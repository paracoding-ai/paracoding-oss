/**
 * An isomorphic-git `fs` adapter backed by Cloud Storage + Firestore.
 *
 * LAYOUT (decided in 01-cost-model.md §3, layout (b)):
 *   `.git/objects/**`  -> Cloud Storage
 *   everything else    -> Firestore
 *
 * isomorphic-git writes history as ONE unsplittable packfile (`fetch.js` does a
 * single `fs.write` of the whole ~25 MB pack, then a single write of the
 * generated `.idx`). Firestore's 1 MiB document limit would force that into
 * ~28 chunk documents that cannot be committed atomically, so a concurrent
 * reader could observe a TORN PACKFILE -- a correctness defect, not a cost
 * problem. GCS stores the same bytes as one object via one atomic
 * `objects.insert`. Refs, HEAD, config and `.git/index` are small, hot, and are
 * where git's correctness lives, so they go to Firestore, where a transaction
 * gives serializable compare-and-swap and a get returns in ~10 ms.
 *
 * WIRING (02-fs-interface.md §1) -- three things that are easy to get wrong:
 *
 *  1. The ten methods are exposed TOP-LEVEL as `async` functions. There is
 *     deliberately NO `promises` property. isomorphic-git detects promise-style
 *     adapters by calling `readFile()` with ZERO ARGUMENTS and testing the
 *     result for `.then`/`.catch`. A non-async function that validates its
 *     argument and throws synchronously is caught, tests false, gets
 *     misdetected as callback-style, is wrapped in `pify`, and then every call
 *     HANGS FOREVER waiting for a callback that never fires. `async` makes the
 *     TypeError a rejection instead, which is a real Promise. Never make one of
 *     these a plain function.
 *
 *  2. All ten of readFile/writeFile/mkdir/rmdir/unlink/stat/lstat/readdir/
 *     readlink/symlink must exist. `bindFs` binds all ten with NO existence
 *     check, so a missing `readlink` is `TypeError: Cannot read properties of
 *     undefined (reading 'bind')` at the first API call -- despite the public
 *     docs calling readlink/symlink optional.
 *
 *  3. `rmdir` is declared with EXACTLY ONE parameter. `FileSystem.js:130` does
 *     `else if (fs.rmdir.length > 1) target._rm = fs.rmdir.bind(fs)` -- a
 *     two-parameter `rmdir` is silently adopted as the RECURSIVE delete
 *     implementation. There is a runtime assertion for this at the bottom of
 *     `createFirestoreGcsFs`.
 *
 * Credentials: Application Default Credentials throughout. No secrets in code.
 */

import { Firestore } from 'firebase-admin/firestore';
import type { CollectionReference } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import type { Bucket } from '@google-cloud/storage';

import type { Backend } from './backend.js';
import { FirestoreStore } from './firestore-store.js';
import { GcsStore } from './gcs-store.js';
import { PackCache } from './pack-cache.js';
import { fsError } from './errors.js';
import { dirname, normalizePath } from './paths.js';
import { type GitStats, type StoredNode, makeStats } from './stats.js';

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

