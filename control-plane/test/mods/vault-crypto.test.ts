// SPDX-License-Identifier: Apache-2.0
// [VAULT-CRYPTO-MOD-V1] Unit tests for mods/vault-crypto.ts -- the PURE vault envelope crypto
// helpers extracted from index.ts. All pure: no cloud, no network, no KMS, no server boot. The
// key assertion is a round-trip with a FIXED 32-byte master Buffer, which stands in for the real
// KMS-derived master without touching the stateful machinery that stayed in index.ts.
process.env.PC_NO_LISTEN = "1";
import {
  vaultIsCleartext, vaultObjKey, vaultEncryptSync, vaultDecryptSync,
} from "../../src/mods/vault-crypto.js";

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

// A deterministic, fixed 32-byte master. AES-256 needs exactly 32 bytes; byte i == i.
const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

console.log("vaultEncryptSync/vaultDecryptSync -- round-trip with a fixed 32-byte master");
{
  const cases: Array<[string, string]> = [
    ["strains/foo/state.json", "hello vault"],
    ["strains/foo/state.json", ""],                     // empty plaintext
    ["a/b/c/deeply/nested/path.bin", "the quick brown fox"],
    ["unicode", "café — ñ — \u{1F510} sealed"],          // multibyte utf8
    ["json", JSON.stringify({ k: 1, nested: [1, 2, 3], s: "x".repeat(500) })],
  ];
  for (const [path, plaintext] of cases) {
    const sealed = vaultEncryptSync(master, path, plaintext);
    const round = vaultDecryptSync(master, path, sealed);
    eq("round-trip [" + path + "] (len " + plaintext.length + ")", round, plaintext);
  }

  // A Buffer plaintext decrypts back to its utf8 string form.
  const buf = Buffer.from("binary-ish \x01\x02 payload", "utf8");
  eq("round-trip of a Buffer plaintext", vaultDecryptSync(master, "p/buf", vaultEncryptSync(master, "p/buf", buf)), buf.toString("utf8"));

  // A fresh encrypt uses a random nonce, so two seals of the same input differ byte-for-byte
  // yet both decrypt to the same plaintext.
  const s1 = vaultEncryptSync(master, "same/path", "same");
  const s2 = vaultEncryptSync(master, "same/path", "same");
  ok("two seals of identical input differ (random nonce)", !s1.equals(s2));
  eq("...but first still decrypts", vaultDecryptSync(master, "same/path", s1), "same");
  eq("...and second too", vaultDecryptSync(master, "same/path", s2), "same");
}

console.log("sealed blob -- starts with the VAULT_MAGIC bytes 'PCV1'");
{
  const sealed = vaultEncryptSync(master, "strains/foo/x", "payload");
  ok("first 4 bytes are the ASCII magic 'PCV1'", sealed.slice(0, 4).toString("ascii") === "PCV1");
  ok("magic bytes are exactly 0x50 0x43 0x56 0x31", sealed[0] === 0x50 && sealed[1] === 0x43 && sealed[2] === 0x56 && sealed[3] === 0x31);
  // envelope layout: magic(4)|epoch(1)|flags(1)|nonce(12)|ct|tag(16) -> min 34 bytes even for ''
  const empty = vaultEncryptSync(master, "strains/foo/x", "");
  ok("flags byte (offset 5) is 0x00 as written", empty[5] === 0x00);
  ok("empty-plaintext envelope is header(18) + tag(16) = 34 bytes", empty.length === 34);
}

console.log("vaultDecryptSync -- AAD/tamper and legacy dual-read");
{
  // Wrong path => the AAD no longer authenticates => GCM tag fails => throws.
  const sealed = vaultEncryptSync(master, "right/path", "secret");
  let threw = false;
  try { vaultDecryptSync(master, "wrong/path", sealed); } catch (e) { threw = true; }
  ok("decrypt under the wrong path throws (AAD bound to path)", threw);

  // Wrong master => key is different => tag fails => throws.
  const other = Buffer.alloc(32, 0xaa);
  let threw2 = false;
  try { vaultDecryptSync(other, "right/path", sealed); } catch (e) { threw2 = true; }
  ok("decrypt under the wrong master throws", threw2);

  // No PCV1 magic => legacy plaintext dual-read: returned as-is utf8, never decrypted.
  eq("non-PCV1 blob returns its bytes as utf8 (legacy dual-read)", vaultDecryptSync(master, "p", Buffer.from("just plaintext", "utf8")), "just plaintext");
}

console.log("vaultIsCleartext -- cleartext-prefix matching");
{
  ok("shared/deploy/ is cleartext", vaultIsCleartext("shared/deploy/lane.json") === true);
  ok("shared/harness/ is cleartext", vaultIsCleartext("shared/harness/lessons.md") === true);
  ok("shared/passkey/ is cleartext", vaultIsCleartext("shared/passkey/x") === true);
  ok("shared/mcp-oauth/ is cleartext", vaultIsCleartext("shared/mcp-oauth/tok") === true);
  ok("shared/vault/ is cleartext", vaultIsCleartext("shared/vault/master.kem") === true);
  ok("leading slashes are stripped before matching", vaultIsCleartext("///shared/vault/x") === true);
  ok("a non-allowlisted path is NOT cleartext", vaultIsCleartext("strains/foo/state.json") === false);
  ok("a prefix must match at position 0", vaultIsCleartext("x/shared/deploy/y") === false);
  ok("empty path is not cleartext", vaultIsCleartext("") === false);
  ok("null-ish path is handled", vaultIsCleartext(undefined as any) === false);
}

console.log("vaultObjKey -- deterministic 32-byte key derivation");
{
  const k1 = vaultObjKey(master, "p/a", 2);
  ok("derives a 32-byte key", Buffer.isBuffer(k1) && k1.length === 32);
  ok("same inputs => same key (pure)", vaultObjKey(master, "p/a", 2).equals(k1));
  ok("different path => different key", !vaultObjKey(master, "p/b", 2).equals(k1));
  ok("different epoch => different key", !vaultObjKey(master, "p/a", 1).equals(k1));
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
