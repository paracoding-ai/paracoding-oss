#!/usr/bin/env python3
# fix-models.py — set CHAT to the best OPUS the key can actually call, and the BUS (work-runner) to HAIKU.
# Uses Anthropic /v1/models to see what THIS key can access (the earlier probe only tried stale dated IDs).
# PROJECT is REQUIRED and has no default. Optional: REGION, SECRET, CP_SVC, WORK_SVC, BUCKET.
import os, subprocess, json, urllib.request, urllib.error
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script updates live Cloud Run "
                     "services and will not guess whose. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
REGION   = os.environ.get("REGION", "us-east1")
SECRET   = os.environ.get("SECRET", "chat-key-claude")
CP_SVC   = os.environ.get("CP_SVC", "paracoding-control-plane")
WORK_SVC = os.environ.get("WORK_SVC", "fleet-work-runner")
BUCKET   = os.environ.get("BUCKET", "").strip()
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
key = sh("gcloud secrets versions access latest --secret=%s --project=%s" % (SECRET, PROJ))
ids = []
try:
    req = urllib.request.Request("https://api.anthropic.com/v1/models?limit=100",
          headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
    j = json.load(urllib.request.urlopen(req, timeout=30))
    ids = [m.get("id", "") for m in j.get("data", [])]
except Exception as e:
    ids = ["<list error: " + str(e)[:120] + ">"]
print("ACCESSIBLE MODELS:", ids)

def pick(prefixes):
    for p in prefixes:
        c = sorted([i for i in ids if i.startswith(p)])
        if c: return c[-1]
    return None
opus = pick(["claude-opus-5", "claude-opus-4-8", "claude-opus-4"])
haiku = pick(["claude-haiku-4-5", "claude-haiku-4", "claude-3-5-haiku"]) or "claude-haiku-4-5-20251001"
print("CHOSEN opus =", opus, "| haiku =", haiku)

result = ["accessible=" + ",".join(ids), "chosen_opus=" + str(opus), "chosen_haiku=" + haiku]
if opus:
    r = sh("gcloud run services update %s --region %s --project %s "
           "--update-env-vars 'CHAT_API_OPUS=%s,CHAT_API_FABLE=%s' && echo OK"
           % (CP_SVC, REGION, PROJ, opus, opus))
    result.append("chat_set_to_opus=" + opus + " (" + ("ok" if "OK" in r else "FAILED") + ")")
else:
    result.append("NO OPUS ACCESS on this key — chat cannot use Opus; you need an Opus-enabled key")
# bus (work-runner) -> haiku
rb = sh("gcloud run services update %s --region %s --project %s "
        "--update-env-vars 'WORK_MODEL=%s' && echo OK" % (WORK_SVC, REGION, PROJ, haiku))
result.append("bus_set_to_haiku=" + haiku + " (" + ("ok" if "OK" in rb else "FAILED/absent") + ")")
txt = "\n".join(result)
open("/tmp/m.txt", "w").write(txt)
if BUCKET:
    sh("gcloud storage cp /tmp/m.txt gs://%s/shared/runner/models.txt" % BUCKET)
else:
    print("(BUCKET unset -- report left at /tmp/m.txt, not uploaded)")
print(txt)
