/**
 * 07-refs / repair.ts
 *
 * The verify + repair + garbage-collect routine.
 *
 * This is the descendant of git-remote-s3's `doctor` command — but with its
 * original job removed. `doctor` exists mainly to clear orphaned TTL locks and
 * to reconcile the "two bundles for one ref" state that their lockless path
 * can produce. We have no locks and cannot produce two heads for one ref, so
 * neither job exists here. What remains is the job git's own `gc` does, which
 * isomorphic-git does not implement at all:
 *
 *   - verify   : does every ref point at a complete, readable object graph?
 *   - sweep    : delete unreachable objects older than a grace period
 *   - repack   : collapse N packs into 1, because isomorphic-git never does
 *   - tornPacks: delete .pack files whose .idx never landed
 *   - spill    : delete `__spill/` blobs no Firestore document names (optional
 *                dep; see RepairDeps.spill). This prefix was swept by nothing
 *                at all until it was added here.
 *
 * THE GRACE PERIOD IS LOAD-BEARING. An in-flight push has, by design, written
 * its objects to GCS but not yet moved the ref. Those objects are unreachable
 * and a naive mark-and-sweep would delete them out from under a push that is
 * about to succeed — turning our safe ordering into the exact corruption it
 * was designed to prevent. The grace period must exceed the longest possible
 * push. This is precisely why git's own gc defaults to --prune=2.weeks.ago
 * rather than pruning everything unreachable.
 *
 * IT APPLIES TO ALL THREE DELETING PATHS, not two. For a while it guarded only
 * loose objects and torn packs, because those are the two deletions inside
 * sweepUnreachable() — while repackReachable() retired whole packs on a
 * separate path with no age check at all. A push landing a new pack during the
 * verify walk was therefore absent from `reachable`, absent from the
 * replacement pack, and deleted: the gc reproducing the exact corruption this
 * paragraph exists to rule out, on the path where the pusher did everything
 * right. See the guards inside repackReachable().
 *
 * AND AN AGE GUARD IS NOT ENOUGH BY ITSELF, on any of them. It is a proxy for
 * "is a push still in flight?", and the proxy fails whenever an object's
 * `updated` stamp is older than the push that is about to reference it — which
 * is the normal state of affairs for a RETRIED push, because its objects were
 * written by the attempt that crashed. So every deleting path also re-reads the
 * ref tips and refuses to delete anything if one moved since the verify walk.
 * Both guards, on both paths:
 *
 *   sweepUnreachable()  age + refs   (loose objects, torn packs)
 *   repackReachable()   age + refs   (whole packs)
 *
 * The refs guard is checked BEFORE any bytes are written or deleted, so an
 * aborted run is a no-op rather than a run that leaves a new pack behind.
 */

import * as git from 'isomorphic-git';

import type { ObjectStore } from './objects';
import type { RefStore } from './refs';
import type { Oid } from './model';

export interface RepairDeps {
  refs: RefStore;
  objects: ObjectStore;
  fs: git.FsClient;
  gitdir: string;
  /**
   * Synthetic working-tree root. We never check anything out (01-cost-model
   * recommendation #2: noCheckout), so nothing is ever written here — but
   * git.indexPack REQUIRES it. Verified in isomorphic-git 1.40.0:
   *
   *     assertParameter('dir', dir);
   *     assertParameter('gitdir', dir);   // <- their typo; still asserts dir
   *     ...
   *     filepath = join(dir, filepath);
   *
   * i.e. indexPack resolves its filepath against the WORKING TREE, not the
   * gitdir, and throws MissingParameterError if dir is absent. Every other
   * plumbing call we make takes gitdir alone. Set dir such that
   * gitdir === join(dir, '.git').
   */
  dir: string;
  cache: object;
  /**
   * OPTIONAL. The metadata store's spilled-content reclaimer (05-adapter's
   * `FirestoreStore.reclaimSpillOrphans`), kept STRUCTURAL so 07-refs does not
   * take a dependency on the adapter.
   *
   * WHY IT BELONGS IN `doctor`. Oversized file content lives in GCS under a
   * `__spill/` prefix keyed by `sha256(path)/sha256(content)`, written BEFORE
   * the Firestore document that names it. That ordering is what makes an
   * overwrite crash-safe, and it is also what leaves an orphan whenever the
   * process dies between the two writes, or a large file is overwritten by a
   * small one. The adapter reclaims the ordinary overwrite chain in line; these
   * residues are reachability garbage and reachability is exactly what this
   * routine already computes for `objects/`. Before this hook, `__spill/` was
   * swept by NOTHING: `sweepUnreachable` only ever looks under
   * `objectsKeyPrefix`, and the promise that orphans were "recoverable offline"
   * had no tool behind it.
   *
   * Same rule as everything else here: age is a grace period, not a policy. Do
   * NOT put a GCS lifecycle rule on `__spill/` -- a two-year-old blob can be
   * the live content of a file nobody has touched in two years.
   */
  spill?: {
    reclaimSpillOrphans(opts?: { graceMs?: number; dryRun?: boolean }): Promise<SpillReclaim>;
  };
}

