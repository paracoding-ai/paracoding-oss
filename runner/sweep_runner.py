#!/usr/bin/env python3
# fleet-sweep-runner — the STALL SWEEPER. NO LLM (idle AND active = ~free: pure Firestore).
# Cloud Scheduler hits it every ~5 min. It finds work that stalled or came back failed and
# re-routes per the fleet's single-try economics (bus-fanout-architecture.md):
#   * a GEMINI item that stalled (in_progress past timeout) or returned blocked/error, not yet
#     escalated  ->  re-queue as CLAUDE(cached): status=pending, substrate=claude, escalated=1.
#     (That's the "one Gemini try, then the cached Claude twin does it" rule.)
#   * already escalated once and STILL stuck  ->  status=needs_supervisor + WAKE fleet-advisor
#     via agent_messages (urgency=hard). Never silent-drop.
# HARD-GATE items (gate==operator / hold / held_for_operator) are NEVER touched. Those two are
# FIRESTORE FIELD NAMES and a field VALUE -- one half of a data contract whose other half is the
# control plane, carried by every hard-gated document already in a deployment. They read like an
# operator's name and they are schema keys, so they are deliberately not renamed: renaming one
# side silently disables the hard gate on every existing document.
# Only sweeps in_progress items the NEW runner actually started (runner=='work-runner'), so it
# won't grab legacy items until they've had a real run.
# FLEET MODE: the sweeper makes NO model call itself, and gates on the mode anyway, because every
# branch it takes MANUFACTURES a paid one -- the park and supervisor branches write an
# agent_messages document that answer_runner pays to answer, and the escalate branch re-queues the
# item onto a bus that work_item_runner pays to run. A deployment with its buses off must not have
# this service quietly filling the queues they will be paid out of. Same imported switch as the
# other two runners (fleet_mode.py), never a second copy.
import os, json
from datetime import datetime, timezone, timedelta
from flask import Flask, request
from google.cloud import firestore
# ONE implementation of the fleet-mode switch, imported -- never a second copy. See fleet_mode.py.
from fleet_mode import read_config_models, fleet_mode, any_bus_allowed, FLEET_MODES

PROJECT = os.environ["PROJECT"]
app = Flask(__name__)
db = firestore.Client(project=PROJECT)

# [SEC-TTL-STAMP-V1] Firestore TTL is FAIL-OPEN: a document missing the expireAt field is
# NEVER deleted, and the console does not say which documents are covered. The control plane
# stamps its own writes at one chokepoint (control-plane/src/index.ts, [SEC-TTL-CHOKEPOINT-V1]);
# this process writes Firestore with its OWN client, out of that chokepoint's reach, so it
# stamps here. Retention is the operator's parameter: journal 120 days; the agent_messages and work_items writes below
# are operational state with no operator retention parameter and are deliberately not stamped.
# Rows written here reach the forever-archive only via the seed/re-seed step in
# deploy/TTL-BIGQUERY-INFRA.md (this process has no archive path of its own).
def _ttl_expire_at(days):
    return datetime.now(timezone.utc) + timedelta(days=days)

# F18: in-process auth config. Both values are PINNED at deploy time and NEVER derived from the
# request. SWEEP_AUDIENCE is the Cloud Run service URL the scheduler mints its OIDC token for;
# SWEEP_INVOKERS is the exact set of service-account emails allowed to call us.
# bootstrap-sweep-runner.sh MUST set SWEEP_AUDIENCE (it is only known after the first deploy).
SWEEP_AUDIENCE = os.environ.get('SWEEP_AUDIENCE', '').strip()
SWEEP_INVOKERS = set(e.strip().lower() for e in os.environ.get(
    'SWEEP_INVOKERS', 'fleet-sweep-sched-sa@%s.iam.gserviceaccount.com' % PROJECT).split(',') if e.strip())
if not SWEEP_AUDIENCE:
    print('SECURITY: SWEEP_AUDIENCE is unset - the sweeper will refuse every request (503) until '
          'bootstrap-sweep-runner.sh pins it to the Cloud Run service URL.', flush=True)

