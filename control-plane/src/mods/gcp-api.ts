// SPDX-License-Identifier: Apache-2.0
// [MOD-GCP-API] Extracted from control-plane/src/index.ts (strangler refactor, 2026-10-20).
// The dependency-free half of the generic GCP REST gateway plus the on-box data helpers:
//   - GCP passthrough predicates (host allow-list, danger classifier, blessed-read allow-list)
//   - the staging-time secret-destroy preflight (SECRET-DESTROY-PREFLIGHT-V1)
//   - direct pg query/insert over process.env.PC_PG_URL (no shared dep)
//   - BigQuery jobs.query + tabledata.insertAll helpers
// Imports shared primitives ONLY from ../shared.js -- never from ../index.js.
//
// LEFT IN index.ts (reported): harGcpApi and harGcpStage. harGcpStage reaches index-only symbols
// (pcAdmitStage, pcCol, db, FieldValue, pcAutoRun) and harGcpApi calls it, so moving either would
// require importing from ../index.js, which this refactor forbids. index.ts imports the predicates
// and pcSecretDestroyRefusal back from this module.
import { PC_PROJECT, PC_LAKE, GCP_PROJECT, waAccessToken, waFetch } from '../shared.js';

// Mirror of index.ts's module-local HAR_PROJECT (process.env or PC_PROJECT fallback). Kept local so
// the blessed-read allow-list resolves the same project without reaching into index.ts.
const HAR_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;

