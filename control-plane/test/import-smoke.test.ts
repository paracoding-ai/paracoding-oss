// SPDX-License-Identifier: Apache-2.0
// [TEST-IMPORTABLE-V1] The control plane must stay importable by tests WITHOUT booting the server
// or needing GCP creds -- that is what lets every module test load it. If this fails, someone
// re-introduced a module-scope side effect (a listen, an unguarded fetch, a blocking interval).
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
(async () => {
  const t0 = Date.now();
  const m: any = await import("../src/index.js");
  const ms = Date.now() - t0;
  let fail = 0;
  const names = Object.keys(m);
  if (names.length < 100) { console.error("  FAIL: expected 100+ exports, got " + names.length); fail++; }
  if (typeof m.smCpuBuckets !== "function") { console.error("  FAIL: smCpuBuckets not exported"); fail++; }
  if (ms > 20000) { console.error("  FAIL: import took " + ms + "ms (>20s)"); fail++; }
  console.log(fail === 0 ? "import-smoke OK (" + names.length + " exports, " + ms + "ms)" : fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
