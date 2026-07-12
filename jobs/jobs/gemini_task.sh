#!/usr/bin/env bash
# gemini_task — token tier 2: text/doc generation on Gemini (Vertex, keyless ADC).
# Sibling to browser_job. For MECHANICAL writing so agents stop burning Claude/Fable tokens.
# Params (JSON in JOB_PARAMS): {prompt (required), system?, model? (default gemini-2.5-flash),
#   location? (default global), max_tokens? (<=8192, default 2048), temperature? (default 0.4)}
# Keyless: ADC token minted per job as paracoding-infra (Vertex, project YOUR_GCP_PROJECT). No long-lived keys.
# Thinking is DISABLED on 2.5-flash variants (thinkingBudget=0) — mechanical writing needs no reasoning
# overhead, and it keeps all of max_tokens for visible output. Output -> /opt/paracoding-mcp/work/gemini/<id>/
# (mcpsvc). REQUESTING AGENT MUST VERIFY before acting.
set -uo pipefail
PROJECT=YOUR_GCP_PROJECT
JP=${JOB_PARAMS:-}
[ -n "$JP" ] || JP='{}'
J(){ printf '%s' "$JP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
PROMPT=$(J prompt); MODEL=$(J model); LOCATION=$(J location); MAXT=$(J max_tokens); TEMP=$(J temperature)
[ -n "$PROMPT" ] || { echo "prompt required"; exit 2; }
[ -n "$MODEL" ] || MODEL=gemini-2.5-flash
case "$MODEL" in
  gemini-2.5-flash|gemini-2.5-pro|gemini-2.5-flash-lite|gemini-2.0-flash) : ;;
  *) echo "model not allowed: $MODEL (allowlist: gemini-2.5-flash|pro|flash-lite, gemini-2.0-flash)"; exit 2 ;;
esac
[ -n "$LOCATION" ] || LOCATION=global
case "$MAXT" in ''|*[!0-9]*) MAXT=2048 ;; esac; [ "$MAXT" -gt 8192 ] && MAXT=8192
[ -n "$TEMP" ] || TEMP=0.4
JID="$(date +%Y%m%d-%H%M%S)-$$"
OUT="/opt/paracoding-mcp/work/gemini/$JID"; mkdir -p "$OUT"
TOKEN=$(sudo -u paracoding-infra env HOME=/home/paracoding-infra CLOUDSDK_CONFIG=/home/paracoding-infra/.config/gcloud PATH=/snap/bin:/usr/bin:/bin gcloud auth application-default print-access-token 2>/dev/null)
[ -n "$TOKEN" ] || { echo "no ADC token — paracoding-infra application-default creds missing/expired"; exit 3; }
if [ "$LOCATION" = "global" ]; then HOST="aiplatform.googleapis.com"; else HOST="${LOCATION}-aiplatform.googleapis.com"; fi
MODEL="$MODEL" python3 - "$OUT" "$MAXT" "$TEMP" <<'PY'
import json, os, sys
out, maxt, temp = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
model = os.environ.get("MODEL","")
p = json.loads(os.environ.get("JOB_PARAMS","{}"))
gen = {"maxOutputTokens": maxt, "temperature": temp}
if "gemini-2.5-flash" in model:            # flash + flash-lite: turn OFF thinking for mechanical writing
    gen["thinkingConfig"] = {"thinkingBudget": 0}
req = {"contents":[{"role":"user","parts":[{"text": p.get("prompt","")}]}], "generationConfig": gen}
if p.get("system"): req["systemInstruction"] = {"parts":[{"text": p["system"]}]}
json.dump(req, open(os.path.join(out,"request.json"),"w"))
PY
URL="https://${HOST}/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent"
HTTP=$(curl -sS -o "$OUT/response.json" -w '%{http_code}' -X POST "$URL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @"$OUT/request.json" --max-time 120 2>"$OUT/curl.err")
python3 - "$OUT" "$HTTP" "$MODEL" "$LOCATION" <<'PY'
import json, sys, os
out, http, model, loc = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try: r = json.load(open(os.path.join(out,"response.json")))
except Exception: r = {}
text = ""
try: text = "".join(part.get("text","") for part in r["candidates"][0]["content"]["parts"])
except Exception: pass
usage = r.get("usageMetadata", {})
open(os.path.join(out,"result.md"),"w").write(text)
res = {"model":model,"location":loc,"http":http,"chars":len(text),
       "prompt_tokens":usage.get("promptTokenCount"),"output_tokens":usage.get("candidatesTokenCount"),
       "finish":(r.get("candidates") or [{}])[0].get("finishReason")}
json.dump(res, open(os.path.join(out,"result.json"),"w"))
print(f"gemini_task={os.path.basename(out)} http={http} model={model} chars={len(text)} out_tokens={usage.get('candidatesTokenCount')} finish={res['finish']} output=work/gemini/{os.path.basename(out)} (AGENT MUST VERIFY)")
print("---8<--- generated text (head) ---")
print(text[:1200])
if not text:
    err = r.get("error", {})
    print("NO TEXT. error:", (json.dumps(err)[:400] if err else f"empty candidates; finish={res.get('finish')}"))
    sys.exit(1)
PY
RC=$?
chown -R mcpsvc:mcpsvc /opt/paracoding-mcp/work/gemini 2>/dev/null || true
exit $RC