def _authorized(req):
    """(ok, http_status, public_message). NEVER put exception text in public_message."""
    if not SWEEP_AUDIENCE or not SWEEP_INVOKERS:
        return (False, 503, 'sweeper not configured')
    hdr = req.headers.get('Authorization') or ''
    if not hdr.startswith('Bearer '):
        return (False, 401, 'unauthorized')
    token = hdr[7:].strip()
    if not token:
        return (False, 401, 'unauthorized')
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        # Signature, expiry AND audience are all verified here against the PINNED audience.
        info = id_token.verify_oauth2_token(token, google_requests.Request(), audience=SWEEP_AUDIENCE)
    except Exception as e:
        print('auth: token verification failed: %s' % (str(e)[:300],), flush=True)
        return (False, 401, 'unauthorized')
    if info.get('iss') not in ('https://accounts.google.com', 'accounts.google.com'):
        print('auth: bad issuer %r' % (info.get('iss'),), flush=True)
        return (False, 401, 'unauthorized')
    email = str(info.get('email') or '').strip().lower()
    if not info.get('email_verified') or email not in SWEEP_INVOKERS:
        print('auth: caller not allowlisted: %r' % (email,), flush=True)
        return (False, 403, 'forbidden')
    return (True, 200, '')


def cfg():
    # The read lives in fleet_mode.read_config_models so the runners cannot disagree about what
    # "unreadable config" means; the fail-safe direction is decided in exactly one place.
    return read_config_models(db)

def journal(agent, action, message):
    try:
        db.collection('journal').add({'agent_id':agent,'action':action,'message':message[:900],
            'timestamp':firestore.SERVER_TIMESTAMP,
            'expireAt':_ttl_expire_at(120)})
    except Exception:
        pass

def _hardgate(it):
    return bool(it.get('hold') or it.get('held_for_operator') or it.get('gate') == 'operator')

def _reroute(doc, it, reason):
    title = (it.get('title') or '')[:100]
    role  = it.get('assigned_role') or 'fleet-infra'
    # NO CLAUDE BUS (operator ruling, 2026-07-25). Escalating a stalled Gemini item onto Opus 5
    # ran on a personal card and was ~96% of that month's API spend. The real cause was a gunicorn
    # kill, not Gemini failing -- so "stalled" was usually a lie. Default is now to PARK and
    # tell a human; a Claude surface (Cowork on Max, or the Flowhood console) picks it up.
    # Escape hatch: set config/models.escalate_substrate to 'claude' to restore the old path.
    esc = str(cfg().get('escalate_substrate') or 'none').strip().lower()
    if esc in ('none', 'off', 'park', 'no', ''):
        doc.reference.update({'status': 'needs_claude', 'sweep_reason': reason,
            'parked_at': firestore.SERVER_TIMESTAMP})
        db.collection('agent_messages').add({'from': 'sweeper', 'to': 'fleet-advisor',
            'question': f"PARKED for a Claude surface: '{title}' ({doc.id}). {reason}. Gemini did not finish it; the bus will not retry.",
            'context': f"work_item {doc.id}, role {role}, status needs_claude",
            'status': 'open', 'urgency': 'normal', 'ts': firestore.SERVER_TIMESTAMP})
        journal('sweeper', 'sweep_park',
            f"{reason}: '{title}' ({doc.id}) -> needs_claude. No Claude bus; pick it up in Cowork or the Flowhood console.")
        return 'parked'
    if not it.get('escalated'):
        doc.reference.update({'status': 'pending', 'substrate': esc, 'escalated': True,
            'escalated_at': firestore.SERVER_TIMESTAMP, 'sweep_reason': reason})
        journal('sweeper', 'sweep_escalate',
            f"{reason}: re-queued '{title}' ({doc.id}) as {esc.upper()} (escalate_substrate={esc}).")
        return 'escalated'
    doc.reference.update({'status': 'needs_supervisor', 'sweep_reason': reason,
        'needs_supervisor_at': firestore.SERVER_TIMESTAMP})
    db.collection('agent_messages').add({'from': 'sweeper', 'to': 'fleet-advisor',
        'question': f"STUCK after two substrates: '{title}' ({doc.id}). {reason}. Needs you.",
        'context': f"work_item {doc.id}, role {role}", 'status': 'open', 'urgency': 'hard',
        'ts': firestore.SERVER_TIMESTAMP})
    journal('sweeper', 'sweep_supervisor',
        f"{reason}: '{title}' ({doc.id}) -> needs_supervisor + woke fleet-advisor.")
    return 'supervisor'

