// SPDX-License-Identifier: Apache-2.0
// [BACKUP-CRYPT-V1] The backup contract: archives are plain fleet-backup-*.tar.gz when
// /etc/fleet/backup.env does not set BACKUP_ENCRYPT_SECRET, and fleet-backup-*.tar.gz.gpg (gpg
// AES256, passphrase from that Secret Manager secret on fd 3) when it does. This drives the PURE
// surface of src/mods/backup.ts (env-file parsing, bucket/encryption resolution, naming) and the
// shell crypto helper ops/backup/fleet-backup-crypt.sh for a real encrypt -> decrypt round trip with a
// dummy passphrase (skipped when gpg is not installed). No cloud, no network, no secrets.
process.env.PC_NO_LISTEN = "1";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bkEnvFile, bkBucket, bkIsEncrypted } from "../../src/mods/backup.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
const here = dirname(fileURLToPath(import.meta.url));
const CRYPT = join(here, "../../../ops/backup/fleet-backup-crypt.sh");
const T = mkdtempSync(join(tmpdir(), "bk-test-"));

// ---- backup.env parsing (the file fleet-backup.sh sources) ----
writeFileSync(join(T, "backup.env"), "BACKUP_BUCKET=demo-proj-paracoding-backups\nBACKUP_ENCRYPT_SECRET=backup-passphrase\n# comment\nexport BACKUP_KEEP=\"5\"\n");
const e = bkEnvFile(join(T, "backup.env"));
ok("env: BACKUP_BUCKET", e.BACKUP_BUCKET === "demo-proj-paracoding-backups", JSON.stringify(e));
ok("env: BACKUP_ENCRYPT_SECRET", e.BACKUP_ENCRYPT_SECRET === "backup-passphrase", JSON.stringify(e));
ok("env: export + quotes", e.BACKUP_KEEP === "5", JSON.stringify(e));
ok("env: missing file -> {}", Object.keys(bkEnvFile(join(T, "nope.env"))).length === 0);
writeFileSync(join(T, "prod.env"), "BACKUP_BUCKET=your-project-id-backups\n");
ok("env: production file has no encryption key", !("BACKUP_ENCRYPT_SECRET" in bkEnvFile(join(T, "prod.env"))));

// ---- bucket resolution: env wins, junk falls back to the production default ----
const saved = process.env.BACKUP_BUCKET;
process.env.BACKUP_BUCKET = "demo-proj-paracoding-backups";
ok("bucket: BACKUP_BUCKET env", bkBucket() === "demo-proj-paracoding-backups", bkBucket());
process.env.BACKUP_BUCKET = "bad bucket/../x";
ok("bucket: junk name rejected", bkBucket() !== "bad bucket/../x", bkBucket());
if (saved === undefined) delete process.env.BACKUP_BUCKET; else process.env.BACKUP_BUCKET = saved;

// ---- naming ----
ok("name: .tar.gz.gpg is encrypted", bkIsEncrypted("fleet-backup-20261107T010203Z-full.tar.gz.gpg"));
ok("name: .tar.gz is plain", !bkIsEncrypted("fleet-backup-20261107T010203Z-full.tar.gz"));
ok("name: legacy .tar.zst.gpg is encrypted", bkIsEncrypted("fleet-backup-20260101T000000Z-core.tar.zst.gpg"));

// ---- real gpg round trip through the shell helper (fd 3 passphrase, throwaway GNUPGHOME) ----
const hasGpg = spawnSync("bash", ["-c", "command -v gpg"]).status === 0;
if (!hasGpg) { console.log("  (gpg not installed -- round-trip skipped)"); }
else {
  writeFileSync(join(T, "pass"), "dummy-passphrase-for-tests-0123456789", { mode: 0o600 });
  writeFileSync(join(T, "wrong"), "not-the-passphrase-0123456789", { mode: 0o600 });
  const plain = Buffer.concat([Buffer.from("fleet-backup round trip\n"), Buffer.alloc(200000, 7)]);
  writeFileSync(join(T, "a.tar.gz"), plain);
  const sh = (s: string) => spawnSync("bash", ["-c", ". \"$CRYPT\"; " + s], { env: { ...process.env, CRYPT, T, BK_GPG_TMP: T }, encoding: "utf8" });
  const enc = sh('bk_encrypt < "$T/a.tar.gz" 3< "$T/pass" > "$T/a.tar.gz.gpg"');
  ok("crypt: encrypt exits 0", enc.status === 0, enc.stderr);
  const ct = readFileSync(join(T, "a.tar.gz.gpg"));
  ok("crypt: ciphertext is OpenPGP, not the plaintext", ct.length > 0 && (ct[0] === 0x8c || ct[0] === 0xc3) && ct.indexOf(Buffer.from("fleet-backup round trip")) < 0);
  ok("crypt: bk_is_openpgp sniffs it", sh('bk_is_openpgp "$T/a.tar.gz.gpg" && ! bk_is_openpgp "$T/a.tar.gz"').status === 0);
  const dec = sh('bk_decrypt < "$T/a.tar.gz.gpg" 3< "$T/pass" > "$T/b.tar.gz"');
  ok("crypt: decrypt exits 0", dec.status === 0, dec.stderr);
  ok("crypt: round trip is byte-identical", Buffer.compare(readFileSync(join(T, "b.tar.gz")), plain) === 0);
  const bad = sh('bk_decrypt < "$T/a.tar.gz.gpg" 3< "$T/wrong" > "$T/c.tar.gz"');
  ok("crypt: wrong passphrase fails loudly", bad.status !== 0 && /decrypt|bad session key|failed/i.test(bad.stderr), "status " + bad.status + " " + bad.stderr);
  ok("crypt: wrong passphrase yields no plaintext", readFileSync(join(T, "c.tar.gz")).length === 0);
  ok("crypt: no GNUPGHOME left behind", spawnSync("bash", ["-c", 'ls -d "$T"/.bkgpg-* 2>/dev/null | wc -l'], { env: { ...process.env, T }, encoding: "utf8" }).stdout.trim() === "0");
}
rmSync(T, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