export function harGcpHostOk(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)googleapis\.com$/.test(u.hostname); } catch (e) { return false; }
}
export function harGcpDanger(method: string, url: string): boolean {
  const m = (method || '').trim().toUpperCase();
  if (m === 'DELETE' || m === 'PUT' || m === 'PATCH' || m === 'POST') return true;
  // HFC2-DANGER-V2. Every mutating verb already returned true above, so these URL patterns are the
  // catch for anything that reaches here WITHOUT a mutating method (and they document the
  // destroy-class surface): IAM policy writes, Secret Manager, service accounts AND their KEYS,
  // short-lived-credential minting (a token for a stronger SA is a privilege jump), instance
  // templates, instance deletion, machine-type changes, and bindings for powerful roles. Instance
  // creation and SA key creation are POSTs, so they are danger by the method rule above; naming them
  // here keeps them dangerous if that rule is ever narrowed. Every pattern from the previous version
  // is preserved -- this is additive only.
  return /:setIamPolicy|\/secrets(\/|$|\?)|secretmanager\.googleapis|serviceAccounts(\/|$|\?)|serviceAccounts\/[^\/]+\/keys|:generateAccessToken|:generateIdToken|:signJwt|:signBlob|iamcredentials\.googleapis|:deleteInstance|:setMachineType|\/instanceTemplates(\/|$|\?)|roles(\/|%2F)(owner|editor|[a-z.]*admin|iam\.|resourcemanager\.|compute\.|storage\.|secretmanager\.)/i.test(url || '');
}
export function harGcpBlessedDirect(method: string, url: string): boolean {
  if ((method || 'GET').toUpperCase() !== 'GET') return false;  // only READS run silently as CP_SA
  const P = [
    'https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/',
    'https://run.googleapis.com/v2/projects/' + HAR_PROJECT + '/',
    'https://run.googleapis.com/v1/projects/' + HAR_PROJECT + '/',
    // [SEC-LAKE-NOGUESS-V1] THE LAKE PREFIX IS PRESENT ONLY WHEN THE BUCKET IS CONFIGURED, and
    // it deliberately does NOT go through pcLakeBucket(): this is a boolean predicate on a
    // request path, and a throw here would turn an unconfigured lake into a 500 instead of a
    // refusal. Fail-closed here means BLESSING NOTHING, so the prefix is spread away entirely.
    // This site is not cosmetic. With the old derived fallback it authorised silent CP_SA GETs
    // against a bucket name guessed from GCP_PROJECT, which in a shared project is the OTHER
    // lane's lake. harWriteLake() was the loud half of this defect; this was the quiet half.
    ...(PC_LAKE ? ['https://storage.googleapis.com/storage/v1/b/' + PC_LAKE + '/'] : []),
    'https://logging.googleapis.com/v2/projects/' + HAR_PROJECT + '/',
    'https://monitoring.googleapis.com/v3/projects/' + HAR_PROJECT + '/',
  ];
  return P.some((p) => (url || '').indexOf(p) === 0);
}
// ================= [SECRET-DESTROY-PREFLIGHT-V1] STAGING-TIME REFUSAL =================
// A secretKeyRef mount is a HARD BOOT DEPENDENCY resolved BY THE PLATFORM, whether or
// not any line of application code reads the variable. On 2026-08-10 a gated job deleted
// Secret Manager secret ad-free-key in the production project. Every check made first was
// TRUE and every one of them was IRRELEVANT: no code reads AD_FREE_KEY, no deploy script
// sets it, a fresh dev project does not have it. Production went down ~70 minutes later,
// when the first COLD START after the delete aborted:
//
//   Could not fetch secret ".../secrets/ad-free-key/versions/latest" for environment
//   variable "AD_FREE_KEY". Instance startup will now abort.
//
// paracoding-control-plane and paracoding-control-plane-mcp both carried that mount.
// Warm instances kept serving the already-resolved value, which is why the outage
// arrived over an hour after the change and was not attributed to it.
//
// EVERY CHECK THAT BLESSED THAT DELETE ANSWERED "will something RE-CREATE it?".
// NONE ANSWERED "does anything currently REFERENCE it?". pipeline/secret-destroy-preflight.py
// answers that one, and this refuses to STAGE a destroy that has not run it.
//
// WHY STAGING TIME AND NOT EXECUTION TIME. A refusal here costs the operator NOTHING --
// no approval spent, no gate round trip. gate-exec/exec_server.py's
// SEC-SSHKEY-PREFLIGHT-V1 note already states the principle in the other direction:
// refusing a job a deployment cannot run "belongs in the control plane" rather than in
// the executor. This is that placement.
//
// IT IS NOT THE FIRST-TOKEN ALLOWLIST AND IT CANNOT REPEAT THAT FAILURE. That control
// inspected EVERY line of EVERY job, so `set -uo pipefail` killed every multi-line job
// the fleet stages, and it had to be stood down. This one fires ONLY on a command that
// destroys a Secret Manager secret or version. A job that does not do that is not read
// differently, cannot be refused by it, and there is no self-lockout: REMOVING this
// block is not itself a secret-destroy command. So it ENFORCES by default, deliberately,
// and the difference from the allowlist is the reason.
//
// THE ESCAPE IS TO DO THE WORK, NOT TO SET A FLAG. Run the preflight in the same job:
//
//   python3 secret-destroy-preflight.py <secret> --project <p> --source-root <dir> || exit 1
//   gcloud secrets delete <secret> --quiet
//
// The preflight exits non-zero for REFERENCED (2), UNKNOWN (3) and internal error (4),
// so `|| exit 1` is what makes the destroy conditional. A mention inside a comment does
// not satisfy this check; the invocation must be on a live line.
const PC_SECRET_DESTROY_TOKEN = 'secret-destroy-preflight.py';
const PC_SECRET_DESTROY_PATTERNS: RegExp[] = [
  /\bgcloud\b[^\n]*\bsecrets\b[^\n]*\bdelete\b/i,
  /\bgcloud\b[^\n]*\bsecrets\b[^\n]*\bversions\b[^\n]*\b(destroy|disable)\b/i,
  /-X[ \t]*DELETE[^\n]*secretmanager\.googleapis\.com/i,
  /(^|[\s'"])DELETE[\s'"][^\n]*secretmanager\.googleapis\.com[^\n]*\/secrets\//i,
  /secretmanager\.googleapis\.com[^\n]*\/secrets\/[^\n]*:(destroy|disable)/i,
];
export function pcLooksLikeSecretDestroy(text: string): boolean {
  const live = String(text || '').split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).join('\n');
  return PC_SECRET_DESTROY_PATTERNS.some((re) => re.test(live));
}
export function pcPreflightInvoked(text: string): boolean {
  return String(text || '').split('\n')
    .some((l) => l.trim() !== '' && !l.trim().startsWith('#') && l.indexOf(PC_SECRET_DESTROY_TOKEN) >= 0);
}
/** Returns a refusal string, or null to allow. Never throws: a guard that can throw is a
 *  guard that can be switched off by malformed input. */
export function pcSecretDestroyRefusal(text: string): string | null {
  try {
    if (!pcLooksLikeSecretDestroy(text)) return null;
    if (pcPreflightInvoked(text)) return null;
  } catch (e) { /* fall through to refuse */ }
  return 'REFUSED AT STAGING: this job destroys a Secret Manager secret or version and does '
    + 'not run ' + PC_SECRET_DESTROY_TOKEN + ' first. NOTHING WAS STAGED and no approval was '
    + 'spent. A secretKeyRef mount is a hard BOOT dependency resolved by the platform: '
    + '"no code reads the variable" is NOT "safe to delete" -- that exact reasoning took '
    + 'production down on 2026-08-10, ~70 minutes later, at the first cold start. Run the '
    + 'preflight in the same job and make the destroy conditional on it:\n'
    + '  python3 ' + PC_SECRET_DESTROY_TOKEN + ' <secret> --project <p> --source-root <dir> || exit 1\n'
    + '  <the destroy command>\n'
    + 'It exits 0 only when EVERY consumer kind was enumerated and none references the '
    + 'secret. REFERENCED is 2, UNKNOWN is 3. If it refuses, remove the reference FIRST '
    + '(deploy the services without the env), prove it, and only then delete.';
}

// [BQ-TOOL-V1] BigQuery read+write for ANY agent as the control-plane SA, reusing the same
// metadata-SA-token path waBqQuery/harGcpApi already use -- no new deps. harBqRun runs read SQL
// or DML via jobs.query and pages results; harBqInsert appends structured JSON rows via
// tabledata.insertAll (streaming) -- the reliable finding-write path: no SQL, no quoting.
// [PG-TOOL-V1] direct SQL to the on-box fleet Postgres (database "fleet"), analog of the bq tool.
let _harPgPool: any = null;
export function harPgPool(): any { if (!_harPgPool) { const { Pool } = require('pg'); _harPgPool = new Pool({ connectionString: process.env.PC_PG_URL || '', max: 4, idleTimeoutMillis: 30000 }); } return _harPgPool; }
export async function harPgQuery(sql: string, maxRows: number): Promise<any> {
  const r: any = await harPgPool().query(sql);
  const all = Array.isArray(r.rows) ? r.rows : [];
  const lim = maxRows || 1000;
  return { rows: all.slice(0, lim), rowCount: r.rowCount, fields: (r.fields || []).map((f: any) => f.name), truncated: all.length > lim };
}
export async function harPgInsert(table: string, rows: any[]): Promise<any> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(String(table || ''))) throw new Error('pg insert: bad table name');
  const r: any = await harPgPool().query('INSERT INTO ' + table + ' SELECT * FROM json_populate_recordset(NULL::' + table + ', $1::json)', [JSON.stringify(rows || [])]);
  return { inserted: r.rowCount };
}
export async function harBqRun(sql: string, maxRows: number): Promise<any> {
  const tok = await waAccessToken();
  const base = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT;
  const cap = Math.min(10000, Math.max(1, maxRows));
  let r = await waFetch(base + '/queries', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000, maxResults: cap }),
  });
  let j: any = await r.json();
  if (j && j.error) return { ok: false, error: (j.error.message || JSON.stringify(j.error)) };
  const jobId = j.jobReference && j.jobReference.jobId;
  const loc = j.jobReference && j.jobReference.location;
  const deadline = Date.now() + 90000;
  while (!j.jobComplete && jobId && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 1500));
    const u = base + '/queries/' + encodeURIComponent(jobId) + '?timeoutMs=20000&maxResults=' + cap + (loc ? ('&location=' + encodeURIComponent(loc)) : '');
    r = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
    j = await r.json();
    if (j && j.error) return { ok: false, error: (j.error.message || JSON.stringify(j.error)) };
  }
  const fields: string[] = (((j.schema && j.schema.fields) || []) as any[]).map((f: any) => String(f.name));
  const mapRow = (row: any) => { const o: any = {}; const cells = (row && row.f) || []; for (let i = 0; i < fields.length; i++) { o[fields[i]] = cells[i] ? cells[i].v : null; } return o; };
  let rows: any[] = (((j.rows) || []) as any[]).map(mapRow);
  let pageToken = j.pageToken;
  while (pageToken && rows.length < maxRows && jobId) {
    const u = base + '/queries/' + encodeURIComponent(jobId) + '?maxResults=' + cap + '&pageToken=' + encodeURIComponent(pageToken) + (loc ? ('&location=' + encodeURIComponent(loc)) : '');
    r = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
    j = await r.json();
    if (j && j.error) break;
    rows = rows.concat((((j.rows) || []) as any[]).map(mapRow));
    pageToken = j.pageToken;
  }
  return {
    ok: true,
    jobComplete: !!j.jobComplete,
    schema: fields,
    rowCount: Math.min(rows.length, maxRows),
    totalRows: j.totalRows ? Number(j.totalRows) : rows.length,
    numDmlAffectedRows: (j.numDmlAffectedRows !== undefined && j.numDmlAffectedRows !== null) ? Number(j.numDmlAffectedRows) : undefined,
    rows: rows.slice(0, maxRows),
  };
}
export function harBqParseTable(table: string): { project: string; dataset: string; table: string } | null {
  let t = String(table || '').trim().replace(/[\x60]/g, '');
  if (!t) return null;
  let project = GCP_PROJECT;
  if (t.indexOf(':') >= 0) { const p = t.split(':'); project = p[0]; t = p.slice(1).join(':'); }
  const parts = t.split('.');
  let dataset = ''; let tbl = '';
  if (parts.length === 3) { project = parts[0]; dataset = parts[1]; tbl = parts[2]; }
  else if (parts.length === 2) { dataset = parts[0]; tbl = parts[1]; }
  else return null;
  if (!dataset || !tbl) return null;
  return { project: project, dataset: dataset, table: tbl };
}
export async function harBqInsert(table: string, rows: any[]): Promise<any> {
  const ref = harBqParseTable(table);
  if (!ref) return { ok: false, error: 'table must be "dataset.table" or "project.dataset.table" (got: ' + String(table).slice(0, 80) + ')' };
  if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'rows must be a non-empty array of JSON objects (column -> value)' };
  for (const rw of rows) { if (!rw || typeof rw !== 'object' || Array.isArray(rw)) return { ok: false, error: 'each row must be a JSON object (column -> value)' }; }
  if (rows.length > 500) return { ok: false, error: 'insert at most 500 rows per call (got ' + rows.length + ')' };
  const tok = await waAccessToken();
  const url = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + ref.project + '/datasets/' + encodeURIComponent(ref.dataset) + '/tables/' + encodeURIComponent(ref.table) + '/insertAll';
  const body = { rows: rows.map((rw: any) => ({ json: rw })), skipInvalidRows: false, ignoreUnknownValues: false };
  const r = await waFetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j: any; try { j = await r.json(); } catch (e) { j = {}; }
  if (j && j.error) return { ok: false, http: r.status, error: (j.error.message || JSON.stringify(j.error)) };
  const insertErrors = (j && j.insertErrors) || null;
  if (insertErrors && insertErrors.length) return { ok: false, inserted: Math.max(0, rows.length - insertErrors.length), insertErrors: insertErrors.slice(0, 20), note: 'some rows rejected -- check column names/types vs the table schema' };
  return { ok: true, inserted: rows.length, table: ref.project + '.' + ref.dataset + '.' + ref.table };
}

