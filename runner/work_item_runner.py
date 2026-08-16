#!/usr/bin/env python3
# fleet-work-runner — consumes work_items and DOES the work (tool-using agent loop; Claude / Gemini / DeepSeek).
# Substrate per-item: work_item.substrate OR payload.substrate OR config/models.work_provider (claude|gemini).
# Claude path supports PROMPT CACHING (config claude_cache=on): static system+tools cached + rolling
# cache breakpoint on latest tool_results so large file reads cache across turns (~10% repeat cost).
# Per-turn cache metrics logged to journal (action=work_cache) for live visibility.
# MEMORY/LEARNING: every strain's system prompt is injected with the fleet laws + shared
# LESSONS + that strain's OWN lessons (the per-role LESSONS.md, which
# override fleet lessons for its lane). Forced for ALL substrates + any future strain.
# 2026-07-24 OPUS 5: the Claude brain is claude-opus-5. Gemini/DeepSeek worker substrates UNCHANGED.
import os, json, time
from datetime import datetime, timedelta, timezone
from flask import Flask, request
from google.cloud import firestore, storage
import anthropic
# ONE implementation of the fleet-mode switch, imported -- never a second copy. See fleet_mode.py.
from fleet_mode import (FLEET_MODES, FLEET_MODE_FALLBACK, read_config_models, fleet_mode,
                        bus_allowed, claude_transport, refusal_text)

PROJECT     = os.environ["PROJECT"]
# [SEC-LAKE-NOGUESS-V1] BUCKET HAS NO DEFAULT AND MUST NOT ACQUIRE ONE. It used to default to
# one particular operator's datalake, so an adopter who forgot to set it did not fail -- this
# runner attached to somebody else's bucket and wrote into it. Deriving "<project>-datalake"
# here instead would be the same defect one step removed: two lanes installed into ONE project
# share PROJECT, so the guess names the OTHER lane's lake and the write succeeds. The installer
# derives the name ONCE, at install time, and sets it explicitly; nothing at runtime guesses it.
# This is the same ruling index.ts carries as LAKE_BUCKET_UNCONFIGURED.
BUCKET      = os.environ.get("BUCKET", "").strip()
if not BUCKET:
    raise RuntimeError(
        "BUCKET is unset. The work runner has no data lake and refuses to guess one: a guessed "
        "bucket name is a cross-lane write waiting to happen. Set BUCKET to the lake bucket the "
        "installer created for THIS lane (deploy-work-runner.sh passes it through), then redeploy.")
WORK_MODEL  = os.environ.get("WORK_MODEL", "claude-opus-5")
VERTEX_LOC  = os.environ.get("VERTEX_LOCATION", "us-east5")
MAX_TURNS   = int(os.environ.get("MAX_TURNS", "24"))
MAX_TOKENS  = int(os.environ.get("MAX_TOKENS", "4096"))
TOOL_CAP    = int(os.environ.get("TOOL_RESULT_CAP", "120000"))
API_KEY     = os.environ.get("ANTHROPIC_API_KEY", "")

app = Flask(__name__)
db  = firestore.Client(project=PROJECT)
gcs = storage.Client(project=PROJECT)
bkt = gcs.bucket(BUCKET)

# [SEC-TTL-STAMP-V1] Firestore TTL is FAIL-OPEN: a document missing the expireAt field is
# NEVER deleted, and the console does not say which documents are covered. The control plane
# stamps its own writes at one chokepoint (control-plane/src/index.ts, [SEC-TTL-CHOKEPOINT-V1]);
# this process writes Firestore with its OWN client, out of that chokepoint's reach, so it
# stamps here. Retention is the operator's parameter: journal 120 days, terminal jobs (pending_confirms) 60 days from
# staging -- a job still pending at 60 days expires with its history, deliberately; token_usage,
# agent_messages and work_items are operational state with no operator retention parameter and
# are deliberately not stamped.
# Rows written here reach the forever-archive only via the seed/re-seed step in
# deploy/TTL-BIGQUERY-INFRA.md (this process has no archive path of its own).
def _ttl_expire_at(days):
    return datetime.now(timezone.utc) + timedelta(days=days)

# OPUS 5 FLOOR (operator decree, 2026-07-24): any legacy Opus 4.x id coming from env or
# Firestore config/models is force-upgraded to Opus 5. Stale config can never pin us back.
OPUS5 = "claude-opus-5"
def _opus5(m):
    m = (m or "").strip()
    if not m: return OPUS5
    return OPUS5 if m.startswith("claude-opus-4") or m.startswith("claude-opus-3") else m

def model_cfg():
    # The read lives in fleet_mode.read_config_models so the runners cannot disagree about what
    # "unreadable config" means; the fail-safe direction is decided in exactly one place.
    return read_config_models(db)

def make_client(mode):
    cfg = model_cfg()
    provider = str(cfg.get('claude_provider') or os.environ.get('CLAUDE_PROVIDER') or 'anthropic').strip().lower()
    # KEYLESS MODE REFUSES THE KEYED TRANSPORT -- IT DOES NOT MERELY FAIL TO PREFER IT.
    # do_item() used to force 'vertex' onto its OWN LOCAL COPY of the config and then call this
    # function, which re-reads config/models from Firestore and never saw that override. So in
    # 'work' mode -- the keyless, employer-billed mode -- a deployment with a leftover
    # ANTHROPIC_API_KEY built an Anthropic key client and billed a personal card. The mode is now
    # an argument, the forcing happens HERE where the client is actually constructed, and the
    # keyed branch is guarded by the one bus_allowed().
    if mode == 'work':
        provider = 'vertex'
    if provider == 'vertex':
        from anthropic import AnthropicVertex
        region = cfg.get('vertex_region') or VERTEX_LOC
        model  = _opus5(cfg.get('vertex_claude_model') or WORK_MODEL)
        return AnthropicVertex(project_id=PROJECT, region=region), model, 'vertex:' + region
    if not bus_allowed(mode, 'claude', 'key'):
        raise RuntimeError(refusal_text(mode, 'claude', 'key') +
                           " make_client refused to construct a keyed Anthropic client.")
    model = _opus5(cfg.get('key_claude_model') or WORK_MODEL)
    return anthropic.Anthropic(api_key=API_KEY), model, 'anthropic-key'

def log_usage(agent, usage, model, source="work-runner"):
    try:
        if not usage: return
        db.collection('token_usage').add({'agent':agent,'model':model,'source':source,
            'provider':'anthropic-claude',
            'input_tokens':int(getattr(usage,'input_tokens',0) or 0),
            'output_tokens':int(getattr(usage,'output_tokens',0) or 0),
            'cache_creation_input_tokens':int(getattr(usage,'cache_creation_input_tokens',0) or 0),
            'cache_read_input_tokens':int(getattr(usage,'cache_read_input_tokens',0) or 0),
            'ts': firestore.SERVER_TIMESTAMP})
    except Exception: pass

def journal(agent, action, message):
    try: db.collection('journal').add({'agent_id':agent,'action':action,'message':message[:900],'timestamp':firestore.SERVER_TIMESTAMP,'expireAt':_ttl_expire_at(120)})
    except Exception: pass

# ---- [HIST-V1] DURABLE HISTORY: the read half and the write half ------------------------
# Fleet rule (durable history): the same `chat_history` collection the control plane's log_history/read_history/
# refresh tools use, with the same field names, so a bus entry and a Cowork entry are the
# same kind of thing and one `refresh` returns both. Do NOT introduce a second store.
# Both halves are fail-soft: history is memory, not a control, and losing it must never
# fail a work item.
def recent_history(role):
    """(text, n_rows) -- this role's own recent turns, OLDEST FIRST so the newest reads last."""
    try:
        q = (db.collection('chat_history')
               .where('agent_id', '==', role)
               .order_by('timestamp', direction=firestore.Query.DESCENDING)
               .limit(max(1, HIST_TURNS)))
        rows = [d.to_dict() or {} for d in q.stream()]
    except Exception as e:
        journal(role, 'hist_read_failed',
                'could not read chat_history (%s). The strain runs WITHOUT its own history this '
                'item -- treat anything it says about prior work as unverified.' % str(e)[:250])
        return '', 0
    rows.reverse()
    lines = []
    for r in rows:
        ts = r.get('timestamp')
        try: when = ts.strftime('%Y-%m-%d %H:%MZ')
        except Exception: when = '(undated)'
        tags = r.get('tags') or []
        tg = (' [' + ', '.join(str(t) for t in tags[:8]) + ']') if tags else ''
        lines.append('- %s%s %s' % (when, tg, str(r.get('text') or '')[:HIST_ENTRY_MAX]))
    out = '\n'.join(lines)
    # Drop the OLDEST if it will not fit. Never the newest -- cutting the tail tells an agent
    # the most recent thing never happened, which is worse than telling it nothing.
    if len(out) > HIST_INJECT_MAX:
        full = len(out)
        while lines and len('\n'.join(lines)) > HIST_INJECT_MAX:
            lines.pop(0)
        out = '\n'.join(lines)
        journal(role, 'hist_truncated',
                'history was %d chars against HIST_INJECT_MAX=%d; kept the %d NEWEST of %d '
                'entries. Older turns were not delivered.' % (full, HIST_INJECT_MAX, len(lines), len(rows)))
    return out, len(rows)

def hist_write(role, text, tags):
    """Append one turn to this role's durable history. Returns the doc id, or '' on failure."""
    try:
        ref = db.collection('chat_history').document()
        ref.set({'id': ref.id, 'agent_id': role, 'role': 'assistant',
                 'text': str(text)[:4000], 'tags': [str(t)[:60] for t in (tags or [])][:12],
                 'session': 'work-runner', 'timestamp': firestore.SERVER_TIMESTAMP})
        return ref.id
    except Exception as e:
        journal(role, 'hist_write_failed',
                'could not write chat_history (%s). This item is in the journal but NOT in the '
                'history a future session refreshes from.' % str(e)[:250])
        return ''

# ---- FLEET MODE: one switch, three positions (operator ruling, 2026-08-01) -------------------
# The switch itself lives in fleet_mode.py and is IMPORTED, not restated, because answer_runner
# and sweep_runner gate on the same decision and three copies of it would drift. Read that file
# for the three positions, the transport distinction between the two on-modes, and the fail-safe
# direction (missing / unreadable / empty / unrecognised -> 'home', which spends nothing).

# ---- GEMINI / VERTEX HARD MONTHLY SPEND CAP (operator ruling, 2026-08-01) --------------------
# Gemini is the DEFAULT substrate (see do_item: work_provider or 'gemini') and it runs on Vertex,
# billed to GCP, which has NO spend ceiling by default. token_usage documents were already being
# written on every model call and READ BY NOTHING. This block is their first consumer: it sums the
# CURRENT CALENDAR MONTH (UTC) of Gemini-attributable token_usage, converts it to an estimated USD
# figure with the conservative price table below, and REFUSES to make another Vertex call once the
# estimate reaches the cap.
#
# WHERE THE CAP LIVES: Firestore config/limits, field gemini_monthly_usd_cap (a number, USD).
# Changing that document is a privileged Firestore write, so it can only happen through the
# operator's Face ID gate. See the cap doc beside the deployed runner.
# THERE IS DELIBERATELY NO CODE PATH HERE THAT RAISES THE CAP. A missing, unreadable, malformed,
# zero or negative value FAILS CLOSED to GEMINI_CAP_DEFAULT_USD -- never to unlimited. A value
# read back from Firestore is honoured in either direction, because putting it there already
# required the human gate; nothing in this process can perform that write (the bus tool set has no
# Firestore-document write tool at all -- see TOOLS/DISPATCH below).
#
# NOTE ON THE substrate OVERRIDE: the per-work-item `substrate` field is UNTOUCHED by this cap and
# must stay that way. The operator uses it deliberately to fan out across buses, and the
# Anthropic path is bounded on the account side. This cap governs the GCP-billed Gemini path only.
GEMINI_CAP_DEFAULT_USD = 20.0

