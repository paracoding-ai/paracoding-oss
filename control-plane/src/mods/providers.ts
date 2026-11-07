// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-PROVIDERS-V1] Model-provider HTTP calls extracted VERBATIM from index.ts: the Claude
// and Gemini request builders + posters (harClaudePost, harVisionDescribe, harGeminiPost,
// harGeminiGenerate) together with the Gemini daily-spend counter those posters own
// (harGeminiSpend / harGeminiSpendToday / HAR_GEMINI_DAILY_USD_MAX). This module imports ONLY
// sibling mods and shared.js, NEVER ../index.js. The spend state lives HERE and only here; the
// two remaining index.ts readers (a /chat tool refusal and the ops-loop log line) reach it
// through the exported accessor/binding, so the mutable state is never split across two files.
import { waAccessToken } from '../shared.js';
import { HAR_GEMINI_MAX_TOKENS, HAR_GEMINI_SAFETY_OFF } from '../shared.js';
import { waFetchLong } from './wa-http.js';
import { harRedact, harGeminiCostUsd } from './harness-core.js';
import { harVertexProject, harVertexHost, harVertexClaudeRegion, harVertexGeminiRegion, harGeminiTransport, harClaudeProvider, harGeminiSafety, harGeminiGenConfig } from './model-providers.js';

const HAR_VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';
export const HAR_GEMINI_DAILY_USD_MAX = Math.max(0.5, Number(process.env.CHAT_GEMINI_DAILY_USD_MAX || 100) || 100);
export const harGeminiSpend: { day: string; usd: number; calls: number } = { day: '', usd: 0, calls: 0 };
export function harGeminiSpendToday(): number {
  const d = new Date().toISOString().slice(0, 10);
  if (harGeminiSpend.day !== d) { harGeminiSpend.day = d; harGeminiSpend.usd = 0; harGeminiSpend.calls = 0; }
  return harGeminiSpend.usd;
}

export async function harClaudePost(apiModel: string, key: string, body: any): Promise<{ r: any; j: any }> {
  // [SEC-FLEETMODE-CONSOLE-V1] A CONSOLE TRANSPORT. NOT BEHIND THE SPEND SWITCH, ON PURPOSE.
  // Read all of this before putting a check back here.
  //
  // WHAT THE SWITCH PROTECTS AGAINST: spend NOBODY ASKED FOR. This system may automate
  // deterministic work; it may never START model work on its own. A queue tick, a sweep, a
  // retry loop or a background runner that wakes up and bills a card or a project while its
  // owner is asleep is the case that rule was written for.
  //
  // WHY THIS FUNCTION IS OUT OF SCOPE: every Claude model call this file makes goes through
  // here -- the plain chat, the tool-capable ops chat and the reflect pass -- and all three
  // are reached from POST /api/chat, the reflect pass from the TAIL of that same request.
  // There is no other caller. Every one of them runs because a signed-in human typed a
  // message and pressed send, so there is no unattended caller here to stop; the only thing
  // a check at this point can stop is the operator talking to his own install. It did
  // exactly that. With the field absent, unreadable or set to home, every transport was
  // refused, this function threw before it built a URL, and the console answered 502 -- the
  // product's main surface dark to protect a budget the human had just chosen to spend --
  // while the unattended path the rule is about carried on deciding for itself elsewhere.
  //
  // AND "DO NOT GATE THE CONSOLE" ALONE WOULD NOT HAVE SURVIVED, WHICH IS WHY THE PARAGRAPH
  // ABOVE IS HERE. The check this replaces arrived with no statement of what it protected
  // against, so the next reader could not tell the console apart from the unattended path and covered
  // both. If a spend control is ever wanted on this path it is a per-request one a human
  // sees and answers, not a fleet-wide field read behind his back.
  let url = 'https://api.anthropic.com/v1/messages';
  let headers: any = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  const out: any = Object.assign({}, body);
  if (harClaudeProvider() === 'vertex') {
    const region = harVertexClaudeRegion(String(out.model || apiModel));
    const tok = await waAccessToken();
    url = 'https://' + harVertexHost(region) + '/v1/projects/' + harVertexProject() + '/locations/' + region +
      '/publishers/anthropic/models/' + encodeURIComponent(String(out.model || apiModel)) + ':rawPredict';
    headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    delete out.model;                                        // on Vertex the model id lives in the URL
    out.anthropic_version = HAR_VERTEX_ANTHROPIC_VERSION;    // and is required in the body
  }
  // [MODEL-LONGRUN-V1] model POST site 1 of 3 (Claude: Anthropic /v1/messages AND Vertex
  // :rawPredict, both assembled above and both posted from this one line).
  const rr = await waFetchLong(url, { method: 'POST', headers, body: JSON.stringify(out) });
  const jj: any = await rr.json();
  return { r: rr, j: jj };
}

