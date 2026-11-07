// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE surface of src/mods/oauth.ts (OAuth 2.1 helpers extracted from
// index.ts). These functions take no cloud, no network and no secrets: oaB64url / oaRand encode,
// oaNormEmail normalises, oaRegBodyTooBig / oaRedirectUriReason validate registration input, and
// oaJsonForScript is the <script>-safe JSON encoder that closed the reflected-XSS hole on the
// consent page. The IO helpers (oaAllowList/oaRegRateLimit, which touch Firestore) are NOT driven
// here. Importing the module runs store.js at load, which PC_NO_LISTEN keeps inert.
process.env.PC_NO_LISTEN = "1";
import { oaB64url, oaRand, oaNormEmail, oaRegBodyTooBig, oaRedirectUriReason, oaJsonForScript } from "../../src/mods/oauth.js";

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
  console.log("oaB64url -- url-safe, unpadded base64");
  {
    eq("'hello' encodes without padding", oaB64url(Buffer.from("hello")), "aGVsbG8");
    eq("0xff 0xff 0xff -> ____ (slash becomes underscore)", oaB64url(Buffer.from([0xff, 0xff, 0xff])), "____");
    eq("0xfb 0xff 0xbf -> -_-_ (plus->minus, slash->underscore)", oaB64url(Buffer.from([0xfb, 0xff, 0xbf])), "-_-_");
    const enc = oaB64url(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
    ok("never emits +, / or = ", !/[+/=]/.test(enc), enc);
    ok("only url-safe alphabet", /^[A-Za-z0-9_-]*$/.test(enc), enc);
  }

  console.log("oaRand -- random token shape and length");
  {
    const d = oaRand();
    ok("default is a string", typeof d === "string");
    ok("default is url-safe only", /^[A-Za-z0-9_-]+$/.test(d), d);
    eq("default (32 bytes) is 43 chars", d.length, 43);
    eq("oaRand(16) is 22 chars", oaRand(16).length, 22);
    ok("two calls differ (randomness)", oaRand() !== oaRand());
  }

  console.log("oaNormEmail -- trim + lowercase, null-safe");
  {
    eq("trims and lowercases", oaNormEmail("  Foo@Bar.COM "), "foo@bar.com");
    eq("null -> empty string", oaNormEmail(null), "");
    eq("undefined -> empty string", oaNormEmail(undefined), "");
    eq("non-string coerces", oaNormEmail(123 as any), "123");
  }

  console.log("oaRegBodyTooBig -- per-field and array ceilings");
  {
    eq("small body is fine", oaRegBodyTooBig({ body: { a: "x" } }), false);
    eq("empty body is fine", oaRegBodyTooBig({ body: {} }), false);
    eq("no req is fine", oaRegBodyTooBig(null as any), false);
    eq("oversized string field is too big", oaRegBodyTooBig({ body: { a: "x".repeat(3000) } }), true);
    eq("array over 64 entries is too big", oaRegBodyTooBig({ body: { arr: new Array(65).fill(1) } }), true);
    eq("array of 64 entries is fine", oaRegBodyTooBig({ body: { arr: new Array(64).fill(1) } }), false);
  }

  console.log("oaRedirectUriReason -- '' means acceptable, else a plain-words reason");
  {
    eq("https is accepted", oaRedirectUriReason("https://example.com/cb"), "");
    eq("http loopback 127.0.0.1 is accepted", oaRedirectUriReason("http://127.0.0.1:3000/callback"), "");
    eq("http localhost is accepted", oaRedirectUriReason("http://localhost:8080/cb"), "");
    ok("plain http host is refused", oaRedirectUriReason("http://evil.com/cb").indexOf("scheme") >= 0);
    ok("javascript: scheme is refused", oaRedirectUriReason("javascript:alert(1)") !== "");
    eq("embedded credentials refused", oaRedirectUriReason("https://u:p@example.com/cb"), "carries embedded credentials");
    eq("fragment refused", oaRedirectUriReason("https://example.com/cb#frag"), "carries a fragment");
    eq("non-URL refused", oaRedirectUriReason("notaurl"), "is not an absolute URL");
    eq("whitespace/control refused", oaRedirectUriReason("https://e\tx.com/cb"), "contains whitespace or control characters");
    eq("overlong refused", oaRedirectUriReason("h".repeat(3000)), "is longer than 2048 characters");
  }

  console.log("oaJsonForScript -- <script>-safe JSON, value-preserving (SEC-OAUTH-XSS-SCRIPTJSON)");
  {
    const s = oaJsonForScript("</script><b>&x");
    ok("escapes <", s.indexOf("\\u003c") >= 0 && s.indexOf("<") < 0, s);
    ok("escapes >", s.indexOf("\\u003e") >= 0 && s.indexOf(">") < 0, s);
    ok("escapes &", s.indexOf("\\u0026") >= 0 && s.indexOf("&") < 0, s);
    eq("still parses to the identical value", JSON.parse(s), "</script><b>&x");
    const obj = oaJsonForScript({ redirect: "</script>", n: 3 });
    ok("object output has no raw <", obj.indexOf("<") < 0, obj);
    eq("object round-trips", JSON.stringify(JSON.parse(obj)), JSON.stringify({ redirect: "</script>", n: 3 }));
    const u = oaJsonForScript("a b c");
    ok("escapes U+2028", u.indexOf("\\u2028") >= 0 && u.indexOf(" ") < 0);
    ok("escapes U+2029", u.indexOf("\\u2029") >= 0 && u.indexOf(" ") < 0);
    eq("line-separator value preserved", JSON.parse(u), "a b c");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
