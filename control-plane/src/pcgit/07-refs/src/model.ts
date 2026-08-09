/**
 * 07-refs / model.ts
 *
 * Document model and value types for the Firestore-backed git ref store.
 *
 * Storage layout (from 01-cost-model.md, layout (b)):
 *   git objects  -> GCS   gs://<bucket>/<repoId>/objects/**
 *   refs         -> Firestore  repos/{repoId}/refs/{encodedRefName}
 *
 * A ref is the ONLY piece of mutable, correctness-critical state in the system.
 * Everything under objects/ is content-addressed and immutable, so it needs no
 * concurrency control at all. All of our concurrency control therefore lives in
 * exactly one place: compareAndSetRef() in ./refs.ts.
 */

import type { Timestamp } from 'firebase-admin/firestore';

/** A 40-character lowercase hex SHA-1 object id. */
export type Oid = string;

const OID_RE = /^[0-9a-f]{40}$/;

/** git's "null oid" — the value git's own protocol uses for create/delete. */
export const ZERO_OID = '0'.repeat(40);

export function isOid(value: unknown): value is Oid {
  return typeof value === 'string' && OID_RE.test(value);
}

export function assertOid(value: unknown, what: string): asserts value is Oid {
  if (!isOid(value)) {
    throw new TypeError(`${what}: expected a 40-char lowercase hex oid, got ${JSON.stringify(value)}`);
  }
}

/**
 * Normalise git's protocol-level null oid to our `null`.
 * The wire protocol says "all zeroes" for both "create this ref" (old side)
 * and "delete this ref" (new side); internally we use `null` for both so the
 * type system forces callers to handle absence.
 */
export function fromWireOid(value: string): Oid | null {
  return value === ZERO_OID ? null : value;
}

export function toWireOid(value: Oid | null): string {
  return value === null ? ZERO_OID : value;
}

/**
 * The Firestore document stored at repos/{repoId}/refs/{encodeRefName(ref)}.
 *
 * Deliberately tiny. Every field here is written on every ref update, and
 * every indexed field adds latency and index-write cost to that update
 * (Firestore best practices: "the number affected indexes" is one of the
 * factors that determines the achievable single-document write rate).
 *
 * OPERATIONAL REQUIREMENT: create a single-field index exemption for this
 * collection covering `updatedAt` and `generation`. Both are monotonically
 * increasing, and Firestore caps a collection containing a monotonically
 * increasing INDEXED field at 500 writes/second collection-wide. Indexing
 * either of these would take a per-document concern and make it a
 * whole-repo concern for no benefit — we never query refs by time.
 * See firebase.google.com/docs/firestore/solutions/shard-timestamp
 */
export interface RefDocument {
  /** Canonical full ref name, e.g. "refs/heads/main". Stored so that the
   *  document is self-describing even though the id is an encoding of it. */
  ref: string;
  /** Current value of the ref. */
  oid: Oid;
  /** Incremented on every successful CAS. Forensics + a cheap fencing token
   *  for logs. Never used as a query key. NOT INDEXED. */
  generation: number;
  /** Server timestamp of the last successful CAS. NOT INDEXED. */
  updatedAt: Timestamp;
  /** Opaque writer identity (Cloud Run revision + instance id + request id).
   *  Purely for "who moved my branch" forensics. */
  updatedBy: string;
}

/** What compareAndSetRef returns on success. */
export interface CasSuccess {
  ok: true;
  ref: string;
  /** Value the ref had before this call. null means the ref was created. */
  previousOid: Oid | null;
  /** Value the ref has now. null means the ref was deleted. */
  oid: Oid | null;
  generation: number;
}

/**
 * Why a compare-and-set was refused.
 *
 * Every one of these means THE SAME THING to a pusher: you lost, your write
 * was NOT applied, and the remote is not where you thought it was. They are
 * distinguished only so the error message can be accurate.
 */
export type CasFailureCode =
  /** Ref exists but holds a different oid than expected. The classic
   *  non-fast-forward / lost-race case: someone else pushed first. */
  | 'STALE'
  /** Caller passed expectedOid === null (create) but the ref already exists.
   *  Another writer created the branch between our read and our write. */
  | 'ALREADY_EXISTS'
  /** Caller passed a non-null expectedOid but the ref does not exist.
   *  Someone deleted the branch under us. */
  | 'NOT_FOUND';

export interface CasFailure {
  ok: false;
  code: CasFailureCode;
  ref: string;
  /** What the caller believed the ref held. */
  expectedOid: Oid | null;
  /** What the ref actually held, observed inside the transaction. */
  actualOid: Oid | null;
  /** Generation observed inside the transaction, or null if the ref is absent. */
  actualGeneration: number | null;
}

export type CasResult = CasSuccess | CasFailure;

/**
 * Thrown by compareAndSetRefOrThrow(). Carries the observed remote state so
 * the caller can render a real git-style error and, if it wants, retry the
 * whole operation from a fresh base.
 */
export class RefCasError extends Error {
  readonly code: CasFailureCode;
  readonly ref: string;
  readonly expectedOid: Oid | null;
  readonly actualOid: Oid | null;

  constructor(failure: CasFailure) {
    super(formatCasFailure(failure));
    this.name = 'RefCasError';
    this.code = failure.code;
    this.ref = failure.ref;
    this.expectedOid = failure.expectedOid;
    this.actualOid = failure.actualOid;
  }
}

/** Message shaped like git's own, so it is intelligible to a human and to an agent. */
export function formatCasFailure(f: CasFailure): string {
  const short = (o: Oid | null) => (o === null ? '(none)' : o.slice(0, 7));
  switch (f.code) {
    case 'STALE':
      return (
        `! [rejected] ${f.ref} (non-fast-forward: lost race). ` +
        `Expected remote at ${short(f.expectedOid)}, but it is at ${short(f.actualOid)}. ` +
        `Another writer updated this ref first. Your update was NOT applied. ` +
        `Fetch ${f.ref}, rebase or merge onto ${short(f.actualOid)}, and push again.`
      );
    case 'ALREADY_EXISTS':
      return (
        `! [rejected] ${f.ref} (already exists). ` +
        `Tried to create the ref, but another writer created it first at ${short(f.actualOid)}. ` +
        `Your update was NOT applied.`
      );
    case 'NOT_FOUND':
      return (
        `! [rejected] ${f.ref} (deleted concurrently). ` +
        `Expected remote at ${short(f.expectedOid)}, but the ref no longer exists. ` +
        `Your update was NOT applied.`
      );
  }
}

/**
 * Firestore document ids may not contain '/', may not be '.' or '..', and may
 * not match /^__.*__$/. Git ref names contain '/' constantly. We percent-encode
 * '%' first and then '/', which is injective and therefore reversible; git's
 * own check-ref-format permits '%' in ref names, so encoding '%' is not
 * optional — without it "refs/heads/a%2Fb" and "refs/heads/a/b" would collide
 * on the same document and silently share a branch head.
 */
export function encodeRefName(ref: string): string {
  if (ref.length === 0) throw new TypeError('encodeRefName: empty ref name');
  const encoded = ref.replace(/%/g, '%25').replace(/\//g, '%2F');
  if (encoded === '.' || encoded === '..' || /^__.*__$/.test(encoded)) {
    throw new TypeError(`encodeRefName: ref name ${ref} maps to a reserved Firestore document id`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > 1500) {
    throw new TypeError(`encodeRefName: ref name ${ref} exceeds Firestore's 1500-byte document id limit`);
  }
  return encoded;
}

export function decodeRefName(docId: string): string {
  return docId.replace(/%2F/g, '/').replace(/%25/g, '%');
}
