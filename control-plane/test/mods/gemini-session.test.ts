// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure helpers of the Gemini session/meter module (src/mods/gemini-session.ts):
// geMeterPct (percentage with a zero-denominator guard), geMeterLine (the seat-usage line, built
// from GE_QUERIES_PER_SEAT / GE_SEATS and geMeterPct) and geMeterKey (agent-id sanitizer). No
// cloud, no network, no secrets. GE_QUERIES_PER_SEAT / GE_SEATS are imported from shared so the
// expectations track whatever the environment configures.
process.env.PC_NO_LISTEN = "1";
import { geMeterPct, geMeterLine, geMeterKey } from "../../src/mods/gemini-session.js";
import { GE_QUERIES_PER_SEAT, GE_SEATS } from "../../src/shared.js";

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
  console.log("geMeterPct -- round(a/b*100), 0 when the denominator is not positive");
  {
    eq("1/2 -> 50", geMeterPct(1, 2), 50);
    eq("3/3 -> 100", geMeterPct(3, 3), 100);
    eq("1/3 rounds down to 33", geMeterPct(1, 3), 33);
    eq("2/3 rounds up to 67", geMeterPct(2, 3), 67);
    eq("0/0 guarded -> 0", geMeterPct(0, 0), 0);
    eq("1/0 guarded -> 0", geMeterPct(1, 0), 0);
    eq("negative denominator guarded -> 0", geMeterPct(1, -5), 0);
    eq("0 of positive -> 0", geMeterPct(0, 200), 0);
  }

  console.log("geMeterLine -- 'seat queries <day> Pacific ...' from GE_QUERIES_PER_SEAT / GE_SEATS");
  {
    const day = "2026-10-20";
    const pool = GE_QUERIES_PER_SEAT * GE_SEATS;
    const mineUsed = 5, poolUsed = 9;
    const want = 'seat queries ' + day + ' Pacific -- you ' + mineUsed + '/' + GE_QUERIES_PER_SEAT
      + ' (' + geMeterPct(mineUsed, GE_QUERIES_PER_SEAT) + '%), pool ' + poolUsed + '/' + pool
      + ' (' + geMeterPct(poolUsed, pool) + '%) across ' + GE_SEATS + ' seat'
      + (GE_SEATS === 1 ? '' : 's');
    eq("matches the documented construction", geMeterLine(day, poolUsed, mineUsed), want);
    ok("starts with 'seat queries '", geMeterLine(day, 0, 0).startsWith("seat queries " + day));
    ok("names the pool ceiling (per-seat * seats)", geMeterLine(day, 0, 0).indexOf("/" + (GE_QUERIES_PER_SEAT * GE_SEATS)) >= 0);
  }

  console.log("geMeterKey -- sanitize agent id to [A-Za-z0-9_-], defaulting to 'anon'");
  {
    eq("clean id passes through", geMeterKey("fleet-advisor"), "fleet-advisor");
    eq("spaces and slashes become underscores", geMeterKey("a b/c"), "a_b_c");
    eq("empty -> anon", geMeterKey(""), "anon");
    eq("null -> anon", geMeterKey(null as any), "anon");
    eq("undefined -> anon", geMeterKey(undefined as any), "anon");
    eq("all-illegal becomes underscores (still truthy, not anon)", geMeterKey("@@@"), "___");
    eq("mixed keeps legal chars", geMeterKey("Bug.Hunters#1"), "Bug_Hunters_1");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
