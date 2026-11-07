// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE chat/tool-wiring helpers (src/mods/chat-wire.ts). No cloud, no network,
// no secrets, no db: every function touches only its arguments, pure imported config consts and
// builtins. HAR_CHAT_EFFORT is frozen at module load from CHAT_EFFORT, so env is pinned to a known
// value BEFORE the dynamic import; the Claude transport defaults are likewise pinned.
process.env.PC_NO_LISTEN = "1";
process.env.CHAT_EFFORT = "medium";
for (const k of ["CHAT_CLAUDE_PROVIDER", "CHAT_GEMINI_PROVIDER", "CHAT_VERTEX_REGION",
  "VERTEX_LOCATION", "CHAT_VERTEX_CLAUDE_REGION", "CHAT_VERTEX_GEMINI_REGION"]) delete process.env[k];

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

const T = (name: string, schema: any = { type: "object", properties: {} }) =>
  ({ name, description: "desc:" + name, schema, run: async () => "" });

(async () => {
  const m: any = await import("../../src/mods/chat-wire.js");

  console.log("chr10 -- a single newline, nothing else");
  eq("chr10 is \\n", m.chr10(), "\n");

  console.log("harMcpResultText -- MCP CallToolResult content -> plain text");
  {
    eq("null -> (no result)", m.harMcpResultText(null), "(no result)");
    eq("undefined -> (no result)", m.harMcpResultText(undefined), "(no result)");
    eq("raw string passes through", m.harMcpResultText("hello"), "hello");
    eq("text blocks joined with newline",
      m.harMcpResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
    eq("non-text block is JSON.stringified",
      m.harMcpResultText({ content: [{ type: "image", data: "x" }] }), JSON.stringify({ type: "image", data: "x" }));
    eq("isError prefixes TOOL ERROR:",
      m.harMcpResultText({ isError: true, content: [{ type: "text", text: "boom" }] }), "TOOL ERROR: boom");
    eq("no content -> whole object JSON", m.harMcpResultText({ foo: 1 }), JSON.stringify({ foo: 1 }));
  }

  console.log("harClaudeToolWire -- {name, description, input_schema}, schema verbatim");
  {
    const sch = { type: "object", properties: { x: { type: "string" } } };
    const out = m.harClaudeToolWire([T("alpha", sch), T("beta")]);
    eq("one entry per tool", out.length, 2);
    eq("name carried", out[0].name, "alpha");
    eq("description carried", out[0].description, "desc:alpha");
    ok("input_schema is the SAME object (not reshaped)", out[0].input_schema === sch);
    eqJson("empty toolset -> []", m.harClaudeToolWire([]), []);
  }

  console.log("harDeepseekToolWire -- OpenAI function shape, schema as parameters verbatim");
  {
    const sch = { type: "object", properties: { q: { type: "string" } } };
    const out = m.harDeepseekToolWire([T("search", sch)]);
    eq("type is function", out[0].type, "function");
    eq("function.name carried", out[0].function.name, "search");
    eq("function.description carried", out[0].function.description, "desc:search");
    ok("parameters is the SAME schema object", out[0].function.parameters === sch);
    eqJson("empty toolset -> []", m.harDeepseekToolWire([]), []);
  }

  console.log("harGeminiToolWire -- functionDeclarations, parameters only for non-empty OBJECT");
  {
    const withProps = m.harGeminiToolWire([T("withp", { type: "object", properties: { a: { type: "string" } } })]);
    eq("one functionDeclarations wrapper", withProps.length, 1);
    const decl = withProps[0].functionDeclarations[0];
    eq("decl name carried", decl.name, "withp");
    eq("params present + OBJECT (reshaped by harGeminiSchema)", decl.parameters.type, "OBJECT");
    eq("property type mapped to STRING", decl.parameters.properties.a.type, "STRING");
    const noProps = m.harGeminiToolWire([T("nop", { type: "object", properties: {} })]);
    ok("empty-schema tool has NO parameters key", !("parameters" in noProps[0].functionDeclarations[0]));
    eqJson("empty toolset -> []", m.harGeminiToolWire([]), []);
  }

  console.log("harChatRemedy -- only 401/403/404/429 produce text, and it names the transport");
  {
    eq("200 -> empty", m.harChatRemedy({ transport: "vertex" }, 200), "");
    eq("null r -> empty", m.harChatRemedy(null, 403), "");
    const vertex403 = m.harChatRemedy({ transport: "vertex", region: "us-east5", alt_transport: "anthropic", alt_ready: true, alt_switch: "set CHAT_CLAUDE_PROVIDER=anthropic" }, 403);
    ok("vertex 403 names the transport used", vertex403.indexOf("transport=vertex") >= 0, vertex403);
    ok("vertex 403 names the ready alternative", vertex403.indexOf("IS ready") >= 0, vertex403);
    const direct401 = m.harChatRemedy({ transport: "anthropic", alt_transport: "vertex", alt_ready: false, alt_blocker: "x", alt_switch: "unset" }, 401);
    ok("alt not ready -> NOT usable either", direct401.indexOf("NOT usable either") >= 0, direct401);
  }

  console.log("harChatResolved -- deepseek is fully deterministic; claude carries HAR_CHAT_EFFORT");
  {
    const ds = m.harChatResolved("deepseek", "sk-xyz");
    eq("deepseek provider", ds.provider, "deepseek");
    eq("deepseek host", ds.host, "api.deepseek.com");
    eq("deepseek transport direct", ds.transport, "direct");
    eq("deepseek key_present true", ds.key_present, true);
    const dsNoKey = m.harChatResolved("deepseek", "");
    eq("deepseek no key -> key_present false", dsNoKey.key_present, false);
    ok("deepseek no key names the blocker", String(dsNoKey.alt_blocker).indexOf("DeepSeek") >= 0);
    const cl = m.harChatResolved("claude", "");
    eq("claude provider", cl.provider, "claude");
    eq("claude effort wired from shared HAR_CHAT_EFFORT", cl.effort, "medium");
    eq("claude transport defaults to vertex", cl.transport, "vertex");
  }

  console.log("harChatNoTextReport -- turn with tool calls, exhaustion and stop reason");
  {
    const r = m.harChatNoTextReport(["ran X: ok", "ran Y: ok"], "MAX_TOKENS", true, 16);
    ok("counts the tool calls", r.indexOf("ran 2 tool call(s)") >= 0, r);
    ok("lists each trace line", r.indexOf("- ran X: ok") >= 0 && r.indexOf("- ran Y: ok") >= 0, r);
    ok("mentions the round limit when exhausted", r.indexOf("16-round tool limit") >= 0, r);
    ok("MAX_TOKENS explained", r.indexOf("truncated by the output token limit") >= 0, r);
    const empty = m.harChatNoTextReport([], "end_turn", false, 8);
    ok("no tools + no text branch", empty.indexOf("no text and called no tools") >= 0, empty);
    ok("benign end_turn adds no stop-reason line", empty.indexOf("stop reason:") < 0, empty);
  }

  console.log("harLogResolved -- pure logging, returns void and does not throw");
  {
    const orig = console.log; let captured = "";
    console.log = (...a: any[]) => { captured += a.join(" "); };
    try {
      const rv = m.harLogResolved("test-site", { provider: "claude", transport: "vertex", region: "us-east5", host: "h", model: "claude-opus-5", effort: "medium", key_present: true, alt_transport: "anthropic", alt_ready: false });
      eq("returns undefined (void)", rv, undefined);
    } finally { console.log = orig; }
    ok("logged the resolve line with the provider", captured.indexOf("[chat/resolve] test-site") >= 0 && captured.indexOf("provider=claude") >= 0, captured);
  }

  console.log("harStrainSystem -- a per-strain system prompt built from the agent id and the laws");
  {
    const s = m.harStrainSystem("fleet-bughunters");
    ok("is a non-trivial string", typeof s === "string" && s.length > 500);
    ok("addresses the strain by id", s.indexOf("You are fleet-bughunters") >= 0);
    ok("mentions the strain's single lane", s.toLowerCase().indexOf("one lane") >= 0, s.slice(0, 200));
    ok("differs per agent id", s !== m.harStrainSystem("fleet-advisor"));
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
