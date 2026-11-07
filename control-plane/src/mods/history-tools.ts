// SPDX-License-Identifier: Apache-2.0
// [MOD-HISTORY-TOOLS] Extracted from control-plane/src/index.ts (strangler refactor, 2026-10-21).
// Tool/route BACKENDS that resolve without reaching into index.ts:
//   - chat_history search/read impls with the BQ-archive fallback (pcSearchHistoryImpl/pcReadHistoryImpl)
//   - the human-gate approval drift check (pcApproveDrift)
//   - the status-page billing/usage measurement (pcBillingMeasure)
//   - the post-quantum TLS ingress readers (pqcReadState/pqcPending)
//   - the git-blob upload raw-body guard (pcBlobBody + its express.raw + size const)
// Imports shared primitives ONLY from ../shared.js and sibling mods -- NEVER from ../index.js.
// Functions are byte-identical to their former index.ts definitions.
//
// LEFT IN index.ts (reported): pcCompletionEvidence + harCompleteItemTool (pcCompletionEvidence
// require()s ./gittools.js, which is bundled beside index.ts, not beside mods/ -- a verbatim move
// would break that runtime require; gittools.js is not a sanctioned mod import), and pcArchiveCaller
// (reaches index-only pcSessionLookup/pcToolClasses/pcNarrowClasses).
import express from 'express';
import { tsMillis, pcStableJson, waAccessToken, waFetch, GCP_PROJECT, GCP_BILLING_DATASET, PQC_POLICY_NAME, PQC_POLICY_URL, PQC_PROXIES_URL } from '../shared.js';
import { _CH, chCol, pcCol, tuCol, cfgCol } from './collections.js';
import { pcArchFallbackDecision, pcArchHistFallback, pcArchMergeDedup, pcArchPlaceNotice, pcArchNotice } from './archive.js';
import { pcRowMillis } from './identity.js';
import { pcBq, pcBillTable } from './status-metrics.js';

// ================== [SEC-BQ-ARCHIVE-V1] chat_history search/read backends ==================
export async function pcSearchHistoryImpl(agent: string, a: any): Promise<any> {
  const snap = await chCol().where('agent_id', '==', agent).limit(3000).get();
  let rows = snap.docs.map((d: any) => d.data());
  rows.sort((x: any, y: any) => tsMillis(y.timestamp) - tsMillis(x.timestamp));
  if (a.role) rows = rows.filter((r: any) => r.role === a.role);
  if (a.query) {
    const q = String(a.query).toLowerCase();
    rows = rows.filter((r: any) =>
      (r.text || '').toLowerCase().includes(q) ||
      (Array.isArray(r.tags) ? r.tags.join(' ').toLowerCase().includes(q) : false));
  }
  const requested = a.limit || 20;
  rows = rows.slice(0, requested);
  const fsTrunc = snap.size >= 3000;
  const dec = _CH ? { consult: false, reason: '' } : pcArchFallbackDecision(rows.length, requested, fsTrunc);
  if (!dec.consult) {
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
  const arch = await pcArchHistFallback(agent, String(a.query || ''), String(a.role || ''), requested);
  const fsIds = snap.docs.map((d: any) => String(d.id));
  let merged = pcArchMergeDedup(rows, fsIds, arch.rows);
  merged.sort((x: any, y: any) => pcRowMillis(y) - pcRowMillis(x));
  merged = merged.slice(0, requested);
  // search_history is cut from the BACK by [MCP-RESULT-CAP-V1]: the notice LEADS.
  return { content: [{ type: 'text', text: pcArchPlaceNotice(JSON.stringify(merged, null, 2), pcArchNotice(dec.reason, arch.notice, fsTrunc), false) }] };
}
export async function pcReadHistoryImpl(agent: string, a: any): Promise<any> {
  const snap = await chCol().where('agent_id', '==', agent).limit(3000).get();
  let rows = snap.docs.map((d: any) => d.data());
  rows.sort((x: any, y: any) => tsMillis(x.timestamp) - tsMillis(y.timestamp));
  const requested = a.limit || 30;
  rows = rows.slice(-requested);
  const fsTrunc = snap.size >= 3000;
  const dec = _CH ? { consult: false, reason: '' } : pcArchFallbackDecision(rows.length, requested, fsTrunc);
  if (!dec.consult) {
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
  const arch = await pcArchHistFallback(agent, '', '', requested);
  const fsIds = snap.docs.map((d: any) => String(d.id));
  let merged = pcArchMergeDedup(rows, fsIds, arch.rows);
  merged.sort((x: any, y: any) => pcRowMillis(x) - pcRowMillis(y));
  merged = merged.slice(-requested);
  // read_history is in PC_RESULT_CAP_TAIL (cut from the FRONT): the notice TRAILS.
  return { content: [{ type: 'text', text: pcArchPlaceNotice(JSON.stringify(merged, null, 2), pcArchNotice(dec.reason, arch.notice, fsTrunc), true) }] };
}

// ---- human-gate approval drift check ----
export function pcApproveDrift(job: any, expect: any): string {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
    return 'this gate page sent no record of what it displayed for this job, so the server cannot '
         + 'confirm you are approving the job you were shown. Reload the gate and approve again.';
  }
  const pairs: string[][] = [
    ['status', String((job as any).status || ''), String(expect.status || '')],
    ['command_type', String((job as any).command_type || ''), String(expect.command_type || '')],
    ['staged_by', String((job as any).staged_by || ''), String(expect.staged_by || '')],
  ];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][1] !== pairs[i][2]) {
      return pairs[i][0] + ' has changed since the gate drew this job: the gate showed "'
           + pairs[i][2] + '", the server now holds "' + pairs[i][1] + '".';
    }
  }
  if (pcStableJson((job as any).arguments) !== pcStableJson(expect.arguments)) {
    return 'the arguments have changed since the gate drew this job: the command shown on screen '
         + 'is not the command now stored against this job id.';
  }
  return '';
}

