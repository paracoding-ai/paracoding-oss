// ============================================================================
// memory-pg.ts  --  NATIVE Postgres store for the memory graph.
// oa.mem_entities, oa.mem_observations (flattened subcollection, entity_id FK),
// oa.mem_relations. Pure native; snapshot-shaped reads keep handler consumption
// unchanged. Transactions/batches become real pg transactions.
// ============================================================================
const { Pool } = require('pg');
const crypto = require('crypto');
let _pool: any = null;
function pool(): any { if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6, idleTimeoutMillis: 30000 }); return _pool; }
function newId(): string { return crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, '').slice(0, 20); }
function tsLike(d: any): any { if (d == null) return undefined; const ms = +new Date(d); const s = Math.floor(ms / 1000); return { _seconds: s, _nanoseconds: 0, seconds: s, toMillis: () => ms, toDate: () => new Date(ms) }; }
function jb(v: any): any { return (v === undefined || v === null) ? null : JSON.stringify(v); }

function entData(x: any): any {
  const o: any = { scope: x.scope, name: x.name, entityType: x.entity_type, aliases: x.aliases || [], createdBy: x.created_by, obsActive: Number(x.obs_active || 0), status: x.status };
  if (x.created_at != null) o.createdAt = tsLike(x.created_at);
  if (x.updated_at != null) o.updatedAt = tsLike(x.updated_at);
  if (x.search_text != null) o.searchText = x.search_text;
  if (x.embedding != null) o.embedding = x.embedding;
  return o;
}
function obsData(x: any): any {
  const o: any = { text: x.text, confidence: x.confidence, author: x.author, status: x.status };
  if (x.evidence != null) o.evidence = x.evidence;
  if (x.session != null) o.session = x.session;
  if (x.created_at != null) o.createdAt = tsLike(x.created_at);
  if (x.supersedes != null) o.supersedes = x.supersedes;
  if (x.superseded_by != null) o.supersededBy = x.superseded_by;
  if (x.embedding != null) o.embedding = x.embedding;
  return o;
}
function relData(x: any): any {
  const o: any = { scope: x.scope, from: x.from_name, to: x.to_name, relationType: x.relation_type, createdBy: x.created_by, status: x.status };
  if (x.created_at != null) o.createdAt = tsLike(x.created_at);
  return o;
}
function docOf(x: any, dataFn: any): any { return { id: x.id, _id: x.id, ref: { id: x.id }, exists: true, data: () => dataFn(x) }; }
function qSnap(rows: any[], dataFn: any): any { const docs = rows.map((r: any) => docOf(r, dataFn)); return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn: any) => docs.forEach(fn) }; }

// -------- entities --------
async function entGet(eid: string): Promise<any> {
  const r = await pool().query('select * from oa.mem_entities where id=$1', [eid]);
  if (!r.rows.length) return { exists: false, id: eid, data: () => undefined };
  return docOf(r.rows[0], entData);
}
async function entSet(eid: string, o: any): Promise<void> {
  const ca = (o && 'createdAt' in o) ? 'now()' : 'null';
  const ua = (o && 'updatedAt' in o) ? 'now()' : 'null';
  await pool().query(
    `insert into oa.mem_entities (id,scope,name,entity_type,aliases,created_by,created_at,updated_at,obs_active,status,search_text,embedding)
     values ($1,$2,$3,$4,$5::jsonb,$6, ${ca}, ${ua}, $7,$8,$9,$10::jsonb)
     on conflict (id) do update set scope=$2,name=$3,entity_type=$4,aliases=$5::jsonb,created_by=$6,obs_active=$7,status=$8,search_text=$9,embedding=$10::jsonb`,
    [eid, o.scope ?? null, o.name ?? null, o.entityType ?? null, jb(o.aliases || []), o.createdBy ?? null, Number(o.obsActive || 0), o.status ?? null, o.searchText ?? null, jb(o.embedding)]);
}
// merge update (reindex / counters). keys present only. serverTimestamp fields -> now().
async function entUpdate(eid: string, o: any): Promise<void> {
  const sets: string[] = []; const args: any[] = []; let i = 1;
  const map: any = { entityType: 'entity_type', createdBy: 'created_by', obsActive: 'obs_active', searchText: 'search_text', embedding: 'embedding', status: 'status', aliases: 'aliases', scope: 'scope', name: 'name' };
  for (const k of Object.keys(o)) {
    if (k === 'updatedAt' || k === 'createdAt') { sets.push((k === 'updatedAt' ? 'updated_at' : 'created_at') + '=now()'); continue; }
    const col = map[k]; if (!col) continue;
    if (col === 'embedding' || col === 'aliases') { sets.push(col + '=$' + i + '::jsonb'); args.push(jb(o[k])); }
    else { sets.push(col + '=$' + i); args.push(o[k] === undefined ? null : o[k]); }
    i++;
  }
  if (!sets.length) return;
  args.push(eid);
  await pool().query('update oa.mem_entities set ' + sets.join(',') + ' where id=$' + i, args);
}
async function entQueryScope(scope: string, entityType: string | null, limit: number): Promise<any> {
  if (entityType) { const r = await pool().query('select * from oa.mem_entities where scope=$1 and entity_type=$2 limit ' + Number(limit), [scope, entityType]); return qSnap(r.rows, entData); }
  const r = await pool().query('select * from oa.mem_entities where scope=$1 limit ' + Number(limit), [scope]); return qSnap(r.rows, entData);
}