/**
 * THE isomorphic-git CACHE -- ONE PER ADAPTER INSTANCE, NEVER PER PROCESS.
 *
 * WHY THIS IS NOT A MODULE-LEVEL `export const gitCache = {}` ANY MORE.
 * It used to be, and it leaked ACROSS TENANTS. isomorphic-git keys this cache
 * by ABSOLUTE FILEPATH and nothing else: `GitIndexManager.acquire` stores the
 * parsed index under `${gitdir}/index`. The gitdir is a VIRTUAL path chosen by
 * the caller, and every tenant in this system mounts its repo at the same one
 * (`/repo/.git`). Two tenants in one process therefore produced the SAME cache
 * key for two different repositories, and the second tenant's commit was
 * measured containing the first tenant's `secret.txt`.
 *
 * The repo prefix that keeps the GCS-side pack cache honest is NOT in this key
 * and cannot be put there -- the key belongs to isomorphic-git, not to us. So
 * the fix is to stop sharing the container: the cache is scoped to the adapter
 * instance, and an adapter instance is scoped to exactly one repo by
 * construction (one bucket, one prefix, one collection). Two tenants are two
 * adapters and therefore two caches, whatever paths they choose.
 *
 * It is NOT a weaker cache. `readObjectPacked` has no ranged read -- `fs.read`
 * takes no offset or length -- so reading one byte of one packed object pulls
 * the ENTIRE packfile into memory and SHA-1s all of it. isomorphic-git
 * memoises the parsed `.idx` and the pack Buffer here, but `cache` defaults to
 * a fresh `{}` PER API CALL, so without hoisting it every request re-downloads
 * and re-hashes ~25 MB. Hoisting to the adapter instance keeps exactly that
 * benefit: 09-mcp builds one adapter per process, so its hit rate is unchanged.
 * The lifetime is now tied to the adapter rather than to the module, which is
 * also why this can be a WeakMap and cannot leak caches for dead repos.
 */
const gitCaches = new WeakMap<GitFs, Record<string, unknown>>();

/**
 * The isomorphic-git `cache` for an adapter built by `createFirestoreGcsFs`.
 * Pass it to EVERY isomorphic-git call made against that adapter:
 *
 *     const fs = createFirestoreGcsFs(opts)
 *     await git.log({ fs, gitdir, cache: gitCacheFor(fs), ... })
 *
 * Throws for anything this factory did not build, rather than handing back a
 * fresh object that would silently be a cache miss on every call -- and rather
 * than letting a caller invent one shared object for two repos, which is the
 * bug this replaced.
 */
export function gitCacheFor(fs: GitFs): Record<string, unknown> {
  const cache = gitCaches.get(fs);
  if (cache === undefined) {
    throw new Error(
      'gitCacheFor: this fs was not created by createFirestoreGcsFs. Every ' +
        'isomorphic-git cache must be scoped to exactly one repo; there is no ' +
        'process-wide cache to fall back to.',
    );
  }
  return cache;
}

/**
 * A `cache` object whose isomorphic-git INDEX slot cannot preserve a dead
 * index.
 *
 * `GitIndexManager.acquire` does `if (!cache[IndexCache]) cache[IndexCache] =
 * {map, stats}` and then trusts `isIndexStale`, which is (isomorphic-git
 * index.js:1004):
 *
 *     const savedStats = cache.stats.get(filepath)
 *     if (savedStats === undefined) return true      // refresh
 *     if (savedStats === null) return false          // <-- never refreshes
 *     const currStats = await fs.lstat(filepath)
 *     if (currStats === null) return false           // <-- never refreshes
 *     return compareStats(savedStats, currStats)
 *
 * BOTH null branches PRESERVE the cached index when the index file is missing,
 * which is exactly backwards. `savedStats === null` means the index did not
 * exist when it was cached, so an index created later is never picked up.
 * `currStats === null` means the index has since been DELETED, and the parsed
 * in-memory copy keeps being served for the life of the process -- the same
 * "deleted, still served" shape as the packfile defect.
 *
 * `isIndexStale` is vendored isomorphic-git; we do not patch node_modules. But
 * we own the `cache` object it is handed, and its only input is
 * `stats.get(filepath)`. Returning `undefined` there takes the FIRST branch --
 * "stale" -- so `updateCachedIndexFile` re-reads the index. If the file is
 * gone, `fs.read` returns null and `GitIndex.from(null)` yields an EMPTY index
 * (index.js:703-704), which is eviction, not preservation.
 *
 * COST, STATED: the parsed-index memo is given up, so each
 * `GitIndexManager.acquire` re-reads and re-parses `.git/index` instead of
 * comparing one lstat. `.git/index` is a single Firestore document on the hot
 * path, and the alternative is a cache that cannot notice a deleted index at
 * all -- there is no third option, because the decision is made synchronously
 * inside `stats.get` and cannot consult the filesystem. The PACK memo, which is
 * the ~25 MB one and the reason this cache exists, is untouched.
 */
