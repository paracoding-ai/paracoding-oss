// SPDX-License-Identifier: Apache-2.0
// [MOD-STATUS-METRICS] Extracted from control-plane/src/index.ts (strangler refactor, 2026-10-20).
// Status-page metrics (CPU ring from /proc/stat + Cloud Monitoring edge/LB traffic) and the
// BigQuery billing lookups. Imports shared primitives ONLY from ../shared.js -- never from ../index.js.
import { waAccessToken, waFetch, GCP_PROJECT, GCP_BILLING_DATASET } from '../shared.js';

export async function pcBq(sql: string): Promise<any> {
  try {
    const tok = await waAccessToken();
    const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/queries', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25000 }) });
    const t = await r.text(); try { return JSON.parse(t); } catch (e) { return null; }
  } catch (e) { return null; }
}
export async function pcBillTable(): Promise<string> {
  try {
    const tok = await waAccessToken();
    const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/datasets/' + GCP_BILLING_DATASET + '/tables?maxResults=200', { headers: { Authorization: 'Bearer ' + tok } });
    const j: any = JSON.parse(await r.text());
    const ids = ((j && j.tables) || []).map((x: any) => (x.tableReference && x.tableReference.tableId) || '').filter((x: string) => x.indexOf('gcp_billing_export_v1_') === 0);
    if (!ids.length) return '';
    // Prefer the table for the CURRENTLY-linked billing account. Relinking to a new billing
    // account creates a NEW export table and the old one goes stale, so lexical-last is wrong.
    try {
      const br: any = await waFetch('https://cloudbilling.googleapis.com/v1/projects/' + GCP_PROJECT + '/billingInfo', { headers: { Authorization: 'Bearer ' + tok } });
      const bj: any = JSON.parse(await br.text());
      const acct = String((bj && bj.billingAccountName) || '').split('/').pop() || '';
      if (acct) { const want = 'gcp_billing_export_v1_' + acct.replace(/-/g, '_'); if (ids.indexOf(want) >= 0) return want; }
    } catch (e) {}
    return ids.sort().reverse()[0] || '';
  } catch (e) { return ''; }
}
const SM_CPU: { t: number; st: any }[] = [];
export function smReadProcStat(): any {
  try {
    const line = require('fs').readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map((x: string) => Number(x) || 0);
    const user = p[0] + p[1], system = p[2], idle = p[3], iowait = p[4] || 0, other = (p[5]||0)+(p[6]||0)+(p[7]||0)+(p[8]||0);
    return { user, system, idle, iowait, other, total: user + system + idle + iowait + other };
  } catch (e) { return null; }
}
export function smSample(): void { const st = smReadProcStat(); if (!st) return; SM_CPU.push({ t: Date.now(), st }); const cut = Date.now() - 7 * 864e5; while (SM_CPU.length && SM_CPU[0].t < cut) SM_CPU.shift(); }
if (process.env.PC_NO_LISTEN !== '1') { try { setInterval(smSample, 20000); smSample(); } catch (e) {} }
export function smCpuBuckets(windowSec: number, n: number): any {
  const now = Date.now(), start = now - windowSec * 1000, bw = windowSec * 1000 / n;
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const b0 = start + i * bw, b1 = b0 + bw;
    const a = SM_CPU.filter((x) => x.t >= b0 - bw && x.t <= b1);
    if (a.length < 2) { out.push(null); continue; }
    const s0 = a[0].st, s1 = a[a.length - 1].st, dt = s1.total - s0.total;
    if (dt <= 0) { out.push(null); continue; }
    const pc = (k: string) => Math.max(0, Math.round(((s1[k] - s0[k]) / dt) * 1000) / 10);
    out.push({ t: Math.round(b1), user: pc('user'), system: pc('system'), iowait: pc('iowait'), other: pc('other'), idle: pc('idle') });
  }
  return { buckets: out, vcpu: (() => { try { return require('os').cpus().length; } catch (e) { return 0; } })() };
}
export async function smMon(filter: string, windowSec: number, aligner: string, reducer: string, groupLabel: string): Promise<any> {
  try {
    const tok = await waAccessToken();
    const end = new Date(), start = new Date(Date.now() - windowSec * 1000);
    const align = Math.max(60, Math.round(windowSec / 60));
    let qs = 'interval.startTime=' + encodeURIComponent(start.toISOString())
      + '&interval.endTime=' + encodeURIComponent(end.toISOString())
      + '&aggregation.alignmentPeriod=' + align + 's'
      + '&aggregation.perSeriesAligner=' + aligner;
    if (reducer) { qs += '&aggregation.crossSeriesReducer=' + reducer; if (groupLabel) qs += '&aggregation.groupByFields=' + encodeURIComponent('resource.label.' + groupLabel); }
    qs += '&filter=' + encodeURIComponent(filter);
    const r: any = await waFetch('https://monitoring.googleapis.com/v3/projects/' + GCP_PROJECT + '/timeSeries?' + qs, { headers: { Authorization: 'Bearer ' + tok } });
    const j: any = JSON.parse(await r.text());
    const out: any = {};
    (j.timeSeries || []).forEach((ts: any) => {
      const rl = (ts.resource && ts.resource.labels) || {}, ml = (ts.metric && ts.metric.labels) || {};
      const lbl = String((groupLabel && (rl[groupLabel] != null ? rl[groupLabel] : ml[groupLabel])) != null ? (rl[groupLabel] != null ? rl[groupLabel] : ml[groupLabel]) : 'all');
      const pts = (ts.points || []).map((pt: any) => ({ t: new Date(pt.interval.endTime).getTime(), v: Number((pt.value && (pt.value.doubleValue != null ? pt.value.doubleValue : pt.value.int64Value)) || 0) })).reverse();
      out[lbl] = (out[lbl] || []).concat(pts);
    });
    return out;
  } catch (e) { return {}; }
}
const SM_EDGE_SVC = ['vmcp-ui', 'vmcp-mcp'];
export async function smEdge(windowSec: number): Promise<any> {
  const f = (m: string) => 'metric.type="run.googleapis.com/container/network/' + m + '" resource.type="cloud_run_revision" (' + SM_EDGE_SVC.map((x) => 'resource.label.service_name="' + x + '"').join(' OR ') + ')';
  const inB = await smMon(f('received_bytes_count'), windowSec, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  const outB = await smMon(f('sent_bytes_count'), windowSec, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  return SM_EDGE_SVC.map((x) => ({ service: x, in: inB[x] || [], out: outB[x] || [] }));
}
export async function smNet(windowSec: number): Promise<any> {
  // LB torn down post-migration; "all edge surfaces" = sum of Cloud Run network bytes across the edges.
  const f = (m: string) => 'metric.type="run.googleapis.com/container/network/' + m + '" resource.type="cloud_run_revision" (' + SM_EDGE_SVC.map((x) => 'resource.label.service_name="' + x + '"').join(' OR ') + ')';
  const inB = await smMon(f('received_bytes_count'), windowSec, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  const outB = await smMon(f('sent_bytes_count'), windowSec, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  const req = await smMon('metric.type="run.googleapis.com/request_count" resource.type="cloud_run_revision" (' + SM_EDGE_SVC.map((x) => 'resource.label.service_name="' + x + '"').join(' OR ') + ')', windowSec, 'ALIGN_RATE', 'REDUCE_SUM', 'service_name');
  return { bytes_in: inB, bytes_out: outB, req };
}


export async function smCpu(windowSec: number): Promise<any> {
  try {
    const tok = await waAccessToken();
    const end = new Date(), start = new Date(Date.now() - windowSec * 1000);
    const align = Math.max(60, Math.round(windowSec / 60));
    const qs = 'interval.startTime=' + encodeURIComponent(start.toISOString())
      + '&interval.endTime=' + encodeURIComponent(end.toISOString())
      + '&aggregation.alignmentPeriod=' + align + 's'
      + '&aggregation.perSeriesAligner=ALIGN_MEAN'
      + '&aggregation.crossSeriesReducer=REDUCE_MEAN'
      + '&aggregation.groupByFields=' + encodeURIComponent('metric.label.cpu_state')
      + '&filter=' + encodeURIComponent('metric.type="agent.googleapis.com/cpu/utilization"');
    const r: any = await waFetch('https://monitoring.googleapis.com/v3/projects/' + GCP_PROJECT + '/timeSeries?' + qs, { headers: { Authorization: 'Bearer ' + tok } });
    const j: any = JSON.parse(await r.text());
    const byState: any = {};
    (j.timeSeries || []).forEach((ts: any) => {
      const st = String(((ts.metric && ts.metric.labels) || {}).cpu_state || 'other');
      (ts.points || []).forEach((pt: any) => {
        const t = new Date(pt.interval.endTime).getTime();
        const v = Number((pt.value && (pt.value.doubleValue != null ? pt.value.doubleValue : pt.value.int64Value)) || 0);
        (byState[st] = byState[st] || {})[t] = v;
      });
    });
    const tset: any = {};
    Object.keys(byState).forEach((s) => Object.keys(byState[s]).forEach((t) => { tset[t] = 1; }));
    const times = Object.keys(tset).map(Number).sort((a, b) => a - b);
    const g = (s: string, t: number) => (byState[s] && byState[s][t]) || 0;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const buckets = times.map((t) => ({
      t,
      user: r1(g('user', t)),
      system: r1(g('system', t)),
      iowait: r1(g('wait', t)),
      other: r1(g('nice', t) + g('steal', t) + g('interrupt', t) + g('softirq', t)),
      idle: r1(g('idle', t)),
    }));
    let vcpu = 0; try { vcpu = require('os').cpus().length; } catch (e) {}
    return { buckets, vcpu };
  } catch (e) { return { buckets: [], vcpu: 0 }; }
}

export async function smMem(windowSec: number): Promise<any> {
  try {
    const tok = await waAccessToken();
    const end = new Date(), start = new Date(Date.now() - windowSec * 1000);
    const align = Math.max(60, Math.round(windowSec / 60));
    const qs = 'interval.startTime=' + encodeURIComponent(start.toISOString())
      + '&interval.endTime=' + encodeURIComponent(end.toISOString())
      + '&aggregation.alignmentPeriod=' + align + 's'
      + '&aggregation.perSeriesAligner=ALIGN_MEAN'
      + '&aggregation.crossSeriesReducer=REDUCE_MEAN'
      + '&aggregation.groupByFields=' + encodeURIComponent('metric.label.state')
      + '&filter=' + encodeURIComponent('metric.type="agent.googleapis.com/memory/percent_used"');
    const r: any = await waFetch('https://monitoring.googleapis.com/v3/projects/' + GCP_PROJECT + '/timeSeries?' + qs, { headers: { Authorization: 'Bearer ' + tok } });
    const j: any = JSON.parse(await r.text());
    const byState: any = {};
    (j.timeSeries || []).forEach((ts: any) => {
      const st = String(((ts.metric && ts.metric.labels) || {}).state || 'other');
      (ts.points || []).forEach((pt: any) => {
        const t = new Date(pt.interval.endTime).getTime();
        const v = Number((pt.value && (pt.value.doubleValue != null ? pt.value.doubleValue : pt.value.int64Value)) || 0);
        (byState[st] = byState[st] || {})[t] = v;
      });
    });
    const tset: any = {};
    Object.keys(byState).forEach((s) => Object.keys(byState[s]).forEach((t) => { tset[t] = 1; }));
    const times = Object.keys(tset).map(Number).sort((a, b) => a - b);
    const g = (s: string, t: number) => (byState[s] && byState[s][t]) || 0;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const buckets = times.map((t) => ({
      t,
      used: r1(g('used', t)),
      cached: r1(g('cached', t)),
      buffered: r1(g('buffered', t)),
      free: r1(g('free', t) + g('slab', t)),
    }));
    let totalGb = 0; try { totalGb = Math.round(require('os').totalmem() / 1073741824 * 10) / 10; } catch (e) {}
    return { buckets, totalGb };
  } catch (e) { return { buckets: [], totalGb: 0 }; }
}
