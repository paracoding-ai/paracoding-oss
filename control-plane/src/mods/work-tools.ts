// SPDX-License-Identifier: Apache-2.0
// [WORKTOOLS-MOD-V1] Work-item / status TOOL-HANDLER helpers + ops-session accessors,
// extracted VERBATIM from control-plane/src/index.ts (strangler modularization).
// Imports only from sibling mods ('./collections.js','./store.js','./journal.js');
// NEVER from '../index.js'.
import { db, FieldValue } from './store.js';
import { _JN, _jpg, _kv, _KVSESS, wiCol, pcCol, opsCol } from './collections.js';
import { harJournalAs } from './journal.js';


// [WORKITEM-PARKED] statuses that mean an item is waiting on a human; read by
// harStatusDigest and harCheck below (moved verbatim with them).
const HAR_PARKED = ['needs_claude', 'needs_cowork', 'needs_supervisor'];

export async function opsGet(): Promise<any> { try { const d = await opsCol().doc('current').get(); return d.exists ? d.data() : null; } catch (e) { return null; } }

export async function opsSet(obj: any): Promise<void> { try { await opsCol().doc('current').set(obj, { merge: true }); } catch (e) {} }

export async function opsClear(reason?: string): Promise<void> {
  // F14: TOMBSTONE, not delete. opsSet() writes with merge:true, so a plain delete() races an
  // in-flight /api/ops/token push and the window silently comes back. Zeroing window_expiry
  // inside a transaction survives that merge. Errors PROPAGATE: /api/ops/end must never
  // answer ok when nothing was actually revoked.
  if (_KVSESS) {
    await _kv.replaceTx('ops_session', 'current', (prev: any) => ({
      window_start: 0, window_expiry: 0, token: '', token_expiry: 0,
      revoked_at: FieldValue.serverTimestamp(), revoked_reason: String(reason || 'manual'),
      revoked_seq: Number(prev.revoked_seq || 0) + 1,
    }));
  } else {
    const ref = db.collection('ops_session').doc('current');
    await db.runTransaction(async (tx: any) => {
      const d = await tx.get(ref);
      const prev: any = d.exists ? (d.data() || {}) : {};
      tx.set(ref, {
        window_start: 0, window_expiry: 0, token: '', token_expiry: 0,
        revoked_at: FieldValue.serverTimestamp(), revoked_reason: String(reason || 'manual'),
        revoked_seq: Number(prev.revoked_seq || 0) + 1,
      }, { merge: false });
    });
  }
  // NOTE for whoever ships spec 3c: revoked_at persists after /api/ops/token opens a fresh
  // window (opsSet merges). Any future check that treats a lingering revoked_at as "closed"
  // MUST clear it on the new-window path, or the ops window can never re-open. harOpsToken
  // below deliberately keys off window_expiry alone for exactly that reason.
  try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'ops_window_revoked',
    message: 'ops window revoked (' + String(reason || 'manual') + ')',
    timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
}