function makeScopedGitCache(): Record<string, unknown> {
  const harden = (slot: { map: Map<string, unknown>; stats: Map<string, unknown> }) => {
    const stats = slot.stats;
    return {
      map: slot.map,
      stats: {
        get: (_k: string) => undefined,
        set: (k: string, v: unknown) => stats.set(k, v),
        delete: (k: string) => stats.delete(k),
      },
    };
  };

  const isIndexSlot = (v: unknown): v is { map: Map<string, unknown>; stats: Map<string, unknown> } =>
    typeof v === 'object' &&
    v !== null &&
    (v as { map?: unknown }).map instanceof Map &&
    (v as { stats?: unknown }).stats instanceof Map;

  // Only the index slot is touched. Every other slot isomorphic-git keeps here
  // -- above all `PackfileCache`, the parsed `.idx` and pack Buffers -- is
  // stored verbatim, because those ARE content-addressed and immutable.
  return new Proxy({} as Record<string | symbol, unknown>, {
    set(target, prop, value) {
      target[prop] = isIndexSlot(value) ? harden(value) : value;
      return true;
    },
  }) as Record<string, unknown>;
}

const DEFAULT_PACK_CACHE_BYTES = Number(
  process.env.GIT_FS_PACK_CACHE_BYTES ?? 128 * 1024 * 1024,
);

/**
 * Transport-level byte cache for immutable packfiles, shared by every adapter
 * instance in the process.
 *
 * Sharing is safe here in a way that sharing `gitCache` was NOT, and for a
 * reason that has to be stated precisely, because the previous version of this
 * comment overstated it. The key is minted by GcsStore and is
 * `<bucket>\0<prefix><path>` -- bucket AND repo prefix, so no two tenants can
 * collide on it whatever virtual paths they use. And an entry is qualified by
 * the object's GCS generation and revalidated against live metadata on every
 * read, so a pack deleted or rewritten by any other instance stops being served
 * immediately. Immutability of the NAME is no longer load-bearing.
 */
export const packCache = new PackCache(DEFAULT_PACK_CACHE_BYTES);

/**
 * The root directory is virtual -- no document, no marker object. Its
 * timestamps are process-constant, which is normally the exact bug described in
 * stats.ts. It is safe HERE and only here: `compareStats` is only ever applied
 * to entries recorded in `.git/index`, and git never indexes a directory. No
 * regular file ever gets constant timestamps from this adapter.
 */