// ---- status-page billing + LLM usage measurement ----
export async function pcBillingMeasure(): Promise<any> {
  const out: any = { gcp: {}, llm: {}, tz: 'UTC' };
  try {
    const table = await pcBillTable();
    if (!table) { out.gcp = { note: 'billing export table not found yet (first data ~a day after enabling)' }; }
    else {
      const T = '`' + GCP_PROJECT + '.' + GCP_BILLING_DATASET + '.' + table + '`';
      const daily = await pcBq('SELECT FORMAT_DATE("%Y-%m-%d", DATE(usage_start_time)) d, ROUND(SUM(cost),4) c FROM ' + T + ' WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 40 DAY) GROUP BY d ORDER BY d');
      const svc = await pcBq('SELECT service.description s, ROUND(SUM(cost),2) c FROM ' + T + ' WHERE usage_start_time >= TIMESTAMP(DATE_TRUNC(CURRENT_DATE(), MONTH)) GROUP BY s ORDER BY c DESC LIMIT 8');
      const rows = (((daily && daily.rows) || []) as any[]).map((r: any) => ({ d: String(r.f[0].v), c: Number(r.f[1].v) || 0 }));
      const svcRows = (((svc && svc.rows) || []) as any[]).map((r: any) => ({ s: String(r.f[0].v || ''), c: Number(r.f[1].v) || 0 }));
      if (!rows.length && daily && (daily.error || daily.errors)) { out.gcp = { note: 'billing query failed (check BigQuery IAM)' }; }
      else {
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = today.slice(0, 7) + '-01';
        const d7 = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
        let day = 0, week = 0, month = 0;
        rows.forEach((r: any) => { if (r.d === today) day += r.c; if (r.d >= d7) week += r.c; if (r.d >= monthStart) month += r.c; });
        const lastDate = rows.length ? rows[rows.length - 1].d : ''; const stale = lastDate ? (((Date.now() - new Date(lastDate + 'T00:00:00Z').getTime()) / 86400000) > 2) : false; out.gcp = { day: Math.round(day * 100) / 100, week: Math.round(week * 100) / 100, month: Math.round(month * 100) / 100, series: rows.slice(-30), services: svcRows, last_date: lastDate, stale: stale, note: rows.length ? '' : 'no billing rows in the last 40 days yet' };
      }
    }
  } catch (e: any) { out.gcp = { note: 'billing unavailable' }; }
  try {
    const nd = new Date();
    const todayStart = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate()));
    const monthStart = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), 1));
    const d7 = new Date(Date.now() - 6 * 86400000);
    const windowStart = (d7.getTime() < monthStart.getTime()) ? d7 : monthStart;
    const snap: any = await tuCol().where('ts', '>=', windowStart).limit(40000).get();
    let prices: any = null;
    try { const pdoc: any = await cfgCol().doc('models').get(); const pd = (pdoc && pdoc.exists && pdoc.data()) || null; if (pd && pd.prices && typeof pd.prices === 'object') prices = pd.prices; } catch (e) {}
    const PAIRS = [['in', 'input_tokens'], ['out', 'output_tokens'], ['cache_write', 'cache_creation_input_tokens'], ['cache_read', 'cache_read_input_tokens']];
    const rateFor = (m: string, k: string): any => { if (!prices) return null; const pp = prices[m]; if (!pp || typeof pp !== 'object') return null; const v = pp[k]; return (typeof v === 'number' && isFinite(v)) ? v : null; };
    const costFor = (m: string, t: any): any => { let c = 0; for (let i = 0; i < PAIRS.length; i++) { const toks = Number(t[PAIRS[i][1]] || 0) || 0; if (!toks) continue; const r = rateFor(m, PAIRS[i][0]); if (r === null) return null; c += (toks / 1000000) * r; } return c; };
    const FLDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    const mkBucket = () => ({} as any);
    const bump = (bk: any, m: string, d: any) => { const t = bk[m] || (bk[m] = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }); for (let i = 0; i < FLDS.length; i++) t[FLDS[i]] += Number(d[FLDS[i]] || 0) || 0; };
    const bDay = mkBucket(), bWeek = mkBucket(), bMonth = mkBucket();
    snap.forEach((doc: any) => {
      const d = doc.data() || {}; const m = String(d.model || 'unknown');
      const ts = (d.ts && d.ts.toMillis) ? d.ts.toMillis() : (d.ts && d.ts._seconds ? d.ts._seconds * 1000 : 0);
      if (ts >= todayStart.getTime()) bump(bDay, m, d);
      if (ts >= d7.getTime()) bump(bWeek, m, d);
      if (ts >= monthStart.getTime()) bump(bMonth, m, d);
    });
    const roll = (bk: any) => {
      const models = Object.keys(bk).map((m) => { const c = costFor(m, bk[m]); const tk = FLDS.reduce((a: number, f: string) => a + (Number(bk[m][f]) || 0), 0); return { model: m, tokens: tk, cost_usd: c }; }).sort((a: any, b: any) => b.tokens - a.tokens);
      let sum = 0; let anyNull = false; models.forEach((x: any) => { if (x.cost_usd === null) anyNull = true; else sum += x.cost_usd; });
      return { models, cost_usd: anyNull ? null : Math.round(sum * 100) / 100 };
    };
    out.llm = { day: roll(bDay), week: roll(bWeek), month: roll(bMonth), prices_configured: prices !== null };
  } catch (e: any) { out.llm = { note: 'usage unavailable' }; }
  return out;
}

