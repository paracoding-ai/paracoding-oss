// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure, deterministic parts of the executor-bucket ingest
// (src/mods/exec-ingest.ts). pcExecIngestId is a pure function of the object name; pcExecIngestWhen
// is pure for a parseable timestamp (returns a Date) and falls back to a store sentinel otherwise.
// No cloud, no network, no secrets.
process.env.PC_NO_LISTEN = "1";
import * as crypto from "crypto";
import { pcExecIngestId, pcExecIngestWhen } from "../../src/mods/exec-ingest.js";

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
  console.log("pcExecIngestId -- 'gcs-' + first 32 hex of sha256(objectName); a pure fn of the name");
  {
    const name = "results/job-123-abcdef.json";
    const want = "gcs-" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
    eq("matches sha256(name) construction", pcExecIngestId(name), want);
    eq("always prefixed gcs-", pcExecIngestId("x").slice(0, 4), "gcs-");
    eq("32 hex chars after the prefix", pcExecIngestId("x").length, 4 + 32);
    eq("deterministic: same name -> same id", pcExecIngestId(name), pcExecIngestId(name));
    ok("different names -> different ids", pcExecIngestId("a") !== pcExecIngestId("b"));
    // non-string coerces via String(name); empty-ish inputs are stable
    eq("null coerces via String()", pcExecIngestId(null as any), pcExecIngestId("null" as any));
    eq("number coerces via String()", pcExecIngestId(42 as any), pcExecIngestId("42"));
  }

  console.log("pcExecIngestWhen -- parseable RFC3339 -> that exact Date; unparseable -> store sentinel");
  {
    const iso = "2024-01-02T03:04:05.000Z";
    const r: any = pcExecIngestWhen(iso);
    ok("parseable string yields a Date", r instanceof Date);
    eq("the Date carries the parsed epoch ms", (r as Date).getTime(), Date.parse(iso));
    ok("empty string is unparseable -> NOT a Date (serverTimestamp sentinel)", !(pcExecIngestWhen("") instanceof Date));
    ok("garbage is unparseable -> NOT a Date", !(pcExecIngestWhen("not-a-timestamp") instanceof Date));
    ok("null is unparseable -> NOT a Date", !(pcExecIngestWhen(null) instanceof Date));
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
