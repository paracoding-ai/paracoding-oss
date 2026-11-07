// [KVDOC-PG] Generic native Postgres document store (table oa.kv, keyed by (coll,id)).
// Backs the simple keyed-document Firestore collections: config, settings, migrations,
// agent_messages, session_keys, user_sessions, ge_sessions, session_revocations, ops_session,
// pending_confirms. Returns Firestore-CollectionReference / DocumentReference / snapshot shapes
// so index.ts call sites are unchanged. FieldValue sentinels (serverTimestamp / increment /
// arrayUnion / arrayRemove) are detected by constructor name and applied faithfully; Date and
// Firestore Timestamp values round-trip through a tagged {__ts:iso} jsonb form so reads return
// Timestamp-like objects (._seconds/.toMillis/.toDate). NUL bytes are deep-stripped (pg jsonb).
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6 }); return _pool; }

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId(): string { const b = require('crypto').randomBytes(20); let s = ''; for (let i = 0; i < 20; i++) s += ALPHA[b[i] % 62]; return s; }

function tsLike(iso: string): any {
  const d = new Date(iso); const ms = d.getTime();
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms, toDate: () => d, toString: () => d.toISOString() };
}
function ctor(v: any): string { return (v && v.constructor && v.constructor.name) || ''; }

// Normalize a plain value for storage: Dates/Timestamps -> {__ts}, strip NUL, recurse.
function norm(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') return v.indexOf('\u0000') >= 0 ? v.replace(/\u0000/g, '') : v;
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (typeof v === 'object' && typeof v._seconds === 'number') return { __ts: new Date(v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6)).toISOString() };
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') { const o: any = {}; for (const k of Object.keys(v)) o[k] = norm(v[k]); return o; }
  return v;
}
// Revive stored jsonb -> Firestore-doc shape: {__ts} -> Timestamp-like.
function revive(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(revive);
  if (typeof v === 'object') {
    if (typeof v.__ts === 'string' && Object.keys(v).length === 1) return tsLike(v.__ts);
    const o: any = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o;
  }
  return v;
}
function isTransform(v: any): boolean {
  const c = ctor(v);
  return c === 'NumericIncrementTransform' || c === 'ArrayUnionTransform' || c === 'ArrayRemoveTransform' || c === 'ServerTimestampTransform';
}
function hasSentinel(v: any): boolean {
  if (v == null || typeof v !== 'object') return false;
  const c = ctor(v);
  if (c === 'NumericIncrementTransform' || c === 'ArrayUnionTransform' || c === 'ArrayRemoveTransform') return true;
  if (c === 'ServerTimestampTransform' || v instanceof Date) return false; // serverTimestamp alone uses the fast merge path
  if (Array.isArray(v)) { for (const e of v) if (hasSentinel(e)) return true; return false; }
  for (const k of Object.keys(v)) if (hasSentinel(v[k])) return true;
  return false;
}
function deepEqual(a: any, b: any): boolean { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } }
// Apply a write object onto a base doc (merge), resolving sentinels against base values.
function applyField(baseVal: any, v: any): any {
  const c = ctor(v);
  if (c === 'ServerTimestampTransform') return { __ts: new Date().toISOString() };
  if (c === 'NumericIncrementTransform') return (Number(baseVal) || 0) + Number(v.operand || 0);
  if (c === 'ArrayUnionTransform') { const a = Array.isArray(baseVal) ? baseVal.slice() : []; for (const e of (v.elements || [])) { const ne = norm(e); if (!a.some((x: any) => deepEqual(x, ne))) a.push(ne); } return a; }
  if (c === 'ArrayRemoveTransform') { const rem = (v.elements || []).map(norm); return (Array.isArray(baseVal) ? baseVal : []).filter((x: any) => !rem.some((e: any) => deepEqual(e, x))); }
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (v && typeof v === 'object' && typeof v._seconds === 'number') return { __ts: new Date(v._seconds * 1000).toISOString() };
  // plain nested object -> deep-merge against base (Firestore set{merge:true} deep-merges maps)
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: any = (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal)) ? Object.assign({}, baseVal) : {};
    for (const k of Object.keys(v)) out[k] = applyField(out[k], v[k]);
    return out;
  }
  return norm(v);
}
function applyObj(base: any, obj: any): any {
  const out: any = Object.assign({}, base || {});
  for (const k of Object.keys(obj || {})) out[k] = applyField(out[k], obj[k]);
  return out;
}
// Build a normalized jsonb payload (no inc/array sentinels; serverTimestamp -> now).
function normWrite(obj: any): any {
  const out: any = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (ctor(v) === 'ServerTimestampTransform') out[k] = { __ts: new Date().toISOString() };
    else out[k] = norm(v);
  }
  return out;
}