/** Structural mirror of 05-adapter's `SpillReclaimReport`. */
export interface SpillReclaim {
  deleted: string[];
  bytesReclaimed: number;
  skippedYoung: number;
  live: number;
  dryRun: boolean;
}

export interface BrokenRef {
  ref: string;
  oid: Oid;
  /** The first reachable oid that could not be read. */
  missingOid: Oid;
  /** Path from the ref tip down to the missing object, for diagnosis. */
  path: Oid[];
}

export interface VerifyReport {
  repoId: string;
  refsChecked: number;
  reachableObjects: number;
  brokenRefs: BrokenRef[];
  /** .pack present, .idx absent. Invisible to readers, so harmless, but wasted bytes. */
  tornPacks: string[];
  /** .idx present, .pack absent. MUST NOT HAPPEN under our write ordering.
   *  If this is ever non-empty, something wrote a pack pair out of order. */
  danglingIdx: string[];
  packCount: number;
  looseCount: number;
}

const NOT_FOUND = 'NotFoundError';

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  return code === NOT_FOUND || name === NOT_FOUND;
}

/**
 * An oid a `.idx` claims, in a pack whose bytes are unreadable. The twin of
 * push.ts `isUnreadablePack` — deliberately a second copy, because these two
 * modules already keep their own `isNotFound` and neither may take a runtime
 * dependency on the other; keep them in step.
 *
 * `readObjectPacked` does not raise `NotFoundError` for this: it finds the oid
 * in the fanout, `fs.read(packFile)` returns null, and it throws
 * `InternalError("Could not read packfile at ...")`. For a VERIFIER that is
 * ordinary input, not an internal fault — it is precisely the "`.idx` without
 * readable `.pack`" state `danglingIdx` exists to report — so it must come out
 * as a broken ref rather than aborting the walk with an opaque error.
 *
 * This became reachable when the verify walk stopped inheriting the caller's
 * isomorphic-git cache (see `verifyRepo`) and when 05-adapter's PackCache
 * started revalidating GCS generations: before, a deleted pack was still
 * readable from memory and the gap was invisible.
 */
function isUnreadablePack(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; data?: { message?: unknown } } | null;
  if (e?.code !== 'InternalError' && e?.name !== 'InternalError') return false;
  const detail = typeof e?.data?.message === 'string' ? e.data.message : String((e as Error).message);
  return /packfile/i.test(detail);
}

/**
 * Walk the full object closure of every ref, confirming each object is
 * readable through the same code path a real reader uses. Returns the
 * reachable set as a side product, which sweep() then consumes.
 */
export async function verifyRepo(
  deps: RepairDeps,
  repoId: string,
): Promise<{
  report: VerifyReport;
  reachable: Set<Oid>;
  /** The tips this walk was derived from. repackReachable uses them to notice
   *  that `reachable` went stale while the walk was running. */
  refsAtVerify: ReadonlyArray<{ ref: string; oid: Oid }>;
}> {
  const { refs, objects, fs, gitdir, cache } = deps;

  const allRefs = await refs.listRefs(repoId);
  const reachable = new Set<Oid>();
  const brokenRefs: BrokenRef[] = [];

  // THE VERIFY WALK USES ITS OWN CACHE, NEVER `deps.cache`. push.ts's fence
  // documents this function as the control that catches what the fence's
  // cache-served closure walk cannot, and that claim is only true if the walk
  // is genuinely cache-blind. `deps.cache` is the caller's hoisted
  // isomorphic-git cache; its `PackfileCache` slot memoises the parsed `.idx`
  // AND the pack Buffer (`p.pack`) keyed by the virtual path, and nothing
  // revalidates it against storage — so a pack GCS has already deleted still
  // reads out of it, and `verifyRepo` would certify a closure that is not
  // there. Worse, `doctor` DELETES on the strength of this walk.
  //
  // A fresh object per call also bounds the lifetime: a verify run pays for the
  // packs it reads once and then drops them, instead of pinning ~25 MB per pack
  // in a process-lifetime cache. Verification is a maintenance path, not the
  // request path; re-reading from GCS is the whole point of it.
  const verifyCache: object = {};

  for (const { ref, oid } of allRefs) {
    const broken = await walkFrom(deps, ref, oid, reachable, verifyCache);
    if (broken) brokenRefs.push(broken);
  }

  const packs = await objects.listPacks();
  const loose = await objects.listLoose();

  const report: VerifyReport = {
    repoId,
    refsChecked: allRefs.length,
    reachableObjects: reachable.size,
    brokenRefs,
    tornPacks: packs.filter((p) => p.hasPack && !p.hasIdx).map((p) => p.packPath),
    danglingIdx: packs.filter((p) => !p.hasPack && p.hasIdx).map((p) => p.idxPath),
    packCount: packs.filter((p) => p.hasPack && p.hasIdx).length,
    looseCount: loose.length,
  };

  // Silence unused-binding lint for the destructured but locally unused deps.
  void fs;
  void gitdir;
  void cache;

  return { report, reachable, refsAtVerify: allRefs };
}

