/**
 * vault-objwrite.ts -- THE WRITE-SIDE POLICY, IN EXACTLY ONE PLACE.
 *
 * WHY THIS MODULE EXISTS AS A SEPARATE FILE.
 *
 * There are TWO independent GCS clients over the same key space:
 *
 *   05-adapter/src/gcs-store.ts   GcsStore.writeFileReturningGeneration / makeDir
 *   07-refs/src/objects.ts        ObjectStore.writeLoose / writePackPair
 *
 * They were built to agree on layout (`objectsKeyPrefix` is computed from the
 * adapter's own two options precisely so the halves cannot drift). If the
 * ENCRYPTION POLICY were re-implemented in each of them, that same drift comes
 * straight back in a far worse form: one writer encrypting a `.idx` the other
 * leaves plaintext does not fail loudly, it makes `ObjectStore.idxContains`
 * -- which runs BEFORE EVERY REF UPDATE -- silently answer "no" for every oid
 * in that pack. The push fence then rejects good pushes, or worse, a repack
 * retires a pack whose contents it could not see.
 *
 * So the policy is a FUNCTION, exported once, imported by both. Both patchers
 * assert that they import it and that they call nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE POLICY, AND THE REASON FOR EVERY EXEMPTION
 * ---------------------------------------------------------------------------
 *
 * 1. DIRECTORY MARKERS STAY PLAINTEXT.  Keys ending in `/` are the zero-byte
 *    marker objects `GcsStore.makeDir` writes through a code path that is NOT
 *    `writeFile`. `pcgit-export.py`'s `strip_directory_markers` identifies them
 *    by `getsize(p) == 0`. Encrypting one makes it 34 bytes, it stops being
 *    recognised as a marker, it survives into `objects/`, and `git fsck`
 *    reports garbage files. There is also nothing in a marker to protect: it is
 *    zero bytes, and its NAME -- which is the only information it carries -- is
 *    plaintext by design anyway.
 *
 * 2. `.idx` FILES STAY PLAINTEXT.  This is the hard architectural constraint,
 *    not a convenience. `ObjectStore.idxContains` does two RANGED reads:
 *
 *        const head  = await this.readRange(idxPath, 0, 8 + 1024 - 1);
 *        const slice = await this.readRange(idxPath, tableAt + lo * stride, ...);
 *
 *    YOU CANNOT RANGED-READ AN AES-GCM BLOB. The tag authenticates the whole
 *    ciphertext; bytes [1024..2048] are undecryptable in isolation. Encrypting
 *    `.idx` would force a whole-file download on the path that runs before
 *    every ref update -- the module's own comment says that "would have made
 *    the honest fence too expensive to keep, which is how fences end up
 *    vestigial."
 *
 *    WHAT THIS COSTS, STATED PLAINLY: a `.idx` holds OIDS AND OFFSETS, no
 *    object content. PCV1 already keeps object PATHS plaintext, and a loose
 *    object's path IS its oid (`objects/ab/cdef...`). So a plaintext `.idx`
 *    leaks strictly LESS than the key namespace already leaks by design. The
 *    content lives in the `.pack`, and the `.pack` is encrypted.
 *
 * 3. EVERYTHING ELSE UNDER `objects/` IS ENCRYPTED.  Loose objects and
 *    `.pack` files.
 *
 * ---------------------------------------------------------------------------
 * AAD AND EPOCH -- IDENTICAL TO WHAT THE READ SIDE ALREADY IMPLEMENTS
 * ---------------------------------------------------------------------------
 *
 * AAD   = magic | epoch | flags | THE FULL GCS OBJECT KEY
 *         e.g. `<repo-prefix>/.git/objects/ab/cdef...`
 *         NOT the adapter's virtual path (two tenants both mount `/repo/.git`,
 *         so virtual paths collide), and NOT the oid alone (which would not
 *         bind loose-vs-packed or the repo prefix). For a loose object the oid
 *         is CONTAINED IN the key, so oid-binding comes free.
 *
 * EPOCH = stamped into the header by the WRITER as the current epoch. The
 *         READER derives its key from the epoch byte ON THE OBJECT, never from
 *         a global. That is what makes a KEM pivot an epoch bump instead of a
 *         flag day. Writers must therefore never assume the reader's epoch.
 *
 * ---------------------------------------------------------------------------
 * A MISSING MASTER IS A HARD FAILURE, NOT A FALLBACK TO PLAINTEXT
 * ---------------------------------------------------------------------------
 *
 * `encryptForStore` THROWS if it is asked to encrypt and holds no master. The
 * tempting alternative -- write plaintext and let dual-read cope -- is exactly
 * the bypass this whole change exists to close: a misconfigured instance would
 * quietly seed plaintext into a store everyone believes is encrypted, and
 * nothing would ever report it. `vaultDecryptMaybe` already throws on the read
 * side for the mirror-image reason. Fail closed, name the grant.
 *
 * DEPENDENCIES: none beyond ./vault-objenc.js, which is node:crypto only.
 */

