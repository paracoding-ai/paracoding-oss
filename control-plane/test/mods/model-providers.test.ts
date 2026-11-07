// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure model/provider/config helpers (src/mods/model-providers.ts). No cloud,
// no network, no secrets, no db: every function touches only its arguments, module-level pure
// config consts, process.env and builtins. Several consts (HAR_GEMINI_*, HAR_MODELS_DEFAULT) are
// frozen at module load from env, so the env is pinned to known values BEFORE a dynamic import.
process.env.PC_NO_LISTEN = "1";
for (const k of ["CHAT_GEMINI_THINKING", "CHAT_MODELS", "CHAT_GEMINI_SAFETY",
  "CHAT_API_OPUS", "CHAT_API_SONNET", "CHAT_API_GFLASH", "CHAT_API_GPRO", "CHAT_API_DEEPSEEK",
  "CHAT_VERTEX_REGION", "VERTEX_LOCATION", "CHAT_VERTEX_GEMINI_REGION", "CHAT_GEMINI_PROVIDER",
  "CHAT_CLAUDE_PROVIDER"]) delete process.env[k];
process.env.CHAT_MAX_TOKENS_GEMINI = "65536";
process.env.CHAT_GEMINI4_THINKING = "high";
process.env.CHAT_GEMINI_THOUGHTS = "1";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.error("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function eqJson(label: string, got: any, want: any) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
function withEnv(kv: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(kv)) { saved[k] = process.env[k]; if (kv[k] === undefined) delete process.env[k]; else process.env[k] = kv[k] as string; }
  try { fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] as string; } }
}

