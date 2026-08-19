/**
 * Firestore backend -- holds refs, HEAD, config, `.git/index`, packed-refs and
 * the working tree. Everything except `.git/objects/`.
 *
 * WHY FIRESTORE FOR THESE (01-cost-model.md §3): they are small, hot (read on
 * literally every git command), and they are where git's correctness lives. A
 * Firestore document get returns in ~10 ms against ~50 ms for a GCS round trip,
 * and a Firestore transaction gives real serializable compare-and-swap for ref
 * updates -- which GCS `ifGenerationMatch` gives only per-object, and which
 * git's own `.lock` discipline gives only per-machine.
 *
 * NOTE, and it is important: isomorphic-git will NOT use that CAS.
 * `GitRefManager.writeRef` is a blind `fs.write` with no expected-old-value,
 * and the `fs` interface has no CAS primitive to expose. Ref compare-and-swap
 * must be wrapped ABOVE isomorphic-git, in caller code, against this same
 * collection. This adapter provides durable, correctly-ordered storage; it does
 * not provide ref atomicity on its own.
 *
 * Credentials: Application Default Credentials only. No key material here.
 */

import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import type {
  CollectionReference,
  DocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore';
import type { Backend } from './backend.js';
import { type NodeKind, type StoredNode, to32 } from './stats.js';
import { fsError } from './errors.js';
import { basename, dirname } from './paths.js';

/**
 * Firestore's max field value is 1,048,487 bytes and max document size is
 * 1 MiB. We leave ~48 KB of headroom for `path`/`parent`/`name` and Firestore's
 * own per-document overhead.
 *
 * This is exactly the limit that made layout (a) untenable, and it is why
 * `.git/objects/` is routed to GCS.
 *
 * ### WHY THIS IS A SPILL THRESHOLD AND NOT A LOUD ERROR ANY MORE
 *
 * It used to throw EFBIG. First contact with the 06-conformance suite failed
 * assertions 8 and 36 on it ("a 1 MiB buffer round-trips"), and chasing that
 * back through 02-fs-interface.md showed the ERROR was wrong, not the suite:
 *
 *   - §6.8 / §6.36 require a 1 MiB buffer to round-trip at an ORDINARY path.
 *   - §4.5 independently says "blobs cannot live inline in a document --
 *     packfiles and large blobs must go to GCS regardless".
 *
 * The spec's own resolution is therefore "spill to GCS", and the adapter had
 * only implemented that routing for `.git/objects/**`. Everything else --
 * including `.git/index`, which is stored in Firestore and grows without bound
 * with the number of tracked files -- was capped at 1 MB. A repo of a few tens
 * of thousands of files has a multi-MB index, so EFBIG here was not an
 * edge-case nicety; it was a hard ceiling on repository size, hit at the one
 * file where git's correctness lives.
 *
 * So: content at or under the threshold stays INLINE in the document (small,
 * hot, transactional, one round trip -- the whole reason refs/HEAD/config live
 * in Firestore). Content over it keeps its Firestore document as the
 * authoritative metadata record -- so `readdir`'s `parent ==` query, `stat`,
 * `mtimeMs`/`ino` and the directory tree all behave identically -- and stores
 * only the BYTES in Cloud Storage.
 */
const MAX_CONTENT_BYTES = 1_000_000;

/** Firestore document IDs are capped at 1500 bytes; base64 costs 4/3. */
const MAX_PATH_BYTES = 1000;

interface FileDoc {
  path: string;
  parent: string;
  name: string;
  kind: NodeKind;
  content?: Buffer;
  /** True when the bytes live in the overflow blob store, not in `content`. */
  overflow?: boolean;
  /**
   * The overflow store key holding this document's bytes. Absent on documents
   * written before spill keys were content-addressed, which still resolve to
   * the plain `path` -- see `spillKeyOf`.
   */
  spillKey?: string;
  /**
   * The GCS generation `spillKey` had when THIS document was written. It is the
   * precondition the next overwrite reclaims that blob under: if anything has
   * rewritten the key since (a concurrent writer that re-installed the same
   * content), the generation has moved and the conditional delete is refused
   * rather than unlinking bytes a live document names. Absent on documents
   * written before this field existed, and on any sink that cannot report a
   * generation -- both of which fall back to leaving the blob to
   * `reclaimSpillOrphans`.
   */
  spillGeneration?: string;
  size: number;
  executable: boolean;
  target?: string;
  rev: number;
}

/**
 * ### WHY SPILL KEYS ARE CONTENT-ADDRESSED
 *
 * The write ordering for spilled content is bytes-first, document-second, and
 * for a CREATION that is unarguably right: a crash in between leaves an orphan
 * blob (garbage) rather than a document pointing at bytes that were never
 * written (a torn read).
 *
 * For an OVERWRITE of one large value by another, the same ordering used to be
 * actively dangerous, because the blob key was just the path and so the second
 * write clobbered the first IN PLACE:
 *
 *     overflow.writeFile(path, v2)   <-- the bytes at `path` are now v2
 *     *** crash ***
 *     put(path, { size, rev: +1 })   <-- never runs
 *
 * leaving NEW BYTES under an UNCHANGED `size`, `updateTime` and `rev`. Those
 * three are exactly what `nodeFrom` turns into `size`/`mtimeMs`/`ino`, i.e.
 * everything `compareStats` looks at. So git considers the file clean forever,
 * never re-hashes it, and every subsequent commit records the OLD content while
 * the working tree holds the new -- the silent-divergence class stats.ts exists
 * to prevent, reached by a route the stat mapping cannot see.
 *
 * Keying the blob by its own content fixes it structurally rather than by
 * adding a second write to get wrong: a write can only ever CREATE a key, never
 * rebind one, so the document remains the single commit point. Crash before the
 * document write and the document still names the previous blob, which is still
 * there and still matches the stat -- the overwrite simply did not happen,
 * which is a state the caller already has to handle.
 *
 * The key is `/<sha256(path)>/<sha256(content)>` rather than
 * `<path>.<sha256(content)>` for two reasons:
 *   - LENGTH. Paths run to `MAX_PATH_BYTES` (1000) and a Cloud Storage object
 *     name is capped at 1024 bytes, so prefix + path + digest can overflow it.
 *     This form is a fixed 130 bytes whatever the path.
 *   - NO CROSS-PATH ALIASING. Hashing the path in means two different paths
 *     holding identical bytes get different keys, so unlinking one cannot pull
 *     the bytes out from under the other. Deduplicating them would be a real
 *     saving and a real hazard; this store has no refcount to make it safe.
 *
 * ### THE LEAK THIS USED TO HAVE, AND WHY THE OBVIOUS FIX WAS REJECTED TWICE
 *
 * Because a content key is only ever CREATED, every overwrite left its
 * predecessor behind and nothing deleted it. Measured: 12 sequential overwrites
 * of one 1.2 MB file left 12 live blobs, 14.4 MB retained for a 1.2 MB file,
 * and `unlink` reclaimed only the current key, orphaning 13.2 MB permanently.
 * The PATH-KEYED scheme this replaced leaked nothing — the crash-safety was
 * bought with an O(number of overwrites) storage leak.
 *
 * The previous fixer refused to delete the predecessor because "another
 * concurrent writer may have just re-installed the key". THAT RACE IS REAL, and
 * content addressing does not make it go away — it is exactly what MAKES it
 * possible. Two writers writing the same bytes to the same path compute the
 * SAME key, so:
 *
 *     W1  writeBlob(K_new); put(doc -> K_new)
 *     W2                    writeBlob(K_old)   <-- same content, same key,
 *                                                  NEW GCS generation
 *     W2                    put(doc -> K_old)
 *     W1  delete(K_old)                        <-- the LIVE document's bytes
 *
 * and the reader gets EIO. Garbage traded for corruption, precisely as feared.
 *
 * ### WHAT ACTUALLY CLOSES IT: A GENERATION PRECONDITION
 *
 * The document records `spillGeneration` — the generation GCS assigned when we
 * wrote that blob — alongside `spillKey`. The next overwrite deletes the
 * predecessor with `ifGenerationMatch: <that generation>`, AFTER its own
 * document has committed. GCS evaluates the precondition server-side, so it is
 * not a check-then-act: if W2 re-installed the key, the generation moved, GCS
 * answers 412 and deletes NOTHING. W1 leaves the blob alone and it becomes
 * ordinary reclaimable garbage instead of a dangling pointer. The delete is
 * strictly after the document commit, so the crash window above is untouched:
 * crash before the commit and the document still names an intact blob.
 *
 * Cost: one extra document read per SPILLED write (to learn the predecessor),
 * on a path that is already moving a megabyte. Small writes — the hot path —
 * pay nothing.
 *
 * ### WHAT STILL NEEDS A SWEEPER, AND WHY IT NOW EXISTS
 *
 * Two orphan sources survive by construction: a crash between the blob write
 * and the document commit, and an overwrite of a LARGE file by a SMALL one
 * (which takes the cheap path and never reads the old document). Both are
 * O(1) per path rather than O(overwrites), and both are reachability garbage.
 * `reclaimSpillOrphans` below is the tool this comment used to merely PROMISE:
 * list the spill prefix, keep every key named by a live document's `spillKey`,
 * delete the rest. That is reachability plus a grace period, not age alone --
 * do NOT put a lifecycle rule on this prefix, for the same reason repair.ts
 * refuses one on `objects/`.
 */
function spillKeyOf(path: string, content: Buffer): string {
  const p = createHash('sha256').update(path, 'utf8').digest('hex');
  const c = createHash('sha256').update(content).digest('hex');
  return `/${p}/${c}`;
}

/**
 * The slice of a blob store this module needs for oversized content. `GcsStore`
 * satisfies it; kept structural so FirestoreStore does not depend on GCS.
 *
 * The `path` argument is an OPAQUE KEY chosen by this module (see `spillKeyOf`),
 * not the caller's filesystem path. It is always absolute, so `GcsStore.key`'s
 * `slice(1)` still applies, but nothing may infer a filesystem path from it.
 */
export interface OverflowSink {
  readFile(path: string): Promise<Buffer | null>;
  writeFile(path: string, data: Buffer, opts: { executable: boolean }): Promise<void>;
  removeFile(path: string): Promise<void>;

  /**
   * OPTIONAL, and the three below are what make the predecessor blob
   * reclaimable. `GcsStore` implements all three.
   *
   * A sink that implements NONE of them still works and is still crash-safe --
   * it simply cannot reclaim in line, and every superseded blob stays until
   * someone runs a reclaimer against a sink that CAN list. That is the honest
   * degradation: no silent corruption, only garbage.
   */
  /** `writeFile`, returning the generation the store assigned, or null. */
  writeFileReturningGeneration?(
    path: string,
    data: Buffer,
    opts: { executable: boolean },
  ): Promise<string | null>;
  /** Delete only if still at `generation`. False = precondition lost, kept. */
  removeFileIfGeneration?(path: string, generation: string): Promise<boolean>;
  /** Flat listing of everything the sink holds, for the reachability sweep. */
  listAll?(): Promise<
    Array<{ path: string; size: number; updatedAtMs: number; generation: string | null }>
  >;
}

/** What `reclaimSpillOrphans` did. Byte counts so the saving is measurable. */
export interface SpillReclaimReport {
  /** Spill keys deleted because no live document named them. */
  deleted: string[];
  bytesReclaimed: number;
  /** Keys held back because they are inside the grace period. */
  skippedYoung: number;
  /** Keys a live document names. Never touched. */
  live: number;
  dryRun: boolean;
}

export interface FirestoreStoreOptions {
  /**
   * One collection per repository, e.g. `db.collection('repos/acme/files')`.
   *
   * Two operational notes that do not fit in code:
   *  1. Add a single-field index EXEMPTION for `content`, `size` and `rev`.
   *     Firestore truncates indexed values at 1500 bytes so large blobs do not
   *     fail the write, but indexing them wastes storage and write cost for
   *     queries nobody issues. `path`, `parent`, `name` and `kind` MUST stay
   *     indexed -- `readdir` is a `parent ==` query.
   *  2. Do NOT index any monotonically increasing field on this collection.
   *     Firestore caps a collection at 500 writes/s when a sequentially
   *     increasing field is indexed (01-cost-model.md §4). `rev` is monotonic
   *     per document, which is why it is on the exemption list above.
   */
  collection: CollectionReference;
  /**
   * Where content larger than `MAX_CONTENT_BYTES` is stored. Must use a key
   * space that cannot collide with the object store's (the adapter passes a
   * dedicated `__spill/` prefix). Omit it and oversized writes go back to
   * rejecting with EFBIG, which is the honest behaviour when there is nowhere
   * to spill to.
   */
  overflow?: OverflowSink;
}

export class FirestoreStore implements Backend {
  private readonly collection: CollectionReference;
  private readonly overflow: OverflowSink | undefined;

  constructor(opts: FirestoreStoreOptions) {
    this.collection = opts.collection;
    this.overflow = opts.overflow;
  }

  /**
   * Document ID. Firestore IDs may not contain `/`, so the path is base64url
   * encoded. The plaintext path is also stored in the `path` field so the
   * collection stays browsable and queryable.
   */
  private docId(path: string, syscall: string): string {
    const bytes = Buffer.from(path, 'utf8');
    if (bytes.byteLength > MAX_PATH_BYTES) {
      throw fsError('EINVAL', syscall, path, 'path too long for a Firestore document ID');
    }
    return bytes.toString('base64url');
  }

  /**
   * THE MTIME/INO MAPPING -- see the block comment in stats.ts for the exact
   * corruption this prevents.
   *
   * `snapshot.updateTime` is set by the Firestore server on every write to the
   * document, so it genuinely moves whenever the content moves. `rev` is a
   * per-document counter incremented by `FieldValue.increment(1)` on every
   * write, which closes git's sub-second window: `compareStats` compares mtime
   * at ONE-SECOND granularity, so two same-size writes inside the same
   * wall-clock second are indistinguishable by time alone. XOR-ing `rev` into
   * `ino` makes them distinguishable.
   *
   * Never return a constant here. An adapter reporting `mtimeMs: 0, ino: 0`
   * commits stale content with no error at all.
   *
   * ### THE XOR IS A DISJUNCTION, AND BOTH HALVES ARE TESTED
   *
   * `rev` and the clock cover each OTHER's failure, which is the whole point of
   * keeping both -- but it also means neither half is observable through this
   * function alone. A `rev` frozen at 1 is invisible here, because `to32(micros)`
   * moves on its own; that was reproduced, and the entire gate passed 57/57 with
   * the counter dead.
   *
   * So do not delete `rev` on the grounds that "ino moves anyway": microsecond
   * `updateTime` distinctness for two writes to the SAME document is not a
   * property Google guarantees anywhere, and it is not testable against our own
   * substitute (whose clock we forced monotonic). And do not derive `ino` from
   * `rev` ALONE either: every new document has `rev = 1`, so distinct files
   * collide and conformance assertion 36 fails with
   * "ino is CONSTANT across distinct files (1, 1, 1)". Both were measured.
   *
   * `09-gate/rev.test.mjs` is what keeps this honest. It pins the substitute's
   * commit timestamp, so `ino` moves if and only if `rev` moves, and it goes RED
   * if the counter freezes OR if `rev` is dropped from the expression below.
   * `12-smoke`'s `A2` is the real-server half of the same question.
   */
  private nodeFrom(snap: DocumentSnapshot, data: FileDoc): StoredNode {
    const updateTime: Timestamp | undefined = snap.updateTime;
    const mtimeMs = updateTime ? updateTime.toMillis() : Date.now();

    let ino: number;
    if (updateTime) {
      const micros =
        updateTime.seconds * 1_000_000 + Math.floor(updateTime.nanoseconds / 1000);
      ino = (to32(micros) ^ (to32(data.rev ?? 0) >>> 0)) >>> 0;
    } else {
      // Should not happen for an existing document. Fall back to something
      // that moves rather than something constant.
      ino = to32(Date.now());
    }

    return {
      kind: data.kind,
      size: data.kind === 'dir' ? 0 : (data.size ?? 0),
      executable: data.executable === true,
      mtimeMs,
      ctimeMs: mtimeMs,
      ino,
      target: data.target,
    };
  }

  private async snapshot(path: string, syscall: string): Promise<DocumentSnapshot | null> {
    const snap = await this.collection.doc(this.docId(path, syscall)).get();
    return snap.exists ? snap : null;
  }

  async getNode(path: string): Promise<StoredNode | null> {
    const snap = await this.snapshot(path, 'stat');
    if (!snap) return null;
    return this.nodeFrom(snap, snap.data() as FileDoc);
  }

  async readFile(path: string): Promise<Buffer | null> {
    const snap = await this.snapshot(path, 'open');
    if (!snap) return null;
    const data = snap.data() as FileDoc;
    if (data.kind !== 'file') return null;

    if (data.overflow === true) {
      if (!this.overflow) {
        // The document says the bytes are elsewhere and there is no elsewhere.
        // Returning null here would read as "file missing" and silently drop
        // content (the §3.3 corruption class), so fail loudly instead.
        throw fsError('EIO', 'read', path, 'content is spilled but no overflow store is configured');
      }
      // No `spillKey` means a document written before spill keys were
      // content-addressed, whose blob is still at the plain path.
      const bytes = await this.overflow.readFile(data.spillKey ?? path);
      if (bytes === null) {
        throw fsError('EIO', 'read', path, 'spilled content is missing from the overflow store');
      }
      return bytes;
    }

    // The Node server SDK materialises a Bytes field as a Buffer. A file
    // written with zero bytes has no `content` field at all after a round trip
    // through an empty Buffer, so normalise to an empty Buffer here.
    return data.content ? Buffer.from(data.content) : Buffer.alloc(0);
  }

  async writeFile(
    path: string,
    data: Buffer,
    opts: { executable: boolean },
  ): Promise<void> {
    if (data.byteLength > MAX_CONTENT_BYTES) {
      if (!this.overflow) {
        throw fsError(
          'EFBIG',
          'write',
          path,
          `${data.byteLength} bytes exceeds the Firestore document limit and ` +
            `no overflow store is configured`,
        );
      }
      // Bytes FIRST, then the document. A crash between the two leaves an
      // orphan blob (garbage, collectable) rather than a document pointing at
      // bytes that were never written (a torn read).
      //
      // The key is derived from the CONTENT, so this holds for an overwrite and
      // not only for a creation: the write below cannot touch the blob the
      // current document names, so a crash before `put` leaves the file exactly
      // as it was, stat included. See `spillKeyOf`.
      const spillKey = spillKeyOf(path, data);
      const sink = this.overflow;

      // The predecessor has to be learned BEFORE the `put` below, because after
      // it the document no longer names it. One extra read, on a call that is
      // already moving more than a megabyte, and it rides alongside the upload
      // so it costs a round trip rather than wall clock.
      const [prior, spillGeneration] = await Promise.all([
        this.snapshot(path, 'write').then((snap) => {
          const doc = snap?.data() as FileDoc | undefined;
          if (!doc || doc.overflow !== true) return null;
          // No `spillKey` => a document from the path-keyed era, whose blob is
          // at the plain path.
          return { key: doc.spillKey ?? path, generation: doc.spillGeneration ?? null };
        }),
        sink.writeFileReturningGeneration
          ? sink.writeFileReturningGeneration(spillKey, data, opts)
          : sink.writeFile(spillKey, data, opts).then(() => null),
      ]);

      await this.put(path, {
        kind: 'file',
        overflow: true,
        spillKey,
        spillGeneration: spillGeneration ?? undefined,
        size: data.byteLength,
        executable: opts.executable,
      });

      // STRICTLY AFTER THE COMMIT. Before it, this would destroy the bytes the
      // live document still names -- the exact torn-overwrite the content key
      // exists to prevent. After it, the document has already moved on and the
      // predecessor is unreachable through this path.
      if (prior !== null && prior.key !== spillKey) {
        await this.reclaimSuperseded(prior.key, prior.generation);
      }
      return;
    }
    // LARGE -> SMALL takes the cheap path below and does not read the old
    // document, so it can still orphan one blob per path. That is O(1), not
    // O(overwrites), and `reclaimSpillOrphans` collects it; paying a document
    // read on EVERY small write to catch it would double the read cost of the
    // hot metadata path for a bounded amount of garbage.
    await this.put(path, {
      kind: 'file',
      content: data,
      size: data.byteLength,
      executable: opts.executable,
    });
  }

  async makeDir(path: string): Promise<void> {
    await this.put(path, { kind: 'dir', size: 0, executable: false });
  }

  async makeSymlink(target: string, path: string): Promise<void> {
    await this.put(path, {
      kind: 'symlink',
      size: Buffer.byteLength(target, 'utf8'),
      executable: false,
      target,
    });
  }

  private async put(
    path: string,
    fields: {
      kind: NodeKind;
      size: number;
      executable: boolean;
      content?: Buffer;
      target?: string;
      overflow?: boolean;
      spillKey?: string;
      spillGeneration?: string;
    },
  ): Promise<void> {
    const doc: Record<string, unknown> = {
      path,
      parent: dirname(path),
      name: basename(path),
      kind: fields.kind,
      size: fields.size,
      executable: fields.executable,
      // Monotonic per-document change counter feeding `ino`.
      rev: FieldValue.increment(1),
      // Every optional field is either SET or explicitly DELETED, never simply
      // omitted, so a merge write is equivalent to a replace for everything
      // this module owns -- an overwrite still cannot leave a stale `target`,
      // `content` or `overflow` behind from a previous incarnation.
      content: fields.content !== undefined ? fields.content : FieldValue.delete(),
      target: fields.target !== undefined ? fields.target : FieldValue.delete(),
      overflow: fields.overflow === true ? true : FieldValue.delete(),
      // Deleted, not omitted, on every non-spilled write -- otherwise a large
      // file overwritten by a small one would keep a `spillKey` naming stale
      // bytes, and a later reader that trusted the key over the `overflow` flag
      // would serve content the document does not describe.
      spillKey: fields.spillKey !== undefined ? fields.spillKey : FieldValue.delete(),
      // Same rule, same reason: a stale generation would make the NEXT
      // overwrite issue a conditional delete against a precondition that has
      // nothing to do with the key it is deleting.
      spillGeneration:
        fields.spillGeneration !== undefined ? fields.spillGeneration : FieldValue.delete(),
    };

    // ### WHY `{ merge: true }` AND NOT A PLAIN `set`
    //
    // This used to be a plain `set` (full replace). That silently BROKE `rev`,
    // and the gate caught it: after 5 writes the stored `rev` was still 1.
    //
    // A no-merge `set` carrying a sentinel sends the field transform in
    // `Write.update_transforms`, and write.proto defines that as "equivalent to
    // performing `update` and `transform` to the same document atomically and
    // IN ORDER". The `update` half is a full replace, so by the time the
    // increment runs, the document no longer has a `rev` field -- increment
    // reads a missing field as 0 and writes 1. Every time. Forever.
    //
    // `rev` was therefore a CONSTANT, which is precisely the "correct-looking
    // and wrong" failure that stats.ts warns about. It was masked only because
    // `updateTime` has microsecond resolution and carries the change signal on
    // its own -- so `ino` still moved, and nothing failed visibly.
    //
    // With `merge: true` the update half is masked, the prior `rev` survives
    // into the post-update document, and the increment sees the real base.
    //
    // ### WHAT THIS WRITE IS NOT: A COMPARE-AND-SET
    //
    // It is BLIND. No expected revision, no precondition, no transaction —
    // last writer wins, silently. For most paths here that is exactly right,
    // because they are written by one owner at a time. For three it is a real
    // limitation, documented in 07-refs-design.md §1.8 rather than left to be
    // discovered:
    //
    //   `.git/index`, `HEAD`, `config` are MUTABLE and read-modify-write.
    //   Two instances staging concurrently both read the index, both add their
    //   own entry, and both write. The second wins entirely. Neither sees an
    //   error. `rev` does not save this — it makes the STAT move so git
    //   re-hashes, which is a different problem (see the block above).
    //
    // This cannot be fixed at this layer, and attempting it here would be
    // wrong. The `fs` contract is `writeFile(path, data)`: there is nowhere to
    // pass an expected value and nowhere to report a conflict, and
    // isomorphic-git's `GitIndexManager` has no handler for a refused write.
    // It is the same seam that makes ref CAS impossible from below — which is
    // why refs are fixed from ABOVE, in 07-refs' `compareAndSetRef` and
    // 09-mcp's `ref-gate.ts`. If these three paths ever become concurrently
    // mutable, fix them the same way: keep the index out of the shared store,
    // or own the read-modify-write above this seam, or refuse it loudly.
    //
    // Blast radius as built: nil. 09-mcp calls only log/readBlob/readCommit/
    // writeBlob/writeCommit, never stages, never checks out, and `ref-gate`
    // already EPERMs `HEAD`. So none of the three is ever written in
    // production. This comment exists so that stops being an accident.
    await this.collection.doc(this.docId(path, 'write')).set(doc, { merge: true });
  }

  async removeFile(path: string): Promise<void> {
    // The blob key is content-derived, so unlink has to LEARN it from the
    // document before destroying the document -- one extra Class A op, on a
    // call this system makes rarely. Reading it after the delete would be
    // reading nothing; guessing it is not possible by construction, which is
    // the same property that makes an overwrite crash-safe.
    const snap = this.overflow ? await this.snapshot(path, 'unlink') : null;
    const doc = snap ? (snap.data() as FileDoc) : undefined;
    const spillKey = doc?.spillKey;

    // The document is the authority, so it goes first; the spilled blob is
    // then unreachable either way. `GcsStore.removeFile` ignores not-found.
    await this.collection.doc(this.docId(path, 'unlink')).delete();

    if (this.overflow) {
      // Conditional for the same reason an overwrite's reclaim is: between the
      // document delete above and this line, a writer can have re-created the
      // file with the SAME bytes -- same content key, new generation -- and
      // committed a document naming it. An unconditional delete here would
      // unlink the bytes that new document names.
      if (spillKey !== undefined) {
        await this.reclaimSuperseded(spillKey, doc?.spillGeneration ?? null);
      }
      // Documents written before spill keys were content-addressed kept their
      // blob at the plain path. Unconditional so an unlink still reclaims them:
      // a path key IS rebound by an overwrite, so there is no generation to
      // carry, and this is the legacy behaviour unchanged.
      await this.overflow.removeFile(path);
    }
  }

  /**
   * Reclaim a spill blob that is no longer named by any document, under the
   * generation it had when we recorded it.
   *
   * `generation === null` means we never learned one (a legacy document, or a
   * sink that cannot report generations). Deleting unconditionally in that case
   * would reintroduce exactly the race this method exists to avoid, so the blob
   * is LEFT and becomes `reclaimSpillOrphans`'s problem. Leaking a bounded
   * amount of garbage is recoverable; unlinking a live document's bytes is not.
   */
  private async reclaimSuperseded(key: string, generation: string | null): Promise<void> {
    const sink = this.overflow;
    if (!sink) return;
    if (generation === null || !sink.removeFileIfGeneration) return;
    await sink.removeFileIfGeneration(key, generation);
  }

  /**
   * THE OFFLINE RECLAIMER, which `spillKeyOf`'s comment used to only promise.
   *
   * Lists the spill prefix, keeps every key a live document names, deletes the
   * rest. Reachability, not age -- but with an age GRACE PERIOD on top, for the
   * same reason `repair.ts`'s sweep has one: the write ordering is bytes first,
   * document second, so a blob whose document has not committed YET is
   * unreachable and completely legitimate. Deleting it would turn a normal
   * in-flight write into a torn one. `graceMs` must exceed the longest possible
   * spilled write; it defaults to an hour, and a caller that passes 0 is
   * asserting no writer is running.
   *
   * Two kinds of orphan reach here, both bounded per path: a crash between the
   * blob write and the document commit, and a large file overwritten by a small
   * one. The unbounded overwrite chain is reclaimed in line by `writeFile`.
   *
   * Requires a sink that can list; without one this reports nothing rather than
   * pretending the prefix is clean.
   */
  async reclaimSpillOrphans(
    opts: { graceMs?: number; dryRun?: boolean } = {},
  ): Promise<SpillReclaimReport> {
    const graceMs = opts.graceMs ?? 60 * 60 * 1000;
    const dryRun = opts.dryRun ?? false;
    const report: SpillReclaimReport = {
      deleted: [],
      bytesReclaimed: 0,
      skippedYoung: 0,
      live: 0,
      dryRun,
    };

    const sink = this.overflow;
    if (!sink?.listAll) {
      throw new Error(
        'reclaimSpillOrphans: the overflow sink cannot list its own key space, so ' +
          'reachability cannot be computed. Pass a GcsStore (or any sink implementing listAll).',
      );
    }

    // THE LIVE SET. Every document whose bytes are spilled, whatever key scheme
    // it was written under. `overflow == true` is the authoritative marker --
    // `spillKey` alone would miss path-keyed legacy documents, and a document
    // that is NOT overflowing has no claim on the prefix at all.
    const live = new Set<string>();
    const snap = await this.collection.where('overflow', '==', true).select('path', 'spillKey').get();
    for (const d of snap.docs) {
      const key = d.get('spillKey') as string | undefined;
      const p = d.get('path') as string | undefined;
      if (key !== undefined) live.add(key);
      // Legacy path-keyed documents keep their blob at the plain path.
      else if (p !== undefined) live.add(p);
    }

    const cutoff = Date.now() - graceMs;
    for (const blob of await sink.listAll()) {
      if (live.has(blob.path)) {
        report.live++;
        continue;
      }
      if (blob.updatedAtMs > cutoff) {
        // Almost certainly a write whose document has not committed yet.
        report.skippedYoung++;
        continue;
      }
      report.deleted.push(blob.path);
      report.bytesReclaimed += blob.size;
      if (dryRun) continue;
      // Conditional whenever we know the generation: a blob that has been
      // rewritten since the listing is a blob some writer is installing right
      // now, and its document may be about to name it.
      if (blob.generation !== null && sink.removeFileIfGeneration) {
        await sink.removeFileIfGeneration(blob.path, blob.generation);
      } else {
        await sink.removeFile(blob.path);
      }
    }

    return report;
  }

  async removeDir(path: string): Promise<void> {
    await this.collection.doc(this.docId(path, 'rmdir')).delete();
  }

  /**
   * `readdir` is a `parent ==` equality query, served by Firestore's automatic
   * single-field index on `parent`. `select('name')` applies a field mask so
   * blob contents are not dragged across the wire for a listing.
   *
   * `.get()` on a Query returns the COMPLETE result set -- the server client
   * streams and buffers every page internally -- so there is no truncation to
   * guard against here, unlike the GCS side.
   */
  async listChildren(path: string): Promise<string[]> {
    const snap = await this.collection
      .where('parent', '==', path)
      .select('name')
      .get();

    const names: string[] = [];
    for (const doc of snap.docs) {
      const name = doc.get('name') as string | undefined;
      // Never `.` or `..` -- they hang `git.statusMatrix` forever (§5.3).
      if (!name || name === '.' || name === '..') continue;
      names.push(name);
    }
    return names;
  }

  async hasChildren(path: string): Promise<boolean> {
    const snap = await this.collection
      .where('parent', '==', path)
      .select('name')
      .limit(1)
      .get();
    return !snap.empty;
  }
}
