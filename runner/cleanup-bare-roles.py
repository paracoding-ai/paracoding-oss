#!/usr/bin/env python3
# cleanup-bare-roles.py — merge split queues: reassign work_items whose assigned_role is a bare
# name (infra/advisor/security/...) to its canonical fleet-* role, so the cockpit shows one agent
# with one queue. Firestore REST + caller's gcloud token (god-mode, runs as the operator). Only
# touches docs whose assigned_role is in the alias map; leaves everything else alone.
# PROJECT is REQUIRED and has no default.
import subprocess, json, urllib.request, urllib.error
import os
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script rewrites Firestore "
                     "documents and will not guess whose project to rewrite. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
# EDIT THIS MAP FOR YOUR OWN ROSTER: bare queue name -> canonical fleet-* role.
ALIAS = {"infra":"fleet-infra","advisor":"fleet-advisor",
         "security":"fleet-security","publisher":"fleet-publisher",
         "gcp":"fleet-gcp","handoff":"fleet-handoff"}
tok = subprocess.run("gcloud auth print-access-token", shell=True, capture_output=True, text=True).stdout.strip()
H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % PROJ

# page through the whole work_items collection
docs = []
tokp = None
while True:
    url = base + "/work_items?pageSize=300" + (("&pageToken=" + tokp) if tokp else "")
    j = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60))
    docs += j.get("documents", [])
    tokp = j.get("nextPageToken")
    if not tokp: break

n = 0
for d in docs:
    f = d.get("fields", {})
    role = (f.get("assigned_role", {}) or {}).get("stringValue", "")
    if role in ALIAS:
        docid = d["name"].split("/documents/")[1]
        url = base + "/" + docid + "?updateMask.fieldPaths=assigned_role"
        body = {"fields": {"assigned_role": {"stringValue": ALIAS[role]}}}
        r = urllib.request.Request(url, data=json.dumps(body).encode(), headers=H, method="PATCH")
        try:
            urllib.request.urlopen(r, timeout=30); n += 1; print("%s: %s -> %s" % (docid, role, ALIAS[role]))
        except urllib.error.HTTPError as e:
            print("FAIL " + docid + " -> " + str(e.code))
print("DONE: reassigned %d work_items to canonical fleet-* roles (scanned %d)" % (n, len(docs)))
