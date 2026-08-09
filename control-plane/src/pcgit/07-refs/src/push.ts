/**
 * 07-refs / push.ts
 *
 * The safe write ordering, expressed as code so it cannot be forgotten.
 *
 *   1. Write every new object to GCS and WAIT for success responses.
 *   2. Fence: prove the new tip's OBJECT CLOSURE is readable — the tip's bytes
 *      straight from GCS, then its closure through the real reader, bounded by
 *      the refs that already exist. See assertClosureDurable.
 *   3. Check fast-forward (needs the objects from step 1, hence after it).
 *   4. compareAndSetRef in Firestore.
 *
 * Step 4 is last, and that is the entire safety argument:
 *
 *   crash between 1 and 4  -> objects exist, ref unmoved. The objects are
 *                             unreachable from any ref, i.e. invisible.
 *                             Harmless garbage; reclaimed by repair.ts.
 *   crash after 4          -> impossible to be missing objects, because
 *                             step 1 completed before step 4 began.
 *
 * The dangerous state (a ref pointing at objects that are not there) is not
 * detected and repaired — it is made UNREACHABLE by the ordering. There is no
 * interleaving of these four steps that produces it, for any number of
 * concurrent writers, because the ref only ever advances to an oid whose
 * closure was durable strictly before the CAS was attempted.
 */

import * as git from 'isomorphic-git';

import type { ObjectStore } from './objects';
import type { RefStore } from './refs';
import { type CasResult, type Oid, RefCasError, formatCasFailure } from './model';

export interface PushRequest {
  repoId: string;
  refName: string;
  /** Value the client believes the remote ref holds. null = create. */
  expectedOid: Oid | null;
  /** New tip. null = delete the ref. */
  newOid: Oid | null;
  /** Client asked for a force push; skips the fast-forward assertion. */
  force?: boolean;
}

export interface PushDeps {
  refs: RefStore;
  objects: ObjectStore;
  /** isomorphic-git fs adapter + gitdir, used only for ancestry checks. */
  fs: git.FsClient;
  gitdir: string;
  /** Module-level, hoisted cache. Never allocate one per request. */
  cache: object;
  /**
   * Uploads the pack / loose objects for this push and resolves only once GCS
   * has acknowledged every one of them. MUST NOT resolve early.
   */
  uploadObjects: () => Promise<void>;
}

export type PushOutcome =
  | { ok: true; ref: string; oid: Oid | null; previousOid: Oid | null }
  | { ok: false; ref: string; reason: 'non-fast-forward'; message: string; remoteOid: Oid | null }
  | { ok: false; ref: string; reason: 'lost-race'; message: string; remoteOid: Oid | null };

export async function pushRef(deps: PushDeps, req: PushRequest): Promise<PushOutcome> {
  const { refs, objects, fs, gitdir, cache } = deps;

  // ---- STEP 1: objects durable, first, always. -----------------------------
  // Even if this push is going to lose the race, uploading first is correct:
  // the objects are content-addressed and immutable, so an upload can never
  // corrupt anything, and a loser's objects are simply unreferenced.
  if (req.newOid !== null) {
    await deps.uploadObjects();

    // ---- STEP 2: fence. ---------------------------------------------------
    // Catches an uploadObjects() that lied about completion. See
    // assertClosureDurable below for why this is a bounded CLOSURE check and
    // not the existence check this used to be.
    await assertClosureDurable(deps, req);

    // ---- STEP 3: fast-forward policy. -------------------------------------
    // This is a POLICY check, not the safety mechanism. It can only be done
    // once the objects are present (it walks the commit graph). It is racy on
    // its own — the remote may move between here and step 4 — and that race is
    // closed by the CAS, which fails if the remote moved.
    if (!req.force && req.expectedOid !== null) {
      const isFf = await git.isDescendent({
        fs,
        gitdir,
        cache,
        oid: req.newOid,
        ancestor: req.expectedOid,
        depth: -1,
      });
      if (!isFf) {
        return {
          ok: false,
          ref: req.refName,
          reason: 'non-fast-forward',
          remoteOid: req.expectedOid,
          message:
            `! [rejected] ${req.refName} (non-fast-forward). ` +
            `${req.newOid.slice(0, 7)} is not a descendant of ${req.expectedOid.slice(0, 7)}. ` +
            `Your update was NOT applied.`,
        };
      }
    }
  }

  // ---- STEP 4: the ref moves last. ----------------------------------------
  const result: CasResult = await refs.compareAndSetRef(
    req.repoId,
    req.refName,
    req.expectedOid,
    req.newOid,
  );

  if (result.ok) {
    return { ok: true, ref: result.ref, oid: result.oid, previousOid: result.previousOid };
  }

  // The loser's path. Loud, specific, and it names the winning oid so the
  // client can fetch it. Nothing was overwritten; nothing was lost.
  return {
    ok: false,
    ref: result.ref,
    reason: 'lost-race',
    remoteOid: result.actualOid,
    message: formatCasFailure(result),
  };
}

/** Re-export so callers can `instanceof` without importing model directly. */
export { RefCasError };

