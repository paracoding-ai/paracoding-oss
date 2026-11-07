// @ts-nocheck
// [PG-FS-SHIM-V1] Firestore-admin-compatible facade over Postgres JSONB (table fs_docs).
// Reproduces ONLY the surface index.ts uses: collection/doc/add, get/set(merge)/update/delete/create,
// where(==,>=,in)/orderBy/limit/startAfter, collectionGroup, count, batch, runTransaction, subcollections,
// FieldValue(serverTimestamp/increment/arrayUnion/arrayRemove/delete), Timestamp read-back (toMillis/_seconds).
const { Pool } = require('pg');

class Timestamp {
  constructor(ms){ this._ms=ms; this.seconds=Math.floor(ms/1000); this._seconds=this.seconds; this.nanoseconds=(ms%1000)*1e6; }
  toMillis(){ return this._ms; } toDate(){ return new Date(this._ms); } toISOString(){ return new Date(this._ms).toISOString(); }
  valueOf(){ return this._ms; }
}
Timestamp.now = ()=> new Timestamp(Date.now());
Timestamp.fromMillis = (ms)=> new Timestamp(ms);

class FV { constructor(op,val){ this.__fv=op; this.val=val; } }
const FieldValue = {
  serverTimestamp: ()=> new FV('ts'),
  increment: (n)=> new FV('inc', Number(n)||0),
  arrayUnion: (...a)=> new FV('au', a),
  arrayRemove: (...a)=> new FV('ar', a),
  delete: ()=> new FV('del'),
};
const DELETE = Symbol('del');

function isPlain(o){ return o && typeof o==='object' && !Array.isArray(o) && !(o instanceof FV) && !(o instanceof Date) && !(o instanceof Timestamp); }

