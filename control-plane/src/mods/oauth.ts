// SPDX-License-Identifier: Apache-2.0
// [OAUTH-MOD-V1] OAuth 2.1 helper functions extracted from index.ts (strangler modularization).
// Imports ONLY from ../shared.js and sibling mods -- NEVER from ../index.js. The OAuth ROUTE
// definitions (app.get/app.post('/oauth/...'), /.well-known/...) STAY in index.ts and import
// these helpers back.
import { oaTokHash, oaPubBase, OAUTH_ALLOW, OA_REG_WINDOW_MS } from '../shared.js';
import { db, FieldValue } from './store.js';
const oaCrypto = require('crypto');
// Re-derived here: same env read + same require() singleton index.ts holds (Node caches require
// by resolved path), used only by the OAuth store/limiter helpers below.
const _OAN = ['pg','native','1','true','on'].includes(String(process.env.PC_OAUTH_STORE || '').toLowerCase());
const _oapg: any = require('../oauth-pg');

export function oaB64url(buf: any): string { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function oaRand(n?: number): string { return oaB64url(oaCrypto.randomBytes(n || 32)); }
const OA_ALLOW_DOC = 'config/oauth_allow';
let oaAllowCache: { at: number; list: string[] } | null = null;
const OA_ALLOW_TTL_MS = 15000;
export function oaNormEmail(s: any): string { return String(s || '').trim().toLowerCase(); }
export async function oaAllowList(): Promise<string[]> {
  const now = Date.now();
  if (oaAllowCache && (now - oaAllowCache.at) < OA_ALLOW_TTL_MS) return oaAllowCache.list;
  let extra: string[] = [];
  try {
    const parts = OA_ALLOW_DOC.split('/');
    const snap = await db.collection(parts[0]).doc(parts[1]).get();
    const d: any = (snap && snap.exists && snap.data()) || null;
    if (d && Array.isArray(d.emails)) extra = d.emails.map(oaNormEmail).filter(Boolean);
  } catch (e) {
    // Read failed. Fall through to the env floor rather than refusing everyone.
    console.error('[oauth-allow] Firestore read failed; using WA_APPROVER_EMAILS only');
  }
  const merged: string[] = [];
  for (const e of OAUTH_ALLOW.concat(extra)) { if (e && merged.indexOf(e) < 0) merged.push(e); }
  oaAllowCache = { at: now, list: merged };
  return merged;
}
export async function oaAllowed(email: string): Promise<boolean> {
  const em = oaNormEmail(email);
  if (!em) return false;
  const list = await oaAllowList();
  return list.length > 0 && list.indexOf(em) >= 0;   // empty list allows nobody: fail closed
}
export async function oaAllowWrite(emails: string[]): Promise<void> {
  const parts = OA_ALLOW_DOC.split('/');
  const clean: string[] = [];
  for (const e of emails.map(oaNormEmail)) { if (e && clean.indexOf(e) < 0) clean.push(e); }
  await db.collection(parts[0]).doc(parts[1]).set({ emails: clean, updated_at: FieldValue.serverTimestamp() }, { merge: true });
  oaAllowCache = null;   // the next read must see the write, not a 15-second-old copy
}
const OA_REG_IP_LIMIT = Number(process.env.OAUTH_REG_IP_LIMIT || 5);
const OA_REG_GLOBAL_LIMIT = Number(process.env.OAUTH_REG_GLOBAL_LIMIT || 100);
const OA_REG_LIMIT_COL = 'oauth_reg_limits';
const OA_REG_PER_IP_PER_HOUR = parseInt(process.env.OAUTH_REG_PER_IP_PER_HOUR || '20', 10);
const OA_REG_MAX_FIELD = parseInt(process.env.OAUTH_REG_MAX_FIELD || '2048', 10);
const oaRegHits: any = new Map();
// Returns { ok: true } and CONSUMES one unit of both budgets, or { ok: false, scope } and consumes
// nothing. THROWS if Firestore is unreachable -- the caller must treat that as a refusal.
export async function oaRegRateLimit(ip: string): Promise<{ ok: boolean; scope: string }> {
  if (_OAN) return await _oapg.rateLimit(OA_REG_LIMIT_COL, oaTokHash(ip), OA_REG_GLOBAL_LIMIT, OA_REG_IP_LIMIT, OA_REG_WINDOW_MS);
  const now = Date.now();
  const gRef = db.collection(OA_REG_LIMIT_COL).doc('global');
  const ipRef = db.collection(OA_REG_LIMIT_COL).doc('ip_' + oaTokHash(ip));
  return await db.runTransaction(async (tx: any): Promise<{ ok: boolean; scope: string }> => {
    const gSnap = await tx.get(gRef);
    const ipSnap = await tx.get(ipRef);
    const g: any = (gSnap && gSnap.exists && gSnap.data()) || null;
    const i: any = (ipSnap && ipSnap.exists && ipSnap.data()) || null;
    const gLive = !!(g && Number(g.reset) > now);
    const iLive = !!(i && Number(i.reset) > now);
    const gCount = gLive ? (Number(g.count) || 0) : 0;
    const iCount = iLive ? (Number(i.count) || 0) : 0;
    const gReset = gLive ? Number(g.reset) : now + OA_REG_WINDOW_MS;
    const iReset = iLive ? Number(i.reset) : now + OA_REG_WINDOW_MS;
    if (gCount >= OA_REG_GLOBAL_LIMIT) return { ok: false, scope: 'global' };
    if (iCount >= OA_REG_IP_LIMIT) return { ok: false, scope: 'ip' };
    tx.set(gRef, { count: gCount + 1, reset: gReset, updated_at: FieldValue.serverTimestamp() });
    tx.set(ipRef, { count: iCount + 1, reset: iReset, updated_at: FieldValue.serverTimestamp() });
    return { ok: true, scope: '' };
  });
}
export function oaRegAllow(ip: string): boolean {
  const now = Date.now();
  const win = 3600000;
  const seen = (oaRegHits.get(ip) || []).filter(function (t: number) { return now - t < win; });
  if (seen.length >= OA_REG_PER_IP_PER_HOUR) { oaRegHits.set(ip, seen); return false; }
  seen.push(now);
  oaRegHits.set(ip, seen);
  // unbounded Maps are their own memory-exhaustion bug; drop the table rather than grow it
  if (oaRegHits.size > 20000) oaRegHits.clear();
  return true;
}
export function oaRegBodyTooBig(req: any): boolean {
  const b = (req && req.body) || {};
  try {
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (typeof v === 'string' && v.length > OA_REG_MAX_FIELD) return true;
      if (Array.isArray(v) && v.length > 64) return true;
    }
    return JSON.stringify(b).length > OA_REG_MAX_FIELD * 8;
  } catch (e) { return true; }
}
// Returns '' when the URI is acceptable, or a plain-words reason to put in the 400.
export function oaRedirectUriReason(s: string): string {
  if (s.length > OA_REG_MAX_FIELD) return 'is longer than ' + OA_REG_MAX_FIELD + ' characters';
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return 'contains whitespace or control characters';
  if (s.indexOf('#') !== -1) return 'carries a fragment';
  let u: any;
  try { u = new URL(s); } catch (e) { return 'is not an absolute URL'; }
  if (u.username || u.password) return 'carries embedded credentials';
  if (u.protocol === 'https:') return '';
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return '';
  return 'uses the ' + u.protocol + ' scheme (only https, or http on localhost/127.0.0.1, are accepted)';
}
// [SEC-OAUTH-XSS-SCRIPTJSON] REFLECTED XSS ON THE ANONYMOUS CONSENT PAGE.
// JSON.stringify() produces valid JSON. It does NOT produce a string that is safe inside a
// <script> element: the HTML tokenizer finds the script element's end tag BEFORE the JS parser
// ever sees the source, so a value carrying a closing script tag terminates the script early and
// the rest of that value is parsed as MARKUP. oaAuthHtml() splices client_id, redirect_uri,
// code_challenge, state and scope -- every one straight off the query string -- into the page's
// inline script, and /oauth/authorize is reachable by allUsers on the same origin that serves the
// console. Escape the three characters that can end or reinterpret a script element, plus
// the two Unicode line terminators that are legal inside a JSON string but are line breaks to a
// JS parser. The result is still valid JSON and still parses to the IDENTICAL value, so the
// consent flow is unchanged -- only the bytes on the wire are.
// FUTURE EDITORS: the replacement literals below MUST carry TWO backslashes in this source so the
// emitted JSON carries ONE. Writing them with a single backslash compiles to the bare character
// and turns the whole helper into a silent no-op that still deploys and still looks fixed.
export function oaJsonForScript(v: any): string {
  return String(JSON.stringify(v))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
export function oaChallenge(req: any, res: any): void {
  res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + oaPubBase(req) + '/.well-known/oauth-protected-resource"');
  res.status(401).json({ error: 'unauthorized' });
}