async function walkFrom(
  deps: RepairDeps,
  ref: string,
  tip: Oid,
  reachable: Set<Oid>,
  /** Verify-local cache. Deliberately NOT `deps.cache` — see verifyRepo. */
  cache: object,
): Promise<BrokenRef | null> {
  const { fs, gitdir } = deps;
  // Explicit stack; a deep history would blow the call stack with recursion.
  const stack: Array<{ oid: Oid; path: Oid[] }> = [{ oid: tip, path: [] }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { oid, path } = item;
    if (reachable.has(oid)) continue;

    let obj: git.ReadObjectResult;
    try {
      obj = await git.readObject({ fs, gitdir, cache, oid, format: 'parsed' });
    } catch (err) {
      if (isNotFound(err) || isUnreadablePack(err)) {
        return { ref, oid: tip, missingOid: oid, path };
      }
      throw err;
    }
    reachable.add(oid);
    const childPath = [...path, oid];

    if (obj.format !== 'parsed') continue; // blob returned raw; nothing to descend into

    switch (obj.type) {
      case 'commit': {
        const commit = obj.object as git.CommitObject;
        stack.push({ oid: commit.tree, path: childPath });
        for (const parent of commit.parent) stack.push({ oid: parent, path: childPath });
        break;
      }
      case 'tree': {
        const tree = obj.object as git.TreeObject;
        for (const entry of tree) {
          // Submodule gitlinks (mode 160000) point into another repository.
          // They are legitimately absent here and must not be reported broken.
          if (entry.mode === '160000') continue;
          stack.push({ oid: entry.oid, path: childPath });
        }
        break;
      }
      case 'tag': {
        const tag = obj.object as git.TagObject;
        stack.push({ oid: tag.object, path: childPath });
        break;
      }
      case 'blob':
        break;
    }
  }
  return null;
}

export interface SweepOptions {
  /** Objects younger than this are never deleted. Must exceed the longest
   *  possible push. Default 24h. */
  graceMs?: number;
  dryRun?: boolean;
  /**
   * The ref tips as verifyRepo() saw them. Supplying this lets the sweep detect
   * that `reachable` went stale under it and delete nothing. `doctor` always
   * supplies it; a caller that omits it gets the age guard only, which is NOT
   * sufficient on its own — see the guards inside sweepUnreachable().
   */
  refsAtVerify?: ReadonlyArray<{ ref: string; oid: Oid }>;
}

export interface SweepReport {
  looseDeleted: string[];
  tornPacksDeleted: string[];
  bytesConsidered: number;
  skippedYoung: number;
  dryRun: boolean;
  /** True if a ref moved between verify and sweep, so nothing was deleted. */
  abortedRefsMoved: boolean;
}

/**
 * Mark-and-sweep for LOOSE objects and torn pack files only.
 *
 * Packs are deliberately NOT swept here. A pack is a container: deciding it is
 * garbage requires proving that none of the oids inside it are reachable,
 * which means parsing every .idx. The safe and much simpler route is
 * repackReachable() below, which builds a single replacement pack containing
 * the whole reachable set and only then retires the old ones.
 *
 * NOTE ON GCS LIFECYCLE RULES: 01-cost-model.md §3(b) suggests using bucket
 * lifecycle rules as a partial substitute for gc. DO NOT. Lifecycle rules are
 * age-based and reachability-blind; a base commit from two years ago is old
 * AND live. An age rule on objects/ would delete exactly the objects git can
 * least afford to lose. The only correct pruning input is reachability, and
 * only this process can compute it.
 */
