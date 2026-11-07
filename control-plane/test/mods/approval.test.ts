// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE surface of src/mods/approval.ts (privileged-job APPROVAL signing
// helpers extracted from index.ts). These take no cloud, no network and no secrets:
// pcApprovalCanonV1/V2 build the length-prefixed canonical bytes a cross-language verifier
// must reproduce, pcApprovalArgsSha is the stable sha256 over the stable-JSON arguments, and
// pcCanonUnsafeArg / pcLoneSurrogate are the refusal guards. The IO half (pcApprovalSign,
// which calls Cloud KMS) is NOT driven here. Importing the module runs shared.js at load,
// which PC_NO_LISTEN keeps inert.
process.env.PC_NO_LISTEN = "1";
import * as crypto from "crypto";
import { pcApprovalCanonV1, pcApprovalCanonV2, pcApprovalArgsSha, pcCanonUnsafeArg, pcLoneSurrogate } from "../../src/mods/approval.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function threw(label: string, fn: () => any) {
  let t = false; try { fn(); } catch (e) { t = true; }
  ok(label, t, "expected a throw, got none");
}

// Independent re-derivation of the documented canon format, matching what a Python verifier
// must produce: ID + '\n', then for each field  <byteLen(name)>:name=<byteLen(value)>:value;
function canon(id: string, order: string[], f: any): Buffer {
  const parts: Buffer[] = [Buffer.from(id + "\n", "utf8")];
  for (const n of order) {
    const nb = Buffer.from(n, "utf8");
    const vb = Buffer.from(String(f[n]), "utf8");
    parts.push(Buffer.from(String(nb.length) + ":", "ascii"), nb,
               Buffer.from("=" + String(vb.length) + ":", "ascii"), vb,
               Buffer.from(";", "ascii"));
  }
  return Buffer.concat(parts);
}

const V1_IN = { alg: "EC_SIGN_P256_SHA256", jid: "job-123", csha: "abc", appr: "admin@example.com", kver: "k/1", iat: "2026-01-01T00:00:00.000Z", exp: "2026-01-01T01:00:00.000Z" };
const V2_IN = { alg: "EC_SIGN_P256_SHA256", jid: "job-123", csha: "abc", ctyp: "shell", asha: "deadbeef", appr: "admin@example.com", kver: "k/1", iat: "2026-01-01T00:00:00.000Z", exp: "2026-01-01T01:00:00.000Z" };
const V1_HEX = "50432d415050524f56414c2d43414e4f4e2d56310a333a616c673d31393a45435f5349474e5f503235365f5348413235363b333a6a69643d373a6a6f622d3132333b343a637368613d333a6162633b343a617070723d31353a73636f74744067707568612e636f6d3b343a6b7665723d333a6b2f313b333a6961743d32343a323032362d30312d30315430303a30303a30302e3030305a3b333a6578703d32343a323032362d30312d30315430313a30303a30302e3030305a3b";
const V2_HEX = "50432d415050524f56414c2d43414e4f4e2d56320a333a616c673d31393a45435f5349474e5f503235365f5348413235363b333a6a69643d373a6a6f622d3132333b343a637368613d333a6162633b343a637479703d353a7368656c6c3b343a617368613d383a64656164626565663b343a617070723d31353a73636f74744067707568612e636f6d3b343a6b7665723d333a6b2f313b333a6961743d32343a323032362d30312d30315430303a30303a30302e3030305a3b333a6578703d32343a323032362d30312d30315430313a30303a30302e3030305a3b";

