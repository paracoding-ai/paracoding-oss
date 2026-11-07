// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-light identity/strain helpers extracted into src/mods/identity.ts.
// Every function under test is pure: it inspects only its arguments (plus two env-derived module
// constants, which we pin below before loading the module). No cloud, network, or secrets.
process.env.PC_NO_LISTEN = "1";
// Pin the two env-derived constants the module reads at load time, so the assertions below are
// deterministic regardless of the ambient environment. Set BEFORE the dynamic import.
process.env.PC_TRUSTED_PROXY_HOPS = "1";
process.env.WA_APPROVER_EMAILS = "boss@x.com, Admin@Y.com";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function has(label: string, hay: string, needle: string) {
  ok(label, hay.indexOf(needle) >= 0, "missing " + JSON.stringify(needle) + "\n        in " + JSON.stringify(hay));
}

(async () => {
  const m: any = await import("../../src/mods/identity.js");
  const { pcRowMillis, pcStrainVisible, pcTrustedClientIp, pcDeniedText } = m;

  console.log("pcRowMillis -- parses Firestore timestamp shapes, Date, ISO string, else 0");
  {
    eq("Firestore {_seconds}", pcRowMillis({ timestamp: { _seconds: 1000 } }), 1000000);
    eq("Firestore {seconds}", pcRowMillis({ timestamp: { seconds: 2 } }), 2000);
    eq("toMillis() shape", pcRowMillis({ timestamp: { toMillis: () => 4242 } }), 4242);
    const d = new Date("2021-01-01T00:00:00Z");
    eq("Date instance -> getTime()", pcRowMillis({ timestamp: d }), d.getTime());
    eq("ISO string -> Date.parse", pcRowMillis({ timestamp: "2021-01-01T00:00:00Z" }), Date.parse("2021-01-01T00:00:00Z"));
    eq("unparseable string -> 0", pcRowMillis({ timestamp: "not-a-date" }), 0);
    eq("no timestamp -> 0", pcRowMillis({}), 0);
    eq("null row -> 0", pcRowMillis(null), 0);
  }

  console.log("pcStrainVisible -- owner/shared_with/approver branch logic with injected rows");
  {
    // viewer === null means the console is unscoped (no IAP): everything is visible.
    eq("null viewer sees all", pcStrainVisible({ owner_email: "a@b.com" }, null), true);
    // empty-string viewer is an authenticated-but-unresolved identity: sees nothing.
    eq("empty viewer sees nothing", pcStrainVisible({ owner_email: "a@b.com" }, ""), false);
    // Owned strain: visible only to its owner...
    eq("owner matches", pcStrainVisible({ owner_email: "A@B.com" }, "a@b.com"), true);
    eq("non-owner, not shared", pcStrainVisible({ owner_email: "a@b.com" }, "c@d.com"), false);
    // ...or to an address listed in shared_with (case-insensitive).
    eq("shared_with match", pcStrainVisible({ owner_email: "a@b.com", shared_with: ["C@D.com"] }, "c@d.com"), true);
    eq("shared_with miss", pcStrainVisible({ owner_email: "a@b.com", shared_with: ["x@y.com"] }, "c@d.com"), false);
    // Unowned (legacy) strain: belongs to the approvers (WA_APPROVER_EMAILS, pinned above).
    eq("unowned -> approver visible", pcStrainVisible({}, "boss@x.com"), true);
    eq("unowned -> approver (lowercased list) visible", pcStrainVisible({ owner_email: "" }, "admin@y.com"), true);
    eq("unowned -> non-approver hidden", pcStrainVisible({}, "stranger@z.com"), false);
  }

  console.log("pcTrustedClientIp -- X-Forwarded-For parsing with PC_TRUSTED_PROXY_HOPS=1, injected req");
  {
    // hops=1: take the entry one before the last (the client as seen by the trusted proxy).
    eq("xff a,b,c hops=1 -> b", pcTrustedClientIp({ headers: { "x-forwarded-for": "a, b, c" } }), "b");
    // Single entry: idx goes negative, clamps to 0.
    eq("xff single -> that entry", pcTrustedClientIp({ headers: { "x-forwarded-for": "1.2.3.4" } }), "1.2.3.4");
    eq("xff trims whitespace", pcTrustedClientIp({ headers: { "x-forwarded-for": " p ,  q ,  r " } }), "q");
    // No XFF: fall back to req.ip, then connection/socket remoteAddress, then 'unknown'.
    eq("no xff -> req.ip", pcTrustedClientIp({ headers: {}, ip: "9.9.9.9" }), "9.9.9.9");
    eq("no xff, socket fallback", pcTrustedClientIp({ headers: {}, socket: { remoteAddress: "8.8.8.8" } }), "8.8.8.8");
    eq("nothing -> unknown", pcTrustedClientIp({ headers: {} }), "unknown");
  }

  console.log("pcDeniedText -- reason -> operator-facing refusal text");
  {
    has("no-strain-for-user", pcDeniedText("no-strain-for-user"), "no Paracoding strain assigned");
    has("user-ambiguous says 'unambiguously'", pcDeniedText("user-ambiguous"), "unambiguously");
    has("user-missing explains token", pcDeniedText("user-missing"), "No user token reached the control plane");
    has("user-audience branch", pcDeniedText("user-audience"), "different OAuth client");
    has("role-keyword prefix", pcDeniedText("role-keyword:bogus"), "DENIED (role keyword): bogus");
    const ur = pcDeniedText("unknown-or-revoked");
    has("unknown-or-revoked mentions expiry", ur, "has EXPIRED, or has been revoked");
    has("unknown-or-revoked quotes TTL days (default 7)", ur, "last 7 days");
    ok("unknown-or-revoked omits the retry-once preamble", ur.indexOf("RETRY ONCE BEFORE ANYTHING ELSE") < 0);
    const mixed = pcDeniedText("mixed");
    has("mixed reports multiple keys", mixed, "more than one session key");
    const none = pcDeniedText("no-identity-yet");
    has("no-identity includes retry-once preamble", none, "RETRY ONCE BEFORE ANYTHING ELSE");
    has("no-identity explains the agent argument", none, 'Pass your session key as the "agent" argument');
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
