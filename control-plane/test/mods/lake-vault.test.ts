// SPDX-License-Identifier: Apache-2.0
// [LAKE-VAULT-MOD-V1] Unit tests for mods/lake-vault.ts -- the pure signed-read helpers extracted
// from the /lakeview viewer. All pure: no cloud, no network, no server boot. The gate secret is
// set BEFORE the dynamic import so shared.ts reads a valid WA_SESSION_SECRET at module load and
// WA_SESSION_SECRET_OK is true (lvSign/lvVerify fail CLOSED on a weak secret).
process.env.PC_NO_LISTEN = "1";
process.env.WA_SESSION_SECRET = "lakeview-unit-test-secret-0123456789ABCDEF";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function fakeReq(cookie?: string): any { return { headers: cookie ? { cookie } : {} }; }

void (async () => {
const lv = await import("../../src/mods/lake-vault.js");

console.log("lvPathOk -- path scoping (allow-list, shape, cleartext refusal)");
{
  eq("empty path refused", lv.lvPathOk(""), "path is empty or longer than 512 characters");
  eq("over 512 chars refused", lv.lvPathOk("shared/state/" + "a".repeat(600)), "path is empty or longer than 512 characters");
  eq("leading slash refused", lv.lvPathOk("/shared/state/x"), "path must be relative to the bucket root");
  ok("backslash / control char refused", lv.lvPathOk("shared/state/a\\b") !== "");
  ok("traversal '..' refused (not a plain name)", lv.lvPathOk("shared/state/../secret").indexOf("is not a plain name") >= 0);
  ok("outside every allow prefix refused", lv.lvPathOk("shared/secret/x").indexOf("outside every viewable prefix") >= 0);
  // accepted paths inside the allow-list that are not cleartext-at-rest
  eq("shared/state/ accepted", lv.lvPathOk("shared/state/report.txt"), "");
  eq("shared/handoff/ accepted", lv.lvPathOk("shared/handoff/note.md"), "");
  eq("agents/ accepted", lv.lvPathOk("agents/advisor/log.json"), "");
}

console.log("lvSessionFp -- determinism + binding to the gate_session payload");
{
  const a = lv.lvSessionFp(fakeReq("gate_session=payloadAAA.sigBBB"));
  const b = lv.lvSessionFp(fakeReq("gate_session=payloadAAA.sigBBB"));
  ok("same cookie -> same fingerprint (deterministic)", a === b && a.length === 32);
  const c = lv.lvSessionFp(fakeReq("gate_session=payloadCCC.sigDDD"));
  ok("different payload -> different fingerprint", a !== c);
  eq("no cookie -> empty fingerprint", lv.lvSessionFp(fakeReq()), "");
  eq("cookie without a '.' separator -> empty fingerprint", lv.lvSessionFp(fakeReq("gate_session=nopayload")), "");
  // the sig half of the cookie must not change the fingerprint -- only the payload half is hashed
  const d = lv.lvSessionFp(fakeReq("gate_session=payloadAAA.DIFFERENTSIG"));
  eq("fingerprint ignores the signature half of the cookie", d, a);
}

console.log("lvSign/lvVerify -- HMAC round-trip with the fixed test secret");
{
  const s1 = lv.lvSign("hello");
  const s2 = lv.lvSign("hello");
  ok("lvSign is deterministic for the same payload", s1 === s2 && s1.length > 0);
  ok("lvSign domain-separates by payload", lv.lvSign("hello") !== lv.lvSign("hello2"));
}

console.log("lvMint/lvVerify -- mint-then-verify round-trip, session-bound");
{
  const fp = lv.lvSessionFp(fakeReq("gate_session=sessionX.sig"));
  const m = lv.lvMint("shared/state/report.txt", fp);
  ok("mint produces a token and a future exp", typeof m.token === "string" && m.exp > Date.now());
  const v = lv.lvVerify(m.token, fp);
  ok("verify with the minting fingerprint returns the path", !!v);
  eq("verified path matches the minted path", v!.path, "shared/state/report.txt");
  // bound to the session: a different fingerprint must not redeem it
  eq("verify with a different fingerprint -> null", lv.lvVerify(m.token, "deadbeef".repeat(4)) as any, null);
  // a tampered signature is rejected
  eq("tampered token -> null", lv.lvVerify(m.token.slice(0, -2) + "zz", fp) as any, null);
  // malformed token (no dot) -> null
  eq("malformed token (no '.') -> null", lv.lvVerify("garbage", fp) as any, null);
  // empty fingerprint never verifies
  eq("empty fingerprint -> null", lv.lvVerify(m.token, "") as any, null);
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
