/**
 * 09-mcp / context.ts
 *
 * MODULE-LEVEL, PROCESS-WIDE STATE. This file is the reason the server can run
 * on Cloud Run at all.
 *
 * ---------------------------------------------------------------------------
 * THE PACKFILE CACHE
 * ---------------------------------------------------------------------------
 * isomorphic-git's `readObjectPacked` has NO ranged read -- `fs.read` takes
 * neither offset nor length -- so reading one byte of one packed object
 * downloads the ENTIRE packfile and SHA-1s all of it to verify the trailer
 * checksum. isomorphic-git memoises the parsed `.idx` and the pack buffer in
 * its `cache` argument, but `cache` DEFAULTS TO A FRESH `{}` PER API CALL.
 *
 * A stateless HTTP server that allocated a cache per request would re-download
 * and re-hash ~25 MB on every single tool call. So:
 *
 *   1. The isomorphic-git cache is obtained from 05-adapter with
 *      `gitCacheFor(fs)` and passed to EVERY isomorphic-git call in this
 *      package. There is a lint-by-eye rule: if you see `git.` without
 *      `cache: ctx.cache`, it is a bug.
 *   2. `packCache` (also 05-adapter) is a byte-level LRU under the fs adapter,
 *      keyed by bucket + GCS object key, so even a cold isomorphic-git cache
 *      entry does not pay for the network transfer twice.
 *
 * NOTE THE CACHE SCOPE, AND DO NOT WIDEN IT. It used to be one module-level
 * `gitCache` exported by 05-adapter and shared by the whole process. That is a
 * CROSS-TENANT LEAK: isomorphic-git keys the cache by absolute filepath, every
 * repo here is mounted at the same virtual gitdir, so two tenants in one
 * process collided on `${gitdir}/index` and one tenant's commit was measured
 * containing the other's file. The cache is now scoped to the adapter INSTANCE
 * by 05-adapter itself, which is why this reads it back off `rawFs` instead of
 * importing a shared object. The singleton below is a lifetime optimisation,
 * not the thing keeping tenants apart -- the adapter enforces that now.
 *
 * The lifetime is otherwise unchanged: the adapter lives for the life of the
 * container, so its cache survives across requests and dies with the instance.
 *
 * "Stateless" in the transport sense (no MCP session state, any instance can
 * serve any request) is unrelated to, and does not forbid, a process-local
 * cache of immutable bytes.
 *
 * ---------------------------------------------------------------------------
 * CLIENTS
 * ---------------------------------------------------------------------------
 * `new Firestore()` / `new Storage()` with no arguments = Application Default
 * Credentials. Both hold gRPC/HTTP connection pools that are expensive to
 * build, which is a second reason they are module-level.
 */

import { Firestore } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import { createFirestoreGcsFs, gitCacheFor, packCache } from '../../05-adapter/src/firestore-gcs-fs.js';
import type { GitFs } from '../../05-adapter/src/firestore-gcs-fs.js';

import { ObjectStore } from '../../07-refs/src/objects';
import { RefStore } from '../../07-refs/src/refs';

import type { Config } from './config';
import { assertPrefixesAgree } from './config';
import { guardRefWrites } from './ref-gate';

export interface ServerContext {
  cfg: Config;
  firestore: Firestore;
  storage: Storage;
  /** The guarded fs adapter. isomorphic-git only ever sees this one. */
  fs: GitFs;
  gitdir: string;
  /** THE hoisted isomorphic-git cache. Pass to every git.* call. */
  cache: Record<string, unknown>;
  refs: RefStore;
  objects: ObjectStore;
  startedAtMs: number;
}

let singleton: ServerContext | undefined;

/**
 * Build (once) and return the process-wide context.
 *
 * Called from the request path, not from module top level, so that a
 * misconfigured environment surfaces as a startup error from `loadConfig()`
 * rather than an unhandled rejection during module evaluation.
 */