// [PG-LOAD-V1] Bulk-load a LARGE dataset into on-box Postgres from a box-local file in ONE call.
// The executor and Postgres are the same VM, so the control plane reads the file directly and
// streams rows in batches via json_populate_recordset -- no chat-sized chunks. format: jsonl
// (one JSON object per line, default), json (a JSON array), or csv (header row + rows).
export async function harPgLoadFile(table: string, file: string, format: string, truncate: boolean, mode?: string): Promise<any> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(String(table || ''))) throw new Error('pg_load: bad table name (schema.table only)');
  const fs = require('fs');
  let raw: string;
  const _f = String(file || '');
  if (/^gs:\/\//i.test(_f)) {
    // [PG-LOAD-LAKE-V1] a gs://bucket/object lake path: the control plane downloads it (it always
    // holds lake read access), so write_file -> lake -> pg_load works without a shared disk path.
    const mm = _f.match(/^gs:\/\/([^/]+)\/(.+)$/i);
    if (!mm) throw new Error('pg_load: bad gs:// path, want gs://<bucket>/<object>: ' + _f);
    try { const { getStorage } = require('firebase-admin/storage'); const dl: any = await getStorage().bucket(mm[1]).file(mm[2]).download(); raw = dl[0].toString('utf8'); }
    catch (e: any) { throw new Error('pg_load: could not download ' + _f + ' from the lake (' + ((e && e.message) || e) + ')'); }
    if (raw.slice(0, 4) === 'PCV1') throw new Error('pg_load: ' + _f + ' is a vault-SEALED lake object (encrypted at rest) -- pg_load reads plaintext. write_file seals agent-folder objects, so load those via the shared disk path instead: write the plaintext with run_command to /srv/fleet/ingest/<name> and pass that path. (A plaintext lake object loads fine.)');
  } else {
    try { raw = fs.readFileSync(_f, 'utf8'); }
    catch (e: any) { throw new Error('pg_load: control plane cannot read ' + _f + ' (' + ((e && e.message) || e) + '). The control plane runs with a PRIVATE /tmp, so files written to /tmp or /var/tmp by run_command or write_file are NOT visible to it. Write the file to the SHARED ingest dir instead -- /srv/fleet/ingest/<name> (run_command, as the fleet user, can write there and the control plane reads the same path) -- or pass a gs://<bucket>/<object> lake path (write_file writes to the lake and pg_load will download it).'); }
  }
  const fmt = String(format || 'jsonl').toLowerCase();
  let rows: any[] = [];
  if (fmt === 'jsonl' || fmt === 'ndjson') {
    const lines = raw.split('\n'); for (let i = 0; i < lines.length; i++) { const t = lines[i].trim(); if (!t) continue; try { rows.push(JSON.parse(t)); } catch (e: any) { throw new Error('pg_load: bad JSON on line ' + (i + 1) + ': ' + ((e && e.message) || e)); } }
  } else if (fmt === 'json') {
    const j = JSON.parse(raw); rows = Array.isArray(j) ? j : [j];
  } else if (fmt === 'csv') {
    const pc = (line: string): string[] => { const out: string[] = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } } out.push(cur); return out; };
    const ls = raw.split('\n').filter((l: string) => l.length > 0); if (!ls.length) return { loaded: 0, table, rows_parsed: 0 };
    const hdr = pc(ls[0]); for (let i = 1; i < ls.length; i++) { const v = pc(ls[i]); const o: any = {}; for (let j = 0; j < hdr.length; j++) o[hdr[j]] = (v[j] === undefined ? null : v[j]); rows.push(o); }
  } else throw new Error('pg_load: format must be jsonl, json, or csv');
  if (!rows.length) return { loaded: 0, table, rows_parsed: 0 };
  // [PG-LOAD-MODE-V1] append (default) | replace | upsert. `truncate:true` is the legacy alias for
  // `replace`. replace uses TRUNCATE ... RESTART IDENTITY CASCADE so it works on an FK-referenced
  // table -- NOTE that CASCADE also empties the child tables that reference it. upsert appends with
  // ON CONFLICT DO NOTHING (dedups on the table's unique/primary key), so it never deletes and never
  // trips the FK-truncate error -- the right choice for reloading an FK-referenced table.
  const _mode = (String(mode || '').toLowerCase() || (truncate ? 'replace' : 'append'));
  if (['append', 'replace', 'upsert'].indexOf(_mode) < 0) throw new Error('pg_load: bad mode "' + _mode + '" (append|replace|upsert)');
  const _conflict = _mode === 'upsert' ? ' ON CONFLICT DO NOTHING' : '';
  const client = await harPgPool().connect();
  let loaded = 0;
  let _cols: string[] = [];
  try {
    // [PG-LOAD-COLS-V1] Insert ONLY the columns the data actually carries, so columns the data
    // omits (a SERIAL id, a defaulted created_at, ...) take their DB default instead of a forced
    // NULL. `INSERT ... SELECT *` broke on every table with a serial/default column. JSON keys that
    // are not columns of the table are ignored (common: extra metadata fields in the source rows).
    const _st = String(table).split('.'); const _sch = _st.length > 1 ? _st[0] : 'public'; const _tbl = _st[_st.length - 1];
    const _cr: any = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [_sch, _tbl]);
    const _tcols = new Set((_cr.rows || []).map((r: any) => r.column_name));
    if (!_tcols.size) throw new Error('pg_load: table ' + table + ' not found (no columns visible)');
    const _jk = new Set<string>(); for (const _r of rows) { if (_r && typeof _r === 'object') for (const _k of Object.keys(_r)) _jk.add(_k); }
    _cols = Array.from(_jk).filter((k) => _tcols.has(k));
    if (!_cols.length) throw new Error('pg_load: none of the data keys match columns of ' + table + ' -- data keys: ' + Array.from(_jk).slice(0, 20).join(',') + ' ; table columns: ' + Array.from(_tcols).join(','));
    const _cl = _cols.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(', ');
    await client.query('BEGIN');
    if (_mode === 'replace') await client.query('TRUNCATE ' + table + ' RESTART IDENTITY CASCADE');
    const B = 2000;
    for (let i = 0; i < rows.length; i += B) {
      const r: any = await client.query('INSERT INTO ' + table + ' (' + _cl + ') SELECT ' + _cl + ' FROM json_populate_recordset(NULL::' + table + ', $1::json)' + _conflict, [JSON.stringify(rows.slice(i, i + B))]);
      loaded += r.rowCount || 0;
    }
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_e) {} throw e; } finally { client.release(); }
  return { loaded, table, rows_parsed: rows.length, mode: _mode, columns: _cols };
}
