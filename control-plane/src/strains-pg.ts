// ============================================================================
// strains-pg.ts  --  NATIVE Postgres store for the `strains` registry.
// Pure native functions (no Firestore-API emulation). Call sites in index.ts
// call these directly when PC_STRAINS_STORE is on. Backed by typed oa.strains.
// Returns plain shaped objects matching the old Firestore .data() shape.
// ============================================================================
const { Pool } = require('pg');
let _pool: any = null;
function pool(): any {
  if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6, idleTimeoutMillis: 30000 });
  return _pool;
}
const COLS = 'role,display_name,status,pasteable,hidden,tool_classes,created_by,created_at,owner_email,shared_with,parent,mode,retired_by,retired_at,sa_email,oauth_client_id,oauth_email,delegating,user_token_aud,user_email,flags_set_by,flags_set_at';

// Firestore-Timestamp-like so callers using ._seconds/.toMillis()/.toDate() keep working.
function tsLike(d: any): any {
  if (d == null) return undefined;
  const ms = +new Date(d); const s = Math.floor(ms / 1000);
  return { _seconds: s, _nanoseconds: 0, seconds: s, toMillis: () => ms, toDate: () => new Date(ms) };
}
// row -> .data() shape. Null columns are OMITTED (Firestore-absent semantics) for the
// load-bearing optional fields; tool_classes absent === all classes, so null MUST omit.
function shape(x: any): any {
  if (!x) return null;
  const o: any = { role: x.role, display_name: x.display_name, status: x.status, shared_with: x.shared_with || [] };
  const put = (k: string, v: any) => { if (v !== null && v !== undefined) o[k] = v; };
  put('pasteable', x.pasteable); put('hidden', x.hidden); put('tool_classes', x.tool_classes);
  put('created_by', x.created_by); put('created_at', tsLike(x.created_at)); put('owner_email', x.owner_email);
  put('parent', x.parent); put('mode', x.mode); put('retired_by', x.retired_by); put('retired_at', tsLike(x.retired_at));
  put('sa_email', x.sa_email); put('oauth_client_id', x.oauth_client_id); put('oauth_email', x.oauth_email);
  put('delegating', x.delegating); put('user_token_aud', x.user_token_aud); put('user_email', x.user_email);
  put('flags_set_by', x.flags_set_by); put('flags_set_at', tsLike(x.flags_set_at));
  return o;
}

// ---------------- reads ----------------
async function get(role: string): Promise<any> {
  const r = await pool().query('select ' + COLS + ' from oa.strains where role=$1', [role]);
  return r.rows.length ? shape(r.rows[0]) : null;
}
async function list(activeOnly: boolean): Promise<any[]> {
  const r = await pool().query('select ' + COLS + ' from oa.strains' + (activeOnly ? " where status='active'" : ''));
  return r.rows.map(shape);
}
const QF: Set<string> = new Set(['user_email', 'sa_email', 'oauth_client_id']);
async function queryActive(field: string, value: string, limit: number): Promise<any[]> {
  if (!QF.has(field)) throw new Error('strains-pg: query field not allowed: ' + field);
  const r = await pool().query('select ' + COLS + ' from oa.strains where ' + field + "=$1 and status='active' limit " + Number(limit), [value]);
  return r.rows.map(shape);
}
async function exists(): Promise<boolean> {
  const r = await pool().query('select 1 from oa.strains limit 1');
  return r.rows.length > 0;
}
async function scan(limit: number): Promise<any[]> {
  const r = await pool().query('select ' + COLS + ' from oa.strains limit ' + Number(limit));
  return r.rows.map(shape);
}

