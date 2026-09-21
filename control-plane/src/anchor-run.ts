// SPDX-License-Identifier: Apache-2.0
//
// [PC-ANCHOR-V1] The I/O half of the anchor. anchor.ts stays pure; everything that touches a store
// lives here, behind injected functions, so the ordering rules below are driven by tests rather
// than argued about.
//
// THE ORDER OF THE TWO WRITES IS THE WHOLE DESIGN, and it is not symmetric.
//
//   segment first, THEN the watermark.
//
// Get it the other way round and a crash between them loses records PERMANENTLY: the watermark says
// those rows are anchored, the segment that would have proved it was never written, and no later
// run will look at them again. Get it this way round and the same crash re-anchors the same rows on
// the next run -- which is recoverable, and which the deterministic object name below makes
// invisible.
//
// THE OBJECT NAME IS DERIVED FROM THE RANGE, NOT FROM THE CLOCK. A segment covering entries 41..90
// is always written to the same path, so a retry OVERWRITES its own previous attempt instead of
// leaving two segments that both claim the range. A name carrying a timestamp or a random suffix
// would turn a harmless retry into a permanent ambiguity about which copy is the log.
//
// ONE RUN IS BOUNDED. `limit` caps how many rows a single run anchors, so the worker has a
// predictable cost and a predictable duration no matter how far behind it is. Falling behind is
// handled by running it again -- the watermark makes that free -- rather than by one unbounded run
// that might not finish.
//
// IT NEVER DELETES THE SOURCE. The witness records stay in Firestore; what is chained is a
// COMMITMENT to each of them. The chain is small, the record is still the thing an auditor reads,
// and the anchor has no power to destroy evidence even if it is wrong.

import {
  chainRows, verifyChain, chainIsIntact, structuralFindings, EMPTY_WATERMARK,
  type Watermark, type WitnessRow, type AnchorSegment,
} from './anchor.js';

export interface RunDeps {
  /** Rows strictly after the watermark, ascending, at most `limit`. */
  readRows: (after: Watermark, limit: number) => Promise<WitnessRow[]>;
  /** Durable, append-only-by-convention store for the chain. Name is deterministic; see header. */
  putObject: (name: string, body: string) => Promise<void>;
  loadWatermark: () => Promise<Watermark | null>;
  saveWatermark: (wm: Watermark) => Promise<void>;
  /** ISO 8601. Injected so a test can pin it. */
  now: () => string;
}

export interface RunReport {
  anchored: number;
  tree_size: number;
  head_hash: string;
  merkle_root: string;
  /** The object the segment was written to, or null when there was nothing to anchor. */
  segment: string | null;
  /** Always false in v1: nothing signs the checkpoint yet. Reported, not implied. */
  signed: boolean;
  /** Set when the segment this run produced does not verify. The watermark is NOT advanced. */
  refused?: string;
}

const PREFIX = 'anchor/tool_witness';

/** `anchor/tool_witness/00000041-00000090.jsonl` -- fixed width so lexical order is numeric order. */
export function segmentName(fromSeq: number, toSeq: number): string {
  const pad = (n: number) => String(n).padStart(8, '0');
  return PREFIX + '/' + pad(fromSeq) + '-' + pad(toSeq) + '.jsonl';
}

/** `anchor/tool_witness/checkpoint-00000090.json` -- one per segment, named by what it commits to. */
export function checkpointName(toSeq: number): string {
  return PREFIX + '/checkpoint-' + String(toSeq).padStart(8, '0') + '.json';
}

/**
 * Anchor one bounded batch. Safe to run again immediately, and safe to run twice at once in the
 * sense that the loser writes the same bytes to the same names.
 */
