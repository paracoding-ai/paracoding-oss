// SPDX-License-Identifier: Apache-2.0
// [ARGON-MOD-V1] Dependency-free helpers of the Argon context-packer + build lane, extracted from
// index.ts by the strangler refactor. Only the pure functions move here: the token estimator, the
// binary-file sniff, and the `=== path ===` build-output parser. The rest of the Argon lane
// (argonPackLoad/Save/Render, argonGitlabGet/Raw/Tree/Send, argonBuildRun/RecoverOnBoot and the
// tool factories) stay in index.ts because they reach index-only symbols (db collections cpkCol/
// cbjCol, harSecretGet, the harGemini* family, HarChatTool, PC_INSTANCE_KEY/PC_BOOT_AT) that are
// not exported from shared.ts or any mod. These three touch nothing outside themselves.

// ~3.6 chars/token, the estimator the whole pack budgets against.
export function argonPackTok(chars: number): number { return Math.ceil(Number(chars || 0) / 3.6); }

export function argonLooksBinary(path: string, text: string): boolean {
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mp3|wasm|jar|so|bin)$/i.test(path)) return true;
  return text.slice(0, 8000).indexOf('\u0000') >= 0;
}

// Parse the build lane's output contract: one `=== relative/path ===` line per file, then the
// whole file body, terminated by `=== END ===` + summary. Rejects unsafe paths and strips a single
// outer markdown fence if the model wrapped a body in one.
export function argonParseFiles(text: string): { files: { path: string; content: string }[]; summary: string } {
  const marks: { name: string; start: number; end: number }[] = [];
  const re = /^=== (.+?) ===[ \t]*$/gm; let m: any;
  while ((m = re.exec(text))) marks.push({ name: String(m[1]).trim(), start: m.index, end: re.lastIndex });
  const files: { path: string; content: string }[] = []; let summary = '';
  for (let i = 0; i < marks.length; i++) {
    const nm = marks[i].name;
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : text.length;
    if (/^END$/i.test(nm)) { summary = text.slice(marks[i].end).trim(); break; }
    let body = text.slice(marks[i].end, bodyEnd).replace(/^\r?\n/, '');
    const fm = /^```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(body.trim());
    if (fm) body = fm[1];
    if (!body.endsWith('\n')) body += '\n';
    const okPath = /^[A-Za-z0-9_.@+\-\/]+$/.test(nm) && nm.indexOf('..') < 0 && nm[0] !== '/' && !/^\.git\//.test(nm);
    if (!okPath) continue;
    const prev = files.findIndex((f) => f.path === nm);
    if (prev >= 0) files[prev].content = body; else files.push({ path: nm, content: body });
  }
  return { files: files, summary: summary };
}
