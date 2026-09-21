// SPDX-License-Identifier: Apache-2.0
//
// [PC-ANCHOR-V1] Turn the witness records into evidence, out of band.
//
// WHY THIS IS A SEPARATE THING AND NOT PART OF THE WITNESS. A hash chain needs a serialized head:
// entry N+1 cannot be written until entry N's hash is known. Doing that on the hot path would mean
// every tool call in the fleet queuing behind one Firestore document, which has a sustained ceiling
// of roughly one write per second. So the witness writes fast, unordered records, and the ordering,
// the chain and the root are computed HERE, afterwards, over a deterministic total order.
//
// WHAT IT GIVES YOU THAT THE RAW RECORDS DO NOT.
//
//   * ORDER. Firestore hands back documents; it does not hand back a sequence. The anchor fixes one
//     -- (timestamp, document id) ascending -- and every reader that follows it gets the same log.
//
//   * TAMPER-EVIDENCE. Each anchored entry carries prev_hash, and entry_hash is computed over a
//     payload that includes prev_hash. Editing entry 5 breaks entry 6, and so on to the head.
//
//   * A ROOT. One RFC 6962 Merkle root over the canonical lines covers every entry up to tree_size
//     with a single value. That is what a signature signs, and it is what catches the one attack a
//     chain alone cannot: a rewrite from genesis, which leaves no internal inconsistency at all.
//
//   * A COUNT. tree_size is a number. A record deleted from the end leaves a perfectly valid chain
//     and is caught by nothing except a checkpoint that commits to more entries than the log holds.
//
// IT DOES NOT SIGN YET, AND IT SAYS SO RATHER THAN IMPLYING OTHERWISE. The checkpoint this writes
// carries signature: null and anchored: false. An unsigned root is tamper-EVIDENT and nothing more:
// anyone who can write the store can recompute the chain from genesis and produce one that
// verifies. Reporting that as anchored would tell an operator the opposite of the truth. Signing
// needs a KMS key of its own -- NOT the approval-signing key, which exists to bind approvals and
// would be conflating two very different statements -- and that is an operator IAM grant, not a
// code change.
//
// RESUMABLE BY CONSTRUCTION. The watermark is the (timestamp, id) of the last anchored record plus
// the chain head hash and the count so far. Re-running after a crash continues the same chain
// rather than starting a second one, and re-running with nothing new is a no-op that still reports
// the head. A worker that cannot be run twice safely is a worker nobody dares schedule.

import { canonicalize, digest } from './evidence.js';
import { createHash } from 'crypto';

export const GENESIS = 'sha256:' + '0'.repeat(64);

// ---------------------------------------------------------------- RFC 6962
//
// MTH({}) = SHA256(); MTH(d[0]) = SHA256(0x00 || d[0]);
// MTH(D[n]) = SHA256(0x01 || MTH(D[0:k]) || MTH(D[k:n])), k = largest power of two < n.
//
// The 0x00 / 0x01 domain separators are the reason to use a specified construction rather than
// hashing pairs: without them a leaf can be presented as an interior node, which is the
// second-preimage attack RFC 6962 exists to prevent.

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);
const sha = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
export const leafHash = (d: Buffer): Buffer => sha(Buffer.concat([LEAF, d]));
export const nodeHash = (l: Buffer, r: Buffer): Buffer => sha(Buffer.concat([NODE, l, r]));