export async function anchorRun(deps: RunDeps, limit = 500): Promise<RunReport> {
  const wm = (await deps.loadWatermark()) || EMPTY_WATERMARK;
  const rows = await deps.readRows(wm, limit);

  if (!rows.length) {
    // A quiet period is not an error and not a no-op worth hiding: report the head so a scheduler
    // log shows the chain is alive and where it stands.
    return {
      anchored: 0,
      tree_size: wm.count,
      head_hash: wm.head,
      merkle_root: '',
      segment: null,
      signed: false,
    };
  }

  // A non-empty chain with no fringe cannot be extended: the root would cover only this batch.
  // Refuse rather than publish a checkpoint that commits to less than its own tree_size claims.
  if (wm.count > 0 && (!wm.fringe || wm.fringe.length === 0)) {
    return {
      anchored: 0, tree_size: wm.count, head_hash: wm.head,
      merkle_root: '', segment: null, signed: false,
      refused: 'the stored watermark reports ' + wm.count + ' anchored entries but carries no '
        + 'Merkle fringe, so this run cannot extend the existing tree. Continuing would publish a '
        + 'root covering only the new batch beside a cumulative tree_size, which commits to less '
        + 'than it claims. Rebuild the fringe from the existing segments, or start a new chain '
        + 'deliberately.',
    };
  }

  const seg: AnchorSegment = chainRows(rows, wm, deps.now());
  if (!seg.entries.length) {
    // Every row was at or before the cursor. Same shape as above.
    return {
      anchored: 0, tree_size: wm.count, head_hash: wm.head,
      merkle_root: '', segment: null, signed: false,
    };
  }

  // VERIFY WHAT WE ARE ABOUT TO WRITE, BEFORE WRITING IT. This is cheap and it is the difference
  // between a worker that produces evidence and one that produces a file. `unanchored` is expected
  // here -- nothing signs it yet -- so only structural findings count.
  // Verified AS A SEGMENT, from the watermark, not from genesis. Handing these lines the default
  // start reports broken_link and sequence_gap on correct output, because entry 1 of this segment
  // legitimately names the previous segment's head rather than GENESIS.
  const findings = verifyChain(seg.lines, seg.checkpoint,
    { prevHash: wm.head, seqOffset: wm.count, prevFringe: wm.fringe });
  if (structuralFindings(findings).length) {
    const first = structuralFindings(findings)[0];
    return {
      anchored: 0, tree_size: wm.count, head_hash: wm.head,
      merkle_root: '', segment: null, signed: false,
      refused: 'the segment this run built does not verify (' + first.kind + ' at seq '
        + String(first.seq) + '): ' + first.detail + ' Nothing was written and the watermark was '
        + 'not advanced, so the next run retries the same rows.',
    };
  }

  const fromSeq = wm.count + 1;
  const toSeq = seg.watermark.count;
  const name = segmentName(fromSeq, toSeq);

  // Segment first. See the header: the other order loses records on a crash.
  await deps.putObject(name, seg.lines.join('\n') + '\n');
  await deps.putObject(checkpointName(toSeq), JSON.stringify(seg.checkpoint, null, 2) + '\n');
  await deps.saveWatermark(seg.watermark);

  return {
    anchored: seg.entries.length,
    tree_size: seg.checkpoint.tree_size,
    head_hash: seg.checkpoint.head_hash,
    merkle_root: seg.checkpoint.merkle_root,
    segment: name,
    signed: false,
  };
}

// ---------------------------------------------------------------- concrete adapters

/**
 * Render a Firestore Timestamp as a fixed-width, NANOSECOND-precision instant.
 *
 * `toDate().toISOString()` is the obvious thing to write here and it is WRONG, because it truncates
 * to milliseconds and Firestore server timestamps carry microseconds.
 *
 * anchor.orderRows compares `ts` AS A STRING. Truncate it and the anchor's order stops agreeing
 * with the order Firestore paged the rows out in -- and then a row that Firestore correctly returns
 * after the cursor is discarded by afterWatermark for sorting before it. The watermark moves on, no
 * later run looks at that row again, and a record is gone from the evidence with nothing reporting
 * it. Nine zero-padded digits keep lexical order identical to chronological order.
 */
export function firestoreTs(ts: any): string | null {
  if (!ts) return null;
  let seconds: number, nanos: number;
  if (typeof ts.seconds === 'number' && typeof ts.nanoseconds === 'number') {
    seconds = ts.seconds;
    nanos = ts.nanoseconds;
  } else if (typeof ts.toDate === 'function') {
    const ms = ts.toDate().getTime();
    if (!isFinite(ms)) return null;
    seconds = Math.floor(ms / 1000);
    nanos = (ms - seconds * 1000) * 1e6;
  } else {
    return null;
  }
  const base = new Date(seconds * 1000).toISOString();
  return base.slice(0, 19) + '.' + String(Math.floor(nanos)).padStart(9, '0') + 'Z';
}

/**
 * Read witness rows from Firestore in the anchor's total order.
 *
 * orderBy(timestamp) THEN orderBy(__name__) is not optional: it is the same total order
 * anchor.orderRows defines, and a reader that omits the document-id tiebreak can hand back two
 * different sequences for the same data on two different days.
 *
 * THE CURSOR IS THE DOCUMENT ITSELF, not a timestamp read off the watermark. startAfter(snapshot)
 * makes Firestore take the ordering values from the stored document, at the precision it stored
 * them, so the resume point is exact by construction rather than by our arithmetic agreeing with
 * theirs. A cursor rebuilt from a formatted string is one rounding away from skipping a record.
 *
 * If that document is gone the run STOPS. Guessing a nearby position is how a gap gets written into
 * a log whose whole purpose is that gaps are visible.
 */
