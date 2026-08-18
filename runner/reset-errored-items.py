#!/usr/bin/env python3
# reset-errored-items.py — flip every work_items doc with status=='error' back to 'pending'
# (clears the stale error field) so the runway re-attempts them now that the Claude key is valid.
# Firestore REST + the caller's gcloud access token (runs as the operator via god-mode). Only
# touches error items. PROJECT is REQUIRED and has no default.
import subprocess, json, urllib.request, urllib.error
import os
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script rewrites Firestore "
                     "documents and will not guess whose project to rewrite. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
tok = subprocess.run("gcloud auth print-access-token", shell=True, capture_output=True, text=True).stdout.strip()
H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % PROJ

q = {"structuredQuery": {"from": [{"collectionId": "work_items"}],
     "where": {"fieldFilter": {"field": {"fieldPath": "status"}, "op": "EQUAL", "value": {"stringValue": "error"}}}}}
req = urllib.request.Request(base + ":runQuery", data=json.dumps(q).encode(), headers=H)
rows = json.load(urllib.request.urlopen(req, timeout=60))
names = [r["document"]["name"] for r in rows if "document" in r]
print("found %d error items" % len(names))

ok = 0
for name in names:
    docid = name.split("/documents/")[1]                       # e.g. work_items/AbC123
    url = base + "/" + docid + "?updateMask.fieldPaths=status&updateMask.fieldPaths=error"
    body = {"fields": {"status": {"stringValue": "pending"}}}   # status->pending; error field cleared (not in body)
    r = urllib.request.Request(url, data=json.dumps(body).encode(), headers=H, method="PATCH")
    try:
        urllib.request.urlopen(r, timeout=30); ok += 1; print("reset " + docid)
    except urllib.error.HTTPError as e:
        print("FAIL " + docid + " -> " + str(e.code) + " " + e.read(160).decode()[:160])
print("DONE: reset %d/%d error items to pending" % (ok, len(names)))
