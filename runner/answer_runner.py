#!/usr/bin/env python3
# fleet-answer-runner. Triggered ~every 2 min by
# Cloud Scheduler. IDLE = FREE: if no open messages, one Firestore read + exit (NO
# LLM call). Per open message: boot a lean model AS the target role, answer, write
# back. Cost scales with traffic, not the clock.
# FLEET MODE: this service is on a 2-minute tick and every open agent_messages document is a
# PAID model call, and those documents are created by the ask_agent tool that every bus agent
# holds, by the MCP surface, and by sweep_runner on two branches. So a deployment that believes
# its buses are off must not have this one waking a paid call every two minutes. It gates on the
# SAME imported switch as work_item_runner (fleet_mode.py) -- not a second copy of it.
# ITS ONLY TRANSPORT IS THE KEYED ONE (anthropic.Anthropic(api_key=...)), so it runs in 'dual'
# alone: 'home' has no bus at all and 'work' is keyless by definition and refuses a keyed call.
# Guards: never answer a self-addressed message; cap answers/run; on failure set
# status='error' + reason (never silent-drop).
# TELEMETRY: after each call, log real token usage from resp.usage to Firestore
# `token_usage` so the dashboard can show what the fleet KNOWS it spent (self-track).
# 2026-07-24 OPUS 5: hard-urgency brain is claude-opus-5. Legacy Opus 4.x ids from a
# stale env var are force-upgraded at call time (see OPUS 5 FLOOR below).
import os, json
from flask import Flask, request
from google.cloud import firestore
import anthropic
# ONE implementation of the fleet-mode switch, imported -- never a second copy. See fleet_mode.py.
from fleet_mode import read_config_models, fleet_mode, bus_allowed, refusal_text
from datetime import datetime, timedelta, timezone

PROJECT     = os.environ["PROJECT"]
DEF_MODEL   = os.environ.get("DEFAULT_MODEL", "claude-haiku-4-5-20251001")  # lean default
HARD_MODEL  = os.environ.get("HARD_MODEL", "claude-opus-5")                # urgency==hard (Opus 5)
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN", "5"))
API_KEY     = os.environ.get("ANTHROPIC_API_KEY", "")
# The one transport this service has. Named as a constant so the mode gate below reasons about
# how the call would be PAID FOR, not merely about which vendor it goes to.
TRANSPORT   = 'key'

app = Flask(__name__)
db = firestore.Client(project=PROJECT)

# [SEC-TTL-STAMP-V1] Firestore TTL is FAIL-OPEN: a document missing the expireAt field is
# NEVER deleted, and the console does not say which documents are covered. The control plane
# stamps its own writes at one chokepoint (control-plane/src/index.ts, [SEC-TTL-CHOKEPOINT-V1]);
# this process writes Firestore with its OWN client, out of that chokepoint's reach, so it
# stamps here. Retention is the operator's parameter: journal 120 days; token_usage and agent_messages are
# operational state with no operator retention parameter and are deliberately not stamped.
# Rows written here reach the forever-archive only via the seed/re-seed step in
# deploy/TTL-BIGQUERY-INFRA.md (this process has no archive path of its own).
def _ttl_expire_at(days):
    return datetime.now(timezone.utc) + timedelta(days=days)

