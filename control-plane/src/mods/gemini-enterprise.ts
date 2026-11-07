// SPDX-License-Identifier: Apache-2.0
// [GEMINI-ENTERPRISE-V1] Gemini Enterprise chat-engine stateful helpers, extracted from index.ts
// (strangler). Moved VERBATIM: geRedirect (OAuth redirect URI), geTurnLogLink (Cloud Logging deep
// link), gePace (per-process RPM bucket) and geOnce (one streamAssist round trip). The pure
// tool-protocol helpers live in ./gemini-protocol; the per-seat session store and query meter in
// ./gemini-session. Module-private config/state is moved in WHOLE because only these functions
// read it: GE_ROOT, GE_DATA_STORES, GE_LOG_PROJECT, GE_RPM, GE_429_MAX and the geCallLog window.
// GE_PN, GE_ENGINE and GE_MODEL_ID were promoted to ../shared (pure env reads) because code that
// stays in index (geMissing, geChat, the chat route) still reads them.
// SKIPPED, left in index: geSeatKey/geSeatFor/geOperatorToken (share the mutable geAccess Map with
// the OAuth route handlers that stay; pcIapEmail is index-only), gePrefilter/gePreread (call the
// index-only harChatGemini/harChatExec/fleetMode/gemCol), and the geChat orchestrator (calls the
// unmovable geOperatorToken plus index-only harChatToolset/harChatExec).
import { waFetch, GE_PN, GE_ENGINE, GE_MODEL_ID } from '../shared.js';
import { geRetryAfterMs, geFrames } from './gemini-protocol.js';

const GE_ROOT   = () => 'projects/' + GE_PN + '/locations/global/collections/default_collection/engines/'
  + GE_ENGINE + '/assistants/default_assistant';
const GE_DATA_STORES = String(process.env.GE_DATA_STORES || '').split(',').map(s => s.trim()).filter(Boolean);
const GE_LOG_PROJECT      = String(process.env.GE_LOG_PROJECT || '').trim();
const GE_RPM     = Math.max(1, Number(process.env.GE_RPM || 8));
const GE_429_MAX = Math.max(0, Number(process.env.GE_429_MAX || 4));
const geCallLog: number[] = [];

export function geRedirect(req: any): string {
  const base = String(process.env.GE_PUBLIC_URL || ('https://' + req.get('host'))).replace(/\/+$/, '');
  return base + '/ge/callback';
}



// [GE-TRACE-LINK-V1] ONE CLICK FROM A REPLY TO THE LOGS THAT EXPLAIN IT.
//
// The seat's own observability logs land in the Gemini Enterprise project, not ours, and finding
// the rows for ONE turn meant hand-building a filter every time. We do not get a trace id back on
// the streamAssist response, so this does not pretend to: it filters to the three Gemini
// Enterprise log streams and seeds the search with the session id, which is the one identifier
// the turn and the logs genuinely share. If the backend does not echo that id, the link still
// opens the right logs at the right moment, which is the whole job.
export function geTurnLogLink(session: string): string {
  if (!GE_LOG_PROJECT) return '';
  const sid = String(session || '').split('/').filter(Boolean).pop() || '';
  if (!sid) return '';
  const q = 'logName=~"discoveryengine.googleapis.com%2F" AND "' + sid + '"';
  return '\nlogs: https://console.cloud.google.com/logs/query;query='
    + encodeURIComponent(q) + '?project=' + encodeURIComponent(GE_LOG_PROJECT);
}

export async function gePace(): Promise<number> {
  const WIN = 60000;
  let waited = 0;
  for (;;) {
    const now = Date.now();
    while (geCallLog.length && (now - geCallLog[0]) >= WIN) geCallLog.shift();
    if (geCallLog.length < GE_RPM) { geCallLog.push(now); return waited; }
    // Sleep only until the OLDEST call falls out of the window, not a flat guess -- that is the
    // soonest a slot can possibly exist, so this neither spins nor overshoots.
    const gap = Math.min((WIN - (now - geCallLog[0])) + 60, 61000);
    await new Promise((res) => setTimeout(res, gap));
    waited += gap;
  }
}