export async function harStatusDigest(agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const now = Date.now();
  const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { agent: a, last_ts: 0, last_action: '', backlog: 0, in_progress: 0 }; return agents[a]; };
  const feed: string[] = [];
  const FEED = ['work_start', 'work_done', 'work_blocked', 'work_error', 'stage_job', 'godmode_executed', 'human_confirmed', 'work_cancelled'];
  // [DIGEST-SCANS-WERE-BOUNDED-AND-SILENT-2026-09-14] Found by a fleet sweep after the same
  // shape was fixed in read_journal. BOTH scans below took ONE bounded window and then
  // filtered it IN MEMORY by caller identity, so a strain whose rows sat past the window got
  // '(nothing recent)' and '0 queued' -- answers byte-identical to having no work at all.
  // Neither can become a where() clause: the roster built by ensure() needs EVERY agent's
  // rows, not only the caller's. So page them, and when a ceiling is reached SAY SO rather
  // than reporting a bare zero that reads like a fact.
  const JPAGE = 500, JCEIL = 5000, WPAGE = 500, WCEIL = 5000;
  let jScanned = 0, wScanned = 0;
  let jDone = false, wDone = false;
  try {
    let jcur: any = null;
    while (jScanned < JCEIL) {
      let jq: any = _JN ? _jpg.pager(JPAGE) : db.collection('journal').orderBy('timestamp', 'desc').limit(JPAGE);
      if (jcur) jq = jq.startAfter(jcur);
      const jsnap = await jq.get();
      if (jsnap.empty) { jDone = true; break; }
      jScanned += jsnap.docs.length;
      jcur = jsnap.docs[jsnap.docs.length - 1];
      jsnap.docs.forEach((d: any) => {
        const e = d.data();
        const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds * 1000 : 0;
        const a = ensure(e.agent_id);
        if (a && ts > a.last_ts) { a.last_ts = ts; a.last_action = String(e.message || e.action || '').slice(0, 90); }
        const relevant = boss || e.agent_id === agentId;
        if (relevant && feed.length < 12 && FEED.indexOf(e.action) >= 0) { const age = ts ? Math.round((now - ts) / 60000) : 9999; feed.push('  [' + age + 'm] ' + e.agent_id + ' ' + e.action + ': ' + String(e.message || '').slice(0, 110)); }
      });
      if (jsnap.docs.length < JPAGE) { jDone = true; break; }
      // Stop once the feed is full, but never before the 120-document window this digest
      // always read, so the roster stays at least as complete as it was before paging.
      if (feed.length >= 12 && jScanned >= 120) break;
    }
  } catch (e) {}
  let pend = 0, inprog = 0, parked = 0;
  try {
    let wcur: any = null;
    while (wScanned < WCEIL) {
      let wq: any = wiCol().orderBy('__name__').limit(WPAGE);
      if (wcur) wq = wq.startAfter(wcur);
      const w = await wq.get();
      if (w.empty) { wDone = true; break; }
      wScanned += w.docs.length;
      wcur = w.docs[w.docs.length - 1];
      w.docs.forEach((d: any) => {
        const x = d.data(); const role = String(x.assigned_role || '');
        if (!boss && role !== agentId) return;
        const a = ensure(role);
        if (x.status === 'pending') { pend++; if (a) a.backlog++; }
        else if (x.status === 'in_progress') { inprog++; if (a) a.in_progress++; }
        else if (HAR_PARKED.indexOf(String(x.status)) >= 0) { parked++; }
      });
      if (w.docs.length < WPAGE) { wDone = true; break; }
    }
  } catch (e) {}
  const lines: string[] = [];
  if (boss) {
    const gate: string[] = []; let gateN = 0;
    try { const p = await pcCol().where('status', '==', 'pending').limit(40).get(); gateN = p.size; p.docs.forEach((d: any) => { const x = d.data(); gate.push('  ' + d.id + '  ' + (x.command_type || '') + '  ' + String((x.arguments && x.arguments.command) || '').replace(/\s+/g, ' ').slice(0, 80)); }); } catch (e) {}
    const active = Object.keys(agents).filter((k) => k !== 'human_operator').map((k) => agents[k]).sort((x: any, y: any) => y.last_ts - x.last_ts);
    lines.push('FLEET STATUS  --  ' + pend + ' pending, ' + inprog + ' in progress, ' + parked + ' PARKED for a human, ' + gateN + ' privileged job(s) sitting at pending (nothing comes to approve them)' + (wDone ? '' : '  [COUNTS ARE A FLOOR: the work_items scan stopped at ' + wScanned + ' documents]'));
    lines.push('DISPATCH: gemini-only (Vertex/GCP billing). NOTHING RUNS UNATTENDED -- stalled work parks and waits for a human. There is no sweeper and no escalation.');
    lines.push(''); lines.push('STRAINS:' + (jDone ? '' : '   [STRAINS ARE A FLOOR: the journal scan stopped at ' + jScanned + ' entries, so a strain last active before that point shows stale or missing here -- its absence is NOT evidence that it is idle]'));
    active.slice(0, 12).forEach((a: any) => { const age = a.last_ts ? Math.round((now - a.last_ts) / 60000) : 9999; const st = (a.in_progress > 0 && age < 6) ? 'working' : (a.backlog > 0 ? 'queued' : 'idle'); lines.push('  ' + a.agent + '  [' + st + ']  ' + a.in_progress + ' active / ' + a.backlog + ' queued  -- last ' + age + 'm ago: ' + a.last_action); });
    if (gateN) { lines.push(''); lines.push('SITTING AT PENDING, NOT RUN (no approval console exists; under PC_AUTO_APPROVE=1 a job lands here only if it failed to reach the executor -- re-stage, run by hand, or supersede):'); gate.forEach((g) => lines.push(g)); }
  } else {
    const me = agents[agentId] || { last_ts: 0, last_action: '(nothing yet)' };
    const age = me.last_ts ? Math.round((now - me.last_ts) / 60000) : 9999;
    lines.push('YOUR LANE (' + agentId + ')  --  ' + pend + ' queued, ' + inprog + ' running now, ' + parked + ' parked waiting on a human' + (wDone ? '' : '  [THESE COUNTS ARE A FLOOR, NOT A TOTAL: the work_items scan stopped at ' + wScanned + ' documents, so more of yours may lie past it]'));
    lines.push('DISPATCH: gemini-only (Vertex/GCP billing). Your items run when you or the operator run them, never on their own.');
    lines.push('LAST ACTIVITY: ' + (me.last_ts ? age + 'm ago -- ' + me.last_action : (jDone ? 'none -- the journal was read to the end, so this is a real zero' : 'none in the ' + jScanned + ' journal entries scanned -- the scan hit its ceiling, so this is NOT proof you have none')));
  }
  lines.push(''); lines.push('RECENT:'); feed.slice(0, 10).forEach((f) => lines.push(f));
  if (!feed.length) lines.push(jDone ? '  (nothing recent -- the journal was read to the end, so this is a real zero)' : '  (nothing recent in the ' + jScanned + ' entries scanned -- the scan hit its ceiling, so this is NOT proof there is nothing)');
  return lines.join('\n').slice(0, 6000);
}