export async function sweepUnreachable(
  deps: RepairDeps,
  repoId: string,
  reachable: Set<Oid>,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000;
  const dryRun = opts.dryRun ?? false;
  const cutoff = Date.now() - graceMs;

  const { objects, refs } = deps;
  const report: SweepReport = {
    looseDeleted: [],
    tornPacksDeleted: [],
    bytesConsidered: 0,
    skippedYoung: 0,
    dryRun,
    abortedRefsMoved: false,
  };

  // ---- THE REFS GUARD, WHICH THIS PATH USED TO LACK ENTIRELY. ------------
  //
  // `reachable` was computed by verifyRepo() minutes ago. If a push completed
  // its CAS in that window, every object it added is (a) absent from
  // `reachable`, because the walk ran before the ref moved, and (b) a legitimate
  // target of the loop below. Deleting them produces a ref pointing at absent
  // objects — Case B, manufactured by the routine that exists to prevent it.
  //
  // THE AGE GUARD BELOW CANNOT COVER THIS ON ITS OWN, and the reason is worth
  // spelling out because it is not obvious. The traced case:
  //
  //   t0       a push writes its objects to GCS and crashes before its CAS.
  //   t0+25h   the client retries. Its uploader finds the objects already
  //            present — or re-offers them and GCS answers 412 — so the objects
  //            keep the `updated` stamp the ABANDONED attempt gave them and
  //            still look 25 h old to an age check with a 24 h grace period.
  //   t0+25h   verifyRepo() walks; the retry's CAS has not landed yet.
  //   t0+25h   the CAS lands.
  //   t0+25h   this sweep sees old-and-unreachable and deletes them.
  //
  // writeLoose() now refreshes the age of an object it re-offers (see
  // objects.ts), which repairs the age guard for the re-upload case. This guard
  // covers the rest: a retry whose uploader skips objects it can already see
  // never touches GCS at all, so nothing refreshes their age, and only the ref
  // comparison can notice that the reachable set is stale.
  //
  // Skipping is always safe. Unreclaimed garbage costs storage until the next
  // run, when the objects will be both reachable and correctly aged. Deleting
  // one wrongly is unrecoverable.
  if (
    opts.refsAtVerify !== undefined &&
    refsMoved(opts.refsAtVerify, await refs.listRefs(repoId))
  ) {
    report.abortedRefsMoved = true;
    return report;
  }

  for (const obj of await objects.listLoose()) {
    if (reachable.has(obj.oid)) continue;
    if (obj.updatedAtMs > cutoff) {
      // Almost certainly an in-flight push. Leave it alone.
      report.skippedYoung++;
      continue;
    }
    report.looseDeleted.push(obj.path);
    if (!dryRun) await objects.deletePath(obj.path);
  }

  for (const pack of await objects.listPacks()) {
    if (pack.hasIdx) continue; // complete, or dangling-idx (reported, not swept)
    if (pack.updatedAtMs > cutoff) {
      report.skippedYoung++;
      continue;
    }
    report.tornPacksDeleted.push(pack.packPath);
    if (!dryRun) await objects.deletePath(pack.packPath);
  }

  void repoId;
  return report;
}

export interface RepackOptions {
  minPacksToBother?: number;
  dryRun?: boolean;
  /** Packs younger than this are never retired. Must exceed the longest
   *  possible push, exactly as in SweepOptions. Default 24h. */
  graceMs?: number;
  /**
   * The ref tips as verifyRepo() saw them. Supplying this lets repack detect
   * that `reachable` went stale under it and retire nothing. `doctor` always
   * supplies it; a caller that omits it gets the age guard only.
   */
  refsAtVerify?: ReadonlyArray<{ ref: string; oid: Oid }>;
}

export interface RepackReport {
  newPackSha: string | null;
  packsRetired: string[];
  objectsPacked: number;
  /** Packs left in place by the grace period — almost always in-flight pushes. */
  packsSkippedYoung: string[];
  /** True if a ref moved between verify and repack, so nothing was retired. */
  abortedRefsMoved: boolean;
}

