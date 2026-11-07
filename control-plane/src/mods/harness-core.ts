// SPDX-License-Identifier: Apache-2.0
// [HARNESS-CORE-MOD-V1] Dependency-free helpers of the agentic harness, extracted from index.ts by
// the strangler refactor. Everything here is PURE: each function reads only its own arguments
// (harGeminiPrice also reads process.env / Date), builds strings, numbers or plain objects, and
// touches nothing else -- no db, no getStorage, no secrets, no lake, no chat loops, no MCP registry,
// and no symbol from shared.ts. harModelLabel renders a model id into a display label; harGeminiPrice
// / harGeminiCostUsd are the Gemini USD-per-1M table and its cost calculator; harToolDefs is the
// static per-strain tool-definition catalog (prompt shaping); harRedact strips secrets from text.
// The rest of the har* family (harModelEntry/harModelList/harModels and everything touching
// harOpus5/HAR_MODELS_DEFAULT, db, secrets, the lake or the chat loops) stays in index.ts.

export function harModelLabel(api: string): string {
  return String(api || '').replace(/^models\//, '').replace(/^(claude|gemini|anthropic|google)[-.]/i, '')
    .replace(/-\d{6,8}$/, '').replace(/-(preview|latest|exp)$/i, '')
    .split(/[-_]/).filter((w: string) => !!w)
    .map((w: string) => (/^[0-9]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

// USD per 1M tokens: [input, output(+thinking), cached input]. Argon list price is $2/$10 (cached
// $0.10) through 2026-11-30, then $4/$20 ($0.20). CHAT_GEMINI_PRICE="in,out,cached" overrides.
export function harGeminiPrice(apiModel: string): number[] {
  const ov = String(process.env.CHAT_GEMINI_PRICE || '').split(',').map((x: string) => Number(x));
  if (ov.length === 3 && ov.every((x: number) => isFinite(x) && x >= 0)) return ov;
  const m = String(apiModel || '');
  if (/^gemini-4-argon/.test(m)) return (Date.now() < Date.parse('2026-12-01T00:00:00Z')) ? [2, 10, 0.10] : [4, 20, 0.20];
  if (/flash/.test(m)) return [0.5, 3, 0.05];
  return [2, 12, 0.20];
}
export function harGeminiCostUsd(apiModel: string, um: any): number {
  if (!um) return 0;
  const pr = harGeminiPrice(apiModel);
  const inTok = Number(um.promptTokenCount || 0) + Number(um.toolUsePromptTokenCount || 0);
  const cached = Math.min(inTok, Number(um.cachedContentTokenCount || 0));
  const outTok = Number(um.candidatesTokenCount || 0) + Number(um.thoughtsTokenCount || 0);
  return ((inTok - cached) * pr[0] + cached * pr[2] + outTok * pr[1]) / 1e6;
}

export function harToolDefs(agentId: string): any[] {
  const boss = agentId === 'fleet-advisor';
  const mine = boss ? 'any strain' : 'you (' + agentId + ')';
  return [
    { name: 'status_digest', description: boss ? 'Live FLEET overview: every strain, what each is doing, backlog counts, gate jobs, recent events. Use for "where are we / report / refresh".' : 'Your lane: what you are working on, your queue, your recent runs, anything of yours parked for a human.', input_schema: { type: 'object', properties: {} } },
    { name: 'check', description: 'Status of recent work items for ' + mine + ' -- what is pending, finished, blocked or parked.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_journal', description: boss ? 'Recent journal entries across ANY strain -- the fleet-wide console view (work runs, cache numbers, gate events). VERIFY here before claiming anything.' : 'Recent journal entries for ' + mine + ' ONLY. This is partitioned per strain: another strain\'s runs never appear here, so their absence proves nothing about them and must not be reported as evidence they did not run. VERIFY your own claims here before making them.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_lake', description: 'Read a lake file for ground truth. Allowed: shared/... and agents/' + agentId + '/... .', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_work_items', description: 'List work items WITH ids for ' + mine + '. status defaults pending; use "all" for any, or needs_claude / needs_cowork / needs_supervisor to see parked work.', input_schema: { type: 'object', properties: { status: { type: 'string' }, role: { type: 'string' } } } },
    { name: 'cancel_work_item', description: 'Cancel a work item by id (bookkeeping). Junk or obsolete items.', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'complete_work_item', description: 'Mark a work item completed. evidence_oid is REQUIRED and the SERVER resolves it against the repository: give the 40-hex oid of the commit that carries the work, or the literal "none" with a reason that OPENS WITH ONE OF MEASURED: NEGATIVE: DUPLICATE: OBSOLETE: NOT-DOING: followed by at least 20 more characters (DUPLICATE: must also name the other item id). "none" means this work produced NO ARTIFACT and those are the only ways that is true, so a completion has no token it can honestly take. A commit that does not resolve refuses the close and NOTHING changes.', input_schema: { type: 'object', properties: { id: { type: 'string' }, evidence_oid: { type: 'string' }, reason: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'evidence_oid'] } },
    { name: 'read_job_log', description: 'Read the result (status/exit/stdout/stderr) of a gate job by job_id.', input_schema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
    { name: 'cowork_prompt', description: 'Hand the operator a paste-ready bootstrap prompt to continue this work in a fresh Cowork chat (full source + deploy access). Use when a job needs building, deploying, or heavy iteration -- or when they asks how to port it.', input_schema: { type: 'object', properties: { strain: { type: 'string', description: 'strain to bootstrap; defaults to ' + agentId }, task: { type: 'string', description: 'one line: what they should have it do first' } } } },
  ];
}

export function harRedact(s: string): string {
  return String(s == null ? '' : s)
    .replace(/([?&]key=)[^&"\s]+/gi, '$1REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer REDACTED')
    .replace(/\b(sk-[A-Za-z0-9_\-]{6,}|ya29\.[A-Za-z0-9._\-]{6,})/g, 'REDACTED');
}