import { pcv1Encrypt, PCV1_DEFAULT_EPOCH } from './vault-objenc.js';

/** Result of applying the write policy to one object. */
export interface StoreBytes {
  /** Exactly what to hand to `file.save()`. */
  bytes: Buffer;
  /**
   * Value for the `ptsize` custom metadata, or null when the object was left
   * plaintext (in which case NO `ptsize` must be stamped -- absent `ptsize`
   * is what tells `plaintextSize` the object is plaintext).
   */
  ptsize: string | null;
  /** True when `bytes` is a PCV1 envelope. For assertions and logging. */
  encrypted: boolean;
}

/**
 * Is this FULL GCS OBJECT KEY one we encrypt?
 *
 * Takes the full key, not a virtual path, so both writers ask the identical
 * question about the identical string.
 */
export function shouldEncryptObjectKey(key: string): boolean {
  // Directory marker. See policy note 1.
  if (key === '' || key.endsWith('/')) return false;
  // Pack index. See policy note 2 -- ranged reads make this non-negotiable.
  if (key.endsWith('.idx')) return false;
  return true;
}

/**
 * Apply the write policy. The ONLY function either writer may call.
 *
 * @param master  the epoch's 32-byte master, or null if none is loaded
 * @param key     the FULL GCS object key -- this is the AAD
 * @param plaintext the bytes the caller wanted to store
 */
export function encryptForStore(
  master: Buffer | null,
  key: string,
  plaintext: Buffer,
): StoreBytes {
  if (!shouldEncryptObjectKey(key)) {
    return { bytes: plaintext, ptsize: null, encrypted: false };
  }
  if (master === null) {
    throw new Error(
      `refusing to write ${key} as plaintext into an encrypted object store: no vault ` +
        `master is loaded. This is a configuration failure, not a data condition. ` +
        `Check the KEM decapsulate grant on the vault key and that the epoch->master ` +
        `registry was populated at boot.`,
    );
  }
  return {
    bytes: pcv1Encrypt(master, key, plaintext, PCV1_DEFAULT_EPOCH),
    // The PLAINTEXT length, so stat() can report it. isomorphic-git stores
    // stat.size in .git/index and compareStats branches on it; a uniform +34
    // makes every indexed file look modified forever.
    ptsize: String(plaintext.length),
    encrypted: true,
  };
}

/**
 * Custom-metadata object for a write, merged with whatever the caller already
 * sets. Returns `base` unchanged when the object was left plaintext, so no
 * `ptsize` key is introduced -- ABSENT means plaintext and that must stay true.
 */
export function withPtsize(
  base: Record<string, string | undefined>,
  stored: StoreBytes,
): Record<string, string | undefined> {
  if (stored.ptsize === null) return base;
  return { ...base, ptsize: stored.ptsize };
}
