/**
 * 07-refs / refs.ts
 *
 * compareAndSetRef — the single point at which correctness lives.
 *
 * Why this exists: isomorphic-git's GitRefManager.writeRef is
 *
 *     await fs.write(join(gitdir, ref), `${value.trim()}\n`, 'utf8')
 *
 * i.e. a BLIND OVERWRITE with no expected-old-value, and GitRefManager's
 * AsyncLock is an in-process mutex that provides exactly zero protection
 * across Cloud Run instances. So the compare-and-swap must be performed
 * ABOVE isomorphic-git, by us, against Firestore. Nothing in this file ever
 * calls isomorphic-git.
 *
 * Firestore semantics this relies on (all cited in ../07-refs-design.md):
 *  - Server client libraries honour the database concurrency mode; Standard
 *    edition defaults to PESSIMISTIC. The Node.js library "obtains a
 *    pessimistic lock on all documents that are read".
 *  - "Firestore guarantees serializable isolation of transactions."
 *  - The client library automatically retries on contention;
 *    ReadWriteTransactionOptions.maxAttempts "Defaults to 5".
 *  - "Read operations must be executed before write operations."
 *  - The update function MAY RUN MORE THAN ONCE. It must therefore be pure
 *    with respect to application state — which is why this one only reads a
 *    document, compares two strings, and stages a write.
 */

import {
  FieldValue,
  Firestore,
  type CollectionReference,
  type DocumentReference,
} from 'firebase-admin/firestore';

import {
  assertOid,
  decodeRefName,
  encodeRefName,
  RefCasError,
  type CasFailure,
  type CasResult,
  type Oid,
  type RefDocument,
} from './model';

export interface RefStoreOptions {
  firestore: Firestore;
  /** Top-level collection holding one document per repository. */
  rootCollection?: string;
  /**
   * Opaque writer identity recorded on each successful update, for forensics
   * only. Suggested: `${K_REVISION}/${instanceId}/${requestId}`.
   */
  writerId: string;
  /**
   * Application-level retry budget for TRANSIENT infrastructure failures only.
   * This sits on top of the client library's own maxAttempts (default 5).
   * A CAS mismatch is NEVER retried here — see refuse-to-retry note below.
   */
  maxTransientRetries?: number;
}

/** gRPC status codes we treat as transient. */
const GRPC_ABORTED = 10;
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_INTERNAL = 13;
const GRPC_RESOURCE_EXHAUSTED = 8;

const TRANSIENT_CODES = new Set<number>([
  GRPC_ABORTED,
  GRPC_UNAVAILABLE,
  GRPC_DEADLINE_EXCEEDED,
  GRPC_INTERNAL,
  GRPC_RESOURCE_EXHAUSTED,
]);

