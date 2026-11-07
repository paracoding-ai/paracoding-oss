// ============================================================================
// journal-pg.ts  --  NATIVE Postgres store for the `journal` collection.
// Writes via the TTL chokepoint (addRef); reads via snapshot-shaped helpers +
// a pager (keyed on serial id = chronological, tie-free). pg is the forever-
// store (no TTL) -> BQ journal dual-write retired.
// ============================================================================
const { Pool } = require('pg');
const crypto = require('crypto');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6, idleTimeoutMillis: 30000 }); return _pool; }
const COLS = 'id,doc_id,agent_id,strain,action,message,severity,role,parent,detail,job_id,ts,at_ts';
function newId(): string { return crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, '').slice(0, 20); }
function tsLike(d: any): any { if (d == null) return undefined; const ms = +new Date(d); const s = Math.floor(ms / 1000); return { _seconds: s, _nanoseconds: 0, seconds: s, toMillis: () => ms, toDate: () => new Date(ms) }; }
function shape(x: any): any {
  const o: any = { agent_id: x.agent_id, action: x.action };
  const put = (k: string, v: any) => { if (v !== null && v !== undefined) o[k] = v; };
  put('strain', x.strain); put('message', x.message); put('severity', x.severity); put('role', x.role);
  put('parent', x.parent); put('job_id', x.job_id);
  if (x.detail != null) o.detail = x.detail;
  o.timestamp = tsLike(x.ts); if (x.at_ts != null) o.at = tsLike(x.at_ts);
  return o;
}
function docOf(x: any): any { return { id: x.doc_id, _id: Number(x.id), _ts: x.ts, ref: { id: x.doc_id }, exists: true, data: () => shape(x) }; }
function qSnap(rows: any[]): any { const docs = rows.map(docOf); return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) }; }

// WRITE (from the TTL chokepoint's patched .add for journal). Returns ref-like {id}.
async function addRef(data: any): Promise<any> {
  const id = newId();
  const hasAt = data && Object.prototype.hasOwnProperty.call(data, 'at');
  await pool().query(
    `insert into oa.journal (doc_id,agent_id,strain,action,message,severity,role,parent,detail,job_id,ts,at_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), ${hasAt ? 'now()' : 'null'})`,
    [id, data.agent_id ?? null, data.strain ?? null, data.action ?? null, data.message ?? null, data.severity ?? null, data.role ?? null, data.parent ?? null, (data.detail != null ? String(data.detail) : null), data.job_id ?? null]);
  return { id, path: 'journal/' + id };
}
// raw insert for backfill (preserve ts)
async function backfillRow(r: any): Promise<void> {
  await pool().query(
    `insert into oa.journal (doc_id,agent_id,strain,action,message,severity,role,parent,detail,job_id,ts,at_ts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (doc_id) do nothing`,
    [r.doc_id, r.agent_id, r.strain, r.action, r.message, r.severity, r.role, r.parent, r.detail, r.job_id, r.ts, r.at_ts]);
}

// READS (snapshot-shaped), ordered by id desc = newest first.
async function recent(limit: number): Promise<any> {
  const r = await pool().query('select ' + COLS + ' from oa.journal order by ts desc, id desc limit ' + Number(limit));
  return qSnap(r.rows);
}
async function recentPage(limit: number, after: any): Promise<any[]> {
  if (after && after.ts != null) { const r = await pool().query('select ' + COLS + ' from oa.journal where (ts, id) < ($1, $2) order by ts desc, id desc limit ' + Number(limit), [after.ts, after.id]); return r.rows; }
  const r = await pool().query('select ' + COLS + ' from oa.journal order by ts desc, id desc limit ' + Number(limit)); return r.rows;
}
// query-like pager matching the firestore loop API (.startAfter(doc).get())
function pager(limit: number): any {
  let after: any = null;
  const self: any = {
    startAfter: (doc: any) => { try { if (doc && doc._ts != null) after = { ts: doc._ts, id: doc._id }; } catch (e) {} return self; },
    limit: (_n: number) => self,
    get: async () => qSnap(await recentPage(limit, after)),
  };
  return self;
}
async function byStrain(strain: string, limit: number): Promise<any> {
  const r = await pool().query('select ' + COLS + ' from oa.journal where coalesce(strain,agent_id)=$1 order by ts desc, id desc limit ' + Number(limit), [strain]);
  return qSnap(r.rows);
}
async function byAgent(agentId: string, limit?: number): Promise<any> {
  const r = await pool().query('select ' + COLS + ' from oa.journal where agent_id=$1 order by ts desc, id desc' + (limit ? ' limit ' + Number(limit) : ''), [agentId]);
  return qSnap(r.rows);
}
async function byActionsRecent(actions: string[], limit: number): Promise<any> {
  const r = await pool().query('select ' + COLS + ' from oa.journal where action = any($1::text[]) order by ts desc, id desc limit ' + Number(limit), [actions]);
  return qSnap(r.rows);
}
async function delByAgent(agentId: string): Promise<number> {
  const r = await pool().query('delete from oa.journal where agent_id=$1', [agentId]);
  return r.rowCount || 0;
}
module.exports = { addRef, backfillRow, recent, recentPage, pager, byStrain, byAgent, byActionsRecent, delByAgent, _pool: () => _pool };