// ---- [PQC-TLS-TOGGLE-V1] post-quantum TLS ingress readers ----
export async function pqcReadState(): Promise<any> {
  const tok = await waAccessToken();
  const h = { Authorization: 'Bearer ' + tok };
  let value: string | null = null;
  let exists = false;
  let minTls: string | null = null;
  const rp = await waFetch(PQC_POLICY_URL, { headers: h });
  if (rp && rp.ok) {
    const jp: any = await rp.json();
    exists = true;
    value = String(jp.postQuantumKeyExchange || '');
    minTls = String(jp.minTlsVersion || '');
  }
  // Coverage: which target proxies actually attach this policy. A stored value of
  // ENABLED with zero attached proxies changes nothing on the wire.
  const attached: string[] = [];
  let coverageKnown = false;
  const rx = await waFetch(PQC_PROXIES_URL, { headers: h });
  if (rx && rx.ok) {
    coverageKnown = true;
    const jx: any = await rx.json();
    const items = (jx && jx.items) || {};
    for (const scope of Object.keys(items)) {
      const arr = (items[scope] && items[scope].targetHttpsProxies) || [];
      for (const p of arr) {
        const sp = String((p && p.sslPolicy) || '');
        if (sp && sp.indexOf('/sslPolicies/' + PQC_POLICY_NAME) >= 0) attached.push(String(p.name || ''));
      }
    }
  }
  let effective = 'absent';
  if (exists) effective = (value === 'ENABLED' && attached.length > 0) ? 'on' : 'off';
  let warning: string | null = null;
  if (exists && value === 'ENABLED' && coverageKnown && attached.length === 0) {
    warning = 'the policy says ENABLED but no target HTTPS proxy attaches it, so nothing negotiates X25519MLKEM768 yet';
  }
  if (exists && value === 'DEFAULT') {
    warning = 'this policy is set to DEFAULT, which silently becomes ENABLED in October 2026. Set it explicitly.';
  }
  return { exists: exists, value: value, min_tls: minTls, effective: effective, attached_proxies: attached, coverage_known: coverageKnown, warning: warning };
}

