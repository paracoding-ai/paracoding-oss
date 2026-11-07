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
const restore = read("../../ops/backup/fleet-restore.sh");
const crypt = read("../../ops/backup/fleet-backup-crypt.sh");
const bkmod = read("../src/mods/backup.ts");
const installer = read("../../install/install.sh");
const firstboot = read("../../install/vm-firstboot.sh");

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

// ---- BACKUP: plain when unconfigured, encrypted when configured, VM+lake, NEVER dumps Secret Manager ----
// [FLEET-BACKUP-V2] (2026-10-31) the backup tars the stage and the LOCAL lake (/srv/fleet/lake; the
// old GCS lake bucket no longer exists) and pipes it through gzip -1.
// [BACKUP-CRYPT-V1] (2026-11-07) encryption is OPT-IN via BACKUP_ENCRYPT_SECRET in /etc/fleet/backup.env:
// unset (the production fleet) -> the unchanged plain .tar.gz line; set (the OSS installer) -> the same
// stream through gpg --symmetric AES256 -> *.tar.gz.gpg, passphrase on fd 3 from Secret Manager.
ok("unconfigured backup stays plain tar.gz", has(backup, '| gzip -1 > "$ARCHIVE"') && has(backup, 'METAENC=\'"encrypted":false\''),
  "the plain .tar.gz path changed");
ok("encryption is opt-in on BACKUP_ENCRYPT_SECRET", has(backup, 'ENC_SECRET="${BACKUP_ENCRYPT_SECRET:-}"') && has(backup, 'if [ -n "$ENC_SECRET" ]; then'),
  "encryption is no longer gated on BACKUP_ENCRYPT_SECRET");
ok("configured backup is gpg AES256 -> .tar.gz.gpg", has(backup, '| gzip -1 | bk_encrypt 3< <(printf') && has(backup, 'EXT=".gpg"')
  && has(crypt, "--symmetric --cipher-algo AES256") && has(backup, '"encrypted\\":true'), "the encrypted backup path is gone");
ok("passphrase never on a command line", !/--passphrase[ =]/.test(crypt + backup + restore) && has(crypt, "--passphrase-fd 3")
  && !/gpg[^\n]*--passphrase-file/.test(crypt), "a passphrase reaches gpg some other way than fd 3");
ok("metadata bearer token not on curl's command line", has(crypt, "curl -sf --config -") && !/curl[^\n]*Authorization: Bearer \$/.test(crypt),
  "the Secret Manager bearer token is on a curl argv");
ok("passphrase not in manifest/sidecar/output", !/(ENCMAN|METAENC|ENCOUT|RHINT)=[^\n]*BKPASS/.test(backup) && !/BKPASS[^\n]*(STAGE|MANIFEST|meta\.json|echo)/.test(backup),
  "the passphrase can reach the manifest, sidecar or output");
ok("backup includes the data-lake (scope=full)", has(backup, "LAKEDIR=/srv/fleet/lake") && has(backup, "TARX=(-C /srv/fleet lake)"),
  "the data-lake was dropped from the backup");
ok("backup does NOT dump Secret Manager", !has(backup, "secrets versions access") && !has(backup, '"$STAGE/secrets') && !has(crypt, "STAGE"),
  "the Secret Manager dump is back in the backup");
ok("retention also rotates .tar.gz.gpg", has(backup, '"gs://$BACKUPS/fleet-backup-*-$SCOPE.tar.gz.gpg"'), "encrypted archives are never pruned");
ok("restore auto-decrypts .gpg / sidecar flag / OpenPGP bytes", has(restore, "*.gpg) ENC=1") && has(restore, "'\"encrypted\":true'")
  && has(restore, "8c|c3) ENC=1") && has(restore, "bk_decrypt <"), "fleet-restore.sh no longer auto-decrypts");
ok("restore takes --passphrase-file and --key-secret", has(restore, "--passphrase-file) PASSFILE_ARG") && has(restore, "--key-secret) KEYSEC_ARG"),
  "restore lost its passphrase flags");
ok("wrong passphrase fails loudly", has(restore, 'rfail "decrypt failed'), "a failed decrypt is no longer an error");
ok("installer creates the passphrase once + warns", has(installer, 'sec $BK_SECRET "$(head -c 48 /dev/urandom | base64') && has(installer, "backup-encrypt-secret=$BK_SECRET")
  && has(installer, "unrecoverable"), "install.sh no longer creates/announces the backup passphrase");
ok("first boot writes BACKUP_ENCRYPT_SECRET", has(firstboot, 'echo "BACKUP_ENCRYPT_SECRET=$BKSEC"') && has(firstboot, " gnupg "),
  "vm-firstboot.sh no longer configures encrypted backups");
ok("console accepts and labels .tar.gz.gpg", has(bkmod, "tar\\.gz\\.gpg") && has(bkmod, "encrypted: done.encrypted") && has(status, "if(dl.encrypted)")
  && has(status, "gpg --decrypt"), "the Flow Hood does not know about encrypted archives");
ok("plain download text only for plain archives", /\} else \{\s*b\.appendChild\(el\('note','Plain \.tar\.gz/.test(status), "'Plain .tar.gz' is shown for encrypted archives");

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
