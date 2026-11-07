// [VRP-PG] Routes the bq tool's vrp.* reads/writes to native Postgres (schema vrp), so the
// bughunter VRP tracker lives on-box instead of BigQuery. Tables mirror BQ 1:1; the views
// findings_latest / candidates / followups_due are recreated in pg. insert() appends (BQ
// streaming-insert semantics) / upserts keyed tables; query() runs (rewritten) SQL on pg.
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6 }); return _pool; }

const COLS: { [t: string]: string[] } = {
  findings: ['finding_id','repo','title','vein','program','severity','status','verdict','file_path','line','pinned_sha','chain','precondition','poc','verified_by','banked_by','work_item_id','buganizer_id','filed_by','filed_on','triaged_priority','reward','created_at','updated_at','found_by','consensus','llm_verdicts','vet_verdict','vet_reason','vet_program','vet_at','vet_pipeline','source_quote','source_symbols','source_proof','gate_status','gate_reason'],
  leads: ['lead_id','repo','tool','file_path','line','rule','snippet','pinned_sha','run_id','created_at'],
  repos: ['repo','owner','host','program','oss_tier','cloud_vrp','payable','payable_on','tiers','priority','vein','hunted','status','date_first_hunted','last_hunted','hunt_count','findings_count','pinned_sha','notes','source','updated_at','leads_run'],
  hunt_runs: ['run_id','repo','pipeline_id','pipeline_url','commit_sha','passes','lean_candidates','semgrep_hits','secret_hits','osv_hits','status','summary','started_at','finished_at'],
  prep: ['finding_id','repo','file_path','line','pinned_sha','permalink','program','vein','severity','title','score','evidence_md','scaffold_md','created_at'],
  report_followups: ['buganizer_id','priority','status','title','repo','vein','file_path','pinned_sha','classify','followup_status','poc_zip','poc_film','comment_path','notes','updated_at'],
  hunt_queue: ['queue_pos','repo','program','oss_tier','vein','band','vein_score','kw','status','verdict','wi_ids','added','updated'],
};
const PK: { [t: string]: string } = { repos: 'repo', prep: 'finding_id', report_followups: 'buganizer_id' };
const VIEWS = new Set(['findings_latest', 'candidates', 'followups_due']);
const nz = (v: any): any => (typeof v === 'string' && v.indexOf('\u0000') >= 0) ? v.replace(/\u0000/g, '') : v;

// normalize a table reference to its bare vrp table/view name, or '' if not vrp.
function vrpTable(table: string): string {
  let t = String(table || '').replace(/`/g, '').trim();
  t = t.replace(/^your-project-id\./i, '').replace(/^your-project-id:/i, '');
  const m = t.match(/(?:^|\.)vrp\.([a-z_]+)$/i);
  if (!m) return '';
  const name = m[1].toLowerCase();
  return (COLS[name] || VIEWS.has(name)) ? name : '';
}
function ownsTable(table: string): boolean { return !!vrpTable(table); }
// does this SQL touch a vrp.* object?
function isVrpQuery(sql: string): boolean {
  const s = String(sql || '').replace(/`/g, '');
  return /\bvrp\.[a-z_]+/i.test(s) || /your-project-id\.vrp\./i.test(s);
}
// rewrite BQ table refs -> pg schema-qualified
function rewrite(sql: string): string {
  let s = String(sql || '').replace(/`/g, '');
  s = s.replace(/your-project-id[.:]vrp\./gi, 'vrp.');
  s = s.replace(/your-project-id[.:]/gi, '');
  return s;
}

async function insert(table: string, rows: any[]): Promise<any> {
  const t = vrpTable(table);
  if (!t || VIEWS.has(t)) return { ok: false, error: 'vrp-pg: not an insertable vrp table: ' + table };
  const cols = COLS[t];
  if (!Array.isArray(rows) || !rows.length) return { ok: true, inserted: 0 };
  const client = await pool().connect();
  let inserted = 0;
  try {
    const conflict = PK[t] ? (' on conflict (' + PK[t] + ') do update set ' + cols.filter(c => c !== PK[t]).map(c => c + '=excluded.' + c).join(',')) : '';
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const vals: any[] = []; const tuples: string[] = []; let p = 1;
      for (const r of batch) { const ph = cols.map(c => { vals.push(r[c] === undefined ? null : nz(r[c])); return '$' + (p++); }); tuples.push('(' + ph.join(',') + ')'); }
      const res = await client.query('insert into vrp.' + t + ' (' + cols.join(',') + ') values ' + tuples.join(',') + conflict, vals);
      inserted += res.rowCount || batch.length;
    }
  } finally { client.release(); }
  return { ok: true, inserted, table: 'vrp.' + t, store: 'postgres' };
}

async function query(sql: string, maxRows: number): Promise<any> {
  const pgsql = rewrite(sql);
  try {
    const r = await pool().query(pgsql);
    const rows = Array.isArray(r.rows) ? r.rows.slice(0, Math.max(1, maxRows || 1000)) : [];
    const schema = (r.fields || []).map((f: any) => String(f.name));
    const out: any = { ok: true, store: 'postgres', schema, rows, rowCount: rows.length, totalRows: Array.isArray(r.rows) ? r.rows.length : (r.rowCount || 0) };
    if (/^\s*(update|insert|delete|merge)\b/i.test(pgsql)) out.numDmlAffectedRows = r.rowCount || 0;
    return out;
  } catch (e: any) {
    return { ok: false, store: 'postgres', error: String((e && e.message) || e), hint: 'VRP is now Postgres (schema vrp) on PG17; use Postgres SQL dialect, not BigQuery (no backticks, no FORMAT_TIMESTAMP/SAFE_CAST/EXCEPT()).' };
  }
}

module.exports = { ownsTable, isVrpQuery, insert, query, _vrpTable: vrpTable, _rewrite: rewrite, _pool: () => _pool };
