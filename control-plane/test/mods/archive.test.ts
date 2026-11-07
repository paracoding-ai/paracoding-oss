// SPDX-License-Identifier: Apache-2.0
// Unit tests for mods/archive.ts. No cloud, no network, no emulator.
//
// shared.ts captures `waFetch = globalThis.fetch` at MODULE LOAD, so the fetch stub MUST be
// installed BEFORE mods/archive.ts (and shared.ts) is imported -- hence the dynamic import()
// below, after the stub is in place. The PURE helpers are driven directly; the BigQuery REST
// fns (pcArchQuery / pcArchiveOnWrite / pcArchHistFallback) are driven through the stubbed
// fetch and we assert the PARSING and the outcome sentences.
process.env.PC_NO_LISTEN = '1';
process.env.GCP_PROJECT = process.env.GCP_PROJECT || 'test-proj';

// --- canned fetch state (tests mutate before each async call) ---
let queryBody: any = null;      // body served at /bigquery/v2/.../queries
let queryOk = true;             // http status for the queries endpoint
let insertBody: any = {};       // body served at .../insertAll
let insertOk = true;
let insertCalls = 0;

function resp(body: any, ok = true): any {
  return {
    ok, status: ok ? 200 : 500,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}
(globalThis as any).fetch = async (u: string, _init?: any): Promise<any> => {
  const url = String(u);
  if (url.indexOf('/instance/service-accounts/default/token') >= 0) return resp({ access_token: 'test-token' });
  if (url.indexOf('/bigquery/v2/') >= 0 && url.indexOf('/queries') >= 0) return resp(queryBody, queryOk);
  if (url.indexOf('/insertAll') >= 0) { insertCalls++; return resp(insertBody, insertOk); }
  return resp({});
};

(async () => {
  const A: any = await import('../../src/mods/archive.js');

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.log('  FAIL ' + label + (detail ? '\n        ' + detail : ''));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, got === want, 'got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
  }

  // ---- pcArchWarn (throttled; must never throw) ----
  let threw = false;
  try { A.pcArchWarn('first'); A.pcArchWarn('second-throttled'); } catch (e) { threw = true; }
  ok('pcArchWarn never throws', !threw);

  // ---- pcArchiveRow (pure) ----
  const jr = A.pcArchiveRow('journal', 'doc1', { agent_id: 'a', action: 'x', message: 'm', job_id: 'j' }, '2026-01-01T00:00:00.000Z');
  eq('pcArchiveRow journal doc_id', jr.doc_id, 'doc1');
  eq('pcArchiveRow journal action', jr.action, 'x');
  ok('pcArchiveRow journal has no role/text', !('role' in jr) && !('text' in jr));
  const cr = A.pcArchiveRow('chat_history', 'd2', { agent_id: 'a', role: 'user', text: 't', tags: ['x', 'y'], session: 's' }, '2026-01-01T00:00:00.000Z');
  eq('pcArchiveRow chat text', cr.text, 't');
  eq('pcArchiveRow chat tags JSON', cr.tags, '["x","y"]');
  eq('pcArchiveRow sentinel ts -> nowIso', cr.ts, '2026-01-01T00:00:00.000Z');
  eq('pcArchiveRow non-array tags -> []', A.pcArchiveRow('chat_history', 'd', { tags: 'nope' }, 'N').tags, '[]');

  // ---- pcArchSql (pure) ----
  const sql = A.pcArchSql('proj', 'ds', 30);
  ok('pcArchSql uses STRPOS not LIKE', sql.indexOf('STRPOS') >= 0 && sql.indexOf('LIKE') < 0);
  ok('pcArchSql has partition filter', sql.indexOf('TIMESTAMP_SUB') >= 0 && sql.indexOf('3650 DAY') >= 0);
  ok('pcArchSql references dataset.chat_history', sql.indexOf('ds') >= 0 && sql.indexOf('chat_history') >= 0);
  ok('pcArchSql clamps 0 -> 30', A.pcArchSql('p', 'd', 0).indexOf('LIMIT 30') >= 0);
  ok('pcArchSql clamps 9999 -> 500', A.pcArchSql('p', 'd', 9999).indexOf('LIMIT 500') >= 0);
  ok('pcArchSql clamps -5 -> 1', A.pcArchSql('p', 'd', -5).indexOf('LIMIT 1') >= 0);

  // ---- pcArchParams (pure) ----
  const ps = A.pcArchParams({ agent: 'a', q: 'needle' });
  eq('pcArchParams count', ps.length, 2);
  eq('pcArchParams type', ps[0].parameterType.type, 'STRING');
  eq('pcArchParams value', ps[0].parameterValue.value, 'a');

  // ---- pcArchHistRow (pure) ----
  const hr = A.pcArchHistRow({ doc_id: 'i', agent_id: 'ag', role: 'r', text: 'tx', tags: '["t1"]', session: 'se', ts: '1700000000' });
  eq('pcArchHistRow id', hr.id, 'i');
  eq('pcArchHistRow archived flag', hr.archived, true);
  ok('pcArchHistRow tags parsed to array', Array.isArray(hr.tags) && hr.tags[0] === 't1');
  eq('pcArchHistRow ts seconds -> ISO', hr.timestamp, new Date(1700000000 * 1000).toISOString());
  ok('pcArchHistRow bad tags -> []', Array.isArray(A.pcArchHistRow({ tags: '{bad' }).tags) && A.pcArchHistRow({ tags: '{bad' }).tags.length === 0);

  // ---- pcArchMergeDedup (pure) ----
  const merged = A.pcArchMergeDedup(
    [{ id: 'a' }],
    ['a', 'b'],                             // b was fetched-but-filtered live; must stay out
    [{ id: 'b' }, { id: 'c' }, { id: 'c' }] // dup c collapses
  );
  eq('pcArchMergeDedup length', merged.length, 2);
  ok('pcArchMergeDedup keeps live a', merged[0].id === 'a');
  ok('pcArchMergeDedup adds c only once, drops b', merged[1].id === 'c' && merged.filter((r: any) => r.id === 'c').length === 1);

  // ---- pcArchFallbackDecision (pure) ----
  eq('fallback: scan truncated -> consult', A.pcArchFallbackDecision(30, 30, true).consult, true);
  eq('fallback: under-delivered -> consult', A.pcArchFallbackDecision(5, 30, false).consult, true);
  eq('fallback: full request -> no consult', A.pcArchFallbackDecision(30, 30, false).consult, false);

  // ---- pcArchNotice (pure) ----
  const n1 = A.pcArchNotice('reasonX', 'Outcome: SERVED -- ok', false);
  ok('pcArchNotice includes why + outcome', n1.indexOf('reasonX') >= 0 && n1.indexOf('Outcome: SERVED') >= 0);
  ok('pcArchNotice warns on truncation', A.pcArchNotice('w', 'o', true).indexOf('3000') >= 0);

  // ---- pcArchPlaceNotice (pure) ----
  eq('placeNotice empty notice passthrough', A.pcArchPlaceNotice('body', '', true), 'body');
  ok('placeNotice tail-kept trails', A.pcArchPlaceNotice('B', 'N', true) === 'B\n\nN');
  ok('placeNotice head-kept leads', A.pcArchPlaceNotice('B', 'N', false) === 'N\n\nB');

  // ---- pcArchMonthKey / budget (pure) ----
  eq('pcArchMonthKey YYYY-MM', A.pcArchMonthKey(Date.parse('2026-03-15T00:00:00Z')), '2026-03');
  const now = Date.parse('2026-03-15T00:00:00Z');
  eq('budgetSpent wrong month -> false', A.pcArchBudgetSpent({ month: '2026-02', bytes: 9e18 }, now, 100), false);
  eq('budgetSpent over cap -> true', A.pcArchBudgetSpent({ month: '2026-03', bytes: 200 }, now, 100), true);
  eq('budgetSpent under cap -> false', A.pcArchBudgetSpent({ month: '2026-03', bytes: 50 }, now, 100), false);
  const c1 = A.pcArchBudgetCharge({ month: '2026-03', bytes: 10 }, now, 5);
  eq('budgetCharge same month accumulates', c1.bytes, 15);
  eq('budgetCharge resets on new month', A.pcArchBudgetCharge({ month: '2026-02', bytes: 999 }, now, 7).bytes, 7);

  // ---- pcArchOutcome (pure; all four failure sentences + served) ----
  eq('outcome BUDGET-SPENT', A.pcArchOutcome(true, null, 'ds').notice.indexOf('BUDGET-SPENT') >= 0, true);
  eq('outcome TOO-EXPENSIVE', A.pcArchOutcome(false, { ok: false, err: 'bytes billed', tooExpensive: true }, 'ds').notice.indexOf('TOO-EXPENSIVE') >= 0, true);
  eq('outcome NOT-PROVISIONED (dataset)', A.pcArchOutcome(false, { ok: false, err: 'Not found: Dataset ds' }, 'ds').notice.indexOf('NOT-PROVISIONED') >= 0, true);
  eq('outcome NOT-PROVISIONED (jobs.create)', A.pcArchOutcome(false, { ok: false, err: 'bigquery.jobs.create denied' }, 'ds').notice.indexOf('NOT-PROVISIONED') >= 0, true);
  eq('outcome UNREACHABLE (generic)', A.pcArchOutcome(false, { ok: false, err: 'socket hang up' }, 'ds').notice.indexOf('UNREACHABLE') >= 0, true);
  const served = A.pcArchOutcome(false, { ok: true, rows: [{ doc_id: 'x', ts: '1700000000', tags: '[]' }], bytes: 42 }, 'ds');
  eq('outcome SERVED rows mapped', served.rows.length, 1);
  eq('outcome SERVED row archived', served.rows[0].archived, true);
  eq('outcome SERVED bytes', served.bytes, 42);
  ok('outcome SERVED notice', served.notice.indexOf('SERVED') >= 0);

  // ---- pcArchQuery (stubbed BQ REST) ----
  queryOk = true;
  queryBody = { jobComplete: true, schema: { fields: [{ name: 'doc_id' }, { name: 'text' }] }, rows: [{ f: [{ v: 'd9' }, { v: 'hello' }] }], totalBytesProcessed: '123' };
  const q = await A.pcArchQuery('SELECT 1', { agent: 'a', q: '', role: '' });
  eq('pcArchQuery ok', q.ok, true);
  eq('pcArchQuery parsed row count', q.rows.length, 1);
  eq('pcArchQuery parsed field by name', q.rows[0].doc_id, 'd9');
  eq('pcArchQuery bytes', q.bytes, 123);
  queryBody = { error: { message: 'maximumBytesBilled: query exceeds byte limit' } };
  const qe = await A.pcArchQuery('SELECT 1', {});
  eq('pcArchQuery error -> ok:false', qe.ok, false);
  eq('pcArchQuery tooExpensive flagged', qe.tooExpensive, true);

  // ---- pcArchiveOnWrite (stubbed insertAll) ----
  insertCalls = 0; insertOk = true; insertBody = {};
  await A.pcArchiveOnWrite('journal', 'docZ', { agent_id: 'a', action: 'x' });
  eq('pcArchiveOnWrite streamed one insert', insertCalls, 1);
  insertCalls = 0;
  await A.pcArchiveOnWrite('not_a_coll', 'docZ', {});
  eq('pcArchiveOnWrite unknown coll -> no insert', insertCalls, 0);
  insertCalls = 0;
  await A.pcArchiveOnWrite('journal', '', {});
  eq('pcArchiveOnWrite empty docId -> no insert', insertCalls, 0);

  // ---- pcArchHistFallback (end-to-end through stub) ----
  queryOk = true;
  queryBody = { jobComplete: true, schema: { fields: [{ name: 'doc_id' }, { name: 'ts' }, { name: 'tags' }] }, rows: [{ f: [{ v: 'h1' }, { v: '1700000000' }, { v: '[]' }] }], totalBytesProcessed: '7' };
  const ff = await A.pcArchHistFallback('agent', '', '', 30);
  eq('pcArchHistFallback served rows', ff.rows.length, 1);
  ok('pcArchHistFallback SERVED notice', ff.notice.indexOf('SERVED') >= 0);
  queryBody = { error: { message: 'Not found: Dataset pc_archive' } };
  const ffn = await A.pcArchHistFallback('agent', 'needle', 'user', 10);
  ok('pcArchHistFallback NOT-PROVISIONED notice', ffn.notice.indexOf('NOT-PROVISIONED') >= 0);
  eq('pcArchHistFallback NOT-PROVISIONED no rows', ffn.rows.length, 0);

  console.log(fail === 0 ? ('archive OK (' + pass + ' assertions)') : (fail + ' FAIL / ' + pass + ' pass'));
  process.exit(fail === 0 ? 0 : 1);
})();
