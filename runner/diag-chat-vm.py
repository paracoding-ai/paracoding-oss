#!/usr/bin/env python3
# diag-chat-vm.py — one-shot ground truth for the two breakages: which Anthropic model the stored key can
# actually call (chat 502), whether the control-plane still has its VPC connector (VM stream), box status.
# PROJECT is REQUIRED and has no default. Optional: REGION, ZONE, SECRET, CP_SVC, VM_NAME, BUCKET.
import os, subprocess, json, urllib.request, urllib.error
PROJ = os.environ.get("PROJECT", "").strip()
if not PROJ:
    raise SystemExit("PROJECT is not set. Refusing to run: this script reads a live secret and "
                     "describes live resources, and will not guess whose. "
                     "Run it as: PROJECT=<your-gcp-project> python3 %s" % __file__)
REGION  = os.environ.get("REGION", "us-east1")
ZONE    = os.environ.get("ZONE", "us-central1-a")
SECRET  = os.environ.get("SECRET", "chat-key-claude")
CP_SVC  = os.environ.get("CP_SVC", "paracoding-control-plane")
VM_NAME = os.environ.get("VM_NAME", "fleet-workstation")
BUCKET  = os.environ.get("BUCKET", "").strip()
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
out = []
key = sh("gcloud secrets versions access latest --secret=%s --project=%s" % (SECRET, PROJ))
out.append("key_len=" + str(len(key)))
for m in ["claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-20250514",
          "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"]:
    try:
        body = json.dumps({"model": m, "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]}).encode()
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
              headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        urllib.request.urlopen(req, timeout=30); out.append("OK    " + m)
    except urllib.error.HTTPError as e:
        out.append(str(e.code) + "  " + m + "  " + e.read(140).decode()[:140])
    except Exception as e:
        out.append("ERR  " + m + "  " + str(e)[:100])
vc = sh("gcloud run services describe " + CP_SVC + " --region " + REGION + " --project " + PROJ +
        " --format='value(spec.template.metadata.annotations[\"run.googleapis.com/vpc-access-connector\"])'")
out.append("cp_vpc_connector=" + (vc or "NONE"))
st = sh("gcloud compute instances describe " + VM_NAME + " --zone=" + ZONE + " --project=" + PROJ +
        " --format='value(status)'")
out.append("box_status=" + (st or "UNKNOWN"))
txt = "\n".join(out)
open("/tmp/diag.txt", "w").write(txt)
if BUCKET:
    subprocess.run("gcloud storage cp /tmp/diag.txt gs://%s/shared/runner/diag.txt" % BUCKET, shell=True)
else:
    print("(BUCKET unset -- report left at /tmp/diag.txt, not uploaded)")
print(txt)
