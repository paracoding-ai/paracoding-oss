/**
 * 07-refs / objects.ts
 *
 * Thin, correctness-focused view of the GCS object half of the store.
 * (The full isomorphic-git `fs` adapter lives in 02-fs-interface; this module
 * only exposes the operations the ref-safety and repair logic need.)
 *
 * Two properties of GCS that the whole torn-state argument rests on, both
 * from cloud.google.com/storage/docs/consistency:
 *
 *   1. "When you write an object to Cloud Storage ... the object is
 *      immediately available for reading and metadata operations as soon as
 *      you receive a success response to your write request."
 *   2. "Bucket listing and object listing are strongly consistent."
 *
 * So: a 200 from objects.insert is a durability fence. There is no window in
 * which we have been told an object exists and a later reader cannot see it.
 * That is what lets "objects first, ref last" be an actual guarantee rather
 * than a probabilistic one.
 *
 * A GCS object insert is also atomic — a partially uploaded object never
 * becomes visible under its final name. So a crashed uploader leaves nothing,
 * not a truncated object.
 */

import type { Bucket, File } from '@google-cloud/storage';

import type { Oid } from './model';

// PCV1-WRITE-V1 the write policy lives in ONE module, imported by BOTH GCS
// clients (this one and 05-adapter's GcsStore), so they cannot drift on
// what gets encrypted. `.idx` stays plaintext: idxContains() ranged-reads
// it and an AES-GCM blob cannot be ranged-read.
import { encryptForStore } from '../../05-adapter/src/vault-objwrite';
import { getVaultMaster } from '../../05-adapter/src/vault-objenc';

/**
 * THE KEY LAYOUT, AND WHY IT IS COMPUTED RATHER THAN CONFIGURED.
 *
 * This module and 05-adapter's `GcsStore` must address the same bytes. The
 * adapter's rule is exactly one line (`gcs-store.ts`):
 *
 *     key(path) = objectPrefix + normalize(path).slice(1)
 *
 * and every object path it is handed looks like `${gitdir}/objects/...`. So the
 * prefix this module must use is a FUNCTION of the two values the adapter is
 * already configured with, and nothing else:
 *
 *     objectsKeyPrefix(objectPrefix, gitdir) = objectPrefix + gitdir.slice(1) + '/objects'
 *
 * This used to be a third, independently-supplied string (`repoId`), from which
 * the prefix was built as `${repoId}/objects`. That is a different key space
 * from the adapter's for every value of `repoId` except the non-obvious
 * `"<repo>/.git"`, and getting it wrong is SILENT: `hasLoose` and `listPacks`
 * simply return "nothing here", so `doctor` reports a clean repo with 0 packs
 * and 0 loose objects and sweeps nothing, forever, while push.ts's fence looks
 * in an empty prefix. A verifier that cannot see what it certifies is worse
 * than no verifier. Taking the adapter's own two options removes the third
 * degree of freedom, so the halves cannot drift.
 */