(async () => {
  console.log("pcApprovalCanonV1 -- stable, deterministic length-prefixed bytes");
  {
    const b = pcApprovalCanonV1(V1_IN);
    ok("returns a Buffer", Buffer.isBuffer(b));
    ok("starts with the V1 domain line", b.toString("utf8").startsWith("PC-APPROVAL-CANON-V1\n"), b.toString("utf8").slice(0, 24));
    ok("deterministic: identical bytes on repeat", b.equals(pcApprovalCanonV1(V1_IN)));
    eq("frozen golden vector (hex)", b.toString("hex"), V1_HEX);
    ok("matches independent re-derivation of the spec", b.equals(canon("PC-APPROVAL-CANON-V1", ["alg","jid","csha","appr","kver","iat","exp"], V1_IN)));
    threw("refuses a non-string field", () => pcApprovalCanonV1({ ...V1_IN, jid: 123 as any }));
  }

  console.log("pcApprovalCanonV2 -- adds ctyp/asha, distinct domain, deterministic");
  {
    const b = pcApprovalCanonV2(V2_IN);
    ok("returns a Buffer", Buffer.isBuffer(b));
    ok("starts with the V2 domain line", b.toString("utf8").startsWith("PC-APPROVAL-CANON-V2\n"), b.toString("utf8").slice(0, 24));
    ok("deterministic: identical bytes on repeat", b.equals(pcApprovalCanonV2(V2_IN)));
    eq("frozen golden vector (hex)", b.toString("hex"), V2_HEX);
    ok("matches independent re-derivation of the spec", b.equals(canon("PC-APPROVAL-CANON-V2", ["alg","jid","csha","ctyp","asha","appr","kver","iat","exp"], V2_IN)));
    const v1 = pcApprovalCanonV1(V1_IN);
    ok("domain separation: V1 and V2 never share leading bytes", v1[0] === b[0] ? v1.slice(0, 22).toString() !== b.slice(0, 22).toString() : true);
    ok("V1 and V2 differ at the domain line", !pcApprovalCanonV2(V2_IN).equals(v1));
    threw("refuses a non-string field", () => pcApprovalCanonV2({ ...V2_IN, asha: null as any }));
  }

  console.log("pcApprovalArgsSha -- stable hex sha256 over stable-JSON arguments");
  {
    const h = pcApprovalArgsSha({ b: 2, a: 1 });
    ok("64 lowercase hex chars", /^[0-9a-f]{64}$/.test(h), h);
    eq("deterministic on repeat", pcApprovalArgsSha({ b: 2, a: 1 }), h);
    eq("key order does not matter (stable JSON)", pcApprovalArgsSha({ a: 1, b: 2 }), h);
    eq("frozen golden vector for {a:1,b:2}", h, "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    const nullSha = crypto.createHash("sha256").update("null", "utf8").digest("hex");
    eq("null canonicalises to sha256('null')", pcApprovalArgsSha(null), nullSha);
    eq("absent (undefined) === null, deliberately", pcApprovalArgsSha(undefined), pcApprovalArgsSha(null));
    threw("refuses a non-integral number the verifier could not match", () => pcApprovalArgsSha({ x: 1.5 }));
    threw("refuses a non-plain object (Date)", () => pcApprovalArgsSha({ x: new Date() }));
  }

  console.log("pcCanonUnsafeArg -- '' when safe, a plain-words reason otherwise");
  {
    eq("plain nested object/array/bool/null/string is safe", pcCanonUnsafeArg({ a: 1, b: [true, null, "x"] }), "");
    eq("safe integer is safe", pcCanonUnsafeArg(42), "");
    eq("null is safe", pcCanonUnsafeArg(null), "");
    ok("non-integral number is flagged", pcCanonUnsafeArg(1.5) === "a non-integral number");
    ok("non-finite number is flagged", pcCanonUnsafeArg(Infinity) === "a non-finite number");
    ok("unsafe integer is flagged", pcCanonUnsafeArg(Number.MAX_SAFE_INTEGER + 2) === "an integer outside the safe range");
    ok("a Date (non-plain object) is flagged", pcCanonUnsafeArg(new Date()) === "an object that is not a plain object");
    ok("a lone-surrogate string is flagged", pcCanonUnsafeArg("bad \uD800 pair") === "a string containing an unpaired UTF-16 surrogate");
    ok("a lone surrogate in an object KEY is flagged", pcCanonUnsafeArg({ ["\uD800"]: 1 }) === "an object key containing an unpaired UTF-16 surrogate");
    ok("a function value is flagged", pcCanonUnsafeArg((() => 0) as any).startsWith("a value of type "));
  }

  console.log("pcLoneSurrogate -- true only for an unpaired UTF-16 surrogate");
  {
    eq("ordinary text is fine", pcLoneSurrogate("normal é text"), false);
    eq("a valid surrogate PAIR is fine", pcLoneSurrogate("😀"), false);
    eq("a lone HIGH surrogate is caught", pcLoneSurrogate("x\uD800y"), true);
    eq("a lone LOW surrogate is caught", pcLoneSurrogate("x\uDC00y"), true);
    eq("empty string is fine", pcLoneSurrogate(""), false);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
