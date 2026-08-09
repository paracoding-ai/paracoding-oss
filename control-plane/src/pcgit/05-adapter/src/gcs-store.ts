/**
 * Cloud Storage backend -- holds everything under `.git/objects/`.
 *
 * WHY GCS FOR OBJECTS (01-cost-model.md sec 3): isomorphic-git writes history as
 * ONE unsplittable `fs.write` of a whole packfile (fetch.js writes the pack
 * verbatim, then the generated `.idx`, as two single writes). At a realistic
 * 25 MB that is 24x Firestore's 1 MiB document limit, forcing ~28 chunk
 * documents that cannot be committed atomically -- so a concurrent reader can
 * observe a TORN PACKFILE. GCS stores the same bytes as one object written by
 * one atomic `objects.insert`, with free same-region transfer to Cloud Run.
 *
 * Object stores have no directories, so directories are an EXPLICIT set of
 * zero-byte marker objects whose name ends in `/` (02-fs-interface.md sec 5).
 * Inferring directories from key prefixes is not good enough: git genuinely
 * creates empty directories (`.git/objects/pack` is empty until the first
 * fetch, `.git/refs/heads` is empty in a fresh repo) and a prefix-inference
 * scheme cannot represent them.
 *
 * Credentials: Application Default Credentials only. No key material here.
 */

import type { Bucket, File, FileMetadata } from '@google-cloud/storage';
import type { Backend } from './backend.js';
import { type StoredNode, to32 } from './stats.js';
import { fsError, isNotFound, isPreconditionFailed } from './errors.js';
import { PackCache, isImmutablePackPath } from './pack-cache.js';
import { vaultDecryptMaybe, getVaultMaster, plaintextSize } from './vault-objenc.js'; // PCV1-READ-V1
// PCV1-WRITE-V1 ONE write policy, shared with 07-refs' ObjectStore. Neither
// writer contains the predicate: encryptForStore() decides from the KEY, so
// the two independent GCS clients over this key space cannot drift. That
// matters most for `.idx`, which git.indexPack() writes through THIS path
// during a repack but which ObjectStore.idxContains() ranged-reads.
import { encryptForStore, withPtsize } from './vault-objwrite.js';

// Cache-key separator. Built with String.fromCharCode(0) rather than a backslash escape:
// the escape does not survive every transport this source travels through, and a silent
// downgrade to a space would make 'bucket' + ' ' + 'a b' collide with 'bucket' + ' ' + 'a b'.
// A NUL cannot appear in a bucket name or an object key, so it is the only safe separator.
const NUL = String.fromCharCode(0);

export interface GcsStoreOptions {
  bucket: Bucket;
  /** Key prefix for this repo, e.g. `repos/acme/`. Normalised to end in `/`. */
  prefix?: string;
  /**
   * OPTIONAL. Omit it and this store caches nothing. The `__spill/` overflow
   * store omits it on purpose: a working-tree file over 1 MiB that happens to
   * be named `pack-<40 hex>.pack` is NOT a packfile and is NOT immutable, so it
   * must never enter a cache keyed on that name.
   */
  packCache?: PackCache;
}

interface ApiListResponse {
  prefixes?: string[];
}

export class GcsStore implements Backend {
  private readonly bucket: Bucket;
  private readonly prefix: string;
  private readonly packCache: PackCache | undefined;

  constructor(opts: GcsStoreOptions) {
    this.bucket = opts.bucket;
    const p = opts.prefix ?? '';
    this.prefix = p === '' || p.endsWith('/') ? p : p + '/';
    this.packCache = opts.packCache;
  }

  /** `/a/b` -> `<prefix>a/b`. Input is always a normalised absolute path. */
  private key(path: string): string {
    return this.prefix + path.slice(1);
  }