export function firestoreReader(db: any, collection = 'tool_witness') {
  return async (after: Watermark, limit: number): Promise<WitnessRow[]> => {
    const col = db.collection(collection);
    let q = col.orderBy('timestamp').orderBy('__name__').limit(limit);
    if (after.last_id) {
      const cursor = await col.doc(after.last_id).get();
      if (!cursor || !cursor.exists) {
        throw new Error(
          'anchor cursor document ' + collection + '/' + after.last_id + ' no longer exists, so '
          + 'this run cannot establish where the last one stopped. Nothing was read and the '
          + 'watermark was not touched. Restore the document, or reset the chain deliberately -- '
          + 'do not let the anchor resume from a guessed position.');
      }
      q = q.startAfter(cursor);
    }
    const snap = await q.get();
    const docs: any[] = [];
    snap.forEach((doc: any) => docs.push(doc));

    const out: WitnessRow[] = [];
    for (const doc of docs) {
      const data = doc.data() || {};
      const ts = firestoreTs(data.timestamp);
      // A record with no usable timestamp has no place in the order -- and SKIPPING it would be the
      // same silent loss as above, because the rows after it would advance the cursor past it
      // forever. Truncate the page here instead, so the next run starts at this row.
      //
      // Unless it is the FIRST row, in which case truncating returns an empty page and the anchor
      // quietly stops growing for as long as that document sits at the head of the queue. A chain
      // that has silently stopped is the failure this whole component exists to make impossible, so
      // that case is an error, not a short page.
      if (!ts) {
        if (!out.length) {
          throw new Error(
            'anchor cannot order ' + collection + '/' + doc.id + ': its `timestamp` field is '
            + 'missing or is not a Firestore Timestamp, and it sorts at the head of the unanchored '
            + 'queue. Reading past it would advance the cursor beyond it permanently, so this run '
            + 'read nothing. Fix or remove that document -- until then the chain cannot advance.');
        }
        break;
      }
      const plain: { [k: string]: any } = {};
      for (const k of Object.keys(data)) {
        if (k === 'timestamp') continue;
        plain[k] = data[k];
      }
      out.push({ id: doc.id, ts: ts, data: plain });
    }
    return out;
  };
}

/** The watermark lives in Firestore next to nothing else, as a single well-known document. */
export function firestoreWatermark(db: any, doc = 'anchor_state/tool_witness') {
  const ref = () => db.doc(doc);
  return {
    load: async (): Promise<Watermark | null> => {
      const d = await ref().get();
      if (!d.exists) return null;
      const x = d.data() || {};
      return {
        head: String(x.head || EMPTY_WATERMARK.head),
        count: Number(x.count || 0),
        last_ts: x.last_ts ? String(x.last_ts) : null,
        last_id: x.last_id ? String(x.last_id) : null,
        // A stored watermark with no fringe is from before the fringe existed. Defaulting to []
        // would silently start a SECOND tree beside the first, so the reader surfaces it as an
        // empty fringe on a non-zero count and anchorRun refuses below rather than guessing.
        fringe: Array.isArray(x.fringe) ? x.fringe.map(String) : [],
      };
    },
    save: async (wm: Watermark): Promise<void> => { await ref().set(wm); },
  };
}

/**
 * Store the watermark in Cloud Storage rather than in Firestore.
 *
 * This decouples anchor state writes from the witness database, allowing the anchor to operate
 * with read-only access to Firestore and write access scoped solely to the destination bucket.
 */
export function gcsWatermark(bucket: any, path = PREFIX + '/watermark.json') {
  const f = () => bucket.file(path);
  return {
    load: async (): Promise<Watermark | null> => {
      const [exists] = await f().exists();
      if (!exists) return null;
      const [buf] = await f().download();
      const x = JSON.parse(buf.toString('utf8')) || {};
      return {
        head: String(x.head || EMPTY_WATERMARK.head),
        count: Number(x.count || 0),
        last_ts: x.last_ts ? String(x.last_ts) : null,
        last_id: x.last_id ? String(x.last_id) : null,
        fringe: Array.isArray(x.fringe) ? x.fringe.map(String) : [],
      };
    },
    save: async (wm: Watermark): Promise<void> => {
      await f().save(Buffer.from(JSON.stringify(wm), 'utf8'), {
        contentType: 'application/json',
        resumable: false,
      });
    },
  };
}

/**
 * Write the chain to Cloud Storage rather than back into Firestore.
 *
 * DELIBERATE: a chain stored in the same database as the records it commits to can be rewritten by
 * exactly the same credential that could rewrite the records. Putting it in a bucket means the two
 * stores can carry different IAM, and "who could have forged this" becomes a question with a
 * narrower answer.
 */
export function gcsWriter(bucket: any) {
  return async (name: string, body: string): Promise<void> => {
    await bucket.file(name).save(Buffer.from(body, 'utf8'), {
      contentType: 'application/x-ndjson',
      resumable: false,
    });
  };
}
