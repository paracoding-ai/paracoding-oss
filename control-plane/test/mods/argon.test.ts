// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free Argon helpers (src/mods/argon.ts). No cloud, no network:
// these three functions touch nothing but their arguments, so the tests are pure in/out.
process.env.PC_NO_LISTEN = "1";
import { argonPackTok, argonLooksBinary, argonParseFiles } from "../../src/mods/argon.js";

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
  console.log("argonPackTok -- ~3.6 chars per token, rounded up");
  {
    eq("zero chars is zero tokens", argonPackTok(0), 0);
    eq("null coerces to zero", argonPackTok(null as any), 0);
    eq("undefined coerces to zero", argonPackTok(undefined as any), 0);
    eq("36 chars -> 10 tokens exactly", argonPackTok(36), 10);
    eq("one char rounds up to one token", argonPackTok(1), 1);
    eq("37 chars rounds up past 10", argonPackTok(37), 11);
    ok("a big file is a lot of tokens", argonPackTok(360000) === 100000);
    ok("monotonic: more chars never means fewer tokens", argonPackTok(1000) >= argonPackTok(999));
  }

  console.log("argonLooksBinary -- extension sniff OR an embedded NUL");
  {
    eq("png by extension", argonLooksBinary("a/b/logo.PNG", "whatever"), true);
    eq("woff2 by extension", argonLooksBinary("fonts/x.woff2", ""), true);
    eq("tarball by extension", argonLooksBinary("x.tgz", ""), true);
    eq("plain .ts source is text", argonLooksBinary("src/index.ts", "export const x = 1;\n"), false);
    eq("README is text", argonLooksBinary("README.md", "# hello\n"), false);
    eq("a NUL byte in the body marks it binary", argonLooksBinary("mystery.dat", "abc\u0000def"), true);
    eq("a NUL past the 8000-char window is not sniffed", argonLooksBinary("big.txt", "x".repeat(8000) + "\u0000"), false);
    eq("empty text, text extension", argonLooksBinary("notes.txt", ""), false);
  }

  console.log("argonParseFiles -- the `=== path ===` build-output contract");
  {
    const text = [
      "=== src/a.ts ===",
      "export const a = 1;",
      "=== dir/b.txt ===",
      "hello",
      "=== END ===",
      "Added a and b; run the build to verify.",
    ].join("\n");
    const r = argonParseFiles(text);
    eq("two files parsed", r.files.length, 2);
    eq("first path", r.files[0].path, "src/a.ts");
    eq("first body kept, newline-terminated", r.files[0].content, "export const a = 1;\n");
    eq("second path", r.files[1].path, "dir/b.txt");
    eq("second body", r.files[1].content, "hello\n");
    eq("summary is the text after === END ===", r.summary, "Added a and b; run the build to verify.");
  }

  console.log("argonParseFiles -- strips a single outer markdown fence");
  {
    const text = "=== x.js ===\n```js\nconst y = 2;\n```\n=== END ===\ndone";
    const r = argonParseFiles(text);
    eq("one file", r.files.length, 1);
    eq("fence removed, trailing newline added", r.files[0].content, "const y = 2;\n");
  }

  console.log("argonParseFiles -- unsafe paths are rejected");
  {
    const text = [
      "=== ../escape.ts ===", "nope",
      "=== /abs/path.ts ===", "nope",
      "=== .git/config ===", "nope",
      "=== ok/safe.ts ===", "yes",
      "=== END ===", "",
    ].join("\n");
    const r = argonParseFiles(text);
    eq("only the safe path survives", r.files.length, 1);
    eq("and it is the safe one", r.files[0].path, "ok/safe.ts");
  }

  console.log("argonParseFiles -- a later block for the same path overwrites the earlier one");
  {
    const text = "=== dup.ts ===\nfirst\n=== dup.ts ===\nsecond\n=== END ===\n";
    const r = argonParseFiles(text);
    eq("deduped to one file", r.files.length, 1);
    eq("last write wins", r.files[0].content, "second\n");
  }

  console.log("argonParseFiles -- no markers at all yields nothing");
  {
    const r = argonParseFiles("just some prose with no file markers");
    eq("no files", r.files.length, 0);
    eq("no summary", r.summary, "");
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