const ROOT_NODE: StoredNode = {
  kind: 'dir',
  size: 0,
  executable: false,
  mtimeMs: Date.now(),
  ctimeMs: Date.now(),
  ino: 1,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FirestoreGcsFsOptions {
  /** Bucket, or a bucket name to resolve via ADC. */
  bucket: Bucket | string;
  /**
   * Collection holding one document per non-object path, or a collection path
   * such as `repos/acme/files` to resolve via ADC. One collection per repo.
   */
  collection: CollectionReference | string;
  /** Reuse an existing client instead of constructing one from ADC. */
  firestore?: Firestore;
  storage?: Storage;
  /** GCS key prefix for this repo's objects, e.g. `repos/acme/`. */
  objectPrefix?: string;
  /**
   * Absolute, normalised paths of `objects` directories, for repos whose gitdir
   * is not literally named `.git` (bare repos, `gitdir` overrides). When
   * omitted, any path segment sequence `.git/objects` is treated as the
   * boundary.
   */
  objectsDirs?: string[];
  /** Override the shared pack cache (tests, or per-tenant isolation). */
  packCache?: PackCache;
}

/**
 * The ten methods, exactly. No `promises`, no `chmod`, no `cp`, no `rm`, and no
 * `_original_unwrapped_fs`.
 *
 * `rm` is deliberately absent so isomorphic-git falls back to its own
 * `rmRecursive` walker, which is built from readdir + lstat + unlink + rmdir.
 * `chmod` is declared in isomorphic-git's typedefs and has ZERO call sites --
 * `checkout.js` materialises a mode change as unlink + writeFile({mode}).
 * Defining `_original_unwrapped_fs` would make `new FileSystem(fs)` return our
 * raw object as if it were already wrapped, and every internal call would be
 * `undefined is not a function`.
 */
export interface GitFs {
  readFile(path: string, options?: unknown): Promise<Buffer | string>;
  writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<GitStats>;
  lstat(path: string): Promise<GitStats>;
  readlink(path: string, options?: unknown): Promise<Buffer | string>;
  symlink(target: string, path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Option / data coercion helpers
// ---------------------------------------------------------------------------

/**
 * isomorphic-git passes options in four distinct shapes at runtime:
 * `undefined`, `{}`, `{ encoding: 'utf8' }`, and the BARE STRING `'utf8'`.
 * Ignoring the encoding is a hard failure -- `GitConfigManager.get` hands the
 * result straight to `GitConfig.from(text)` which calls `.split()`, so a Buffer
 * there is `TypeError: text.split is not a function` at `git.currentBranch`.
 */
function encodingOf(options: unknown): string | undefined {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string') return enc;
  }
  return undefined;
}

/**
 * §2.5: unknown option keys must be IGNORED, not rejected. `{ autocrlf: 'true' }`
 * is an isomorphic-git-internal key that reaches `readFile` verbatim. Hence no
 * allow-list validation anywhere in this file.
 */
function modeOf(options: unknown): number | undefined {
  if (options && typeof options === 'object') {
    const mode = (options as { mode?: unknown }).mode;
    if (typeof mode === 'number') return mode;
  }
  return undefined;
}

function decode(bytes: Buffer, encoding: string | undefined): Buffer | string {
  if (!encoding || encoding === 'buffer') return bytes;
  return bytes.toString(encoding as BufferEncoding);
}

function toBuffer(data: unknown, encoding: string | undefined): Buffer {
  if (typeof data === 'string') {
    const enc = encoding && encoding !== 'buffer' ? encoding : 'utf8';
    return Buffer.from(data, enc as BufferEncoding);
  }
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError(
    `data must be a string, Buffer or TypedArray, received ${Object.prototype.toString.call(data)}`,
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Matches a path STRICTLY under a `.git/objects/` directory. */
const UNDER_OBJECTS = /(?:^|\/)\.git\/objects\//;
/** Matches `.git/objects` itself as well as everything under it. */
const AT_OR_UNDER_OBJECTS = /(?:^|\/)\.git\/objects(?:\/|$)/;

class Adapter {
  private readonly meta: Backend;
  private readonly objects: Backend;
  private readonly objectsDirs: string[] | undefined;

  constructor(opts: FirestoreGcsFsOptions) {
    const storage = opts.storage ?? new Storage();
    const bucket =
      typeof opts.bucket === 'string' ? storage.bucket(opts.bucket) : opts.bucket;

    const firestore = opts.firestore ?? new Firestore();
    const collection =
      typeof opts.collection === 'string'
        ? firestore.collection(opts.collection)
        : opts.collection;

    const cache = opts.packCache ?? packCache;
    this.objects = new GcsStore({
      bucket,
      prefix: opts.objectPrefix,
      packCache: cache,
    });
    // Overflow sink for Firestore-side content that exceeds the 1 MiB document
    // limit -- principally `.git/index`, which grows without bound with the
    // number of tracked files, and any working-tree file over ~1 MB. See the
    // MAX_CONTENT_BYTES comment in firestore-store.ts for why this is a spill
    // rather than an EFBIG. Its own `__spill/` prefix keeps it out of the
    // object store's key space, so a repo containing a literal `__spill`
    // directory still cannot collide with a real object.
    //
    // NO packCache ON THE OVERFLOW STORE. Spilled content is working-tree files
    // and `.git/index` -- mutable by definition. `isImmutablePackPath` matches
    // on the BASENAME, so a tracked file the user happened to name
    // `pack-<40 hex>.pack`, spilled here because it exceeds 1 MiB, would
    // otherwise be cached as if it were an immutable packfile and every
    // overwrite of it would have to be caught by revalidation. Nothing under
    // `__spill/` is ever a real packfile, so it is simpler and stricter not to
    // offer the cache at all.
    this.meta = new FirestoreStore({
      collection,
      overflow: new GcsStore({
        bucket,
        prefix: (opts.objectPrefix ?? '') + '__spill/',
      }),
    });
    this.objectsDirs = opts.objectsDirs?.map(normalizePath);
  }

  // -- routing ------------------------------------------------------------
  //
  // TWO predicates, not one, and the difference matters.
  //
  // The boundary directory `.git/objects` itself is METADATA in Firestore, so
  // `readdir('.git')` lists `objects` and the two stores agree on the shape of
  // the tree. Its CHILDREN live in GCS, so listing it and testing it for
  // emptiness must go to GCS. Collapsing these into one predicate breaks one
  // side or the other: route the boundary wholly to GCS and `.git/objects`
  // vanishes from `readdir('.git')`; route it wholly to Firestore and
  // `readdir('.git/objects')` returns nothing while the objects are physically
  // present -- which §2.3 calls out as a corruption class in its own right.

  /** Where this path's own metadata and bytes live. */
  private storeOf(path: string): Backend {
    if (this.objectsDirs) {
      return this.objectsDirs.some(d => path.startsWith(d + '/'))
        ? this.objects
        : this.meta;
    }
    return UNDER_OBJECTS.test(path) ? this.objects : this.meta;
  }

  /** Where this path's CHILDREN live. */
  private listStoreOf(path: string): Backend {
    if (this.objectsDirs) {
      return this.objectsDirs.some(d => path === d || path.startsWith(d + '/'))
        ? this.objects
        : this.meta;
    }
    return AT_OR_UNDER_OBJECTS.test(path) ? this.objects : this.meta;
  }

  // -- lookup primitives --------------------------------------------------

  private async node(path: string): Promise<StoredNode | null> {
    if (path === '/') return ROOT_NODE;
    return this.storeOf(path).getNode(path);
  }

  /**
   * Node at `path`, or the correct POSIX rejection.
   *
   * On a miss we probe the parent so that a leading component which is a
   * regular file yields ENOTDIR rather than ENOENT -- `FileSystem.exists()`
   * treats both as "false" (FileSystem.js:98-99), but `readdir` does NOT:
   * ENOTDIR becomes `null` (the sentinel `GitWalkerFs` uses for "not a tree")
   * while everything else becomes `[]`.
   *
   * JUDGEMENT CALL: only the IMMEDIATE parent is probed, not every leading
   * component. Full POSIX would walk the whole path. One extra lookup per miss
   * is already the dominant cost of `writeObjectLoose`'s existence check
   * (which misses by construction for every new object); walking N components
   * would multiply it by path depth for a distinction isomorphic-git only
   * draws one level deep in practice.
   */
  private async lookup(path: string, syscall: string): Promise<StoredNode> {
    const node = await this.node(path);
    if (node) return node;

    const parent = dirname(path);
    if (parent !== path) {
      const parentNode = await this.node(parent);
      if (parentNode && parentNode.kind !== 'dir') {
        throw fsError('ENOTDIR', syscall, path);
      }
    }
    throw fsError('ENOENT', syscall, path);
  }

  /**
   * `lookup` + symlink resolution, for the `stat`-family semantics.
   *
   * JUDGEMENT CALL: only the FINAL component is resolved; symlinked
   * intermediate directories are not followed. This is safe for isomorphic-git
   * specifically -- git materialises symlinks as mode-0o120000 blobs, which are
   * always leaf entries, and `utils/assertNoSymlinkInLeadingPath.js` walks
   * leading components with its own `lstat` calls rather than relying on the
   * adapter to resolve them. Full per-component resolution would cost one round
   * trip per path segment on every single stat.
   */
  private async resolve(
    path: string,
    syscall: string,
  ): Promise<{ path: string; node: StoredNode }> {
    let current = path;
    for (let hop = 0; hop < 40; hop++) {
      const node = await this.lookup(current, syscall);
      if (node.kind !== 'symlink') return { path: current, node };
      const target = node.target ?? '';
      current = target.startsWith('/')
        ? normalizePath(target)
        : normalizePath(dirname(current) + '/' + target);
    }
    throw fsError('ELOOP', syscall, path);
  }

  /** Assert that `dirname(path)` exists and is a directory. */
  private async requireParentDir(path: string, syscall: string): Promise<void> {
    const parent = dirname(path);
    const node = await this.node(parent);
    // §2.3: THIS ENOENT IS THE MKDIRP TRIGGER. `FileSystem.write` wraps every
    // `_writeFile` in try/catch and, on ANY failure, runs `mkdir(dirname(path))`
    // and retries. Directory creation for loose objects, refs and checked-out
    // subtrees happens ONLY because the first write fails. An object-store
    // adapter that cheerfully writes `a/b/c` with no `a/b` never creates the
    // directory markers, and then `readdir` finds nothing while the bytes are
    // physically present -- the repo reads as empty.
    if (!node) throw fsError('ENOENT', syscall, path);
    if (node.kind !== 'dir') throw fsError('ENOTDIR', syscall, path);
  }

  // -- the ten methods ----------------------------------------------------

  async readFile(path: string, options?: unknown): Promise<Buffer | string> {
    const p = normalizePath(path);
    const encoding = encodingOf(options);

    // Fast path: one backend round trip. Only if that comes back empty do we
    // spend lookups working out WHICH error this is, or following a symlink.
    const bytes = await this.storeOf(p).readFile(p);
    if (bytes !== null) return decode(bytes, encoding);

    const resolved = await this.resolve(p, 'open');
    if (resolved.node.kind === 'dir') throw fsError('EISDIR', 'read', p);

    const followed = await this.storeOf(resolved.path).readFile(resolved.path);
    // Never resolve null/undefined to mean "missing". `FileSystem.read`
    // catches unconditionally and returns null either way, but `stat`-driven
    // callers and `GitIndexManager` do not, and a silent empty index reads as
    // "everything is unstaged" (§3.3).
    if (followed === null) throw fsError('ENOENT', 'open', p);
    return decode(followed, encoding);
  }

  async writeFile(path: string, data: unknown, options?: unknown): Promise<void> {
    const p = normalizePath(path);
    const buffer = toBuffer(data, encodingOf(options));
    const mode = modeOf(options);

    // Both probes at once: they are independent, so this is one round trip of
    // latency rather than two. GCS Class B ops are ~$0.0004/1000; latency is
    // the scarce resource, not op count.
    const [existing] = await Promise.all([
      this.node(p),
      this.requireParentDir(p, 'open'),
    ]);
    if (existing && existing.kind === 'dir') {
      throw fsError('EISDIR', 'open', p);
    }

    // `normalizeMode` collapses permissions to 0755 if ANY execute bit is set,
    // else 0644 -- so a single boolean carries all the fidelity git can use.
    // A write with no mode means "regular file": checkout materialises a mode
    // change as unlink + writeFile({ mode: 0o777 }), never as an in-place chmod.
    await this.storeOf(p).writeFile(p, buffer, {
      executable: mode !== undefined ? (mode & 0o111) !== 0 : false,
    });
  }

  async unlink(path: string): Promise<void> {
    const p = normalizePath(path);
    // lstat semantics: unlink removes the link, not its target.
    const node = await this.lookup(p, 'unlink');
    if (node.kind === 'dir') throw fsError('EISDIR', 'unlink', p);
    await this.storeOf(p).removeFile(p);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalizePath(path);
    const resolved = await this.resolve(p, 'scandir');
    // ENOTDIR here, ENOENT above, and they are NOT interchangeable:
    // `FileSystem.readdir` maps ENOTDIR -> null and everything else -> [].
    // `hasObjectPacked` / `readObjectPacked` / `expandOidPacked` all do
    // `list.filter(...)` with no null check, so throwing ENOTDIR for a MISSING
    // `.git/objects/pack` would crash every packfile lookup with
    // "Cannot read properties of null".
    if (resolved.node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', p);

    const names = await this.listStoreOf(resolved.path).listChildren(resolved.path);
    // Belt and braces. `.` or `..` in a listing made `git.statusMatrix` hang
    // indefinitely -- the walker resolves `.` back to the same directory and
    // recurses forever. Both backends already exclude them; this is the last
    // gate before the names reach isomorphic-git.
    return names.filter(n => n !== '.' && n !== '..' && n !== '');
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw fsError('EEXIST', 'mkdir', p);

    const [existing] = await Promise.all([
      this.node(p),
      this.requireParentDir(p, 'mkdir'),
    ]);
    // EEXIST is what `FileSystem.mkdir` explicitly catches and treats as
    // success (FileSystem.js:171). ENOENT from `requireParentDir` above is what
    // drives its recursion to the parent (FileSystem.js:175). Any OTHER code
    // escapes `FileSystem.mkdir` unhandled.
    if (existing) throw fsError('EEXIST', 'mkdir', p);

    // Idempotent under concurrency by construction: `FileSystem.write`'s
    // mkdirp fires concurrently for sibling loose objects under
    // `.git/objects/xx/`, so two racing mkdirs are routine. Both write the
    // same marker; last write wins; the directory set is unchanged either way.
    await this.storeOf(p).makeDir(p);
  }

  // EXACTLY ONE DECLARED PARAMETER. `FileSystem.js:130` adopts a `rmdir` whose
  // `.length > 1` as the RECURSIVE delete implementation, and would then call
  // this with `{ recursive: true }` and expect a whole tree to disappear.
  // Adding a second parameter here -- even an ignored, cosmetic one -- makes
  // `git.checkout` and `abortMerge` throw ENOTEMPTY and leave a half-updated
  // working tree. Asserted at runtime in `createFirestoreGcsFs`.
  async rmdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '/') throw fsError('EPERM', 'rmdir', p);

    const node = await this.lookup(p, 'rmdir');
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', p);

    // ENOTEMPTY is the one wrong-error-code case that produces a VISIBLY broken
    // tree rather than a silent one: `checkout.js:209` catches exactly
    // ENOTEMPTY and logs "Did not delete X because directory is not empty";
    // any other code rethrows and aborts the checkout mid-write, leaving a
    // working tree that is neither the old nor the new commit.
    if (await this.listStoreOf(p).hasChildren(p)) {
      throw fsError('ENOTEMPTY', 'rmdir', p);
    }
    await this.storeOf(p).removeDir(p);
  }

  async stat(path: string): Promise<GitStats> {
    const p = normalizePath(path);
    return makeStats((await this.resolve(p, 'stat')).node);
  }

  async lstat(path: string): Promise<GitStats> {
    const p = normalizePath(path);
    return makeStats(await this.lookup(p, 'lstat'));
  }

  async readlink(path: string, options?: unknown): Promise<Buffer | string> {
    const p = normalizePath(path);
    const node = await this.lookup(p, 'readlink');
    if (node.kind !== 'symlink') throw fsError('EINVAL', 'readlink', p);
    const target = node.target ?? '';
    // `FileSystem.readlink` calls this with `{ encoding: 'buffer' }` and then
    // coerces anyway (`Buffer.isBuffer(link) ? link : Buffer.from(link)`), so
    // either return type is accepted; honour the request regardless.
    return encodingOf(options) === 'buffer' ? Buffer.from(target, 'utf8') : target;
  }

  /**
   * NOTE THE ARGUMENT ORDER: target first. `FileSystem.writelink(filename,
   * buffer)` calls `this._symlink(buffer.toString('utf8'), filename)` --
   * the wrapper swaps them.
   */
  async symlink(target: string, path: string): Promise<void> {
    const p = normalizePath(path);
    if (typeof target !== 'string') {
      throw new TypeError('symlink target must be a string');
    }
    const [existing] = await Promise.all([
      this.node(p),
      this.requireParentDir(p, 'symlink'),
    ]);
    if (existing) throw fsError('EEXIST', 'symlink', p);
    // Real symlinks in Firestore (a document with kind 'symlink' and a target),
    // EPERM under `.git/objects/` where a symlink can never legitimately
    // appear -- git stores symlinks as mode-0o120000 blobs, which are ordinary
    // object files.
    await this.storeOf(p).makeSymlink(target, p);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFirestoreGcsFs(opts: FirestoreGcsFsOptions): GitFs {
  const impl = new Adapter(opts);

  // Object-method shorthand, every one `async`. Declared here rather than
  // returning the class instance so the shape is auditable at a glance and so
  // no prototype method (e.g. a future `promises` getter, or `chmod`) can leak
  // onto the object isomorphic-git sniffs.
  const fs: GitFs = {
    async readFile(path: string, options?: unknown) {
      return impl.readFile(path, options);
    },
    async writeFile(path: string, data: unknown, options?: unknown) {
      return impl.writeFile(path, data, options);
    },
    async unlink(path: string) {
      return impl.unlink(path);
    },
    async readdir(path: string) {
      return impl.readdir(path);
    },
    async mkdir(path: string) {
      return impl.mkdir(path);
    },
    async rmdir(path: string) {
      return impl.rmdir(path);
    },
    async stat(path: string) {
      return impl.stat(path);
    },
    async lstat(path: string) {
      return impl.lstat(path);
    },
    async readlink(path: string, options?: unknown) {
      return impl.readlink(path, options);
    },
    async symlink(target: string, path: string) {
      return impl.symlink(target, path);
    },
  };

  // Fail loudly at construction rather than silently corrupting a checkout
  // months later. See the comment on `Adapter.rmdir`.
  if (fs.rmdir.length !== 1) {
    throw new Error(
      `fs.rmdir must declare exactly one parameter (got ${fs.rmdir.length}); ` +
        'isomorphic-git treats rmdir.length > 1 as a recursive-delete implementation',
    );
  }
  // The promise-detection probe calls readFile() with zero arguments and needs
  // a real thenable back. A non-async method here would throw synchronously,
  // be misdetected as callback-style, and hang every subsequent call forever.
  const probe = fs.readFile(undefined as unknown as string);
  if (typeof probe?.then !== 'function' || typeof probe?.catch !== 'function') {
    throw new Error('fs.readFile() must return a Promise when called with no arguments');
  }
  probe.catch(() => {});

  // One cache per adapter, minted here so a caller CANNOT hand the same cache
  // to two repos. Registered in a WeakMap rather than as a property on `fs`
  // because the object isomorphic-git sniffs must keep exactly the ten methods
  // and nothing else.
  gitCaches.set(fs, makeScopedGitCache());

  return fs;
}

export { PackCache } from './pack-cache.js';
export { fsError } from './errors.js';
export type { FsError, FsErrorCode } from './errors.js';
export type { GitStats, StoredNode } from './stats.js';
export { normalizePath, dirname, basename } from './paths.js';
