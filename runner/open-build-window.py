#!/usr/bin/env python3
# open-build-window.py — open a time-boxed BUILD WINDOW (default 30 min). While open, fleet-build-runner
# auto-runs fleet-infra's staged build jobs (allowlisted targets) so iteration is one-tap-per-session.
# Firestore REST + caller's gcloud token (runs as the operator via god-mode). Set MINS to change
# duration; set CLOSE=1 to close early. Keep your gate/cockpit tab open so the runner has a live
# token to act as you. PROJECT is REQUIRED and has no default.
import subprocess, json, urllib.request, time, os
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script rewrites Firestore "
                     "documents and will not guess whose project to rewrite. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
MINS = int(os.environ.get("MINS", "30"))
CLOSE = os.environ.get("CLOSE", "") == "1"
tok = subprocess.run("gcloud auth print-access-token", shell=True, capture_output=True, text=True).stdout.strip()
H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
base = "https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents" % PROJ
if CLOSE:
    exp = int(time.time() * 1000)
    body = {"fields": {"active": {"booleanValue": False}, "expiry_ms": {"integerValue": str(exp)}}}
else:
    exp = int(time.time() * 1000) + MINS * 60000
    body = {"fields": {"active": {"booleanValue": True}, "expiry_ms": {"integerValue": str(exp)}}}
url = base + "/build_window/current?updateMask.fieldPaths=active&updateMask.fieldPaths=expiry_ms"
r = urllib.request.Request(url, data=json.dumps(body).encode(), headers=H, method="PATCH")
urllib.request.urlopen(r, timeout=30)
print(("BUILD WINDOW CLOSED" if CLOSE else "BUILD WINDOW OPEN for %d min" % MINS))
