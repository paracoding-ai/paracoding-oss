/**
 * gppatch.ts -- git_propose_patch
 *
 * WHY THIS EXISTS. git_propose takes WHOLE FILE content, so proposing a one-line
 * change to a file of several hundred kilobytes costs on the order of 90k tokens.
 * This module removes that cost and NOTHING ELSE. It grants no new authority: the
 * result is committed through the same whole-file path, and the commit stays
 * invisible until git_push moves the ref by compare-and-swap.
 *
 * WHAT IT DOES NOT DO. It does not introduce partial writes into the store.
 * `applyUnifiedDiff` is a PURE function: (base text, diff) -> whole new text, or a
 * refusal. The result is handed to `gitPropose` unchanged, so every byte that
 * reaches the object store still goes through the whole-file path in tree.ts:
 * same mode preservation, same symlink/gitlink refusal, same commit shape, same
 * author attribution, and still invisible until git_push moves the ref by CAS.
 *
 * NO `git apply`, AND THAT IS DELIBERATE, NOT A COMPROMISE.
 *   1. There is no git binary here. The runtime image is node:24-slim, which is
 *      debian:bookworm-slim plus ca-certificates, curl, wget, gnupg, dirmngr,
 *      xz-utils and libatomic1. `git apply` would be ENOENT at runtime, inside a
 *      try/catch, and would report as a generic INTERNAL error forever.
 *   2. There is also no filesystem to apply it to. `ctx.fs` is the Firestore+GCS
 *      adapter; the container's own disk is tmpfs charged against the revision's
 *      memory. Materialising a worktree to shell out would be the wrong shape.
 *   3. `git apply -C1` REDUCES context and SEARCHES for a nearby offset. That is
 *      exactly the guessing that tree.ts refuses to do ("a wrong guess writes
 *      plausible, silently-wrong content into a commit"). This applier is
 *      STRICTER than git: zero fuzz, zero offset search, exact byte match of the
 *      old side at the stated line number, or the hunk is rejected.
 *
 * REJECT SEMANTICS WITHOUT .rej FILES. Every hunk of every file is evaluated and
 * every failure is collected before anything is written. One failed hunk fails the
 * whole call and NOTHING is committed. The caller gets the same information a
 * .rej file carries -- which hunk, at which line, what was expected, what was
 * actually there -- as structured JSON.
 */

import * as git from 'isomorphic-git';

import type { ServerContext } from './pcgit/09-mcp/src/context.js';
import { ToolError, badRequest } from './pcgit/09-mcp/src/errors.js';
import { gitPropose } from './pcgit/09-mcp/src/ops.js';
import { RefGate } from './pcgit/09-mcp/src/ref-gate.js';
import { fsClient, normalizeRepoPath } from './pcgit/09-mcp/src/tree.js';

// ---------------------------------------------------------------------------
// text <-> lines, with the trailing newline made explicit
// ---------------------------------------------------------------------------

export interface Text {
  lines: string[];
  /** Does the file end with a newline? An empty file is `true` by convention. */
  nl: boolean;
}

export function toText(s: string): Text {
  if (s === '') return { lines: [], nl: true };
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
    return { lines: parts, nl: true };
  }
  return { lines: parts, nl: false };
}