async function getRow(coll: string, id: string): Promise<any> {
  const r = await pool().query('select data from oa.kv where coll=$1 and id=$2', [coll, id]);
  return r.rows.length ? r.rows[0].data : null;
}
// full replace (.set no merge)
async function setFull(coll: string, id: string, obj: any): Promise<void> {
  if (hasSentinel(obj)) return rmw(coll, id, obj, false);
  const data = normWrite(obj);
  await pool().query('insert into oa.kv (coll,id,data,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (coll,id) do update set data=excluded.data, updated_at=now()', [coll, id, JSON.stringify(data)]);
}
// shallow merge (.set {merge:true} / .update)
async function setMerge(coll: string, id: string, obj: any): Promise<void> {
  if (hasSentinel(obj)) return rmw(coll, id, obj, true);
  const data = normWrite(obj);
  await pool().query("insert into oa.kv (coll,id,data,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (coll,id) do update set data = coalesce(oa.kv.data,'{}'::jsonb) || excluded.data, updated_at=now()", [coll, id, JSON.stringify(data)]);
}
// read-modify-write under advisory lock (for increment / arrayUnion / arrayRemove)
async function rmw(coll: string, id: string, obj: any, merge: boolean): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [coll + '\u0001' + id]);
    const r = await client.query('select data from oa.kv where coll=$1 and id=$2 for update', [coll, id]);
    const base = merge ? (r.rows.length ? r.rows[0].data : {}) : {};
    const data = applyObj(base, obj);
    await client.query('insert into oa.kv (coll,id,data,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (coll,id) do update set data=excluded.data, updated_at=now()', [coll, id, JSON.stringify(data)]);
    await client.query('commit');
  } catch (e) { try { await client.query('rollback'); } catch (e2) {} throw e; }
  finally { client.release(); }
}
// atomic full-replace computed from the previous doc (ops_session tombstone; merge:false)
async function replaceTx(coll: string, id: string, mutator: (prev: any) => any): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [coll + '\u0001' + id]);
    const r = await client.query('select data from oa.kv where coll=$1 and id=$2 for update', [coll, id]);
    const prev = r.rows.length ? revive(r.rows[0].data) : {};
    const next = normWrite(mutator(prev) || {});
    await client.query('insert into oa.kv (coll,id,data,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (coll,id) do update set data=excluded.data, updated_at=now()', [coll, id, JSON.stringify(next)]);
    await client.query('commit');
  } catch (e) { try { await client.query('rollback'); } catch (e2) {} throw e; }
  finally { client.release(); }
}
async function delDoc(coll: string, id: string): Promise<void> { await pool().query('delete from oa.kv where coll=$1 and id=$2', [coll, id]); }

function docSnap(coll: string, id: string, data: any): any {
  return { id, exists: data != null, ref: docRef(coll, id), data: () => (data == null ? undefined : revive(data)) };
}
function docRef(coll: string, id: string): any {
  return {
    id, path: coll + '/' + id,
    async get() { return docSnap(coll, id, await getRow(coll, id)); },
    async set(obj: any, opts?: any) { if (opts && opts.merge) await setMerge(coll, id, obj); else await setFull(coll, id, obj); },
    async update(obj: any) { await setMerge(coll, id, obj); },
    async delete() { await delDoc(coll, id); },
  };
}

async function runQuery(coll: string, st: any): Promise<any> {
  const preds: string[] = ['coll=$1']; const args: any[] = [coll]; let i = 2;
  for (const w of (st.wheres || [])) {
    if (w[1] !== '==') throw new Error('kvdoc-pg: unsupported op ' + w[1]);
    preds.push("data->>'" + String(w[0]).replace(/[^a-zA-Z0-9_]/g, '') + "' = $" + i); args.push(String(w[2])); i++;
  }
  let sql = 'select id, data from oa.kv where ' + preds.join(' and ') + ' order by id';
  if (st.lim != null) sql += ' limit ' + Number(st.lim);
  const r = await pool().query(sql, args);
  const docs = r.rows.map((row: any) => docSnap(coll, row.id, row.data));
  return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) };
}
async function runCount(coll: string, st: any): Promise<number> {
  const preds: string[] = ['coll=$1']; const args: any[] = [coll]; let i = 2;
  for (const w of (st.wheres || [])) { if (w[1] !== '==') throw new Error('kvdoc-pg: unsupported count op'); preds.push("data->>'" + String(w[0]).replace(/[^a-zA-Z0-9_]/g, '') + "' = $" + i); args.push(String(w[2])); i++; }
  const r = await pool().query('select count(*)::int n from oa.kv where ' + preds.join(' and '), args);
  return r.rows[0] ? r.rows[0].n : 0;
}
function query(coll: string, st: any): any {
  return {
    where(f: string, op: string, v: any) { return query(coll, Object.assign({}, st, { wheres: [...(st.wheres || []), [f, op, v]] })); },
    limit(n: number) { return query(coll, Object.assign({}, st, { lim: n })); },
    orderBy(_f: string, _d?: string) { return query(coll, st); }, // only id order is used; kv has no other ordered reads
    get() { return runQuery(coll, st); },
    count() { return { get: async () => { const n = await runCount(coll, st); return { data: () => ({ count: n }) }; } }; },
  };
}
function col(coll: string): any {
  return {
    doc(id?: string) { return docRef(coll, id || genId()); },
    where(f: string, op: string, v: any) { return query(coll, { wheres: [[f, op, v]] }); },
    orderBy(_f: string, _d?: string) { return query(coll, {}); },
    limit(n: number) { return query(coll, { lim: n }); },
    get() { return runQuery(coll, {}); },
    async add(obj: any) { const id = genId(); await setFull(coll, id, obj); return docRef(coll, id); },
  };
}

module.exports = { col, replaceTx, rawGet: getRow, rawSetFull: setFull, rawSetMerge: setMerge, rawDel: delDoc, _pool: () => _pool, _revive: revive, _norm: norm };
