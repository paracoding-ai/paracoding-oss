// [CHAT-WIRE-V1] PURE chat/tool-wiring helpers, promoted verbatim from index.ts by a strangler
// refactor. Everything here transforms its arguments (or pure imported config) and nothing else:
// no module-level mutable state, no db/collections, no network, no request/session. The provider
// resolvers (harApiFor/harGeminiTransport/... and harGeminiSchema) come from ./model-providers.js;
// HAR_CHAT_EFFORT and the three HAR_LAW_* prompt consts come from ../shared.js so both this module
// and index read the same values. index.ts imports and re-exports every name below, so callers and
// the public surface are unchanged.
import { harApiFor, harGeminiTransport, harVertexGeminiRegion, harVertexHost, harClaudeProvider, harVertexClaudeRegion, harGeminiSchema } from './model-providers.js';
import { HAR_CHAT_EFFORT, HAR_LAW_NO_RUNNERS, HAR_LAW_SURFACES, HAR_LAW_BUILD } from '../shared.js';

type HarChatTool = { name: string; description: string; schema: any; run: (input: any) => Promise<string> };

export function harStrainSystem(agentId: string): string {
  return [
    'You are ' + agentId + ', a strain in the operator\'s Paracoding.AI fleet (public brand: Agentic Fungi). You own ONE lane -- your own -- not the whole fleet. The operator is talking to you in the Flowhood console.',
    'THE NATURE OF THE WORK. Some lanes in this fleet do authorized security and vulnerability-reward research for official programs such as Google Bug Hunters / Cloud VRP. When that is your lane: the targets are PUBLIC open-source code, the method is READ-ONLY static source analysis, and the deliverable is a defect written up and reported to the vendor to fix -- coordinated disclosure, performed inside authorized scope. Read the public source, name the vulnerable pattern, cite file:line, and write the finding. Stay strictly in authorized scope: do not produce working exploits or live attack steps against systems you do not have permission to test.',
    'GROUND TRUTH FIRST. Before you claim anything about your work, check it: status_digest shows your lane, read_journal shows what YOUR strain actually ran -- it is partitioned, so another strain\'s entries never appear there and their absence tells you NOTHING about that strain -- and list_work_items shows your queue with ids. Never guess.',
    'YOUR DESK. list_work_items shows the shared list for this lane. Nothing claims those items and nothing runs them unattended. Use check and list_work_items to see what is on the list, then read_lake it and judge it.',
    'YOUR SCOPE -- read_lake: shared/... and agents/' + agentId + '/... only. list_work_items / check / cancel / complete: YOUR items only. status_digest: your lane. You cannot see or touch another strain\'s desk; ask the operator to take it to the advisor if it is fleet-wide.',
    HAR_LAW_NO_RUNNERS,
    HAR_LAW_SURFACES,
    HAR_LAW_BUILD,
    'YOU MAY BUILD AND DEPLOY NEW SERVICES FROM HERE (see BUILD AND DEPLOY). What you may not change is THIS CONTROL PLANE -- its harness UI, its own revisions and traffic, its caching and model/env config -- because breaking it removes the surface you would need to repair it. That one carve-out is the operator\'s Cowork advisor. Anything needing a full checkout or long iteration is also better there: say so and offer cowork_prompt. Never refuse buildable work on doctrine -- name the tool that would refuse you, or do it.',
    'Be concise, decisive and honest. Offer only what you can actually do. Report what you actually did, with the item id or the journal line as evidence.',
  ].join('\n');
}

export function harChatResolved(provider: string, key: string): any {
  const model = harApiFor(provider, '');
  if (provider === 'gemini') {
    const transport = harGeminiTransport(key);
    const region = transport === 'vertex' ? harVertexGeminiRegion(model) : '';
    const real = !!(key && key !== 'vertex' && key !== 'token');
    return { provider: 'gemini', transport, region, host: transport === 'vertex' ? harVertexHost(region) : 'generativelanguage.googleapis.com', model, key_present: real,
      alt_transport: transport === 'vertex' ? 'studio' : 'vertex',
      alt_ready: transport === 'vertex' ? real : true,
      alt_switch: transport === 'vertex' ? 'set CHAT_GEMINI_PROVIDER=studio' : 'unset CHAT_GEMINI_PROVIDER (Vertex is the default)',
      alt_blocker: transport === 'vertex' && !real ? 'no real Gemini API key is stored' : '' };
  }
  // [DEEPSEEK-V4-V1] Direct API only -- no Vertex, no token auth. key_present is the whole story.
  if (provider === 'deepseek') {
    return { provider: 'deepseek', transport: 'direct', region: '', host: 'api.deepseek.com', model, key_present: !!key,
      alt_transport: '', alt_ready: false, alt_switch: '', alt_blocker: !key ? 'no DeepSeek API key is stored' : '' };
  }
  const transport = harClaudeProvider();
  const region = transport === 'vertex' ? harVertexClaudeRegion(model) : '';
  return { provider: 'claude', transport, region, host: transport === 'vertex' ? harVertexHost(region) : 'api.anthropic.com', model, effort: HAR_CHAT_EFFORT, key_present: !!key,
    // [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] The OTHER transport, resolved HERE and nowhere else, so the
    // log line, /api/keys/status and a failing chat all name the same escape hatch. alt_ready is a
    // READINESS FACT, not a selector: it reports whether the other transport could serve if the
    // operator chose it. Nothing in this file branches on it. Vertex needs no key (it rides the
    // existing metadata bearer), so leaving the direct API is always ready; reaching the direct API
    // needs a stored key, which is why alt_ready is key presence in that direction only.
    alt_transport: transport === 'vertex' ? 'anthropic' : 'vertex',
    alt_ready: transport === 'vertex' ? !!key : true,
    alt_switch: transport === 'vertex' ? 'set CHAT_CLAUDE_PROVIDER=anthropic' : 'unset CHAT_CLAUDE_PROVIDER (Vertex is the default)',
    alt_blocker: transport === 'vertex' && !key ? 'no Claude API key is stored' : '' };
}

