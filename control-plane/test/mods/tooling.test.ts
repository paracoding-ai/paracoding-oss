// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-TOOLING-V1] Unit tests for mods/tooling.ts -- the tool-class policy
// (annotations + refusal stub) and the tool-output cap / lake-bound helpers. All pure:
// no cloud, no network, no server boot.
process.env.PC_NO_LISTEN = "1";
import * as crypto from "crypto";
import {
  pcToolAnnotations, pcRefusalTool,
  pcCapArgNames, pcCapNote, pcCapResult, pcCapWrap,
  pcLakeReadRefusal, pcPutFileDecode, harCompactToolOut,
  PC_TOOL_CLASS,
} from "../../src/mods/tooling.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}

(async () => {
  // ---- pcToolAnnotations ----
  ok("ann: unclassified -> undefined", pcToolAnnotations("no_such_tool_xyz") === undefined);
  const r = pcToolAnnotations("git_read"); // class read
  ok("ann: read readOnlyHint", !!r && r.readOnlyHint === true && r.destructiveHint === false,
    JSON.stringify(r));
  const w = pcToolAnnotations("delete_entities"); // write + destructive
  ok("ann: destructive write", !!w && w.readOnlyHint === false && w.destructiveHint === true,
    JSON.stringify(w));
  const wn = pcToolAnnotations("post_work_item"); // write but nocard
  ok("ann: nocard write -> readOnlyHint", !!wn && wn.readOnlyHint === true && wn.destructiveHint === false,
    JSON.stringify(wn));
  const st = pcToolAnnotations("run_command"); // stage
  ok("ann: stage destructive+openWorld", !!st && st.readOnlyHint === false && st.destructiveHint === true && st.openWorldHint === true,
    JSON.stringify(st));
  ok("PC_TOOL_CLASS exported & populated", PC_TOOL_CLASS && PC_TOOL_CLASS.git_read === "read" && PC_TOOL_CLASS.put_file === "write");

  // ---- pcRefusalTool ----
  const handler = pcRefusalTool("write_file", "write", "you cannot write", ["read"]);
  ok("refusal: returns a function", typeof handler === "function");
  const out = await handler();
  ok("refusal: isError true", out && out.isError === true);
  const rt = out.content[0].text;
  ok("refusal: text names tool/class/held",
    rt.indexOf("REFUSED") >= 0 && rt.indexOf("write_file") >= 0 && rt.indexOf("`write`") >= 0 && rt.indexOf("read") >= 0,
    rt.slice(0, 120));
  const h2 = await pcRefusalTool("x", "stage", "why", [])();
  ok("refusal: empty held -> (none)", h2.content[0].text.indexOf("(none)") >= 0);

  // ---- pcCapArgNames ----
  ok("argnames: strips agent", JSON.stringify(pcCapArgNames({ inputSchema: { a: 1, agent: 1, b: 1 } })) === JSON.stringify(["a", "b"]));
  ok("argnames: no schema -> []", JSON.stringify(pcCapArgNames({})) === "[]");
  ok("argnames: null spec -> []", JSON.stringify(pcCapArgNames(null)) === "[]");

  // ---- pcCapNote ----
  const note = pcCapNote("git_grep", ["pattern", "limit"], 100, 400, false);
  ok("capnote: names tool", note.indexOf("tool: git_grep") >= 0);
  ok("capnote: shows shown/total", note.indexOf("100 of 400") >= 0);
  ok("capnote: head says PREFIX", note.indexOf("THIS IS A PREFIX") >= 0);
  const noteTail = pcCapNote("read_history", [], 100, 400, true);
  ok("capnote: tail says END", noteTail.indexOf("THIS IS THE END OF THE RESULT") >= 0);
  ok("capnote: no args advice", noteTail.indexOf("takes no narrowing arguments") >= 0);

  // ---- pcCapResult ----
  ok("capresult: non-object passthrough", pcCapResult("t", [], "plain") === "plain");
  const small = { content: [{ type: "text", text: "tiny" }] };
  ok("capresult: small unchanged", pcCapResult("list_files", [], small) === small);
  const bigText = "A".repeat(60000);
  const bigOut = { content: [{ type: "text", text: bigText }] };
  const capped = pcCapResult("list_files", ["path"], bigOut); // head cut (not in TAIL set)
  const ctext = capped.content[0].text;
  ok("capresult: head cut shorter", ctext.length < bigText.length, "len=" + ctext.length);
  ok("capresult: head cut keeps head", ctext.slice(0, 10) === "AAAAAAAAAA");
  ok("capresult: head cut has marker", ctext.indexOf("TRUNCATED") >= 0 && ctext.indexOf("[MCP-RESULT-CAP-V1]") >= 0);
  const cappedTail = pcCapResult("read_history", [], { content: [{ type: "text", text: bigText }] });
  const ttext = cappedTail.content[0].text;
  ok("capresult: tail cut keeps tail", ttext.slice(-10) === "AAAAAAAAAA");
  ok("capresult: tail cut has END marker", ttext.indexOf("THIS IS THE END OF THE RESULT") >= 0);

  // ---- pcCapWrap ----
  const identity = async (x: any) => x;
  ok("capwrap: exempt returns handler", pcCapWrap("git_read", {}, identity) === identity);
  ok("capwrap: exempt read_file", pcCapWrap("read_file", {}, identity) === identity);
  const wrapped = pcCapWrap("list_files", { inputSchema: { path: 1 } }, async () => ({ content: [{ type: "text", text: "B".repeat(60000) }] }));
  ok("capwrap: non-exempt returns new fn", typeof wrapped === "function" && wrapped !== identity);
  const wres = await wrapped({});
  ok("capwrap: result compacted", wres.content[0].text.length < 60000, "len=" + wres.content[0].text.length);

  // ---- harCompactToolOut ----
  ok("compact: short unchanged", harCompactToolOut("x", "hello") === "hello");
  const longS = "C".repeat(20000);
  const comp = harCompactToolOut("some_tool", longS); // default cap 6000
  ok("compact: default cap shrinks", comp.length < longS.length && comp.length < 7000, "len=" + comp.length);
  ok("compact: elided marker + head+tail", comp.indexOf("chars elided") >= 0 && comp.slice(0, 5) === "CCCCC" && comp.slice(-5) === "CCCCC");
  ok("compact: exempt set passthrough", harCompactToolOut("gitx", longS, new Set(["gitx"])) === longS);
  const gitComp = harCompactToolOut("git_read", "D".repeat(40000)); // git_read base cap 35000
  ok("compact: git_read 35k cap", gitComp.length > 30000 && gitComp.length <= 35000 + 200, "len=" + gitComp.length);
  const ovr = harCompactToolOut("some_tool", "E".repeat(50000), undefined, 45000); // capOverride
  ok("compact: capOverride applied", ovr.length > 7000 && ovr.length <= 45000 + 200, "len=" + ovr.length);

  // ---- pcLakeReadRefusal ----
  ok("lakeread: under bound -> null", pcLakeReadRefusal("x/y.txt", 1000) === null);
  const refusal = pcLakeReadRefusal("lake/big.json", 200000);
  ok("lakeread: over bound -> refusal", typeof refusal === "string" && refusal!.indexOf("FILE_TOO_LARGE") >= 0 && refusal!.indexOf("lake/big.json") >= 0 && refusal!.indexOf("200000") >= 0);

  // ---- pcPutFileDecode ----
  const payload = Buffer.from("hello lake world");
  const b64 = payload.toString("base64");
  const good = pcPutFileDecode(b64, undefined);
  ok("putdecode: valid -> buf", !!good.buf && good.buf!.equals(payload) && !good.err);
  const sha = crypto.createHash("sha256").update(payload).digest("hex");
  const goodSha = pcPutFileDecode(b64, sha);
  ok("putdecode: correct sha -> buf", !!goodSha.buf && !goodSha.err);
  const badSha = pcPutFileDecode(b64, sha.replace(/.$/, sha.endsWith("a") ? "b" : "a"));
  ok("putdecode: sha mismatch", !!badSha.err && badSha.err!.indexOf("SHA256_MISMATCH") >= 0);
  const badShaFmt = pcPutFileDecode(b64, "not-hex");
  ok("putdecode: bad sha format", !!badShaFmt.err && badShaFmt.err!.indexOf("BAD_SHA256") >= 0);
  const badB64 = pcPutFileDecode("@@@@not base64@@@@", undefined);
  ok("putdecode: bad base64", !!badB64.err && badB64.err!.indexOf("BAD_BASE64") >= 0);
  const bigB64 = Buffer.alloc(40001, 65).toString("base64");
  const tooBig = pcPutFileDecode(bigB64, undefined);
  ok("putdecode: payload too large", !!tooBig.err && tooBig.err!.indexOf("PAYLOAD_TOO_LARGE") >= 0);

  console.log((fail === 0 ? "OK" : fail + " FAIL") + " -- " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