# [SPEND-CAP-V1] PER-PROVIDER MONTHLY CEILINGS (operator ruling, 2026-08-03): separate caps, one per
# wallet -- Gemini is GCP credits, Claude is a different bill, and a single ceiling would let
# one drain the other's budget.
#
# THREE BUCKETS, AND EVERY token_usage ROW LANDS IN EXACTLY ONE. Attribution is by MODEL NAME,
# never by the 'provider' field: measured 2026-08-03, provider reads 'anthropic-claude' even
# when the call went to Vertex (GCP-billed spend labelled Anthropic), and answer_runner and the
# web chat write no provider field at all. model is the only universally present field.
#
# 'other' IS NOT PADDING. With ONE cap, a model id that stopped starting with 'gemini' was still
# counted. With per-provider caps it would match no bucket and sum to $0.00 forever -- the exact
# blindness the old code warns about itself. 'other' catches it, is capped LOWER on purpose, and
# is priced at the most expensive rate so unknown spend refuses sooner. If 'other' ever spends
# anything, ADD A BUCKET -- do not raise it.
#
# THE RATES BELOW ARE ESTIMATES, NOT PUBLISHED PRICES. They are rounded UP so the cap fires
# early rather than late, which is the safe direction, but they must be replaced with real
# per-million figures before this is what stands between an adopter and a bill.
SPEND_BUCKETS = ('gemini', 'claude', 'other')
CAP_DEFAULT_USD = {'gemini': 20.0, 'claude': 20.0, 'other': 5.0}

# Secret Manager secret holding {"gemini": n, "claude": n, "other": n}. ONE secret, so a partial
# write cannot leave the ceilings inconsistent. NOT in Firestore on purpose: fleet-gate-exec-sa
# holds project-wide roles/datastore.user, so any approved gate job could rewrite a Firestore
# cap -- that is a suggestion, not a ceiling. datastore.user does not reach Secret Manager.
CAPS_SECRET_NAME = os.environ.get("CAPS_SECRET", "pc-monthly-usd-caps")
CAPS_TTL_SEC = 60
_CAPS = {'v': None, 'at': 0.0}
# {bucket: {'usd': float, 'at': float, 'month': 'YYYY-MM'}}
_BUCKET_SPEND = {}

# USD per MILLION tokens. Compiled in, NOT read from config/models.prices -- that document is
# Firestore, executor-writable, and fails OPEN to "no price". A cap priced from a mutable
# document is not a cap. Claude bills cache writes and cache reads as SEPARATE tiers; a
# two-number in/out table would materially misprice it.
# [RATES-V1] PUBLISHED prices, USD per MILLION tokens, verified 2026-08-04 against
# platform.claude.com/docs/en/about-claude/pricing and cloud.google.com/vertex-ai pricing.
# Keyed by MODEL PREFIX, longest match wins. The BUCKET decides which ceiling applies; the
# MODEL decides what the call costs. Those are different questions and keying both off the
# bucket under-counted claude-fable-5 and claude-mythos-5 by half.
#   cw = cache WRITE (Claude 1h TTL rate -- run_claude sets 1h by default; the 5m rate is
#        cheaper and using it would under-count)
#   cr = cache READ / cached input
# Gemini is priced at the >200K LONG-CONTEXT rate: above that threshold Vertex charges EVERY
# token at the higher rate and a token_usage row does not tell us which side we were on.
MODEL_RATES = (
    ('claude-opus',   {'in': 5.00,  'out': 25.00, 'cw': 10.00, 'cr': 0.50}),
    ('claude-sonnet', {'in': 3.00,  'out': 15.00, 'cw': 6.00,  'cr': 0.30}),
    ('claude-haiku',  {'in': 1.00,  'out': 5.00,  'cw': 2.00,  'cr': 0.10}),
    ('claude-fable',  {'in': 10.00, 'out': 50.00, 'cw': 20.00, 'cr': 1.00}),
    ('claude-mythos', {'in': 10.00, 'out': 50.00, 'cw': 20.00, 'cr': 1.00}),
    ('gemini',        {'in': 4.00,  'out': 18.00, 'cw': 4.00,  'cr': 0.40}),
)
# An unrecognised model prices at the most expensive PUBLISHED model, so a new or renamed id
# over-estimates and the ceiling fires sooner. It never prices at zero.
RATE_UNKNOWN = {'in': 10.00, 'out': 50.00, 'cw': 20.00, 'cr': 1.00}


def rate_for(model):
    """Longest-prefix match on the model id. Never returns None, never returns free."""
    m = str(model or '').strip().lower()
    best = None
    for pfx, r in MODEL_RATES:
        if m.startswith(pfx) and (best is None or len(pfx) > len(best[0])):
            best = (pfx, r)
    return best[1] if best else RATE_UNKNOWN


def spend_bucket(model, provider=''):
    """Which ceiling does this row count against? MODEL NAME decides. Never returns None."""
    m = str(model or '').strip().lower()
    if m.startswith('gemini'):
        return 'gemini'
    if m.startswith('claude'):
        return 'claude'
    p = str(provider or '').strip().lower()
    if not m:
        if p.startswith('gemini'):
            return 'gemini'
        if p.startswith('anthropic') or p.startswith('claude'):
            return 'claude'
    return 'other'


def row_usd(model, tin, tout, tcw, tcr):
    """[RATES-V1] Cost of ONE call, priced by its own model id."""
    r = rate_for(model)
    return ((tin / 1000000.0) * r['in'] + (tout / 1000000.0) * r['out']
            + (tcw / 1000000.0) * r['cw'] + (tcr / 1000000.0) * r['cr'])


def spend_caps_usd():
    """{bucket: usd} HARD ceilings from Secret Manager. NEVER returns unlimited.

    Every failure mode -- secret absent, SDK absent, malformed JSON, missing key, non-number,
    zero, negative, NaN -- falls back to the COMPILED default for that bucket. The SDK import is
    lazy (file convention) and its absence is a FALLBACK, not a crash: if the requirements
    change did not land, the caps are the safe defaults rather than no caps.
    """
    now = time.time()
    if _CAPS['v'] is not None and (now - _CAPS['at']) < CAPS_TTL_SEC:
        return _CAPS['v']
    out = dict(CAP_DEFAULT_USD)
    try:
        from google.cloud import secretmanager
        c = secretmanager.SecretManagerServiceClient()
        name = "projects/%s/secrets/%s/versions/latest" % (PROJECT, CAPS_SECRET_NAME)
        raw = c.access_secret_version(request={"name": name}).payload.data.decode("utf-8")
        got = json.loads(raw)
        if isinstance(got, dict):
            for b in SPEND_BUCKETS:
                try:
                    v = float(got.get(b))
                except (TypeError, ValueError):
                    continue
                if v > 0:          # 0, negative and NaN all fail this and keep the default
                    out[b] = v
    except Exception as e:
        journal('work-runner', 'cap_read_default',
                'monthly caps unreadable (%s) -- using compiled defaults %s. NEVER unlimited.'
                % (str(e)[:150], CAP_DEFAULT_USD))
    _CAPS['v'] = out
    _CAPS['at'] = now
    return out


def bucket_month_to_date_usd(bucket):
    """(usd, trusted) for ONE bucket this UTC month.

    ONE scan fills EVERY bucket's cache, so checking gemini and then claude inside the TTL costs
    a single pass. Costs no more Firestore reads than the Gemini-only version it replaces: that
    one already streamed and paid for every row, then discarded the non-Gemini ones.
    trusted=False means the number could not be computed and the caller MUST fail closed.
    """
    mstart, mkey = _month_start_utc()
    now = time.time()
    c = _BUCKET_SPEND.get(bucket)
    if c and c['month'] == mkey and (now - c['at']) < GEMINI_SPEND_TTL_SEC:
        return c['usd'], True
    acc = {}
    n = 0
    try:
        q = (db.collection('token_usage')
               .where('ts', '>=', mstart)
               .select(['provider', 'model', 'input_tokens', 'output_tokens',
                        'cache_creation_input_tokens', 'cache_read_input_tokens',
                        'thoughts_tokens'])
               .limit(GEMINI_USAGE_SCAN_MAX))
        for d in q.stream():
            n += 1
            r = d.to_dict() or {}
            # [RATES-V1] Price each row by ITS OWN model, then sum money into the bucket.
            # Summing tokens first and pricing once per bucket cannot represent a bucket that
            # holds models at different prices -- claude-opus-5 and claude-fable-5 differ 2x.
            bk = spend_bucket(r.get('model'), r.get('provider'))
            acc[bk] = acc.get(bk, 0.0) + row_usd(
                r.get('model'),
                int(r.get('input_tokens') or 0),
                (int(r.get('output_tokens') or 0) + int(r.get('thoughts_tokens') or 0)),
                int(r.get('cache_creation_input_tokens') or 0),
                int(r.get('cache_read_input_tokens') or 0))
    except Exception as e:
        if c and c['month'] == mkey:
            journal('work-runner', 'gemini_cap',
                    'token_usage scan failed (%s); reusing last [%s] estimate $%.4f'
                    % (str(e)[:150], bucket, c['usd']))
            return c['usd'], True
        journal('work-runner', 'gemini_cap',
                'token_usage scan failed and there is no prior estimate (%s) -- FAILING CLOSED, '
                'no model call.' % str(e)[:200])
        return 0.0, False
    if n >= GEMINI_USAGE_SCAN_MAX:
        journal('work-runner', 'gemini_cap',
                'token_usage scan hit its %d-document ceiling, so every bucket total would be an '
                'UNDER-count -- FAILING CLOSED, no model call.' % GEMINI_USAGE_SCAN_MAX)
        return 0.0, False
    for b in SPEND_BUCKETS:
        _BUCKET_SPEND[b] = {'usd': float(acc.get(b) or 0.0), 'at': now, 'month': mkey}
    for b in acc:
        if b not in _BUCKET_SPEND:
            _BUCKET_SPEND[b] = {'usd': float(acc[b]), 'at': now, 'month': mkey}
    return _BUCKET_SPEND[bucket]['usd'], True


def spend_cap_check(role, model):
    """(allowed, message) for the bucket THIS model spends from.

    Per-bucket by design: Gemini at its ceiling must NOT refuse a Claude call. That independence
    is the whole reason the caps are split.
    """
    bucket = spend_bucket(model)
    cap = spend_caps_usd().get(bucket) or CAP_DEFAULT_USD.get(bucket) or 5.0
    usd, trusted = bucket_month_to_date_usd(bucket)
    if not trusted:
        msg = ('SPEND CAP [%s]: month-to-date spend is UNKNOWN (token_usage could not be '
               'summed). Failing CLOSED -- no model call. Cap is $%.2f/month.' % (bucket, cap))
        CAPPED['v'] = True; CAPPED['msg'] = msg
        journal(role, 'gemini_capped', msg)
        return False, msg
    pct = (usd / cap * 100.0) if cap else 0.0
    journal(role, 'gemini_spend',
            '[%s] month-to-date estimate $%.4f of $%.2f cap (%.1f%%) model=%s'
            % (bucket, usd, cap, pct, str(model)[:60]))
    if usd >= cap:
        _extra = ''
        if bucket == 'other':
            _extra = (" This model matched NO known bucket, so it bills against the 'other' "
                      "ceiling at the most expensive rate. Do not raise 'other' -- add a bucket "
                      "for model id '%s'." % str(model)[:60])
        msg = ('SPEND CAP REACHED [%s]: an estimated $%.4f this month against a HARD cap of '
               '$%.2f. Refusing the call. Raising it needs Face ID at the gate; nothing in this '
               'runner can raise it.%s' % (bucket, usd, cap, _extra))
        CAPPED['v'] = True; CAPPED['msg'] = msg
        journal(role, 'gemini_capped', msg)
        return False, msg
    return True, ''


def spend_topup(model, tin, tout, tcw, tcr):
    """[RATES-V1] Add this call's cost to the cached month-to-date for the bucket this MODEL
    belongs to, so a long loop cannot coast past the ceiling on a stale sum inside the TTL."""
    try:
        c = _BUCKET_SPEND.get(spend_bucket(model))
        if c is not None:
            c['usd'] += row_usd(model, tin, tout, tcw, tcr)
    except Exception:
        pass


