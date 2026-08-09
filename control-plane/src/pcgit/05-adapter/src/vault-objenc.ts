/**
 * PCV1 envelope for GIT OBJECTS, Node side. READ PATH FIRST.
 *
 * Byte-for-byte compatible with shared/vault/envelope.py and with
 * shared/state/security-lane/gitenc/gitenc_envelope.py:
 *
 *     magic(4)="PCV1" | epoch(1) | flags(1) | nonce(12) | ciphertext(N) | tag(16)
 *     key = HKDF-SHA256(master, salt=HKDF_SALT, info="pcv1:"+path+":e"+epoch, 32)
 *     AAD = magic | epoch | flags | path
 *
 * `path` IS THE FULL GCS OBJECT KEY, not the virtual filesystem path. GcsStore
 * builds that key as `prefix + normalizedPath.slice(1)`, so the AAD must be
 * computed from `this.key(path)` and NEVER from the adapter-level path -- two
 * repos mounted at the same virtual `/repo/.git` would otherwise produce the
 * same AAD for different objects, which is the same cross-tenant collision
 * class the gitCache WeakMap was introduced to kill.
 *
 * NO NEW DEPENDENCIES. `node:crypto` has hkdfSync and aes-256-gcm. The
 * control-plane Dockerfile transpiles rather than bundles, so every import must
 * resolve from node_modules at runtime -- a built-in is the only safe choice.
 * IF THIS FILE IS ADDED TO THE BUILD IT MUST BE ADDED TO THE DOCKERFILE's
 * esbuild line, with `&& test -s dist/<name>.js`, or it compiles to nothing.
 *
 * DUAL-READ: a blob whose first four bytes are not `PCV1` is returned VERBATIM.
 * It is never decoded to a string. A git object is a zlib stream and a
 * utf8 round trip corrupts it silently -- that is the defect in the deployed
 * shared/vault/envelope.py, whose dual-read branch does
 * `blob.decode("utf-8", errors="replace")`.
 *
 * PROVEN: 57/57 cross-language checks against gitenc_envelope.py, including
 * byte-identical output under a fixed nonce, and 18/18 runtime checks driving
 * the PATCHED production gcs-store.ts.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export const PCV1_MAGIC = Buffer.from('PCV1', 'ascii');
export const PCV1_HEADER_LEN = 18;
export const PCV1_TAG_LEN = 16;
export const PCV1_OVERHEAD = PCV1_HEADER_LEN + PCV1_TAG_LEN; // 34

/**
 * The epoch this build WRITES. Must track `VAULT_EPOCH` in control-plane/src/
 * index.ts, which the KEM_XWING pivot moved from 1 to 2. Reading is NOT limited
 * to this epoch -- see the registry below.
 */
export const PCV1_EPOCH_CURRENT = 2;
export const PCV1_DEFAULT_EPOCH = PCV1_EPOCH_CURRENT;

/**
 * Epoch -> KEM parameters, mirroring `VAULT_KEM_SPEC` in index.ts. Kept here so
 * an epoch byte off the wire can be recognised as known-but-unloaded rather
 * than reported as generic garbage.
 *
 * `keyVersion` and `path` are DELIBERATELY NOT duplicated from index.ts. This
 * module never talks to Cloud KMS -- it only ever receives an already-derived
 * 32-byte master. Copying the KMS resource names here would create a second
 * source of truth for the one string that must never drift, and index.ts builds
 * them from PC_PROJECT at runtime anyway. index.ts owns the KMS binding; this
 * module owns the envelope.
 */
export const PCV1_KEM_SPEC: { [k: string]: { alg: string; ctLen: number } } = {
  '1': { alg: 'ML-KEM-1024', ctLen: 1568 },
  '2': { alg: 'KEM_XWING', ctLen: 1120 },
};

const HKDF_SALT = Buffer.from('paracoding-vault-hkdf-salt-v1', 'utf8');

