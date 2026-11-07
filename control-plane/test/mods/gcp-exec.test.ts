// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-GCPEXEC-V1] Unit tests for mods/gcp-exec.ts. harRootWithQuery is pure (no cloud,
// no network) and gets its branches exercised directly. harOpsToken awaits opsGet() on every path
// (the ops-window doc is read before any decision), so it has no store-free pure branch -- it is
// asserted to be an exported async function instead, per the extraction contract.
process.env.PC_NO_LISTEN = "1";
import { harOpsToken, harRootWithQuery } from "../../src/mods/gcp-exec.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

void (async () => {

console.log("harRootWithQuery -- collapse onto root, keep the query");
{
  // no query at all -> bare root
  eq("no query -> '/'", harRootWithQuery({ url: "/harness" }), "/");
  eq("root with no query -> '/'", harRootWithQuery({ url: "/" }), "/");
  // a query is preserved, reattached to '/'
  eq("query preserved", harRootWithQuery({ url: "/harness?a=1&b=2" }), "/?a=1&b=2");
  eq("empty query marker kept", harRootWithQuery({ url: "/x?" }), "/?");
  // originalUrl wins over url (express sets both; the extracted code reads originalUrl first)
  eq("originalUrl takes precedence", harRootWithQuery({ originalUrl: "/a?keep=1", url: "/stripped" }), "/?keep=1");
  // missing / empty request coerces to '/', never throws
  eq("empty object -> '/'", harRootWithQuery({}), "/");
  eq("null req -> '/'", harRootWithQuery(null), "/");
  // only the FIRST '?' splits; later ones ride along in the query
  eq("second '?' stays in query", harRootWithQuery({ url: "/p?x=1?y=2" }), "/?x=1?y=2");
}

console.log("harOpsToken -- extracted, exported, async (store-coupled: no pure branch)");
{
  ok("harOpsToken is exported", typeof harOpsToken !== "undefined");
  ok("harOpsToken is a function", typeof harOpsToken === "function");
  ok("harOpsToken is async (returns a Promise-like / thenable)", harOpsToken.constructor && harOpsToken.constructor.name === "AsyncFunction");
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
