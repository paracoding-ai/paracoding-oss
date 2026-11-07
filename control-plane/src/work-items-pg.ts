// [WORKITEM-PG] Native Postgres store for the work_items collection (oa.work_items).
// Exposes a Firestore-CollectionReference-shaped adapter so index.ts call sites keep
// db.collection('work_items').doc()/.where()/.orderBy()/.limit()/.startAfter()/.get()
// /.count() and docSnap.ref.update() verbatim. Real columns back the queried/indexed
// fields; a `data` jsonb column preserves any other (schemaless) field verbatim.
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 4 }); return _pool; }

const SCALAR = ['title', 'assigned_role', 'status', 'summary', 'created_by', 'source', 'substrate', 'claimed_by', 'completed_by', 'result_note', 'cancelled_by', 'cancel_note'];
const TS = ['created_at', 'claimed_at', 'completed_at', 'finished_at', 'cancelled_at', 'updated_at'];
const JSONB = ['payload', 'evidence', 'completion_evidence'];
const MAPPED = new Set(['id', 'data', ...SCALAR, ...TS, ...JSONB]);

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId(): string {
  const b = require('crypto').randomBytes(20); let s = '';
  for (let i = 0; i < 20; i++) s += ALPHA[b[i] % 62];
  return s;
}

function tsLike(v: any): any {
  if (v == null) return v;
  const d = (v instanceof Date) ? v : new Date(v);
  const ms = d.getTime();
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms, toDate: () => d, toString: () => d.toISOString() };
}

// row (SELECT *) -> Firestore-doc-shaped plain object
function rowToDoc(r: any): any {
  const o: any = Object.assign({}, (r.data && typeof r.data === 'object') ? r.data : {});
  o.id = r.id;
  for (const c of SCALAR) if (r[c] != null) o[c] = r[c];
  for (const c of JSONB) if (r[c] != null) o[c] = r[c];
  for (const c of TS) if (r[c] != null) o[c] = tsLike(r[c]);
  return o;
}

// split a write object into mapped columns and schemaless overflow
function split(obj: any): { cols: string[]; vals: any[]; tsCols: string[]; overflow: any } {
  const cols: string[] = []; const vals: any[] = []; const tsCols: string[] = []; const overflow: any = {};
  for (const k of Object.keys(obj || {})) {
    if (k === 'id') continue;
    if (TS.indexOf(k) >= 0) { tsCols.push(k); continue; }            // present -> now()
    if (SCALAR.indexOf(k) >= 0) { cols.push(k); vals.push(obj[k] === undefined ? null : obj[k]); continue; }
    if (JSONB.indexOf(k) >= 0) { cols.push(k); vals.push(JSON.stringify(obj[k] === undefined ? null : obj[k])); continue; }
    overflow[k] = obj[k];
  }
  return { cols, vals, tsCols, overflow };
}
function jsonbCast(c: string): string { return JSONB.indexOf(c) >= 0 ? '::jsonb' : ''; }

// .set(obj): upsert; mentioned cols written, data (overflow) replaced.
async function setDoc(id: string, obj: any): Promise<void> {
  const { cols, vals, tsCols, overflow } = split(obj);
  const insCols: string[] = ['id']; const insPh: string[] = ['$1']; const args: any[] = [id]; let i = 2;
  const upd: string[] = [];
  for (let k = 0; k < cols.length; k++) {
    const c = cols[k]; insCols.push(c); insPh.push('$' + i + jsonbCast(c)); args.push(vals[k]); upd.push(c + '=excluded.' + c); i++;
  }
  for (const c of tsCols) { insCols.push(c); insPh.push('now()'); upd.push(c + '=now()'); }
  insCols.push('data'); insPh.push('$' + i + '::jsonb'); args.push(JSON.stringify(overflow)); upd.push('data=excluded.data'); i++;
  const sql = 'insert into oa.work_items (' + insCols.join(',') + ') values (' + insPh.join(',') + ') on conflict (id) do update set ' + upd.join(',');
  await pool().query(sql, args);
}

// .update(obj): merge; mentioned cols set, overflow merged into data.
async function updateDoc(id: string, obj: any): Promise<void> {
  const { cols, vals, tsCols, overflow } = split(obj);
  const sets: string[] = []; const args: any[] = []; let i = 1;
  for (let k = 0; k < cols.length; k++) { const c = cols[k]; sets.push(c + '=$' + i + jsonbCast(c)); args.push(vals[k]); i++; }
  for (const c of tsCols) sets.push(c + '=now()');
  if (Object.keys(overflow).length) { sets.push('data = data || $' + i + '::jsonb'); args.push(JSON.stringify(overflow)); i++; }
  if (!sets.length) return;
  args.push(id);
  await pool().query('update oa.work_items set ' + sets.join(',') + ' where id=$' + i, args);
}