# ATTRIBUTION -- READ THIS BEFORE YOU "FIX" IT.
# token_usage rows have NO provider field historically. Every write site (log_usage() below, the
# Gemini write in run_gemini(), and answer_runner.py's
# log_usage()) sets source='work-runner' / 'answer-runner' -- that is WHICH RUNNER, not WHICH
# VENDOR. The only pre-existing field that separates a Vertex-Gemini row from a Claude or DeepSeek
# row is `model`, which the Gemini path sets from cfg['work_gemini_model'] (default
# 'gemini-3.1-pro-preview'). So spend is attributed by MODEL-NAME PREFIX, with a new explicit
# `provider` field written going forward as a belt-and-braces second signal. If a future Gemini
# model id stops starting with 'gemini', ADD IT HERE or this cap silently stops seeing that spend.
GEMINI_MODEL_PREFIXES = ('gemini',)
GEMINI_PROVIDER_TAG = 'gemini-vertex'

# PRICE TABLE -- deliberately CONSERVATIVE (it ROUNDS UP). USD per 1,000,000 tokens.
# Basis: published Vertex AI list rates for Gemini 3 Pro at the time of writing -- $2.00/M input
# and $12.00/M output for prompts up to 200k tokens, $4.00/M input and $18.00/M output above 200k.
# The model actually configured here is 'gemini-3.1-pro-preview' and I could NOT confirm a rate
# card for it, so these numbers are the ABOVE-200k tier ROUNDED UP AGAIN -- roughly 2.5x the
# short-context rate. That is intentional and it is stated plainly: this estimate is HIGH. The
# ruling is a cap that stops early rather than late, so at a $20 cap the fleet will halt somewhere
# between roughly $8 and $20 of real spend. That is the correct failure direction.
# DO NOT lower these "to be more accurate" without a confirmed rate card. An optimistic estimate
# defeats the entire control.
# Cached input is billed at a discount in reality; here it is billed at the FULL input rate.
GEMINI_USD_PER_M_INPUT  = 5.00
GEMINI_USD_PER_M_OUTPUT = 20.00

# In-process month-to-date cache. A single item can make MAX_TURNS(24) calls and a tick can run
# WORK_BATCH(4) items, so re-scanning token_usage on every turn would be absurd. 60s TTL.
GEMINI_SPEND_TTL_SEC = 60
# Hard ceiling on documents scanned per month-sum. Never expected to be hit; if it IS hit the sum
# would be a silent UNDER-count, so hitting it is treated as "estimate not trustworthy" and fails
# closed rather than letting an optimistic number through.
GEMINI_USAGE_SCAN_MAX = 200000

_GEM_SPEND = {'usd': None, 'at': 0.0, 'month': ''}
_GEM_CAP   = {'usd': None, 'at': 0.0}
# Set when a Gemini call was REFUSED because of the cap. Read by do_item() so a capped item is
# never mislabelled as an ordinary failure (and so the sweeper never re-routes it into a retry).
CAPPED = {'v': False, 'msg': ''}

def _month_start_utc():
    from datetime import datetime, timezone
    n = datetime.now(timezone.utc)
    return n.replace(day=1, hour=0, minute=0, second=0, microsecond=0), n.strftime('%Y-%m')

def gemini_cap_usd():
    """The HARD cap in USD. Firestore config/limits.gemini_monthly_usd_cap, else FAIL CLOSED."""
    now = time.time()
    if _GEM_CAP['usd'] is not None and (now - _GEM_CAP['at']) < GEMINI_SPEND_TTL_SEC:
        return _GEM_CAP['usd']
    try:
        d = db.collection('config').document('limits').get()
        raw = (d.to_dict() or {}).get('gemini_monthly_usd_cap') if d.exists else None
        v = GEMINI_CAP_DEFAULT_USD if raw is None else float(raw)
        if not (v > 0):                      # 0, negative, or NaN -> fail closed at the default
            v = GEMINI_CAP_DEFAULT_USD
    except Exception:
        # Unreadable or malformed config NEVER means "unlimited".
        return GEMINI_CAP_DEFAULT_USD
    _GEM_CAP['usd'] = v; _GEM_CAP['at'] = now
    return v

def gemini_month_to_date_usd():
    """(usd_estimate, trusted) for the current UTC calendar month.

    trusted=False means the number could NOT be computed reliably (Firestore unreadable and no
    prior estimate, or the scan ceiling was hit). Callers MUST fail closed on trusted=False:
    refusing to spend against an unknown balance is the correct direction."""
    mstart, mkey = _month_start_utc()
    now = time.time()
    c = _GEM_SPEND
    if c['usd'] is not None and c['month'] == mkey and (now - c['at']) < GEMINI_SPEND_TTL_SEC:
        return c['usd'], True
    tin = tout = 0; n = 0
    try:
        q = (db.collection('token_usage')
               .where('ts', '>=', mstart)
               .select(['provider', 'model', 'input_tokens', 'output_tokens',
                        'cache_creation_input_tokens', 'thoughts_tokens'])
               .limit(GEMINI_USAGE_SCAN_MAX))
        for d in q.stream():
            n += 1
            r = d.to_dict() or {}
            prov = str(r.get('provider') or '').lower()
            mod  = str(r.get('model') or '').lower()
            if not (prov.startswith('gemini') or mod.startswith(GEMINI_MODEL_PREFIXES)):
                continue
            # input_tokens on the Gemini path is prompt_token_count, which ALREADY INCLUDES the
            # cached prefix -- so cache_read_input_tokens is NOT added here (that would double
            # count). Charging the cached portion at the full input rate is the conservative call.
            tin  += int(r.get('input_tokens') or 0) + int(r.get('cache_creation_input_tokens') or 0)
            # thoughts_tokens is written by run_gemini() from 2026-08-01 onward. Rows written
            # before that date have no such field, so thinking tokens in those rows are invisible
            # and the month-to-date figure UNDER-counts them; the rounded-up rates above are the
            # buffer that covers it.
            tout += int(r.get('output_tokens') or 0) + int(r.get('thoughts_tokens') or 0)
    except Exception as e:
        if c['usd'] is not None and c['month'] == mkey:
            journal('work-runner', 'gemini_cap',
                    'token_usage month scan failed (%s); reusing last estimate $%.4f' % (str(e)[:150], c['usd']))
            return c['usd'], True
        journal('work-runner', 'gemini_cap',
                'token_usage month scan failed and there is no prior estimate (%s) -- FAILING CLOSED, '
                'no Gemini/Vertex call.' % str(e)[:200])
        return 0.0, False
    if n >= GEMINI_USAGE_SCAN_MAX:
        journal('work-runner', 'gemini_cap',
                'token_usage month scan hit its %d-document ceiling, so the month-to-date total would '
                'be an UNDER-count -- FAILING CLOSED, no Gemini/Vertex call.' % GEMINI_USAGE_SCAN_MAX)
        return 0.0, False
    usd = (tin / 1000000.0) * GEMINI_USD_PER_M_INPUT + (tout / 1000000.0) * GEMINI_USD_PER_M_OUTPUT
    c['usd'] = usd; c['at'] = now; c['month'] = mkey
    return usd, True

def gemini_cap_check(role):
    """Back-compat alias, kept ONE release so nothing breaks silently. Use spend_cap_check."""
    return spend_cap_check(role, 'gemini')


def _retired_gemini_cap_check(role):
    """(allowed, message). Call IMMEDIATELY BEFORE every Vertex/Gemini request.

    Never raises, never retries, never sleeps. On refusal it journals the cap AND the estimate and
    the caller returns cleanly."""
    cap = gemini_cap_usd()
    usd, trusted = gemini_month_to_date_usd()
    if not trusted:
        msg = ('GEMINI CAP: month-to-date Gemini/Vertex spend is UNKNOWN (token_usage could not be '
               'summed). Failing CLOSED -- no Vertex call. Cap is $%.2f/month.' % cap)
        CAPPED['v'] = True; CAPPED['msg'] = msg
        journal(role, 'gemini_capped', msg)
        print('[gemini-cap] REFUSED (estimate untrusted), cap $%.2f' % cap, flush=True)
        return False, msg
    # Log the estimate at EVERY call so spend can be watched accruing in the journal and the log.
    pct = (usd / cap * 100.0) if cap else 0.0
    journal(role, 'gemini_spend',
            'month-to-date Gemini estimate $%.4f of $%.2f cap (%.1f%%)' % (usd, cap, pct))
    print('[gemini-cap] month-to-date $%.4f / cap $%.2f (%.1f%%)' % (usd, cap, pct), flush=True)
    if usd >= cap:
        msg = ('GEMINI CAP REACHED: an estimated $%.4f of Gemini/Vertex spend this month against a '
               'HARD cap of $%.2f (Firestore config/limits.gemini_monthly_usd_cap). Refusing the '
               'Vertex call. Raising the cap requires a Face ID-gated Firestore write -- see '
               'shared/runner/GEMINI-CAP.md. Nothing in this runner can raise it.' % (usd, cap))
        CAPPED['v'] = True; CAPPED['msg'] = msg
        journal(role, 'gemini_capped', msg)
        return False, msg
    return True, ''

# ---- F1/F2: EXECUTABLE-WRITE BOUNDARY ---------------------------------------------------------
# The deploy scripts cat these prefixes out of the lake and EXECUTE them: deploy-cp-harness.sh
# (the five vault cleartext prefixes, listed in the tuple below), the
# loader and deploy-work-runner.sh (the prefix holding THIS file).
# A bus agent that can write them is deferred remote code execution. Writes are denied; READS are
# untouched (t_read_file passes write=False, so LAWS/LESSONS/source review all keep working).
#
# FINDING 5.1 -- READ THIS BEFORE YOU EDIT THE LIST. This is ONE boundary with TWO independent
# implementations: this tuple, and the control plane's LAKE_EXEC_PREFIXES
# (TypeScript, deployed by a different script on a different schedule). Nothing else makes them
# agree. Changing one without the other is a SECURITY REGRESSION: the boundary would be closed on
# the bus path and open on the MCP path. Both files carry the same literal list AND the same
# canonical digest below, and each refuses to start if its own list does not hash to it. Change the
# list => change BOTH files and recompute the digest in both.
# NOT the same thing as VAULT_CLEARTEXT_PREFIXES (an at-rest ENCRYPTION exemption in the control
# plane); that list grants and denies nothing. Do not conflate them.
# The digest is compiled in and is NEVER fetched from the lake -- a lake-hosted boundary would be
# writable by the principals it restrains.
# VERIFY-GREP: F1-EXEC-WRITE-BOUNDARY-WIRED
LAKE_EXEC_PREFIXES = ('shared/deploy/', 'shared/harness/', 'shared/passkey/', 'shared/mcp-oauth/', 'shared/vault/', 'shared/security/', 'shared/runner/', 'shared/gate-exec/', 'shared/reaper/')
LAKE_EXEC_BOUNDARY_SHA256 = 'c51a6cf76ceedc0e4a401ad961d12c52ef2e10fb8d9e4cb835cde23998b2e51e'

def _assert_exec_boundary():
    import hashlib
    canon = '\n'.join(sorted(LAKE_EXEC_PREFIXES)) + '\n'
    got = hashlib.sha256(canon.encode('utf-8')).hexdigest()
    if got != LAKE_EXEC_BOUNDARY_SHA256:
        raise RuntimeError('FATAL F1/F2: executable-write boundary digest mismatch. want=%s got=%s '
                           '-- refusing to start with an unverified boundary.'
                           % (LAKE_EXEC_BOUNDARY_SHA256, got))
_assert_exec_boundary()

_EXEC_DENY_MSG = ("denied: {prefix} is an EXECUTABLE prefix -- the deploy chain runs code from it, so "
                  "no role (including {role}) may write there. Reads are still allowed. Write your "
                  "change as a SPEC under shared/state/ (e.g. shared/state/security-fixes/), name it in "
                  "your complete_work_item note, and a human deploys it. shared/state/, "
                  "shared/handoff/, shared/oss-release/ and agents/{role}/ are unaffected.")