export async function harCheck(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const lim = Math.max(1, Math.min(20, Number((input && input.limit)) || 6));
  try {
    let rows: any[] = [];
    if (boss) {
      const snap = await wiCol().where('source', '==', 'ops-chat').limit(150).get();
      rows = snap.docs.map((d: any) => { const o = d.data() || {}; o.id = d.id; return o; });
    } else {
      const snap = await wiCol().where('assigned_role', '==', agentId).limit(150).get();
      rows = snap.docs.map((d: any) => { const o = d.data() || {}; o.id = d.id; return o; });
    }
    rows.sort((a: any, b: any) => (((b.created_at && b.created_at._seconds) || 0) - ((a.created_at && a.created_at._seconds) || 0)));
    rows = rows.slice(0, lim);
    if (!rows.length) return boss ? 'No work items sourced from this console yet.' : 'No work items for ' + agentId + ' yet.';
    return 'LAST ' + rows.length + ':\n' + rows.map((r: any) => { const st = String(r.status || '?').toUpperCase(); const flag = HAR_PARKED.indexOf(String(r.status)) >= 0 ? '  <-- PARKED, needs a human' : ''; return '  [' + st + ']  ' + String(r.title || '').slice(0, 74) + '  (' + r.id + ')' + flag; }).join('\n');
  } catch (e: any) { return 'check failed: ' + String((e && e.message) || e); }
}

export async function harListItemsTool(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const st = String((input && input.status) || 'pending').trim();
  const role = boss ? String((input && input.role) || '').trim() : agentId;
  try {
    let q: any = wiCol();
    if (st && st !== 'all') q = q.where('status', '==', st);
    const snap = await q.limit(300).get();
    let rows = snap.docs.map((d: any) => { const o = d.data() || {}; o._id = d.id; return o; });
    if (role) rows = rows.filter((r: any) => String(r.assigned_role || '') === role);
    rows = rows.slice(0, 60);
    if (!rows.length) return 'no work items (' + st + (role ? ', ' + role : '') + ').';
    return 'WORK ITEMS (' + st + ', ' + rows.length + ' shown, id first):\n' + rows.map((r: any) => '  ' + r._id + '  [' + String(r.status || '?') + ']  ' + String(r.assigned_role || '') + '  ' + String(r.substrate || '-') + '  ' + String(r.title || '').slice(0, 62)).join('\n');
  } catch (e: any) { return 'list_work_items failed: ' + String((e && e.message) || e); }
}

export async function harOwns(id: string, agentId: string): Promise<boolean> {
  if (agentId === 'fleet-advisor') return true;
  try { const d = await wiCol().doc(id).get(); if (!d.exists) return false; return String((d.data() || {}).assigned_role || '') === agentId; } catch (e) { return false; }
}

export async function harCancelItemTool(input: any, agentId: string): Promise<string> {
  const id = String((input && input.id) || '').trim(); if (!id) return 'cancel: id required.';
  if (!(await harOwns(id, agentId))) return 'cancel denied: ' + id + ' is not in your lane.';
  try { await wiCol().doc(id).update({ status: 'cancelled', cancelled_by: agentId, cancelled_at: FieldValue.serverTimestamp(), cancel_note: String((input && input.note) || '') }); harJournalAs(agentId, 'work_cancelled', 'cancelled ' + id + ' ' + String((input && input.note) || '')); return 'cancelled work item ' + id; } catch (e: any) { return 'cancel failed: ' + String((e && e.message) || e); }
}
