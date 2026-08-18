#!/usr/bin/env python3
# fix-history-attribution.py — re-file THIS-session journal entries that were mislabeled fleet-advisor
# back to fleet-infra. SCOPED to fleet-infra's own known job_ids so it can never touch the REAL
# fleet-advisor's history. Firestore REST + caller's gcloud token (fleet-infra god-mode job).
# PROJECT and JOBIDS are REQUIRED and have no defaults. JOBIDS used to be eleven literal Firestore
# job ids from one particular past session. Those ids are BOTH operator identity AND this script's
# entire safety scope -- they are what stops it touching journal history it has no business
# rewriting. Shipping them would hand an adopter a journal rewriter scoped to somebody else's
# document ids; dropping the scope would hand them an UNSCOPED one, which is strictly worse. So
# the scope is required input and an empty scope rewrites nothing.
import subprocess, json, urllib.request, urllib.error
import os
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script rewrites Firestore "
                     "documents and will not guess whose project to rewrite. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
JOBIDS = [j.strip() for j in os.environ.get("JOBIDS", "").split(",") if j.strip()]
if not JOBIDS:
    raise SystemExit("JOBIDS is not set. Refusing to run: this script rewrites journal "
                     "attribution and the job-id list IS its safety scope. "
                     "Run it as: PROJECT=<project> JOBIDS=<id1,id2,...> python3 %s" % __file__)
tok = subprocess.run("gcloud auth print-access-token", shell=True, capture_output=True, text=True).stdout.strip()
H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % PROJ

docs = []; tokp = None
while True:
    u = base + "/journal?pageSize=300" + (("&pageToken=" + tokp) if tokp else "")
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=40))
    docs += j.get("documents", []); tokp = j.get("nextPageToken")
    if not tokp: break

n = 0
for d in docs:
    f = d.get("fields", {})
    aid = (f.get("agent_id", {}) or {}).get("stringValue", "")
    msg = (f.get("message", {}) or {}).get("stringValue", "")
    if aid == "fleet-advisor" and any(jid in msg for jid in JOBIDS):
        did = d["name"].split("/documents/")[1]
        url = base + "/" + did + "?updateMask.fieldPaths=agent_id"
        body = {"fields": {"agent_id": {"stringValue": "fleet-infra"}}}
        r = urllib.request.Request(url, data=json.dumps(body).encode(), headers=H, method="PATCH")
        try:
            urllib.request.urlopen(r, timeout=30); n += 1; print("refiled " + did)
        except urllib.error.HTTPError as e:
            print("err " + did + " " + str(e.code))
print("REFILED %d journal entries fleet-advisor -> fleet-infra (scoped to fleet-infra's job_ids)" % n)
