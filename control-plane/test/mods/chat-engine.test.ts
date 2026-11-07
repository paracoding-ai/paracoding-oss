// SPDX-License-Identifier: Apache-2.0
// [CHAT-ENGINE-MOD-V1] Unit tests for the pure branches of the chat-engine helpers
// (src/mods/chat-engine.ts). harUsageOk is a pure predicate over a provider usage object; it is
// exercised exhaustively here. harTurnCheckpoint's no-op guard (a meta with no id) returns before
// it touches any collection, so that branch is pure too. No cloud, no network, no DB rows written.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { harUsageOk, harTurnCheckpoint } from "../../src/mods/chat-engine.js";

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
  console.log("harUsageOk -- a usage object is real iff >=1 present field and every present field is a finite number >= 0");
  {
    // not an object -> false
    eq("null -> false", harUsageOk(null), false);
    eq("undefined -> false", harUsageOk(undefined), false);
    eq("array -> false", harUsageOk([]), false);
    eq("populated array -> false", harUsageOk([1, 2, 3] as any), false);
    eq("string -> false", harUsageOk("5" as any), false);
    eq("number -> false", harUsageOk(42 as any), false);

    // empty / all-absent object -> false (seen === 0)
    eq("{} -> false", harUsageOk({}), false);
    eq("all fields undefined -> false", harUsageOk({ input_tokens: undefined, output_tokens: undefined }), false);
    eq("all fields null -> false", harUsageOk({ input_tokens: null, cache_read_input_tokens: null }), false);
    eq("unrelated keys only -> false", harUsageOk({ foo: 1, bar: 2 }), false);

    // present but unusable -> whole object false
    eq("negative input_tokens -> false", harUsageOk({ input_tokens: -1 }), false);
    eq("NaN -> false", harUsageOk({ input_tokens: NaN }), false);
    eq("Infinity -> false", harUsageOk({ output_tokens: Infinity }), false);
    eq("string field -> false", harUsageOk({ input_tokens: "5" }), false);
    eq("one good + one bad field -> false", harUsageOk({ input_tokens: 10, output_tokens: -3 }), false);

    // present and usable -> true
    eq("one positive field -> true", harUsageOk({ input_tokens: 100 }), true);
    eq("measured zero is real -> true", harUsageOk({ input_tokens: 0 }), true);
    eq("good field + absent fields -> true", harUsageOk({ input_tokens: 5, output_tokens: undefined }), true);
    eq("cache_read alone -> true", harUsageOk({ cache_read_input_tokens: 3 }), true);
    eq("all four present and valid -> true", harUsageOk({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 }), true);
  }

  console.log("harTurnCheckpoint -- the no-id guard returns before any collection write (pure branch)");
  {
    eq("no meta -> undefined, no throw", harTurnCheckpoint(null as any, { status: "running" }, null), undefined);
    eq("meta without id -> undefined, no throw", harTurnCheckpoint({ agent: "x" } as any, { status: "running" }, null), undefined);
    eq("empty meta -> undefined, no throw", harTurnCheckpoint({} as any, {}, null), undefined);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
