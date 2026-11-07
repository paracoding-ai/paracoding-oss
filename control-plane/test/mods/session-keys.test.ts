// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE surface of src/mods/session-keys.ts (keyword -> role helpers
// extracted from index.ts). These take no cloud, no network and no secrets. slNormRole is
// a total pure function; slResolveRole's empty-keyword guard returns BEFORE it ever reaches
// strainList (the only IO), so that branch is reachable here too. The registry-matching and
// ambiguity branches of slResolveRole need strainList and are covered by the integration
// suite, not here. Importing the module runs shared.js at load, which PC_NO_LISTEN keeps inert.
process.env.PC_NO_LISTEN = "1";
import { slNormRole, slResolveRole } from "../../src/mods/session-keys.js";

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
  console.log("slNormRole -- lowercase, strip spaces/dashes/underscores, drop ONE leading 'fleet'");
  {
    eq("plain token is unchanged", slNormRole("advisor"), "advisor");
    eq("backend doc id collapses to the human name", slNormRole("fleet-advisor"), "advisor");
    eq("mixed case + space + leading fleet", slNormRole("Fleet Advisor"), "advisor");
    eq("underscores are separators too", slNormRole("bug_hunter"), "bughunter");
    eq("uppercase with a space", slNormRole("BUG HUNTER"), "bughunter");
    eq("surrounding whitespace is dropped", slNormRole("  spaced  "), "spaced");
    eq("'fleet' alone normalises to empty (the leading-strip eats it)", slNormRole("fleet"), "");
    eq("only the LEADING 'fleet' is stripped, once", slNormRole("fleetfleet"), "fleet");
    eq("'fleet' in the middle is NOT stripped", slNormRole("superfleet"), "superfleet");
    eq("dashes between repeats: separators go first, then one leading fleet", slNormRole("fleet-fleet-advisor"), "fleetadvisor");
    eq("empty string stays empty", slNormRole(""), "");
    eq("null coerces to empty (String(x||''))", slNormRole(null as any), "");
    eq("undefined coerces to empty", slNormRole(undefined as any), "");
    // the two case-insensitive spellings the operator actually types must agree
    eq("human name and backend id resolve to the SAME token",
       slNormRole("Advisor"), slNormRole("fleet-advisor"));
    // idempotent: normalising a normalised value is a fixed point
    eq("idempotent on an already-normalised value", slNormRole(slNormRole("Fleet-Advisor")), slNormRole("Fleet-Advisor"));
  }

  console.log("slResolveRole -- empty-keyword guard returns before any registry read");
  {
    const a = await slResolveRole("");
    eq("empty string -> empty-keyword error", a.error, "empty role keyword");
    eq("empty string -> no role", a.role as any, undefined);
    eq("whitespace-only normalises to empty -> same guard", (await slResolveRole("   ")).error, "empty role keyword");
    eq("separators-only normalises to empty -> same guard", (await slResolveRole("___")).error, "empty role keyword");
    eq("bare 'fleet' normalises to empty -> same guard (never resolves a role)", (await slResolveRole("fleet")).error, "empty role keyword");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