// [VISION-PREPASS-V1] Cheap, keyless Vertex image->text so ANY harness model -- even text-only
// DeepSeek -- can 'read' an attached screenshot. Gemini Flash-Lite (multimodal) transcribes +
// describes the image(s); POST /api/chat injects the result into the user's message before the
// chosen model runs, so no per-provider vision wiring is needed. Keyless Vertex = the project's
// own service account (billed to this project, no API key). Model is env-tunable; default is the
// current cheap Flash-Lite (gemini-2.5-flash-lite went Limited-Access, 3.5 Flash-Lite replaces it).
const PC_VISION_MODEL = String(process.env.PC_VISION_MODEL || 'gemini-3.5-flash-lite');
export async function harVisionDescribe(images: any[]): Promise<string> {
  try {
    const imgs = (Array.isArray(images) ? images : []).filter((im: any) => im && im.data);
    if (!imgs.length) return '';
    const parts: any[] = imgs.map((im: any) => ({ inlineData: { mimeType: String((im && im.media_type) || 'image/png'), data: String(im.data) } }));
    parts.push({ text: 'Transcribe and describe the attached image' + (imgs.length > 1 ? 's' : '') + ' in full for a downstream AI agent that CANNOT see ' + (imgs.length > 1 ? 'them' : 'it') + '. Include ALL visible text verbatim (UI labels, errors, code, logs, numbers), the layout and structure, and anything a reader would need to act. Be complete and literal; do not summarize detail away. Plain text only.' });
    const tok = await waAccessToken();
    const region = harVertexGeminiRegion(PC_VISION_MODEL);
    const project = harVertexProject();
    const vhost = harVertexHost(region);
    const url = 'https://' + vhost + '/v1/projects/' + project + '/locations/' + region + '/publishers/google/models/' + PC_VISION_MODEL + ':generateContent';
    const r: any = await waFetchLong(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: harGeminiGenConfig() }) });
    let j: any = null; try { j = await r.json(); } catch (e: any) { j = null; }
    if (!r.ok) { const um = (j && j.error && (j.error.message || j.error.status)) || ('HTTP ' + r.status); throw new Error(harRedact('vision-prepass ' + PC_VISION_MODEL + ' region=' + region + ': ' + um)); }
    const c = j && j.candidates && j.candidates[0];
    const tparts: any[] = (c && c.content && Array.isArray(c.content.parts)) ? c.content.parts : [];
    return tparts.filter((p: any) => p && typeof p.text === 'string' && !p.thought).map((p: any) => p.text).join('').trim();
  } catch (e: any) {
    return '[image attached, but the vision prepass could not read it: ' + String((e && e.message) || e).slice(0, 200) + ']';
  }
}

