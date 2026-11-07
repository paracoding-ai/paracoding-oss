// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free branches of work-tools (src/mods/work-tools.ts) -- the
// validate/short-circuit paths that return BEFORE any Firestore/pg read. harOwns answers the
// fleet-advisor ownership question purely (advisor owns every lane, no store lookup), and
// harCancelItemTool refuses a missing id before it ever calls harOwns or touches the store.
// The DB-backed happy paths (list/check/status/cancel-of-a-real-item, ops session) are NOT
// unit-tested here, exactly as the other mod tests leave their cloud paths alone.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { harOwns, harCancelItemTool } from "../../src/mods/work-tools.js";

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
  console.log("harOwns -- the fleet-advisor short-circuit is pure (owns every lane, no store read)");
  {
    // agentId === 'fleet-advisor' returns true as the very first statement, before any
    // wiCol() lookup, so it resolves true for ANY id including a blank/garbage one.
    eq("advisor owns a normal id", await harOwns("someWorkItem", "fleet-advisor"), true);
    eq("advisor owns an empty id too (branch is before the store read)", await harOwns("", "fleet-advisor"), true);
    eq("advisor owns a junk id too", await harOwns("\u0000!!", "fleet-advisor"), true);
  }

  console.log("harCancelItemTool -- refuses a missing id before harOwns / any store write");
  {
    // id is String(input?.id||'').trim(); a falsy/blank id returns the fixed refusal string
    // BEFORE the ownership check and before wiCol().doc().update(), so no store is touched.
    eq("no input -> id required", await harCancelItemTool(undefined, "fleet-x"), "cancel: id required.");
    eq("empty object -> id required", await harCancelItemTool({}, "fleet-x"), "cancel: id required.");
    eq("empty-string id -> id required", await harCancelItemTool({ id: "" }, "fleet-x"), "cancel: id required.");
    eq("whitespace-only id is trimmed -> id required", await harCancelItemTool({ id: "   " }, "fleet-x"), "cancel: id required.");
    eq("non-string id that stringifies blank -> id required", await harCancelItemTool({ id: null }, "fleet-x"), "cancel: id required.");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
