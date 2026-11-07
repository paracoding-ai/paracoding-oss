// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free part of the findings gate (src/mods/findings.ts).
// harFindingTable is pure: it only inspects its string argument (strips backticks, trims, and
// matches the vrp.findings table name case-insensitively). No cloud, no network, no secrets.
process.env.PC_NO_LISTEN = "1";
import { harFindingTable } from "../../src/mods/findings.js";

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
  console.log("harFindingTable -- true only for the vrp.findings table (any dataset/project qualifier)");
  {
    eq("bare vrp.findings", harFindingTable("vrp.findings"), true);
    eq("dataset-qualified ...vrp.findings", harFindingTable("myproj.vrp.findings"), true);
    eq("backtick-wrapped is stripped then matched", harFindingTable("`vrp.findings`"), true);
    eq("surrounding whitespace is trimmed", harFindingTable("  vrp.findings  "), true);
    eq("case-insensitive", harFindingTable("VRP.Findings"), true);
    eq("project.dataset.table form", harFindingTable("p.vrp.findings"), true);

    eq("a different table in vrp is not the gate", harFindingTable("vrp.leads"), false);
    eq("findings in a different dataset is not matched", harFindingTable("other.findings"), false);
    eq("a longer suffix is not matched (anchored at end)", harFindingTable("vrp.findings_archive"), false);
    eq("'xvrp.findings' is not matched (boundary is '.' or start)", harFindingTable("xvrp.findings"), false);
    eq("empty string", harFindingTable(""), false);
    eq("null coerces to empty -> false", harFindingTable(null as any), false);
    eq("undefined coerces to empty -> false", harFindingTable(undefined as any), false);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
