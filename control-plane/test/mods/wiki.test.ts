// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free branches of src/mods/wiki.ts (strangler extraction).
// pcCompletionEvidence has a long pre-store validation funnel that returns BEFORE any Firestore
// read, any getStorage().bucket() probe, and before require('../gittools.js') -- those are the
// branches asserted here. harCompleteItemTool refuses a missing id before it ever calls harOwns
// or pcCompletionEvidence. wikiGitOid is tested for its memoization contract (the resolver is
// resolved once and the same function reference is handed back on every later call). The
// store-backed / gittools-backed happy paths (MEASURED lookups, a real commit resolution, a real
// work-item update) are integration-tested, exactly as the other mod tests leave cloud paths alone.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { wikiGitOid, pcCompletionEvidence, harCompleteItemTool } from "../../src/mods/wiki.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

(async () => {
  console.log("pcCompletionEvidence -- pure validation funnel (returns before any store/gittools call)");
  {
    // (1) a missing evidence_oid refuses up front, naming NOTHING was closed.
    const r1: any = await pcCompletionEvidence("", "whatever", "fleet-x");
    eq("empty oid -> not ok", r1.ok, false);
    ok("empty oid refusal names evidence_oid as required", /evidence_oid is required/.test(r1.refusal));

    // (2) evidence_oid:"none" whose reason does not OPEN with a recognised kind is refused.
    const r2: any = await pcCompletionEvidence("none", "just trust me on this one please", "fleet-x");
    eq("none + un-kinded reason -> not ok", r2.ok, false);
    ok("un-kinded refusal says reason must OPEN with a kind", /must OPEN with one of/.test(r2.refusal));

    // (3) a recognised kind with fewer than 20 chars of body is refused (shared length gate).
    const r3: any = await pcCompletionEvidence("none", "NEGATIVE: too short", "fleet-x");
    eq("NEGATIVE + short body -> not ok", r3.ok, false);
    ok("short-body refusal demands >=20 chars", /needs at least/.test(r3.refusal));

    // (4) a recognised kind with a sufficient body passes WITHOUT touching any store (kind=none).
    const r4: any = await pcCompletionEvidence("none", "NEGATIVE: the cloned repo produced no upload-pack endpoint at main", "fleet-x");
    eq("NEGATIVE + full body -> ok", r4.ok, true);
    eq("evidence kind is none", r4.evidence.kind, "none");
    eq("evidence category is NEGATIVE", r4.evidence.category, "NEGATIVE");
    ok("the journal line is prefixed evidence=none/NEGATIVE", r4.line.indexOf("evidence=none/NEGATIVE:") === 0);

    // (5) DUPLICATE must name a 20-char id; a body without one is refused even though it is long.
    const r5: any = await pcCompletionEvidence("none", "DUPLICATE: see the other one somewhere", "fleet-x");
    eq("DUPLICATE without an id -> not ok", r5.ok, false);
    ok("DUPLICATE refusal demands the duplicated id", /must name the id/.test(r5.refusal));

    // (6) DUPLICATE WITH a 20-char id passes purely.
    const r6: any = await pcCompletionEvidence("none", "DUPLICATE: abcdefghij1234567890", "fleet-x");
    eq("DUPLICATE with a 20-char id -> ok", r6.ok, true);
    eq("evidence category is DUPLICATE", r6.evidence.category, "DUPLICATE");

    // (7) a non-"none" evidence_oid that is not 40-hex refuses before gittools is ever required.
    const r7: any = await pcCompletionEvidence("deadbeef", null, "fleet-x");
    eq("short/garbage oid -> not ok", r7.ok, false);
    ok("bad-oid refusal demands a 40-char hex oid", /must be a 40-character lowercase hex/.test(r7.refusal));
  }

  console.log("harCompleteItemTool -- refuses a missing id before harOwns / pcCompletionEvidence / any store write");
  {
    // id is String(input?.id||'').trim(); a falsy/blank id returns the fixed refusal string
    // BEFORE the ownership check and before pcCompletionEvidence / wiCol().doc().update().
    eq("no input -> id required", await harCompleteItemTool(undefined, "fleet-x"), "complete: id required.");
    eq("empty object -> id required", await harCompleteItemTool({}, "fleet-x"), "complete: id required.");
    eq("empty-string id -> id required", await harCompleteItemTool({ id: "" }, "fleet-x"), "complete: id required.");
    eq("whitespace-only id is trimmed -> id required", await harCompleteItemTool({ id: "   " }, "fleet-x"), "complete: id required.");
  }

  console.log("wikiGitOid -- resolves the git oid resolver once and memoizes the reference");
  {
    const f1 = wikiGitOid();
    ok("wikiGitOid hands back a function", typeof f1 === "function");
    const f2 = wikiGitOid();
    ok("the second call returns the SAME reference (memoized, not re-required)", f1 === f2);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