export function getContext(cfg: Config): ServerContext {
  if (singleton) return singleton;

  assertPrefixesAgree(cfg);

  // `databaseId` is the ONE setting that cannot be supplied by the environment:
  // the client library reads no env var for it and silently falls back to the
  // constant `(default)`. Passing `{}` for `(default)` keeps the no-settings
  // behaviour byte-for-byte for anyone who did not create a named database.
  const firestore = new Firestore(
    cfg.databaseId && cfg.databaseId !== '(default)' ? { databaseId: cfg.databaseId } : {},
  );
  const storage = new Storage();
  const bucket = storage.bucket(cfg.bucket);

  // The raw adapter, then the ref-write firewall on top of it. Nothing in this
  // package is allowed to hold a reference to the unguarded fs.
  //
  // JUDGEMENT CALL -- the bucket and collection are passed BY NAME rather than
  // as the client objects built above, so the adapter constructs its own
  // Firestore/Storage from Application Default Credentials.
  //
  // HISTORY, because the original reason for this is now GONE and must not be
  // cited as still true: 05-adapter used to carry its own `node_modules` copy
  // of the Google client libraries, whose .d.ts files declare private members,
  // so `Bucket` here was NOMINALLY a different type from `Bucket` there --
  // and, far worse, the two copies' FieldValue sentinels rejected each other
  // at runtime on every write. The repo is an npm workspace now: there is ONE
  // copy on disk, `tools/check-single-copy.mjs` is a prebuild hook AND a gate
  // inside the container image, and the types are identical.
  //
  // Passing names is kept anyway because it is not a workaround for anything:
  // it keeps the adapter's construction its own business, costs one extra gRPC
  // channel and one extra HTTP client per process, and hides nothing. Do NOT
  // "fix" it by giving 05-adapter its own dependency tree again.
  //
  // AMENDED, and this is the reason: the adapter's own `new Firestore()` would
  // resolve `databaseId` to `(default)`. There is no environment variable that
  // redirects it. With a NAMED database (bringup.sh's FIRESTORE_CHOICE=named,
  // database `pc-mcp-git`) the ref layer would then have talked to `pc-mcp-git`
  // while the fs adapter talked to `(default)` — two different databases, one
  // of which does not exist. So the CLIENT is passed for Firestore, exactly as
  // `FirestoreGcsFsOptions.firestore` already provides for. This is NOT the old
  // second-dependency-tree workaround: there is one physical copy of the
  // library on disk (tools/check-single-copy.mjs, enforced in the image), so
  // the `Firestore` type here and there are the same class.
  //
  // The BUCKET is still passed by name — `new Storage()` needs no per-instance
  // setting and the adapter's own client is harmless.
  const rawFs = createFirestoreGcsFs({
    firestore,
    bucket: cfg.bucket,
    collection: cfg.filesCollection,
    objectPrefix: cfg.objectPrefix,
    objectsDirs: [`${cfg.gitdir}/objects`],
  });

  singleton = {
    cfg,
    firestore,
    storage,
    fs: guardRefWrites(rawFs),
    gitdir: cfg.gitdir,
    cache: gitCacheFor(rawFs),
    refs: new RefStore({
      firestore,
      rootCollection: cfg.refsRootCollection,
      writerId: cfg.writerId,
    }),
    // The SAME two values handed to createFirestoreGcsFs above. ObjectStore
    // derives the GCS key prefix from them with the adapter's own rule, so the
    // two halves cannot address different bytes. There is deliberately no
    // third string to keep in step any more.
    objects: new ObjectStore({ objectPrefix: cfg.objectPrefix, gitdir: cfg.gitdir, bucket }),
    startedAtMs: Date.now(),
  };

  return singleton;
}

/**
 * Exposed on /health so an operator can see the cache is doing its job.
 * A hit rate near zero on a warm instance means the hoist is broken somewhere.
 */
export function packCacheStats(): { hits: number; misses: number; bytesHeld: number } {
  return { hits: packCache.hits, misses: packCache.misses, bytesHeld: packCache.size };
}
