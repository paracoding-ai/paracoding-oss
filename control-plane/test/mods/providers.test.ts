// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-PROVIDERS-V1] Unit tests for the NETWORK-FREE surface of src/mods/providers.ts, the
// model-provider HTTP calls extracted verbatim from index.ts. The posters themselves
// (harClaudePost, harGeminiPost, harGeminiGenerate) always reach a socket, so they are only
// asserted exported + callable; the genuinely pure branches ARE driven: harVisionDescribe's
// empty-input guard (returns '' before it ever mints a token or fetches) and the Gemini
// daily-spend counter harGeminiSpendToday() that harGeminiGenerate's cap check depends on --
// default 0, same-UTC-day keep, and the day-rollover reset. Env is pinned before the dynamic
// import; PC_NO_LISTEN keeps shared.js inert at load.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
process.env.CHAT_GEMINI_DAILY_USD_MAX = "100";

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
  const m: any = await import("../../src/mods/providers.js");

  console.log("exports -- the four provider posters are present and callable");
  {
    for (const n of ["harClaudePost", "harGeminiPost", "harGeminiGenerate", "harVisionDescribe", "harGeminiSpendToday"]) {
      eq(n + " is a function", typeof m[n], "function");
    }
    ok("harGeminiSpend is an object", m.harGeminiSpend && typeof m.harGeminiSpend === "object");
    ok("HAR_GEMINI_DAILY_USD_MAX is a positive number",
       typeof m.HAR_GEMINI_DAILY_USD_MAX === "number" && m.HAR_GEMINI_DAILY_USD_MAX > 0,
       String(m.HAR_GEMINI_DAILY_USD_MAX));
  }

  console.log("harVisionDescribe -- empty/invalid input returns '' WITHOUT any token or fetch");
  {
    eq("no images -> ''", await m.harVisionDescribe([]), "");
    eq("non-array -> ''", await m.harVisionDescribe(null as any), "");
    eq("entries without .data -> ''", await m.harVisionDescribe([{ media_type: "image/png" }, {}]), "");
  }

  console.log("harGeminiSpendToday -- the moved daily spend counter (pure, UTC-day rollover)");
  {
    const today = new Date().toISOString().slice(0, 10);
    // First read on a fresh module: day was '' so it rolls to today and reports 0.
    eq("fresh counter reads 0", m.harGeminiSpendToday(), 0);
    eq("roll stamped today's UTC date", m.harGeminiSpend.day, today);
    // Same-day spend is kept, not reset.
    m.harGeminiSpend.usd = 5;
    m.harGeminiSpend.calls = 2;
    eq("same-day read keeps the spend", m.harGeminiSpendToday(), 5);
    eq("same-day read does not zero calls", m.harGeminiSpend.calls, 2);
    // A stale day forces a reset back to 0 on the next read.
    m.harGeminiSpend.day = "2000-01-01";
    eq("stale day rolls over to 0", m.harGeminiSpendToday(), 0);
    eq("rollover zeroes calls too", m.harGeminiSpend.calls, 0);
    eq("rollover restamps today", m.harGeminiSpend.day, today);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