/**
 * PROCESS-WIDE MASTER REGISTRY, keyed by EPOCH, set at boot after the KMS
 * decapsulate(s).
 *
 * WHY A MAP AND NOT ONE BUFFER. This used to hold a single master, with a note
 * saying an epoch registry was required BEFORE any KEM pivot. The pivot has now
 * happened: index.ts is at `VAULT_EPOCH = 2` (KEM_XWING) and carries a
 * `vaultMasterForEpoch` dual-read window so epoch-1 and epoch-2 objects are
 * both readable from one build. A single-master reader here would have been the
 * flag day that window exists to prevent -- `pcv1Decrypt` already derives its
 * per-object key from the BLOB's epoch byte, so the only thing that was missing
 * was the ability to hold more than one master at a time. That is this map.
 *
 * Deliberately a module singleton rather than a GcsStore constructor option.
 * The option would have to be threaded through `createFirestoreGcsFs` ->
 * `Adapter` -> two `new GcsStore(...)` call sites in a second file, and a
 * partial rollout of that plumbing gives a store whose master is `undefined`
 * -- which reads as "no key" and throws on every encrypted object. One
 * assignment at boot cannot be half-applied.
 *
 * THE LIMIT, STATED: this is per-PROCESS, so it is per-FLEET, not per-tenant.
 * It is correct for the single-repo control plane and it is NOT correct if a
 * second tenant with a different master is ever served from the same process.
 * If that day comes this must become an adapter-scoped value, exactly as the
 * isomorphic-git cache had to.
 */
const _mastersByEpoch = new Map<number, Buffer>();

function assertMaster(master: Buffer): void {
  if (master.length !== 32) {
    throw new Error(`PCV1 master must be 32 bytes, got ${master.length}`);
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 255) {
    throw new Error(`PCV1 epoch must be a byte, got ${String(epoch)}`);
  }
}

/** Register the master for ONE epoch. Call once per readable epoch at boot. */
export function setVaultMasterForEpoch(epoch: number, master: Buffer | null): void {
  assertEpoch(epoch);
  if (master === null) {
    _mastersByEpoch.delete(epoch);
    return;
  }
  assertMaster(master);
  _mastersByEpoch.set(epoch, master);
}

/** The master registered for `epoch`, or null. */
export function getVaultMasterForEpoch(epoch: number): Buffer | null {
  return _mastersByEpoch.get(epoch) ?? null;
}

/** Epochs this process can currently decrypt, ascending. */
export function loadedVaultEpochs(): number[] {
  return [..._mastersByEpoch.keys()].sort((a, b) => a - b);
}

/**
 * Back-compatible single-master API: registers/reads the CURRENT epoch.
 * `setVaultMaster(null)` clears the WHOLE registry, so a de-provisioned process
 * cannot keep serving one stale epoch it happens to still hold.
 */
export function setVaultMaster(master: Buffer | null): void {
  if (master === null) {
    _mastersByEpoch.clear();
    return;
  }
  setVaultMasterForEpoch(PCV1_EPOCH_CURRENT, master);
}

export function getVaultMaster(): Buffer | null {
  return getVaultMasterForEpoch(PCV1_EPOCH_CURRENT);
}

/** True if these bytes carry a PCV1 envelope. Cheap; safe on empty buffers. */
export function isPcv1(blob: Buffer): boolean {
  return blob.length >= 4 && blob.compare(PCV1_MAGIC, 0, 4, 0, 4) === 0;
}

/**
 * The per-object key. IDENTICAL derivation to the vault's `vaultObjKey`.
 * Changing the info string, the salt, or the epoch encoding makes every stored
 * object unreadable, so none of them are parameters.
 */
export function vaultObjKey(master: Buffer, path: string, epoch: number): Buffer {
  assertMaster(master);
  assertEpoch(epoch);
  const info = Buffer.concat([
    Buffer.from('pcv1:', 'utf8'),
    Buffer.from(path, 'utf8'),
    Buffer.from(':e', 'utf8'),
    Buffer.from([epoch]),
  ]);
  return Buffer.from(hkdfSync('sha256', master, HKDF_SALT, info, 32));
}

function aadFor(epoch: number, flags: number, path: string): Buffer {
  return Buffer.concat([
    PCV1_MAGIC,
    Buffer.from([epoch, flags]),
    Buffer.from(path, 'utf8'),
  ]);
}

/** Wrap bytes in a PCV1 envelope. WRITE PATH -- lands LAST, not first. */
export function pcv1Encrypt(
  master: Buffer,
  path: string,
  plaintext: Buffer,
  epoch: number = PCV1_DEFAULT_EPOCH,
  nonce: Buffer = randomBytes(12),
): Buffer {
  if (nonce.length !== 12) throw new Error('PCV1 nonce must be 12 bytes');
  const flags = 0;
  const cipher = createCipheriv('aes-256-gcm', vaultObjKey(master, path, epoch), nonce);
  cipher.setAAD(aadFor(epoch, flags, path));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    PCV1_MAGIC,
    Buffer.from([epoch, flags]),
    nonce,
    body,
    cipher.getAuthTag(),
  ]);
}

