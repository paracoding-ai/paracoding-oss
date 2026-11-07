// SPDX-License-Identifier: Apache-2.0
// [LAKE-VAULT-MOD-V1] Signed, session-bound read helpers for the /lakeview viewer, extracted
// VERBATIM from index.ts (strangler refactor). These are the PURE pieces of the viewer: path
// scoping, the session fingerprint, the lakeview-domain HMAC, token mint/verify, and the
// Buffer-returning decrypt. The two cloud-touching readers (lvReadSealed, lvServe) and the
// master-key machinery (vaultMasterForEpoch) stay in index.ts, which imports these back.
// This module imports only ../shared.js and sibling mods -- NEVER ../index.js.
import express from 'express';
import * as crypto from 'crypto';
import { waB64, waEq, WA_SESSION_SECRET, WA_SESSION_SECRET_OK, LV_TTL_SEC } from '../shared.js';
import { waCookie } from './wa-http.js';
import { vaultObjKey, vaultIsCleartext } from './vault-crypto.js';
import { lvHasControlChar } from './content-serve.js';
const vCrypto = require('crypto');

// The viewable set. Deliberately enumerated, deliberately short, and deliberately NOT 'shared/'.
const LV_ALLOW: string[] = ['shared/state/', 'shared/handoff/', 'shared/wiki/', 'shared/oss-release/', 'shared/fleet/', 'shared/bootstrap/', 'agents/'];
const LV_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
// A charCodeAt scan, NOT a regex range: a control-byte class written with backslash-u escapes does
// not survive both git transport channels intact, and a scope check that arrives mangled is a scope
// check that silently does not run.
// Returns '' when the path may be viewed, or the REASON it may not. Never a bare boolean: the
// operator is the only caller, and a refusal he cannot read costs him a round trip to an agent.
export function lvPathOk(p: string): string {
  const path = String(p || '');
  if (path === '' || path.length > 512) return 'path is empty or longer than 512 characters';
  if (lvHasControlChar(path)) return 'path carries a backslash or a control character';
  if (path.charAt(0) === '/') return 'path must be relative to the bucket root';
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (!LV_SEG_RE.test(segs[i])) return 'segment ' + JSON.stringify(segs[i].slice(0, 40)) + ' is not a plain name';
  }
  if (!LV_ALLOW.some((px) => path.indexOf(px) === 0)) return 'path is outside every viewable prefix (' + LV_ALLOW.join(' ') + ')';
  if (vaultIsCleartext(path)) return 'path is a CLEARTEXT-at-rest prefix and is never viewable here';
  return '';
}
// Binds a token to ONE gate session. Derived from the session cookie's payload, so a re-minted
// session (logout, expiry, re-mint) silently kills every outstanding link. Hashed rather
// than stored, so the token itself never carries session material.
export function lvSessionFp(req: express.Request): string {
  const c = waCookie(req, 'gate_session') || '';
  const payload = c.indexOf('.') > 0 ? c.split('.')[0] : '';
  if (!payload) return '';
  return crypto.createHash('sha256').update('lakeview-fp:' + payload, 'utf8').digest('hex').slice(0, 32);
}
// Domain-separated from the session and elevation HMACs by the 'lakeview:' prefix, exactly as
// waMakeElevated separates itself with 'elev:'. Fails CLOSED on a missing or weak secret: an
// empty-key HMAC is forgeable, and a forgeable view link is an unauthenticated lake read.
export function lvSign(payload: string): string {
  if (!WA_SESSION_SECRET_OK) throw new Error('WA_SESSION_SECRET missing or too weak - refusing to issue a view link.');
  return crypto.createHmac('sha256', WA_SESSION_SECRET).update('lakeview:' + payload).digest('base64url');
}
export function lvMint(path: string, fp: string): { token: string; exp: number } {
  const exp = Date.now() + LV_TTL_SEC * 1000;
  const payload = waB64(Buffer.from(JSON.stringify({ p: path, exp: exp, s: fp })));
  return { token: payload + '.' + lvSign(payload), exp: exp };
}
export function lvVerify(tok: string, fp: string): { path: string } | null {
  const t = String(tok || '');
  const i = t.indexOf('.');
  if (i <= 0) return null;
  const payload = t.slice(0, i);
  const sig = t.slice(i + 1);
  if (!WA_SESSION_SECRET_OK) return null;
  let expect = '';
  try { expect = lvSign(payload); } catch (e) { return null; }
  if (!waEq(sig, expect)) return null;
  let j: any = null;
  try { j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!j || typeof j.p !== 'string' || typeof j.s !== 'string') return null;
  if (!(Number(j.exp) > Date.now())) return null;
  if (!fp || !waEq(j.s, fp)) return null;
  return { path: j.p };
}
// Buffer-returning twin of vaultDecryptSync. It exists because vaultDecryptSync ends in
// .toString('utf8'), which substitutes U+FFFD for every byte sequence that is not valid UTF-8 --
// a PNG served through it downloads cleanly and is silently corrupt. Same header layout, same AAD,
// same per-object key derivation; the ONLY difference is that the plaintext is not stringified.
export function lvDecryptBuf(master: Buffer, path: string, blob: Buffer): Buffer {
  const epoch = blob[4];
  const nonce = blob.slice(6, 18);
  const rest = blob.slice(18);
  const tag = rest.slice(rest.length - 16);
  const ct = rest.slice(0, rest.length - 16);
  const aad = Buffer.concat([blob.slice(0, 4), Buffer.from([epoch]), Buffer.from([0x00]), Buffer.from(path, 'utf8')]);
  const d = vCrypto.createDecipheriv('aes-256-gcm', vaultObjKey(master, path, epoch), nonce);
  d.setAAD(aad); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