function kOf(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function rootOf(hashed: Buffer[]): Buffer {
  if (hashed.length === 1) return hashed[0];
  const k = kOf(hashed.length);
  return nodeHash(rootOf(hashed.slice(0, k)), rootOf(hashed.slice(k)));
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha(Buffer.alloc(0));
  return rootOf(leaves.map(leafHash));
}

// ---------------------------------------------------------------- the chain

export interface Watermark {
  /** Chain head after the last anchored entry, or GENESIS. */
  head: string;
  /** Number of entries anchored so far. This is the next tree_size floor. */
  count: number;
  /** The (timestamp, id) cursor, so the next run resumes rather than restarting. */
  last_ts: string | null;
  last_id: string | null;
  /**
   * The RFC 6962 right-hand fringe: hex hashes of the perfect subtrees covering everything
   * anchored so far, left to right, sizes strictly decreasing.
   *
   * THIS IS WHAT MAKES THE CHECKPOINT MEAN ANYTHING. The anchor writes BOUNDED SEGMENTS, so a run
   * only ever holds its own new lines. Computing the root over just those and publishing it beside
   * a CUMULATIVE tree_size was the first design, and it was close to worthless: such a root commits
   * to the newest segment alone, so rewriting any earlier segment leaves it matching. Carrying the
   * fringe lets each run extend the tree and publish a root over ALL tree_size entries while still
   * only reading its own batch -- log2(n) hashes instead of the whole log.
   */
  fringe: string[];
}

export const EMPTY_WATERMARK: Watermark = {
  head: GENESIS, count: 0, last_ts: null, last_id: null, fringe: [],
};

/**
 * Append one leaf to the fringe, merging equal-sized neighbours, exactly as RFC 6962 builds a tree.
 *
 * The invariant: entry i of the fringe covers a PERFECT subtree, and the sizes strictly decrease
 * left to right. Appending can only merge from the right, which is why this is O(1) amortised.
 */
export function fringeAppend(fringe: string[], leaf: Buffer, sizes: number[]): void {
  fringe.push(leaf.toString('hex'));
  sizes.push(1);
  while (sizes.length > 1 && sizes[sizes.length - 1] === sizes[sizes.length - 2]) {
    const r: Buffer = Buffer.from(fringe.pop() as string, 'hex') as Buffer;
    const l: Buffer = Buffer.from(fringe.pop() as string, 'hex') as Buffer;
    const n = sizes.pop() as number;
    sizes.pop();
    fringe.push(nodeHash(l, r).toString('hex'));
    sizes.push(n * 2);
  }
}

/** The perfect-subtree sizes implied by a count, largest first. Recovers `sizes` from the fringe. */
export function fringeSizes(count: number): number[] {
  const out: number[] = [];
  let n = count;
  let bit = 1;
  while (bit <= n) bit <<= 1;
  bit >>= 1;
  while (bit >= 1) {
    if (n >= bit) { out.push(bit); n -= bit; }
    bit >>= 1;
  }
  return out;
}

/**
 * Fold a fringe into the tree head, right to left.
 *
 * Right to left because the rightmost subtree is the shallowest: MTH(D[n]) splits at the largest
 * power of two below n, so everything to the right of that split is the smaller sibling.
 */
export function fringeRoot(fringe: string[]): Buffer {
  if (!fringe.length) return sha(Buffer.alloc(0));
  let r: Buffer = Buffer.from(fringe[fringe.length - 1], 'hex') as Buffer;
  for (let i = fringe.length - 2; i >= 0; i--) {
    r = nodeHash(Buffer.from(fringe[i], 'hex') as Buffer, r);
  }
  return r;
}

export interface WitnessRow {
  id: string;
  /** ISO 8601. Firestore timestamps must be normalised to this before they get here. */
  ts: string;
  data: { [k: string]: any };
}

export interface AnchoredEntry {
  v: number;
  typ: string;
  seq: number;
  at: string;
  source_id: string;
  record_digest: string;
  prev_hash: string;
  entry_hash?: string;
}

/**
 * The payload entry_hash is computed over: the entry MINUS its own entry_hash.
 *
 * Excluding the field is not a detail. An entry cannot commit to a value it does not yet have, and
 * a scheme that hashes a placeholder gives two different hashes for the same entry depending on
 * which placeholder was used.
 */
export function hashPayload(entry: AnchoredEntry): { [k: string]: any } {
  const out: { [k: string]: any } = {};
  for (const k of Object.keys(entry)) {
    if (k === 'entry_hash') continue;
    out[k] = (entry as any)[k];
  }
  return out;
}

/**
 * Fix the order. Ascending by timestamp, then by document id.
 *
 * The id tiebreak is what makes this a TOTAL order rather than merely a sorted one: Firestore
 * timestamps collide, and two readers that break a tie differently produce two different logs with
 * two different roots, both of which verify internally. That is the worst possible outcome for an
 * evidence system -- two honest parties disagreeing about what happened.
 */
export function orderRows(rows: WitnessRow[]): WitnessRow[] {
  return rows.slice().sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

/** Rows at or before the watermark cursor. Dropped so a re-run does not double-anchor. */
export function afterWatermark(rows: WitnessRow[], wm: Watermark): WitnessRow[] {
  if (!wm.last_ts) return rows;
  return rows.filter((r) => {
    if (r.ts > (wm.last_ts as string)) return true;
    if (r.ts < (wm.last_ts as string)) return false;
    return r.id > (wm.last_id as string);
  });
}

export interface AnchorSegment {
  entries: AnchoredEntry[];
  lines: string[];
  watermark: Watermark;
  checkpoint: {
    v: number;
    typ: string;
    at: string;
    tree_size: number;
    merkle_root: string;
    head_hash: string;
    merkle_algorithm: string;
    hash_algorithm: string;
    /** Null until a signing key exists. See the header: this is stated, not implied. */
    signature: null;
    /** False while signature is null. An unsigned root is tamper-evident, not non-repudiable. */
    anchored: boolean;
  };
}

/**
 * Chain a batch of rows onto an existing watermark and produce the segment plus a checkpoint.
 *
 * Pure apart from the clock, which is injected. Everything here is driven directly by tests: no
 * Firestore, no GCS, no KMS.
 */
export function chainRows(rows: WitnessRow[], wm: Watermark, nowIso: string): AnchorSegment {
  const ordered = afterWatermark(orderRows(rows), wm);
  const entries: AnchoredEntry[] = [];
  const lines: string[] = [];

  let prev = wm.head;
  let seq = wm.count;
  let lastTs = wm.last_ts;
  let lastId = wm.last_id;

  for (const row of ordered) {
    seq += 1;
    const entry: AnchoredEntry = {
      v: 1,
      typ: 'pc.anchor.entry.v1',
      seq: seq,
      at: row.ts,
      source_id: row.id,
      // The whole source record, canonicalized and hashed. The record itself stays in Firestore;
      // what is chained is a commitment to it, so the chain is small and the record is still the
      // thing an auditor reads.
      record_digest: digest(row.data),
      prev_hash: prev,
    };
    entry.entry_hash = digest(hashPayload(entry));
    entries.push(entry);
    // The canonical form IS the line. There is exactly one byte sequence a given entry can be
    // written as, so "the line I am reading" and "the bytes that were hashed" are the same thing,
    // and re-indenting is itself a detectable edit rather than a free rewrite.
    lines.push(canonicalize(entry));
    prev = entry.entry_hash as string;
    lastTs = row.ts;
    lastId = row.id;
  }

  // Extend the tree rather than building a new one over this batch. See Watermark.fringe.
  const fringe = (wm.fringe || []).slice();
  const sizes = fringeSizes(wm.count);
  for (const line of lines) fringeAppend(fringe, leafHash(Buffer.from(line, 'utf8')), sizes);
  const root = 'sha256:' + fringeRoot(fringe).toString('hex');

  return {
    entries,
    lines,
    watermark: { head: prev, count: seq, last_ts: lastTs, last_id: lastId, fringe: fringe },
    checkpoint: {
      v: 1,
      typ: 'pc.checkpoint.v1',
      at: nowIso,
      tree_size: seq,
      merkle_root: root,
      head_hash: prev,
      merkle_algorithm: 'RFC6962-SHA256',
      hash_algorithm: 'RFC8785-JCS-SHA256',
      signature: null,
      anchored: false,
    },
  };
}

// ---------------------------------------------------------------- verification

export type FindingKind = 'hash_mismatch' | 'sequence_gap' | 'broken_link' | 'merkle_root_mismatch'
  | 'checkpoint_beyond_log' | 'unanchored' | 'root_not_checked';

export interface Finding { seq: number | null; kind: FindingKind; detail: string; }

/**
 * Where a run of lines sits in the chain. Omit it for a whole log read from the beginning.
 *
 * THIS EXISTS BECAUSE A SEGMENT IS NOT A LOG, and conflating the two was a real bug: the anchor
 * writes bounded segments, so every segment after the first starts at some seq > 1 with a
 * prev_hash that is the previous segment's head, NOT genesis. Verifying one against the defaults
 * reports broken_link and sequence_gap on a perfectly good segment -- which is exactly what
 * happened, and what made the second and every later anchor run refuse its own correct output.
 */
export interface ChainStart {
  /** The chain head this run of lines continues from. GENESIS for the first. */
  prevHash: string;
  /** How many entries precede these lines. 0 for the first. */
  seqOffset: number;
  /**
   * The fringe covering those preceding entries. REQUIRED whenever seqOffset > 0.
   *
   * Without it the root can only be computed over the lines in hand, which is a DIFFERENT tree from
   * the one the checkpoint commits to -- and comparing the two reports merkle_root_mismatch on a
   * perfectly good segment. That is not a hypothetical: it is what this function did until the
   * segmented worker exercised it. When it is absent and seqOffset > 0 the root is not checked at
   * all, and that is reported as a finding rather than passed over.
   */
  prevFringe?: string[];
}

const FROM_GENESIS: ChainStart = { prevHash: GENESIS, seqOffset: 0, prevFringe: [] };

/**
 * Replay a chain from its lines and report where it breaks.
 *
 * Takes the LINES, not parsed objects, and re-parses them here. A verifier handed objects it
 * serialized itself is checking its own serializer rather than the log.
 */
export function verifyChain(lines: string[], checkpoint?: AnchorSegment['checkpoint'] | null,
                            start?: ChainStart): Finding[] {
  const from = start || FROM_GENESIS;
  const findings: Finding[] = [];
  let prev = from.prevHash;

  for (let i = 0; i < lines.length; i++) {
    const seq = from.seqOffset + i + 1;
    const entry = JSON.parse(lines[i]) as AnchoredEntry;
    const recorded = entry.entry_hash as string;
    const recomputed = digest(hashPayload(entry));

    if (recomputed !== recorded) {
      findings.push({ seq, kind: 'hash_mismatch',
        detail: 'entry ' + seq + ' records ' + recorded + ' but its contents hash to ' + recomputed
          + '. This entry was edited in place.' });
    }
    if (entry.seq !== seq) {
      findings.push({ seq, kind: 'sequence_gap',
        detail: 'this line should carry seq ' + seq + ' and carries ' + entry.seq + '. Sequence '
          + 'numbers are positions in the whole chain, so a mismatch means entries were inserted, '
          + 'removed or reordered.' });
    }
    if (entry.prev_hash !== prev) {
      findings.push({ seq, kind: 'broken_link',
        detail: 'entry ' + seq + ' names predecessor ' + entry.prev_hash + ' but the previous line '
          + 'hashes to ' + prev + '.' });
    }
    prev = recorded;
  }

  if (checkpoint) {
    const covered = from.seqOffset + lines.length;
    // Extend the preceding fringe rather than building a tree over these lines alone. With
    // seqOffset 0 and an empty fringe this is exactly merkleRoot(lines); with an offset it is the
    // whole tree, which is what the checkpoint commits to.
    let root: string | null = null;
    if (from.seqOffset === 0 || (from.prevFringe && from.prevFringe.length)) {
      const fr = (from.prevFringe || []).slice();
      const sizes = fringeSizes(from.seqOffset);
      for (const l of lines) fringeAppend(fr, leafHash(Buffer.from(l, 'utf8')), sizes);
      root = 'sha256:' + fringeRoot(fr).toString('hex');
    } else {
      findings.push({ seq: null, kind: 'root_not_checked',
        detail: 'these lines start at entry ' + (from.seqOffset + 1) + ' and no fringe for the '
          + from.seqOffset + ' entries before them was supplied, so the Merkle root was NOT '
          + 'verified. The links and sequence numbers above were. Supply prevFringe, or verify '
          + 'the whole log from genesis.' });
    }
    if (covered < checkpoint.tree_size) {
      findings.push({ seq: checkpoint.tree_size, kind: 'checkpoint_beyond_log',
        detail: 'the checkpoint commits to ' + checkpoint.tree_size + ' entries and these lines '
          + 'account for ' + covered + '. Entries were deleted from the end: truncation leaves a '
          + 'perfectly valid chain, and this is the only thing that catches it.' });
    }
    if (root !== null && root !== checkpoint.merkle_root) {
      findings.push({ seq: null, kind: 'merkle_root_mismatch',
        detail: 'the checkpoint signs root ' + checkpoint.merkle_root + '; these entries now hash to '
          + root + '. The log was rewritten. A rewrite leaves no internal inconsistency, so this is '
          + 'the layer that catches it.' });
    }
    if (!checkpoint.signature) {
      findings.push({ seq: null, kind: 'unanchored',
        detail: 'no signature covers this checkpoint. The chain is tamper-evident and nothing more: '
          + 'anyone who can write the store can rebuild it from genesis and produce a chain that '
          + 'verifies. This is reported rather than assumed away.' });
    }
  } else {
    findings.push({ seq: null, kind: 'unanchored',
      detail: 'no checkpoint was supplied, so nothing commits to a length or a root.' });
  }

  return findings;
}

/**
 * True only when the chain is intact AND something signs it.
 *
 * `unanchored` is deliberately NOT excused here. A chain with no signature is an audit log, and
 * reporting it as verified would tell an operator the opposite of the truth.
 */
export function chainIsVerified(findings: Finding[]): boolean {
  return findings.length === 0;
}

/** True when the chain itself is intact, ignoring whether anything signs it. */
export function chainIsIntact(findings: Finding[]): boolean {
  return findings.filter((f) => f.kind !== 'unanchored').length === 0;
}

/** The findings that mean the LOG is wrong, as opposed to merely unsigned or unchecked. */
export function structuralFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.kind !== 'unanchored' && f.kind !== 'root_not_checked');
}
