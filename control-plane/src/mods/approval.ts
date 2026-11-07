// SPDX-License-Identifier: Apache-2.0
// [APPROVAL-MOD-V1] Privileged-job APPROVAL signing helpers, extracted VERBATIM from
// index.ts (strangler modularization). SECURITY-CRITICAL: these sign privileged-job
// approvals. Imports only from '../shared.js'; never from '../index.js'.
import * as crypto from 'crypto';
import { pcStableJson, waAccessToken, waFetch, PC_APPROVAL_CANON_V2_ID, PC_APPROVAL_SIG_KEY } from '../shared.js';

// ---- [SEC-APPROVAL-KMSSIG-V1] Stage C: ASYMMETRIC approval signatures (signing half) ----
// The Stage-A/B control is an HMAC whose key gate-exec ALSO holds, so the executor can mint
// a valid approval for any command it likes -- it is a signing oracle for its own approvals.
// Only asymmetry closes that: the control plane signs with a Cloud KMS EC_SIGN_P256_SHA256
// key version it alone may use, and the executor verifies with the PUBLIC key. This is the
// SIGNING half; the verifier is gate-exec/exec_server.py.
//
// CANONICALISATION IS THE ENTIRE SECURITY ARGUMENT, which is why it is a named, documented,
// separately testable function and not an inline concat. `jobId + '|' + _cmdSha` was safe
// only by accident: both operands happen to be fixed-shape. The moment approver identity, a
// key version and an expiry join the message, '|' becomes forgeable -- an approver string
// ending in '|<a key version>' is indistinguishable from a different approver plus that key
// version, and a signature over one tuple verifies as a signature over the other. Every
// field below is preceded by its UTF-8 BYTE length, so no value can impersonate a delimiter.
//
// SPEC AND CROSS-LANGUAGE TEST VECTORS: pcApprovalCanonV1 below IS the specification. Every
// field is length-prefixed and emitted in the fixed order named by PC_APPROVAL_CANON_ORDER,
// and any verifier -- in any language -- must reproduce these bytes exactly.
const PC_APPROVAL_CANON_ID = 'PC-APPROVAL-CANON-V1';
// Fixed order. Not sorted at runtime, not derived from Object.keys: a locale-, insertion- or
// engine-dependent order would silently produce different bytes on the two sides.
const PC_APPROVAL_CANON_ORDER: string[] = ['alg', 'jid', 'csha', 'appr', 'kver', 'iat', 'exp'];
// [PC-APPROVAL-CANON-V2] THIS FUNCTION IS NO LONGER CALLED BY THE SIGNER AND IS KEPT ANYWAY.
// gate-exec still ACCEPTS V1 stamps during migration, so V1's bytes are still a live part of
// the system's behaviour, and this remains their executable specification -- the thing the
// cross-language equivalence vectors are run against. It is deleted in the commit that sets
// APPROVAL_ACCEPT_CANON_V1=0 everywhere, not before: deleting the spec while the verifier
// still implements it is how a canon quietly acquires two meanings.
export function pcApprovalCanonV1(f: { alg: string; jid: string; csha: string; appr: string; kver: string; iat: string; exp: string }): Buffer {
  const parts: Buffer[] = [Buffer.from(PC_APPROVAL_CANON_ID + '\n', 'utf8')];
  for (const n of PC_APPROVAL_CANON_ORDER) {
    const v = (f as any)[n];
    // A non-string here would stringify differently in the two languages (null, undefined,
    // 3 vs '3'). Refuse instead: an unsigned approval is recoverable, a mis-signed one is not.
    if (typeof v !== 'string') throw new Error('approval canon: field ' + n + ' must be a string');
    const nb = Buffer.from(n, 'utf8');
    // Buffer.byteLength semantics, NEVER String.length. '—'.length is 1 and its UTF-8
    // length is 3; Python's len() over a str counts the other one again. A verifier that
    // counts characters derives different bytes and refuses every genuine approval.
    const vb = Buffer.from(v, 'utf8');
    parts.push(Buffer.from(String(nb.length) + ':', 'ascii'), nb,
               Buffer.from('=' + String(vb.length) + ':', 'ascii'), vb,
               Buffer.from(';', 'ascii'));
  }
  return Buffer.concat(parts);
}
// ---- [PC-APPROVAL-CANON-V2] THE EXECUTION CONTEXT JOINS THE SIGNED BYTES ----
// WHAT V1 LEFT OUT. V1 signs alg, jid, csha, appr, kver, iat, exp. That proves a named human
// approved THIS COMMAND TEXT for THIS JOB ID under THIS KEY inside THIS WINDOW, and it says
// nothing whatever about HOW the text is executed. gate-exec reads command_type and
// arguments.targetNode off the job document and those two select
//     ssh -o StrictHostKeyChecking=no -i <key> <targetNode> <command>
// versus a local bash. NEITHER WAS SIGNED. So a principal holding roles/datastore.user could
// take a command a human genuinely approved for local execution, set command_type to 'ssh',
// point targetNode at a machine the approver never saw, and every signed byte still verified.
// Firestore integrity was the only thing standing in that gap, and the removal of gate-exec's
// roles/datastore.user grant is the direction of travel, so it cannot stay the only thing.
//
// [SEC-SSHTOOL-REMOVED-V1] THE ssh BRANCH DESCRIBED ABOVE NO LONGER EXISTS -- ssh_executor and
// the executor's ssh path were both removed as dead, and gate-exec now has one execution path.
// ctyp AND asha STAY SIGNED ANYWAY, AND NARROWING THE CANON TO "THE ONE BRANCH THAT REMAINS"
// WOULD BE A MISTAKE. What these two fields actually buy is that the approval names WHICH
// execution semantics were authorised; the ssh branch was merely the first thing that could
// diverge from them. Sign only what today's code branches on and the gap silently reopens the
// day a second branch is added -- by whoever adds it, who will not read this. The canon is
// unchanged; only the example above is now historical.
//
// THE V2 FIELD SET, AND WHY THESE NAMES IN THIS ORDER:
//
//     alg  jid  csha  ctyp  asha  appr  kver  iat  exp
//
// The two new fields are INSERTED after csha, not appended after exp, and that is a choice
// rather than a convenience. Fields 2-5 now say WHAT IS BEING AUTHORISED -- which job, which
// command text, which execution branch, which arguments -- and fields 6-9 say WHO AUTHORISED
// IT, UNDER WHICH KEY, AND FOR HOW LONG. That is the grouping V1 already had; the new facts
// go in the group they belong to instead of being parked at the end. A reviewer diffing V1
// against V2 then reads an INSERTION INTO ONE GROUP rather than a nine-field permutation, and
// a permutation is the change most likely to be waved through unread.
//
//   ctyp  the job's command_type, verbatim, '' when the field is absent. It is the branch
//         selector, so it is the single smallest edit that redirects an approved command.
//   asha  sha256, lowercase hex, of the canonicalised arguments object. THE HASH, NOT THE
//         OBJECT: arguments is unbounded and inlining it would carry a whole script into the
//         signed message twice, once inside asha and once inside csha.
//
// WHY A HASH OF THE WHOLE ARGUMENTS OBJECT RATHER THAN A targetNode FIELD. targetNode lives
// INSIDE arguments. Hashing the object covers targetNode and every other argument in one
// field, including arguments gate-exec does not read today but may read tomorrow. A dedicated
// targetNode field would be a second, weaker statement of a fact asha already makes, and it
// would need its own convention for absence that could disagree with the object's.
//
// csha IS KEPT even though asha covers arguments.command, because csha is taken over the
// command string AFTER gate-exec's command/cmd precedence, which is not recoverable from asha
// alone. Retiring a control that works in order to tidy a field list is not a trade made here.
//
// THE FRAMING IS V1'S, UNCHANGED: the same length-prefixed fields, the same Buffer.byteLength
// semantics, so ':' '=' ';' '|', LF and NUL stay legal inside ctyp and asha with no escaping
// and no rejection. The two new fields inherit that property rather than needing a fresh
// argument for it. Only the DOMAIN line changes besides the fields, and it must: a V1 message
// and a V2 message begin with different bytes, so a signature over one can never be replayed
// as a signature over the other -- which is what makes accepting both during migration a
// bounded decision rather than an open one.
const PC_APPROVAL_CANON_V2_ORDER: string[] = ['alg', 'jid', 'csha', 'ctyp', 'asha', 'appr', 'kver', 'iat', 'exp'];
export function pcApprovalCanonV2(f: { alg: string; jid: string; csha: string; ctyp: string; asha: string; appr: string; kver: string; iat: string; exp: string }): Buffer {
  const parts: Buffer[] = [Buffer.from(PC_APPROVAL_CANON_V2_ID + '\n', 'utf8')];
  for (const n of PC_APPROVAL_CANON_V2_ORDER) {
    const v = (f as any)[n];
    // Same refusal as V1: a non-string would stringify differently in the two languages.
    if (typeof v !== 'string') throw new Error('approval canon: field ' + n + ' must be a string');
    const nb = Buffer.from(n, 'utf8');
    // Buffer.byteLength semantics, NEVER String.length -- see the V1 note above.
    const vb = Buffer.from(v, 'utf8');
    parts.push(Buffer.from(String(nb.length) + ':', 'ascii'), nb,
               Buffer.from('=' + String(vb.length) + ':', 'ascii'), vb,
               Buffer.from(';', 'ascii'));
  }
  return Buffer.concat(parts);
}
// [PC-APPROVAL-CANON-V2] THE ARGUMENTS ARE CANONICALISED BY pcStableJson, WHICH ALREADY EXISTS
// AND IS ALREADY TRUSTED. It is the function pcApproveDrift uses to decide whether a displayed
// job and a stored job are the same job, precisely so key order cannot make one intention look
// like two, and it is deliberately reused here rather than reimplemented: two canonicalisers
// in one file is two things to keep in step, and this fleet has already paid for that lesson.
//
// WHAT THIS ADDS IS A GUARD, NOT A SECOND SERIALISER. gate-exec has to rebuild these exact
// bytes in Python, and there are values pcStableJson will happily serialise that the two
// languages DO NOT SPELL THE SAME WAY:
//   * non-integral and out-of-safe-range numbers -- V8 and CPython switch to exponent notation
//     at different magnitudes, and Firestore hands Python an int where it hands us a Number;
//   * anything that is not null/boolean/number/string/array/plain object -- a Date, a Buffer,
//     a Firestore Timestamp or DocumentReference has no agreed JSON spelling at all;
//   * strings carrying an unpaired UTF-16 surrogate, which [SEC-CANON-SURROGATE-V1] already
//     refuses for the command and which are refused here for every other argument too.
// Each of those THROWS. The throw is caught by the fail-soft wrapper around the signing block
// below, so the effect is that no V2 signature is stamped for a job whose arguments we could
// not honestly promise the verifier can rebuild -- rather than stamping one that will fail to
// verify later, at the executor, after the human has already spent a tap.
export function pcCanonUnsafeArg(v: any): string {
  if (v === null || v === undefined) return '';
  const t = typeof v;
  if (t === 'boolean') return '';
  if (t === 'number') {
    if (!Number.isFinite(v)) return 'a non-finite number';
    if (!Number.isInteger(v)) return 'a non-integral number';
    if (!Number.isSafeInteger(v)) return 'an integer outside the safe range';
    return '';
  }
  if (t === 'string') return pcLoneSurrogate(v) ? 'a string containing an unpaired UTF-16 surrogate' : '';
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const w = pcCanonUnsafeArg(v[i]); if (w) return w; }
    return '';
  }
  if (t === 'object') {
    // PLAIN OBJECTS ONLY. A class instance serialises through pcStableJson as its own
    // enumerable keys and would silently drop everything else, so it is refused rather than
    // half-signed.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return 'an object that is not a plain object';
    const k = Object.keys(v);
    for (let i = 0; i < k.length; i++) {
      if (pcLoneSurrogate(k[i])) return 'an object key containing an unpaired UTF-16 surrogate';
      const w = pcCanonUnsafeArg(v[k[i]]); if (w) return w;
    }
    return '';
  }
  return 'a value of type ' + t;
}
// ABSENT AND NULL ARE THE SAME VALUE HERE, DELIBERATELY, and gate-exec's pc_canon_args_sha
// makes the same choice: a job with no arguments field and a job whose arguments field is null
// both canonicalise to the four bytes 'null'. Note that the verifier must read the RAW field
// for this and not its own {} default -- '{}' and 'null' are different bytes.
export function pcApprovalArgsSha(args: any): string {
  const a = args === undefined ? null : args;
  const why = pcCanonUnsafeArg(a);
  if (why) throw new Error('approval canon: the arguments cannot be canonicalised identically by the verifier (' + why + ')');
  return crypto.createHash('sha256').update(pcStableJson(a), 'utf8').digest('hex');
}
const PC_APPROVAL_SIG_TIMEOUT_MS = Math.max(1000, Number(process.env.APPROVAL_SIG_TIMEOUT_MS || 8000));
export async function pcApprovalSign(canonBytes: Buffer): Promise<string> {
  if (!PC_APPROVAL_SIG_KEY) throw new Error('approval sign: APPROVAL_SIG_KEY_VERSION unset');
  const digest = crypto.createHash('sha256').update(canonBytes).digest('base64');
  const tok = await waAccessToken();
  // EXPLICIT DEADLINE. A stalled KMS connection resolves neither way for minutes, and this
  // sits directly in front of a human waiting on their own approval tap. The vault reader was
  // bitten by exactly this shape of hang.
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, PC_APPROVAL_SIG_TIMEOUT_MS);
  try {
    const r = await waFetch('https://cloudkms.googleapis.com/v1/' + PC_APPROVAL_SIG_KEY + ':asymmetricSign', {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest: { sha256: digest } }),
    });
    if (!r || !r.ok) { let t = ''; try { t = r ? await r.text() : ''; } catch (e) {} throw new Error('KMS asymmetricSign failed: ' + (r && r.status) + ' ' + String(t).slice(0, 200)); }
    const j: any = await r.json();
    const sig = j && j.signature;
    if (!sig) throw new Error('KMS asymmetricSign: no signature in response');
    // KMS echoes the key version it ACTUALLY signed with. If that is not the version we asked
    // for, the stamp would name a key that did not make this signature and every verifier
    // would fetch the wrong public key. Refuse rather than emit a mislabelled stamp.
    const used = String((j && j.name) || '');
    if (used && used !== PC_APPROVAL_SIG_KEY) throw new Error('KMS asymmetricSign: signed by ' + used + ', expected ' + PC_APPROVAL_SIG_KEY);
    return String(sig);
  } finally { clearTimeout(timer); }
}
// [SEC-CANON-SURROGATE-V1] LONE SURROGATES ARE REFUSED, NOT SUBSTITUTED.
// The approval digest stamped below is computed here in Node and re-computed in Python by
// gate-exec's verifier. The two languages do not agree on an unpaired UTF-16 surrogate:
// Node's UTF-8 encoder substitutes U+FFFD and happily produces a digest, while Python's
// str.encode('utf-8') raises UnicodeEncodeError. The Python call site has no try/except, so
// such a command escapes as a 500 -- an unjournalled crash whose cause nobody can read --
// instead of a refusal anyone can audit. Refusing here makes the divergence unreachable
// from the side that WRITES the document: nothing is stamped, nothing is signed, nothing
// executes, and the refusal is journalled and returned as a 403.
// Firestore stores well-formed UTF-8, so this is not reachable through the staging path
// today. It is armed BEFORE the verifier lands rather than after, because after is when a
// 500 has already happened.
export function pcLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xDC00 && c <= 0xDFFF) return true;
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n < 0xDC00 || n > 0xDFFF) return true;
      i++;
    }
  }
  return false;
}
