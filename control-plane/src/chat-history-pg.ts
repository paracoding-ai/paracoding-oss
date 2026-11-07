// [CHAT-HISTORY-PG] Native Postgres store for the chat_history collection (oa.chat_history).
// Firestore-CollectionReference-shaped adapter so index.ts call sites keep
// db.collection('chat_history').doc()/.add()/.where()/.orderBy()/.limit()/.count()/.get()
// and docSnap.data() verbatim. The Firestore field is `timestamp`; the column is `ts`.
// Writes bypass the SEC-TTL-CHOKEPOINT (which patches the Firestore prototypes), so this
// module stamps expire_at (now + 120d) itself; the dead BigQuery dual-write is intentionally
// dropped (pc_archive never existed -> it was failing silently anyway).
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 4 }); return _pool; }

const TTL_DAYS = 120;
const SCALAR = ['agent_id', 'role', 'text', 'session', 'provider', 'model', 'effort', 'tool_model'];
const INTC = ['tools_run'];
const JSONB = ['tags', 'steps'];
// Firestore field `timestamp` maps to column `ts`; `expireAt` -> `expire_at`.
const MAPPED = new Set(['id', 'data', 'timestamp', 'expireAt', 'ts', 'expire_at', ...SCALAR, ...INTC, ...JSONB]);

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId(): string { const b = require('crypto').randomBytes(20); let s = ''; for (let i = 0; i < 20; i++) s += ALPHA[b[i] % 62]; return s; }
// Postgres text/jsonb cannot hold NUL (\u0000). Strip it from scalars and from serialized JSON.
function nz(v: any): any { return (typeof v === 'string' && v.indexOf('\u0000') >= 0) ? v.replace(/\u0000/g, '') : v; }
function deepNz(v: any): any {
  if (typeof v === 'string') return (v.indexOf('\u0000') >= 0) ? v.replace(/\u0000/g, '') : v;
  if (Array.isArray(v)) return v.map(deepNz);
  if (v && typeof v === 'object') { const o: any = {}; for (const k of Object.keys(v)) o[k] = deepNz(v[k]); return o; }
  return v;
}
function jstr(v: any): string { return JSON.stringify(deepNz(v === undefined ? null : v)); }

function tsLike(v: any): any {
  if (v == null) return v;
  const d = (v instanceof Date) ? v : new Date(v);
  const ms = d.getTime();
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms, toDate: () => d, toString: () => d.toISOString() };
}
// value for a timestamp-ish input: a Date if resolvable, else undefined (=> now()).
function tsVal(v: any): any {
  if (v == null) return undefined;
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (e) {} }
  if (typeof v.toMillis === 'function') { try { return new Date(v.toMillis()); } catch (e) {} }
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; }
  return undefined; // serverTimestamp() sentinel / unknown object -> now()
}

function rowToDoc(r: any): any {
  const o: any = Object.assign({}, (r.data && typeof r.data === 'object') ? r.data : {});
  o.id = r.id;
  for (const c of SCALAR) if (r[c] != null) o[c] = r[c];
  for (const c of INTC) if (r[c] != null) o[c] = r[c];
  for (const c of JSONB) if (r[c] != null) o[c] = r[c];
  if (r.ts != null) o.timestamp = tsLike(r.ts);
  return o;
}

async function insertDoc(id: string, obj: any): Promise<void> {
  const cols: string[] = ['id']; const ph: string[] = ['$1']; const args: any[] = [id]; let i = 2;
  const overflow: any = {};
  for (const k of Object.keys(obj || {})) {
    if (k === 'id' || k === 'timestamp' || k === 'expireAt') continue;
    if (SCALAR.indexOf(k) >= 0) { cols.push(k); ph.push('$' + i); args.push(obj[k] === undefined ? null : nz(obj[k])); i++; }
    else if (INTC.indexOf(k) >= 0) { cols.push(k); ph.push('$' + i); args.push(obj[k] == null ? null : Number(obj[k])); i++; }
    else if (JSONB.indexOf(k) >= 0) { cols.push(k); ph.push('$' + i + '::jsonb'); args.push(jstr(obj[k])); i++; }
    else overflow[k] = obj[k];
  }
  // ts: from `timestamp` field (resolvable) else now()
  cols.push('ts');
  if ('timestamp' in obj) { const d = tsVal(obj.timestamp); if (d !== undefined) { ph.push('$' + i); args.push(d); i++; } else ph.push('now()'); }
  else ph.push('now()');
  // expire_at: from `expireAt` if resolvable, else now() + TTL
  cols.push('expire_at');
  { const d = ('expireAt' in obj) ? tsVal(obj.expireAt) : undefined; if (d !== undefined) { ph.push('$' + i); args.push(d); i++; } else ph.push("now() + interval '" + TTL_DAYS + " days'"); }
  cols.push('data'); ph.push('$' + i + '::jsonb'); args.push(jstr(overflow)); i++;
  await pool().query('insert into oa.chat_history (' + cols.join(',') + ') values (' + ph.join(',') + ') on conflict (id) do nothing', args);
}

