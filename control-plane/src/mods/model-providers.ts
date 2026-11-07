// SPDX-License-Identifier: Apache-2.0
// [MODEL-PROVIDERS-MOD-V1] Pure model / provider / config helpers of the agentic harness,
// extracted verbatim from index.ts by the strangler refactor. Everything here is PURE: each
// function reads only its own arguments, the module-level pure config consts below, process.env,
// builtins, and pure symbols imported from ../shared.js or ./harness-core.js -- no db, no secrets,
// no lake, no network, no mutable module state, no chat loops. The impure har* helpers (harKeyAge
// and the rest touching db / secrets / the lake / the chat loops) stay in index.ts.
import { harModelLabel } from './harness-core.js';
import { PC_PROJECT, HAR_OPUS5, HAR_GEMINI_THINKING_LEVELS, HAR_GEMINI_MAX_TOKENS, HAR_GEMINI_SAFETY_OFF } from '../shared.js';

// ---- model catalog: harOpus5 / harModelEntry / harModelList / HAR_MODELS_DEFAULT / harModels / harApiFor ----
export function harOpus5(m: string): string {
  const s = String(m || '').trim();
  if (!s) return HAR_OPUS5;
  // the opus-3 family is stale end to end; there is no opus-3-x that postdates opus-5.
  if (s.indexOf('claude-opus-3') === 0) return HAR_OPUS5;
  // opus-4: ONLY bare 4 and 4-1, optionally version-suffixed. NOT 4-5, 4-6, 4-8 or anything later.
  if (/^claude-opus-4(-1)?(@|$)/.test(s)) return HAR_OPUS5;
  return s;
}
export function harModelEntry(api: string): any {
  const a = harOpus5(String(api || ''));
  return { id: a, label: harModelLabel(a), sub: '', api: a };
}
export function harModelList(apis: string[], floor: string): any[] {
  const seen: any = {}; const out: any[] = [];
  for (const a of apis) { const s = String(a || '').trim(); if (!s || seen[s]) continue; seen[s] = 1; out.push(harModelEntry(s)); }
  return out.length ? out : [harModelEntry(floor)];
}
const HAR_MODELS_DEFAULT = {
  claude: harModelList([process.env.CHAT_API_OPUS || HAR_OPUS5, process.env.CHAT_API_SONNET || 'claude-sonnet-5'], HAR_OPUS5),
  // [GCP-FLOWHOOD-DEFAULT-V70] FLASH IS FIRST, AND THE ORDER IS THE DEFAULT -- there is no
  // separate "default model" field anywhere. harness.html seeds MODEL.gemini from MODELS.gemini[0]
  // (loadModels), so whichever entry is listed first is what a fresh Flowhood opens on. The
  // operator asked for the current Flash by default (3.7 in 12.x, 3.8 from 12.7); swapping these two is the whole of that change, and
  // reordering here without also changing setProvider() in harness.html leaves the page on Claude.
  // Pro is NOT removed -- it is one click away in the MODEL block, same as it was.
  gemini: harModelList([process.env.CHAT_API_GFLASH || 'gemini-4-argon', 'gemini-3.8-flash', process.env.CHAT_API_GPRO || 'gemini-3.1-pro-preview', 'gemini-4-argon'], 'gemini-4-argon'),
  // [GE-SEAT-V1] The flat-rate Gemini Enterprise seat, as a third substrate beside the two
  // metered ones. It is ONE entry because the seat has one assistant: the model behind it is
  // the engine's business, not a chip in this picker. Listed here so it reaches the page by
  // the same /api/models path the others use and needs no second mechanism.
  ge: [{ id: 'ge', label: 'Gemini Enterprise', sub: 'flat rate', api: 'gemini-enterprise' }],
  // [DEEPSEEK-V4-V1] DeepSeek V4 Pro -- OpenAI-compatible, metered, zero classifier refusals.
  // 1M context, 262K output, function calling. Best-in-class for VRP/CyberGym work.
  deepseek: harModelList([process.env.CHAT_API_DEEPSEEK || 'deepseek-v4-pro'], 'deepseek-v4-pro'),
};
export function harModels(): any { try { return process.env.CHAT_MODELS ? JSON.parse(process.env.CHAT_MODELS) : HAR_MODELS_DEFAULT; } catch (e) { return HAR_MODELS_DEFAULT; } }
export function harApiFor(provider: string, id: string): string {
  // harOpus5 again here because a CHAT_MODELS JSON override never passes through harModelEntry().
  const m = harModels()[provider] || []; const hit = m.find((x: any) => x.id === id);
  const api = (hit && hit.api) || (m[0] && m[0].api) || '';
  return provider === 'claude' ? harOpus5(api) : api;
}

