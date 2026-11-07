// SPDX-License-Identifier: Apache-2.0
// [SEC-BQ-ARCHIVE-V1] BigQuery forever-archive (search/read/measure) helpers.
// Extracted from control-plane/src/index.ts by strangler refactor. Pure helpers plus
// thin BigQuery REST I/O; no db / FieldValue / pcCol access lives here.
import { GCP_PROJECT, PC_ARCHIVE_COLLS, waFetch, waAccessToken, tsMillis } from '../shared.js';

// ==================== [SEC-BQ-ARCHIVE-V1] the forever-archive in BigQuery ====================
// journal and chat_history rows expire from Firestore ([SEC-TTL-CHOKEPOINT-V1]); the archive
// in BigQuery is kept FOREVER (operator parameter). Raw REST against bigquery.googleapis.com
// with the metadata-server token, the exact pattern waBqQuery above already uses -- NO new npm
// dependency, deliberately: the Dockerfile transpiles rather than bundles, so every import
// must resolve from node_modules at runtime, and the Storage Write API client would be a new
// one. Streaming insertAll is enough for a best-effort mirror.
//
// ORDERING HAZARD: the dual-write captures NEW writes only. Enabling the Firestore TTL
// policy before the archive dataset is created AND seeded from the existing collections
// destroys every pre-deploy transcript with no copy. Sequence and commands:
// deploy/TTL-BIGQUERY-INFRA.md (create dataset/tables -> seed -> deploy this -> only then TTL).
//
// COST DISCIPLINE, all four teeth:
//   - maximumBytesBilled = 2 GiB on EVERY query, enforced SERVER-SIDE by BigQuery, so no
//     future edit of the SQL string can quietly bypass it;
//   - tables are DAY-partitioned on ts, clustered on agent_id, require_partition_filter=true
//     (DDL in the infra doc), and every query here carries a partition filter;
//   - a per-instance scan budget of ~144 GB per UTC month (~14% of the 1 TiB free tier);
//   - the archive is consulted ONLY when live Firestore under-delivers, so the common path
//     costs zero and stays byte-identical to the pre-archive behaviour.
// Rows written to Firestore by src/runner/*.py are TTL-stamped there but NOT dual-written
// (those processes have no archive path); they reach BigQuery via the idempotent re-seed
// MERGE in the infra doc. Dedup on read is by document id either way.
const PC_ARCHIVE_DATASET = process.env.PC_ARCHIVE_DATASET || 'pc_archive';
const PC_ARCHIVE_OFF = String(process.env.PC_ARCHIVE || '').toLowerCase() === 'off';
const PC_ARCH_MAX_BYTES_BILLED = '2147483648';
const PC_ARCH_MONTH_BYTES_CAP = 144000000000;
const PC_ARCH_BUDGET: { month: string; bytes: number } = { month: '', bytes: 0 };
let PC_ARCH_WARN_AT = 0;
// The dual-write is BEST EFFORT by operator parameter, so a failure is a rate-limited log
// line and never the caller's problem. This catch-and-log is the DECREED behaviour for this
// side channel, not a swallowed deploy error: the Firestore write it mirrors has already
// succeeded, and Firestore remains the source of truth for 120 days.
export function pcArchWarn(msg: string): void {
  const now = Date.now();
  if (now - PC_ARCH_WARN_AT < 300000) return;
  PC_ARCH_WARN_AT = now;
  try { console.warn('[SEC-BQ-ARCHIVE-V1] ' + msg); } catch (e) {}
}
// PURE: shape one BigQuery row from a Firestore payload. FieldValue.serverTimestamp()
// sentinels carry no time yet, so a sentinel timestamp becomes nowIso -- within clock skew
// of what Firestore will record, and exact enough for an archive keyed by doc_id.
export function pcArchiveRow(coll: string, docId: string, data: any, nowIso: string): any {
  const d: any = (data && typeof data === 'object') ? data : {};
  const s = (v: any): string => (typeof v === 'string') ? v : ((typeof v === 'number' || typeof v === 'boolean') ? String(v) : '');
  const when = (v: any): string => {
    const ms = tsMillis(v);
    if (ms) return new Date(ms).toISOString();
    if (v instanceof Date) return v.toISOString();
    return nowIso;
  };
  if (coll === 'journal') {
    return { doc_id: docId, agent_id: s(d.agent_id), action: s(d.action), message: s(d.message), job_id: s(d.job_id), ts: when(d.timestamp) };
  }
  return { doc_id: docId, agent_id: s(d.agent_id), role: s(d.role), text: s(d.text), tags: JSON.stringify(Array.isArray(d.tags) ? d.tags : []), session: s(d.session), ts: when(d.timestamp) };
}
// Fire-and-forget mirror of one just-written document. Never throws; see pcArchWarn above.
// insertId = the Firestore document id, so BigQuery's own streaming dedup and the read-side
// dedup agree on what "the same row" means.
export async function pcArchiveOnWrite(coll: string, docId: string, data: any): Promise<void> {
  if (PC_ARCHIVE_OFF || !docId) return;
  const table = PC_ARCHIVE_COLLS[coll];
  if (!table) return;
  try {
    const row = pcArchiveRow(coll, docId, data, new Date().toISOString());
    const tok = await waAccessToken();
    const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/datasets/' + PC_ARCHIVE_DATASET + '/tables/' + table + '/insertAll', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bigquery#tableDataInsertAllRequest', rows: [{ insertId: docId, json: row }] }),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || (j && Array.isArray(j.insertErrors) && j.insertErrors.length)) {
      pcArchWarn('dual-write to ' + PC_ARCHIVE_DATASET + '.' + table + ' FAILED (HTTP ' + String(r.status) + '). The Firestore write succeeded; the archive is missing this row until the next re-seed (deploy/TTL-BIGQUERY-INFRA.md). If the dataset does not exist yet, run the infra doc steps IN ORDER.');
    }
  } catch (e: any) {
    pcArchWarn('dual-write threw: ' + String((e && e.message) || e) + '. The Firestore write succeeded; the archive catches up at the next re-seed.');
  }
}
// PURE: the one parameterised query both history tools use. STRPOS, never LIKE -- the needle
// is DATA and must not be interpretable as a pattern -- and every string is a named query
// parameter, never spliced into the SQL. The only inlined values are the project/dataset
// identifiers (env-derived, identifiers cannot be parameterised in SQL) and the two integer
// literals produced by clamping below. The partition filter (ts >= 3650 days back) satisfies
// require_partition_filter; widen it in one place if the archive ever outlives a decade.
export function pcArchSql(project: string, dataset: string, lim: number): string {
  const n = Math.max(1, Math.min(500, Math.floor(Number(lim) || 0) || 30));
  return 'SELECT doc_id, agent_id, role, text, tags, session, ts FROM `' + project + '.' + dataset + '.chat_history`'
    + ' WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3650 DAY)'
    + ' AND agent_id = @agent'
    + " AND (@q = '' OR STRPOS(LOWER(text), @q) > 0 OR STRPOS(LOWER(tags), @q) > 0)"
    + " AND (@role = '' OR role = @role)"
    + ' ORDER BY ts DESC LIMIT ' + String(n);
}
// PURE: named string parameters in BigQuery REST shape.
export function pcArchParams(vals: { [k: string]: string }): any[] {
  const out: any[] = [];
  for (const k of Object.keys(vals)) {
    out.push({ name: k, parameterType: { type: 'STRING' }, parameterValue: { value: String(vals[k]) } });
  }
  return out;
}
export async function pcArchQuery(sql: string, params: { [k: string]: string }): Promise<any> {
  const tok = await waAccessToken();
  const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/queries', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, parameterMode: 'NAMED', queryParameters: pcArchParams(params), maximumBytesBilled: PC_ARCH_MAX_BYTES_BILLED, timeoutMs: 20000 }),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) {
    const msg = String((j && j.error && j.error.message) || ('HTTP ' + String(r && r.status)));
    return { ok: false, err: msg, tooExpensive: /bytesbilled|bytes billed|byte limit/i.test(msg) };
  }
  if (j.jobComplete === false) return { ok: false, err: 'query did not complete within timeoutMs', tooExpensive: false };
  const fields: any[] = (j.schema && j.schema.fields) || [];
  const rows: any[] = (j.rows || []).map((rw: any) => {
    const o: any = {};
    (rw.f || []).forEach((c: any, i: number) => { o[String((fields[i] && fields[i].name) || i)] = c && c.v; });
    return o;
  });
  return { ok: true, rows: rows, bytes: Number(j.totalBytesProcessed || 0) };
}
// PURE: one archive result row in the same shape the live rows serve. BigQuery serves
// TIMESTAMP as epoch SECONDS in a decimal string; timestamp becomes an ISO string here, which
// pcRowMillis below understands alongside live Firestore Timestamps. archived:true marks
// provenance so a reader can tell which half of a merged answer each row came from.
export function pcArchHistRow(r: any): any {
  let tags: any = [];
  try { tags = JSON.parse(String((r && r.tags) || '[]')); } catch (e) { tags = []; }
  if (!Array.isArray(tags)) tags = [];
  const ms = Math.round(Number((r && r.ts) || 0) * 1000) || 0;
  return { id: String((r && r.doc_id) || ''), agent_id: String((r && r.agent_id) || ''), role: String((r && r.role) || ''), text: String((r && r.text) || ''), tags: tags, session: String((r && r.session) || ''), timestamp: ms ? new Date(ms).toISOString() : '', archived: true };
}
// PURE: dedup BY DOCUMENT ID. fsIds is every id the live read FETCHED (not only the ones
// served): a document the live side saw and filtered out must not sneak back in through its
// archive copy, and a duplicate among the archive rows themselves is dropped the same way.
export function pcArchMergeDedup(fsRows: any[], fsIds: string[], archRows: any[]): any[] {
  const seen: { [id: string]: boolean } = {};
  for (const id of (fsIds || [])) { if (id) seen[id] = true; }
  const merged = (fsRows || []).slice();
  for (const r of (archRows || [])) {
    const id = String((r && r.id) || '');
    if (!id || seen[id]) continue;
    seen[id] = true;
    merged.push(r);
  }
  return merged;
}
// PURE: consult the archive ONLY when live Firestore under-delivers -- either it served
// fewer rows than asked for, or its pre-existing 3000-document no-orderBy scan window was
// FULL, in which case the live subset is arbitrary and recall cannot be trusted.
export function pcArchFallbackDecision(served: number, requested: number, fsScanTruncated: boolean): { consult: boolean; reason: string } {
  if (fsScanTruncated) return { consult: true, reason: 'the live Firestore scan hit its 3000-document window' };
  if (served < requested) return { consult: true, reason: 'live Firestore served ' + String(served) + ' of the ' + String(requested) + ' rows requested' };
  return { consult: false, reason: 'live Firestore served the full request' };
}
// PURE: the in-band notice. Every consultation says what happened -- served / unreachable /
// budget-spent / too-expensive -- and the pre-existing 3000-document truncation is REPORTED
// rather than left silent.
export function pcArchNotice(why: string, outcome: string, fsScanTruncated: boolean): string {
  const parts: string[] = ['[SEC-BQ-ARCHIVE-V1]'];
  if (fsScanTruncated) parts.push('WARNING: the live Firestore read is capped at 3000 documents with NO orderBy and that cap was HIT, so the live half of this answer is an arbitrary subset.');
  parts.push('The BigQuery archive was consulted because ' + why + '.');
  parts.push(outcome);
  return parts.join(' ');
}
// PURE: notice placement, chosen by which end survives that tool's result-cap truncation.
// read_history is in PC_RESULT_CAP_TAIL (cut from the FRONT, tail survives): notice TRAILS.
// search_history is head-kept (cut from the BACK): notice LEADS.
export function pcArchPlaceNotice(body: string, notice: string, keptTail: boolean): string {
  if (!notice) return body;
  return keptTail ? (body + '\n\n' + notice) : (notice + '\n\n' + body);
}
// PURE: per-instance monthly scan budget over UTC calendar months.
export function pcArchMonthKey(nowMs: number): string { return new Date(nowMs).toISOString().slice(0, 7); }
export function pcArchBudgetSpent(state: any, nowMs: number, capBytes: number): boolean {
  if (!state || state.month !== pcArchMonthKey(nowMs)) return false;
  return (Number(state.bytes) || 0) >= capBytes;
}
export function pcArchBudgetCharge(state: any, nowMs: number, addBytes: number): { month: string; bytes: number } {
  const mkey = pcArchMonthKey(nowMs);
  const cur = (state && state.month === mkey) ? (Number(state.bytes) || 0) : 0;
  return { month: mkey, bytes: cur + Math.max(0, Number(addBytes) || 0) };
}
// PURE: classify the archive attempt into rows + the exact in-band outcome sentence. The
// failure paths are first-class here so the extracted-function tests can drive them.
export function pcArchOutcome(budgetSpent: boolean, res: any, dataset: string): { rows: any[]; notice: string; bytes: number } {
  if (budgetSpent) {
    return { rows: [], bytes: 0, notice: 'Outcome: BUDGET-SPENT -- this instance has used its ~144 GB archive scan budget for the current UTC month, so the archive was NOT searched this time; older rows exist in BigQuery dataset ' + dataset + '. Narrow the query, or retry after the month rolls over.' };
  }
  if (!res || res.ok !== true) {
    const err = String((res && res.err) || 'no response');
    if (res && res.tooExpensive) {
      return { rows: [], bytes: 0, notice: 'Outcome: TOO-EXPENSIVE -- BigQuery refused the query at the server-side 2 GiB maximumBytesBilled cap (' + err + '); older rows were NOT searched. Narrow with query/role/limit.' };
    }
    // [SEC-BQ-UNPROVISIONED-V49] NOT PROVISIONED IS NOT BROKEN, AND SAYING SO IS THE WHOLE FIX.
    // MEASURED 2026-08-15 on prod: gen.py and install.sh mention bigquery ZERO times, and
    // `bq datasets list` returns 0 items -- so the archive does not exist on THIS fleet and has
    // never existed on ANY adopter's install. The tools ship; the provisioning does not. Until
    // now every one of those installs surfaced a raw 'Access Denied ... bigquery.jobs.create'
    // through this branch, which reads as a broken system rather than an optional feature that
    // was never switched on. That is the same defect shape the installer's 0/10 Firestore-region
    // check already paid for: a check that cries wolf on every fresh install is worse than no
    // check, because the operator who needs it is the one who has learned to scroll past it.
    // THREE OUTCOMES, NOT TWO, and the third one is the common case. Detection is on the error
    // BigQuery itself returns, not on a config flag, because a flag would claim provisioning
    // that may have been half-done: jobs.create denied is the IAM half missing, 'Not found:
    // Dataset' is the dataset half missing, and an unenabled API is neither. All three mean the
    // same thing to a reader -- nobody built this yet -- and none of them means the archive is
    // malfunctioning. A genuine fault still falls through to UNREACHABLE below, so this cannot
    // swallow a real failure: it recognises only the fingerprints of an install that never ran
    // the runbook.
    // CORRECTED 2026-08-15, WITHIN MINUTES OF DEPLOY, BY THE FLEET'S OWN PROD. After the
    // project-level grant landed, the next failure was NOT 'Not found: Dataset' but:
    //   Access Denied: Table <p>:pc_archive.chat_history: User does not have permission to
    //   query table <p>:pc_archive.chat_history, or perhaps it does not exist.
    // BigQuery answers a MISSING TABLE with an access-denied shape on purpose, so it does not
    // leak whether the table exists. The first version of this test only knew the dataset
    // wording, so it classified a half-provisioned install as a FAULT and told the reader the
    // archive 'appears to BE provisioned'. That is the exact wrong answer for the exact case
    // this branch exists to catch, and only a real install produced it.
    if (/bigquery[.]jobs[.]create|Not found: Dataset|Not found: Table|or perhaps it does not exist|permission to query table|has not been used in project|accessNotConfigured/i.test(err)) {
      return { rows: [], bytes: 0, notice: 'Outcome: NOT-PROVISIONED -- the BigQuery forever-archive is OPTIONAL and this install has not created it, so there are no older rows to search and nothing is broken. This answer is live Firestore only, which holds the most recent 120 days. To enable it, follow deploy/TTL-BIGQUERY-INFRA.md: it needs BOTH the dataset ' + dataset + ' (created and seeded) AND roles/bigquery.jobUser on this service on the project -- BigQuery requires jobs.create at project level to run any query, whatever the dataset ACL says. Do NOT enable the Firestore TTL until the archive is created and seeded, or pre-deploy transcripts are destroyed with no copy. Reported cause: ' + err + '.' };
    }
    return { rows: [], bytes: 0, notice: 'Outcome: UNREACHABLE -- the archive query failed (' + err + '); this answer is live Firestore only and older rows were NOT searched. The archive appears to BE provisioned on this install, so this is a fault rather than a missing setup.' };
  }
  const rows = (res.rows || []).map(pcArchHistRow);
  return { rows: rows, bytes: Math.max(0, Number(res.bytes) || 0), notice: 'Outcome: SERVED -- ' + String(rows.length) + ' archived row(s) considered, deduplicated against live rows by document id.' };
}
// The one archive entry point for both history tools. Thin on purpose: budget check (pure),
// one bounded query, outcome classification (pure), budget charge (pure).
export async function pcArchHistFallback(agent: string, q: string, role: string, lim: number): Promise<{ rows: any[]; notice: string }> {
  if (PC_ARCHIVE_OFF) {
    return { rows: [], notice: 'Outcome: UNREACHABLE -- the archive is switched off on this service (PC_ARCHIVE=off); older rows were NOT searched.' };
  }
  const spent = pcArchBudgetSpent(PC_ARCH_BUDGET, Date.now(), PC_ARCH_MONTH_BYTES_CAP);
  let res: any = null;
  if (!spent) {
    try {
      res = await pcArchQuery(pcArchSql(GCP_PROJECT, PC_ARCHIVE_DATASET, lim), { agent: String(agent || ''), q: String(q || '').toLowerCase(), role: String(role || '') });
    } catch (e: any) {
      res = { ok: false, err: String((e && e.message) || e), tooExpensive: false };
    }
  }
  const out = pcArchOutcome(spent, res, PC_ARCHIVE_DATASET);
  if (out.bytes) {
    const st = pcArchBudgetCharge(PC_ARCH_BUDGET, Date.now(), out.bytes);
    PC_ARCH_BUDGET.month = st.month; PC_ARCH_BUDGET.bytes = st.bytes;
  }
  return { rows: out.rows, notice: out.notice };
}
