// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE surface of src/mods/wa-http.ts (HTTP wrappers + gate/util helpers
// extracted from index.ts). These take no cloud, no network and no secrets: waSafe wraps an
// express handler and swallows its throw, waCookie parses the Cookie header, waIsDangerous is a
// pure regex classifier, and waWorkstreamOf derives a workstream from a job shape. The IO halves
// (waFetchLong/waPostLong real sockets, waJobCommand's Firestore read) are NOT driven here; they
// are exercised by the import-smoke and integration paths. Importing the module runs shared.js at
// load, which PC_NO_LISTEN keeps inert.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { waSafe, waCookie, waIsDangerous, waWorkstreamOf } from "../../src/mods/wa-http.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

// Minimal express req/res doubles — only the members the helpers touch.
function mkReq(cookie?: string): any { return { headers: cookie === undefined ? {} : { cookie } }; }
function mkRes(): any {
  const r: any = { headersSent: false, _status: 0, _json: undefined, _sent: false };
  r.status = (n: number) => { r._status = n; return r; };
  r.json = (v: any) => { r._json = v; r._sent = true; return r; };
  return r;
}

(async () => {
  console.log("waCookie -- parses the Cookie header, URL-decodes the value");
  {
    const req = mkReq("a=1; gate_session=abc%20d; b=2");
    eq("reads a named cookie", waCookie(req, "a"), "1");
    eq("URL-decodes the value", waCookie(req, "gate_session"), "abc d");
    eq("later cookie still found", waCookie(req, "b"), "2");
    eq("absent name -> undefined", waCookie(req, "nope"), undefined);
    eq("no Cookie header -> undefined", waCookie(mkReq(), "a"), undefined);
    eq("a part with no '=' is skipped", waCookie(mkReq("flag; x=9"), "x"), "9");
  }

  console.log("waIsDangerous -- true for destructive commands, false for read-only ones");
  {
    eq("gcloud delete", waIsDangerous("gcloud projects delete evil"), true);
    eq("rm -rf", waIsDangerous("rm -rf /var/data"), true);
    eq("gsutil rm", waIsDangerous("gsutil rm gs://bucket/x"), true);
    eq("gcloud storage rm", waIsDangerous("gcloud storage rm gs://b/o"), true);
    eq("curl -X DELETE instances", waIsDangerous("curl -X DELETE https://api/instances/i-1"), true);
    eq("gcloud compute instances stop", waIsDangerous("gcloud compute instances stop vm-1"), true);
    eq("remove-iam-policy-binding", waIsDangerous("gcloud x remove-iam-policy-binding y"), true);
    eq("read-only list is safe", waIsDangerous("gcloud compute instances list"), false);
    eq("plain echo is safe", waIsDangerous("echo hello"), false);
    eq("empty string is safe", waIsDangerous(""), false);
    eq("null coerces to safe", waIsDangerous(null as any), false);
  }

  console.log("waWorkstreamOf -- native field, then arguments, then [workstream:] token, then ''");
  {
    eq("native workstream field, trimmed", waWorkstreamOf({ workstream: "  ops/deploy  " }), "ops/deploy");
    eq("arguments.workstream fallback", waWorkstreamOf({ arguments: { workstream: "hunt" } }), "hunt");
    eq("token parsed from command text", waWorkstreamOf({ arguments: { command: "run #DESC [workstream: vrp/scan] go" } }), "vrp/scan");
    eq("token parsed from cmd alias", waWorkstreamOf({ arguments: { cmd: "[workstream: a.b_c-d/ e]" } }), "a.b_c-d/ e");
    eq("native field wins over token", waWorkstreamOf({ workstream: "win", arguments: { command: "[workstream: lose]" } }), "win");
    eq("unknown -> ''", waWorkstreamOf({ arguments: { command: "no marker here" } }), "");
    eq("empty object -> ''", waWorkstreamOf({}), "");
    eq("null -> '' (caught)", waWorkstreamOf(null), "");
  }

  console.log("waSafe -- passes through, and swallows a handler throw as a 500");
  {
    const h1 = waSafe(async (_req, res) => { res.status(200).json({ ok: true }); });
    const res1 = mkRes();
    await (h1 as any)(mkReq(), res1);
    eq("ok handler sets its own status", res1._status, 200);
    ok("ok handler sent its body", res1._json && res1._json.ok === true);

    const h2 = waSafe(async () => { throw new Error("boom"); });
    const res2 = mkRes();
    let threw = false;
    try { await (h2 as any)(mkReq(), res2); } catch (e) { threw = true; }
    ok("a throwing handler never rejects out of waSafe", !threw);
    eq("throw becomes a 500", res2._status, 500);
    ok("500 body is the generic message", !!res2._json && res2._json.error === "request failed",
       JSON.stringify(res2._json));

    const h3 = waSafe(async () => { throw new Error("late"); });
    const res3 = mkRes(); res3.headersSent = true;
    let threw3 = false;
    try { await (h3 as any)(mkReq(), res3); } catch (e) { threw3 = true; }
    ok("throw after headersSent is still swallowed", !threw3);
    eq("no second response is written once headersSent", res3._sent, false);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