(async () => {
  const m: any = await import("../../src/mods/model-providers.js");

  console.log("harOpus5 -- floors stale opus-3 / opus-4 / opus-4-1 to claude-opus-5, passes the rest");
  {
    eq("empty -> claude-opus-5", m.harOpus5(""), "claude-opus-5");
    eq("null coerces -> claude-opus-5", m.harOpus5(null as any), "claude-opus-5");
    eq("opus-3 family floored", m.harOpus5("claude-opus-3-5"), "claude-opus-5");
    eq("bare opus-4 floored", m.harOpus5("claude-opus-4"), "claude-opus-5");
    eq("opus-4-1 floored", m.harOpus5("claude-opus-4-1"), "claude-opus-5");
    eq("opus-4-1 with @version floored", m.harOpus5("claude-opus-4-1@20250101"), "claude-opus-5");
    eq("opus-4-8 is NOT floored (newer)", m.harOpus5("claude-opus-4-8"), "claude-opus-4-8");
    eq("opus-5 passes through", m.harOpus5("claude-opus-5"), "claude-opus-5");
    eq("sonnet passes through", m.harOpus5("claude-sonnet-5"), "claude-sonnet-5");
  }

  console.log("harModelEntry / harModelList -- catalog entries, dedup, floor fallback");
  {
    eqJson("entry carries id/label/sub/api, opus floored",
      m.harModelEntry("claude-opus-4"), { id: "claude-opus-5", label: "Opus 5", sub: "", api: "claude-opus-5" });
    const list = m.harModelList(["claude-opus-5", "claude-opus-5", "claude-sonnet-5"], "claude-opus-5");
    eq("duplicate id dropped (2 entries)", list.length, 2);
    eq("first entry id", list[0].id, "claude-opus-5");
    eq("second entry id", list[1].id, "claude-sonnet-5");
    const empty = m.harModelList([], "claude-opus-5");
    eq("empty input -> one floor entry", empty.length, 1);
    eq("floor entry id", empty[0].id, "claude-opus-5");
    const blanks = m.harModelList(["", "  "], "claude-sonnet-5");
    eq("all-blank input -> floor entry", blanks[0].id, "claude-sonnet-5");
  }

  console.log("harModels / harApiFor -- default catalog + id->api resolution");
  {
    const cat = m.harModels();
    ok("default catalog has claude/gemini/ge/deepseek", !!(cat.claude && cat.gemini && cat.ge && cat.deepseek));
    eq("ge seat is one flat-rate entry", cat.ge.length, 1);
    eq("ge api", cat.ge[0].api, "gemini-enterprise");
    eq("claude m[0] is opus-5 with nothing configured", cat.claude[0].api, "claude-opus-5");
    eq("harApiFor claude known id floors through harOpus5", m.harApiFor("claude", "claude-opus-4"), "claude-opus-5");
    eq("harApiFor unknown claude id -> m[0].api", m.harApiFor("claude", "nope"), "claude-opus-5");
    eq("harApiFor gemini returns api verbatim (no opus floor)", m.harApiFor("gemini", "gemini-3.8-flash"), "gemini-3.8-flash");
    eq("harApiFor unknown provider -> empty", m.harApiFor("mystery", "x"), "");
    withEnv({ CHAT_MODELS: JSON.stringify({ claude: [{ id: "x", api: "api-x" }] }) }, () => {
      eq("CHAT_MODELS override is parsed", m.harModels().claude[0].api, "api-x");
    });
    withEnv({ CHAT_MODELS: "{not json" }, () => {
      ok("invalid CHAT_MODELS falls back to default", !!m.harModels().gemini);
    });
  }

  console.log("harVertexHost / harVertexProject -- host + project resolution");
  {
    eq("global -> bare host", m.harVertexHost("global"), "aiplatform.googleapis.com");
    eq("region -> regional host", m.harVertexHost("us-east5"), "us-east5-aiplatform.googleapis.com");
    withEnv({ GCP_PROJECT: "proj-a", GOOGLE_CLOUD_PROJECT: undefined }, () => {
      eq("GCP_PROJECT wins", m.harVertexProject(), "proj-a");
    });
    withEnv({ GCP_PROJECT: undefined, GOOGLE_CLOUD_PROJECT: "proj-b" }, () => {
      eq("GOOGLE_CLOUD_PROJECT fallback", m.harVertexProject(), "proj-b");
    });
  }

  console.log("harClaudeGlobalOnly / harGeminiGlobalOnly -- which models are global-endpoint only");
  {
    ok("opus-5 is global-only", m.harClaudeGlobalOnly("claude-opus-5") === true);
    ok("opus-4-8 is global-only", m.harClaudeGlobalOnly("claude-opus-4-8") === true);
    ok("bare opus-4 is NOT global-only", m.harClaudeGlobalOnly("claude-opus-4") === false);
    ok("sonnet is NOT global-only", m.harClaudeGlobalOnly("claude-sonnet-5") === false);
    ok("gemini-3 is global-only", m.harGeminiGlobalOnly("gemini-3.8-flash") === true);
    ok("gemini-4 is global-only", m.harGeminiGlobalOnly("gemini-4-argon") === true);
    ok("a -preview model is global-only", m.harGeminiGlobalOnly("gemini-1.5-pro-preview") === true);
    ok("gemini-2.0 plain is NOT global-only", m.harGeminiGlobalOnly("gemini-2.0") === false);
  }

  console.log("harVertexClaudeRegion / harVertexGeminiRegion -- region with safe global fallback");
  {
    withEnv({ CHAT_VERTEX_REGION: undefined, VERTEX_LOCATION: undefined }, () => {
      eq("claude default region us-east5", m.harVertexClaudeRegion(), "us-east5");
      eq("claude default region ignores non-global-only model", m.harVertexClaudeRegion("claude-sonnet-5"), "us-east5");
    });
    withEnv({ CHAT_VERTEX_REGION: "us-east5" }, () => {
      eq("regional config forced to global for a global-only model", m.harVertexClaudeRegion("claude-opus-5"), "global");
    });
    withEnv({ CHAT_VERTEX_GEMINI_REGION: undefined }, () => {
      eq("gemini default region is global", m.harVertexGeminiRegion("gemini-3.8-flash"), "global");
    });
    withEnv({ CHAT_VERTEX_GEMINI_REGION: "us-central1" }, () => {
      eq("gemini regional config forced to global for global-only model", m.harVertexGeminiRegion("gemini-4-argon"), "global");
      eq("gemini regional config kept for a non-global-only model", m.harVertexGeminiRegion("gemini-2.0"), "us-central1");
    });
  }

  console.log("harGeminiTransport / harClaudeProvider -- transport selection (vertex is the default)");
  {
    withEnv({ CHAT_GEMINI_PROVIDER: undefined }, () => {
      eq("no provider env -> vertex", m.harGeminiTransport("some-real-key"), "vertex");
    });
    withEnv({ CHAT_GEMINI_PROVIDER: "studio" }, () => {
      eq("studio + real key -> studio", m.harGeminiTransport("real-key"), "studio");
      eq("studio but key='vertex' is not real -> vertex", m.harGeminiTransport("vertex"), "vertex");
      eq("studio but empty key -> vertex", m.harGeminiTransport(""), "vertex");
    });
    withEnv({ CHAT_CLAUDE_PROVIDER: undefined }, () => {
      eq("no claude provider env -> vertex", m.harClaudeProvider(), "vertex");
    });
    withEnv({ CHAT_CLAUDE_PROVIDER: "anthropic" }, () => {
      eq("anthropic opt-in -> anthropic", m.harClaudeProvider(), "anthropic");
    });
    withEnv({ CHAT_CLAUDE_PROVIDER: "direct" }, () => {
      eq("direct alias -> anthropic", m.harClaudeProvider(), "anthropic");
    });
  }

  console.log("harClaudeHostDesc -- host line carries region only for vertex");
  {
    eq("vertex -> host+region", m.harClaudeHostDesc({ transport: "vertex", host: "h", region: "r" }), "host=h region=r");
    eq("non-vertex -> host only", m.harClaudeHostDesc({ transport: "anthropic", host: "api.anthropic.com" }), "host=api.anthropic.com");
  }

  console.log("harGeminiThinkingFor / harGeminiGenConfig -- thinking level + generationConfig");
  {
    eq("gemini-4 default thinking = high", m.harGeminiThinkingFor("gemini-4-argon"), "high");
    eq("non-gemini-4 default thinking = ''", m.harGeminiThinkingFor("gemini-3.8-flash"), "");
    const g4 = m.harGeminiGenConfig("gemini-4-argon");
    eq("maxOutputTokens from HAR_GEMINI_MAX_TOKENS", g4.maxOutputTokens, 65536);
    eqJson("gemini-4 adds thinkingConfig high + includeThoughts", g4.thinkingConfig, { thinkingLevel: "high", includeThoughts: true });
    const gflash = m.harGeminiGenConfig("gemini-3.8-flash");
    ok("gemini-3.8-flash gets no thinkingConfig by default", typeof gflash.thinkingConfig === "undefined");
    const gexp = m.harGeminiGenConfig("gemini-3.8-flash", "low");
    eq("explicit valid thinking wins for a gemini-3 model", gexp.thinkingConfig.thinkingLevel, "low");
    const gbad = m.harGeminiGenConfig("gemini-3.8-flash", "bogus");
    ok("invalid explicit thinking ignored (falls back to '')", typeof gbad.thinkingConfig === "undefined");
  }

  console.log("harGeminiRoute -- short greetings route low, everything else ''");
  {
    eq("'hi' -> low", m.harGeminiRoute("hi"), "low");
    eq("'thanks' -> low", m.harGeminiRoute("thanks"), "low");
    eq("'status?' -> low", m.harGeminiRoute("status?"), "low");
    eq("a real question -> ''", m.harGeminiRoute("explain the vertex region fallback please"), "");
    eq("empty -> ''", m.harGeminiRoute(""), "");
    eq("'hithere...' long greeting-ish over 80 chars -> ''", m.harGeminiRoute("hello " + "x".repeat(90)), "");
  }

  console.log("harGeminiSafety / harGeminiBlockMsg -- safety settings + block explainer");
  {
    const s = m.harGeminiSafety();
    eq("five categories", s.length, 5);
    ok("every threshold is OFF", s.every((x: any) => x.threshold === "OFF"));
    ok("harassment category present", s.some((x: any) => x.category === "HARM_CATEGORY_HARASSMENT"));
    const msg = m.harGeminiBlockMsg("SAFETY");
    ok("block msg names the blockReason", msg.indexOf("blockReason=SAFETY") >= 0);
    ok("block msg is a non-empty explainer", msg.length > 50);
  }

  console.log("harGeminiSchema -- JSON Schema -> Gemini schema (type map, $ref, anyOf-null, nesting)");
  {
    eqJson("string -> STRING", m.harGeminiSchema({ type: "string" }, {}, 0), { type: "STRING" });
    eqJson("integer -> INTEGER", m.harGeminiSchema({ type: "integer" }, {}, 0), { type: "INTEGER" });
    eqJson("non-object node -> STRING", m.harGeminiSchema(null, {}, 0), { type: "STRING" });
    eqJson("depth cap -> STRING", m.harGeminiSchema({ type: "object", properties: { a: { type: "string" } } }, {}, 9), { type: "STRING" });
    const obj = m.harGeminiSchema(
      { type: "object", properties: { name: { type: "string", description: "n" }, n: { type: "integer" } }, required: ["name", "ghost"] }, {}, 0);
    eq("object -> OBJECT", obj.type, "OBJECT");
    eq("property type mapped", obj.properties.name.type, "STRING");
    eq("property description kept", obj.properties.name.description, "n");
    eqJson("required filtered to known props", obj.required, ["name"]);
    const arr = m.harGeminiSchema({ type: "array", items: { type: "string" } }, {}, 0);
    eq("array -> ARRAY", arr.type, "ARRAY");
    eq("array items mapped", arr.items.type, "STRING");
    const nul = m.harGeminiSchema({ anyOf: [{ type: "string" }, { type: "null" }] }, {}, 0);
    eq("anyOf string|null -> STRING", nul.type, "STRING");
    ok("anyOf with null marks nullable", nul.nullable === true);
    const root = { $defs: { Foo: { type: "integer" } } };
    const ref = m.harGeminiSchema({ $ref: "#/$defs/Foo" }, root, 0);
    eq("$ref resolved to INTEGER", ref.type, "INTEGER");
    eqJson("broken $ref -> STRING", m.harGeminiSchema({ $ref: "#/$defs/Missing" }, root, 0), { type: "STRING" });
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