function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RefStore {
  private readonly db: Firestore;
  private readonly root: string;
  private readonly writerId: string;
  private readonly maxTransientRetries: number;

  constructor(opts: RefStoreOptions) {
    this.db = opts.firestore;
    this.root = opts.rootCollection ?? 'repos';
    this.writerId = opts.writerId;
    this.maxTransientRetries = opts.maxTransientRetries ?? 3;
  }

  private refsCollection(repoId: string): CollectionReference {
    return this.db.collection(this.root).doc(repoId).collection('refs');
  }

  private refDoc(repoId: string, refName: string): DocumentReference {
    return this.refsCollection(repoId).doc(encodeRefName(refName));
  }

  /**
   * Read a ref. Non-transactional: the value is a point-in-time snapshot and
   * is stale the instant it is returned. That is fine and expected — the CAS
   * is what makes the eventual write safe, not the freshness of this read.
   */
  async readRef(repoId: string, refName: string): Promise<Oid | null> {
    const snap = await this.refDoc(repoId, refName).get();
    if (!snap.exists) return null;
    return (snap.data() as RefDocument).oid;
  }

  /** List every ref in a repo. One query; refs are few and tiny. */
  async listRefs(repoId: string): Promise<Array<{ ref: string; oid: Oid }>> {
    const snap = await this.refsCollection(repoId).get();
    return snap.docs.map((d) => {
      const data = d.data() as RefDocument;
      return { ref: data.ref ?? decodeRefName(d.id), oid: data.oid };
    });
  }

  /**
   * Atomic compare-and-set of a single ref.
   *
   *   expectedOid === null  -> CREATE. Succeeds only if the ref does not exist.
   *   expectedOid is an oid -> UPDATE. Succeeds only if the ref holds exactly that oid.
   *   newOid === null       -> DELETE. Requires a non-null expectedOid; you may
   *                            not delete a ref without saying what you believed
   *                            it held.
   *
   * Returns a discriminated union. It does NOT throw on a lost race, because a
   * lost race is an ordinary, expected outcome of a correct concurrent system,
   * not an exception. It throws only on genuine infrastructure failure.
   *
   * ------------------------------------------------------------------------
   * WHY THIS DOES NOT AUTO-RETRY ON MISMATCH
   * ------------------------------------------------------------------------
   * Re-reading the ref and re-issuing the CAS with the newly observed value
   * would turn a compare-and-swap into a blind overwrite with extra steps, and
   * would silently discard the winner's commits. A mismatch is a semantic
   * answer, not a transient fault. The caller must go back to the top: fetch
   * the new head, rebase/merge its work onto it, recompute newOid, and call
   * again. Only the caller knows whether that is safe.
   *
   * We DO retry on transient gRPC failures (ABORTED from contention that
   * outlasted the library's own 5 attempts, UNAVAILABLE, DEADLINE_EXCEEDED),
   * with full-jitter exponential backoff. Retrying those is safe because the
   * comparison is re-evaluated from scratch inside the new transaction: if the
   * first attempt actually committed, the second attempt observes newOid !==
   * expectedOid and returns STALE rather than double-applying. The operation
   * is idempotent by construction.
   */
  async compareAndSetRef(
    repoId: string,
    refName: string,
    expectedOid: Oid | null,
    newOid: Oid | null,
  ): Promise<CasResult> {
    if (expectedOid !== null) assertOid(expectedOid, 'compareAndSetRef(expectedOid)');
    if (newOid !== null) assertOid(newOid, 'compareAndSetRef(newOid)');
    if (expectedOid === null && newOid === null) {
      throw new TypeError('compareAndSetRef: refusing to delete a ref you expect not to exist (no-op)');
    }
    if (expectedOid !== null && expectedOid === newOid) {
      // Nothing to do. Do not burn a write; Firestore charges for it and it
      // consumes the per-document write budget for no reason.
      return { ok: true, ref: refName, previousOid: expectedOid, oid: newOid, generation: -1 };
    }

    const doc = this.refDoc(repoId, refName);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxTransientRetries; attempt++) {
      try {
        return await this.db.runTransaction<CasResult>(
          async (tx) => {
            // READ FIRST. Firestore requires all reads to precede all writes
            // inside a transaction, and on Standard edition this read takes a
            // pessimistic lock on the document for the transaction's duration.
            const snap = await tx.get(doc);
            const current = snap.exists ? (snap.data() as RefDocument) : null;
            const actualOid = current?.oid ?? null;
            const actualGeneration = current?.generation ?? null;

            const fail = (code: CasFailure['code']): CasFailure => ({
              ok: false,
              code,
              ref: refName,
              expectedOid,
              actualOid,
              actualGeneration,
            });

            if (expectedOid === null) {
              // CREATE
              if (current !== null) return fail('ALREADY_EXISTS');
            } else {
              // UPDATE or DELETE
              if (current === null) return fail('NOT_FOUND');
              if (actualOid !== expectedOid) return fail('STALE');
            }

            if (newOid === null) {
              tx.delete(doc);
              return {
                ok: true,
                ref: refName,
                previousOid: expectedOid,
                oid: null,
                generation: (actualGeneration ?? 0) + 1,
              };
            }

            const nextGeneration = (actualGeneration ?? 0) + 1;
            // tx.set with a whole document, not tx.update with a merge: the
            // document is five small fields and a full rewrite removes any
            // possibility of a stale field surviving a schema change.
            tx.set(doc, {
              ref: refName,
              oid: newOid,
              generation: nextGeneration,
              updatedAt: FieldValue.serverTimestamp(),
              updatedBy: this.writerId,
            });

            return {
              ok: true,
              ref: refName,
              previousOid: expectedOid,
              oid: newOid,
              generation: nextGeneration,
            };
          },
          // maxAttempts defaults to 5; stated explicitly so the retry budget
          // is visible at the call site rather than inherited silently.
          { maxAttempts: 5 },
        );
      } catch (err) {
        lastError = err;
        if (!isTransient(err) || attempt === this.maxTransientRetries) throw err;
        // Full jitter: 100ms, 200ms, 400ms ceilings. Keeps two racing pushers
        // from re-colliding in lockstep.
        const ceiling = 100 * 2 ** attempt;
        await sleep(Math.random() * ceiling);
      }
    }
    /* istanbul ignore next -- loop always returns or throws */
    throw lastError;
  }

  /** Throwing variant, for call sites that prefer exceptions. */
  async compareAndSetRefOrThrow(
    repoId: string,
    refName: string,
    expectedOid: Oid | null,
    newOid: Oid | null,
  ): Promise<Oid | null> {
    const result = await this.compareAndSetRef(repoId, refName, expectedOid, newOid);
    if (!result.ok) throw new RefCasError(result);
    return result.oid;
  }
}