export function objectsKeyPrefix(objectPrefix: string, gitdir: string): string {
  const p = objectPrefix === '' || objectPrefix.endsWith('/') ? objectPrefix : `${objectPrefix}/`;
  // Same reduction 05-adapter/paths.ts `normalizePath` applies before the
  // adapter builds a key, so `/r/.git`, `r/.git` and `/r/./.git/` all agree.
  const segments: string[] = [];
  for (const segment of gitdir.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const g = segments.join('/');
  return g === '' ? `${p}objects` : `${p}${g}/objects`;
}

export interface ObjectStoreOptions {
  bucket: Bucket;
  /** EXACTLY the `objectPrefix` handed to `createFirestoreGcsFs`. */
  objectPrefix: string;
  /** EXACTLY the `gitdir` passed to isomorphic-git, e.g. `/.git`. */
  gitdir: string;
}

/** A pack pair as it exists (or half-exists) in the bucket. */
export interface PackPair {
  sha: string;
  packPath: string;
  idxPath: string;
  hasPack: boolean;
  hasIdx: boolean;
  /** Newest of the two objects' creation times, epoch ms. */
  updatedAtMs: number;
}

export class ObjectStore {
  private readonly bucket: Bucket;
  readonly prefix: string;

  constructor(opts: ObjectStoreOptions) {
    this.bucket = opts.bucket;
    this.prefix = objectsKeyPrefix(opts.objectPrefix, opts.gitdir);
  }

  loosePath(oid: Oid): string {
    return `${this.prefix}/${oid.slice(0, 2)}/${oid.slice(2)}`;
  }

  packPath(sha: string): string {
    return `${this.prefix}/pack/pack-${sha}.pack`;
  }

  idxPath(sha: string): string {
    return `${this.prefix}/pack/pack-${sha}.idx`;
  }

  async hasLoose(oid: Oid): Promise<boolean> {
    const [exists] = await this.bucket.file(this.loosePath(oid)).exists();
    return exists;
  }

  /**
   * Write a loose object. Content-addressed, therefore immutable, therefore
   * idempotent: two writers racing on the same oid write byte-identical
   * content, so last-write-wins is indistinguishable from first-write-wins.
   * No locking, no preconditions, nothing to get wrong.
   *
   * `ifGenerationMatch: 0` is used anyway ("create only if absent") purely to
   * avoid paying for a redundant upload; a 412 here is a success, not a
   * failure, and is swallowed.
   *
   * BUT SWALLOWING IT SILENTLY BREAKS THE GC'S GRACE PERIOD, so the 412 branch
   * is not a bare `return`. repair.ts decides what is safe to delete partly by
   * AGE, read from the object's GCS `updated` stamp. A 412 leaves that stamp
   * exactly as the previous writer left it. So:
   *
   *   t0      a push writes these bytes, then crashes before its ref CAS.
   *   t0+25h  the client retries, re-offers the identical bytes, GCS 412s.
   *   t0+25h  the object is about to become reachable, and still looks 25 h old.
   *
   * A 24 h grace period reads that as "abandoned garbage" and deletes it out
   * from under the retry — the exact deletion the grace period exists to
   * prevent, on the exact path the design calls safe. The bytes are immutable so
   * there is nothing to re-upload; what has to move is the METADATA clock. A
   * metadata patch does that (GCS defines `updated` as the modification time of
   * the object metadata) for one cheap Class A op instead of a second upload.
   *
   * This is one of TWO guards. repair.ts also re-reads the ref tips, because a
   * retry whose uploader skips objects it can already see never calls this
   * method at all and so refreshes nothing.
   *
   * `resumable: false` matters. `File.save` defaults to a RESUMABLE upload
   * unless it is told otherwise (`file.js`: `if (options.resumable === false)
   * startSimpleUpload_ else startResumableUpload_`), which is three round trips
   * — create session, PUT, finalise — for an object that is typically a few
   * hundred bytes. Resumable exists for multi-megabyte payloads; a loose git
   * object is never one. `writePackPair` below already opts out, and this was
   * the one writer in the file that did not.
   */
  async writeLoose(oid: Oid, contents: Buffer): Promise<void> {
    const key = this.loosePath(oid);
    const file = this.bucket.file(key);
    // PCV1-WRITE-V1 ONE encrypt, ABOVE BOTH save() sites in this method. The
    // recovery path below must store the IDENTICAL bytes; deriving them twice
    // would produce two different nonces for one content-addressed object.
    // AAD is `key`, the full GCS object key, exactly as the reader binds it.
    const stored = encryptForStore(getVaultMaster(), key, contents);
    try {
      await file.save(stored.bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        ...(stored.ptsize === null
          ? {}
          : { metadata: { metadata: { ptsize: stored.ptsize } } }),
      });
      return;
    } catch (err) {
      if ((err as { code?: number }).code !== 412) throw err;
      // 412: already present, identical bytes. Fall through to refresh its age.
    }

    try {
      await file.setMetadata({ metadata: { lastOfferedAt: new Date().toISOString() } });
    } catch (err) {
      // Deleted between the 412 and the patch — by a gc that had already decided
      // it was garbage, most likely. Write it properly this time; the object is
      // content-addressed so this cannot corrupt anything.
      if ((err as { code?: number }).code !== 404) throw err;
      // PCV1-WRITE-V1 THE SECOND save() IN THIS METHOD. It is reached only when a
      // gc deletes the object between the 412 and the metadata patch, so a
      // version of this patch that missed it would write plaintext under
      // concurrent gc pressure and never once in a test.
      await file.save(stored.bytes, {
        resumable: false,
        ...(stored.ptsize === null
          ? {}
          : { metadata: { metadata: { ptsize: stored.ptsize } } }),
      });
    }
  }

  /**
   * Write a pack pair in the ONLY safe order: .pack first, .idx second.
   *
   * isomorphic-git's readObjectPacked lists objects/pack, filters for *.idx,
   * and for each idx that contains the oid reads the sibling *.pack. So:
   *   - .pack present, .idx absent  -> the pack is INVISIBLE. Harmless.
   *   - .idx present, .pack absent  -> the reader finds the oid in the index
   *                                    and then hard-fails reading the pack.
   *                                    A corrupt repo.
   * The .idx is therefore the commit point of a pack. Writing it last makes
   * a crash mid-pack-write structurally incapable of producing a broken repo.
   * Deleting a pack inverts this: delete the .idx FIRST (see repair.ts).
   */
  async writePackPair(sha: string, pack: Buffer, idx: Buffer): Promise<void> {
    const packKey = this.packPath(sha);
    const idxKey = this.idxPath(sha);
    // PCV1-WRITE-V1 the .pack is ENCRYPTED, the .idx is left PLAINTEXT. Neither
    // decision is made here: encryptForStore() decides from the KEY, so this
    // writer and GcsStore's writer are incapable of disagreeing about a file.
    const storedPack = encryptForStore(getVaultMaster(), packKey, pack);
    const storedIdx = encryptForStore(getVaultMaster(), idxKey, idx);
    await this.bucket.file(packKey).save(storedPack.bytes, {
      resumable: false,
      ...(storedPack.ptsize === null
        ? {}
        : { metadata: { metadata: { ptsize: storedPack.ptsize } } }),
    });
    // Not concurrent. The await above is the fence. THE ORDER IS UNCHANGED:
    // .pack first, .idx second. The .idx is the commit point of a pack --
    // .pack without .idx is invisible and harmless, .idx without .pack is a
    // corrupt repo. Encryption must not be allowed to reorder that.
    await this.bucket.file(idxKey).save(storedIdx.bytes, { resumable: false });
  }

  async listPacks(): Promise<PackPair[]> {
    const [files] = await this.bucket.getFiles({ prefix: `${this.prefix}/pack/` });
    const byShaes = new Map<string, PackPair>();
    for (const f of files) {
      const m = /pack-([0-9a-f]{40})\.(pack|idx)$/.exec(f.name);
      if (!m) continue;
      const sha = m[1] as string;
      const kind = m[2] as 'pack' | 'idx';
      const existing =
        byShaes.get(sha) ??
        ({
          sha,
          packPath: this.packPath(sha),
          idxPath: this.idxPath(sha),
          hasPack: false,
          hasIdx: false,
          updatedAtMs: 0,
        } satisfies PackPair);
      if (kind === 'pack') existing.hasPack = true;
      else existing.hasIdx = true;
      existing.updatedAtMs = Math.max(existing.updatedAtMs, fileTimeMs(f));
      byShaes.set(sha, existing);
    }
    return [...byShaes.values()];
  }

  async listLoose(): Promise<Array<{ oid: Oid; path: string; updatedAtMs: number }>> {
    const [files] = await this.bucket.getFiles({ prefix: `${this.prefix}/` });
    const out: Array<{ oid: Oid; path: string; updatedAtMs: number }> = [];
    for (const f of files) {
      const rest = f.name.slice(this.prefix.length + 1);
      const m = /^([0-9a-f]{2})\/([0-9a-f]{38})$/.exec(rest);
      if (!m) continue;
      out.push({ oid: `${m[1]}${m[2]}`, path: f.name, updatedAtMs: fileTimeMs(f) });
    }
    return out;
  }

  async deletePath(path: string): Promise<void> {
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }

  /** Ranged GET. `end` is INCLUSIVE, as in HTTP `Range:` and GCS's own API. */
  private async readRange(path: string, start: number, end: number): Promise<Buffer | null> {
    try {
      const [bytes] = await this.bucket.file(path).download({ start, end });
      return bytes;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  /**
   * Does this .idx actually contain this oid?
   *
   * Real membership, by binary layout, not by "some pack exists". Both index
   * versions are handled because "we only ever write v2" is an assumption about
   * a file some other tool may have produced:
   *
   *   v2: magic \377tOc | u32 version=2 | u32 fanout[256] | 20-byte sha * N | ...
   *   v1: u32 fanout[256] | (u32 offset + 20-byte sha) * N
   *
   * The fanout table turns this into TWO SMALL RANGED READS regardless of pack
   * size: 1 KiB of fanout, then only the run of sorted hashes sharing the oid's
   * first byte (~N/256 entries). Downloading a 3 MB .idx on every push, on a
   * path that runs before every ref update, would have made the honest fence
   * too expensive to keep — which is how fences end up vestigial.
   */
  async idxContains(idxPath: string, oid: Oid): Promise<boolean> {
    const head = await this.readRange(idxPath, 0, 8 + 1024 - 1);
    if (head === null || head.length < 1024) return false;

    const isV2 = head.readUInt32BE(0) === 0xff744f63 && head.readUInt32BE(4) === 2;
    const fanoutAt = isV2 ? 8 : 0;
    const tableAt = isV2 ? 8 + 1024 : 1024;
    const stride = isV2 ? 20 : 24;
    const shaAt = isV2 ? 0 : 4;
    if (head.length < fanoutAt + 1024) return false;

    const firstByte = Number.parseInt(oid.slice(0, 2), 16);
    if (!Number.isInteger(firstByte)) return false;
    const lo = firstByte === 0 ? 0 : head.readUInt32BE(fanoutAt + (firstByte - 1) * 4);
    const hi = head.readUInt32BE(fanoutAt + firstByte * 4);
    if (hi <= lo) return false; // no object in this pack starts with that byte

    const slice = await this.readRange(idxPath, tableAt + lo * stride, tableAt + hi * stride - 1);
    if (slice === null) return false;

    const target = Buffer.from(oid, 'hex');
    if (target.length !== 20) return false;
    for (let i = 0; i + stride <= slice.length; i += stride) {
      if (slice.compare(target, 0, 20, i + shaAt, i + shaAt + 20) === 0) return true;
    }
    return false;
  }

  /**
   * The sha of a COMPLETE pack pair that really contains `oid`, or null.
   *
   * Incomplete pairs are skipped on purpose: `readObjectPacked` filters for
   * `*.idx`, so a `.pack` with no `.idx` is invisible to every reader and must
   * not count as durable — exactly the rule `writePackPair` encodes.
   */
  async packContaining(oid: Oid): Promise<string | null> {
    for (const pack of await this.listPacks()) {
      if (!pack.hasPack || !pack.hasIdx) continue;
      if (await this.idxContains(pack.idxPath, oid)) return pack.sha;
    }
    return null;
  }
}

function fileTimeMs(f: File): number {
  const meta = f.metadata as { timeCreated?: string; updated?: string };
  const stamp = meta.updated ?? meta.timeCreated;
  return stamp ? Date.parse(stamp) : 0;
}