@app.route('/', methods=['GET','POST'])
def run():
    # IN-PROCESS AUTH (F18): verify the OIDC Bearer token directly.
    # Protects the sweeper if the Cloud Run IAM --no-allow-unauthenticated binding is misconfigured.
    # F18: pinned audience + service-account allowlist; see _authorized() above.
    ok, status, why = _authorized(request)
    if not ok:
        return (why, status)

    # FLEET MODE GATE, before ANY work_items scan and before any write. The refusal is loud in all
    # three of the required places: a journal row, a stdout line, and a state the sweeper cannot
    # turn into a retry loop -- nothing is written at all, so every item keeps the exact status it
    # already had and is swept normally the moment the mode changes. Failing here rather than
    # inside _reroute() is deliberate: a partial sweep that parks some items and not others is a
    # worse state to leave a deployment in than one that did nothing and said so.
    _cfg  = cfg()
    _mode = fleet_mode(_cfg)
    if not any_bus_allowed(_mode):
        _msg = ("FLEET MODE '%s': every model bus is OFF (this is also where an unreadable, "
                "absent, empty or unrecognised switch lands), so the sweeper did NOT sweep. It "
                "wrote nothing: every item keeps the status it already had and is swept as soon "
                "as the mode changes. Sweeping now would manufacture paid work -- agent_messages "
                "for the answer runner, re-queued items for the work runner -- on buses that are "
                "off. Flip it at config/models.fleet_mode (%s)."
                % (_mode, ' | '.join(FLEET_MODES)))
        journal('sweeper', 'bus_off', _msg)
        print('[fleet-mode] %s -> sweeper refused, nothing written' % (_mode,), flush=True)
        return (_msg, 200)

    timeout_min = int(_cfg.get('stall_timeout_min') or 15)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=timeout_min)
    acted, seen = [], set()

    # 1) in_progress runs from the NEW runner that hung past the timeout
    try:
        for d in db.collection('work_items').where('status','==','in_progress').limit(100).stream():
            it = d.to_dict()
            if _hardgate(it) or d.id in seen:
                continue
            if it.get('runner') != 'work-runner':      # leave legacy/hand-managed items alone
                continue
            sa = it.get('started_at')
            if sa and hasattr(sa, 'timestamp') and sa.timestamp() > cutoff.timestamp():
                continue                                # still within its run window
            seen.add(d.id); acted.append(_reroute(d, it, f"stalled >{timeout_min}m in_progress"))
    except Exception as e:
        journal('sweeper','sweep_error', f"in_progress scan: {str(e)[:200]}")

    # 2) came back failed from a single run (blocked / error) — only the runner sets these
    for st in ('blocked', 'error'):
        try:
            for d in db.collection('work_items').where('status','==',st).limit(50).stream():
                it = d.to_dict()
                if _hardgate(it) or d.id in seen:
                    continue
                seen.add(d.id); acted.append(_reroute(d, it, f"returned {st}"))
        except Exception as e:
            journal('sweeper','sweep_error', f"{st} scan: {str(e)[:200]}")

    if not acted:
        return ('idle: nothing stalled (no LLM, pure Firestore)', 200)
    journal('sweeper','sweep_run', f"swept {len(acted)}: {json.dumps(acted)}")
    return (json.dumps({'swept':len(acted),'actions':acted}), 200)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT','8080')))
