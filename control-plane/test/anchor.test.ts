// SPDX-License-Identifier: Apache-2.0
// Drives anchor.ts with hand-built rows. No Firestore, no GCS, no KMS.
//
// The load-bearing tests are the ones that break the log on purpose. A verifier that has never
// been shown a broken chain is a verifier nobody has tested -- it is easy to write one that
// returns "fine" unconditionally and passes every happy-path test ever written.
import {
  GENESIS, EMPTY_WATERMARK, merkleRoot, orderRows, afterWatermark, chainRows, verifyChain,
  chainIsVerified, chainIsIntact, fringeAppend, fringeSizes, fringeRoot, leafHash,
  type WitnessRow, type Watermark,
} from "../src/anchor.js";
import { createHash } from "node:crypto";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

const NOW = "2026-09-12T00:00:00.000Z";
function fringeRootHex(f: string[]): string { return "sha256:" + fringeRoot(f).toString("hex"); }
function row(id: string, ts: string, data: any = { tool: "git_read" }): WitnessRow {
  return { id, ts, data };
}

console.log("RFC 6962");
eq("empty tree is SHA256 of nothing",
   merkleRoot([]).toString("hex"), createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
eq("one leaf is SHA256(0x00 || d)",
   merkleRoot([Buffer.from("a")]).toString("hex"),
   createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from("a")])).digest("hex"));
// Non-power-of-two sizes are where a hand-rolled tree goes wrong while passing a suite built on
// 2, 4 and 8. This project has already shipped that bug once.
const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 13, 37];
const roots = new Set(sizes.map((n) =>
  merkleRoot(Array.from({ length: n }, (_, i) => Buffer.from("leaf" + i))).toString("hex")));
eq("distinct roots across awkward sizes", roots.size, sizes.length);

console.log("Total order -- the tiebreak is the point");
{
  // Same timestamp, ids out of order. Two readers that break the tie differently produce two
  // different logs with two different roots, both internally valid.
  const rows = [row("bbb", "2026-01-01T00:00:00Z"), row("aaa", "2026-01-01T00:00:00Z")];
  const ordered = orderRows(rows);
  eq("colliding timestamps break by id", ordered[0].id, "aaa");
  const reversed = orderRows(rows.slice().reverse());
  eq("and the order does not depend on input order", reversed[0].id, "aaa");
  eq("same root either way",
     chainRows(rows, EMPTY_WATERMARK, NOW).checkpoint.merkle_root,
     chainRows(rows.slice().reverse(), EMPTY_WATERMARK, NOW).checkpoint.merkle_root);
}

console.log("Chaining");
{
  const rows = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z"), row("c", "2026-01-01T00:00:03Z")];
  const seg = chainRows(rows, EMPTY_WATERMARK, NOW);
  eq("three entries", seg.entries.length, 3);
  eq("first names genesis", seg.entries[0].prev_hash, GENESIS);
  eq("second names the first", seg.entries[1].prev_hash, seg.entries[0].entry_hash);
  eq("third names the second", seg.entries[2].prev_hash, seg.entries[1].entry_hash);
  eq("seq is 1-based", seg.entries[0].seq, 1);
  eq("tree_size matches", seg.checkpoint.tree_size, 3);
  eq("head is the last hash", seg.checkpoint.head_hash, seg.entries[2].entry_hash);
  ok("the algorithms are named in the record",
     seg.checkpoint.merkle_algorithm === "RFC6962-SHA256"
     && seg.checkpoint.hash_algorithm === "RFC8785-JCS-SHA256");
  ok("the source record is committed to, not copied",
     typeof seg.entries[0].record_digest === "string"
     && seg.entries[0].record_digest.indexOf("sha256:") === 0
     && JSON.stringify(seg.entries[0]).indexOf("git_read") < 0);
  ok("it does NOT claim to be anchored", seg.checkpoint.anchored === false);
  ok("and the signature is null, not absent", seg.checkpoint.signature === null);
}

console.log("Resume -- a worker nobody dares run twice is a worker nobody schedules");
{
  const first = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z")];
  const segA = chainRows(first, EMPTY_WATERMARK, NOW);
  const wm: Watermark = segA.watermark;
  eq("watermark counts what was anchored", wm.count, 2);
  eq("watermark remembers the cursor", wm.last_id, "b");

  // The same rows again, plus one new one. The old two must NOT be anchored twice.
  const second = first.concat([row("c", "2026-01-01T00:00:03Z")]);
  const segB = chainRows(second, wm, NOW);
  eq("only the new row is anchored", segB.entries.length, 1);
  eq("it continues the sequence", segB.entries[0].seq, 3);
  eq("and continues the chain", segB.entries[0].prev_hash, segA.entries[1].entry_hash);
  eq("tree_size is cumulative", segB.checkpoint.tree_size, 3);

  const segC = chainRows(first, wm, NOW);
  eq("re-running with nothing new anchors nothing", segC.entries.length, 0);
  eq("and leaves the head where it was", segC.checkpoint.head_hash, wm.head);
}

console.log("Verification -- the happy path");
{
  const rows = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z"), row("c", "2026-01-01T00:00:03Z")];
  const seg = chainRows(rows, EMPTY_WATERMARK, NOW);
  const f = verifyChain(seg.lines, seg.checkpoint);
  eq("the chain itself is intact", chainIsIntact(f), true);
  // And yet it must NOT report verified, because nothing signs it.
  eq("but it is NOT reported as verified", chainIsVerified(f), false);
  eq("exactly one finding, and it is the honest one", f.length, 1);
  eq("unanchored", f[0].kind, "unanchored");
}

