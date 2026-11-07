// [TOKEN-USAGE-PG] Native Postgres store for token_usage (append-only, ts range/order reads)
// and token_usage_gaps (append-only). Firestore-collection-shaped so call sites keep
// .add(), .orderBy('ts',dir).limit(n).get(), .where('ts','>=',Date).limit(n).get().
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 4 }); return _pool; }
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId(): string { const b = require('crypto').randomBytes(20); let s = ''; for (let i = 0; i < 20; i++) s += ALPHA[b[i] % 62]; return s; }
function tsLike(d: Date): any { const ms = d.getTime(); return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6, toMillis: () => ms, toDate: () => d, toString: () => d.toISOString() }; }
function ctor(v: any): string { return (v && v.constructor && v.constructor.name) || ''; }
// resolve a ts-ish write value (serverTimestamp sentinel -> now)
function tsWrite(v: any): Date { if (ctor(v) === 'ServerTimestampTransform') return new Date(); if (v instanceof Date) return v; if (v && typeof v._seconds === 'number') return new Date(v._seconds * 1000); if (typeof v === 'number') return new Date(v); return new Date(); }
// resolve a ts-ish bound value for a WHERE (Date / Timestamp-like)
function tsBound(v: any): Date { if (v instanceof Date) return v; if (v && typeof v._seconds === 'number') return new Date(v._seconds * 1000); if (v && typeof v.toMillis === 'function') return new Date(v.toMillis()); if (typeof v === 'number') return new Date(v); return new Date(v); }
const TU_COLS = ['agent', 'model', 'source', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

function tuRowToDoc(r: any): any {
  const o: any = Object.assign({}, (r.data && typeof r.data === 'object') ? r.data : {});
  o.agent = r.agent; o.model = r.model; o.source = r.source;
  o.input_tokens = Number(r.input_tokens || 0); o.output_tokens = Number(r.output_tokens || 0);
  o.cache_creation_input_tokens = Number(r.cache_creation_input_tokens || 0); o.cache_read_input_tokens = Number(r.cache_read_input_tokens || 0);
  if (r.ts != null) o.ts = tsLike(r.ts instanceof Date ? r.ts : new Date(r.ts));
  return o;
}
async function tuAdd(obj: any): Promise<void> {
  const id = genId();
  const over: any = {};
  for (const k of Object.keys(obj || {})) if (TU_COLS.indexOf(k) < 0 && k !== 'ts') over[k] = obj[k];
  await pool().query(
    'insert into oa.token_usage (id,agent,model,source,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,ts,data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
    [id, obj.agent ?? null, obj.model ?? null, obj.source ?? null, Number(obj.input_tokens || 0), Number(obj.output_tokens || 0), Number(obj.cache_creation_input_tokens || 0), Number(obj.cache_read_input_tokens || 0), tsWrite(obj.ts), JSON.stringify(over)]);
}
async function tuQuery(st: any): Promise<any> {
  const preds: string[] = []; const args: any[] = []; let i = 1;
  for (const w of (st.wheres || [])) {
    if (w[0] !== 'ts') throw new Error('token-usage-pg: only ts predicates supported');
    const op = w[1]; if (['>=', '>', '<=', '<'].indexOf(op) < 0) throw new Error('token-usage-pg: unsupported op ' + op);
    preds.push('ts ' + op + ' $' + i); args.push(tsBound(w[2])); i++;
  }
  let sql = 'select * from oa.token_usage';
  if (preds.length) sql += ' where ' + preds.join(' and ');
  if (st.order && st.order[0] === 'ts') sql += ' order by ts ' + ((st.order[1] || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc');
  if (st.lim != null) sql += ' limit ' + Number(st.lim);
  const r = await pool().query(sql, args);
  const docs = r.rows.map((row: any) => ({ id: row.id, exists: true, data: () => tuRowToDoc(row) }));
  return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) };
}
function tuQ(st: any): any {
  return {
    where(f: string, op: string, v: any) { return tuQ(Object.assign({}, st, { wheres: [...(st.wheres || []), [f, op, v]] })); },
    orderBy(f: string, dir?: string) { return tuQ(Object.assign({}, st, { order: [f, dir || 'asc'] })); },
    limit(n: number) { return tuQ(Object.assign({}, st, { lim: n })); },
    get() { return tuQuery(st); },
  };
}
async function gapAdd(obj: any): Promise<void> {
  await pool().query('insert into oa.token_usage_gaps (id,agent,model,source,reason,saw,ts) values ($1,$2,$3,$4,$5,$6,$7)',
    [genId(), obj.agent ?? null, obj.model ?? null, obj.source ?? null, obj.reason ?? null, obj.saw ?? null, tsWrite(obj.ts)]);
}
function col(name: string): any {
  if (name === 'token_usage_gaps') return { async add(obj: any) { await gapAdd(obj); return { id: 'gap' }; } };
  return {
    async add(obj: any) { await tuAdd(obj); return { id: 'tu' }; },
    where(f: string, op: string, v: any) { return tuQ({ wheres: [[f, op, v]] }); },
    orderBy(f: string, dir?: string) { return tuQ({ order: [f, dir || 'asc'] }); },
    limit(n: number) { return tuQ({ lim: n }); },
    get() { return tuQuery({}); },
  };
}
module.exports = { col, _pool: () => _pool };