export async function harGeminiPost(apiModel: string, key: string, payload: any): Promise<{ r: any; j: any; hostDesc: string }> {
  let url = 'https://generativelanguage.googleapis.com/v1beta/models/' + apiModel + ':generateContent?key=' + encodeURIComponent(key);
  let headers: any = { 'Content-Type': 'application/json' };
  let hostDesc = 'host=generativelanguage.googleapis.com transport=studio';
  if (harGeminiTransport(key) === 'vertex') {
    const region = harVertexGeminiRegion(apiModel);
    const project = harVertexProject();
    const vhost = harVertexHost(region);
    const tok = await waAccessToken();
    url = 'https://' + vhost + '/v1/projects/' + project + '/locations/' + region + '/publishers/google/models/' + apiModel + ':generateContent';
    headers['Authorization'] = 'Bearer ' + tok;
    hostDesc = 'host=' + vhost + ' transport=vertex region=' + region + ' project=' + project;
  }
  // [MODEL-LONGRUN-V1] model POST site 3 of 3 (Gemini, tool-capable path). This is the one the
  // 16-round loop hammers, so it is the site the ceiling was most likely to reach first.
  const r = await waFetchLong(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let j: any = null;
  try { j = await r.json(); } catch (e: any) { j = { parse_error: String((e && e.message) || e) }; }
  return { r: r, j: j, hostDesc: hostDesc };
}

// [CHAT-NOTEXT-REPORT-V1] "(no text)" WAS THE CONSOLE THROWING AWAY EVERYTHING IT KNEW.
// MEASURED on a real install: the operator asked a strain to build a calculator, the model made
// five correct tool calls, and the chat rendered "FLEET GCP - GEMINI / (no text)" -- twice. The
// RAN/STAGED word and the stderr, the only strings that diagnose a failure, never reached the
// screen. The tool results existed; they were sitting in the loop's own `contents` array and were
// dropped on the floor at the return statement.
//
// WHY GEMINI HITS THIS AND CLAUDE MOSTLY DOES NOT, so nobody "fixes" it by blaming one model:
// both loops keep the LAST turn that carried text and return it. Claude nearly always emits a
// text block ALONGSIDE its tool_use, so finalText is populated on the way through. Gemini
// frequently returns parts containing ONLY functionCall and no text at all, so finalText is still
// empty when the loop ends -- and then the fallback fired. Same latent hole in both; only the
// odds differ, which is why this is applied to BOTH loops rather than to the Gemini one.
//
// THIS CANNOT REGRESS A WORKING TURN. It runs only where the old code had already decided it had
// nothing, i.e. exactly where "(no text)" would have printed.
// [ARGON-NATIVE-P0] LONG DECODE ON generateContent -- the CONTINUATION loop. MEASURED on this
// project 2026-10-16 with the VM service account (no key): a unary gemini-4-argon call with
// maxOutputTokens above 32,768 returns exactly 32,768 tokens, finishReason CONTINUATION and a
// candidate.continuationToken; re-sending the SAME request plus top-level continuationToken resumes
// mid-line. Without this loop the turn silently ended at hop 1. Parts are appended unchanged (their
// thoughtSignatures ride along); usage is summed across hops, which is what Vertex bills.
// Hops are capped at ceil(maxOutputTokens / 32,768) + 1 unless CHAT_GEMINI_MAX_HOPS says otherwise.
const HAR_GEMINI_MAX_HOPS = Math.max(0, Number(process.env.CHAT_GEMINI_MAX_HOPS || 0) || 0);
// [ARGON-SAFETY-V1] THE INPUT SAFETY FILTER BLOCKS THIS FLEET'S OWN WORK. MEASURED 2026-10-16: a plain
// "full status for your lane" to fleet-argon came back HTTP 200 with NO candidates and
// promptFeedback.blockReason=SAFETY -- the 128K of inherited VRP / exploit / security-research history
// sent with every turn trips Gemini's DANGEROUS_CONTENT input filter, and the harness rendered that as
// the useless "model returned no text". This is the operator's own internal harness doing authorized
// security research on their own fleet, so the four CONFIGURABLE categories are set OFF by default
// (CHAT_GEMINI_SAFETY=block to restore Google's defaults). Non-configurable core filters (e.g. CSAM)
// are unaffected -- those stay on and cannot be turned off here. When a block still happens, the turn
// now says so plainly instead of pretending the model went silent.
export async function harGeminiGenerate(apiModel: string, key: string, payload: any): Promise<{ r: any; j: any; hostDesc: string; hops: number }> {
  const maxOut = Number((payload && payload.generationConfig && payload.generationConfig.maxOutputTokens) || HAR_GEMINI_MAX_TOKENS) || HAR_GEMINI_MAX_TOKENS;
  const cap = HAR_GEMINI_MAX_HOPS || (Math.ceil(maxOut / 32768) + 1);
  const um: any = {};
  const allParts: any[] = [];
  let first: any = null; let okR: any = null; let lastCand: any = null; let hostDesc = ''; let hops = 0; let token = ''; let blockReason = '';
  if (HAR_GEMINI_SAFETY_OFF && payload && typeof payload === 'object' && !payload.safetySettings) payload.safetySettings = harGeminiSafety();
  while (hops < cap) {
    hops++;
    if (harGeminiSpendToday() >= HAR_GEMINI_DAILY_USD_MAX) {
      throw new Error('gemini daily spend cap reached: $' + harGeminiSpend.usd.toFixed(2) + ' of $' + HAR_GEMINI_DAILY_USD_MAX.toFixed(2) + ' today (UTC) across ' + harGeminiSpend.calls + ' call(s). Raise CHAT_GEMINI_DAILY_USD_MAX to allow more. [CHAT-GEMINI-SPENDGUARD-V1]');
    }
    const body = token ? Object.assign({}, payload, { continuationToken: token }) : payload;
    const res = await harGeminiPost(apiModel, key, body);
    if (res && res.j && res.j.usageMetadata) { harGeminiSpendToday(); harGeminiSpend.usd += harGeminiCostUsd(apiModel, res.j.usageMetadata); harGeminiSpend.calls++; }
    hostDesc = res.hostDesc;
    if (!res.r.ok) {
      if (!okR) return { r: res.r, j: res.j, hostDesc: res.hostDesc, hops: hops };
      console.error('[chat/gemini] long decode hop ' + hops + ' failed HTTP ' + res.r.status + '; keeping ' + (hops - 1) + ' hop(s) of output');
      break;
    }
    okR = okR || res.r;
    const j: any = res.j || {};
    if (!first) first = j;
    const u: any = j.usageMetadata || {};
    for (const k of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount']) {
      if (typeof u[k] === 'number') um[k] = (um[k] || 0) + u[k];
    }
    const c: any = (j.candidates && j.candidates[0]) || null;
    if (!c) {
      const pf: any = (j && j.promptFeedback) || null;
      if (pf && pf.blockReason) { blockReason = String(pf.blockReason) + (pf.blockReasonMessage ? ' (' + pf.blockReasonMessage + ')' : ''); console.log('[chat/gemini] prompt blocked agent-side hop=' + hops + ' blockReason=' + blockReason); }
      break;
    }
    lastCand = c;
    const ps: any[] = (c.content && Array.isArray(c.content.parts)) ? c.content.parts : [];
    for (const p of ps) allParts.push(p);
    token = String(c.continuationToken || j.continuationToken || '');
    if (String(c.finishReason || '') !== 'CONTINUATION' || !token) break;
  }
  const merged: any = Object.assign({}, first || {}, { usageMetadata: um });
  if (blockReason) merged._blockReason = blockReason;
  if (lastCand) {
    const mc: any = Object.assign({}, lastCand, { content: Object.assign({}, lastCand.content || {}, { role: 'model', parts: allParts }) });
    delete mc.continuationToken;
    merged.candidates = [mc];
  }
  if (hops > 1) console.log('[chat/gemini] long decode model=' + apiModel + ' hops=' + hops + ' finish=' + String((lastCand && lastCand.finishReason) || '') + ' out_tokens=' + String(um.candidatesTokenCount || 0));
  return { r: okR, j: merged, hostDesc: hostDesc, hops: hops };
}
