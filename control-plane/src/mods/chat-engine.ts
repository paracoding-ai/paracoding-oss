// SPDX-License-Identifier: Apache-2.0
// [CHAT-ENGINE-MOD-V1] Usage-accounting and chat-history helpers of the agentic harness, extracted
// from index.ts by the strangler refactor. These touch Firestore/PG collections (token_usage,
// token_usage_gaps, chat_history, chat_turns) but NOT the chat orchestrator (harChat/harChatExec/
// harRunChat), the provider HTTP calls (which need index-only waFetchLong) or the lake, so they
// carry no index-only or mutable-module state. harUsageOk gates whether a provider usage object is
// real (vs a zero that would lie in the cost rollups); harRecordUsage writes it to token_usage or
// records the gap; harRecentHistory loads a strain's budgeted verbatim history; harTurnCheckpoint
// and harTurnRecoverOnBoot persist and recover in-flight durable turns across a restart.

import { chCol, tuCol, tuGapCol, ctCol } from './collections.js';
import { FieldValue } from './store.js';
import { PC_INSTANCE_KEY, PC_BOOT_AT } from '../shared.js';
export function harUsageOk(u: any): boolean {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  const F = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  let seen = 0;
  for (let i = 0; i < F.length; i++) {
    const v = u[F[i]];
    if (v === undefined || v === null) continue;   // absent field: the provider reported none of this kind
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return false;   // present but unusable: the whole object is
    seen++;
  }
  return seen > 0;
}
export async function harRecordUsage(agentId: string, model: string, source: string, usage: any): Promise<void> {
  try {
    if (harUsageOk(usage)) {
      await tuCol().add({
        agent: agentId, model: model, source: source,
        input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        ts: FieldValue.serverTimestamp(),
      });
      return;
    }
    await tuGapCol().add({
      agent: agentId, model: model, source: source,
      reason: 'UNMEASURED: the provider response carried no usable usage object. This call HAPPENED and its cost is unknown. It is deliberately NOT written to token_usage, because a row of zeros there would be summed as a real zero by /api/dash/usage and /api/usage.',
      saw: (usage === null || usage === undefined) ? 'absent' : (Array.isArray(usage) ? 'array' : typeof usage),
      ts: FieldValue.serverTimestamp(),
    });
  } catch (e) {}
}
export async function harRecentHistory(agentId: string, budgetTok: number): Promise<any[]> {
  if (!agentId) return [];
  try {
    // (1) DETERMINISM: orderBy timestamp desc + limit(600) => always the newest 600 turns. Without the
    // orderBy Firestore returned the first 600 docs by __name__ (auto-id, effectively random), so past
    // 600 docs the SET of turns changed arbitrarily between requests — the strain silently forgot real
    // turns and recalled random old ones, and the prompt prefix was never stable enough to cache.
    const snap = await chCol().where('agent_id', '==', agentId).orderBy('timestamp', 'desc').limit(600).get();
    const r = snap.docs.map((d: any) => d.data()).reverse();   // newest-first -> oldest-first (downstream expects oldest-first)
    // defensive re-sort: tolerant of a missing/undefined timestamp (falls back to 0, never throws)
    r.sort((a: any, b: any) => (((a.timestamp && a.timestamp._seconds) || 0) - ((b.timestamp && b.timestamp._seconds) || 0)));
    const all: any[] = [];
    for (let i = 0; i < r.length; i++) {
      const t = String(r[i].text || ''); if (!t) continue;
      all.push({ role: r[i].role === 'assistant' ? 'ag' : 'me', text: t, tok: Math.max(1, Math.ceil(t.length / 4)) });
    }
    let tok = 0; for (const m of all) tok += m.tok;
    // (2) HYSTERETIC TRIM: trimming to exactly the budget on every call shifted the prefix by a few
    // tokens every single turn, which invalidated the prompt cache every single turn. Instead: only
    // re-trim once we blow 1.25x budget, then cut back to 0.75x, always dropping WHOLE turns (never
    // splitting a message). The prefix therefore stays byte-identical across many consecutive turns
    // and only shifts occasionally.
    const hiWater = budgetTok * 1.25; const loWater = budgetTok * 0.75;
    let start = 0;
    if (tok > hiWater) { while (start < all.length - 1 && tok > loWater) { tok -= all[start].tok; start++; } }
    return all.slice(start).map((m: any) => ({ role: m.role, text: m.text }));
  } catch (e) { return []; }
}
export function harTurnCheckpoint(meta: any, st: any, steps: any[] | null): void {
  try {
    if (!meta || !meta.id) return;
    const row: any = Object.assign({ agent_id: String(meta.agent || ''), instance: PC_INSTANCE_KEY, boot_at: PC_BOOT_AT,
      prompt: String(meta.prompt || '').slice(0, 2000), model: String(meta.model || ''), updated_at: new Date().toISOString() }, st || {});
    if (steps) row.steps = steps.slice(-30).map((x: any) => ({ name: String((x && x.name) || ''), out: String((x && x.out) || '').slice(0, 600) }));
    ctCol().doc(String(meta.id)).set(row, { merge: true }).catch(() => {});
  } catch (e) {}
}
export async function harTurnRecoverOnBoot(): Promise<void> {
  try {
    const q: any = await ctCol().where('instance', '==', PC_INSTANCE_KEY).where('status', '==', 'running').limit(50).get();
    for (const d of q.docs) {
      const x: any = d.data() || {};
      if (String(x.boot_at || '') >= PC_BOOT_AT) continue;
      await d.ref.set({ status: 'interrupted', interrupted_at: new Date().toISOString() }, { merge: true });
      const last = Array.isArray(x.steps) ? x.steps.slice(-5).map((st: any) => st.name + ': ' + String(st.out || '').slice(0, 160)).join(' | ') : '';
      if (x.agent_id) await chCol().add({ agent_id: x.agent_id, role: 'assistant',
        text: '[interrupted] A turn was cut off by a control-plane restart after ' + Number(x.round || 0) + ' round(s) (~$' + Number(x.usd || 0).toFixed(2) + '). Prompt: ' + String(x.prompt || '').slice(0, 300) + (last ? ' -- last steps: ' + last : '') + '. Say "continue" to pick it up.',
        tags: ['harness', 'recovered'], timestamp: FieldValue.serverTimestamp() });
      console.log('[chat/durable] marked interrupted turn ' + d.id + ' agent=' + x.agent_id);
    }
  } catch (e: any) { console.error('[chat/durable] boot sweep failed: ' + String((e && e.message) || e)); }
}