def _exec_prefix(p):
    for px in LAKE_EXEC_PREFIXES:
        if p.startswith(px): return px
    return None

def _allowed(role, path, write):
    p = path.lstrip('/')
    if write and _exec_prefix(p): return None
    if p.startswith('shared/'): return p
    if p.startswith('agents/' + role + '/'): return p
    if '/' not in p or not p.startswith('agents/'): return 'agents/' + role + '/' + p
    return None

# --- PCV1-RUNNER-SEAL-V1: THE RUNNER'S OWN SOURCE MUST STAY PLAINTEXT --------
# bootstrap.py hot-loads this file's deployed copy with
# download_as_text(), and deploy-work-runner.sh does
#     gcloud storage cat <this file's deployed object> > main.py
#     grep -q "fleet-work-runner" main.py || { echo "STOP: runner source missing"; exit 1; }
# Sealing this object breaks BOTH: the hot loader would exec ciphertext and the
# deploy would exit 1. The same is true of the codec peer and the two files
# _pcv1_codec() bootstraps from -- they are read BEFORE any key exists, so a
# sealed codec is an unrecoverable bootstrap loop.
#
# The runner, vault and deploy prefixes are all inside
# LAKE_EXEC_PREFIXES, so every write path in this file ALREADY refuses them. This
# assertion is what keeps that true: narrow the boundary and the runner refuses to
# START, rather than sealing its own source and discovering it in production.
_SEAL_MUST_STAY_PLAINTEXT = (
    'shared/runner/work_item_runner.py',   # hot-loaded by bootstrap.py; grepped by the deploy
    'shared/runner/vault_runtime.py',      # runner-side codec peer
    'shared/vault/envelope.py',            # the codec _pcv1_codec() loads
    'shared/deploy/lane-fetch.py',         # the master-key fetcher _pcv1_master() loads
)


def _assert_seal_cannot_reach_bootstrap():
    bad = [q for q in _SEAL_MUST_STAY_PLAINTEXT if _exec_prefix(q) is None]
    if bad:
        raise RuntimeError(
            'FATAL PCV1-RUNNER-SEAL-V1: %r is writable by this runner, so a write would SEAL '
            'it. That breaks bootstrap.py download_as_text() and the `grep -q fleet-work-runner` '
            'in deploy-work-runner.sh. Refusing to start.' % (bad,))


_assert_seal_cannot_reach_bootstrap()

# --- PCV1-RUNNER-GUARD-V2 -----------------------------------------------
# PCV1 envelope safety for the lake file tools.
#
# magic b'PCV1' | epoch(1) | flags(1) | nonce(12) | ciphertext | tag(16)
# Fixed overhead 34 bytes.
#
# Three call sites read-modify-write the lake: t_edit_file, t_stage_job (the
# handoff append) and -- read only -- t_read_file. The handoff prefix is NOT
# one of the five VAULT_CLEARTEXT_PREFIXES, so handoff objects are PCV1 too.
#
# The codec is NOT reimplemented here. envelope.py and
# lane-fetch.py are pulled from the lake at run time (exact paths below) -- both are
# in cleartext prefixes, so a plain download reads them. The only local decisions
# are a 4-byte magic comparison and a minimum-length check.
_PCV1_MAGIC = b'PCV1'
_PCV1_MIN_ENVELOPE = 34          # 4 magic + 1 epoch + 1 flags + 12 nonce + 16 tag
_PCV1_CODEC_PATH = 'shared/vault/envelope.py'
_PCV1_LANEFETCH_PATH = 'shared/deploy/lane-fetch.py'
_PCV1_NEG_TTL = 120.0            # seconds to remember "master unavailable"
_pcv1_threading = __import__('threading')
_pcv1_time = __import__('time')
_pcv1_cache = {}
_pcv1_lock = _pcv1_threading.Lock()          # protects _pcv1_cache only -- never held over I/O
_pcv1_boot_lock = _pcv1_threading.Lock()
_pcv1_epoch_locks = {}


def _pcv1_is_envelope(raw):
    """True iff these bytes carry the PCV1 magic. Magic only -- not a codec.

    Deliberately magic-only and NOT length-aware: a 4-byte b'PCV1' object is a
    DAMAGED envelope and must still be refused for writing. Length is judged
    separately by _pcv1_epoch().
    """
    return (isinstance(raw, (bytes, bytearray))
            and len(raw) >= 4 and bytes(raw[:4]) == _PCV1_MAGIC)


def _pcv1_epoch(raw):
    """Epoch byte, or None if the object is too short to be a real envelope.

    Returning None is how a truncated envelope reaches its own refusal instead of
    raising IndexError out of the guard and surfacing as 'tool error: index out of
    range' -- which is exactly the drift-flavoured message this guard exists to
    prevent.
    """
    if len(raw) < _PCV1_MIN_ENVELOPE:
        return None
    return raw[4]


def _pcv1_generation(blob):
    """Pin the object's current generation. Raises rather than writing unfenced.

    A check-then-write with no precondition still destroys an object that becomes
    encrypted between the read and the write -- the live case during an encryption
    sweep. Every surviving read-modify-write in this file is fenced on this value.
    """
    try:
        blob.reload()
    except BaseException as e:
        raise RuntimeError('cannot pin a generation for %s (%s: %s) -- refusing to write '
                           'without a concurrency precondition'
                           % (getattr(blob, 'name', '?'), type(e).__name__, str(e)[:120]))
    g = getattr(blob, 'generation', None)
    if g is None:
        raise RuntimeError('no generation on %s after reload() -- refusing to write without a '
                           'concurrency precondition' % getattr(blob, 'name', '?'))
    return int(g)


def _pcv1_codec():
    """The canonical codec + lane-fetch master derivation, imported from the lake."""
    with _pcv1_boot_lock:
        if 'codec' in _pcv1_cache:
            return _pcv1_cache['codec'], _pcv1_cache['lanefetch'], _pcv1_cache['workdir']
        import importlib.util, os as _os, sys as _sys, tempfile as _tf
        wd = _tf.mkdtemp(prefix='pcv1-runner.')
        loaded = {}
        for key, lake_path, modname in (('codec', _PCV1_CODEC_PATH, 'envelope'),
                                        ('lanefetch', _PCV1_LANEFETCH_PATH, 'lane_fetch')):
            raw = bkt.blob(lake_path).download_as_bytes()
            if _pcv1_is_envelope(raw):
                raise RuntimeError(
                    '%s is ITSELF a PCV1 envelope -- the cleartext-prefix bootstrap is '
                    'broken and nothing in the lake can be decrypted until it is fixed.'
                    % lake_path)
            dst = _os.path.join(wd, modname + '.py')
            with open(dst, 'wb') as _fh:
                _fh.write(raw)
            spec = importlib.util.spec_from_file_location(modname, dst)
            mod = importlib.util.module_from_spec(spec)
            _sys.modules.setdefault(modname, mod)
            spec.loader.exec_module(mod)
            loaded[key] = mod
        # [PCV1-RUNNER-SEAL-V1] encrypt/is_cleartext/CLEARTEXT_PREFIXES/EPOCH are
        # required now that this runner SEALS. A codec that cannot seal must fail
        # here, at load, and not at the moment an object is about to be replaced.
        for _attr in ('decrypt_bytes', 'encrypt', 'is_encrypted', 'is_cleartext',
                      'CLEARTEXT_PREFIXES', 'EPOCH', 'KEM_SPEC'):
            if not hasattr(loaded['codec'], _attr):
                raise RuntimeError('codec from %s has no %s -- wrong or truncated file'
                                   % (_PCV1_CODEC_PATH, _attr))
        if not hasattr(loaded['lanefetch'], 'master_for_epoch'):
            raise RuntimeError('%s has no master_for_epoch -- wrong or truncated file'
                               % _PCV1_LANEFETCH_PATH)
        # [PCV1-RUNNER-SEAL-V1] THE CLEARTEXT LIST IS ONE INVARIANT ACROSS THREE
        # PEERS (the control plane, the envelope codec,
        # and the runner-side codec peer). This runner does NOT re-declare it --
        # it reads the codec's own list and refuses if that list has drifted.
        # Exactly five, and every one of them inside the executable-write
        # boundary. The second half is what makes "seal by default" TOTAL: since
        # all five cleartext prefixes are exec-denied, _allowed(write=True) can
        # never return a cleartext path, so every path this runner can write is a
        # SEAL path. Widening the list would reopen a plaintext write path.
        _ct = tuple(getattr(loaded['codec'], 'CLEARTEXT_PREFIXES', None) or ())
        if len(_ct) != 5:
            raise RuntimeError(
                'codec CLEARTEXT_PREFIXES has %d entries, want exactly 5 -- refusing to seal '
                'against a list that has drifted from its peers.' % len(_ct))
        _widened = [x for x in _ct if _exec_prefix(str(x)) is None]
        if _widened:
            raise RuntimeError(
                'codec CLEARTEXT_PREFIXES contains %r, which is NOT inside the executable-write '
                'boundary. Every path this runner may write must be a SEAL path; a cleartext '
                'prefix outside the boundary makes plaintext writes reachable again. Refusing.'
                % (_widened,))
        _pcv1_cache['codec'] = loaded['codec']
        _pcv1_cache['lanefetch'] = loaded['lanefetch']
        _pcv1_cache['workdir'] = wd
        return loaded['codec'], loaded['lanefetch'], wd


def _pcv1_master(epoch):
    """32-byte vault master for `epoch`, memoized. Raises if unobtainable.

    lane-fetch's die() path raises SystemExit, which is a BaseException and would
    otherwise tear down the worker instead of surfacing as a tool error.

    Concurrency: the cache mutex is NEVER held across the gcloud/KMS derivation.
    Derivation is serialised per epoch, so a slow or failing epoch cannot block
    reads of a different one.

    Failures ARE cached, for _PCV1_NEG_TTL seconds. The expected day-one state is
    a runner SA without cloudkms...useToDecapsulate; without a negative cache every
    read of every one of the ~45 PCV1 objects spawns a fresh gcloud subprocess that
    403s. The refusal still fires on every call -- only the subprocess is
    suppressed, and the message says the failure is cached and when it expires.
    """
    epoch = int(epoch)
    now = _pcv1_time.time()
    with _pcv1_lock:
        hit = _pcv1_cache.get(('master', epoch))
        if hit is not None:
            return hit
        neg = _pcv1_cache.get(('fail', epoch))
        if neg is not None and now < neg[0]:
            raise RuntimeError('vault master unavailable for epoch %d (cached failure, retried '
                               'in %ds): %s' % (epoch, int(neg[0] - now) + 1, neg[1]))
        lk = _pcv1_epoch_locks.get(epoch)
        if lk is None:
            lk = _pcv1_epoch_locks[epoch] = _pcv1_threading.Lock()
    with lk:
        with _pcv1_lock:
            hit = _pcv1_cache.get(('master', epoch))
            if hit is not None:
                return hit
        try:
            codec, lanefetch, wd = _pcv1_codec()
            m = lanefetch.master_for_epoch(codec, epoch, wd)
            if not isinstance(m, (bytes, bytearray)) or len(m) != 32:
                raise RuntimeError('master_for_epoch returned %d bytes, want 32' % len(m or b''))
        except BaseException as e:
            why = '%s: %s' % (type(e).__name__, str(e)[:200])
            with _pcv1_lock:
                _pcv1_cache[('fail', epoch)] = (_pcv1_time.time() + _PCV1_NEG_TTL, why)
            raise RuntimeError('vault master unavailable for epoch %d (%s)' % (epoch, why))
        with _pcv1_lock:
            _pcv1_cache[('master', epoch)] = bytes(m)
            _pcv1_cache.pop(('fail', epoch), None)
            return _pcv1_cache[('master', epoch)]


