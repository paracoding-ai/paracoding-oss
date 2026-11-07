// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure/offline branches of the Gemini Enterprise engine module
// (src/mods/gemini-enterprise.ts), extracted from index.ts by the strangler refactor.
//  - geRedirect: derives "<base>/ge/callback" from GE_PUBLIC_URL or the request host, trailing
//    slashes stripped. Pure (env + req), no network.
//  - geTurnLogLink: builds a Cloud Logging deep link; returns '' with no GE_LOG_PROJECT, and
//    otherwise derives the session id as the last non-empty path segment. GE_LOG_PROJECT is read
//    at module LOAD, so the module is imported DYNAMICALLY after the env var is set.
//  - gePace: the per-process RPM bucket starts empty, so the first call waits 0ms.
//  - geOnce: one streamAssist round trip -- it fetches immediately and has no offline branch, so
//    it is only asserted to be an exported function.
// No cloud, no network, no secrets.
process.env.PC_NO_LISTEN = "1";
process.env.GE_LOG_PROJECT = "ge-logs-proj";       // must be set BEFORE the dynamic import below

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
  // Dynamic import so GE_LOG_PROJECT (read at module load) is already set when the module evaluates.
  const { geRedirect, geTurnLogLink, gePace, geOnce } = await import("../../src/mods/gemini-enterprise.js");

  console.log("exports -- every moved symbol is an exported function");
  {
    ok("geRedirect is a function", typeof geRedirect === "function");
    ok("geTurnLogLink is a function", typeof geTurnLogLink === "function");
    ok("gePace is a function", typeof gePace === "function");
    ok("geOnce is a function", typeof geOnce === "function");
  }

  console.log("geRedirect -- '<base>/ge/callback', base from GE_PUBLIC_URL or req host, no trailing /");
  {
    const saved = process.env.GE_PUBLIC_URL;
    process.env.GE_PUBLIC_URL = "https://pub.example.com";
    eq("GE_PUBLIC_URL used verbatim", geRedirect({ get: () => "ignored.host" }), "https://pub.example.com/ge/callback");
    process.env.GE_PUBLIC_URL = "https://pub.example.com///";
    eq("trailing slashes stripped", geRedirect({ get: () => "ignored.host" }), "https://pub.example.com/ge/callback");
    delete process.env.GE_PUBLIC_URL;
    eq("falls back to https://<req host>", geRedirect({ get: (_h: string) => "req.host.example" }), "https://req.host.example/ge/callback");
    ok("deterministic for the same input", geRedirect({ get: () => "a.b" }) === geRedirect({ get: () => "a.b" }));
    if (saved === undefined) delete process.env.GE_PUBLIC_URL; else process.env.GE_PUBLIC_URL = saved;
  }

  console.log("geTurnLogLink -- '' without a session id; else a Logging link seeded with the id");
  {
    eq("empty session -> ''", geTurnLogLink(""), "");
    eq("slashes only -> '' (no id)", geTurnLogLink("///"), "");
    const proj = "ge-logs-proj";
    const mk = (sid: string) => {
      const q = 'logName=~"discoveryengine.googleapis.com%2F" AND "' + sid + '"';
      return '\nlogs: https://console.cloud.google.com/logs/query;query='
        + encodeURIComponent(q) + '?project=' + encodeURIComponent(proj);
    };
    eq("full session path -> last segment is the id", geTurnLogLink("projects/p/locations/global/collections/c/engines/e/sessions/abc123"), mk("abc123"));
    eq("trailing slash ignored when picking the id", geTurnLogLink("a/b/c/"), mk("c"));
    eq("bare id passes through", geTurnLogLink("sess-xyz"), mk("sess-xyz"));
    ok("link starts with the logs prefix", geTurnLogLink("x/y").startsWith("\nlogs: https://console.cloud.google.com/logs/query;query="));
    ok("link names the configured project", geTurnLogLink("x/y").indexOf("project=" + proj) >= 0);
    ok("deterministic for the same session", geTurnLogLink("s/1") === geTurnLogLink("s/1"));
  }

  console.log("gePace -- the RPM bucket starts empty, so the first call waits 0ms");
  {
    const w = await gePace();
    eq("first call returns 0 (no wait)", w, 0);
    ok("returns a number", typeof w === "number");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
