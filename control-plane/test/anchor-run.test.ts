// SPDX-License-Identifier: Apache-2.0
// Drives anchor-run.ts with an in-memory store. No Firestore, no GCS.
//
// The tests that matter are about ORDER and CRASHES, because those are the only two ways a worker
// like this loses evidence, and neither shows up in a happy-path run.
import {
  anchorRun, segmentName, checkpointName, firestoreReader, firestoreWatermark, gcsWatermark,
  type RunDeps,
} from "../src/anchor-run.js";
import { EMPTY_WATERMARK, verifyChain, chainIsIntact, type Watermark, type WitnessRow } from "../src/anchor.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

const NOW = "2026-09-12T06:00:00.000Z";

function row(id: string, ts: string): WitnessRow {
  return { id, ts, data: { tool: "git_read", role: "fleet-x" } };
}

/** An in-memory world: rows to read, objects written, one watermark, and a failure injector. */
function world(rows: WitnessRow[]) {
  const objects: { [name: string]: string } = {};
  let wm: Watermark | null = null;
  let failPut = 0;
  let failSave = 0;
  const deps: RunDeps = {
    readRows: async (after, limit) => {
      const sorted = rows.slice().sort((a, b) => (a.ts + a.id < b.ts + b.id ? -1 : 1));
      const fresh = after.last_ts
        ? sorted.filter((r) => r.ts > after.last_ts! || (r.ts === after.last_ts! && r.id > after.last_id!))
        : sorted;
      return fresh.slice(0, limit);
    },
    putObject: async (name, body) => {
      if (failPut > 0) { failPut--; throw new Error("gcs unavailable"); }
      objects[name] = body;
    },
    loadWatermark: async () => wm,
    saveWatermark: async (w) => {
      if (failSave > 0) { failSave--; throw new Error("firestore unavailable"); }
      wm = w;
    },
    now: () => NOW,
  };
  return {
    deps, objects,
    get wm() { return wm; },
    failPutOnce() { failPut = 1; },
    failSaveOnce() { failSave = 1; },
    add(r: WitnessRow) { rows.push(r); },
  };
}


// ---------------------------------------------------------------- a fake Firestore
//
// It orders by (seconds, nanoseconds, id) -- FULL PRECISION -- because that is what Firestore does,
// and the two bugs below only exist in the gap between that order and the one the anchor computes.

class FakeTs {
  constructor(public seconds: number, public nanoseconds: number) {}
  toDate() { return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)); }
}
interface FakeDoc { id: string; ts: FakeTs | null; tool?: string; }

