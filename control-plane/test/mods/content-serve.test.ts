// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-CONTENT-SERVE-V1] Unit tests for mods/content-serve.ts -- the pure render/format
// helpers extracted from the /wiki renderer and the /lakeview viewer. All pure: no cloud, no
// network, no server boot.
process.env.PC_NO_LISTEN = "1";
import {
  wikiParseFront, wikiNotice, lvHasControlChar, lvIsText,
} from "../../src/mods/content-serve.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

void (async () => {

console.log("wikiParseFront -- front-matter parsing");
{
  // must open with the exact `---\n` delimiter
  eq("missing leading delimiter -> null", wikiParseFront("page: x\n") as any, null);
  eq("no closing delimiter -> null", wikiParseFront("---\npage: x\n") as any, null);

  const r = wikiParseFront("---\npage: index\ntitle: Hello\n---\n# body\ntext\n");
  ok("parses a valid doc", !!r);
  eq("scalar key: page", r!.fm.page, "index");
  eq("scalar key: title", r!.fm.title, "Hello");
  eq("body is everything after the closing delimiter", r!.body, "# body\ntext\n");

  // list values: `key:` then two-space `- item` lines
  const l = wikiParseFront("---\npage: p\nwatch:\n  - git:ref:path@" + "a".repeat(40) + "\n  - lake:x@" + "b".repeat(64) + "\n---\nB");
  ok("watch parses as an array", Array.isArray(l!.fm.watch));
  eq("watch length", l!.fm.watch.length, 2);
  eq("watch[1] stripped of quotes/space", l!.fm.watch[1], "lake:x@" + "b".repeat(64));

  // quoted list items are unquoted
  const q = wikiParseFront("---\nk:\n  - \"quoted\"\n  - 'single'\n---\nB");
  eq("double-quoted item unquoted", q!.fm.k[0], "quoted");
  eq("single-quoted item unquoted", q!.fm.k[1], "single");

  // empty scalar -> empty array
  const e = wikiParseFront("---\nwatch:\n---\nB");
  ok("bare `key:` -> []", Array.isArray(e!.fm.watch) && e!.fm.watch.length === 0);

  // a dash item before any key is malformed
  eq("list item before any key -> null", wikiParseFront("---\n  - orphan\n---\nB") as any, null);
  // an unparseable non-kv, non-list line -> null
  eq("garbage line -> null", wikiParseFront("---\nnot a kv line\n---\nB") as any, null);
  // comment and blank lines inside front-matter are skipped
  const c = wikiParseFront("---\n# a comment\n\npage: z\n---\nB");
  eq("comments/blanks skipped", c!.fm.page, "z");
}

console.log("wikiNotice -- module-constant notice page");
{
  function fakeRes() {
    const r: any = { _status: 0, _body: "" };
    r.status = (s: number) => { r._status = s; return r; };
    r.send = (b: string) => { r._body = b; return r; };
    return r;
  }
  const res = fakeRes();
  wikiNotice(res as any, 404, "No such page", "<p>gone</p>");
  eq("status is forwarded", res._status, 404);
  ok("doctype present", res._body.indexOf("<!doctype html>") === 0);
  ok("heading used in <title>", res._body.indexOf("<title>No such page</title>") >= 0);
  ok("heading used in <h1>", res._body.indexOf("<h1>No such page</h1>") >= 0);
  ok("body is interpolated", res._body.indexOf("<p>gone</p>") >= 0);
  ok("CSS rode along with the function", res._body.indexOf("background:#0f0a1e") >= 0);
  ok("the standing hint is appended", res._body.indexOf("Served by the control plane") >= 0);

  const res2 = fakeRes();
  wikiNotice(res2 as any, 200, "The wiki is empty", "x");
  eq("different status forwarded", res2._status, 200);
}

console.log("lvHasControlChar -- byte guard");
{
  ok("plain name is clean", lvHasControlChar("shared/wiki/index.md") === false);
  ok("NUL is a control char", lvHasControlChar("a\x00b") === true);
  ok("newline is a control char", lvHasControlChar("a\nb") === true);
  ok("DEL (127) is flagged", lvHasControlChar("a\x7fb") === true);
  ok("backslash (92) is flagged", lvHasControlChar("a\\b") === true);
  ok("space (32) is NOT flagged", lvHasControlChar("a b") === false);
  ok("empty string is clean", lvHasControlChar("") === false);
}

console.log("lvIsText -- binary vs text classification");
{
  ok("ascii is text", lvIsText(Buffer.from("hello world", "utf8")) === true);
  ok("valid utf8 is text", lvIsText(Buffer.from("café — ñ", "utf8")) === true);
  ok("empty buffer is text", lvIsText(Buffer.alloc(0)) === true);
  ok("a NUL byte makes it binary", lvIsText(Buffer.from([0x61, 0x00, 0x62])) === false);
  // an invalid utf8 byte sequence does not survive the round trip
  ok("invalid utf8 is binary", lvIsText(Buffer.from([0xff, 0xfe, 0xfd])) === false);
  // a PNG magic header is binary
  ok("PNG header is binary", lvIsText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === false);
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