// ---- Gemini generation config: HAR_GEMINI_THINKING / HAR_GEMINI4_THINKING / HAR_GEMINI_THOUGHTS + helpers ----
const HAR_GEMINI_THINKING = (function () {
  const raw = String(process.env.CHAT_GEMINI_THINKING || '').trim().toLowerCase();
  if (!raw) return '';
  if (HAR_GEMINI_THINKING_LEVELS.indexOf(raw) >= 0) return raw;
  console.error('[chat/gemini] CHAT_GEMINI_THINKING=' + raw + ' is not one of ' + HAR_GEMINI_THINKING_LEVELS.join('|') + '; sending no thinkingConfig (model default)');
  return '';
})();
const HAR_GEMINI4_THINKING = (function () {
  const raw = String(process.env.CHAT_GEMINI4_THINKING || 'high').trim().toLowerCase();
  return HAR_GEMINI_THINKING_LEVELS.indexOf(raw) >= 0 ? raw : 'high';
})();
export function harGeminiThinkingFor(apiModel: string): string {
  if (HAR_GEMINI_THINKING) return HAR_GEMINI_THINKING;
  return /^gemini-4/.test(String(apiModel || '')) ? HAR_GEMINI4_THINKING : '';
}
const HAR_GEMINI_THOUGHTS = String(process.env.CHAT_GEMINI_THOUGHTS || '1').trim() !== '0';
export function harGeminiGenConfig(apiModel?: string, thinking?: string): any {
  const g: any = { maxOutputTokens: HAR_GEMINI_MAX_TOKENS };
  const lvl = (thinking && HAR_GEMINI_THINKING_LEVELS.indexOf(thinking) >= 0 && /^gemini-[34]/.test(String(apiModel || ''))) ? thinking : harGeminiThinkingFor(String(apiModel || ''));
  if (lvl) g.thinkingConfig = HAR_GEMINI_THOUGHTS ? { thinkingLevel: lvl, includeThoughts: true } : { thinkingLevel: lvl };
  return g;
}
// [ARGON-ROUTER-V1] Default is high (the operator's standing choice). A short greeting / ack /
// ping goes low; the client can force any level with body.thinking = low|medium|high.
export function harGeminiRoute(msg: string): string {
  const m = String(msg || '').trim();
  if (m.length <= 80 && /^(hi|hello|hey|yo|ping|thanks|thank you|thx|ok|okay|cool|great|yes|no|status\??|who am i\??|what time is it\??)\b/i.test(m)) return 'low';
  return '';
}

// ---- Vertex / provider host + transport resolution ----
export function harVertexProject(): string { return process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT; }
export function harVertexHost(region: string): string { return region === 'global' ? 'aiplatform.googleapis.com' : region + '-aiplatform.googleapis.com'; }
export function harClaudeGlobalOnly(apiModel: string): boolean {
  const m = String(apiModel || '').toLowerCase();
  return /^claude-opus-5/.test(m) || /^claude-opus-4-8/.test(m);
}
// Same shape as harVertexGeminiRegion, deliberately: when the configured region and the model
// disagree, prefer the one that can actually serve and SAY which was chosen. apiModel is optional
// so an existing caller that has no model in hand still gets the configured region.
export function harVertexClaudeRegion(apiModel?: string): string {
  const raw = String(process.env.CHAT_VERTEX_REGION || process.env.VERTEX_LOCATION || 'us-east5').trim() || 'us-east5';
  if (raw !== 'global' && apiModel && harClaudeGlobalOnly(apiModel)) {
    console.log('[chat/claude] region "' + raw + '" ignored for global-only model ' + apiModel + '; using global');
    return 'global';
  }
  return raw;
}
export function harGeminiGlobalOnly(apiModel: string): boolean {
  const m = String(apiModel || '').toLowerCase();
  return /^gemini-(3|4)/.test(m) || m.indexOf('-preview') >= 0;
}
export function harVertexGeminiRegion(apiModel: string): string {
  const raw = String(process.env.CHAT_VERTEX_GEMINI_REGION || 'global').trim() || 'global';
  // SAFE FALLBACK: when the configured region and the configured model disagree, prefer the one
  // that can actually serve the model rather than 404ing, and say which was chosen.
  if (raw !== 'global' && harGeminiGlobalOnly(apiModel)) {
    console.log('[chat/gemini] region "' + raw + '" ignored for global-only model ' + apiModel + '; using global');
    return 'global';
  }
  return raw;
}
// [CHAT-VERTEX-DEFAULT-V2] Same rule as Claude, for the same reason: a stale chat-key-gemini secret
// or a leftover GEMINI_API_KEY used to divert the chat to generativelanguage.googleapis.com, where
// the configured Vertex publisher model id does not exist -> the error the operator saw. Vertex is
// now the default; the AI-Studio transport requires CHAT_GEMINI_PROVIDER=studio AND a real key.
export function harGeminiTransport(key: string): string {
  const p = String(process.env.CHAT_GEMINI_PROVIDER || '').trim().toLowerCase();
  const real = !!(key && key !== 'vertex' && key !== 'token');
  if ((p === 'studio' || p === 'genai' || p === 'apikey' || p === 'key') && real) return 'studio';
  return 'vertex';
}
// Which transport the Claude chat uses.
// [CHAT-VERTEX-DEFAULT-V2] WAS: key-absence inference -- any ANTHROPIC_API_KEY env value or any
// chat-key-claude Secret Manager version, however stale, silently selected api.anthropic.com. On an
// install that had ever had a key set (the operator's has), the "wired to Vertex" change of
// 2026-08-09 therefore did nothing at all: the chat still went to the direct API and still failed.
// NOW: VERTEX IS THE DEFAULT and the direct API is an EXPLICIT OPT-IN. Only CHAT_CLAUDE_PROVIDER
// set to 'anthropic' (or 'api'/'key'/'direct') leaves Vertex. A key lying around in Secret Manager
// can no longer change the transport -- it is data, not configuration.
export function harClaudeProvider(): string {
  const p = String(process.env.CHAT_CLAUDE_PROVIDER || '').trim().toLowerCase();
  if (p === 'anthropic' || p === 'api' || p === 'key' || p === 'direct') return 'anthropic';
  return 'vertex';
}
export function harClaudeHostDesc(r: any): string {
  return r.transport === 'vertex' ? ('host=' + r.host + ' region=' + r.region) : ('host=' + r.host);
}

