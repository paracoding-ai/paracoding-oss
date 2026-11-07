// SPDX-License-Identifier: Apache-2.0
// Unit tests for mods/status-metrics.ts. No cloud, no network, no emulator.
//
// shared.ts captures `waFetch = globalThis.fetch` at MODULE LOAD, so the fetch stub MUST be
// installed BEFORE the module (and shared.ts) is imported -- hence the dynamic import() below,
// after the stub is in place. PURE fns (smReadProcStat, smCpuBuckets) are driven directly; the
// Cloud Monitoring / BigQuery fns (smMon/smEdge/smNet/pcBq/pcBillTable) are driven through the
// stubbed fetch returning canned JSON, and we assert the PARSING.
process.env.PC_NO_LISTEN = '1';
process.env.GCP_PROJECT = process.env.GCP_PROJECT || 'test-proj';
process.env.GCP_BILLING_DATASET = process.env.GCP_BILLING_DATASET || 'billing_export';

// --- canned response bodies the stub serves (tests mutate these before each call) ---
let monBody: any = { timeSeries: [] };
let bqBody: any = null;
let tablesBody: any = { tables: [] };
let billingBody: any = { billingAccountName: '' };

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
  if (url.indexOf('monitoring.googleapis.com') >= 0) return resp(monBody);
  if (url.indexOf('/bigquery/v2/') >= 0 && url.indexOf('/queries') >= 0) return resp(bqBody);
  if (url.indexOf('/datasets/') >= 0 && url.indexOf('/tables') >= 0) return resp(tablesBody);
  if (url.indexOf('cloudbilling.googleapis.com') >= 0) return resp(billingBody);
  return resp({});
};