  /**
   * Cache key. The object key alone is NOT unique across tenants: two repos on
   * DIFFERENT buckets can share a prefix (trivially, two tenants that both take
   * the default empty prefix), and would then collide on every object name.
   * The bucket is part of the identity of the bytes, so it is part of the key.
   * NUL can occur in neither a bucket name nor an object key, so the join is
   * unambiguous.
   */
  private cacheKey(path: string): string {
    return `${this.bucket.name}${NUL}${this.key(path)}`;
  }

  /** Directory marker key: `/a/b` -> `<prefix>a/b/`; root -> `<prefix>`. */
  private dirKey(path: string): string {
    return path === '/' ? this.prefix : this.key(path) + '/';
  }

  private async metadataOf(key: string): Promise<FileMetadata | null> {
    try {
      const [metadata] = await this.bucket.file(key).getMetadata();
      return metadata;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Map GCS object metadata onto a StoredNode.
   *
   * THE MTIME/INO MAPPING -- see the block comment in stats.ts for the
   * corruption this prevents. `updated` is the object's most recent
   * modification time and `generation` is a NEW value assigned on every
   * overwrite, so both genuinely move on every write. `generation` is what
   * closes git's sub-second "racy" window, because `compareStats` only
   * compares mtime at one-second granularity.
   *
   * The fallbacks are deliberately "always look changed" rather than
   * "constant": a missing `updated` yields `Date.now()`, which over-reports
   * change (a wasted re-hash) instead of under-reporting it (silent data loss).
   */
  private nodeFrom(metadata: FileMetadata, kind: 'file' | 'dir'): StoredNode {
    const updatedMs = metadata.updated ? Date.parse(metadata.updated) : NaN;
    const createdMs = metadata.timeCreated ? Date.parse(metadata.timeCreated) : NaN;
    const mtimeMs = Number.isFinite(updatedMs)
      ? updatedMs
      : Number.isFinite(createdMs)
        ? createdMs
        : Date.now();

    let ino: number;
    if (metadata.generation !== undefined && metadata.generation !== null) {
      ino = to32(BigInt(metadata.generation));
    } else {
      // No generation => fall back to the timestamp, which at least moves.
      ino = to32(mtimeMs);
    }

    return {
      kind,
      // PCV1-READ-V1 stat() must report the PLAINTEXT length: isomorphic-git
      // stores stat.size in .git/index and compareStats branches on it, so a
      // uniformly +34 size makes every indexed file look modified forever.
      // No `ptsize` means the object is plaintext, so this is a no-op today.
      size: kind === 'dir' ? 0 : plaintextSize(Number(metadata.size ?? 0), metadata.metadata as Record<string, string | undefined> | undefined),
      executable: metadata.metadata?.mode === '755',
      mtimeMs,
      ctimeMs: mtimeMs,
      ino,
    };
  }

  async getNode(path: string): Promise<StoredNode | null> {
    // File first: the hot path is `writeObjectLoose`'s existence check on a
    // loose object, which is a file. Directories cost a second round trip.
    const fileMeta = await this.metadataOf(this.key(path));
    if (fileMeta) return this.nodeFrom(fileMeta, 'file');

    const dirMeta = await this.metadataOf(this.dirKey(path));
    if (dirMeta) return this.nodeFrom(dirMeta, 'dir');

    return null;
  }

  /**
   * THE COHERENCE RULE (multi-instance assertion 61).
   *
   * A cached packfile is served ONLY after its generation has been revalidated
   * against the live object metadata -- the SAME `getMetadata` call `getNode`
   * makes for `stat`. That is the whole point: `stat` and `readFile` now read
   * their existence answer from one source, so they cannot disagree, and a pack
   * deleted by a repack on ANOTHER instance stops being served here on the very
   * next read rather than lingering until this container dies.
   *
   * What the cache still buys, which is the part that mattered: the object BODY
   * is not transferred. `readObjectPacked` has no ranged read, so a miss is a
   * whole ~25 MB download plus a SHA-1 over all of it. A revalidation is one
   * small metadata RPC. We trade a cheap round trip for the right answer, not a
   * 25 MB one.
   */
  async readFile(path: string): Promise<Buffer | null> {
    const key = this.key(path);
    const cache = this.packCache;

    if (cache === undefined || !isImmutablePackPath(path)) {
      try {
        const [bytes] = await this.bucket.file(key).download();
        // PCV1-READ-V1 dual-read: no PCV1 magic returns the bytes verbatim.
        return vaultDecryptMaybe(getVaultMaster(), key, bytes);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    }

    const ck = this.cacheKey(path);
    const metadata = await this.metadataOf(key);
    if (metadata === null) {
      // Authoritatively gone. Drop the bytes so the next reader does not even
      // pay the revalidation, and report the same ENOENT `stat` reports.
      cache.delete(ck);
      return null;
    }

    const generation =
      metadata.generation !== undefined && metadata.generation !== null
        ? String(metadata.generation)
        : '';

    const hit = cache.get(ck, generation);
    if (hit) return hit;

    try {
      const [raw] = await this.bucket.file(key).download();
      // PCV1-READ-V1 DECRYPT BEFORE CACHING. Caching `raw` here would make
      // every cache hit return ciphertext while every miss returned a good
      // packfile -- an intermittent corruption that depends on cache warmth.
      const bytes = vaultDecryptMaybe(getVaultMaster(), key, raw);
      cache.set(ck, bytes, generation);
      return bytes;
    } catch (err) {
      if (isNotFound(err)) {
        // Deleted between the metadata probe and the download.
        cache.delete(ck);
        return null;
      }
      throw err;
    }
  }

  async writeFile(
    path: string,
    data: Buffer,
    opts: { executable: boolean },
  ): Promise<void> {
    await this.writeFileReturningGeneration(path, data, opts);
  }

  /**
   * `writeFile`, but handing back the GENERATION GCS assigned to this write.
   *
   * The spill store needs it. Its blob keys are content-addressed, so a key can
   * only be created and never rebound  --  which is what makes an overwrite
   * crash-safe, and also what makes the predecessor blob a permanent orphan
   * unless someone deletes it. Deleting it UNCONDITIONALLY is not safe even
   * under content addressing: a concurrent writer that happens to write the OLD
   * CONTENT again computes the SAME key, re-installs it, and commits its
   * document, at which point our delete unlinks bytes the live document names.
   * A generation makes the delete conditional, so a re-installed key (new
   * generation) survives and merely becomes reclaimable garbage.
   *
   * `null` means the client did not surface one; callers must then treat the
   * blob as un-reclaimable-in-line and leave it to `reclaimSpillOrphans`.
   */
  async writeFileReturningGeneration(
    path: string,
    data: Buffer,
    opts: { executable: boolean },
  ): Promise<string | null> {
    const key = this.key(path);
    const file = this.bucket.file(key);
    // PCV1-WRITE-V1 AAD is `key`: the FULL GCS object key, e.g.
    // `<repo-prefix>/.git/objects/ab/cdef...`. NOT the adapter's virtual
    // path -- two tenants both mount `/repo/.git`, so virtual paths collide.
    // The epoch is stamped into the header by the writer; the reader derives
    // its key from the epoch byte ON THE OBJECT, which is what makes a KEM
    // pivot an epoch bump rather than a flag day.
    const stored = encryptForStore(getVaultMaster(), key, data);
    await file.save(stored.bytes, {
      resumable: false,
      contentType: 'application/octet-stream',
      metadata: {
        cacheControl: 'no-store',
        // PCV1-WRITE-V1 `ptsize` carries the PLAINTEXT length for stat().
        // withPtsize() adds the key ONLY when the object was encrypted:
        // ABSENT ptsize is what tells plaintextSize() an object is plaintext,
        // and that must stay true for markers, .idx and the legacy corpus.
        metadata: withPtsize({ mode: opts.executable ? '755' : '644' }, stored),
      },
    });
    // A freshly written packfile is almost always read back immediately (fetch
    // writes the pack, then `GitPackIndex.fromPack` indexes it). Seeding the
    // cache here saves the body transfer on that read.
    //
    // The seed carries the generation the write produced, so the read-back
    // revalidates against it and hits. If the client did not surface a
    // generation we simply do not seed: an entry that can never be revalidated
    // is an entry that can never be served, and holding it would only consume
    // budget.
    const gen = file.metadata?.generation;
    if (this.packCache !== undefined && isImmutablePackPath(path)) {
      if (gen !== undefined && gen !== null) {
        // PCV1-WRITE-V1 SEED THE PLAINTEXT `data`, NEVER `stored.bytes`. The
        // cache sits BEHIND the decrypt in readFile, so its contract is
        // plaintext. Seeding ciphertext here would make every cache HIT
        // return ciphertext while every MISS returned a good packfile --
        // corruption that depends on how warm the process is, and that
        // every presence check passes.
        this.packCache.set(this.cacheKey(path), data, String(gen));
      }
    }
    return gen === undefined || gen === null ? null : String(gen);
  }

  async removeFile(path: string): Promise<void> {
    const key = this.key(path);
    // Local eviction is a courtesy, not the mechanism. It saves THIS instance a
    // revalidation; it does nothing for any other instance, which is why
    // `readFile` revalidates rather than trusting this.
    this.packCache?.delete(this.cacheKey(path));
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }

  /**
   * Delete `path` ONLY IF it is still the generation we were told to expect.
   *
   * `ifGenerationMatch` is a server-side precondition, so this is not a
   * check-then-act: GCS answers 412 and deletes nothing if anything has
   * rewritten the object since. That is the whole safety argument for
   * reclaiming a content-addressed spill blob  --  see
   * `writeFileReturningGeneration`.
   *
   * @returns true if the object was deleted or was already gone; false if the
   *          precondition failed, i.e. someone else owns those bytes now.
   */
  async removeFileIfGeneration(path: string, generation: string): Promise<boolean> {
    const key = this.key(path);
    this.packCache?.delete(this.cacheKey(path));
    try {
      await this.bucket.file(key).delete({ ignoreNotFound: true, ifGenerationMatch: generation });
      return true;
    } catch (err) {
      if (isPreconditionFailed(err)) return false;
      if (isNotFound(err)) return true;
      throw err;
    }
  }

  /**
   * FLAT listing of every object under this store's prefix, with the metadata a
   * reachability sweep needs. Paths come back in this store's own space (a
   * leading `/`), so they can be compared directly against the keys stored in
   * documents and handed straight back to `removeFileIfGeneration`.
   *
   * NO `delimiter` here  --  the spill key space is two levels deep
   * (`/<sha256(path)>/<sha256(content)>`) and a delimited listing would only
   * ever return the first level. `autoPaginate` stays off for the reason
   * `list()` documents: with it on, the library keeps only the LAST page's raw
   * response, and a truncated listing here would look like "everything else is
   * an orphan".
   */
  async listAll(): Promise<
    Array<{ path: string; size: number; updatedAtMs: number; generation: string | null }>
  > {
    const out: Array<{ path: string; size: number; updatedAtMs: number; generation: string | null }> = [];
    let pageToken: string | undefined;

    do {
      const [files, nextQuery] = await this.bucket.getFiles({
        prefix: this.prefix,
        autoPaginate: false,
        maxResults: 1000,
        pageToken,
      });
      for (const file of files as File[]) {
        const rest = file.name.slice(this.prefix.length);
        // The prefix's own marker object, if one was ever created.
        if (rest === '' || rest.endsWith('/')) continue;
        const md = file.metadata ?? {};
        const updated = md.updated ? Date.parse(md.updated) : NaN;
        out.push({
          path: '/' + rest,
          size: Number(md.size ?? 0),
          // A missing timestamp reads as "just written", which makes the grace
          // period keep it. Over-retaining is recoverable; over-deleting is not.
          updatedAtMs: Number.isFinite(updated) ? updated : Date.now(),
          generation:
            md.generation === undefined || md.generation === null ? null : String(md.generation),
        });
      }
      pageToken = (nextQuery as { pageToken?: string } | undefined)?.pageToken;
    } while (pageToken);

    return out;
  }

  async makeDir(path: string): Promise<void> {
    // PCV1-WRITE-V1 DIRECTORY MARKERS STAY PLAINTEXT, deliberately and
    // permanently. dirKey() ends in '/', so encryptForStore() would exempt
    // it anyway; the write is left raw so there is no doubt. A marker is
    // zero bytes and its NAME -- the only thing it carries -- is plaintext
    // by design. Encrypting one makes it 34 bytes, at which point
    // pcgit-export.py's strip_directory_markers (which identifies markers by
    // `getsize(p) == 0`) stops recognising it, it survives into objects/,
    // and git fsck reports garbage files.
    await this.bucket.file(this.dirKey(path)).save(Buffer.alloc(0), {
      resumable: false,
      contentType: 'application/x-directory',
    });
  }

  async removeDir(path: string): Promise<void> {
    await this.bucket.file(this.dirKey(path)).delete({ ignoreNotFound: true });
  }

  async listChildren(path: string): Promise<string[]> {
    return this.list(path, Infinity);
  }

  async hasChildren(path: string): Promise<boolean> {
    return (await this.list(path, 1)).length > 0;
  }

  /**
   * List immediate children using `delimiter: '/'`, which makes GCS roll every
   * deeper key up into `prefixes`. Two sources of names:
   *   - items:    objects directly in this directory (files, and the
   *               directory's OWN marker, which must be filtered out)
   *   - prefixes: every subdirectory, including ones that exist only as an
   *               empty marker object
   *
   * `autoPaginate` is off ON PURPOSE. With it on, the library exhausts pages
   * for `items` but hands back only the LAST page's raw response, so
   * `prefixes` from earlier pages are lost and subdirectories silently
   * disappear from the listing -- which sec 5.3 warns makes every nested file
   * absent from every commit. Paginating by hand keeps both halves complete.
   * `.git/objects/xx/` and `.git/objects/pack` must never be truncated.
   */
  private async list(path: string, limit: number): Promise<string[]> {
    const prefix = this.dirKey(path);
    const names = new Set<string>();
    let pageToken: string | undefined;

    do {
      const [files, nextQuery, apiResponse] = await this.bucket.getFiles({
        prefix,
        delimiter: '/',
        autoPaginate: false,
        maxResults: 1000,
        pageToken,
      });

      for (const file of files as File[]) {
        const rest = file.name.slice(prefix.length);
        // `rest === ''` is this directory's own marker object.
        // A `/` in `rest` cannot happen under a delimiter query, but guard
        // anyway -- a nested name must never leak out as a child basename.
        if (rest === '' || rest.includes('/')) continue;
        names.add(rest);
      }

      for (const sub of (apiResponse as ApiListResponse | undefined)?.prefixes ?? []) {
        const rest = sub.slice(prefix.length).replace(/\/+$/, '');
        if (rest !== '' && !rest.includes('/')) names.add(rest);
      }

      if (names.size >= limit) break;
      pageToken = (nextQuery as { pageToken?: string } | undefined)?.pageToken;
    } while (pageToken);

    // Never `.` or `..`: including them hung `git.statusMatrix` forever (sec 5.3).
    // They cannot arise from a GCS listing, but the invariant is asserted here
    // so it is checked at the only place child names are produced.
    names.delete('.');
    names.delete('..');
    return [...names];
  }

  async makeSymlink(_target: string, path: string): Promise<void> {
    // Nothing under `.git/objects/` is ever a symlink -- git stores symlinks as
    // mode-0o120000 blobs, which are ordinary object files here.
    throw fsError('EPERM', 'symlink', path, 'symlinks are not supported in the object store');
  }
}