async function delDoc(id: string): Promise<void> { await pool().query('delete from oa.work_items where id=$1', [id]); }
async function getRow(id: string): Promise<any> { const r = await pool().query('select * from oa.work_items where id=$1', [id]); return r.rows.length ? r.rows[0] : null; }

function docSnap(id: string, row: any): any {
  return { id, exists: row != null, ref: docRef(id), data: () => (row == null ? undefined : rowToDoc(row)) };
}
function docRef(id: string): any {
  return {
    id, path: 'work_items/' + id,
    async get() { return docSnap(id, await getRow(id)); },
    async set(obj: any) { await setDoc(id, obj); },
    async update(obj: any) { await updateDoc(id, obj); },
    async delete() { await delDoc(id); },
    collection() { throw new Error('work-items-pg: subcollections are not supported'); },
  };
}

function colName(f: string): string { return (f === '__name__' || f === FieldPath_doc) ? 'id' : f; }
const FieldPath_doc = '__name__';

async function runQuery(st: any): Promise<any> {
  const preds: string[] = []; const args: any[] = []; let i = 1;
  for (const w of (st.wheres || [])) {
    const col = colName(w[0]); const op = w[1]; const v = w[2];
    if (op === '==') { preds.push(col + '=$' + i); args.push(v); i++; }
    else if (op === 'in') { preds.push(col + '=ANY($' + i + '::text[])'); args.push(v); i++; }
    else if (op === '>') { preds.push(col + '>$' + i); args.push(v); i++; }
    else if (op === '<') { preds.push(col + '<$' + i); args.push(v); i++; }
    else if (op === '>=') { preds.push(col + '>=$' + i); args.push(v); i++; }
    else if (op === '<=') { preds.push(col + '<=$' + i); args.push(v); i++; }
    else throw new Error('work-items-pg: unsupported op ' + op);
  }
  let orderCol = 'id'; let dir = 'asc';
  if (st.order) { orderCol = colName(st.order[0]); dir = (st.order[1] || 'asc').toLowerCase(); }
  if (st.after != null) {
    const col = orderCol; const cmp = (dir === 'desc') ? '<' : '>';
    preds.push(col + cmp + '$' + i); args.push(st.after); i++;
  }
  let sql = 'select * from oa.work_items';
  if (preds.length) sql += ' where ' + preds.join(' and ');
  sql += ' order by ' + orderCol + ' ' + (dir === 'desc' ? 'desc' : 'asc');
  if (st.lim != null) sql += ' limit ' + Number(st.lim);
  const r = await pool().query(sql, args);
  const docs = r.rows.map((row: any) => docSnap(row.id, row));
  return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) };
}
async function runCount(st: any): Promise<number> {
  const preds: string[] = []; const args: any[] = []; let i = 1;
  for (const w of (st.wheres || [])) {
    const col = colName(w[0]); const op = w[1]; const v = w[2];
    if (op === '==') { preds.push(col + '=$' + i); args.push(v); i++; }
    else if (op === 'in') { preds.push(col + '=ANY($' + i + '::text[])'); args.push(v); i++; }
    else throw new Error('work-items-pg: unsupported count op ' + op);
  }
  let sql = 'select count(*)::int as n from oa.work_items';
  if (preds.length) sql += ' where ' + preds.join(' and ');
  const r = await pool().query(sql, args);
  return r.rows[0] ? r.rows[0].n : 0;
}

function query(st: any): any {
  const api: any = {
    where(f: string, op: string, v: any) { return query(Object.assign({}, st, { wheres: [...(st.wheres || []), [f, op, v]] })); },
    orderBy(f: string, dir?: string) { return query(Object.assign({}, st, { order: [f, dir || 'asc'] })); },
    limit(n: number) { return query(Object.assign({}, st, { lim: n })); },
    startAfter(cur: any) { const id = (cur && typeof cur === 'object' && 'id' in cur) ? cur.id : cur; return query(Object.assign({}, st, { after: id })); },
    get() { return runQuery(st); },
    count() { return { get: async () => { const n = await runCount(st); return { data: () => ({ count: n }) }; } }; },
  };
  return api;
}

function col(): any {
  return {
    doc(id?: string) { return docRef(id || genId()); },
    where(f: string, op: string, v: any) { return query({ wheres: [[f, op, v]] }); },
    orderBy(f: string, dir?: string) { return query({ order: [f, dir || 'asc'] }); },
    limit(n: number) { return query({ lim: n }); },
    get() { return runQuery({}); },
    async add(obj: any) { const r = docRef(genId()); await r.set(obj); return r; },
  };
}

module.exports = { col, _pool: () => _pool, _rowToDoc: rowToDoc, _genId: genId };