(async () => {
  const sm: any = await import('../../src/mods/status-metrics.js');

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.log('  FAIL ' + label + (detail ? '\n        ' + detail : ''));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, got === want, 'got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
  }

  // ---- smReadProcStat (pure; reads /proc/stat on this Linux box) ----
  const st = sm.smReadProcStat();
  ok('smReadProcStat returns an object', !!st && typeof st === 'object');
  ok('smReadProcStat total is a positive number', !!st && typeof st.total === 'number' && st.total > 0);
  eq('smReadProcStat total == sum of parts', !!st && st.total, !!st && (st.user + st.system + st.idle + st.iowait + st.other));
  for (const k of ['user', 'system', 'idle', 'iowait', 'other']) ok('smReadProcStat has numeric ' + k, !!st && typeof st[k] === 'number');

  // ---- smCpuBuckets (pure math over the private ring; exercise via smSample) ----
  sm.smSample(); sm.smSample();
  const cb = sm.smCpuBuckets(3600, 30);
  ok('smCpuBuckets returns {buckets,vcpu}', !!cb && Array.isArray(cb.buckets));
  eq('smCpuBuckets yields exactly n buckets', cb.buckets.length, 30);
  eq('smCpuBuckets honours a different n', sm.smCpuBuckets(1800, 5).buckets.length, 5);
  ok('smCpuBuckets vcpu is a non-negative number', typeof cb.vcpu === 'number' && cb.vcpu >= 0);
  ok('smCpuBuckets entries are null or percentage objects',
    cb.buckets.every((b: any) => b === null || (typeof b.user === 'number' && typeof b.idle === 'number' && typeof b.iowait === 'number')));

  // ---- smMon (parse Cloud Monitoring timeSeries; grouped + reversed) ----
  monBody = { timeSeries: [ { resource: { labels: { service_name: 'svc-a' } }, metric: { labels: {} }, points: [
    { interval: { endTime: '2026-10-20T00:01:00Z' }, value: { doubleValue: 5 } },
    { interval: { endTime: '2026-10-20T00:00:00Z' }, value: { int64Value: 3 } },
  ] } ] };
  const mon = await sm.smMon('metric.type="x"', 3600, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  ok('smMon groups by the resource label', !!mon['svc-a'] && Array.isArray(mon['svc-a']));
  eq('smMon keeps both points', mon['svc-a'] ? mon['svc-a'].length : -1, 2);
  eq('smMon reverses to oldest-first (int64Value parsed)', mon['svc-a'] && mon['svc-a'][0].v, 3);
  eq('smMon parses doubleValue', mon['svc-a'] && mon['svc-a'][1].v, 5);
  eq('smMon parses endTime to epoch ms', mon['svc-a'] && mon['svc-a'][0].t, new Date('2026-10-20T00:00:00Z').getTime());
  // bad JSON -> {} (no throw)
  monBody = 'not json';
  const monErr = await sm.smMon('f', 3600, 'ALIGN_RATE', '', '');
  ok('smMon swallows parse errors to {}', monErr && typeof monErr === 'object' && Object.keys(monErr).length === 0);

  // ---- smEdge (fixed service list, parses per-service in/out) ----
  monBody = { timeSeries: [ { resource: { labels: { service_name: 'paracoding-control-plane' } }, metric: { labels: {} }, points: [
    { interval: { endTime: '2026-10-20T00:00:00Z' }, value: { doubleValue: 11 } },
  ] } ] };
  const edge = await sm.smEdge(3600);
  ok('smEdge returns one row per edge service', Array.isArray(edge) && edge.length === 2);
  eq('smEdge first service name', edge[0] && edge[0].service, 'paracoding-control-plane');
  ok('smEdge populates in[] for the matched service', edge[0] && Array.isArray(edge[0].in) && edge[0].in.length === 1);
  ok('smEdge leaves unmatched service empty', edge[1] && Array.isArray(edge[1].in) && edge[1].in.length === 0);

  // ---- smNet (three LB series grouped by backend_target_name) ----
  monBody = { timeSeries: [ { resource: { labels: { backend_target_name: 'be-1' } }, metric: { labels: {} }, points: [
    { interval: { endTime: '2026-10-20T00:00:00Z' }, value: { doubleValue: 7 } },
  ] } ] };
  const net = await sm.smNet(3600);
  ok('smNet has bytes_in/bytes_out/req', !!net && !!net.bytes_in && !!net.bytes_out && !!net.req);
  ok('smNet groups bytes_in by backend target', !!net.bytes_in['be-1'] && net.bytes_in['be-1'][0].v === 7);
  ok('smNet groups req by backend target', !!net.req['be-1']);

  // ---- pcBq (BigQuery query passthrough) ----
  bqBody = { rows: [ { f: [ { v: '2026-10-20' }, { v: '1.5' } ] } ] };
  const bq = await sm.pcBq('SELECT 1');
  ok('pcBq returns parsed BigQuery JSON', !!bq && Array.isArray(bq.rows) && bq.rows.length === 1);
  eq('pcBq preserves row cell', bq.rows[0].f[1].v, '1.5');
  bqBody = 'xxx not json';
  const bqErr = await sm.pcBq('SELECT bad');
  eq('pcBq returns null on unparseable body', bqErr, null);

  // ---- pcBillTable (pick the table for the linked billing account) ----
  tablesBody = { tables: [
    { tableReference: { tableId: 'gcp_billing_export_v1_AAAAAA_BBBBBB' } },
    { tableReference: { tableId: 'gcp_billing_export_v1_CCCCCC_DDDDDD' } },
    { tableReference: { tableId: 'some_other_table' } },
  ] };
  billingBody = { billingAccountName: 'billingAccounts/AAAAAA-BBBBBB' };
  const t1 = await sm.pcBillTable();
  eq('pcBillTable prefers the linked account table', t1, 'gcp_billing_export_v1_AAAAAA_BBBBBB');
  billingBody = { billingAccountName: '' };
  const t2 = await sm.pcBillTable();
  eq('pcBillTable falls back to lexical-last export table', t2, 'gcp_billing_export_v1_CCCCCC_DDDDDD');
  tablesBody = { tables: [ { tableReference: { tableId: 'unrelated' } } ] };
  const t3 = await sm.pcBillTable();
  eq('pcBillTable returns empty when no export table exists', t3, '');

  console.log((fail === 0 ? 'OK' : fail + ' FAIL') + '  (status-metrics: ' + pass + ' passed, ' + fail + ' failed)');
  process.exit(fail ? 1 : 0);
})();