function cmpDocs(a: FakeDoc, b: FakeDoc): number {
  const at = a.ts, bt = b.ts;
  // Firestore's type ordering puts null BEFORE every timestamp, so an unusable row sorts to the
  // head of the queue -- which is exactly what makes skipping it lose every row behind it.
  if (!at && bt) return -1;
  if (at && !bt) return 1;
  if (at && bt) {
    if (at.seconds !== bt.seconds) return at.seconds - bt.seconds;
    if (at.nanoseconds !== bt.nanoseconds) return at.nanoseconds - bt.nanoseconds;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function fakeDb(docs: FakeDoc[], store: { [k: string]: any } = {}) {
  const snapOf = (d: FakeDoc) => ({
    id: d.id, exists: true,
    data: () => { const o: any = { tool: d.tool || 'git_read' }; if (d.ts) o.timestamp = d.ts; return o; },
    __doc: d,
  });
  function query(after: FakeDoc | null, limit: number) {
    return {
      orderBy() { return this; },
      limit(n: number) { return query(after, n); },
      startAfter(snap: any) { return query(snap.__doc, limit); },
      async get() {
        // Firestore's own orderBy('timestamp') excludes documents that lack the field.
        const rows = docs.slice().sort(cmpDocs)
          .filter((d) => !after || cmpDocs(d, after) > 0).slice(0, limit);
        return { forEach: (f: any) => rows.map(snapOf).forEach(f) };
      },
    };
  }
  return {
    collection(_name: string) {
      const q: any = query(null, 1000);
      q.doc = (id: string) => ({
        async get() {
          const d = docs.find((x) => x.id === id);
          return d ? snapOf(d) : { id, exists: false, data: () => undefined };
        },
      });
      return q;
    },
    doc(path: string) {
      return {
        async get() {
          const v = store[path];
          return { exists: v !== undefined, data: () => v };
        },
        async set(v: any) { store[path] = JSON.parse(JSON.stringify(v)); },
      };
    },
    __store: store,
  };
}

void (async () => {

console.log("Names are derived from the range, never from the clock");
eq("segment", segmentName(41, 90), "anchor/tool_witness/00000041-00000090.jsonl");
eq("checkpoint", checkpointName(90), "anchor/tool_witness/checkpoint-00000090.json");
ok("fixed width, so lexical order is numeric order",
   segmentName(9, 9) < segmentName(10, 10));

console.log("A first run");
{
  const w = world([row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z"), row("c", "2026-01-01T00:00:03Z")]);
  const r = await anchorRun(w.deps);
  eq("anchored three", r.anchored, 3);
  eq("tree_size", r.tree_size, 3);
  eq("segment name", r.segment, "anchor/tool_witness/00000001-00000003.jsonl");
  ok("segment written", typeof w.objects[r.segment!] === "string");
  ok("checkpoint written", typeof w.objects["anchor/tool_witness/checkpoint-00000003.json"] === "string");
  ok("watermark advanced", w.wm !== null && w.wm.count === 3);
  eq("it does not claim to be signed", r.signed, false);
  const lines = w.objects[r.segment!].trim().split("\n");
  eq("one line per entry", lines.length, 3);
  ok("and what was written verifies",
     chainIsIntact(verifyChain(lines, JSON.parse(w.objects["anchor/tool_witness/checkpoint-00000003.json"]))));
}

console.log("Resume -- the second run continues the SAME chain");
{
  const rows = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z")];
  const w = world(rows);
  const r1 = await anchorRun(w.deps);
  eq("first run anchored two", r1.anchored, 2);

  w.add(row("c", "2026-01-01T00:00:03Z"));
  const r2 = await anchorRun(w.deps);
  eq("second run anchored only the new one", r2.anchored, 1);
  eq("sequence continued", r2.tree_size, 3);
  eq("second segment starts where the first ended", r2.segment, "anchor/tool_witness/00000003-00000003.jsonl");
  // The head of run 1 must be the prev_hash of run 2's first entry, or the chain is two chains.
  const e3 = JSON.parse(w.objects[r2.segment!].trim());
  eq("run 2 links to run 1's head", e3.prev_hash, r1.head_hash);
}

console.log("Running again with nothing new is a no-op that still reports the head");
{
  const w = world([row("a", "2026-01-01T00:00:01Z")]);
  const r1 = await anchorRun(w.deps);
  const before = Object.keys(w.objects).length;
  const r2 = await anchorRun(w.deps);
  eq("anchored nothing", r2.anchored, 0);
  eq("wrote nothing", Object.keys(w.objects).length, before);
  eq("but still reports the head", r2.head_hash, r1.head_hash);
  eq("and the tree size", r2.tree_size, 1);
}

console.log("A bounded run, and falling behind is handled by running again");
{
  const rows = [];
  for (let i = 1; i <= 7; i++) rows.push(row("r" + i, "2026-01-01T00:00:0" + i + "Z"));
  const w = world(rows);
  const r1 = await anchorRun(w.deps, 3);
  eq("limit respected", r1.anchored, 3);
  const r2 = await anchorRun(w.deps, 3);
  eq("next batch", r2.anchored, 3);
  eq("and it continues the count", r2.tree_size, 6);
  const r3 = await anchorRun(w.deps, 3);
  eq("the remainder", r3.anchored, 1);
  eq("seven in total", r3.tree_size, 7);
  // Reassemble every segment in name order and verify the whole chain end to end.
  const names = Object.keys(w.objects).filter((n) => n.endsWith(".jsonl")).sort();
  const all: string[] = [];
  for (const n of names) for (const l of w.objects[n].trim().split("\n")) all.push(l);
  eq("three segments", names.length, 3);
  eq("seven lines", all.length, 7);
  const cp = JSON.parse(w.objects[checkpointName(7)]);
  ok("the reassembled chain verifies against the final checkpoint",
     chainIsIntact(verifyChain(all, cp)));
}

console.log("THE CRASH THAT MATTERS -- segment written, watermark save fails");
{
  const w = world([row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z")]);
  w.failSaveOnce();
  let threw = false;
  try { await anchorRun(w.deps); } catch (e) { threw = true; };
  ok("the run failed loudly rather than silently", threw);
  ok("the watermark did NOT advance", w.wm === null);
  // The records are therefore still pending. The next run re-anchors them, writes the SAME bytes to
  // the SAME name, and recovers. This is the whole reason the segment is written first.
  const r = await anchorRun(w.deps);
  eq("the next run recovers them", r.anchored, 2);
  eq("to the same object name", r.segment, "anchor/tool_witness/00000001-00000002.jsonl");
  eq("with no duplicate segment", Object.keys(w.objects).filter((n) => n.endsWith(".jsonl")).length, 1);
  ok("and the watermark is now correct", w.wm !== null && w.wm!.count === 2);
}

console.log("The other crash -- the segment write itself fails");
{
  const w = world([row("a", "2026-01-01T00:00:01Z")]);
  w.failPutOnce();
  let threw = false;
  try { await anchorRun(w.deps); } catch (e) { threw = true; }
  ok("it failed loudly", threw);
  ok("nothing was written", Object.keys(w.objects).length === 0);
  ok("and the watermark did not move", w.wm === null);
  const r = await anchorRun(w.deps);
  eq("the retry anchors the row", r.anchored, 1);
}

console.log("An empty collection");
{
  const w = world([]);
  const r = await anchorRun(w.deps);
  eq("anchored nothing", r.anchored, 0);
  eq("head is genesis", r.head_hash, EMPTY_WATERMARK.head);
  eq("no segment", r.segment, null);
  ok("and nothing was written", Object.keys(w.objects).length === 0);
}

console.log("THE ADAPTER -- sub-millisecond timestamps");
{
  // Firestore server timestamps carry MICROSECONDS. Two witness records inside the same millisecond
  // are ordinary under any concurrency at all, and the anchor orders rows by comparing `ts` AS A
  // STRING. So if the reader truncates `ts` to milliseconds, the anchor's order and Firestore's
  // order DISAGREE -- and a row that Firestore correctly returns after the cursor is then thrown
  // away by afterWatermark for sorting before it. Silently, permanently, in the one component whose
  // entire job is not losing evidence.
  //
  //   y  ts = 10.000700s  id "a"   <- Firestore: AFTER x. Truncated: same ms, id "a" < "x" = BEFORE.
  //   x  ts = 10.000500s  id "x"   <- the cursor after page 1
  const docs: FakeDoc[] = [
    { id: "m", ts: new FakeTs(10, 100000000) },
    { id: "x", ts: new FakeTs(10, 500000) },
    { id: "a", ts: new FakeTs(10, 700000) },
  ];
  const db = fakeDb(docs);
  const read = firestoreReader(db);

  const page1 = await read(EMPTY_WATERMARK, 2);
  eq("page 1 is in Firestore order", page1.map((r) => r.id).join(","), "x,a");
  ok("ts keeps sub-millisecond precision", page1[0].ts !== page1[1].ts,
     "both rows came back as " + page1[0].ts);
  ok("and the anchor's string order matches Firestore's", page1[0].ts < page1[1].ts,
     page1[0].ts + " should sort before " + page1[1].ts);
  eq("fixed width, so lexical order is chronological", page1[0].ts.length, "2026-01-01T00:00:00.000000000Z".length);

  // Drive the real run end to end: every row must be anchored EXACTLY ONCE across the two pages.
  const wmStore = firestoreWatermark(db);
  const deps: RunDeps = {
    readRows: read, putObject: async (n, b) => { objects[n] = b; },
    loadWatermark: wmStore.load, saveWatermark: wmStore.save, now: () => NOW,
  };
  const objects: { [k: string]: string } = {};
  const r1 = await anchorRun(deps, 2);
  const r2 = await anchorRun(deps, 2);
  eq("page 1 anchored two", r1.anchored, 2);
  eq("page 2 anchored the third -- none was dropped", r2.anchored, 1);
  const all: string[] = [];
  for (const n of Object.keys(objects).filter((k) => k.endsWith(".jsonl")).sort())
    for (const l of objects[n].trim().split("\n")) all.push(l);
  eq("three entries in the chain", all.length, 3);
  const ids = all.map((l) => JSON.parse(l).source_id).sort().join(",");
  eq("and they are the three documents, each once", ids, "a,m,x");
  ok("the reassembled chain verifies",
     chainIsIntact(verifyChain(all, JSON.parse(objects[checkpointName(3)]))));
}

console.log("THE ADAPTER -- a row it cannot order is never stepped over");
{
  // Firestore sorts null before every timestamp, so a row with an unusable `timestamp` lands at the
  // HEAD of the unanchored queue. Skipping it would advance the cursor past it and past nothing
  // else -- but read a page after it and every row in that page is lost with it.
  const head: FakeDoc[] = [
    { id: "a", ts: new FakeTs(10, 0) },
    { id: "b", ts: null },
    { id: "c", ts: new FakeTs(12, 0) },
  ];
  let threw = "";
  try { await firestoreReader(fakeDb(head))(EMPTY_WATERMARK, 10); }
  catch (e: any) { threw = String(e.message || e); }
  ok("at the head of the queue it is an error, not a short page", threw.indexOf("/b:") >= 0, threw);
  ok("and the error says the chain cannot advance until it is fixed",
     threw.indexOf("cannot advance") >= 0, threw);

  // And it can never be quietly dealt with later: because null sorts FIRST, such a row is either at
  // the head of the queue -- where the run above refuses -- or already behind the cursor, where the
  // query will never return it again. There is no position from which skipping it is recoverable,
  // which is the whole reason the reader treats it as a stop rather than a short page.
  const past: FakeDoc[] = [{ id: "a", ts: new FakeTs(10, 0) }, { id: "b", ts: new FakeTs(11, 0) }];
  const db2 = fakeDb(past);
  const read2 = firestoreReader(db2);
  const seen = await read2(EMPTY_WATERMARK, 10);
  past.push({ id: "z", ts: null });
  const wm2: Watermark = { head: "x", count: 2, last_ts: seen[1].ts, last_id: seen[1].id, fringe: ["x"] };
  const after = await read2(wm2, 10);
  eq("behind the cursor it is simply unreachable", after.length, 0);
}

console.log("THE ADAPTER -- the cursor is the document, not a rounded clock reading");
{
  const docs: FakeDoc[] = [{ id: "a", ts: new FakeTs(10, 1) }, { id: "b", ts: new FakeTs(10, 2) }];
  const db = fakeDb(docs);
  const read = firestoreReader(db);
  const p1 = await read(EMPTY_WATERMARK, 1);
  const wm: Watermark = { head: "x", count: 1, last_ts: p1[0].ts, last_id: p1[0].id, fringe: ["x"] };
  const p2 = await read(wm, 10);
  eq("resumes exactly after it", p2.map((r) => r.id).join(","), "b");

  // And if the cursor document is gone, it must STOP rather than guess a position.
  const gone: Watermark = { head: "x", count: 1, last_ts: p1[0].ts, last_id: "vanished", fringe: ["x"] };
  let threw = "";
  try { await read(gone, 10); } catch (e: any) { threw = String(e.message || e); }
  ok("a missing cursor document is refused loudly", threw.indexOf("vanished") >= 0, threw);
}

console.log("THE ADAPTER -- the watermark document");
{
  const db = fakeDb([]);
  const wmStore = firestoreWatermark(db);
  eq("absent is null, not an empty tree", await wmStore.load(), null);
  const wm: Watermark = { head: "sha256:aa", count: 4, last_ts: "t", last_id: "i", fringe: ["sha256:bb"] };
  await wmStore.save(wm);
  const back = await wmStore.load();
  eq("round trips", JSON.stringify(back), JSON.stringify(wm));

  // A watermark written before the fringe existed must surface as fringe-less so anchorRun refuses.
  const legacy = fakeDb([{ id: "a", ts: new FakeTs(10, 0) }],
    { "anchor_state/tool_witness": { head: "sha256:aa", count: 4, last_ts: null, last_id: null } });
  const legacyStore = firestoreWatermark(legacy);
  const l = await legacyStore.load();
  ok("legacy watermark has no fringe", l !== null && l.fringe.length === 0);
  const r = await anchorRun({
    readRows: firestoreReader(legacy), putObject: async () => { throw new Error("must not write"); },
    loadWatermark: legacyStore.load, saveWatermark: legacyStore.save, now: () => NOW,
  });
  ok("and the run refuses rather than starting a second tree", typeof r.refused === "string");
  eq("having written nothing", r.anchored, 0);
}

console.log("THE ADAPTER -- the gcs watermark object");
{
  const store: { [k: string]: Buffer } = {};
  const bucket = {
    file(name: string) {
      return {
        async exists() { return [name in store]; },
        async download() { return [store[name]]; },
        async save(buf: Buffer) { store[name] = buf; },
      };
    },
  };
  const gcs = gcsWatermark(bucket);

  // 1. load-when-missing
  eq("gcs absent is null", await gcs.load(), null);

  // 2. save-then-load round trip
  const wm: Watermark = { head: "sha256:aa", count: 4, last_ts: "t", last_id: "i", fringe: ["sha256:bb"] };
  await gcs.save(wm);
  const back = await gcs.load();
  eq("gcs round trips", JSON.stringify(back), JSON.stringify(wm));
  ok("stored at expected default path in bucket", "anchor/tool_witness/watermark.json" in store);

  // 3. fringe default
  store["anchor/tool_witness/watermark.json"] = Buffer.from(
    JSON.stringify({ head: "sha256:legacy", count: 2, last_ts: null, last_id: null }),
    "utf8"
  );
  const legacy = await gcs.load();
  ok("legacy watermark without fringe defaults to empty array", legacy !== null && Array.isArray(legacy.fringe) && legacy.fringe.length === 0);
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