export function fromText(t: Text): string {
  if (t.lines.length === 0) return '';
  return t.lines.join('\n') + (t.nl ? '\n' : '');
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export type OpKind = ' ' | '-' | '+';

export interface Op {
  k: OpKind;
  text: string;
}

export interface Hunk {
  /** 1-based, as written in the @@ header. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: Op[];
  /** The @@ line verbatim, for error messages. */
  header: string;
  /** 1-based position of this hunk within its file patch. */
  index: number;
  /** `\ No newline at end of file` seen against the old side. */
  oldNoNl: boolean;
  /** `\ No newline at end of file` seen against the new side. */
  newNoNl: boolean;
}

export interface FilePatch {
  path: string;
  /** `--- /dev/null`: the patch creates this file. */
  isNew: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  const t = p.trim();
  if (t === '/dev/null') return t;
  // Strip one leading a/ or b/ component, the -p1 that `git apply -p1` assumes.
  const m = /^[ab]\/(.*)$/.exec(t);
  return m ? (m[1] as string) : t;
}

/**
 * Parse a unified diff into file patches.
 *
 * REFUSES rather than ignores: mode changes, renames, copies, binary patches and
 * deletions. Each of those is a structural change tree.ts deliberately does not
 * perform through a whole-file write, so accepting the syntax and silently doing
 * something else would be the worst possible answer.
 */
export function parseUnifiedDiff(patch: string): FilePatch[] {
  if (typeof patch !== 'string' || patch.trim() === '') {
    throw badRequest('patch must be a non-empty unified diff');
  }
  const lines = patch.split('\n');
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  let pendingOld: string | null = null;

  const closeHunk = () => {
    if (!hunk || !cur) return;
    const got = { minus: 0, plus: 0 };
    for (const op of hunk.ops) {
      if (op.k === ' ' || op.k === '-') got.minus++;
      if (op.k === ' ' || op.k === '+') got.plus++;
    }
    if (got.minus !== hunk.oldLines || got.plus !== hunk.newLines) {
      throw badRequest(
        `hunk ${hunk.index} of ${cur.path} declares ${hunk.oldLines} old / ` +
          `${hunk.newLines} new lines but its body has ${got.minus} / ${got.plus}. ` +
          `The @@ header and the hunk body disagree; this patch was not produced ` +
          `by a diff tool or was edited by hand.`,
        { path: cur.path, hunk: hunk.index, header: hunk.header },
      );
    }
    cur.hunks.push(hunk);
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith('diff --git ')) {
      closeHunk();
      cur = null;
      pendingOld = null;
      continue;
    }
    if (
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('copy from ') ||
      line.startsWith('copy to ') ||
      line.startsWith('deleted file mode ')
    ) {
      throw badRequest(
        `this patch changes file structure (${JSON.stringify(line.trim())}). ` +
          `git_propose_patch edits file CONTENT only: no mode changes, no renames, ` +
          `no copies, no deletions. Those are structural changes and stay a human ` +
          `decision, exactly as they are for git_propose.`,
        { line: line.trim() },
      );
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      throw badRequest('binary patches are not supported', { line: line.trim() });
    }
    if (line.startsWith('new file mode ') || line.startsWith('index ')) {
      continue;
    }

    if (line.startsWith('--- ')) {
      closeHunk();
      pendingOld = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = stripPrefix(line.slice(4));
      if (pendingOld === null) {
        throw badRequest(`+++ header with no preceding --- header: ${JSON.stringify(line)}`);
      }
      if (newPath === '/dev/null') {
        throw badRequest(
          `this patch DELETES ${pendingOld}. git_propose_patch cannot delete a file: ` +
            `the whole-file write path in tree.ts has no delete operation, and a ` +
            `deletion is a structural change.`,
          { path: pendingOld },
        );
      }
      const isNew = pendingOld === '/dev/null';
      if (!isNew && pendingOld !== newPath) {
        throw badRequest(
          `the --- and +++ headers name different files (${pendingOld} vs ${newPath}); ` +
            `renames are not supported`,
          { from: pendingOld, to: newPath },
        );
      }
      const path = normalizeRepoPath(newPath, { allowRoot: false });
      if (files.some((f) => f.path === path)) {
        throw badRequest(`${path} appears twice in this patch`, { path });
      }
      cur = { path, isNew, hunks: [] };
      files.push(cur);
      pendingOld = null;
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      if (!cur) {
        throw badRequest(
          `hunk header before any file header: ${JSON.stringify(line)}. A unified ` +
            `diff needs '--- a/path' and '+++ b/path' before its first @@.`,
        );
      }
      closeHunk();
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        ops: [],
        header: line,
        index: cur.hunks.length + 1,
        oldNoNl: false,
        newNoNl: false,
      };
      continue;
    }

    if (!hunk) continue; // preamble, trailing junk, `-- ` mail signature, etc.

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` applies to the line immediately above.
      const prev = hunk.ops[hunk.ops.length - 1];
      if (!prev) {
        throw badRequest('"\\ No newline at end of file" with no preceding line');
      }
      if (prev.k === ' ' || prev.k === '-') hunk.oldNoNl = true;
      if (prev.k === ' ' || prev.k === '+') hunk.newNoNl = true;
      continue;
    }
    if (line === '' && i === lines.length - 1) continue; // trailing newline of the patch itself
    const k = line.charAt(0);
    if (k === ' ' || k === '-' || k === '+') {
      hunk.ops.push({ k: k as OpKind, text: line.slice(1) });
      continue;
    }
    if (line === '') {
      // A context line that is itself empty is legally written as a single space,
      // but many tools (and every editor that trims trailing whitespace) emit "".
      hunk.ops.push({ k: ' ', text: '' });
      continue;
    }
    throw badRequest(
      `unrecognised line inside hunk ${hunk.index} of ${cur ? cur.path : '?'}: ` +
        JSON.stringify(line.slice(0, 120)),
      { line: line.slice(0, 120) },
    );
  }
  closeHunk();

  if (files.length === 0) {
    throw badRequest(
      'no file headers found in the patch. Expected unified diff with ' +
        "'--- a/path' and '+++ b/path' lines.",
    );
  }
  for (const f of files) {
    if (f.hunks.length === 0) {
      throw badRequest(`${f.path} has a file header but no @@ hunks`, { path: f.path });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface Reject {
  path: string;
  hunk: number;
  header: string;
  atLine: number;
  reason: string;
  expected?: string;
  actual?: string;
}

export interface ApplyResult {
  ok: boolean;
  content?: string;
  rejects: Reject[];
}

/**
 * Apply one file's hunks to `base`. STRICT: the old side must match byte for byte
 * at the line number the hunk states. No fuzz, no offset search, no reordering.
 *
 * `base` is null for a file the patch creates.
 */
export function applyUnifiedDiff(base: string | null, fp: FilePatch): ApplyResult {
  const rejects: Reject[] = [];
  const src: Text = base === null ? { lines: [], nl: true } : toText(base);
  const out: string[] = [];
  let cursor = 0;
  let outNl = src.nl;

  for (const h of fp.hunks) {
    // A pure insertion writes `-N,0`, meaning "after old line N". Everything else
    // writes the 1-based number of the first line it touches.
    const at = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;

    if (at < cursor) {
      rejects.push({
        path: fp.path,
        hunk: h.index,
        header: h.header,
        atLine: h.oldStart,
        reason:
          `hunk starts at old line ${h.oldStart}, which is at or before the end of the ` +
          `previous hunk (old line ${cursor}). Hunks must be in ascending, ` +
          `non-overlapping order.`,
      });
      continue;
    }
    if (at > src.lines.length) {
      rejects.push({
        path: fp.path,
        hunk: h.index,
        header: h.header,
        atLine: h.oldStart,
        reason: `hunk starts at old line ${h.oldStart} but the file has only ${src.lines.length} lines`,
      });
      continue;
    }

    for (let i = cursor; i < at; i++) out.push(src.lines[i] as string);
    let i = at;
    const staged: string[] = [];
    let bad: Reject | null = null;

    for (const op of h.ops) {
      if (op.k === ' ' || op.k === '-') {
        if (i >= src.lines.length) {
          bad = {
            path: fp.path,
            hunk: h.index,
            header: h.header,
            atLine: i + 1,
            reason: `hunk runs past the end of the file (${src.lines.length} lines)`,
            expected: op.text,
          };
          break;
        }
        if (src.lines[i] !== op.text) {
          bad = {
            path: fp.path,
            hunk: h.index,
            header: h.header,
            atLine: i + 1,
            reason: `context mismatch at line ${i + 1}: the file does not contain what the patch says it contains`,
            expected: op.text,
            actual: src.lines[i] as string,
          };
          break;
        }
        i++;
      }
      if (op.k === ' ' || op.k === '+') staged.push(op.text);
    }

    if (bad) {
      rejects.push(bad);
      // Do not advance. The result is discarded wholesale; this only keeps the
      // remaining hunks from producing a cascade of meaningless follow-on errors.
      continue;
    }

    for (const s of staged) out.push(s);

    const reachedEof = i === src.lines.length;
    if (reachedEof) {
      if (h.oldNoNl && src.nl) {
        rejects.push({
          path: fp.path,
          hunk: h.index,
          header: h.header,
          atLine: i,
          reason:
            'the patch says the original file has no trailing newline, but it does. ' +
            'The patch was made against different content.',
        });
        continue;
      }
      if (!h.oldNoNl && !src.nl && h.ops.some((o) => o.k === '-' || o.k === ' ')) {
        rejects.push({
          path: fp.path,
          hunk: h.index,
          header: h.header,
          atLine: i,
          reason:
            'the original file has no trailing newline, but the patch does not say so ' +
            '("\\ No newline at end of file" is missing). The patch was made against ' +
            'different content.',
        });
        continue;
      }
      outNl = !h.newNoNl;
    }
    cursor = i;
  }

  if (rejects.length) return { ok: false, rejects };
  for (let i = cursor; i < src.lines.length; i++) out.push(src.lines[i] as string);
  return { ok: true, content: fromText({ lines: out, nl: outNl }), rejects: [] };
}

// ---------------------------------------------------------------------------
// the operation
// ---------------------------------------------------------------------------

const OID_RE = /^[0-9a-f]{40}$/;

/**
 * The same branch-name rules ops.ts `assertBranchName` applies, restated because
 * that function is not exported. It runs BEFORE the ref read so a malformed
 * branch is reported as a bad argument rather than as REF_NOT_FOUND -- and
 * gitPropose applies the real one again downstream, so this is a message
 * improvement, never the only check.
 */
function branchRef(branch: string): string {
  if (typeof branch !== 'string' || branch.length === 0) {
    throw badRequest('branch must be a non-empty string');
  }
  if (branch.startsWith('refs/')) {
    throw badRequest(
      `branch must be a bare branch name, not a full ref. Got ${JSON.stringify(branch)}.`,
      { branch },
    );
  }
  if (OID_RE.test(branch)) throw badRequest('branch must be a name, not an oid', { branch });
  if (/[\0\x20~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-|^@$|^HEAD$/.test(branch)) {
    throw badRequest(`branch ${JSON.stringify(branch)} is not a valid git branch name`, { branch });
  }
  return `refs/heads/${branch}`;
}

async function readBlobAt(
  ctx: ServerContext,
  commit: string,
  path: string,
): Promise<{ oid: string; content: string } | null> {
  try {
    const r = await git.readBlob({
      fs: fsClient({ fs: ctx.fs, gitdir: ctx.gitdir, cache: ctx.cache }),
      gitdir: ctx.gitdir,
      cache: ctx.cache,
      oid: commit,
      filepath: path,
    });
    if (r.blob.length > ctx.cfg.maxBlobBytes) {
      throw new ToolError(
        'FILE_TOO_LARGE',
        `${path} is ${r.blob.length} bytes, over the ${ctx.cfg.maxBlobBytes}-byte cap`,
        { path, size: r.blob.length, maxBytes: ctx.cfg.maxBlobBytes },
      );
    }
    for (let i = 0; i < Math.min(r.blob.length, 8000); i++) {
      if (r.blob[i] === 0) {
        throw badRequest(`${path} is binary; git_propose_patch edits text files only`, { path });
      }
    }
    return { oid: r.oid, content: Buffer.from(r.blob).toString('utf8') };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'NotFoundError') return null;
    throw err;
  }
}

/**
 * Apply a unified diff to a branch and commit the result. THE REF IS NOT MOVED --
 * this returns commitOid and baseOid exactly as git_propose does, and nothing is
 * visible until git_push.
 */
export async function gitProposePatch(
  ctx: ServerContext,
  args: {
    branch: string;
    patch: string;
    message: string;
    expected_blob_sha?: Record<string, string | null>;
    author?: { name: string; email: string };
  },
) {
  const files = parseUnifiedDiff(args.patch);
  if (files.length > ctx.cfg.maxProposeFiles) {
    throw new ToolError(
      'TOO_MANY_FILES',
      `${files.length} files in one patch, limit is ${ctx.cfg.maxProposeFiles}`,
      { count: files.length, limit: ctx.cfg.maxProposeFiles },
    );
  }

  // The head is read HERE, before the base blobs, and asserted again after
  // gitPropose has built the commit. Without that, a writer landing in between
  // would have its change to these same files silently discarded: the patch is
  // computed against the old tree while the commit's parent is the new head.
  const refName = branchRef(args.branch);
  const gate = new RefGate(ctx.refs, ctx.cfg.repoId, ctx.cfg.defaultBranch);
  const headBefore: string | null = await gate.readExactRef(refName);
  if (headBefore === null && !files.every((f) => f.isNew)) {
    throw new ToolError(
      'REF_NOT_FOUND',
      `branch ${args.branch} does not exist, so there is nothing to patch. ` +
        `Only a patch that creates every file it touches can start a branch.`,
      { branch: args.branch },
    );
  }

  const cas = args.expected_blob_sha ?? {};
  for (const [k, v] of Object.entries(cas)) {
    if (v !== null && !OID_RE.test(String(v))) {
      throw badRequest(
        `expected_blob_sha[${k}] must be a 40-hex blob oid, or null meaning ` +
          `"this file must not exist yet". Got ${JSON.stringify(v)}.`,
        { path: k, value: v },
      );
    }
  }
  const known = new Set(files.map((f) => f.path));
  for (const k of Object.keys(cas)) {
    if (!known.has(normalizeRepoPath(k, { allowRoot: false }))) {
      throw badRequest(
        `expected_blob_sha names ${k}, which this patch does not touch. ` +
          `A compare-and-swap on a file the patch never reads proves nothing.`,
        { path: k },
      );
    }
  }

  const staged: Array<{ path: string; content: string }> = [];
  const rejects: Reject[] = [];
  const seen: Array<{ path: string; baseBlobOid: string | null; hunks: number }> = [];

  for (const fp of files) {
    const existing = headBefore === null ? null : await readBlobAt(ctx, headBefore, fp.path);

    if (fp.isNew && existing !== null) {
      throw badRequest(
        `the patch creates ${fp.path} (--- /dev/null) but that file already exists at ` +
          `${args.branch}. Re-diff against the current content.`,
        { path: fp.path, blobOid: existing.oid },
      );
    }
    if (!fp.isNew && existing === null) {
      throw new ToolError(
        'PATH_NOT_FOUND',
        `${fp.path} does not exist at ${args.branch}. To create it, produce the patch ` +
          `against /dev/null.`,
        { path: fp.path, branch: args.branch },
      );
    }

    const want = Object.prototype.hasOwnProperty.call(cas, fp.path) ? cas[fp.path] : undefined;
    if (want !== undefined) {
      const actual = existing === null ? null : existing.oid;
      if (want !== actual) {
        throw new ToolError(
          'STALE',
          `compare-and-swap failed on ${fp.path}: you expected blob ` +
            `${want === null ? '(absent)' : want} but ${args.branch} holds ` +
            `${actual === null ? '(absent)' : actual}. The file moved under your diff. ` +
            `NOTHING WAS COMMITTED. Re-read the file and rebuild the patch.`,
          { path: fp.path, expected: want, actual, branch: args.branch },
        );
      }
    }

    const r = applyUnifiedDiff(existing === null ? null : existing.content, fp);
    seen.push({
      path: fp.path,
      baseBlobOid: existing === null ? null : existing.oid,
      hunks: fp.hunks.length,
    });
    if (!r.ok) {
      for (const x of r.rejects) rejects.push(x);
      continue;
    }
    if (existing !== null && r.content === existing.content) {
      throw badRequest(
        `${fp.path} is unchanged by this patch. An empty commit is almost always a ` +
          `sign the patch was already applied; refusing rather than creating one.`,
        { path: fp.path },
      );
    }
    staged.push({ path: fp.path, content: r.content as string });
  }

  if (rejects.length) {
    // Same contract as `git apply --reject` would give, minus the .rej files:
    // every failure across every file, and NOTHING committed.
    throw new ToolError(
      'BAD_REQUEST',
      `${rejects.length} hunk(s) did not apply. NOTHING WAS COMMITTED and the branch ` +
        `is untouched. Re-read the file with git_read and rebuild the patch against ` +
        `its current bytes.`,
      { rejected: true, rejects, files: seen },
    );
  }

  const proposed: any = await gitPropose(ctx, {
    branch: args.branch,
    files: staged,
    message: args.message,
    ...(args.author ? { author: args.author } : {}),
  });

  // The window between reading the base blobs and gitPropose reading the head.
  if (proposed.baseOid !== headBefore) {
    throw new ToolError(
      'STALE',
      `${args.branch} moved from ${headBefore ?? '(nothing)'} to ` +
        `${proposed.baseOid ?? '(nothing)'} while this patch was being applied. The ` +
        `commit that was built is unreachable from any ref and will be reclaimed; ` +
        `NOTHING WAS PUSHED. Re-read the files and rebuild the patch.`,
      { branch: args.branch, headBefore, headNow: proposed.baseOid },
    );
  }

  return {
    ...proposed,
    applied: seen.map((s) => ({
      path: s.path,
      hunks: s.hunks,
      baseBlobOid: s.baseBlobOid,
    })),
    patchedFiles: staged.length,
  };
}
