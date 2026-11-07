// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-SECRETS-KEYS-V1] Unit tests for mods/secrets-keys.ts -- the Secret Manager
// REST surface (read + allowlisted write) and the chat-provider key helpers. No cloud, no
// network, no server boot.
//
// shared.ts captures `waFetch = globalThis.fetch` at MODULE LOAD, so the fetch stub MUST be
// installed BEFORE the module (and shared.ts) is imported -- hence the dynamic import() below,
// after the stub is in place. Pure fns (harKeyName/pcGhSecretName/pcSecretWriteRefusal) are
// driven directly; the REST fns are driven through the stubbed fetch returning canned JSON and
// we assert the PARSING and the allowlist/refusal behaviour.
process.env.PC_NO_LISTEN = "1";
process.env.GCP_PROJECT = process.env.GCP_PROJECT || "test-proj";
// A clean key environment so harKey's env-shortcut is tested deliberately, not by accident.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ANTHROPIC_ADMIN_KEY;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// --- mutable controls the stub reads before each call ---
let secretAccess: { status: number; value?: string; malformed?: boolean } = { status: 200, value: "the-secret" };
let createStatus = 409;      // 409 = already-exists (ignored)
let addVersionStatus = 200;  // 200 = write ok
let keysBody: any = { data: [{ id: "key_1", workspace_key_prefix: "sk-ant-pfx" }] };
const calls: { url: string; method: string }[] = [];

