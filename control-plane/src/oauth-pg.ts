// ============================================================================
// oauth-pg.ts  --  NATIVE Postgres backend for the OAuth data layer.
//
// Replaces the Firestore reads/writes behind oaGet/oaSet/oaDel/oaTokGet and the
// rate-limit transactions, for the oauth_* collections ONLY. Real typed tables
// in schema `oa` (see migration). The OAuth business logic in index.ts
// (rotation, retry-grace, reuse detection, bearer validation) is UNCHANGED --
// this module only swaps where the bytes live, and returns objects shaped
// exactly like the Firestore .data() the callers already expect.
//
// Not the pg-fs shim: no generic collection/doc/query/transaction emulation.
// A fixed, small set of typed accessors for a known schema.
// ============================================================================
const { Pool } = require('pg');

let _pool: any = null;
function pool(): any {
  if (!_pool) _pool = new Pool({ connectionString: process.env.PC_PG_URL, max: 6, idleTimeoutMillis: 30000 });
  return _pool;
}

// Which collections this backend owns. Everything else stays on Firestore.
const OA_COLS: Set<string> = new Set([
  'oauth_tokens', 'oauth_refresh', 'oauth_clients', 'oauth_codes',
  'oauth_reg_limits', 'oauth_key_limits',
]);
function owns(col: string): boolean { return OA_COLS.has(String(col)); }