// ONE streamAssist round trip: send text on a session, return the assembled reply and the
// session the seat wants used next.
export async function geOnce(tok: string, session: string, text: string): Promise<any> {
  // A TRANSPORT FAILURE IS AN ANSWER, NOT AN EXCEPTION. Unwrapped, a DNS miss or a refused
  // connection propagates out of the chat route as a bare 500 'internal error' with an err_id --
  // the operator learns nothing and goes looking at the console instead of at the network.
  // Measured while building this: ECONNREFUSED surfaced exactly that way.
  let r: any;
  let raw = '';
  let paced = 0;
  for (let attempt = 0; ; attempt++) {
  paced += await gePace();
  try {
    r = await waFetch('https://discoveryengine.googleapis.com/v1alpha/' + GE_ROOT() + ':streamAssist', {
      method: 'POST',
      // x-goog-user-project NAMES THE PROJECT THAT IS BILLED AND QUOTA-CHECKED, and it has to be
      // the one that OWNS THE ENGINE, not the one this service happens to run in. GCP_PROJECT here
      // is the fleet project; the seat lives in the Gemini Enterprise project, and a quota project
      // the signed-in person holds no serviceusage.use on is refused with a 403 that talks about
      // quota rather than about the seat -- a wrong-looking answer to a right-looking question.
      headers: { Authorization: 'Bearer ' + tok, 'x-goog-user-project': GE_PN, 'Content-Type': 'application/json' },
      // [GE-MODEL-SELECT-V1] PICK THE MODEL. WE HAD NEVER SENT ONE, SO WE HAD ALWAYS TAKEN THE
      // ENGINE DEFAULT, AND THE ENGINE DEFAULT IS WHATEVER THE CONSOLE HAPPENS TO HAVE ENABLED.
      //
      // THE OPERATOR SPOTTED THIS, NOT ME. He asked: if users can select a model in the Gemini
      // Enterprise web app, why can we not select one too? Read out of the live v1alpha discovery
      // document rather than guessed -- StreamAssistRequest carries generationSpec, and
      // StreamAssistRequestGenerationSpec has exactly one field:
      //     modelId  "Optional. The Vertex AI model_id used for the generative model.
      //               If not set, the default Assistant model will be used."
      // and the spec itself is described as overriding "the default generation configuration at
      // the engine level". This request body has only ever carried query and session, so every
      // turn this fleet has ever run has silently taken the engine default -- gemini-3.5-flash on
      // this app today, while 3.8 Flash sat switched off in Feature Management.
      //
      // IT COSTS NOTHING EXTRA. An Assistant query is counted per QUERY, not per model, so the
      // 160-per-licensed-user-per-day pool is unmoved by this. A better model on the same budget
      // is the cheapest lever available to this seat, and Google's own note on 3.8 Flash claims it
      // "significantly improves response quality and agentic workflows" -- which is exactly the
      // axis this harness keeps losing on: inert fixes, rounds spent hunting for a file, patches
      // that will not apply.
      //
      // IT SHIPS EMPTY, so behaviour is unchanged until someone sets it. GE_MODEL_ID='' omits
      // generationSpec entirely and the request is byte-identical to the one this fleet has always
      // sent. TWO THINGS MUST BOTH BE TRUE before setting it: the model has to be enabled in the
      // app's Feature Management > Model availability list, and the id has to be a Vertex AI
      // model_id. If either is wrong the seat answers with an HTTP error naming it, which geOnce
      // already surfaces verbatim -- a loud failure, not a silent downgrade to the default.
      body: JSON.stringify({
        query: { text },
        session: session || '-',
        ...(GE_MODEL_ID ? { generationSpec: { modelId: GE_MODEL_ID } } : {}),
        ...(GE_DATA_STORES.length ? {
          toolsSpec: {
            vertexAiSearchSpec: {
              dataStoreSpecs: GE_DATA_STORES.map(ds => ({ dataStore: ds })),
            },
          },
        } : {}),
      }),
    });
  } catch (e: any) {
    return { error: 'the seat was unreachable', detail: String((e && (e.cause || e).message) || e).slice(0, 300) };
  }
  if (!r) return { error: 'the seat was unreachable' };
  try { raw = await r.text(); }
  catch (e: any) { return { error: 'the seat closed the stream mid-answer', detail: String((e && e.message) || e).slice(0, 300) }; }
  // [GE-PACER-V1] A 429 IS RETRIED HERE RATHER THAN RETURNED, because the caller cannot retry it
  // usefully: the turn's tool loop has already spent its earlier rounds, and handing the operator
  // a quota error means re-running work that already succeeded. The bucket above makes this rare;
  // this catches what the bucket cannot see -- a second instance, or a quota shared with another
  // client of the same engine.
  if (r.status === 429 && attempt < GE_429_MAX) {
    const wait = geRetryAfterMs(r, raw, attempt);
    console.warn('[ge/pace] 429 from streamAssist; waiting ' + wait + 'ms then retrying ('
      + (attempt + 1) + '/' + GE_429_MAX + ')');
    await new Promise((res) => setTimeout(res, wait));
    paced += wait;
    continue;
  }
  break;
  }
  // A QUOTA REFUSAL IS EXPLAINED, NOT DUMPED. This used to fall through to the generic HTTP
  // handler below, which puts raw.slice(0, 400) in front of the operator -- and what he actually
  // saw was a JSON error array in his chat bubble, which says nothing about what to do next. The
  // seat is not broken and nothing was billed; we were too fast.
  // [GE-429-IS-A-DAY-NOT-A-MINUTE-V1] THIS MESSAGE USED TO SAY "per minute" AND "give it a
  // minute", AND IT WAS WRONG IN THE MOST EXPENSIVE WAY A MESSAGE CAN BE WRONG: it named a
  // recoverable cause for an unrecoverable state. MEASURED 2026-09-12. The operator and this
  // strain spent an hour between them hunting a rate limit -- waiting, backing off, retrying,
  // reading quota dashboards -- while the true answer was that the day's allowance was gone and
  // nothing was going to recover until midnight Pacific. The evidence that settled it: the seat
  // had served TEN queries inside one minute earlier the same day without complaint, then refused
  // twenty-five consecutive requests spread over an hour at a far lower rate. That is a spent
  // pool, not a throttle. The underlying refusal names the metric plainly --
  // discoveryengine.googleapis.com/text_answer_gen_tier_enterprise_standard_regional -- and the
  // caller is told the metric here so nobody has to go and find it again.
  if (r.status === 429) {
    return { error: 'the Gemini Enterprise seat is out of Assistant queries', quota: true,
      detail: 'This is the DAILY allowance, not a per-minute throttle, and it resets at midnight '
        + 'Pacific. Every tool round trip inside a turn spends one query, so a turn that runs '
        + 'three tools spends four. The request was retried ' + GE_429_MAX + ' times with backoff '
        + 'and nothing recovered, which is what a spent pool looks like -- a throttle would have '
        + 'let one through. The quota the seat names is '
        + 'discoveryengine.googleapis.com/text_answer_gen_tier_enterprise_standard_regional. '
        + 'Until it resets, switch this strain to Gemini or Claude: same strain, same tools, same '
        + 'journal, only the engine changes.' };
  }
  if (!r.ok) return { error: 'the seat answered HTTP ' + r.status, detail: raw.slice(0, 400) };
  let acc = '', sess = session || '', skipped: string[] | null = null;
  for (const ev of geFrames(raw)) {
    if (ev.sessionInfo && ev.sessionInfo.session) sess = ev.sessionInfo.session;
    const ans = ev.answer || {};
    if (ans.state === 'SKIPPED') skipped = (ans.assistSkippedReasons || []).slice();
    let whole = '';
    for (const rep of (ans.replies || [])) {
      const c = ((rep.groundedContent || {}).content) || {};
      if (c.text) whole += c.text;
    }
    // Replies are DELTAS. A frame that begins with everything already collected is cumulative
    // and replaces; anything else appends. Replacing on every frame makes the answer flicker
    // and then vanish when the last chunk is whitespace, which is measured, not theoretical.
    if (whole) { if (whole.length >= acc.length && whole.indexOf(acc) === 0) acc = whole; else acc += whole; }
  }
  // spent:1 -- this request reached the model and consumed one Assistant query from the
  // daily pool. A 429 above returns before this point and consumes nothing.
  return { text: acc, session: sess, skipped, paced, spent: 1 };
}