/**
 * The gc isomorphic-git does not have.
 *
 * Every fetch deposits a new pack-<sha>.pack/.idx pair and nothing ever
 * removes one, while readObjectPacked scans EVERY .idx on a cache miss — so
 * read cost grows linearly with the number of fetches, forever. This collapses
 * them.
 *
 * Ordering is the mirror image of writePackPair():
 *   write new .pack -> write new .idx -> (new pack is now live)
 *   -> delete old .idx FIRST -> then delete old .pack
 *
 * Deleting the old .idx first is mandatory. If the .pack went first, a
 * concurrent reader could find an oid in the surviving .idx and then hard-fail
 * reading the pack that no longer exists. Removing the .idx makes the pack
 * instantly invisible instead, and the orphaned .pack is then just bytes.
 */
export async function repackReachable(
  deps: RepairDeps,
  repoId: string,
  reachable: Set<Oid>,
  opts: RepackOptions = {},
): Promise<RepackReport> {
  const { objects, refs, fs, gitdir, dir, cache } = deps;
  const minPacks = opts.minPacksToBother ?? 4;
  const dryRun = opts.dryRun ?? false;
  const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - graceMs;

  const before = (await objects.listPacks()).filter((p) => p.hasPack && p.hasIdx);

  // Count only the packs this run could actually RETIRE, not every pack that
  // exists. Packs inside the grace window are going to be skipped below, so
  // counting them here would let a repo full of brand-new packs clear the
  // threshold, write a fresh pack, retire nothing, and end up with one MORE
  // pack than it started with — a gc that grows the thing it was called to
  // shrink, once per scheduled run.
  const retirable = before.filter((p) => p.updatedAtMs <= cutoff);
  const young = before.filter((p) => p.updatedAtMs > cutoff).map((p) => p.packPath);
  if (retirable.length < minPacks) {
    return {
      newPackSha: null,
      packsRetired: [],
      objectsPacked: 0,
      packsSkippedYoung: young,
      abortedRefsMoved: false,
    };
  }

  // ---- THE GRACE PERIOD APPLIES HERE TOO, AND IT IS DECIDED FIRST. -------
  //
  // `reachable` was computed by verifyRepo() minutes ago, and a push landing
  // in that window writes a pack that is (a) not in `reachable`, so its objects
  // are not in the replacement pack, and (b) in `before`, so the retire loop
  // used to delete it. The ref CAS then points at objects nothing holds any
  // more — Case B, manufactured by the very routine that exists to prevent it,
  // and manufactured on the SAFE path where the push did everything right.
  //
  // Two guards, because they cover different halves of the window:
  //
  //   AGE  — a pack younger than the grace period is never retired, whatever
  //          `reachable` says. Same rule, same constant, same reasoning as the
  //          loose sweep: it must exceed the longest possible push.
  //   REFS — re-read the ref tips and compare them with the ones verifyRepo
  //          walked. If ANY moved, `reachable` is stale by definition, so this
  //          run retires nothing. This is cheap (one small read per ref) and it
  //          closes the case the age guard cannot: a push that lands a pack and
  //          completes its CAS entirely inside the walk, on a repo whose clock
  //          skew or long walk pushed the pack past the cutoff.
  //
  // WHY THIS RUNS BEFORE packObjects() AND NOT AFTER IT. It used to be checked
  // after the new pack had already been written and indexed, so an aborted run
  // ADDED a pack and retired nothing. Under sustained ref activity — exactly the
  // condition that makes the abort fire — every scheduled `doctor` therefore
  // left the repo with one more pack than it found, which is precisely the
  // "gc that grows the thing it was called to shrink" that `minPacksToBother`
  // exists to prevent, arriving through a different door. An abort must be a
  // NO-OP, so the decision has to precede the write.
  //
  // Skipping is always safe. An unretired pack costs storage and one extra
  // .idx scan on a cache miss until the next run, when it will be both in
  // `reachable` and old enough. Deleting one wrongly is unrecoverable.
  const movedRefs =
    opts.refsAtVerify !== undefined &&
    refsMoved(opts.refsAtVerify, await refs.listRefs(repoId));

  // The same reasoning applies to a dry run: it is asked to REPORT, not to
  // write. Writing a pack it will never retire made `dryRun` grow the repo too.
  if (movedRefs || dryRun) {
    return {
      newPackSha: null,
      packsRetired: [],
      objectsPacked: 0,
      // Only genuinely young packs may be reported as skipped-young. The abort
      // path used to dump every surviving pack into this field, which read as
      // "the grace period saved them" when the real reason was a stale
      // reachable set — a mislabel that hid the growth above from anyone
      // reading the report.
      packsSkippedYoung: young,
      abortedRefsMoved: movedRefs,
    };
  }

  const oids = [...reachable];
  // packObjects({ write: true }) writes objects/pack/pack-<sha>.pack through
  // our fs adapter; indexPack then produces the sibling .idx. That is the
  // .pack-then-.idx order we require, and it is why we call two APIs instead
  // of one.
  const packed = await git.packObjects({ fs, gitdir, cache, oids, write: true });
  const filename = packed.filename;
  const newSha = /pack-([0-9a-f]{40})\.pack$/.exec(filename)?.[1] ?? null;
  if (newSha === null) {
    throw new Error(`repack: unexpected packObjects filename ${filename}`);
  }

  // filepath is joined onto `dir`, not `gitdir` — see the note on RepairDeps.dir.
  await git.indexPack({ fs, dir, gitdir, cache, filepath: `.git/objects/pack/${filename}` });

  const retired: string[] = [];
  const skippedYoung: string[] = [];
  for (const old of before) {
    if (old.sha === newSha) continue;
    if (old.updatedAtMs > cutoff) {
      // Almost certainly a push that landed during the walk. Leave it alone.
      skippedYoung.push(old.packPath);
      continue;
    }
    await objects.deletePath(old.idxPath); // .idx FIRST — makes the pack invisible
    await objects.deletePath(old.packPath); // then the bytes
    retired.push(old.packPath);
  }

  return {
    newPackSha: newSha,
    packsRetired: retired,
    objectsPacked: oids.length,
    packsSkippedYoung: skippedYoung,
    abortedRefsMoved: false,
  };
}