// -------- observations --------
async function obsActive(eid: string, limit: number): Promise<any> {
  const r = await pool().query("select * from oa.mem_observations where entity_id=$1 and status='active' order by created_at desc limit " + Number(limit), [eid]);
  return qSnap(r.rows, obsData);
}
async function obsAll(eid: string, limit: number): Promise<any> {
  const r = await pool().query('select * from oa.mem_observations where entity_id=$1 order by created_at desc limit ' + Number(limit), [eid]);
  return qSnap(r.rows, obsData);
}
async function obsExistsAnywhere(obsId: string): Promise<boolean> {
  const r = await pool().query('select 1 from oa.mem_observations where id=$1 limit 1', [obsId]);
  return r.rows.length > 0;
}
// add observation (transaction): insert; if supersedesId -> mark it superseded; else bump obs_active.
async function obsAddTx(eid: string, o: any, supersedesId: string | null): Promise<{ id: string }> {
  const id = newId();
  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query(
      `insert into oa.mem_observations (id,entity_id,text,confidence,evidence,author,session,created_at,status,supersedes,superseded_by,embedding)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7, now(), $8,$9,$10,$11::jsonb)`,
      [id, eid, o.text ?? null, o.confidence ?? null, jb(o.evidence), o.author ?? null, o.session ?? null, o.status ?? 'active', supersedesId ?? null, o.supersededBy ?? null, jb(o.embedding)]);
    if (supersedesId) { await c.query("update oa.mem_observations set status='superseded', superseded_by=$1 where id=$2", [id, supersedesId]); }
    else { await c.query('update oa.mem_entities set obs_active = obs_active + 1 where id=$1', [eid]); }
    await c.query('commit');
    return { id };
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; }
  finally { c.release(); }
}
// delete_entities: retract entity + its active obs.
async function entRetract(eid: string): Promise<void> {
  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query("update oa.mem_observations set status='retracted' where entity_id=$1 and status='active'", [eid]);
    await c.query("update oa.mem_entities set status='retracted', obs_active=0, updated_at=now() where id=$1", [eid]);
    await c.query('commit');
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; } finally { c.release(); }
}
// delete_observations: retract matching (by id OR exact text), decrement obs_active.
async function obsRetractMatching(eid: string, tokens: string[]): Promise<number> {
  const c = await pool().connect();
  try {
    await c.query('begin');
    const r = await c.query("update oa.mem_observations set status='retracted' where entity_id=$1 and status='active' and (id = any($2::text[]) or text = any($2::text[]))", [eid, tokens]);
    const n = r.rowCount || 0;
    if (n) await c.query('update oa.mem_entities set obs_active = greatest(0, obs_active - $2), updated_at=now() where id=$1', [eid, n]);
    await c.query('commit');
    return n;
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; } finally { c.release(); }
}