def log_usage(agent, model, usage, source="answer-runner"):
    # Self-tracked token accounting. Best-effort; never breaks the answer path.
    try:
        if not usage:
            return
        db.collection('token_usage').add({
            'agent': agent, 'model': model, 'source': source,
            'input_tokens': int(getattr(usage, 'input_tokens', 0) or 0),
            'output_tokens': int(getattr(usage, 'output_tokens', 0) or 0),
            'cache_creation_input_tokens': int(getattr(usage, 'cache_creation_input_tokens', 0) or 0),
            'cache_read_input_tokens': int(getattr(usage, 'cache_read_input_tokens', 0) or 0),
            'ts': firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass

def journal(agent, action, message):
    try:
        db.collection('journal').add({'agent_id': agent, 'action': action, 'message': message[:900],
                                      'timestamp': firestore.SERVER_TIMESTAMP,
                                      'expireAt': _ttl_expire_at(120)})
    except Exception:
        pass

def brain_context(role, limit=8):
    try:
        rows = [d.to_dict() for d in db.collection('chat_history').where('agent_id','==',role).limit(200).stream()]
        rows.sort(key=lambda r: (r['timestamp'].timestamp() if r.get('timestamp') else 0))
        return "\n".join(f"[{r.get('role')}] {(r.get('text') or '')[:400]}" for r in rows[-limit:])
    except Exception:
        return ""

def answer_one(doc):
    m = doc.to_dict()
    to, frm = m.get('to'), m.get('from')
    if not to or to == frm:
        doc.reference.update({'status':'error','error':'invalid/self-addressed message'})
        return 'skip'
    model = HARD_MODEL if m.get('urgency') == 'hard' else DEF_MODEL
    # OPUS 5 FLOOR (operator decree 2026-07-24): a stale env var can never pin us to Opus 4.x.
    if model.startswith('claude-opus-4') or model.startswith('claude-opus-3'):
        model = 'claude-opus-5'
    sys_prompt = (f"You are {to} in this Paracoding fleet, answering another fleet agent "
                  f"with NO human relay. Be concise and direct. Use your recent notes if relevant.")
    user = (f"Question from {frm}: {m.get('question','')}\n\n"
            f"Context: {m.get('context','')}\n\nYour recent notes:\n{brain_context(to)}")
    resp = anthropic.Anthropic(api_key=API_KEY).messages.create(
        model=model, max_tokens=800, system=sys_prompt,
        messages=[{"role":"user","content":user}])
    log_usage(to, model, getattr(resp, 'usage', None))
    text = "".join(b.text for b in resp.content if getattr(b,'type','')=='text').strip() or "(no answer)"
    doc.reference.update({'answer':text,'status':'answered','answered_by':to,
                          'answered_via':'answer-runner','model':model,
                          'answered_at': firestore.SERVER_TIMESTAMP})
    db.collection('journal').add({'agent_id':to,'action':'answer_message',
        'message':f"answer-runner answered msg {doc.id} from {frm} using {model}.",
        'timestamp': firestore.SERVER_TIMESTAMP,
        'expireAt': _ttl_expire_at(120)})
    return 'answered'

@app.route('/', methods=['GET','POST'])
def run():
    open_msgs = list(db.collection('agent_messages').where('status','==','open').limit(MAX_PER_RUN).stream())
    if not open_msgs:
        return ('idle: no open messages (no LLM call)', 200)
    # FLEET MODE GATE. After the idle check so an idle tick stays one Firestore read and free, and
    # BEFORE any Anthropic client is constructed, so no call can escape it. The refusal is loud in
    # all three of the required places: a journal row, a stdout line, and a state the sweeper
    # cannot turn into a retry loop -- the messages are left EXACTLY as they are, status 'open',
    # untouched, so they are answered the moment the mode changes. sweep_runner scans work_items
    # and never agent_messages, so an open message is not a sweepable state at all; setting them
    # to 'error' would instead destroy the question and require a human to re-ask it.
    _mode = fleet_mode(read_config_models(db))
    if not bus_allowed(_mode, 'claude', TRANSPORT):
        _msg = (refusal_text(_mode, 'claude', TRANSPORT) +
                " %d open message(s) left untouched; they are answered as soon as the mode changes."
                % len(open_msgs))
        journal('answer-runner', 'bus_off', _msg)
        print('[fleet-mode] %s -> refused claude/%s, %d message(s) left open'
              % (_mode, TRANSPORT, len(open_msgs)), flush=True)
        return (_msg, 200)
    out = []
    for d in open_msgs:
        try:
            out.append(answer_one(d))
        except Exception as e:
            d.reference.update({'status':'error','error':str(e)[:500]})
            journal('answer-runner', 'answer_error', f"msg {d.id} error: {str(e)[:300]}")
            out.append('error')
    return (json.dumps({'processed': out}), 200)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT','8080')))