function refsMoved(
  atVerify: ReadonlyArray<{ ref: string; oid: Oid }>,
  now: ReadonlyArray<{ ref: string; oid: Oid }>,
): boolean {
  if (atVerify.length !== now.length) return true;
  const then = new Map(atVerify.map((r) => [r.ref, r.oid]));
  for (const { ref, oid } of now) {
    if (then.get(ref) !== oid) return true;
  }
  return false;
}

/** One-shot entry point suitable for a Cloud Scheduler job. */
export async function doctor(
  deps: RepairDeps,
  repoId: string,
  opts: SweepOptions & RepackOptions & { repack?: boolean } = {},
): Promise<{
  verify: VerifyReport;
  sweep: SweepReport;
  repack: RepackReport | null;
  spill: SpillReclaim | null;
}> {
  const { report, reachable, refsAtVerify } = await verifyRepo(deps, repoId);

  // Refuse to delete ANYTHING while a ref is known-broken. In that state the
  // reachable set is incomplete by definition, so every sweep decision derived
  // from it is untrustworthy.
  if (report.brokenRefs.length > 0) {
    throw new Error(
      `doctor: ${report.brokenRefs.length} broken ref(s) in ${repoId} — refusing to sweep. ` +
        report.brokenRefs
          .map((b) => `${b.ref}@${b.oid.slice(0, 7)} is missing ${b.missingOid.slice(0, 7)}`)
          .join('; '),
    );
  }
  if (report.danglingIdx.length > 0) {
    throw new Error(
      `doctor: ${report.danglingIdx.length} .idx file(s) without a .pack in ${repoId}. ` +
        `This is impossible under the documented write ordering; investigate before sweeping.`,
    );
  }

  // `refsAtVerify` is threaded into BOTH deleting paths so either can abort if
  // a push completed while we were walking. Explicitly last in each spread so
  // it cannot be overridden by opts.
  const sweep = await sweepUnreachable(deps, repoId, reachable, { ...opts, refsAtVerify });
  const repack =
    opts.repack === true
      ? await repackReachable(deps, repoId, reachable, { ...opts, refsAtVerify })
      : null;

  // The `__spill/` prefix, which nothing swept before. It is a DIFFERENT key
  // space with a DIFFERENT reachability root -- Firestore documents, not refs --
  // so it is not folded into sweepUnreachable(); mixing the two would let a
  // stale ref snapshot decide the fate of a file's content. It runs last and its
  // failure is not allowed to invalidate the object-store work above, because
  // the two are independent and a half-run doctor should still report what it
  // did.
  let spill: SpillReclaim | null = null;
  if (deps.spill) {
    const spillOpts: { graceMs?: number; dryRun?: boolean } = {};
    if (opts.graceMs !== undefined) spillOpts.graceMs = opts.graceMs;
    if (opts.dryRun !== undefined) spillOpts.dryRun = opts.dryRun;
    spill = await deps.spill.reclaimSpillOrphans(spillOpts);
  }

  return { verify: report, sweep, repack, spill };
}