def _pcv1_sidecar(path):
    """A NEW handoff path that does not exist yet. Never overwrites anything."""
    base = path[:-3] if path.endswith('.md') else path
    stamp = _pcv1_time.strftime('%H%M%S', _pcv1_time.gmtime())
    for i in range(64):
        cand = '%s.proposal-%s-%d.md' % (base, stamp, i)
        if not bkt.blob(cand).exists():
            return cand
    raise RuntimeError('no free sidecar path next to %s after 64 tries' % path)


_PCV1_TWOLINER = ('gcloud storage cp gs://{b}/shared/deploy/lane-fetch.py /tmp/lane-fetch.py'
                  ' && python3 /tmp/lane-fetch.py {p} /tmp/plain')

# Master could not be obtained. The object itself has NOT been examined beyond its
# magic, and there is no evidence against it -- so, and ONLY here, we say so.
_PCV1_READ_REFUSAL = (
    "REFUSED: {p} is ENCRYPTED AT REST (PCV1 envelope, epoch {e}). Nothing is known to be wrong "
    "with this object -- it is ciphertext, and that is correct. This runner could not obtain the "
    "vault master key, so it will NOT decode the raw bytes as text: that would return mojibake "
    "and report success. Reason: {why}. Read it with the lane-fetch two-liner instead: "
    + _PCV1_TWOLINER)

# Master WAS obtained and decryption still failed. Saying "not corrupt" here would
# be a lie in the one case where the object really is destroyed.
_PCV1_DECRYPT_REFUSAL = (
    "REFUSED: {p} is a PCV1 envelope (epoch {e}). The vault master WAS obtained and decryption "
    "still FAILED: {why}. DO NOT assume this object is healthy. An authentication failure means "
    "the bytes do not match the key and the object-path AAD, so this object may ALREADY BE "
    "DAMAGED -- an unguarded edit_file/write_file overwrite leaves the PCV1 magic in place -- or "
    "it may be from another epoch or another key. This runner will NOT decode ciphertext as text. "
    "Confirm with the lane-fetch two-liner (" + _PCV1_TWOLINER + "). If that also fails, treat the "
    "object as DAMAGED: restore it from object versioning. Do NOT overwrite it and do NOT 'repair' "
    "it with write_file -- that erases the last evidence of what it was.")

# Starts with PCV1 but is shorter than the fixed 34-byte overhead.
_PCV1_TRUNC_REFUSAL = (
    "REFUSED: {p} carries the PCV1 magic but is only {n} bytes. A valid envelope is at least 34 "
    "(4 magic + 1 epoch + 1 flags + 12 nonce + 16 tag), so this object is TRUNCATED or DAMAGED. "
    "It cannot be decrypted and it must NOT be written to: an edit or a write here would replace "
    "a damaged envelope with plaintext and erase the last evidence of what it held. Restore it "
    "from object versioning (gcloud storage ls -a gs://{b}/{p}).")

# [PCV1-RUNNER-SEAL-V1] The old blanket edit refusal is GONE. It said "edit_file
# writes PLAINTEXT", which was true and is now false: edit_file decrypts, edits,
# and RE-SEALS. Leaving that text in place would have been a refusal message that
# lies. The cases where an edit still cannot proceed are covered by the existing
# TRUNC / READ / DECRYPT refusals plus the new seal refusal below.
_PCV1_SEAL_REFUSAL = (
    "REFUSED: {p} must be stored ENCRYPTED -- it is not under a vault cleartext prefix -- and "
    "this runner could not seal it. NOTHING WAS WRITTEN: the envelope is computed BEFORE the "
    "upload, so a failure here cannot leave a half-written object and cannot downgrade a sealed "
    "object to plaintext. Reason: {why}. This is the correct outcome, not an outage to work "
    "around: do NOT retry with a different tool and do NOT 'repair' the object. If the vault "
    "master is unavailable the runner cannot write encrypted objects at all until that is fixed.")

_PCV1_EDIT_BINARY_REFUSAL = (
    "REFUSED: {p} decrypted cleanly but is NOT valid UTF-8 ({why}). edit_file does string "
    "replacement, and decoding these bytes with errors='replace' would substitute U+FFFD, write "
    "the result back, and report success -- silently destroying the object while claiming to have "
    "edited it. Nothing was written. Fetch it with the lane-fetch two-liner ("
    + _PCV1_TWOLINER + ") and edit it as bytes.")

_PCV1_STAGE_NOTE = (
    "\n\nNOTE: the day's handoff file is ENCRYPTED AT REST (PCV1). shared/handoff/ is NOT one of "
    "the vault cleartext prefixes, so appending plaintext to it would have destroyed the "
    "ciphertext. This proposal was written to a NEW sidecar object instead; the encrypted handoff "
    "file was not touched. Read it with the lane-fetch two-liner.")
# --- PCV1-RUNNER-GUARD-V2 end -------------------------------------------------


def _pcv1_seal_for_write(p, plaintext):
    """PLAINTEXT (str|bytes) -> (bytes to STORE at p, sealed?). Fails CLOSED.

    Sealing is the DEFAULT and the only exemption is the codec's OWN
    CLEARTEXT_PREFIXES list, read out of the module loaded from the lake. This
    file deliberately does NOT re-declare that list: it is one invariant across
    three peers and a fourth copy here would be a fourth thing to drift.

    Binary safety: the codec's encrypt() takes bytes and decrypt_bytes() returns
    bytes. envelope.decrypt() is NEVER used on a write path -- its legacy branch
    decodes with errors="replace", which substitutes U+FFFD for non-UTF-8 bytes
    and reports success.

    Nothing here touches the network or the bucket. That is the point: the caller
    gets the bytes to store, or an exception, and there is no state in between.
    """
    if isinstance(plaintext, str):
        data = plaintext.encode('utf-8')
    elif isinstance(plaintext, (bytes, bytearray)):
        data = bytes(plaintext)
    else:
        raise TypeError('content for %s is %s, not str/bytes' % (p, type(plaintext).__name__))
    if _pcv1_is_envelope(data):
        raise RuntimeError(
            'the content offered for %s already carries the PCV1 magic. Sealing it would '
            'DOUBLE-SEAL an envelope and storing it verbatim would install bytes this runner '
            'cannot account for.' % p)
    codec = _pcv1_codec()[0]
    if codec.is_cleartext(p):
        return data, False
    master = _pcv1_master(int(codec.EPOCH))
    sealed = codec.encrypt(master, p, data)
    # A seal is only allowed to replace an object once it has been PROVEN to
    # round-trip. AES-GCM is microseconds; a silently unreadable object is
    # permanent.
    if not _pcv1_is_envelope(sealed) or len(sealed) != len(data) + _PCV1_MIN_ENVELOPE:
        raise RuntimeError('seal for %s produced %d bytes for a %d-byte payload (want %d)'
                           % (p, len(sealed), len(data), len(data) + _PCV1_MIN_ENVELOPE))
    if codec.decrypt_bytes(master, p, sealed) != data:
        raise RuntimeError('seal round-trip self-check FAILED for %s' % p)
    return sealed, True


def _pcv1_upload(p, plaintext, if_generation_match):
    """SEAL, THEN UPLOAD. The ONLY place this file puts bytes in the lake.

    Every write site goes through here, so "does the runner seal?" is a question
    about ONE function instead of five call sites. The ordering is the control:
    the envelope is built first and the upload is never reached if it cannot be.

    if_generation_match is REQUIRED, never defaulted. 0 means "must not exist".
    An unfenced write is how a sealed object gets silently replaced between a
    read and a write, which is the whole failure this block exists to stop.
    """
    body, sealed = _pcv1_seal_for_write(p, plaintext)
    bkt.blob(p).upload_from_string(
        body, if_generation_match=if_generation_match,
        content_type='application/octet-stream' if sealed else 'text/plain')
    return sealed