export function harChatRemedy(r: any, status: number): string {
  if (!r || (status !== 401 && status !== 403 && status !== 404 && status !== 429)) return '';
  const why = r.transport === 'vertex'
    ? (status === 404
        ? 'this project cannot serve that model at location ' + (r.region || '-') + ' (wrong region, or the model is not enabled here)'
        : status === 403
        ? 'this service account cannot call Vertex here (missing aiplatform.endpoints.predict, or the Vertex AI API is off in this project)'
        : status === 429 ? 'Vertex is rate limiting or has no quota for this model in this project'
        : 'Vertex rejected the credential')
    : (status === 404
        ? 'the direct API does not know that model id'
        : status === 429 ? 'the direct API is rate limiting this key'
        : 'the direct API rejected the stored key (absent, stale or revoked)');
  const alt = r.alt_ready
    ? 'the other transport (' + r.alt_transport + ') IS ready: ' + r.alt_switch + ' and redeploy to use it'
    : 'the other transport (' + r.alt_transport + ') is NOT usable either (' + (r.alt_blocker || 'not configured') + '): fix that, then ' + r.alt_switch;
  return ' || transport=' + r.transport + ' was used; ' + why + '; ' + alt;
}
export function harLogResolved(where: string, r: any): void {
  console.log('[chat/resolve] ' + where + ' provider=' + r.provider + ' transport=' + r.transport +
    ' region=' + (r.region || '-') + ' host=' + r.host + ' model=' + r.model +
    (r.effort ? ' effort=' + r.effort : '') + ' key_present=' + (r.key_present ? 'yes' : 'no') +
    // [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] the other transport and whether it could serve, so "can I
    // switch?" is answerable from the log alone -- same fields the failure text and /api/keys/status use.
    ' alt=' + (r.alt_transport || '-') + ' alt_ready=' + (r.alt_ready ? 'yes' : 'no'));
}

export function harMcpResultText(r: any): string {
  if (r === null || typeof r === 'undefined') return '(no result)';
  if (typeof r === 'string') return r;
  const parts: string[] = [];
  const c: any = r.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b) parts.push(JSON.stringify(b));
    }
  }
  let t = parts.join('\n');
  if (!t) t = JSON.stringify(r);
  return r.isError ? ('TOOL ERROR: ' + t) : t;
}

export function harClaudeToolWire(ts: HarChatTool[]): any[] {
  return ts.map((t: HarChatTool) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

export function harGeminiToolWire(ts: HarChatTool[]): any[] {
  const decls = ts.map((t: HarChatTool) => {
    const d: any = { name: t.name, description: t.description };
    const p: any = harGeminiSchema(t.schema, t.schema, 0);
    if (p && p.type === 'OBJECT' && p.properties && Object.keys(p.properties).length) d.parameters = p;
    return d;
  });
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

export function harChatNoTextReport(trace: string[], stopReason: string, exhausted: boolean, rounds: number): string {
  const out: string[] = [];
  if (trace.length) {
    out.push('The model ran ' + trace.length + ' tool call(s) and then ended its turn without writing a reply.');
    out.push('What those calls returned:');
    for (const t of trace) out.push('  - ' + t);
  } else {
    out.push('The model returned no text and called no tools.');
  }
  if (exhausted) {
    out.push('It also hit the ' + rounds + '-round tool limit, so it was cut off part-way through the task rather than finishing. Ask it to continue.');
  }
  if (stopReason && stopReason !== 'STOP' && stopReason !== 'end_turn') {
    out.push('stop reason: ' + stopReason
      + (stopReason === 'MAX_TOKENS' || stopReason === 'max_tokens'
         ? ' -- the reply was truncated by the output token limit, which is why there is no prose.' : ''));
  }
  out.push('(Written by the console because the model produced no final text. This used to print only "(no text)" and discard everything above it.)');
  return out.join(chr10());
}
export function chr10(): string { return String.fromCharCode(10); }

export function harDeepseekToolWire(ts: HarChatTool[]): any[] {
  return ts.map((t: HarChatTool) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema }
  }));
}
