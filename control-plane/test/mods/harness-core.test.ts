// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free harness-core helpers (src/mods/harness-core.ts). No cloud, no
// network, no secrets: every function touches only its arguments (harGeminiPrice also reads
// process.env / Date), so the tests are pure in/out.
process.env.PC_NO_LISTEN = "1";
import { harModelLabel, harGeminiPrice, harGeminiCostUsd, harToolDefs, harRedact } from "../../src/mods/harness-core.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function eqJson(label: string, got: any, want: any) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

(async () => {
  console.log("harModelLabel -- strips provider prefix, date/preview suffix, title-cases words");
  {
    eq("claude-opus-5 -> Opus 5", harModelLabel("claude-opus-5"), "Opus 5");
    eq("gemini-4-argon -> 4 Argon", harModelLabel("gemini-4-argon"), "4 Argon");
    eq("models/ prefix stripped then provider", harModelLabel("models/gemini-3.1-pro-preview"), "3.1 Pro");
    eq("8-digit date suffix stripped", harModelLabel("claude-3-5-sonnet-20240620"), "3 5 Sonnet");
    eq("-latest suffix stripped", harModelLabel("claude-sonnet-latest"), "Sonnet");
    eq("empty string stays empty", harModelLabel(""), "");
    eq("null coerces to empty", harModelLabel(null as any), "");
    eq("digit-leading word is not capitalized", harModelLabel("gemini-4o"), "4o");
  }

  console.log("harGeminiPrice -- [input, output, cached] USD per 1M, by model family");
  {
    eqJson("flash family -> [0.5, 3, 0.05]", harGeminiPrice("gemini-3.8-flash"), [0.5, 3, 0.05]);
    eqJson("unknown/pro default -> [2, 12, 0.20]", harGeminiPrice("gemini-3.1-pro-preview"), [2, 12, 0.20]);
    eqJson("empty -> default", harGeminiPrice(""), [2, 12, 0.20]);
    const argon = harGeminiPrice("gemini-4-argon");
    ok("argon has 3 price points", argon.length === 3);
    ok("argon is the intro ([2,10,0.10]) or post-promo ([4,20,0.20]) table, by date",
      JSON.stringify(argon) === JSON.stringify([2, 10, 0.10]) || JSON.stringify(argon) === JSON.stringify([4, 20, 0.20]),
      JSON.stringify(argon));
    // env override: "in,out,cached", all finite and >= 0
    const saved = process.env.CHAT_GEMINI_PRICE;
    try {
      process.env.CHAT_GEMINI_PRICE = "1,2,3";
      eqJson("CHAT_GEMINI_PRICE override wins for every model", harGeminiPrice("gemini-4-argon"), [1, 2, 3]);
      process.env.CHAT_GEMINI_PRICE = "1,2";               // wrong arity -> ignored
      eqJson("two-field override is ignored (falls back)", harGeminiPrice("gemini-3.8-flash"), [0.5, 3, 0.05]);
      process.env.CHAT_GEMINI_PRICE = "1,-2,3";            // negative -> ignored
      eqJson("negative override is ignored (falls back)", harGeminiPrice("gemini-3.8-flash"), [0.5, 3, 0.05]);
    } finally {
      if (saved === undefined) delete process.env.CHAT_GEMINI_PRICE; else process.env.CHAT_GEMINI_PRICE = saved;
    }
  }

  console.log("harGeminiCostUsd -- usage metadata * price / 1e6");
  {
    eq("no usage metadata -> 0", harGeminiCostUsd("gemini-3.8-flash", null), 0);
    eq("undefined usage -> 0", harGeminiCostUsd("gemini-3.8-flash", undefined), 0);
    // flash price [0.5, 3, 0.05]; 1M uncached in + 1M out = 0.5 + 3 = 3.5
    eq("1M in + 1M out at flash price = $3.50",
      harGeminiCostUsd("gemini-3.8-flash", { promptTokenCount: 1000000, candidatesTokenCount: 1000000 }), 3.5);
    // cached tokens bill at the cheaper cached rate
    eq("fully-cached 1M input at flash cached rate = $0.05",
      harGeminiCostUsd("gemini-3.8-flash", { promptTokenCount: 1000000, cachedContentTokenCount: 1000000 }), 0.05);
    // thinking + tool-use tokens are counted (output + input respectively)
    eq("thoughts count as output, toolUse prompt counts as input",
      harGeminiCostUsd("gemini-3.8-flash", { promptTokenCount: 500000, toolUsePromptTokenCount: 500000, thoughtsTokenCount: 1000000 }),
      (1000000 * 0.5 + 1000000 * 3) / 1e6);
    ok("cached is capped at input (no negative cost)",
      harGeminiCostUsd("gemini-3.8-flash", { promptTokenCount: 10, cachedContentTokenCount: 1000000 }) >= 0);
  }

  console.log("harToolDefs -- static per-strain tool catalog (prompt shaping)");
  {
    const boss = harToolDefs("fleet-advisor");
    const strain = harToolDefs("bughunters");
    eq("same number of tools regardless of strain", boss.length, strain.length);
    ok("exactly nine tools", boss.length === 9, "len=" + boss.length);
    eq("first tool is status_digest", boss[0].name, "status_digest");
    const names = boss.map((t: any) => t.name);
    for (const n of ["status_digest", "check", "read_journal", "read_lake", "list_work_items",
      "cancel_work_item", "complete_work_item", "read_job_log", "cowork_prompt"]) {
      ok("tool present: " + n, names.indexOf(n) >= 0);
    }
    ok("every tool carries an input_schema object", boss.every((t: any) => t.input_schema && t.input_schema.type === "object"));
    const bossRj = boss.find((t: any) => t.name === "read_journal").description;
    const strainRj = strain.find((t: any) => t.name === "read_journal").description;
    ok("boss read_journal description differs from a strain's", bossRj !== strainRj);
    const strainLake = strain.find((t: any) => t.name === "read_lake").description;
    ok("strain read_lake description names the agent id", strainLake.indexOf("bughunters") >= 0);
  }

  console.log("harRedact -- strips keys, bearer tokens, sk-/ya29. secrets");
  {
    eq("?key=... is redacted, rest of the query kept", harRedact("https://x/y?key=SECRET123&a=1"), "https://x/y?key=REDACTED&a=1");
    eq("&key=... is redacted too", harRedact("u?a=1&key=abcDEF_-99"), "u?a=1&key=REDACTED");
    eq("Bearer token redacted", harRedact("Authorization: Bearer abc.def-123XYZ"), "Authorization: Bearer REDACTED");
    eq("sk- key redacted", harRedact("key is sk-abcDEF123456 done"), "key is REDACTED done");
    eq("ya29. access token redacted", harRedact("tok ya29.AbCdEf_12-345 end"), "tok REDACTED end");
    eq("nothing to redact is unchanged", harRedact("plain text, no secrets here"), "plain text, no secrets here");
    eq("null coerces to empty string", harRedact(null as any), "");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