const num = (v: any): number | null => (v === undefined || v === null || v === '') ? null : Number(v);
const b = (v: any): boolean => v === true;
// a Firestore FieldValue.serverTimestamp() sentinel (or any value) in an audit
// timestamp field -> we just stamp now(); these fields are never read by logic.
const hasKey = (o: any, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- reads
async function get(col: string, id: string): Promise<any> {
  try {
    if (col === 'oauth_tokens') {
      const r = await pool().query('select role,email,client_id,exp_ms,refresh_hash,revoked from oa.tokens where token_hash=$1', [id]);
      if (!r.rows.length) return null; const x = r.rows[0];
      return { role: x.role, email: x.email, client_id: x.client_id, exp: num(x.exp_ms), refresh_hash: x.refresh_hash, revoked: b(x.revoked) };
    }
    if (col === 'oauth_refresh') {
      const r = await pool().query('select role,email,client_id,issued_at_ms,exp_ms,access_hash,revoked,revoked_by,rotated_at_ms,rotate_salt,next_hash,rt_chain,prev_hash from oa.refresh where token_hash=$1', [id]);
      if (!r.rows.length) return null; const x = r.rows[0];
      return { role: x.role, email: x.email, client_id: x.client_id, issued_at: num(x.issued_at_ms), exp: num(x.exp_ms), access_hash: x.access_hash, revoked: b(x.revoked), revoked_by: x.revoked_by, rotated_at_ms: num(x.rotated_at_ms), rotate_salt: x.rotate_salt, next_hash: x.next_hash, rt_chain: x.rt_chain, prev_hash: x.prev_hash };
    }
    if (col === 'oauth_clients') {
      const r = await pool().query('select redirect_uris,client_name,token_endpoint_auth_method,created_ms from oa.clients where client_id=$1', [id]);
      if (!r.rows.length) return null; const x = r.rows[0];
      return { client_id: id, redirect_uris: x.redirect_uris || [], client_name: x.client_name, token_endpoint_auth_method: x.token_endpoint_auth_method, created: num(x.created_ms) };
    }
    if (col === 'oauth_codes') {
      const r = await pool().query('select client_id,redirect_uri,code_challenge,email,role,via,exp_ms from oa.codes where code=$1', [id]);
      if (!r.rows.length) return null; const x = r.rows[0];
      return { client_id: x.client_id, redirect_uri: x.redirect_uri, code_challenge: x.code_challenge, email: x.email, role: x.role, via: x.via, exp: num(x.exp_ms) };
    }
    if (col === 'oauth_reg_limits' || col === 'oauth_key_limits') {
      const r = await pool().query('select count,reset_ms from oa.rate_limits where col=$1 and id=$2', [col, id]);
      if (!r.rows.length) return null; const x = r.rows[0];
      return { count: num(x.count), reset: num(x.reset_ms) };
    }
  } catch (e) { /* match oaGet: swallow, return null */ }
  return null;
}

// ---------------------------------------------------------------- writes (full overwrite, like .set(obj))
async function set(col: string, id: string, o: any): Promise<void> {
  try {
    if (col === 'oauth_tokens') {
      await pool().query(
        `insert into oa.tokens (token_hash,role,email,client_id,exp_ms,refresh_hash,revoked,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,now())
         on conflict (token_hash) do update set role=$2,email=$3,client_id=$4,exp_ms=$5,refresh_hash=$6,revoked=$7,updated_at=now()`,
        [id, o.role ?? null, o.email ?? null, o.client_id ?? null, num(o.exp), o.refresh_hash ?? null, b(o.revoked)]);
      return;
    }
    if (col === 'oauth_refresh') {
      const revAt = hasKey(o, 'revoked_at') ? 'now()' : 'null';
      await pool().query(
        `insert into oa.refresh (token_hash,role,email,client_id,issued_at_ms,exp_ms,access_hash,revoked,revoked_at,revoked_by,rotated_at_ms,rotate_salt,next_hash,rt_chain,prev_hash,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,${revAt},$9,$10,$11,$12,$13,$14,now())
         on conflict (token_hash) do update set role=$2,email=$3,client_id=$4,issued_at_ms=$5,exp_ms=$6,access_hash=$7,revoked=$8,revoked_at=${revAt},revoked_by=$9,rotated_at_ms=$10,rotate_salt=$11,next_hash=$12,rt_chain=$13,prev_hash=$14,updated_at=now()`,
        [id, o.role ?? null, o.email ?? null, o.client_id ?? null, num(o.issued_at), num(o.exp), o.access_hash ?? null, b(o.revoked), o.revoked_by ?? null, num(o.rotated_at_ms), o.rotate_salt ?? null, o.next_hash ?? null, o.rt_chain ?? null, o.prev_hash ?? null]);
      return;
    }
    if (col === 'oauth_clients') {
      await pool().query(
        `insert into oa.clients (client_id,redirect_uris,client_name,token_endpoint_auth_method,created_ms)
         values ($1,$2::jsonb,$3,$4,$5)
         on conflict (client_id) do update set redirect_uris=$2::jsonb,client_name=$3,token_endpoint_auth_method=$4,created_ms=$5`,
        [id, JSON.stringify(o.redirect_uris || []), o.client_name ?? null, o.token_endpoint_auth_method ?? 'none', num(o.created)]);
      return;
    }
    if (col === 'oauth_codes') {
      await pool().query(
        `insert into oa.codes (code,client_id,redirect_uri,code_challenge,email,role,via,exp_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (code) do update set client_id=$2,redirect_uri=$3,code_challenge=$4,email=$5,role=$6,via=$7,exp_ms=$8`,
        [id, o.client_id ?? null, o.redirect_uri ?? null, o.code_challenge ?? null, o.email ?? null, o.role ?? null, o.via ?? null, num(o.exp)]);
      return;
    }
    if (col === 'oauth_reg_limits' || col === 'oauth_key_limits') {
      await pool().query(
        `insert into oa.rate_limits (col,id,count,reset_ms,updated_at) values ($1,$2,$3,$4,now())
         on conflict (col,id) do update set count=$3,reset_ms=$4,updated_at=now()`,
        [col, id, num(o.count) ?? 0, num(o.reset)]);
      return;
    }
  } catch (e) { /* match oaSet: swallow */ }
}

async function del(col: string, id: string): Promise<void> {
  try {
    if (col === 'oauth_tokens') { await pool().query('delete from oa.tokens where token_hash=$1', [id]); return; }
    if (col === 'oauth_refresh') { await pool().query('delete from oa.refresh where token_hash=$1', [id]); return; }
    if (col === 'oauth_clients') { await pool().query('delete from oa.clients where client_id=$1', [id]); return; }
    if (col === 'oauth_codes') { await pool().query('delete from oa.codes where code=$1', [id]); return; }
    if (col === 'oauth_reg_limits' || col === 'oauth_key_limits') { await pool().query('delete from oa.rate_limits where col=$1 and id=$2', [col, id]); return; }
  } catch (e) { /* match oaDel: swallow */ }
}

// -------------------------------------------------- oaRetirePrior (equality sweep, both token stores)
// Returns count retired. One UPDATE per store (no pagination; indexed on client_id,email).
async function retirePrior(clientId: string, email: string, keepAtH: string, keepRtH: string): Promise<number> {
  let n = 0;
  const rt = await pool().query(
    `update oa.tokens set revoked=true, updated_at=now()
      where client_id=$1 and email=$2 and token_hash<>$3 and revoked=false`, [clientId, email, keepAtH]);
  n += rt.rowCount || 0;
  const rr = await pool().query(
    `update oa.refresh set revoked=true, revoked_at=now(), revoked_by='reauthorization', updated_at=now()
      where client_id=$1 and email=$2 and token_hash<>$3 and revoked=false`, [clientId, email, keepRtH]);
  n += rr.rowCount || 0;
  return n;
}

// -------------------------------------------------- oaRtRevokeChain (reuse): revoke whole chain + kill its access tokens
async function revokeChain(chain: string, why: string): Promise<number> {
  if (!chain) return 0;
  const c = await pool().connect();
  try {
    await c.query('begin');
    // access tokens minted by any record in the chain die
    const acc = await c.query('select access_hash from oa.refresh where rt_chain=$1 and access_hash is not null', [chain]);
    const r = await c.query(
      `update oa.refresh set revoked=true, revoked_at=now(), revoked_by=$2, updated_at=now()
        where rt_chain=$1 and revoked=false`, [chain, why]);
    const hashes = acc.rows.map((x: any) => x.access_hash).filter(Boolean);
    if (hashes.length) await c.query('delete from oa.tokens where token_hash = any($1::text[])', [hashes]);
    await c.query('commit');
    return r.rowCount || 0;
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; }
  finally { c.release(); }
}

// -------------------------------------------------- native rate limiter (replaces Firestore runTransaction)
// Serialized per-limiter with a transaction advisory lock -> atomic, no row-existence race.
async function rateLimit(col: string, ipHash: string, globalLimit: number, ipLimit: number, windowMs: number): Promise<{ ok: boolean; scope: string }> {
  const now = Date.now();
  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [col]);
    const gq = await c.query('select count,reset_ms from oa.rate_limits where col=$1 and id=$2', [col, 'global']);
    const iq = await c.query('select count,reset_ms from oa.rate_limits where col=$1 and id=$2', [col, 'ip_' + ipHash]);
    const g = gq.rows[0] || null; const i = iq.rows[0] || null;
    const gLive = !!(g && Number(g.reset_ms) > now);
    const iLive = !!(i && Number(i.reset_ms) > now);
    const gCount = gLive ? (Number(g.count) || 0) : 0;
    const iCount = iLive ? (Number(i.count) || 0) : 0;
    const gReset = gLive ? Number(g.reset_ms) : now + windowMs;
    const iReset = iLive ? Number(i.reset_ms) : now + windowMs;
    if (gCount >= globalLimit) { await c.query('rollback'); return { ok: false, scope: 'global' }; }
    if (iCount >= ipLimit) { await c.query('rollback'); return { ok: false, scope: 'ip' }; }
    await c.query(`insert into oa.rate_limits (col,id,count,reset_ms,updated_at) values ($1,$2,$3,$4,now())
                   on conflict (col,id) do update set count=$3,reset_ms=$4,updated_at=now()`, [col, 'global', gCount + 1, gReset]);
    await c.query(`insert into oa.rate_limits (col,id,count,reset_ms,updated_at) values ($1,$2,$3,$4,now())
                   on conflict (col,id) do update set count=$3,reset_ms=$4,updated_at=now()`, [col, 'ip_' + ipHash, iCount + 1, iReset]);
    await c.query('commit');
    return { ok: true, scope: '' };
  } catch (e) { try { await c.query('rollback'); } catch (_) {} throw e; }
  finally { c.release(); }
}

module.exports = { owns, get, set, del, retirePrior, revokeChain, rateLimit, _pool: () => _pool };