// In-flight: these operations are asynchronous and take minutes (staging, the
// human's approval tap, then the GCP operation). The UI needs to know which of
// those three it is sitting in, so the pending job is reported explicitly.
export async function pqcPending(): Promise<any> {
  try {
    const snap = await pcCol().where('status', '==', 'pending').limit(25).get();
    for (const doc of snap.docs) {
      const d: any = doc.data() || {};
      const cmd = String((d.arguments && (d.arguments.command || d.arguments.cmd)) || '');
      if (cmd.indexOf('/sslPolicies/' + PQC_POLICY_NAME) >= 0 || String(d.command_type || '').indexOf('sslPolicies') >= 0) {
        let want = '';
        const m = /"postQuantumKeyExchange"\s*:\s*"([A-Z]+)"/.exec(cmd);
        if (m) want = m[1];
        return { job_id: String(d.job_id || doc.id), want: want, staged_by: String(d.staged_by || ''), state: 'awaiting_approval' };
      }
    }
  } catch (e) {}
  return null;
}

// ---- git-blob upload raw-body guard ----
const PC_BLOB_MAX_BYTES = 64 * 1024 * 1024;
// RAW BODY, ROUTE-LEVEL ONLY. app.use(express.json()) is mounted globally at the top of
// this file and app.use(express.urlencoded()) further down; neither touches a body whose
// Content-Type is not JSON or form-encoded, so an upload sent as application/octet-stream
// reaches this middleware unparsed and NO OTHER ROUTE's body parsing changes -- this
// express.raw is attached to this one registration, not to the app. A caller who mislabels
// an upload as application/json or as a form gets a 400 from here naming the header,
// rather than a Buffer that is silently an object.
const pcBlobRawBody = express.raw({ type: '*/*', limit: PC_BLOB_MAX_BYTES });
// The size refusal is handled HERE rather than falling through to Express's default error
// handler, which would answer 413 with an HTML page a machine client cannot read.
export function pcBlobBody(req: any, res: any, next: any): void {
  pcBlobRawBody(req, res, (err: any) => {
    if (err) {
      const tooBig = !!(err && (err.type === 'entity.too.large' || err.status === 413));
      console.error('[git-blob] body rejected: ' + String((err && err.message) || err));
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'too large' : 'bad body',
        detail: tooBig
          ? 'an upload may be at most ' + PC_BLOB_MAX_BYTES + ' bytes'
          : String((err && err.message) || err).slice(0, 300),
      });
      return;
    }
    next();
  });
}