function resp(body: any, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

(globalThis as any).fetch = async (u: string, init?: any): Promise<any> => {
  const url = String(u);
  const method = String((init && init.method) || "GET").toUpperCase();
  calls.push({ url, method });
  if (url.indexOf("/instance/service-accounts/default/token") >= 0) return resp({ access_token: "test-token" });
  // Secret Manager read: .../secrets/<name>/versions/latest:access
  if (url.indexOf("secretmanager.googleapis.com") >= 0 && url.indexOf(":access") >= 0) {
    if (secretAccess.status !== 200) return resp({ error: { message: "denied" } }, secretAccess.status);
    if (secretAccess.malformed) return resp({ nope: true }, 200);
    return resp({ payload: { data: b64(secretAccess.value || "") } }, 200);
  }
  // Secret Manager create: POST .../secrets?secretId=<name>
  if (url.indexOf("secretmanager.googleapis.com") >= 0 && url.indexOf("secretId=") >= 0) {
    return resp(createStatus === 409 ? { error: { message: "exists" } } : {}, createStatus);
  }
  // Secret Manager addVersion: POST .../secrets/<name>:addVersion
  if (url.indexOf("secretmanager.googleapis.com") >= 0 && url.indexOf(":addVersion") >= 0) {
    return resp(addVersionStatus === 200 ? {} : { error: { message: "boom" } }, addVersionStatus);
  }
  // Anthropic admin: list keys / disable
  if (url.indexOf("api.anthropic.com/v1/organizations/keys") >= 0 && url.indexOf("/disable") >= 0) return resp({}, 200);
  if (url.indexOf("api.anthropic.com/v1/organizations/keys") >= 0) return resp(keysBody, 200);
  return resp({}, 200);
};

(async () => {
  const m: any = await import("../../src/mods/secrets-keys.js");

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
  }

  // ---- harKeyName (pure) ----
  eq("harKeyName gemini", m.harKeyName("gemini"), "chat-key-gemini");
  eq("harKeyName deepseek", m.harKeyName("deepseek"), "chat-key-deepseek");
  eq("harKeyName claude", m.harKeyName("claude"), "chat-key-claude");
  eq("harKeyName unknown -> claude default", m.harKeyName("whatever"), "chat-key-claude");

  // ---- pcGhSecretName (pure) ----
  eq("pcGhSecretName default prefix", m.pcGhSecretName("default"), "github-token-default");

  // ---- pcSecretWriteRefusal (allowlist, pure) ----
  eq("refusal: chat-key-claude allowed", m.pcSecretWriteRefusal("chat-key-claude"), null);
  eq("refusal: chat-key-gemini allowed", m.pcSecretWriteRefusal("chat-key-gemini"), null);
  eq("refusal: chat-key-deepseek allowed", m.pcSecretWriteRefusal("chat-key-deepseek"), null);
  eq("refusal: github-token-<slug> allowed", m.pcSecretWriteRefusal("github-token-default"), null);
  ok("refusal: path-traversal slug refused", m.pcSecretWriteRefusal("github-token-../chat-key-claude") !== null);
  ok("refusal: arbitrary name refused", typeof m.pcSecretWriteRefusal("data-lake-key") === "string"
     && m.pcSecretWriteRefusal("data-lake-key").indexOf("REFUSED") === 0);
  ok("refusal: near-miss chat key refused", m.pcSecretWriteRefusal("chat-key-evil") !== null);

  // ---- harSecretGet (REST read) ----
  secretAccess = { status: 200, value: "hunter2" };
  eq("harSecretGet 200 -> decoded payload", await m.harSecretGet("chat-key-claude"), "hunter2");
  secretAccess = { status: 403 };
  eq("harSecretGet 403 -> null (not absent)", await m.harSecretGet("chat-key-claude"), null);
  secretAccess = { status: 404 };
  eq("harSecretGet 404 -> null", await m.harSecretGet("chat-key-claude"), null);
  secretAccess = { status: 200, malformed: true };
  eq("harSecretGet 200 malformed payload -> null", await m.harSecretGet("chat-key-claude"), null);

  // ---- harKey (env shortcut, SM fallback, vertex/empty defaults) ----
  process.env.ANTHROPIC_API_KEY = "env-claude";
  eq("harKey claude uses env first", await m.harKey("claude"), "env-claude");
  delete process.env.ANTHROPIC_API_KEY;
  secretAccess = { status: 200, value: "sm-gemini" };
  eq("harKey gemini falls back to Secret Manager", await m.harKey("gemini"), "sm-gemini");
  secretAccess = { status: 404 };
  eq("harKey gemini with no key -> 'vertex'", await m.harKey("gemini"), "vertex");
  eq("harKey deepseek with no key -> '' (no vertex fallback)", await m.harKey("deepseek"), "");

  // ---- harSecretSetX (allowlist-gated REST write) ----
  calls.length = 0;
  const refused = await m.harSecretSetX("data-lake-key", "x");
  ok("harSecretSetX refuses off-allowlist name", refused.ok === false && String(refused.detail).indexOf("REFUSED") === 0);
  ok("harSecretSetX refusal sends NOTHING to the network",
     calls.filter((c) => c.url.indexOf("secretmanager") >= 0).length === 0);

  createStatus = 409; addVersionStatus = 200;
  const wrote = await m.harSecretSetX("chat-key-claude", "newkey");
  ok("harSecretSetX writes allowed name -> ok:true", wrote.ok === true, JSON.stringify(wrote));

  createStatus = 409; addVersionStatus = 500;
  const failed = await m.harSecretSetX("chat-key-claude", "newkey");
  ok("harSecretSetX surfaces the HTTP status on failure",
     failed.ok === false && String(failed.detail).indexOf("HTTP 500") >= 0, JSON.stringify(failed));

  // ---- harSecretSet (bare boolean facade) ----
  createStatus = 409; addVersionStatus = 200;
  eq("harSecretSet true on success", await m.harSecretSet("chat-key-claude", "k"), true);
  eq("harSecretSet false on refusal", await m.harSecretSet("data-lake-key", "k"), false);

  // ---- disableOldClaudeKey ----
  secretAccess = { status: 404 };
  delete process.env.ANTHROPIC_ADMIN_KEY;
  calls.length = 0;
  await m.disableOldClaudeKey("sk-ant-old");
  ok("disableOldClaudeKey no-ops without an admin key",
     calls.filter((c) => c.url.indexOf("api.anthropic.com") >= 0).length === 0);

  process.env.ANTHROPIC_ADMIN_KEY = "admin-key";
  keysBody = { data: [{ id: "key_1", workspace_key_prefix: "sk-ant-old" }] };
  calls.length = 0;
  await m.disableOldClaudeKey("sk-ant-old-and-more");
  ok("disableOldClaudeKey disables the matched key",
     calls.some((c) => c.method === "POST" && c.url.indexOf("/disable") >= 0));
  delete process.env.ANTHROPIC_ADMIN_KEY;

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