/** Thrown when the fence refuses the push. Distinct so callers can tell an
 *  upload bug apart from a policy rejection or a lost race. */
export class DurabilityFenceError extends Error {
  override readonly name = 'DurabilityFenceError';
  constructor(
    message: string,
    readonly ref: string,
    readonly tipOid: Oid,
    /** The first object the fence could not account for. */
    readonly missingOid: Oid,
    /** Tip -> ... -> parent of missingOid, for diagnosis. */
    readonly path: Oid[],
  ) {
    super(message);
  }
}

const NOT_FOUND = 'NotFoundError';

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  return code === NOT_FOUND || name === NOT_FOUND;
}

/**
 * An oid the .idx claims to hold, in a packfile whose BYTES could not be read.
 *
 * isomorphic-git does not raise `NotFoundError` for this. `readObjectPacked`
 * finds the oid in the fanout, then `fs.read(packFile)` returns null and it
 * throws `InternalError("Could not read packfile at ...")`. Semantically that
 * is the same fact `NotFoundError` carries — this object is not readable — but
 * it arrives under a different name, so a fence that only converted
 * `NotFoundError` re-threw it raw.
 *
 * THIS BECAME REACHABLE WHEN THE PACK CACHE STARTED TELLING THE TRUTH. While
 * 05-adapter's `PackCache` served deleted packs by name, a pack that `gc`
 * removed under a running push was still readable from memory and the walk
 * never saw the gap. Now that the cache revalidates the GCS generation on every
 * read (gcs-store.ts `readFile`), a repack on another instance that retires a
 * pack mid-walk surfaces here — as the ordinary, expected outcome of a race,
 * not as a bug. It must therefore come out as the fence's own error, naming the
 * offending oid and the path that reached it, so the caller can retry. Safety
 * never depended on this: either way the exception propagates and step 4 never
 * runs, so the ref does not move. What was wrong was the diagnosis.
 */
function isUnreadablePack(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown; data?: { message?: unknown } } | null;
  if (e?.code !== 'InternalError' && e?.name !== 'InternalError') return false;
  const detail = typeof e?.data?.message === 'string' ? e.data.message : String((e as Error).message);
  return /packfile/i.test(detail);
}

/**
 * THE FENCE. This is the step that has to be able to fail.
 *
 * WHAT IT REPLACED, AND WHY THAT MATTERED. This used to be
 *
 *     hasLoose(tip) || packs.some(p => p.hasPack && p.hasIdx)
 *
 * whose second half never looked at the oid. Any repo that had ever received a
 * single complete pack passed the fence for EVERY oid, forever. So the step
 * whose stated purpose (07-refs-design.md §4.3) is "to catch an uploadObjects()
 * that resolves early" was structurally incapable of catching one: a lying
 * upload sailed through, the CAS moved the ref, and the result was a ref
 * pointing at objects that are not there — the Case B state §4.3 claims is
 * unreachable. A fence that cannot fail is not a weak fence, it is a comment.
 *
 * WHAT IT DOES NOW, in two parts, because they prove different things — and
 * they prove them to DIFFERENT STRENGTHS. CACHE-BLIND ONLY FOR THE TIP:
 *
 *  1. DURABILITY OF THE TIP, DIRECT FROM GCS. `hasLoose` / `packContaining` go
 *     to the bucket, and `packContaining` binary-searches the real .idx fanout
 *     for this exact oid. This deliberately bypasses BOTH caches in the read
 *     path — isomorphic-git's `cache` and 05-adapter's `PackCache`, which is
 *     seeded on write — so a process that merely *believes* it uploaded the tip
 *     cannot satisfy this half. For the tip, and only the tip, the fence is
 *     satisfiable exclusively by bytes GCS acknowledged.
 *
 *  2. CONNECTIVITY OF THE CLOSURE, THROUGH THE ORDINARY READ PATH. A reachable
 *     tip whose tree is missing is still Case B, so the tip alone is not enough.
 *     This walks the closure through `git.readObject` — the same path a real
 *     reader takes, with the hoisted `cache` live underneath it.
 *
 *     SO THIS HALF DOES NOT PROVE DURABILITY, AND MUST NOT BE READ AS IF IT
 *     DID. What it proves is that the graph is COMPLETE as this process can
 *     read it: no interior object is missing, mistyped or unparseable. The
 *     cache that can satisfy it is isomorphic-git's own hoisted `cache` — the
 *     `PackfileCache` slot, which memoises the parsed `.idx` AND the pack
 *     Buffer on the `GitPackIndex` object (`p.pack`, index.cjs readObjectPacked)
 *     and is never revalidated against storage. An interior object whose pack
 *     GCS no longer holds, but which this process read once earlier in its life,
 *     still satisfies this half. 09-gate/defects2.test.mjs (E4) constructs
 *     exactly that state and shows the fence passing, so this is a demonstrated
 *     limit, not a theoretical one.
 *
 *     WHICH CACHE, PRECISELY — because this used to name the wrong one. It said
 *     05-adapter's `PackCache`, the transport-level byte cache seeded on write.
 *     That is no longer true and the claim would now be a lie: `PackCache`
 *     entries are qualified by GCS generation and revalidated against live
 *     object metadata on every read (gcs-store.ts `readFile`), so bytes GCS has
 *     deleted stop being served on the very next read — the same fix that made
 *     `stat` and `readFile` agree for multi-instance assertion 61. E4's cold-
 *     cache half asserts that: with a fresh `cache`, the identical scenario is
 *     now REJECTED by the fence. `PackCache` is still bypassed by part 1, which
 *     is why it is named there.
 *
 *     IT IS DELIBERATE, AND THE PRICE OF CLOSING IT IS THE REASON. Making part 2
 *     GCS-direct means a `hasLoose`/`packContaining` round trip PER OBJECT the
 *     push added, on the path that runs before every ref update; a push of a few
 *     thousand objects would pay thousands of extra round trips, and a fence too
 *     expensive to keep is a fence that gets removed — the failure mode the
 *     paragraph above this one is about. The residual risk is bounded by what
 *     part 1 already excludes: `uploadObjects()` must have genuinely landed the
 *     TIP in GCS, so a wholesale early-return is still caught, and what survives
 *     is only the narrower "landed the tip but silently dropped an interior
 *     object it had cached". `doctor` re-derives the whole closure from GCS,
 *     which is where that case is caught — and it does so with a cache it mints
 *     itself, empty on every run, precisely so this sentence is a mechanism and
 *     not a hope. See the block in repair.ts `verifyRepo`; handing it
 *     `deps.cache` would make it inherit exactly the blindness described above,
 *     and it deletes on the strength of that walk.
 *
 * WHY THE WALK IS BOUNDED, and is therefore affordable on every push: it stops
 * descending at any oid that is already a ref tip on this remote (and at
 * `expectedOid`). That is precisely `git rev-list --objects <new> --not --all`,
 * the connectivity check real git runs in receive-pack. It rests on the
 * induction the ordering already establishes: every ref tip got there by
 * passing this same fence, so its closure was durable before its CAS. The cost
 * is therefore proportional to what THIS push added, not to repo history. If
 * that induction is ever in doubt, `doctor` re-derives it from scratch —
 * that is repair.ts's job, not this one's.
 */
