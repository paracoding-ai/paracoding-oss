// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free guard branches of har-read (src/mods/har-read.ts). Both tools
// scope strictly by the RAW agentId and REFUSE a blank identity BEFORE touching Firestore/pg, and
// read_job_log also rejects a missing job_id before any read. Those early returns are pure (no
// cloud, no network, no secrets); the DB-backed happy paths are not unit-tested here.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { harReadJournalTool, harReadJobLogTool } from "../../src/mods/har-read.js";

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
  console.log("harReadJournalTool -- refuses a blank/unresolved identity before any journal read");
  {
    const r1 = await harReadJournalTool({}, "");
    ok("empty agentId -> denied (no fleet-wide default)", r1.startsWith("read_journal denied:"), r1);
    ok("denied message explains it is deliberate", r1.indexOf("deliberate") >= 0, r1);
    const r2 = await harReadJournalTool({ limit: 5 }, "   ");
    ok("whitespace-only agentId is trimmed -> denied", r2.startsWith("read_journal denied:"), r2);
  }

  console.log("harReadJobLogTool -- refuses a blank identity, then requires a job_id, both before any read");
  {
    const j1 = await harReadJobLogTool({ job_id: "abc" }, "");
    ok("empty agentId -> denied (job output is privileged)", j1.startsWith("read_job_log denied:"), j1);
    ok("denied message names privileged data", j1.indexOf("privileged") >= 0, j1);
    const j2 = await harReadJobLogTool({ job_id: "abc" }, "  ");
    ok("whitespace-only agentId is trimmed -> denied", j2.startsWith("read_job_log denied:"), j2);

    // identity resolves but no job_id -> required, still before touching the store
    eq("resolved identity, no job_id -> required", await harReadJobLogTool({}, "some-strain"), "read_job_log: job_id required.");
    eq("resolved identity, blank job_id -> required", await harReadJobLogTool({ job_id: "  " }, "some-strain"), "read_job_log: job_id required.");
    eq("resolved identity, blank id alias -> required", await harReadJobLogTool({ id: "" }, "some-strain"), "read_job_log: job_id required.");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