console.log("Verification -- break it on purpose");
{
  const rows = [row("a", "2026-01-01T00:00:01Z"), row("b", "2026-01-01T00:00:02Z"),
                row("c", "2026-01-01T00:00:03Z"), row("d", "2026-01-01T00:00:04Z")];
  const seg = chainRows(rows, EMPTY_WATERMARK, NOW);

  // 1. Edit one entry in place.
  {
    const lines = seg.lines.slice();
    const e = JSON.parse(lines[1]);
    e.source_id = "forged";
    lines[1] = JSON.stringify(e);
    const f = verifyChain(lines, seg.checkpoint);
    ok("an in-place edit is caught", f.some((x) => x.kind === "hash_mismatch" && x.seq === 2));
    ok("and the root disagrees too", f.some((x) => x.kind === "merkle_root_mismatch"));
  }

  // 2. Delete an entry from the middle.
  {
    const lines = seg.lines.slice();
    lines.splice(1, 1);
    const f = verifyChain(lines, seg.checkpoint);
    ok("a deletion breaks the sequence", f.some((x) => x.kind === "sequence_gap"));
    ok("and breaks the link", f.some((x) => x.kind === "broken_link"));
  }

  // 3. Truncate from the end. This leaves a PERFECTLY VALID chain -- every link is correct --
  //    and is caught by nothing except a checkpoint that commits to a length.
  {
    const lines = seg.lines.slice(0, 2);
    const f = verifyChain(lines, seg.checkpoint);
    eq("the chain itself is still internally perfect",
       f.filter((x) => x.kind === "hash_mismatch" || x.kind === "broken_link" || x.kind === "sequence_gap").length, 0);
    ok("and ONLY the checkpoint catches it", f.some((x) => x.kind === "checkpoint_beyond_log"));
  }

  // 4. Rewrite the whole log from genesis. Also internally perfect. Only the root catches it.
  {
    const forged = chainRows([row("z", "2026-01-01T00:00:01Z")], EMPTY_WATERMARK, NOW);
    const f = verifyChain(forged.lines, seg.checkpoint);
    eq("a rewrite leaves no internal inconsistency",
       f.filter((x) => x.kind === "hash_mismatch" || x.kind === "broken_link").length, 0);
    ok("only the root catches it", f.some((x) => x.kind === "merkle_root_mismatch"));
  }

  // 5. Prove the check can fail. A verifier that cannot report a problem is not a verifier.
  {
    const f = verifyChain(seg.lines, seg.checkpoint);
    eq("the untouched log reports no structural finding", chainIsIntact(f), true);
  }
}

console.log("Verification -- no checkpoint at all is still reported");
{
  const seg = chainRows([row("a", "2026-01-01T00:00:01Z")], EMPTY_WATERMARK, NOW);
  const f = verifyChain(seg.lines, null);
  ok("reported as unanchored rather than passed", f.some((x) => x.kind === "unanchored"));
  eq("and never verified", chainIsVerified(f), false);
}

console.log("The incremental fringe must agree with the all-at-once root, at EVERY size");
{
  // This is the assertion the whole segmented design rests on. If these ever disagree, a checkpoint
  // published by the worker commits to a different tree than the one an auditor rebuilds from the
  // segments, and both parties are honest and stuck.
  let worst = 0;
  for (let n = 1; n <= 40; n++) {
    const leaves = Array.from({ length: n }, (_, i) => Buffer.from("line" + i));
    const allAtOnce = merkleRoot(leaves).toString("hex");
    const fr: string[] = [];
    const sz: number[] = [];
    for (const l of leaves) fringeAppend(fr, leafHash(l), sz);
    if (fringeRoot(fr).toString("hex") !== allAtOnce) { worst = n; break; }
  }
  eq("sizes 1..40 agree", worst, 0);
  // And the fringe must be recoverable from the count alone, or a resumed run rebuilds it wrong.
  let badSizes = 0;
  for (let n = 1; n <= 40; n++) {
    const fr: string[] = [];
    const sz: number[] = [];
    for (let i = 0; i < n; i++) fringeAppend(fr, leafHash(Buffer.from("line" + i)), sz);
    if (JSON.stringify(fringeSizes(n)) !== JSON.stringify(sz)) { badSizes = n; break; }
  }
  eq("fringeSizes(n) reconstructs the live sizes", badSizes, 0);
}

console.log("A segmented build gives the same root as one big build");
{
  const rows = Array.from({ length: 9 }, (_, i) =>
    row("r" + i, "2026-01-01T00:00:0" + i + "Z"));
  const oneShot = chainRows(rows, EMPTY_WATERMARK, NOW);
  let wm = EMPTY_WATERMARK;
  let lines: string[] = [];
  for (const batch of [rows.slice(0, 2), rows.slice(2, 7), rows.slice(7)]) {
    const seg = chainRows(batch, wm, NOW);
    wm = seg.watermark;
    for (const l of seg.lines) lines.push(l);
  }
  eq("same tree_size", wm.count, oneShot.checkpoint.tree_size);
  eq("same head", wm.head, oneShot.checkpoint.head_hash);
  eq("SAME ROOT across three segments", fringeRootHex(wm.fringe), oneShot.checkpoint.merkle_root);
  eq("and the reassembled lines are the same lines", lines.join("|"), oneShot.lines.join("|"));
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