async function assertClosureDurable(deps: PushDeps, req: PushRequest): Promise<void> {
  const { refs, objects, fs, gitdir, cache } = deps;
  const tip = req.newOid;
  if (tip === null) return;

  // --- part 1: the tip's bytes are in GCS, addressed by oid. ---------------
  const inGcs = (await objects.hasLoose(tip)) || (await objects.packContaining(tip)) !== null;
  if (!inGcs) {
    throw new DurabilityFenceError(
      `push aborted: object ${tip} is not readable in GCS after uploadObjects() resolved. ` +
        `Refusing to move ${req.refName} to an object that is not durable. ` +
        `This almost always means uploadObjects() returned before its writes were acknowledged.`,
      req.refName,
      tip,
      tip,
      [],
    );
  }

  // --- part 2: everything the tip reaches is readable too. -----------------
  const boundary = new Set<Oid>();
  if (req.expectedOid !== null) boundary.add(req.expectedOid);
  for (const { oid } of await refs.listRefs(req.repoId)) boundary.add(oid);
  boundary.delete(tip); // never let the tip itself terminate its own walk

  const seen = new Set<Oid>();
  const stack: Array<{ oid: Oid; path: Oid[] }> = [{ oid: tip, path: [] }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { oid, path } = item;
    if (seen.has(oid) || boundary.has(oid)) continue;
    seen.add(oid);

    let obj: git.ReadObjectResult;
    try {
      obj = await git.readObject({ fs, gitdir, cache, oid, format: 'parsed' });
    } catch (err) {
      if (!isNotFound(err) && !isUnreadablePack(err)) throw err;
      throw new DurabilityFenceError(
        `push aborted: ${req.refName}@${tip.slice(0, 7)} reaches ${oid}, which is not ` +
          `readable after uploadObjects() resolved` +
          (path.length > 0 ? ` (via ${path.map((p) => p.slice(0, 7)).join(' -> ')})` : '') +
          (isUnreadablePack(err)
            ? `. Its packfile is listed but unreadable — most likely retired by a ` +
              `concurrent repack; retry the push.`
            : '') +
          `. Refusing to move the ref onto an incomplete object graph.`,
        req.refName,
        tip,
        oid,
        path,
      );
    }

    if (obj.format !== 'parsed') continue; // blob handed back raw; nothing below it
    const childPath = [...path, oid];

    switch (obj.type) {
      case 'commit': {
        const commit = obj.object as git.CommitObject;
        stack.push({ oid: commit.tree, path: childPath });
        // Parents ARE walked — a push of N commits must prove all N, not just
        // the newest. The boundary is what stops this at the previous tip
        // instead of at the root commit; on an ordinary fast-forward that is
        // `expectedOid`, one hop down.
        for (const parent of commit.parent) stack.push({ oid: parent, path: childPath });
        break;
      }
      case 'tree': {
        const tree = obj.object as git.TreeObject;
        for (const entry of tree) {
          // Submodule gitlinks (mode 160000) point into another repository and
          // are legitimately absent here.
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
}
