// SPDX-License-Identifier: Apache-2.0
// [VAULT-CRYPTO-MOD-V1] PURE vault envelope crypto helpers, extracted VERBATIM from
// control-plane/src/index.ts (strangler modularization). Every symbol here is a pure function
// of its arguments -- no module state, no network, no db, no getStorage. The STATEFUL master-key
// machinery STAYS in index.ts by design: _vaultMasterByEpoch / _vaultMasterPromiseByEpoch, the
// KMS fetch vaultDecapsulate, vaultMasterForEpoch / vaultMaster, the VAULT_KEM_SPEC / VAULT_KMS_*
// consts and vaultKemCiphertext that reads them, and the [PCV1-GIT-VAULT-WIRE] gittools bridge.
// Imports node builtins and ../shared.js ONLY -- NEVER ../index.js.
import * as vCrypto from 'crypto';
import { VAULT_MAGIC, VAULT_EPOCH } from '../shared.js';

// VAULT_HKDF_SALT is read ONLY by vaultObjKey below, so it rides along as a module-private const.
const VAULT_HKDF_SALT = Buffer.from('paracoding-vault-hkdf-salt-v1', 'utf8');

// Prefixes that stay CLEARTEXT at rest — MUST match shared/runner/vault_runtime.py CLEARTEXT_PREFIXES exactly.
// [SEC-IAP-ONLY-V126] shared/passkey/ SURVIVES HERE ON PURPOSE. The prefix names a lake path that
// once held loaded code; nothing loads it now. It stays CLEARTEXT-CLASSED because this list is a
// closed set that is an invariant across three peers -- this file, shared/vault/envelope.py and
// shared/deploy/lane-fetch.py, which live in the lake and not in this repository -- and changing
// one peer would have index.ts sealing what envelope.py calls cleartext. The release gate carries
// an asserted allowance for exactly this literal.
const VAULT_CLEARTEXT_PREFIXES = ['shared/deploy/', 'shared/harness/', 'shared/passkey/', 'shared/mcp-oauth/', 'shared/vault/'];
export function vaultIsCleartext(path: string): boolean { const p = String(path || '').replace(/^\/+/, ''); return VAULT_CLEARTEXT_PREFIXES.some((px) => p.indexOf(px) === 0); }

export function vaultObjKey(master: Buffer, path: string, epoch: number): Buffer {
  const info = Buffer.concat([Buffer.from('pcv1:', 'ascii'), Buffer.from(path, 'utf8'), Buffer.from(':e', 'ascii'), Buffer.from([epoch])]);
  return Buffer.from(vCrypto.hkdfSync('sha256', master, VAULT_HKDF_SALT, info, 32));
}
export function vaultEncryptSync(master: Buffer, path: string, plaintext: Buffer | string): Buffer {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const nonce = vCrypto.randomBytes(12);
  const header = Buffer.concat([VAULT_MAGIC, Buffer.from([VAULT_EPOCH]), Buffer.from([0x00]), nonce]);
  const aad = Buffer.concat([VAULT_MAGIC, Buffer.from([VAULT_EPOCH]), Buffer.from([0x00]), Buffer.from(path, 'utf8')]);
  const key = vaultObjKey(master, path, VAULT_EPOCH);
  const cipher = vCrypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, ct, tag]);  // magic|epoch|flags|nonce|ct|tag  (== envelope.py)
}
export function vaultDecryptSync(master: Buffer, path: string, blob: Buffer): string {
  if (!(blob && blob.length >= 4 && blob.slice(0, 4).equals(VAULT_MAGIC))) return blob.toString('utf8');  // legacy plaintext dual-read
  const epoch = blob[4];
  const nonce = blob.slice(6, 18);
  const rest = blob.slice(18);
  const tag = rest.slice(rest.length - 16);
  const ct = rest.slice(0, rest.length - 16);
  // [SEC-AAD-FLAGS-V1] BIND THE FLAGS BYTE THAT IS ACTUALLY STORED, blob[5], instead of the
  // constant 0x00 this line used to splice in. The defect in plain words: the envelope is
  // magic|epoch|flags|nonce|ct|tag and the AAD is documented as magic|epoch|flags|path, but this
  // reader FABRICATED the flags position instead of reading it. Anything with write access to the
  // lake bucket could flip byte 5 of a stored object and the GCM tag still verified here -- an
  // unauthenticated byte sitting inside a header the envelope claims to authenticate whole.
  // vault-objenc.ts:208 already does `const flags = blob[5]` and feeds it to aadFor(), so the two
  // codecs DISAGREED: the same tampered object this function accepted, pcv1Decrypt REJECTED. Two
  // readers of one format silently disagreeing is worse than either behaviour on its own.
  //
  // THE LEGACY FALLBACK IS NOT BELT-AND-BRACES, IT IS THE WHOLE REASON THIS IS SAFE TO LAND. The
  // lake is sealed at rest, there is no delete and there is no re-encrypt tool, so a read change
  // that orphans one object orphans it FOREVER. WHAT WAS MEASURED IN THIS TREE: the only lake
  // writer is harWriteLake -> vaultEncryptSync, whose header and AAD both hardcode 0x00 at the
  // flags position (the two lines directly above this function), and the only other PCV1 writer
  // in the repository is pcv1Encrypt in vault-objenc.ts, which sets `const flags = 0`. Two
  // writers, both emitting 0x00, zero sites anywhere in the tree that write any other value.
  // WHAT COULD NOT BE ESTABLISHED FROM CODE: the envelope's own header names two peer writers,
  // in two sibling fleet components outside this repository, and
  // NEITHER FILE EXISTS IN THIS REPOSITORY. So "nothing in the lake carries a non-zero flags
  // byte" is a well-supported inference, not a fact, and an inference is not a licence to make an
  // object permanently undecryptable. Therefore: bind the stored byte; if and only if the tag
  // then fails AND the stored byte is non-zero, retry ONCE against the legacy 0x00 AAD, say so
  // loudly, and succeed. A flipped flags byte can no longer pass silently -- it either
  // authenticates or it is named in the log -- and nothing readable before this change becomes
  // unreadable after it.
  const flags = blob.length > 5 ? blob[5] : 0;
  const key = vaultObjKey(master, path, epoch);
  const vOpen = (f: number): Buffer => {
    const aad = Buffer.concat([blob.slice(0, 4), Buffer.from([epoch]), Buffer.from([f]), Buffer.from(path, 'utf8')]);
    const d = vCrypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  };
  try {
    return vOpen(flags).toString('utf8');
  } catch (e: any) {
    // flags === 0 means the bound AAD and the legacy AAD are the SAME BYTES. A retry would fail
    // identically and would only turn one honest decrypt failure into two, so rethrow untouched:
    // the fallback must never mask a wrong master, a KMS fault or a corrupt object.
    if (flags === 0) throw e;
    const out = vOpen(0).toString('utf8');
    console.warn('[SEC-AAD-FLAGS-V1] LEGACY-AAD FALLBACK: lake object ' + path + ' (epoch ' + epoch + ') carries flags 0x' + flags.toString(16) + ' and authenticates ONLY against the pre-[SEC-AAD-FLAGS-V1] 0x00 AAD. The bytes are intact and are being returned, but that flags byte is NOT covered by the GCM tag on this object -- rewrite it through harWriteLake to seal it properly. This line firing at all means a writer outside this repository emitted a non-zero flags byte.');
    return out;
  }
}