// ---- Gemini request schema / safety: HAR_GEM_TYPES / HAR_GEM_KEEP / HAR_GEM_FORMATS + helpers ----
const HAR_GEM_TYPES: { [k: string]: string } = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
const HAR_GEM_KEEP = ['description', 'enum', 'title', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern'];
const HAR_GEM_FORMATS: { [k: string]: string[] } = { STRING: ['date-time', 'enum'], INTEGER: ['int32', 'int64'], NUMBER: ['float', 'double'] };
export function harGeminiSchema(node: any, root: any, depth: number): any {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) return { type: 'STRING' };
  let n: any = node;
  let hops = 0;
  while (n && typeof n.$ref === 'string' && hops++ < 8) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(n.$ref);
    const bag: any = (m && root && root[m[1]]) || null;
    const tgt: any = (bag && m) ? bag[m[2]] : null;
    if (!tgt || typeof tgt !== 'object') return { type: 'STRING' };
    n = tgt;
  }
  const alts: any[] = Array.isArray(n.anyOf) ? n.anyOf : (Array.isArray(n.oneOf) ? n.oneOf : []);
  if (alts.length) {
    const real = alts.filter((a: any) => !(a && a.type === 'null'));
    const nullable = real.length !== alts.length;
    if (!real.length) return { type: 'STRING', nullable: true };
    const first: any = harGeminiSchema(real[0], root, depth + 1);
    if (nullable) first.nullable = true;
    if (typeof n.description === 'string' && !first.description) first.description = n.description;
    return first;
  }
  let ty: any = n.type;
  let nullable = false;
  if (Array.isArray(ty)) { nullable = ty.indexOf('null') >= 0; ty = ty.filter((x: any) => x !== 'null')[0]; }
  let t = HAR_GEM_TYPES[String(ty || '').toLowerCase()] || '';
  if (!t) t = n.properties ? 'OBJECT' : (n.items ? 'ARRAY' : 'STRING');
  const out: any = { type: t };
  if (nullable) out.nullable = true;
  for (let i = 0; i < HAR_GEM_KEEP.length; i++) { const k = HAR_GEM_KEEP[i]; if (typeof n[k] !== 'undefined') out[k] = n[k]; }
  if (typeof n.format === 'string' && (HAR_GEM_FORMATS[t] || []).indexOf(n.format) >= 0) out.format = n.format;
  if (t === 'OBJECT') {
    const props: any = (n.properties && typeof n.properties === 'object') ? n.properties : null;
    if (props) {
      const p: any = {};
      const keys = Object.keys(props);
      for (let i = 0; i < keys.length; i++) p[keys[i]] = harGeminiSchema(props[keys[i]], root, depth + 1);
      if (keys.length) out.properties = p;
    }
    if (Array.isArray(n.required) && out.properties) {
      const req = n.required.filter((x: any) => typeof x === 'string' && typeof out.properties[x] !== 'undefined');
      if (req.length) out.required = req;
    }
  } else if (t === 'ARRAY') {
    out.items = harGeminiSchema(n.items, root, depth + 1);
  }
  return out;
}
export function harGeminiSafety(): any[] {
  const thr = 'OFF';
  return ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY']
    .map((cat) => ({ category: cat, threshold: thr }));
}
export function harGeminiBlockMsg(reason: string): string {
  return 'Vertex refused this turn before the model ran: promptFeedback.blockReason=' + reason + '. '
    + 'That is Gemini\'s INPUT safety filter acting on the whole prompt, which includes the recent history sent with every turn -- not on your message alone. '
    + (HAR_GEMINI_SAFETY_OFF
       ? 'The configurable categories are already set OFF here, so this is a non-configurable core filter; something in this strain\'s history is tripping it. Trim or reset this strain\'s history, or ask in a fresh strain.'
       : 'Set CHAT_GEMINI_SAFETY=off to turn the configurable categories off for this internal harness.');
}