// -------- relations --------
async function relGet(id: string): Promise<any> {
  const r = await pool().query('select * from oa.mem_relations where id=$1', [id]);
  if (!r.rows.length) return { exists: false, id, data: () => undefined };
  return docOf(r.rows[0], relData);
}
async function relSet(id: string, o: any): Promise<void> {
  const ca = (o && 'createdAt' in o) ? 'now()' : 'null';
  await pool().query(
    `insert into oa.mem_relations (id,scope,from_name,to_name,relation_type,created_by,created_at,status)
     values ($1,$2,$3,$4,$5,$6, ${ca}, $7)
     on conflict (id) do update set scope=$2,from_name=$3,to_name=$4,relation_type=$5,created_by=$6,status=$7`,
    [id, o.scope ?? null, o.from ?? null, o.to ?? null, o.relationType ?? null, o.createdBy ?? null, o.status ?? null]);
}
async function relUpdate(id: string, o: any): Promise<void> {
  if (o && o.status) await pool().query('update oa.mem_relations set status=$1 where id=$2', [o.status, id]);
}
async function relByScope(scope: string, limit: number): Promise<any> { const r = await pool().query('select * from oa.mem_relations where scope=$1 limit ' + Number(limit), [scope]); return qSnap(r.rows, relData); }
async function relByFrom(scope: string, from: string, limit: number): Promise<any> { const r = await pool().query('select * from oa.mem_relations where scope=$1 and from_name=$2 limit ' + Number(limit), [scope, from]); return qSnap(r.rows, relData); }
async function relByTo(scope: string, to: string, limit: number): Promise<any> { const r = await pool().query('select * from oa.mem_relations where scope=$1 and to_name=$2 limit ' + Number(limit), [scope, to]); return qSnap(r.rows, relData); }

// ---- firestore-shaped adapters over native ops (memory-graph ONLY; bounded to the exact chains used) ----
function entRefA(eid: string): any {
  return { id: eid, get: () => entGet(eid), set: (o: any) => entSet(eid, o), update: (o: any) => entUpdate(eid, o), collection: (_n: string) => obsCollA(eid) };
}
function obsQueryA(eid: string, active: boolean, lim: number | null): any {
  return {
    where: (f: string, _op: string, v: any) => obsQueryA(eid, active || (f === 'status' && v === 'active'), lim),
    orderBy: () => obsQueryA(eid, active, lim),
    limit: (n: number) => obsQueryA(eid, active, n),
    get: () => active ? obsActive(eid, lim || 1000) : obsAll(eid, lim || 1000),
  };
}
function obsCollA(eid: string): any {
  return {
    doc: (id?: string) => ({ id: id || newId() }),
    where: (f: string, _op: string, v: any) => obsQueryA(eid, f === 'status' && v === 'active', null),
    orderBy: () => obsQueryA(eid, false, null),
    limit: (n: number) => obsQueryA(eid, false, n),
    get: () => obsAll(eid, 1000),
  };
}
function entQueryA(flt: any): any {
  return {
    where: (f: string, _op: string, v: any) => entQueryA(Object.assign({}, flt, { [f]: v })),
    limit: (n: number) => entQueryA(Object.assign({}, flt, { _lim: n })),
    get: async () => { const snap = await entQueryScope(flt.scope, flt.entityType || null, flt._lim || 100); snap.docs.forEach((d: any) => { d.ref = entRefA(d.id); }); return snap; },
  };
}
function entCol(): any { return { doc: (id: string) => entRefA(id), where: (f: string, _op: string, v: any) => entQueryA({ [f]: v }) }; }
function relRefA(id: string): any { return { id, get: () => relGet(id), set: (o: any) => relSet(id, o), update: (o: any) => relUpdate(id, o) }; }
function relQueryA(flt: any): any {
  return {
    where: (f: string, _op: string, v: any) => relQueryA(Object.assign({}, flt, { [f]: v })),
    limit: (n: number) => relQueryA(Object.assign({}, flt, { _lim: n })),
    get: () => flt.from ? relByFrom(flt.scope, flt.from, flt._lim || 50) : (flt.to ? relByTo(flt.scope, flt.to, flt._lim || 50) : relByScope(flt.scope, flt._lim || 100)),
  };
}
function relCol(): any { return { doc: (id: string) => relRefA(id), where: (f: string, _op: string, v: any) => relQueryA({ [f]: v }) }; }

module.exports = { entGet, entSet, entUpdate, entQueryScope, obsActive, obsAll, obsExistsAnywhere, obsAddTx, entRetract, obsRetractMatching, relGet, relSet, relUpdate, relByScope, relByFrom, relByTo, entCol, relCol, _pool: () => _pool };