async function getRow(id: string): Promise<any> { const r = await pool().query('select * from oa.chat_history where id=$1', [id]); return r.rows.length ? r.rows[0] : null; }
async function delDoc(id: string): Promise<void> { await pool().query('delete from oa.chat_history where id=$1', [id]); }

function docSnap(id: string, row: any): any { return { id, exists: row != null, ref: docRef(id), data: () => (row == null ? undefined : rowToDoc(row)) }; }
function docRef(id: string): any {
  return {
    id, path: 'chat_history/' + id,
    async get() { return docSnap(id, await getRow(id)); },
    async set(obj: any) { await insertDoc(id, obj); },
    async update(obj: any) { await insertDoc(id, obj); }, // chat_history rows are append-only in practice
    async delete() { await delDoc(id); },
  };
}

function colName(f: string): string { if (f === '__name__') return 'id'; if (f === 'timestamp') return 'ts'; return f; }

async function runQuery(st: any): Promise<any> {
  const preds: string[] = []; const args: any[] = []; let i = 1;
  for (const w of (st.wheres || [])) {
    const col = colName(w[0]); const op = w[1]; const v = w[2];
    if (op === '==') { preds.push(col + '=$' + i); args.push(v); i++; }
    else if (op === 'in') { preds.push(col + '=ANY($' + i + '::text[])'); args.push(v); i++; }
    else throw new Error('chat-history-pg: unsupported op ' + op);
  }
  let orderCol = 'id'; let dir = 'asc';
  if (st.order) { orderCol = colName(st.order[0]); dir = (st.order[1] || 'asc').toLowerCase(); }
  let sql = 'select * from oa.chat_history';
  if (preds.length) sql += ' where ' + preds.join(' and ');
  sql += ' order by ' + orderCol + ' ' + (dir === 'desc' ? 'desc' : 'asc');
  if (orderCol !== 'id') sql += ', id ' + (dir === 'desc' ? 'desc' : 'asc'); // tie-break stable
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
    else throw new Error('chat-history-pg: unsupported count op ' + op);
  }
  let sql = 'select count(*)::int as n from oa.chat_history';
  if (preds.length) sql += ' where ' + preds.join(' and ');
  const r = await pool().query(sql, args);
  return r.rows[0] ? r.rows[0].n : 0;
}

function query(st: any): any {
  return {
    where(f: string, op: string, v: any) { return query(Object.assign({}, st, { wheres: [...(st.wheres || []), [f, op, v]] })); },
    orderBy(f: string, dir?: string) { return query(Object.assign({}, st, { order: [f, dir || 'asc'] })); },
    limit(n: number) { return query(Object.assign({}, st, { lim: n })); },
    get() { return runQuery(st); },
    count() { return { get: async () => { const n = await runCount(st); return { data: () => ({ count: n }) }; } }; },
  };
}

function col(): any {
  return {
    doc(id?: string) { return docRef(id || genId()); },
    where(f: string, op: string, v: any) { return query({ wheres: [[f, op, v]] }); },
    orderBy(f: string, dir?: string) { return query({ order: [f, dir || 'asc'] }); },
    limit(n: number) { return query({ lim: n }); },
    get() { return runQuery({}); },
    async add(obj: any) { const r = docRef(genId()); await insertDoc(r.id, obj); return { id: r.id }; },
  };
}

module.exports = { col, _pool: () => _pool, _rowToDoc: rowToDoc };
