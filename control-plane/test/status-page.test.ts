// SPDX-License-Identifier: Apache-2.0
// [STATUS-PAGE-REGRESSION-V1] Static invariants on the status page + its metrics backend + the
// VM backup script. These exist because real work was lost SILENTLY: the dark theme reverted to
// green, the CPU/network graphs vanished, and the backup once dumped Secret Manager into a plain
// archive. Each of those would pass every runtime test. This asserts the SHAPE of the source so a
// regression fails the pipeline instead of reaching production. Pure text checks -- no cloud, no net.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));          // control-plane/test
const read = (p: string) => readFileSync(join(here, p), "utf8");
const status = read("../src/status.html");
const index = read("../src/index.ts");
const backup = read("../../ops/backup/fleet-backup.sh");

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.error("  FAIL: " + label + (detail ? " -- " + detail : ""));
}
const has = (s: string, n: string) => s.indexOf(n) >= 0;

// ---- THEME: dark, never the old green ----
const GREENS = ["#123a56", "#0f4a47", "#175339"];
GREENS.forEach((g) => ok("status theme is not the old green (" + g + ")", !has(status, g),
  "status.html reverted to the green gradient"));
ok("status body uses the gradient tokens", has(status, "background:linear-gradient(135deg,var(--g1)"));
ok("status --g1 is a dark value", /:root\{--g1:#0[0-9a-f]/.test(status), "theme root var is not dark");

// ---- GRAPHS: the CPU + network + MRTG graphs and their backend must exist ----
["renderMetrics", "cpuSvg(", "mrtgSvg(", "netSvg(", 'id="metrics"', "/api/status/metrics", "MRTG"].forEach((n) =>
  ok("status page keeps graph piece: " + n, has(status, n), "a status-page graph was removed"));
["/api/status/metrics", "smCpuBuckets", "smEdge", "smNet", "STATUS-METRICS-V1"].forEach((n) =>
  ok("metrics backend keeps: " + n, has(index, n), "the status metrics backend was removed"));

// ---- SECTIONS removed on purpose must STAY removed ----
ok("LLM API usage section stays removed", !has(status, "LLM API usage"), "the removed LLM section is back");
ok("backup-log list stays removed", !has(status, "(d.backups||[]).forEach"), "the removed backup-log list is back");
ok("backup card not labelled 'encrypted'", !has(status, "one encrypted file"), "backup card says encrypted again");

// ---- CORE sections still present ----
["function renderBilling", "function renderBackups", "Back up now"].forEach((n) =>
  ok("status page keeps section: " + n, has(status, n)));

// ---- BACKUP is plain, VM+lake, and NEVER dumps Secret Manager ----
ok("backup is plain tar.gz", has(backup, '-czf "$ARCHIVE"') && !has(backup, "--symmetric"),
  "backup is not plain gzip");
ok("backup includes the data-lake (scope=full)", has(backup, "data-lake (full only)") && has(backup, 'rsync -r "gs://$LAKE"'),
  "the data-lake was dropped from the backup");
ok("backup does NOT dump Secret Manager", !has(backup, "secrets versions access latest --secret=") && !has(backup, '"$STAGE/secrets'),
  "the Secret Manager dump is back in the backup");

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