// ---- encode JS value -> JSON-storable (Date/Timestamp -> {__ts__:ms}); resolve FieldValue against prev ----
function encode(v){
  if (v instanceof Date) return { __ts__: v.getTime() };
  if (v instanceof Timestamp) return { __ts__: v._ms };
  if (Array.isArray(v)) return v.map(encode);
  if (isPlain(v)){ const o={}; for (const k of Object.keys(v)) o[k]=encode(v[k]); return o; }
  return v;
}
function decode(v){
  if (v && typeof v==='object' && !Array.isArray(v) && typeof v.__ts__==='number') return new Timestamp(v.__ts__);
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v==='object'){ const o={}; for (const k of Object.keys(v)) o[k]=decode(v[k]); return o; }
  return v;
}
function arrEq(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
// apply a write object (which may contain FV + nested) onto prev (encoded form); merge=deep merge, else replace at this level
function applyWrite(prev, incoming, merge){
  const base = merge && isPlain(prev) ? Object.assign({}, prev) : {};
  for (const k of Object.keys(incoming)){
    const nv = incoming[k];
    if (nv instanceof FV){
      if (nv.__fv==='ts') base[k]={ __ts__: Date.now() };
      else if (nv.__fv==='inc') base[k]=(typeof base[k]==='number'?base[k]:0)+nv.val;
      else if (nv.__fv==='del') delete base[k];
      else if (nv.__fv==='au'){ const cur=Array.isArray(base[k])?base[k].slice():[]; for (const e of nv.val.map(encode)) if (!cur.some(x=>arrEq(x,e))) cur.push(e); base[k]=cur; }
      else if (nv.__fv==='ar'){ const cur=Array.isArray(base[k])?base[k].slice():[]; base[k]=cur.filter(x=>!nv.val.map(encode).some(e=>arrEq(x,e))); }
    } else if (isPlain(nv) && merge && isPlain(base[k])){
      base[k]=applyWrite(base[k], nv, true);
    } else {
      base[k]=encode(nv);
    }
  }
  return base;
}
function jp(f){ return String(f).replace(/'/g,"''"); }
function numExpr(f){ const g=jp(f); return "(CASE WHEN data#>>'{"+g+",__ts__}' IS NOT NULL THEN (data#>>'{"+g+",__ts__}')::numeric WHEN (data->>'"+g+"') ~ '^-?[0-9.]+$' THEN (data->>'"+g+"')::numeric ELSE NULL END)"; }
function autoId(){ const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let s=''; for(let i=0;i<20;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; }
const TTL_FIELDS = (process.env.PC_TTL_FIELDS||'expireAt,expire_at,expireAtMs').split(',');
function ttlFrom(data){ for (const f of TTL_FIELDS){ const v=data[f]; if (v && typeof v.__ts__==='number') return new Date(v.__ts__); if (typeof v==='number' && v>1e12) return new Date(v); } return null; }

class DocSnap{
  constructor(ref, raw){ this.ref=ref; this.id=ref.id; this._raw=raw; this.exists=raw!=null; }
  data(){ return this._raw==null?undefined:decode(this._raw); }
  get(field){ const d=this.data(); return d?d[field]:undefined; }
}
class QuerySnap{
  constructor(docs){ this.docs=docs; this.empty=docs.length===0; this.size=docs.length; }
  forEach(fn){ this.docs.forEach(fn); }
}

class Query{
  constructor(db, coll, group){ this.db=db; this.coll=coll; this.group=!!group; this._w=[]; this._order=null; this._limit=null; this._after=null; }
  where(f,op,v){ const q=this._clone(); q._w.push([f,op,v]); return q; }
  orderBy(f,dir){ const q=this._clone(); q._order=[f,(dir||'asc').toLowerCase()]; return q; }
  limit(n){ const q=this._clone(); q._limit=n; return q; }
  startAfter(snapOrVal){ const q=this._clone(); q._after=snapOrVal; return q; }
  count(){ const self=this; return { get: async()=>{ const {sql,params}=self._build(true); const r=await self.db._q(sql,params); return { data:()=>({count:Number(r.rows[0].n)}) }; } }; }
  _clone(){ const q=new Query(this.db,this.coll,this.group); q._w=this._w.slice(); q._order=this._order; q._limit=this._limit; q._after=this._after; return q; }
  _build(count){
    const params=[]; const cond=[];
    if (this.group){ params.push(this.coll); cond.push("(path ~ ('(^|/)'||$"+params.length+"||'/[^/]+$'))"); }
    else { params.push(this.coll+'/%'); cond.push('path LIKE $'+params.length); params.push(this.coll+'/%/%'); cond.push('path NOT LIKE $'+params.length); }
    for (const [f,op,v] of this._w){
      if (op==='=='){ params.push(JSON.stringify(encode(v))); cond.push("data->'"+f.replace(/'/g,"''")+"' = $"+params.length+"::jsonb"); }
      else if (op==='>='){ if (v instanceof Timestamp||typeof v==='number'){ params.push(v instanceof Timestamp?v._ms:v); cond.push(numExpr(f)+' >= $'+params.length); } else { params.push(String(v)); cond.push("(data->>'"+jp(f)+"') >= $"+params.length); } }
      else if (op==='in'){ const arr=(v||[]); const ph=arr.map(x=>{params.push(JSON.stringify(encode(x))); return '$'+params.length+'::jsonb';}); cond.push("data->'"+f.replace(/'/g,"''")+"' IN ("+(ph.join(',')||'NULL')+")"); }
      else throw new Error('pg_fs: unsupported where op '+op);
    }
    if (this._after!=null && this._order){ const f=this._order[0]; let cv=this._after; if (cv && cv._raw!==undefined) cv=decode(cv._raw)[f]; const gt=this._order[1]==='desc'?'<':'>'; if (cv instanceof Timestamp||typeof cv==='number'){ params.push(cv instanceof Timestamp?cv._ms:cv); cond.push(numExpr(f)+' '+gt+' $'+params.length); } else { params.push(String(cv)); cond.push("(data->>'"+jp(f)+"') "+gt+" $"+params.length); } }
    let sql='SELECT '+(count?'count(*) n':'path,data')+' FROM fs_docs WHERE '+cond.join(' AND ');
    if (!count && this._order) sql+=' ORDER BY '+numExpr(this._order[0])+' '+(this._order[1]==='desc'?'DESC':'ASC')+" NULLS LAST, data->>'"+jp(this._order[0])+"' "+(this._order[1]==='desc'?'DESC':'ASC');
    if (!count && this._limit!=null) sql+=' LIMIT '+Number(this._limit);
    return {sql,params};
  }
  async get(){ const {sql,params}=this._build(false); const r=await this.db._q(sql,params); return new QuerySnap(r.rows.map(row=> new DocSnap(new DocRef(this.db,row.path), row.data))); }
}

class CollRef extends Query{
  constructor(db, path){ super(db, path, false); this.path=path; this.id=path.split('/').pop(); }
  doc(id){ return new DocRef(this.db, this.path+'/'+(id||autoId())); }
  async add(data){ const ref=this.doc(); await ref.set(data); return ref; }
}
class DocRef{
  constructor(db, path){ this.db=db; this.path=path; this.id=path.split('/').pop(); }
  collection(name){ return new CollRef(this.db, this.path+'/'+name); }
  async get(client){ const q=client||this.db; const r=await q._q('SELECT data FROM fs_docs WHERE path=$1',[this.path]); return new DocSnap(this, r.rows.length?r.rows[0].data:null); }
  async _write(data, merge, client, mustExist){
    const run=async(c)=>{
      const pr=await c.query('SELECT data FROM fs_docs WHERE path=$1 FOR UPDATE',[this.path]);
      if (mustExist && !pr.rows.length) throw new Error('pg_fs update: no document to update: '+this.path);
      const prev=pr.rows.length?pr.rows[0].data:null;
      const next=applyWrite(prev, data, merge);
      const exp=ttlFrom(next);
      await c.query('INSERT INTO fs_docs(path,data,expires_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(path) DO UPDATE SET data=EXCLUDED.data, expires_at=EXCLUDED.expires_at, updated_at=now()',[this.path,JSON.stringify(next),exp]);
    };
    if (client) return run(client._pg||client.__c); // within tx
    const c=await this.db.pool.connect(); try{ await c.query('BEGIN'); await run(c); await c.query('COMMIT'); } catch(e){ await c.query('ROLLBACK'); throw e; } finally{ c.release(); }
  }
  set(data,opts){ return this._write(data, !!(opts&&opts.merge), null, false); }
  create(data){ return this._write(data, false, null, false); }
  update(data){ return this._write(data, true, null, true); }
  async delete(){ await this.db._q('DELETE FROM fs_docs WHERE path=$1',[this.path]); }
}

class Txn{
  constructor(c){ this.__c=c; this._w=[]; }
  async get(ref){ const r=await this.__c.query('SELECT data FROM fs_docs WHERE path=$1 FOR UPDATE',[ref.path]); return new DocSnap(ref, r.rows.length?r.rows[0].data:null); }
  set(ref,data,opts){ this._w.push(['set',ref,data,!!(opts&&opts.merge),false]); return this; }
  create(ref,data){ this._w.push(['set',ref,data,false,false]); return this; }
  update(ref,data){ this._w.push(['update',ref,data,true,true]); return this; }
  delete(ref){ this._w.push(['delete',ref]); return this; }
  async _apply(){ for (const w of this._w){ if (w[0]==='delete') await this.__c.query('DELETE FROM fs_docs WHERE path=$1',[w[1].path]); else await w[1]._write(w[2], w[3], this, w[4]); } }
}
class Batch{
  constructor(db){ this.db=db; this.ops=[]; }
  set(ref,data,opts){ this.ops.push(['set',ref,data,opts]); return this; }
  create(ref,data){ this.ops.push(['create',ref,data]); return this; }
  update(ref,data){ this.ops.push(['update',ref,data]); return this; }
  delete(ref){ this.ops.push(['delete',ref]); return this; }
  async commit(){ const c=await this.db.pool.connect(); const t=new Txn(c); try{ await c.query('BEGIN'); for (const o of this.ops){ if(o[0]==='delete') t.delete(o[1]); else t[o[0]](o[1],o[2],o[3]); } await t._apply(); await c.query('COMMIT'); } catch(e){ await c.query('ROLLBACK'); throw e; } finally{ c.release(); } }
}

class DB{
  constructor(opts){ this.pool=new Pool(typeof opts==='string'?{connectionString:opts}:opts); }
  async _q(sql,params){ return this.pool.query(sql,params); }
  collection(name){ return new CollRef(this, name); }
  doc(path){ return new DocRef(this, path); }
  collectionGroup(name){ return new Query(this, name, true); }
  batch(){ return new Batch(this); }
  async runTransaction(fn){
    for (let attempt=0; attempt<5; attempt++){
      const c=await this.pool.connect(); const t=new Txn(c);
      try{ await c.query('BEGIN'); const res=await fn(t); await t._apply(); await c.query('COMMIT'); c.release(); return res; }
      catch(e){ await c.query('ROLLBACK'); c.release(); if (attempt<4 && /serializ|deadlock|could not/i.test(String(e.message))) continue; throw e; }
    }
  }
  async sweepExpired(){ const r=await this._q('DELETE FROM fs_docs WHERE expires_at IS NOT NULL AND expires_at<=now()'); return r.rowCount; }
  async end(){ await this.pool.end(); }
}
module.exports={ DB, FieldValue, Timestamp };