def t_read_file(role, args):
    p = _allowed(role, args['path'], False)
    if not p: return "denied: outside your scope"
    b = bkt.blob(p)
    if not b.exists(): return f"(no file at {p})"
    _raw = b.download_as_bytes()
    if not _pcv1_is_envelope(_raw):
        return _raw.decode('utf-8', errors='replace')  # legacy plaintext, unchanged
    _epoch = _pcv1_epoch(_raw)
    if _epoch is None:
        return _PCV1_TRUNC_REFUSAL.format(p=p, n=len(_raw), b=BUCKET)
    try:
        _master = _pcv1_master(_epoch)
    except BaseException as _e:
        return _PCV1_READ_REFUSAL.format(
            p=p, e=_epoch, b=BUCKET,
            why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
    try:
        _codec = _pcv1_codec()[0]
        return _codec.decrypt_bytes(_master, p, _raw).decode('utf-8')
    except BaseException as _e:
        return _PCV1_DECRYPT_REFUSAL.format(
            p=p, e=_epoch, b=BUCKET,
            why='%s: %s' % (type(_e).__name__, str(_e)[:200]))

def t_write_file(role, args):
    _px = _exec_prefix(str(args.get('path','')).lstrip('/'))
    if _px: return _EXEC_DENY_MSG.format(prefix=_px, role=role)
    p = _allowed(role, args['path'], True)
    if not p: return "denied: outside your scope"
    # [PCV1-RUNNER-SEAL-V1] was a bare one-line raw upload of args['content'] --
    # no envelope, no envelope CHECK and no precondition, so it silently replaced
    # ciphertext with plaintext. Now: pin the generation, seal, then write.
    _content = args.get('content','')
    _b = bkt.blob(p)
    try:
        _gen = _pcv1_generation(_b) if _b.exists() else 0
    except BaseException as _e:
        return _PCV1_SEAL_REFUSAL.format(p=p, why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
    try:
        _sealed = _pcv1_upload(p, _content, _gen)
    except BaseException as _e:
        return _PCV1_SEAL_REFUSAL.format(p=p, why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
    return (f"wrote gs://{BUCKET}/{p} ({len(_content)} chars, "
            f"{'SEALED PCV1' if _sealed else 'cleartext prefix'})")

def t_edit_file(role, args):
    _px = _exec_prefix(str(args.get('path','')).lstrip('/'))
    if _px: return _EXEC_DENY_MSG.format(prefix=_px, role=role)
    p = _allowed(role, args['path'], True)
    if not p: return "denied: outside your scope"
    b = bkt.blob(p)
    if not b.exists(): return f"(no file at {p}) — use write_file to create it"
    _gen = _pcv1_generation(b)
    _raw = b.download_as_bytes(if_generation_match=_gen)
    if _pcv1_is_envelope(_raw):
        # [PCV1-RUNNER-SEAL-V1] This used to be a blanket refusal, which was
        # correct only because the write below was plaintext. Now that the write
        # RE-SEALS, refusing every sealed object would have made edit_file
        # one-shot per object: the first edit seals it and every later edit is
        # refused. So: decrypt through the SAME ladder t_read_file uses, and keep
        # a refusal on every branch that cannot be completed honestly.
        _epoch = _pcv1_epoch(_raw)
        if _epoch is None:
            return _PCV1_TRUNC_REFUSAL.format(p=p, n=len(_raw), b=BUCKET)
        try:
            _master = _pcv1_master(_epoch)
        except BaseException as _e:
            return _PCV1_READ_REFUSAL.format(
                p=p, e=_epoch, b=BUCKET, why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
        try:
            _plain = _pcv1_codec()[0].decrypt_bytes(_master, p, _raw)
        except BaseException as _e:
            return _PCV1_DECRYPT_REFUSAL.format(
                p=p, e=_epoch, b=BUCKET, why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
        try:
            txt = _plain.decode('utf-8')
        except BaseException as _e:
            return _PCV1_EDIT_BINARY_REFUSAL.format(
                p=p, why='%s: %s' % (type(_e).__name__, str(_e)[:120]))
    else:
        txt = _raw.decode('utf-8', errors='replace')
    old = args.get('old_string',''); new = args.get('new_string','')
    if not old: return "old_string required (exact snippet to replace)"
    n = txt.count(old)
    if n == 0: return f"old_string not found in {p}. read_file it and copy the EXACT text (whitespace incl.)."
    if n > 1: return f"old_string appears {n}x in {p}; add surrounding lines to make it UNIQUE, then retry."
    try:
        _sealed = _pcv1_upload(p, txt.replace(old, new, 1), _gen)
    except BaseException as _e:
        return _PCV1_SEAL_REFUSAL.format(p=p, why='%s: %s' % (type(_e).__name__, str(_e)[:200]))
    return (f"edited {p}: replaced 1 occurrence ({len(old)}->{len(new)} chars, "
            f"{'re-SEALED PCV1' if _sealed else 'cleartext prefix'}).")

def t_list_files(role, args):
    pre = args.get('prefix','shared/')
    names = [b.name for b in gcs.list_blobs(BUCKET, prefix=pre.lstrip('/'), max_results=200)]
    return "\n".join(names[:200]) or "(empty)"

def t_append_journal(role, args):
    journal(role, args.get('action','note'), args.get('message',''))
    return "journaled"

def t_ask_agent(role, args):
    db.collection('agent_messages').add({'from':role,'to':args['to'],'question':args.get('question',''),
        'context':args.get('context',''),'status':'open','urgency':args.get('urgency','normal'),
        'ts': firestore.SERVER_TIMESTAMP})
    return f"asked {args['to']} (answer-runner will reply; check back next run)"

_READ_SHELL = {'cat','ls','head','tail','wc','grep','egrep','fgrep','find','less','more','stat','file','tree','sed','awk'}
def t_stage_job(role, args):
    ct = (args.get('command_type') or 'run_cmd').strip()
    cmd = (args.get('command') or '')
    if ct == 'run_cmd' and cmd.strip():
        first = cmd.strip().split()[0].split('/')[-1].lower()
        if first in _READ_SHELL or (first in ('python3','python') and ('open(' in cmd or '.read(' in cmd)):
            return ("BLOCKED — do NOT use shell/python to read/list/edit files. Use read_file, list_files, "
                    "edit_file, or write_file. stage_privileged_job is only for real deploys (gcloud/firebase/npm).")
    jargs = {}
    if args.get('command'): jargs['command'] = args['command']
    if args.get('target'):  jargs['targetNode'] = args['target']
    # BUS CANNOT STAGE (operator ruling, 2026-07-25). Every Cowork chat and every bus agent share
    # the single operator principal, and approving ONE gated job SUPERSEDES every other job from
    # that principal -- so a bus-staged job can silently kill a human's staged work. Default is to
    # write the proposal into the strain's handoff file; the advisor stages them one at a time.
    # Escape hatch, no redeploy: set config/models.bus_can_stage = 'on'.
    _can = str(model_cfg().get('bus_can_stage') or os.environ.get('BUS_CAN_STAGE') or 'off').strip().lower()
    if _can not in ('on', '1', 'true', 'yes'):
        _day = time.strftime('%Y-%m-%d', time.gmtime())
        _path = 'shared/handoff/' + role + '-' + _day + '.md'
        _blob = bkt.blob(_path)
        _entry = ('\n## PROPOSED ' + ct + ' at ' + time.strftime('%H:%M:%SZ', time.gmtime()) + '\n\n'
                  '```\n' + str(jargs.get('command', ''))[:4000] + '\n```\n\n'
                  'target: ' + str(jargs.get('targetNode', '(none)')) + '\n')
        _exists = _blob.exists()
        _gen = _pcv1_generation(_blob) if _exists else None
        _raw = _blob.download_as_bytes(if_generation_match=_gen) if _exists else None
        _note = ''
        if _raw is not None and _pcv1_is_envelope(_raw):
            # The handoff prefix is NOT vault-cleartext, so these objects are PCV1.
            # [PCV1-RUNNER-SEAL-V1] This runner now SEALS, so it can also DECRYPT: the
            # normal path is decrypt -> append -> re-seal, fenced on the generation that
            # was already pinned. Without this, the first sealed handoff would make every
            # later proposal a new sidecar object forever -- the same one-shot trap the
            # edit_file change avoids. The sidecar survives as the FALLBACK for the cases
            # where decryption is genuinely impossible: nothing is read-modify-written
            # there, so a damaged or unreadable handoff can never be destroyed by a
            # proposal. Fail closed means fall back to a NEW object, never to plaintext.
            _dec = None
            _why = ''
            _ep = _pcv1_epoch(_raw)
            if _ep is None:
                _why = 'the object carries the PCV1 magic but is truncated (%d bytes)' % len(_raw)
            else:
                try:
                    _dec = _pcv1_codec()[0].decrypt_bytes(_pcv1_master(_ep), _path, _raw)
                except BaseException as _e:
                    _why = '%s: %s' % (type(_e).__name__, str(_e)[:160])
            if _dec is not None:
                try:
                    _prev = _dec.decode('utf-8')
                except BaseException as _e:
                    _dec = None
                    _why = 'decrypted but not valid UTF-8 (%s)' % type(_e).__name__
            if _dec is not None:
                _pcv1_upload(_path, _prev + _entry, _gen)
            else:
                _path = _pcv1_sidecar(_path)
                _note = _PCV1_STAGE_NOTE
                _prev = ('# HANDOFF (sidecar) - ' + role + ' ' + _day + '\n\n'
                         'The main handoff file for this day is ENCRYPTED AT REST (PCV1) and this\n'
                         'runner could not read it: ' + _why + '.\n'
                         'It will NOT append plaintext to it and it will NOT overwrite it. This\n'
                         'sidecar holds the proposal instead.\n')
                _pcv1_upload(_path, _prev + _entry, 0)
        elif _raw is None:
            _prev = ('# HANDOFF - ' + role + ' ' + _day + '\n\n'
                     'Privileged actions this strain proposed. The bus cannot stage them; the advisor reviews\n'
                     'and stages them ONE AT A TIME so they do not supersede each other.\n')
            _pcv1_upload(_path, _prev + _entry, 0)
        else:
            _prev = _raw.decode('utf-8', errors='replace')
            _pcv1_upload(_path, _prev + _entry, _gen)
        journal(role, 'stage_deferred',
                'NOT staged (bus_can_stage=off). ' + ct + ' proposal appended to ' + _path)
        return ('NOT STAGED - the bus is not allowed to put jobs on the human gate. Approving one job '
                'supersedes every other pending job from the same principal, so a bus-staged job can '
                'silently kill a human running job. Your proposal has been APPENDED to ' + _path + ' and '
                'the advisor will stage it. Reference that file in your complete_work_item note and '
                'treat your deliverable as done.')
    ref = db.collection('pending_confirms').document()
    ref.set({'job_id': ref.id, 'staged_by': role, 'command_type': ct,
             'arguments': jargs, 'status': 'pending', 'created_at': firestore.SERVER_TIMESTAMP,
             'expireAt': _ttl_expire_at(60)})
    try: STAGED['ids'].append(ref.id)
    except Exception: pass
    journal(role, 'stage_job', f"Staged {ct} ({ref.id}) awaiting human approval: {str(jargs.get('command',''))[:200]}")
    return (f"STAGED job {ref.id} ({ct}) on the operator gate — NOT run until the operator "
            f"approves. Name this job id in your complete_work_item note.")

# [HIST-V1] Job ids this item actually staged. Fleet rule: name only identifiers a tool
# returned to you -- so the history entry quotes these rather than anything the model said.
STAGED = {'ids': []}
DONE = {'v': False, 'note': ''}
def t_complete(role, args):
    DONE['v'] = True; DONE['note'] = args.get('note','done')
    return "work item marked complete"

TOOLS = [
 {"name":"read_file","description":"Read a lake file (shared/... or agents/<role>/...). Use this to read source — never shell.","input_schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}},
 {"name":"edit_file","description":"PATCH a file: replace ONE exact occurrence of old_string with new_string. USE THIS for big files instead of rewriting. old_string must match the file EXACTLY (copy from read_file) and be unique.","input_schema":{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]}},
 {"name":"write_file","description":"Create or fully overwrite a SMALL/new file. For large existing files use edit_file.","input_schema":{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}},
 {"name":"list_files","description":"List files under a prefix (default shared/). Use ONCE to find a path — do not re-list repeatedly.","input_schema":{"type":"object","properties":{"prefix":{"type":"string"}}}},
 {"name":"append_journal","description":"Record a short progress note to the fleet journal.","input_schema":{"type":"object","properties":{"action":{"type":"string"},"message":{"type":"string"}},"required":["message"]}},
 {"name":"ask_agent","description":"Ask another fleet agent a question (async).","input_schema":{"type":"object","properties":{"to":{"type":"string"},"question":{"type":"string"},"context":{"type":"string"},"urgency":{"type":"string"}},"required":["to","question"]}},
 {"name":"stage_privileged_job","description":"PROPOSE a privileged action for the operator gate (runs only after the operator confirms). ONLY for real execution: a deploy or gcloud/firebase/npm/node/python3 command, or ssh. NEVER to read/edit files. Returns the job id.","input_schema":{"type":"object","properties":{"command_type":{"type":"string"},"command":{"type":"string"},"target":{"type":"string"}},"required":["command_type"]}},
 {"name":"complete_work_item","description":"Call when done (deliverable written and/or job staged). One-line summary; name any staged job id.","input_schema":{"type":"object","properties":{"note":{"type":"string"}},"required":["note"]}},
]
DISPATCH = {"read_file":t_read_file,"write_file":t_write_file,"edit_file":t_edit_file,"list_files":t_list_files,
            "append_journal":t_append_journal,"ask_agent":t_ask_agent,"stage_privileged_job":t_stage_job,
            "complete_work_item":t_complete}

def run_gemini(role, model, sys_prompt, user_text):
    from google import genai
    from google.genai import types
    cfg = model_cfg()
    region = cfg.get('vertex_region') or 'global'
    client = genai.Client(vertexai=True, project=PROJECT, location=region)
    fds = [types.FunctionDeclaration(name=t["name"], description=t["description"], parameters=t["input_schema"]) for t in TOOLS]
    gen_kwargs = dict(
        system_instruction=sys_prompt,
        tools=[types.Tool(function_declarations=fds)],
        tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode=(cfg.get('gemini_tool_mode') or 'AUTO'))),
        max_output_tokens=int(cfg.get('gemini_max_tokens') or MAX_TOKENS))
    _t = cfg.get('gemini_temperature')
    if _t is not None:
        try: gen_kwargs['temperature'] = float(_t)
        except Exception: pass
    _tl = str(cfg.get('gemini_thinking_level') or '').strip()
    if _tl:
        try:
            gen_kwargs['thinking_config'] = types.ThinkingConfig(thinking_level=_tl)
        except Exception:
            try: gen_kwargs['thinking_config'] = types.ThinkingConfig(thinking_budget=int(_tl))
            except Exception: pass
    journal(role, 'work_cfg', f"gemini cfg: think={_tl or 'default'} mode={cfg.get('gemini_tool_mode') or 'AUTO'} temp={_t if _t is not None else 'default'}")
    gcfg = types.GenerateContentConfig(**gen_kwargs)
    contents = [types.Content(role='user', parts=[types.Part.from_text(text=user_text)])]
    turns = 0
    while turns < MAX_TURNS and not DONE['v']:
        # HARD MONTHLY CAP: checked BEFORE every single Vertex request, not just once per item.
        # A 24-turn loop that crosses the cap mid-way stops right here, cleanly.
        _ok, _capmsg = spend_cap_check(role, model)
        if not _ok:
            journal(role, 'work_capped',
                    'stopped before turn %d without calling Vertex: %s' % (turns + 1, _capmsg))
            break
        turns += 1
        resp = client.models.generate_content(model=model, contents=contents, config=gcfg)
        try:
            um = getattr(resp, 'usage_metadata', None)
            if um:
                db.collection('token_usage').add({'agent':role,'model':model,'source':'work-runner',
                    'provider':GEMINI_PROVIDER_TAG,
                    'input_tokens':int(getattr(um,'prompt_token_count',0) or 0),
                    'output_tokens':int(getattr(um,'candidates_token_count',0) or 0),
                    'cache_creation_input_tokens':0,
                    'cache_read_input_tokens':int(getattr(um,'cached_content_token_count',0) or 0),
                    # thinking tokens are billed as OUTPUT and are NOT in candidates_token_count.
                    # Recorded so the cap can charge for them; absent on rows written before
                    # 2026-08-01.
                    'thoughts_tokens':int(getattr(um,'thoughts_token_count',0) or 0),
                    'ts': firestore.SERVER_TIMESTAMP})
        except Exception: pass
        # Keep the 60s cache CHEAP but not stale: instead of invalidating it (which would make us
        # re-scan token_usage on all 24 turns), add THIS call's estimated cost to the cached
        # month-to-date figure. Within a TTL window the running total therefore still climbs, so a
        # single long loop cannot blow past the cap while coasting on a stale sum.
        try:
            um = getattr(resp, 'usage_metadata', None)
            if um is not None and _GEM_SPEND['usd'] is not None:
                _ti = int(getattr(um,'prompt_token_count',0) or 0)
                _to = (int(getattr(um,'candidates_token_count',0) or 0)
                       + int(getattr(um,'thoughts_token_count',0) or 0))
                _GEM_SPEND['usd'] += ((_ti / 1000000.0) * GEMINI_USD_PER_M_INPUT
                                      + (_to / 1000000.0) * GEMINI_USD_PER_M_OUTPUT)
                spend_topup(model, _ti, _to, 0, 0)
        except Exception: pass
        cand = (getattr(resp,'candidates',None) or [None])[0]
        if not cand or not getattr(cand,'content',None):
            break
        contents.append(cand.content)
        parts = cand.content.parts or []
        calls = [getattr(p,'function_call',None) for p in parts if getattr(p,'function_call',None)]
        if not calls:
            break
        journal(role, 'work_turn', f"t{turns}: " + ", ".join(c.name for c in calls))
        fresp = []
        for fc in calls:
            fn = DISPATCH.get(fc.name)
            try:
                args = dict(fc.args) if getattr(fc,'args',None) else {}
            except Exception:
                args = {}
            try: out = fn(role, args) if fn else f"unknown tool {fc.name}"
            except Exception as e: out = f"tool error: {str(e)[:300]}"
            fresp.append(types.Part.from_function_response(name=fc.name, response={"result": str(out)[:TOOL_CAP]}))
        contents.append(types.Content(role='user', parts=fresp))
    return turns

def run_claude(role, client, model, prov, sys_prompt, user_text, cfg):
    # Anthropic Messages loop WITH prompt caching (config claude_cache=on, default on).
    cache_on = str(cfg.get('claude_cache') or 'on').lower() not in ('off','0','false','no')
    if cache_on:
        # 1h CACHE TTL ON THE STABLE PREFIX (operator ruling 2026-07-24, cost).
        # The runner ticks every 5 minutes, so the default 5-minute cache expired between
        # ticks and we paid the full cache-WRITE price on the LAWS+LESSONS system prompt and
        # all 8 tool schemas every single tick. 1h write = 2.0x base, once an hour; every
        # read after that is 0.1x. Ordering law: longer-TTL blocks must appear BEFORE
        # shorter-TTL ones, and the API order is tools -> system -> messages, so 1h here
        # plus the 5m rolling tool_result breakpoint below is legal.
        # Flip config/models.claude_cache_ttl to "5m" in Firestore to revert without a redeploy.
        _ttl = str(cfg.get('claude_cache_ttl') or '1h').strip().lower()
        _cc_long = {"type":"ephemeral"} if _ttl in ('5m','','off','none') else {"type":"ephemeral","ttl":_ttl}
        sys_param = [{"type":"text","text":sys_prompt,"cache_control":dict(_cc_long)}]
        tools_param = [dict(t) for t in TOOLS]
        tools_param[-1] = {**tools_param[-1], "cache_control":dict(_cc_long)}
    else:
        sys_param, tools_param = sys_prompt, TOOLS
        _cc_long = {}
    journal(role, 'work_cfg', f"claude cfg: prov={prov} model={model} cache={'on' if cache_on else 'off'}")
    msgs = [{"role":"user","content":user_text}]
    turns = 0
    while turns < MAX_TURNS and not DONE['v']:
        # [SPEND-CAP-V1] HARD MONTHLY CAP, checked BEFORE every request. Placed before
        # `turns += 1` so the message reads the same way run_gemini's does.
        _ok, _capmsg = spend_cap_check(role, model)
        if not _ok:
            journal(role, 'work_capped',
                    'stopped before turn %d without calling the model: %s' % (turns + 1, _capmsg))
            break
        turns += 1
        try:
            resp = client.messages.create(model=model, max_tokens=MAX_TOKENS, system=sys_param, tools=tools_param, messages=msgs)
        except Exception as _e:
            # Narrow fallback: if this SDK/endpoint rejects the extended TTL, drop to the
            # default 5m cache rather than failing the work item. Never swallow other errors.
            _es = str(_e).lower()
            if cache_on and _cc_long.get('ttl') and ('ttl' in _es or 'cache_control' in _es):
                journal(role,'work_cache', f"1h TTL rejected, falling back to 5m: {str(_e)[:200]}")
                _cc_long.pop('ttl', None)
                sys_param = [{"type":"text","text":sys_prompt,"cache_control":{"type":"ephemeral"}}]
                tools_param = [dict(t) for t in TOOLS]
                tools_param[-1] = {**tools_param[-1], "cache_control":{"type":"ephemeral"}}
                resp = client.messages.create(model=model, max_tokens=MAX_TOKENS, system=sys_param, tools=tools_param, messages=msgs)
            else:
                raise
        _u = getattr(resp,'usage',None)
        log_usage(role, _u, model)
        # [SPEND-CAP-V1] Top up the cached month-to-date exactly as run_gemini does. Without it
        # a 24-turn loop coasts past the ceiling on a stale sum -- the precise thing the Gemini
        # top-up was written to prevent.
        if _u is not None:
            spend_topup(model,
                        int(getattr(_u,'input_tokens',0) or 0),
                        int(getattr(_u,'output_tokens',0) or 0),
                        int(getattr(_u,'cache_creation_input_tokens',0) or 0),
                        int(getattr(_u,'cache_read_input_tokens',0) or 0))
        if _u:
            _cc = getattr(_u,'cache_creation',None)
            _w1h = getattr(_cc,'ephemeral_1h_input_tokens',0) if _cc else 0
            _w5m = getattr(_cc,'ephemeral_5m_input_tokens',0) if _cc else 0
            journal(role,'work_cache', f"t{turns}: in={getattr(_u,'input_tokens',0)} cache_write={getattr(_u,'cache_creation_input_tokens',0)} (1h={_w1h} 5m={_w5m}) cache_read={getattr(_u,'cache_read_input_tokens',0)} out={getattr(_u,'output_tokens',0)}")
        msgs.append({"role":"assistant","content":resp.content})
        tool_results = []; names = []
        for b in resp.content:
            if getattr(b,'type','')=='tool_use':
                names.append(b.name)
                fn = DISPATCH.get(b.name)
                try: out = fn(role, b.input) if fn else f"unknown tool {b.name}"
                except Exception as e: out = f"tool error: {str(e)[:300]}"
                tool_results.append({"type":"tool_result","tool_use_id":b.id,"content":str(out)[:TOOL_CAP]})
        if names: journal(role, 'work_turn', f"t{turns}: " + ", ".join(names))
        if not tool_results:
            break
        if cache_on:
            # move the rolling cache breakpoint to this turn's last tool_result (caches big file reads)
            for m in msgs:
                if m.get('role')=='user' and isinstance(m.get('content'), list):
                    for blk in m['content']:
                        if isinstance(blk, dict): blk.pop('cache_control', None)
            tool_results[-1]['cache_control'] = {"type":"ephemeral"}
        msgs.append({"role":"user","content":tool_results})
    return turns

def do_item(doc):
    it = doc.to_dict()
    role = it.get('assigned_role') or 'fleet-infra'
    title = it.get('title','(untitled)')
    payload = it.get('payload', {})
    doc.reference.update({'status':'in_progress','started_at':firestore.SERVER_TIMESTAMP,'runner':'work-runner'})
    journal(role, 'work_start', f"work-runner started '{title[:120]}' (item {doc.id}) as {role}.")
    def _rd(pp):
        try: return t_read_file(role, {'path':pp})
        except Exception: return ""
    rules   = _rd('shared/fleet/LAWS.md')  # the LAWS (operator-decreed)
    lshared = _rd('shared/fleet/LESSONS.md')
    lstrain = _rd('agents/' + role + '/LESSONS.md')
    inv     = _rd('shared/fleet/INVENTORY.md')  # [INV-V1] what already exists
    # [LAW-INJECT-V1] A cap that silently halves a document is how one law existed for a
    # full day for humans only. If anything is being cut, SAY SO, with the numbers.
    for _dn, _dv, _dc in (('shared/fleet/LAWS.md', rules, LAW_INJECT_MAX),
                          ('shared/fleet/LESSONS.md', lshared, LESSON_INJECT_MAX),
                          ('shared/fleet/INVENTORY.md', inv, INV_INJECT_MAX),
                          ('agents/' + role + '/LESSONS.md', lstrain, LESSON_INJECT_MAX)):
        if _dv and len(_dv) > _dc:
            journal(role, 'law_truncated',
                    'INJECTION TRUNCATED: %s is %d chars but only %d reach this strain. '
                    'Everything past that point was NOT delivered. Raise LAW_INJECT_MAX / '
                    'LESSON_INJECT_MAX on fleet-work-runner.' % (_dn, len(_dv), _dc))
    DONE['v']=False; DONE['note']=''
    CAPPED['v']=False; CAPPED['msg']=''
    STAGED['ids'] = []
    # [HIST-V1] Durable history, read half -- mechanical, not discipline.
    _hist, _hist_n = recent_history(role)
    sys_prompt = (f"You are {role}, an autonomous agent in this Paracoding fleet. DO the work item with your "
        f"tools — don't describe it. BE DECISIVE: read a file ONCE, locate your target, and immediately make "
        f"the change with edit_file — do NOT repeatedly list_files or re-read; redundant exploration is a "
        f"failure. To change an existing file you MUST call edit_file (old_string copied EXACTLY from what "
        f"read_file returned, new_string = the replacement). Reading without editing is a failure. NEVER claim "
        f"a change you did not make with a tool. FILES: read_file to read; edit_file to change a big existing "
        f"file (don't rewrite it with write_file); write_file only for new/small files. NEVER shell/cat/python "
        f"to read or edit — BLOCKED. stage_privileged_job is ONLY for real execution (deploy, gcloud/firebase/"
        f"npm, ssh) — propose it, it runs only after the operator confirms. You MUST call complete_work_item when the "
        f"deliverable exists (name any staged job id) or it does not count.\n\n"
        f"LAWS (operator-decreed — obey):\n{rules[:LAW_INJECT_MAX]}\n\n"
        f"FLEET LESSONS — obey; APPEND new fleet-wide lessons to shared/fleet/LESSONS.md:\n{lshared[:LESSON_INJECT_MAX]}\n\n"
        f"YOUR STRAIN LESSONS ({role}) — obey; these OVERRIDE fleet lessons for YOUR lane; "
        f"append strain-specific learnings to agents/{role}/LESSONS.md:\n"
        + (lstrain[:LESSON_INJECT_MAX] if (lstrain and not lstrain.startswith('(no file')) else '(none yet — create agents/' + role + '/LESSONS.md as you learn)')
        + "\n\nWHAT THIS FLEET ALREADY HAS — generated from source, so it is what EXISTS, "
          "not what someone remembers. READ IT BEFORE YOU BUILD ANYTHING. If a tool below "
          "already does the job, USE IT — do not write a second implementation, and do not "
          "invent a file to hold state that one of these collections already holds. If this "
          "disagrees with the source, the SOURCE wins and this index is stale; say so:\n"
        + (inv[:INV_INJECT_MAX] if (inv and not inv.startswith('(no file'))
           else '(no INVENTORY.md yet — regenerate it with '
                'the fleet inventory generator. Until then you do NOT '
                'know what tools exist; check before claiming anything is missing.)')
        + "\n\nYOUR OWN RECENT HISTORY (" + role + ") — what THIS strain has already done, "
          "oldest first, newest last. It is written automatically when an item finishes and it "
          "is the same history a human sees when they say 'refresh'. DO NOT REDO WORK THAT IS "
          "ALREADY HERE. If something below is wrong, say so plainly in your completion note — "
          "a correction in the history is worth more than the original entry:\n"
        + (_hist if _hist else '(nothing yet for this strain — yours will be written when this '
                              'item finishes. An empty history means UNKNOWN, not "quiet": do '
                              'not report it as though nothing has happened.)'))
    user = f"WORK ITEM: {title}\n\nDetails/payload:\n{json.dumps(payload)[:3000]}\n\nDo it now, decisively."

    cfg = model_cfg()
    # substrate: per-item document field OR payload.substrate OR global work_provider
    wprov = str(it.get('substrate') or payload.get('substrate') or cfg.get('work_provider') or 'gemini').lower()
    # FLEET MODE GATE. After the substrate override so the per-item bus choice is still
    # visible in the journal; before any client is constructed so no call can escape.
    _mode = fleet_mode(cfg)
    # The TRANSPORT is resolved before the gate, because which bus may run depends on how the
    # call would be PAID FOR and not only on which vendor it goes to. Gemini is Vertex-only.
    _transport = 'vertex' if wprov == 'gemini' else claude_transport(
        cfg, _mode, os.environ.get('CLAUDE_PROVIDER', ''))
    if not bus_allowed(_mode, wprov, _transport):
        _msg = (refusal_text(_mode, wprov, _transport) +
                " The item is back on the queue untouched and runs as soon as the mode changes.")
        # [RUNNER-CANCEL-STICKS-V81] DO NOT RESURRECT A CANCELLED ITEM. This wrote
        # status='pending' UNCONDITIONALLY, so a cancel landing any time before the write was
        # silently overwritten and the item went straight back on the queue -- which is why
        # cancel_work_item, whose own description says "bookkeeping", could not stop a
        # bus-off retry loop. MEASURED 2026-08-16 on item 1gwGSzAX6xUEdUJXxn1u: cancelled_at
        # set and cancelled_by recorded, and the item still had status 'pending' with a
        # started_at LATER than its cancelled_at. With the buses off that costs no model
        # spend, but it emits three journal rows every tick forever and buries the audit
        # trail the journal exists to be.
        # RE-READ RATHER THAN TRUST THE SNAPSHOT: `it`/`doc` were read before the model gate,
        # and the whole point is that the operator may have cancelled DURING that window.
        _fresh = {}
        try:
            _snap = doc.reference.get()
            _fresh = (_snap.to_dict() or {}) if _snap.exists else {}
        except Exception:
            _fresh = {}
        _upd = {'runner': 'work-runner', 'bus_off_at': firestore.SERVER_TIMESTAMP,
                'result_note': _msg[:500]}
        if _fresh.get('cancelled_at') or _fresh.get('status') == 'cancelled':
            # Restore the CANCELLED state the operator asked for, not the queue state.
            _upd['status'] = 'cancelled'
            journal(role, 'bus_off_cancelled',
                    'item %s was cancelled while claimed; left cancelled rather than '
                    'returned to the queue' % doc.id)
        else:
            _upd['status'] = 'pending'
        doc.reference.update(_upd)
        journal(role, 'bus_off', "work-runner did NOT start '%s' (item %s). %s"
                % (title[:100], doc.id, _msg))
        print('[fleet-mode] %s -> refused %s/%s for item %s'
              % (_mode, wprov, _transport, doc.id), flush=True)
        return 'bus_off'
    turns = 0
    if wprov == 'gemini':
        gmodel = cfg.get('work_gemini_model') or 'gemini-3.1-pro-preview'
        # HARD MONTHLY CAP pre-flight. Do not even open the agent loop if the month is spent.
        # The item is put BACK to pending (nothing was done to it), so it resumes by itself when
        # the calendar month rolls over or when the operator raises the cap at the gate. It is NOT
        # errored, so the sweeper will not re-route it and there is no retry loop: run() breaks
        # the batch as soon as it sees this, so we do at most one of these per 5-minute tick.
        _ok, _capmsg = spend_cap_check(role, gmodel)
        if not _ok:
            doc.reference.update({'status':'pending','runner':'work-runner',
                'gemini_capped_at':firestore.SERVER_TIMESTAMP,'result_note':_capmsg[:500]})
            journal(role, 'work_gemini_capped',
                    f"work-runner did NOT start '{title[:100]}' (item {doc.id}); re-queued as pending. {_capmsg}")
            return 'gemini_capped'
        journal(role, 'work_model', f"work-runner using vertex-gemini model={gmodel}")
        try: turns = run_gemini(role, gmodel, sys_prompt, user)
        except Exception as e:
            journal(role, 'work_error', f"gemini path failed: {str(e)[:400]}"); raise
    else:
        client, model, prov = make_client(_mode)
        # [SPEND-CAP-V1] Pre-flight, mirroring the Gemini arm. The item goes BACK to pending
        # untouched, so it resumes when the month rolls over or the cap is raised.
        _ok, _capmsg = spend_cap_check(role, model)
        if not _ok:
            doc.reference.update({'status':'pending','runner':'work-runner',
                'gemini_capped_at':firestore.SERVER_TIMESTAMP,'result_note':_capmsg[:500]})
            journal(role, 'work_gemini_capped',
                    f"work-runner did NOT start '{title[:100]}' (item {doc.id}); re-queued as pending. {_capmsg}")
            return 'gemini_capped'
        journal(role, 'work_model', f"work-runner using {prov} model={model}")
        try: turns = run_claude(role, client, model, prov, sys_prompt, user, cfg)
        except Exception as e:
            journal(role, 'work_error', f"claude path failed: {str(e)[:400]}"); raise

    if DONE['v']:
        status = 'done'
    elif CAPPED['v']:
        # The loop stopped part-way because the Gemini cap was reached. Partial work may already
        # have been written, so this is TERMINAL rather than re-queued: a human looks at it.
        # 'gemini_capped' is deliberately not a status the sweeper scans (in_progress/blocked/
        # error), so it can never become a retry loop.
        status = 'gemini_capped'
    else:
        status = 'blocked'
    _note = DONE['note'] or (CAPPED['msg'] if CAPPED['v'] else f"stopped after {turns} turns without complete_work_item")
    doc.reference.update({'status':status,'finished_at':firestore.SERVER_TIMESTAMP,
        'result_note':_note[:500],'turns':turns})
    # [HIST-V1] Durable history, write half. Only reached for done/blocked/mid-loop-capped -- the two
    # EARLY returns above (fleet mode off, Gemini pre-flight cap) put the item back on the
    # queue untouched, and an entry saying nothing happened is noise in the one place that
    # has to stay signal.
    _hid = hist_write(role,
        "work-runner %s '%s' (item %s) in %d turns. %s%s"
        % (status, title[:140], doc.id, turns, _note[:1500],
           (' STAGED AT THE GATE: ' + ', '.join(STAGED['ids'])) if STAGED['ids'] else ''),
        [role, 'work-runner', status, doc.id] + list(STAGED['ids']))
    journal(role,'work_'+status, f"work-runner {status} '{title[:100]}' (item {doc.id}) in {turns} turns: {_note[:200]}"
        + (" [history %s, %d prior turn(s) injected]" % (_hid or 'NOT WRITTEN', _hist_n)))
    return status

# [LAW-INJECT-V1] How much of each injected document reaches a strain. Environment
# variables so these can be retuned from a Cloud Run config update with no rebuild; the code
# defaults below are the fallback so a missing variable cannot silently restore the old 1500.
# Measured 2026-08-03: the laws doc 29,207 bytes (32,474 with the newest law), LESSONS.md 19,195. 1500 is
# why Laws 1-15 never reached a bus agent. These leave ~50% headroom over today's real sizes.
LAW_INJECT_MAX    = int(os.environ.get("LAW_INJECT_MAX", "48000"))
LESSON_INJECT_MAX = int(os.environ.get("LESSON_INJECT_MAX", "32000"))

# [HIST-V1] The strain's OWN durable history, injected the same way. Same chat_history
# collection the MCP log_history / read_history / refresh tools use -- one store, not two.
# Entries are capped individually so ten short ones beat three long ones for orientation.
HIST_TURNS      = int(os.environ.get("HIST_TURNS", "10"))
HIST_ENTRY_MAX  = int(os.environ.get("HIST_ENTRY_MAX", "900"))
HIST_INJECT_MAX = int(os.environ.get("HIST_INJECT_MAX", "8000"))

# [INV-V1] The generated index of what this fleet ALREADY HAS -- every MCP tool, every
# Firestore collection and which of them carry real open/closed state, the lake write
# boundary, the runner knobs, and the environment facts that each cost a failure to learn.
# ~7,000 chars today. Generated from source, never hand-written.
INV_INJECT_MAX  = int(os.environ.get("INV_INJECT_MAX", "24000"))

WORK_BATCH  = int(os.environ.get("WORK_BATCH", "4"))
WORK_BUDGET = int(os.environ.get("WORK_BUDGET_SEC", "240"))

# NOTE ON 'held_for_operator' AND gate=='operator' BELOW. These are FIRESTORE FIELD NAMES and a field
# VALUE, not prose: they are one half of a data contract whose other half is the control plane,
# and every hard-gated document already in a deployment carries them. They read like an operator's
# name and they are a schema key, so they are deliberately NOT renamed here. Renaming one side
# silently disables the hard gate on every existing document -- the rename is a coordinated
# migration of both sides plus the stored data, not a string substitution in this file.
@firestore.transactional
def _claim(tx, ref):
    snap = ref.get(transaction=tx)
    c = snap.to_dict() or {}
    if c.get('status') != 'pending':
        return False
    # [RUNNER-CANCEL-STICKS-V81] Belt and braces beside the bus_off fix: a cancelled item must
    # never be claimed even if some other path has left its status reading 'pending'. cancelled_at
    # is set once and never cleared, so this is the durable signal and status is not.
    if c.get('cancelled_at'):
        return False
    if c.get('hold') or c.get('held_for_operator') or (c.get('gate') == 'operator'):
        return False
    tx.update(ref, {'status':'in_progress','started_at':firestore.SERVER_TIMESTAMP,'runner':'work-runner'})
    return True

def _next_claimed(skip):
    for cand in db.collection('work_items').where('status','==','pending').limit(25).stream():
        if cand.id in skip:
            continue
        c = cand.to_dict() or {}
        if c.get('hold') or c.get('held_for_operator') or (c.get('gate') == 'operator'):
            skip.add(cand.id)
            continue
        try:
            if _claim(db.transaction(), cand.reference):
                return cand
        except Exception:
            pass
        skip.add(cand.id)
    return None

@app.route('/', methods=['GET','POST'])
def run():
    t0 = time.time(); out = []; skip = set()
    while len(out) < WORK_BATCH and (time.time() - t0) < WORK_BUDGET:
        d = _next_claimed(skip)
        if not d:
            break
        skip.add(d.id)
        try:
            _st = do_item(d)
            out.append({'item': d.id, 'status': _st})
            if _st in ('gemini_capped', 'bus_off'):
                # Month is spent. Stop the batch instead of burning the other three items on a
                # check we already know the answer to.
                break
        except Exception as e:
            d.reference.update({'status':'error','error':str(e)[:500]})
            journal('work-runner','work_error', 'item %s error: %s' % (d.id, str(e)[:300]))
            out.append({'item': d.id, 'status': 'error'})
    if not out:
        return ('idle: no runnable pending work items (no LLM call)', 200)
    journal('work-runner','work_batch', 'tick processed %d item(s) in %ds (batch=%d budget=%ds)' % (len(out), int(time.time()-t0), WORK_BATCH, WORK_BUDGET))
    return (json.dumps({'batch': out, 'secs': int(time.time()-t0)}), 200)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT','8080')))