// ---------------- writes ----------------
const TS = new Set(['created_at', 'retired_at', 'flags_set_at']);
const JSONB = new Set(['tool_classes', 'shared_with']);
// Column set for full overwrite (role is the PK, handled separately).
const ALLCOLS = ['display_name', 'status', 'pasteable', 'hidden', 'tool_classes', 'created_by', 'created_at', 'owner_email', 'shared_with', 'parent', 'mode', 'retired_by', 'retired_at', 'sa_email', 'oauth_client_id', 'oauth_email', 'delegating', 'user_token_aud', 'user_email', 'flags_set_by', 'flags_set_at'];
function val(col: string, obj: any): any {
  if (TS.has(col)) return undefined; // handled as now() literal in SQL
  if (JSONB.has(col)) return (col in obj) ? JSON.stringify(obj[col] || (col === 'shared_with' ? [] : null)) : null;
  return (col in obj) ? (obj[col] === undefined ? null : obj[col]) : null;
}
// Full overwrite (.set(obj) no merge): every column set; omitted -> null/default.
async function setFull(role: string, obj: any): Promise<void> {
  const cols: string[] = ['role']; const ph: string[] = ['$1']; const args: any[] = [role];
  let i = 2;
  for (const c of ALLCOLS) {
    cols.push(c);
    if (TS.has(c)) { ph.push(c in obj ? 'now()' : 'null'); }
    else if (c === 'shared_with') { ph.push('$' + i + '::jsonb'); args.push(JSON.stringify((obj.shared_with) || [])); i++; }
    else if (c === 'tool_classes') { ph.push(c in obj ? '$' + i + '::jsonb' : 'null'); if (c in obj) { args.push(JSON.stringify(obj[c] || null)); i++; } }
    else { ph.push('$' + i); args.push(val(c, obj)); i++; }
  }
  const upd = cols.slice(1).map(c => c + '=excluded.' + c).join(',');
  await pool().query('insert into oa.strains (' + cols.join(',') + ',updated_at) values (' + ph.join(',') + ',now()) on conflict (role) do update set ' + upd + ',updated_at=now()', args);
}
// Merge (.set(obj,{merge:true}) / .update(obj)): only keys present in obj are written.
async function merge(role: string, obj: any): Promise<void> {
  const setCols: string[] = []; const insCols: string[] = ['role']; const insPh: string[] = ['$1']; const args: any[] = [role];
  let i = 2;
  for (const c of ALLCOLS) {
    if (!(c in obj)) continue;
    insCols.push(c);
    if (TS.has(c)) { setCols.push(c + '=now()'); insPh.push('now()'); }
    else if (JSONB.has(c)) { setCols.push(c + '=$' + i + '::jsonb'); insPh.push('$' + i + '::jsonb'); args.push(JSON.stringify(obj[c] ?? (c === 'shared_with' ? [] : null))); i++; }
    else { setCols.push(c + '=$' + i); insPh.push('$' + i); args.push(obj[c] === undefined ? null : obj[c]); i++; }
  }
  if (!setCols.length) return;
  await pool().query('insert into oa.strains (' + insCols.join(',') + ',updated_at) values (' + insPh.join(',') + ',now()) on conflict (role) do update set ' + setCols.join(',') + ',updated_at=now()', args);
}
// shared_with array ops (cap 64), dedup.
async function shareAdd(role: string, email: string): Promise<void> {
  await pool().query(
    `update oa.strains set shared_with = (
       select coalesce(jsonb_agg(v), '[]'::jsonb) from (
         select distinct value as v from jsonb_array_elements_text(shared_with || jsonb_build_array($2::text)) limit 64
       ) t), updated_at=now() where role=$1`, [role, email]);
}
async function shareRemove(role: string, email: string): Promise<void> {
  await pool().query(
    `update oa.strains set shared_with = (
       select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements_text(shared_with) where value <> $2
     ), updated_at=now() where role=$1`, [role, email]);
}
async function del(role: string): Promise<void> {
  await pool().query('delete from oa.strains where role=$1', [role]);
}

// ---------------- snapshot-shaped wrappers (so read call sites keep .exists/.data()/.docs) ----------------
function docSnap(role: string, data: any): any {
  return { exists: data != null, id: role, ref: { id: role, path: 'strains/' + role }, data: () => (data == null ? undefined : data) };
}
function qSnap(rows: any[]): any {
  const docs = rows.map((r: any) => ({ id: r.role, ref: { id: r.role }, data: () => r }));
  return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) };
}
async function getSnap(role: string): Promise<any> { return docSnap(role, await get(role)); }
async function querySnapActive(field: string, value: string, limit: number): Promise<any> { return qSnap(await queryActive(field, value, limit)); }
async function scanSnap(limit: number): Promise<any> { return qSnap(await scan(limit)); }

module.exports = { get, list, queryActive, exists, scan, setFull, merge, shareAdd, shareRemove, del, getSnap, querySnapActive, scanSnap, _pool: () => _pool };