/** Unwrap a PCV1 envelope. Throws on any authentication failure. */
export function pcv1Decrypt(master: Buffer, path: string, blob: Buffer): Buffer {
  if (!isPcv1(blob)) throw new Error('not a PCV1 envelope');
  if (blob.length < PCV1_OVERHEAD) {
    throw new Error(
      `PCV1 blob truncated: ${blob.length} bytes, minimum ${PCV1_OVERHEAD}`,
    );
  }
  const epoch = blob[4] as number;
  const flags = blob[5] as number;
  const nonce = blob.subarray(6, 18);
  const tag = blob.subarray(blob.length - PCV1_TAG_LEN);
  const body = blob.subarray(PCV1_HEADER_LEN, blob.length - PCV1_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', vaultObjKey(master, path, epoch), nonce);
  decipher.setAAD(aadFor(epoch, flags, path));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Resolve the master to decrypt a blob stamped `epoch`, given whatever master
 * the caller had to hand.
 *
 * PRECEDENCE, and the order is the point:
 *   1. the registry entry for THIS blob's epoch -- so an epoch-1 object is
 *      decrypted with the epoch-1 master even though the caller passed the
 *      current-epoch one. That is the whole dual-read window.
 *   2. if the registry is EMPTY, the caller's explicit master. This keeps the
 *      module usable as a pure codec (the cross-language interop vectors drive
 *      it exactly this way) and preserves the pre-registry behaviour.
 *   3. otherwise THROW naming the epoch. A populated registry that lacks this
 *      epoch is a provisioning gap, not a decode error, and falling back to
 *      some other epoch's master would only surface as a GCM tag failure three
 *      layers away.
 */
function resolveMasterFor(epoch: number, fallback: Buffer | null): Buffer | null {
  const registered = _mastersByEpoch.get(epoch);
  if (registered !== undefined) return registered;
  if (_mastersByEpoch.size === 0) return fallback;
  const known = PCV1_KEM_SPEC[String(epoch)];
  throw new Error(
    `PCV1 object is epoch ${epoch}` +
      (known ? ` (${known.alg})` : ' (unknown epoch)') +
      `, but this process holds masters only for epoch(s) ` +
      `${loadedVaultEpochs().join(', ')}; the dual-read window is not open for it`,
  );
}

/**
 * THE READ-PATH ENTRY POINT. This is the only function GcsStore calls.
 *
 * Dual-read, and the failure modes are deliberately NOT symmetric:
 *
 *   no PCV1 magic            -> return the bytes verbatim, key or no key.
 *                               This is what lets the store hold plaintext and
 *                               ciphertext at once during migration.
 *   PCV1 magic, no master    -> THROW. Returning the ciphertext would hand
 *                               isomorphic-git a "loose object" that does not
 *                               inflate, and the operator would debug a
 *                               corrupt-repo report caused by a missing IAM
 *                               grant. Name the real fault at the real site.
 *   PCV1 magic, epoch with
 *   no loaded master         -> THROW naming the epoch (see resolveMasterFor).
 *   PCV1 magic, wrong key
 *   or wrong path            -> THROW, from GCM authentication.
 */
export function vaultDecryptMaybe(
  master: Buffer | null,
  path: string,
  blob: Buffer,
): Buffer {
  if (!isPcv1(blob)) return blob;
  const epoch = blob.length > 4 ? (blob[4] as number) : PCV1_EPOCH_CURRENT;
  const use = resolveMasterFor(epoch, master);
  if (use === null) {
    throw new Error(
      `PCV1 object at ${path} but no vault master is loaded; this process ` +
        'cannot read the git object store (check the KEM decapsulate grant)',
    );
  }
  return pcv1Decrypt(use, path, blob);
}

/**
 * Plaintext byte length for `stat`, when the object is a PCV1 envelope.
 *
 * WHY THIS EXISTS. `GcsStore.nodeFrom` reports `Number(metadata.size)`, which
 * after encryption is the CIPHERTEXT length -- 34 bytes too many. isomorphic-git
 * records `stat.size` in `.git/index` and `compareStats` branches on it, so a
 * uniformly wrong size makes every indexed file look modified forever. The
 * writer therefore stamps the plaintext length in GCS custom metadata as
 * `ptsize`, and this reads it back.
 *
 * ABSENT `ptsize` MEANS PLAINTEXT, which is the correct dual-read answer for
 * every object written before the writer change lands. Subtracting 34
 * unconditionally would be wrong for exactly those objects, so it is not done.
 */
export function plaintextSize(
  rawSize: number,
  custom: Record<string, string | undefined> | undefined,
): number {
  const stamped = custom?.ptsize;
  if (stamped === undefined) return rawSize;
  const n = Number(stamped);
  return Number.isFinite(n) && n >= 0 ? n : rawSize;
}
