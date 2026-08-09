/**
 * 09-mcp / ops.ts
 *
 * The six operations. Each one is a plain async function returning a plain
 * object; `tools.ts` only adds argument schemas and JSON framing.
 *
 * INVARIANT, EVERY FUNCTION IN THIS FILE: isomorphic-git is never handed a
 * symbolic ref name. Names are resolved to oids by `RefGate` against the
 * Firestore ref documents first (see ref-gate.ts for why).
 */

import * as git from 'isomorphic-git';

import { pushRef } from '../../07-refs/src/push';
import type { PushOutcome } from '../../07-refs/src/push';
import { isOid } from '../../07-refs/src/model';

import type { Config } from './config';
import type { ServerContext } from './context';
import { ToolError, badRequest } from './errors';
import { diffCommits } from './diff';
import { RefGate, peelToCommit } from './ref-gate';
import {
  MODE_EXEC,
  MODE_FILE,
  MODE_GITLINK,
  MODE_SYMLINK,
  type GitDeps,
  buildTree,
  fsClient,
  normalizeRepoPath,
  readTreeEntries,
} from './tree';

function deps(ctx: ServerContext): GitDeps {
  return { fs: ctx.fs, gitdir: ctx.gitdir, cache: ctx.cache };
}

function gate(ctx: ServerContext): RefGate {
  return new RefGate(ctx.refs, ctx.cfg.repoId, ctx.cfg.defaultBranch);
}

/** ref -> { refName, commit oid }, peeling annotated tags. */
async function resolveCommit(
  ctx: ServerContext,
  ref: string,
): Promise<{ refName: string | null; commit: string }> {
  const resolved = await gate(ctx).resolveRef(ref);
  try {
    const commit = await peelToCommit(deps(ctx), resolved.oid);
    return { refName: resolved.refName, commit };
  } catch (err) {
    if (isNotFound(err)) {
      // A ref pointing at an object that is not in the store. 07-refs §4.2
      // Case B, which the push ordering is designed to make unreachable. If we
      // ever see it, say so precisely rather than reporting "no such path".
      throw new ToolError(
        'OBJECT_NOT_FOUND',
        `ref ${resolved.refName ?? ref} points at ${resolved.oid}, which is not readable ` +
          `in the object store. The repository needs repair (07-refs repair.ts verifyRepo).`,
        { ref, refName: resolved.refName, oid: resolved.oid },
      );
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'NotFoundError';
}

function isWrongType(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ObjectTypeError';
}

function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

function assertBranchName(branch: string): string {
  if (typeof branch !== 'string' || branch.length === 0) {
    throw badRequest('branch must be a non-empty string');
  }
  if (branch.startsWith('refs/')) {
    throw badRequest(
      `branch must be a bare branch name, not a full ref. Got ${JSON.stringify(branch)}; ` +
        `did you mean ${JSON.stringify(branch.replace(/^refs\/heads\//, ''))}?`,
      { branch },
    );
  }
  if (isOid(branch)) throw badRequest('branch must be a name, not an oid', { branch });
  if (/[\0\x20~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-|^@$|^HEAD$/.test(branch)) {
    throw badRequest(`branch ${JSON.stringify(branch)} is not a valid git branch name`, {
      branch,
    });
  }
  return `refs/heads/${branch}`;
}

// ---------------------------------------------------------------------------
// 1. git_read
// ---------------------------------------------------------------------------

export async function gitRead(ctx: ServerContext, args: { path: string; ref: string }) {
  const path = normalizeRepoPath(args.path, { allowRoot: false });
  const { refName, commit } = await resolveCommit(ctx, args.ref);

  let blobOid: string;
  let bytes: Uint8Array;
  try {
    const result = await git.readBlob({
      fs: fsClient(deps(ctx)),
      gitdir: ctx.gitdir,
      cache: ctx.cache,
      oid: commit,
      filepath: path,
    });
    blobOid = result.oid;
    bytes = result.blob;
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError('PATH_NOT_FOUND', `no such file at ${args.ref}: ${path}`, {
        path,
        ref: args.ref,
        commit,
      });
    }
    if (isWrongType(err)) {
      throw new ToolError(
        'NOT_A_BLOB',
        `${path} is not a file at ${args.ref}. Use git_list to list a directory.`,
        { path, ref: args.ref, commit },
      );
    }
    throw err;
  }

  if (bytes.length > ctx.cfg.maxBlobBytes) {
    // Deliberately an error, not a truncated body. A silently truncated read
    // becomes a whole-file write that deletes the tail of the file.
    throw new ToolError(
      'FILE_TOO_LARGE',
      `${path} is ${bytes.length} bytes, over the ${ctx.cfg.maxBlobBytes}-byte read cap. ` +
        `Contents were NOT returned.`,
      { path, blobOid, size: bytes.length, maxBytes: ctx.cfg.maxBlobBytes },
    );
  }

  const binary = isBinary(bytes);
  const buffer = Buffer.from(bytes);

  return {
    ok: true as const,
    path,
    ref: args.ref,
    refName,
    commit,
    blobOid,
    size: bytes.length,
    encoding: binary ? ('base64' as const) : ('utf-8' as const),
    content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// 2. git_list
// ---------------------------------------------------------------------------

export async function gitList(ctx: ServerContext, args: { path?: string; ref: string }) {
  const path = normalizeRepoPath(args.path ?? '', { allowRoot: true });
  const { refName, commit } = await resolveCommit(ctx, args.ref);

  let treeOid: string;
  let entries;
  try {
    const result = await readTreeEntries(deps(ctx), commit, path);
    treeOid = result.treeOid;
    entries = result.entries;
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError('PATH_NOT_FOUND', `no such directory at ${args.ref}: ${path || '/'}`, {
        path,
        ref: args.ref,
        commit,
      });
    }
    if (isWrongType(err)) {
      throw new ToolError(
        'NOT_A_TREE',
        `${path} is not a directory at ${args.ref}. Use git_read to read a file.`,
        { path, ref: args.ref, commit },
      );
    }
    throw err;
  }

  return {
    ok: true as const,
    path,
    ref: args.ref,
    refName,
    commit,
    treeOid,
    entries: entries.map((e) => ({
      name: e.path,
      path: path === '' ? e.path : `${path}/${e.path}`,
      type: e.mode === MODE_GITLINK ? ('submodule' as const) : e.type,
      mode: e.mode,
      oid: e.oid,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. git_log
// ---------------------------------------------------------------------------

export async function gitLog(
  ctx: ServerContext,
  args: { ref: string; max_count: number; path?: string },
) {
  const maxCount = args.max_count;
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    throw badRequest('max_count must be an integer >= 1', { max_count: maxCount });
  }
  if (maxCount > ctx.cfg.maxLogCount) {
    throw badRequest(`max_count must be <= ${ctx.cfg.maxLogCount}`, {
      max_count: maxCount,
      limit: ctx.cfg.maxLogCount,
    });
  }

  const path =
    args.path === undefined || args.path === ''
      ? undefined
      : normalizeRepoPath(args.path, { allowRoot: false });
  const { refName, commit } = await resolveCommit(ctx, args.ref);

  let commits;
  try {
    commits = await git.log({
      fs: fsClient(deps(ctx)),
      gitdir: ctx.gitdir,
      cache: ctx.cache,
      ref: commit,
      depth: maxCount,
      // No `force`. If the path never existed, isomorphic-git throws and the
      // agent is told so, rather than receiving an empty list that reads as
      // "this file has no history".
      ...(path !== undefined ? { filepath: path } : {}),
    });
  } catch (err) {
    if (isNotFound(err) && path !== undefined) {
      throw new ToolError(
        'PATH_NOT_FOUND',
        `no file or directory ${path} in the history of ${args.ref}`,
        { path, ref: args.ref, commit },
      );
    }
    throw err;
  }

  return {
    ok: true as const,
    ref: args.ref,
    refName,
    commit,
    path: path ?? null,
    count: commits.length,
    commits: commits.map((c) => ({
      oid: c.oid,
      parents: c.commit.parent,
      tree: c.commit.tree,
      message: c.commit.message,
      author: {
        name: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: c.commit.author.timestamp,
        timezoneOffset: c.commit.author.timezoneOffset,
        iso8601: new Date(c.commit.author.timestamp * 1000).toISOString(),
      },
      committer: {
        name: c.commit.committer.name,
        email: c.commit.committer.email,
        timestamp: c.commit.committer.timestamp,
        timezoneOffset: c.commit.committer.timezoneOffset,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. git_diff
// ---------------------------------------------------------------------------

export async function gitDiff(
  ctx: ServerContext,
  args: { from_ref: string; to_ref: string; path?: string },
) {
  const path =
    args.path === undefined || args.path === ''
      ? undefined
      : normalizeRepoPath(args.path, { allowRoot: false });

  const from = await resolveCommit(ctx, args.from_ref);
  const to = await resolveCommit(ctx, args.to_ref);

  if (from.commit === to.commit) {
    // A genuinely empty answer, and it is flagged as such. This is the one
    // place an empty result is correct, and it is never ambiguous with a
    // failure because `identical` says so explicitly.
    return {
      ok: true as const,
      from: { ref: args.from_ref, refName: from.refName, commit: from.commit },
      to: { ref: args.to_ref, refName: to.refName, commit: to.commit },
      path: path ?? null,
      identical: true,
      truncated: false,
      changes: [],
      patch: '',
    };
  }

  const result = await diffCommits(deps(ctx), from.commit, to.commit, {
    maxFiles: ctx.cfg.maxDiffFiles,
    maxFileBytes: ctx.cfg.maxDiffFileBytes,
    ...(path !== undefined ? { pathFilter: path } : {}),
  });

  return {
    ok: true as const,
    from: { ref: args.from_ref, refName: from.refName, commit: from.commit },
    to: { ref: args.to_ref, refName: to.refName, commit: to.commit },
    path: path ?? null,
    identical: false,
    truncated: result.truncated,
    changes: result.changes,
    patch: result.patch,
  };
}

// ---------------------------------------------------------------------------
// 5a. copy-by-existing-blob  [SEC-PROPOSE-COPY-V1]
// ---------------------------------------------------------------------------

/**
 * Name an EXISTING blob as the source of a proposed file, instead of sending
 * its bytes.
 *
 * WHY THIS EXISTS: `git_propose`'s `content` is an agent's own typed output, so
 * every byte of it is a chance to corrupt the file, and that has already
 * happened twice. Most of what a generated tree contains is already in this
 * repository verbatim. This lets a proposal NAME those blobs and send none of
 * their bytes.
 *
 * WHY THERE IS NO BARE-OID FORM, AND THIS IS THE WHOLE AUTHORISATION ARGUMENT:
 * a source is named as (path, ref) and NOTHING ELSE. The ref goes through the
 * same `resolveCommit` -> `RefGate` that `git_read` and `git_list` use, and the
 * path is resolved by reading that commit's tree. So this reaches EXACTLY the
 * set of objects the caller could already reach with `git_list`, and not one
 * object more. Accepting a bare oid and handing it to `readObject` would
 * bypass ref resolution entirely and let a caller mount ANY object in the
 * store into a visible tree -- including one that is unreachable from every
 * ref, which is another writer's abandoned proposal (07-refs 4.2 Case A, whose
 * entire purpose is that those stay invisible). That is a new read reach and a
 * new write reach at once, and the convenience is not worth it.
 *
 * `blob_oid` is therefore an ASSERTION, NEVER A LOOKUP KEY: the caller states
 * what it believes the source resolves to, and a mismatch refuses the whole
 * proposal. That buys the compare-and-swap without buying the escape hatch.
 *
 * WHAT THIS DOES NOT WIDEN: the destination. A copied file is written by the
 * same `buildTree` onto the same branch as a `content` file, so every path rule
 * (`normalizeRepoPath`), every structural refusal (tree, symlink, gitlink) and
 * the branch-name check apply unchanged. Bytes arriving from inside the store
 * buy no write reach that typing them would not have bought.
 *
 * The blob is never materialised. `readTreeEntries` on the parent directory
 * yields the entry's oid and mode from the tree alone, so a source far over
 * `cfg.maxBlobBytes` copies fine and costs one tree read. That is the
 * write-side analogue of why `gitList` exists next to `gitRead`.
 */
export interface ProposeCopyFrom {
  /** Repo-relative path of the file to copy. */
  path: string;
  /** Ref to read it at. Resolved by the same gate `git_read` uses. */
  ref: string;
  /** OPTIONAL assertion. Refuse unless the resolved source oid equals this. */
  blob_oid?: string | null;
}

async function resolveCopySource(
  ctx: ServerContext,
  destPath: string,
  src: ProposeCopyFrom,
): Promise<{ oid: string; path: string; ref: string; refName: string | null; commit: string }> {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    throw badRequest(`files[${destPath}].copy_from must be an object { path, ref }`, {
      path: destPath,
    });
  }
  if (typeof src.ref !== 'string' || src.ref.trim() === '') {
    throw badRequest(`files[${destPath}].copy_from.ref must be a non-empty ref name`, {
      path: destPath,
    });
  }
  const from = normalizeRepoPath(src.path, { allowRoot: false });
  const cut = from.lastIndexOf('/');
  const dir = cut < 0 ? '' : from.slice(0, cut);
  const name = cut < 0 ? from : from.slice(cut + 1);

  // The same resolver git_read uses. A ref this caller cannot resolve dies here.
  const { refName, commit } = await resolveCommit(ctx, src.ref);

  let entries;
  try {
    entries = (await readTreeEntries(deps(ctx), commit, dir)).entries;
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError('PATH_NOT_FOUND', `no such file at ${src.ref}: ${from}`, {
        path: from,
        ref: src.ref,
        commit,
      });
    }
    if (isWrongType(err)) {
      throw new ToolError(
        'NOT_A_TREE',
        `cannot copy ${from} at ${src.ref}: ${dir === '' ? '/' : dir} is not a directory`,
        { path: from, ref: src.ref, commit },
      );
    }
    throw err;
  }

  const entry = entries.find((e) => e.path === name);
  if (entry === undefined) {
    // A missing source is an ERROR, never an empty file. Falling through to a
    // zero-byte blob here would write a plausible, silently-wrong commit --
    // exactly the failure this package's errors.ts exists to forbid.
    throw new ToolError('PATH_NOT_FOUND', `no such file at ${src.ref}: ${from}`, {
      path: from,
      ref: src.ref,
      commit,
    });
  }
  if (entry.type !== 'blob' || entry.mode !== MODE_FILE) {
    // 100755 is refused along with everything else, deliberately: `buildTree`
    // has no mode parameter and defaults a NEW path to 100644, so copying an
    // executable onto a path that does not exist yet would silently drop its
    // executable bit. A refusal is recoverable; a silently non-executable
    // install script is not. Every blob in this repository is 100644 today,
    // so this costs nothing and closes the hole before it can open.
    const what =
      entry.mode === MODE_GITLINK
        ? 'submodule'
        : entry.mode === MODE_SYMLINK
          ? 'symlink'
          : entry.mode === MODE_EXEC
            ? 'executable file'
            : entry.type;
    throw new ToolError(
      'NOT_A_BLOB',
      `cannot copy ${from} at ${src.ref}: it is a ${what} (mode ${entry.mode}), not a ` +
        `regular ${MODE_FILE} file`,
      { path: from, ref: src.ref, commit, mode: entry.mode, type: entry.type },
    );
  }

  if (src.blob_oid !== undefined && src.blob_oid !== null) {
    if (!isOid(src.blob_oid)) {
      throw badRequest(
        `files[${destPath}].copy_from.blob_oid must be a 40-char lowercase hex oid`,
        { path: destPath, blob_oid: src.blob_oid },
      );
    }
    if (src.blob_oid !== entry.oid) {
      throw badRequest(
        `files[${destPath}].copy_from.blob_oid says ${src.blob_oid}, but ${from} at ` +
          `${src.ref} is ${entry.oid}. NOTHING was written. Either the source moved, or ` +
          `that oid names something else -- an oid is never a lookup key here.`,
        {
          path: destPath,
          source: from,
          ref: src.ref,
          commit,
          expected: src.blob_oid,
          actual: entry.oid,
        },
      );
    }
  }

  return { oid: entry.oid, path: from, ref: src.ref, refName, commit };
}

// ---------------------------------------------------------------------------
// 5b. remove-a-path  [SEC-PROPOSE-DELETE-V1]
// ---------------------------------------------------------------------------

/**
 * Resolve a path being REMOVED against the base tree of the branch being
 * written, and refuse if it is not there.
 *
 * WHY THIS RESOLVES AT ALL, rather than handing the path to `buildTree` and
 * letting the tree walk sort it out: a caller has to be able to VERIFY that a
 * removal removed the thing it meant. Resolving here yields the oid of the
 * blob that is about to leave the tree, which goes back in the response the
 * same way a copy's source does, and it turns a typo into an error BEFORE any
 * object is written rather than partway through building the tree.
 *
 * WHY A MISSING PATH IS AN ERROR AND NEVER A NO-OP: a removal that quietly
 * succeeded on a path that was never there reports success and changes
 * nothing. That is how a "removal" ships that removed nothing -- and the whole
 * point of the caller asking for a removal is that the file must be gone.
 *
 * THIS WIDENS NO AUTHORISATION, AND THAT IS THE ENTIRE ARGUMENT. There is no
 * ref parameter: a removal is resolved against `baseTree`, the tree of the
 * branch head this proposal is already building on. It reaches strictly less
 * than `copy_from`, which at least takes a ref. Removing a path is therefore
 * possible in exactly the cases where OVERWRITING that same path through
 * `content` is possible -- same branch, same `normalizeRepoPath`, same
 * `assertBranchName`, same structural refusals, same commit, and the same
 * compare-and-swap in `git_push` deciding whether any of it becomes visible. A
 * delete primitive that reached further than the write primitive would be a
 * privilege escalation, so it does not take a ref, an oid, a glob or a prefix.
 */
async function resolveDeleteTarget(
  ctx: ServerContext,
  branch: string,
  baseTree: string | null,
  path: string,
): Promise<{ oid: string; mode: string }> {
  if (baseTree === null) {
    throw new ToolError(
      'PATH_NOT_FOUND',
      `cannot remove ${path}: branch ${branch} does not exist yet, so it holds no files. ` +
        `NOTHING was written.`,
      { path, branch },
    );
  }
  const cut = path.lastIndexOf('/');
  const dir = cut < 0 ? '' : path.slice(0, cut);
  const name = cut < 0 ? path : path.slice(cut + 1);

  let entries;
  try {
    entries = (await readTreeEntries(deps(ctx), baseTree, dir)).entries;
  } catch (err) {
    if (isNotFound(err)) {
      throw new ToolError(
        'PATH_NOT_FOUND',
        `cannot remove ${path}: ${dir === '' ? '/' : dir} does not exist at ${branch}. ` +
          `NOTHING was written.`,
        { path, branch },
      );
    }
    if (isWrongType(err)) {
      throw new ToolError(
        'NOT_A_TREE',
        `cannot remove ${path}: ${dir === '' ? '/' : dir} is not a directory at ${branch}`,
        { path, branch },
      );
    }
    throw err;
  }

  const entry = entries.find((e) => e.path === name);
  if (entry === undefined) {
    throw new ToolError(
      'PATH_NOT_FOUND',
      `cannot remove ${path}: no such file at ${branch}. NOTHING was written. A removal ` +
        `is never a no-op here -- if it were, a typo would report a deletion that ` +
        `deleted nothing.`,
      { path, branch },
    );
  }
  if (entry.type !== 'blob') {
    // No recursive directory removal, deliberately: the blast radius of one
    // wrong path would be everything underneath it. Name each file.
    const what = entry.mode === MODE_GITLINK ? 'submodule' : entry.type;
    throw new ToolError(
      'BAD_REQUEST',
      `cannot remove ${path}: it is a ${what}, not a file. This API removes one named ` +
        `file per entry; there is no recursive removal, no glob and no prefix. Name ` +
        `each file you want gone.`,
      { path, branch, mode: entry.mode, type: entry.type },
    );
  }
  if (entry.mode === MODE_SYMLINK) {
    throw new ToolError(
      'BAD_REQUEST',
      `cannot remove ${path}: it is a symlink (mode ${entry.mode}). Removing a symlink ` +
        `is a structural change this API does not perform, exactly as writing over one ` +
        `is not.`,
      { path, branch, mode: entry.mode, type: entry.type },
    );
  }

  return { oid: entry.oid, mode: entry.mode };
}

/** One entry of a proposal after its bytes have been named, any of three ways. */
type NormalizedFile =
  | { path: string; content: string; copyFrom: null; remove: false }
  | { path: string; content: null; copyFrom: ProposeCopyFrom; remove: false }
  | { path: string; content: null; copyFrom: null; remove: true };

/** One resolved entry of a proposal, as reported back to the caller. */
interface ProposedFile {
  path: string;
  /**
   * The blob this entry PUTS at `path`. `null` for a removal, which puts
   * nothing there -- the oid of what was taken away is reported as
   * `source.removedBlobOid` instead, so the two can never be confused.
   */
  blobOid: string | null;
  /**
   * Byte length for a `content` entry. `null` for a copy: the source blob is
   * deliberately never materialised, so the server does not know its size and
   * will not guess one. `blobOid` is what the caller verifies against, and it
   * is present for both forms that write. `null` for a removal.
   */
  size: number | null;
  source:
    | { kind: 'content' }
    | { kind: 'copy'; path: string; ref: string; refName: string | null; commit: string }
    /**
     * `removedBlobOid` is what the caller verifies a removal against, the way
     * `blobOid` verifies a write: it is the oid the path actually held in the
     * base tree at the moment it was removed.
     */
    | { kind: 'delete'; removedBlobOid: string; mode: string };
}

// ---------------------------------------------------------------------------
// 5. git_propose
// ---------------------------------------------------------------------------

/**
 * Write whole-file contents as a new commit object. THE REF IS NOT MOVED.
 *
 * This is step 1 of 07-refs §4.3's ordering ("upload every new object; await
 * success for all of them"), and nothing more. Until `git_push` succeeds the
 * new objects are unreachable from any ref, which is 07-refs §4.2 Case A:
 * invisible to every reader, harmless, and reclaimed by `repair.ts` after the
 * grace period if the agent abandons the proposal.
 *
 * Splitting propose from push is not ceremony. It is what makes the CAS
 * meaningful: the agent must state, in `git_push`, the value it believes the
 * branch holds. A combined "commit and move the branch" call would have to
 * read the head itself, and that read-then-write is precisely the blind
 * overwrite this system exists to eliminate.
 */
export async function gitPropose(
  ctx: ServerContext,
  args: {
    branch: string;
    files: Array<{
      path: string;
      content?: string | null;
      copy_from?: ProposeCopyFrom | null;
      delete?: boolean | null;
    }>;
    message: string;
    author?: { name: string; email: string };
  },
) {
  const refName = assertBranchName(args.branch);

  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw badRequest(
      'files must be a non-empty array of { path, content }, { path, copy_from } or ' +
        '{ path, delete: true }',
    );
  }
  if (args.files.length > ctx.cfg.maxProposeFiles) {
    throw new ToolError(
      'TOO_MANY_FILES',
      `${args.files.length} files in one proposal, limit is ${ctx.cfg.maxProposeFiles}`,
      { count: args.files.length, limit: ctx.cfg.maxProposeFiles },
    );
  }
  if (typeof args.message !== 'string' || args.message.trim() === '') {
    throw badRequest('message must be a non-empty commit message');
  }

  const seen = new Set<string>();
  const normalized: NormalizedFile[] = args.files.map((file): NormalizedFile => {
    const path = normalizeRepoPath(file.path, { allowRoot: false });
    if (seen.has(path)) {
      throw badRequest(`duplicate path in files: ${path}`, { path });
    }
    seen.add(path);
    const hasContent = file.content !== undefined && file.content !== null;
    const hasCopy = file.copy_from !== undefined && file.copy_from !== null;

    // `delete` is boolean-or-absent. There is deliberately no `delete: false`
    // form: it names no operation, and reading it as "leave this file alone"
    // would make an entry that does nothing look like an entry that did
    // something. Omitting the entry is how you leave a file alone.
    const del = file.delete;
    if (del !== undefined && del !== null && typeof del !== 'boolean') {
      throw badRequest(
        `files[${path}].delete must be the boolean true, or be omitted`,
        { path, delete: del },
      );
    }
    if (del === false) {
      throw badRequest(
        `files[${path}] sets delete:false, which names no operation. To remove the path ` +
          `send delete:true; to leave it alone, omit the entry entirely.`,
        { path },
      );
    }
    const hasDelete = del === true;

    const chosen = (hasContent ? 1 : 0) + (hasCopy ? 1 : 0) + (hasDelete ? 1 : 0);
    if (chosen > 1) {
      throw badRequest(
        `files[${path}] sets ${chosen} of content, copy_from and delete. EXACTLY ONE is ` +
          `required: content sends the bytes, copy_from names an existing blob to reuse, ` +
          `delete:true removes the path.`,
        { path, content: hasContent, copy_from: hasCopy, delete: hasDelete },
      );
    }
    if (chosen === 0) {
      throw badRequest(
        `files[${path}] sets none of content, copy_from and delete. Exactly one is ` +
          `required; an entry with none would write an empty file.`,
        { path, content: false, copy_from: false, delete: false },
      );
    }
    if (hasContent && typeof file.content !== 'string') {
      throw badRequest(`files[${path}].content must be a string`, { path });
    }
    if (hasDelete) return { path, content: null, copyFrom: null, remove: true };
    return hasContent
      ? { path, content: file.content as string, copyFrom: null, remove: false }
      : { path, content: null, copyFrom: file.copy_from as ProposeCopyFrom, remove: false };
  });

  // Only bytes that actually CROSSED THE WIRE count against the cap. A copy
  // sends none, which is the entire point of it.
  const totalBytes = normalized.reduce(
    (n, f) => n + (f.content === null ? 0 : Buffer.byteLength(f.content, 'utf8')),
    0,
  );
  if (totalBytes > ctx.cfg.maxProposeBytes) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `proposal is ${totalBytes} bytes, over the ${ctx.cfg.maxProposeBytes}-byte limit`,
      { bytes: totalBytes, limit: ctx.cfg.maxProposeBytes },
    );
  }

  // The base is read here ONLY to build the commit's parent and base tree. It
  // is NOT a claim about what the branch will hold at push time; the CAS in
  // git_push is what decides that.
  const baseOid = await gate(ctx).readExactRef(refName);

  let baseTree: string | null = null;
  if (baseOid !== null) {
    try {
      const { commit } = await git.readCommit({
        fs: fsClient(deps(ctx)),
        gitdir: ctx.gitdir,
        cache: ctx.cache,
        oid: baseOid,
      });
      baseTree = commit.tree;
    } catch (err) {
      if (isNotFound(err)) {
        throw new ToolError(
          'OBJECT_NOT_FOUND',
          `branch ${args.branch} points at ${baseOid}, which is not readable in the object store`,
          { branch: args.branch, oid: baseOid },
        );
      }
      throw err;
    }
  }

  // Blobs first. Content-addressed and immutable, so writing them is safe even
  // if the eventual push loses its race. A COPY WRITES NOTHING HERE: its blob is
  // already in the store, and resolving it costs one tree read.
  const written: ProposedFile[] = [];
  for (const file of normalized) {
    if (file.remove) {
      // Resolved against the base tree, and refused if it is not there. No
      // object is written for a removal; the work is entirely in the tree.
      const gone = await resolveDeleteTarget(ctx, args.branch, baseTree, file.path);
      written.push({
        path: file.path,
        blobOid: null,
        size: null,
        source: { kind: 'delete', removedBlobOid: gone.oid, mode: gone.mode },
      });
      continue;
    }
    if (file.copyFrom !== null) {
      const src = await resolveCopySource(ctx, file.path, file.copyFrom);
      written.push({
        path: file.path,
        blobOid: src.oid,
        size: null,
        source: {
          kind: 'copy',
          path: src.path,
          ref: src.ref,
          refName: src.refName,
          commit: src.commit,
        },
      });
      continue;
    }
    const blob = Buffer.from(file.content, 'utf8');
    const blobOid = await git.writeBlob({
      fs: fsClient(deps(ctx)),
      gitdir: ctx.gitdir,
      blob,
    });
    written.push({ path: file.path, blobOid, size: blob.byteLength, source: { kind: 'content' } });
  }

  const treeOid = await buildTree(
    deps(ctx),
    baseTree,
    written
      .filter((w) => w.source.kind !== 'delete')
      .map((w) => ({ path: w.path, oid: w.blobOid as string })),
    written.filter((w) => w.source.kind === 'delete').map((w) => w.path),
  );

  const now = Math.floor(Date.now() / 1000);
  const identity = {
    name: args.author?.name ?? ctx.cfg.authorName,
    email: args.author?.email ?? ctx.cfg.authorEmail,
    timestamp: now,
    // UTC. The server has no business inventing a timezone for an agent.
    timezoneOffset: 0,
  };

  const commitOid = await git.writeCommit({
    fs: fsClient(deps(ctx)),
    gitdir: ctx.gitdir,
    commit: {
      message: args.message.endsWith('\n') ? args.message : `${args.message}\n`,
      tree: treeOid,
      parent: baseOid === null ? [] : [baseOid],
      author: identity,
      committer: identity,
    },
  });

  return {
    ok: true as const,
    branch: args.branch,
    refName,
    commitOid,
    treeOid,
    /** The branch head this commit was built on. `null` = new branch. */
    baseOid,
    parents: baseOid === null ? [] : [baseOid],
    files: written,
    /** How many entries reused an existing blob instead of sending bytes. */
    copied: written.filter((w) => w.source.kind === 'copy').length,
    /**
     * How many entries REMOVED a path. The paths themselves, and the blob oid
     * each one held when it was removed, are in `files` above -- every removal
     * is an entry whose `source.kind` is `delete`.
     */
    deleted: written.filter((w) => w.source.kind === 'delete').length,
    /** Every path this commit removes, so a caller can verify at a glance. */
    deletedPaths: written.filter((w) => w.source.kind === 'delete').map((w) => w.path),
    /** Bytes that actually crossed the wire. A copy contributes zero. */
    bytesSent: totalBytes,
    refMoved: false,
    next:
      `Nothing is visible yet: the branch still points at ${baseOid ?? '(nothing)'}. ` +
      `Call git_push with branch=${JSON.stringify(args.branch)}, ` +
      `expected_oid=${baseOid === null ? 'null' : JSON.stringify(baseOid)}, ` +
      `commit_oid=${JSON.stringify(commitOid)}.`,
  };
}

// ---------------------------------------------------------------------------
// 6. git_push
// ---------------------------------------------------------------------------

/**
 * Derive the refs-layer CAS code from what `pushRef` reports.
 *
 * `pushRef` collapses `CasResult` into a `PushOutcome` and drops the
 * `CasFailureCode`, but the mapping is total and is exactly the one
 * `RefStore.compareAndSetRef` applies (refs.ts:199-206):
 *
 *   expectedOid === null                 -> ALREADY_EXISTS (create lost)
 *   expectedOid !== null, actual === null -> NOT_FOUND      (deleted under us)
 *   otherwise                             -> STALE          (someone pushed first)
 *
 * Re-deriving it here keeps push.ts, which owns the safe ORDERING, unchanged.
 */
function casCode(
  expectedOid: string | null,
  actualOid: string | null,
): 'STALE' | 'ALREADY_EXISTS' | 'NOT_FOUND' {
  if (expectedOid === null) return 'ALREADY_EXISTS';
  if (actualOid === null) return 'NOT_FOUND';
  return 'STALE';
}

export async function gitPush(
  ctx: ServerContext,
  args: { branch: string; expected_oid: string | null; commit_oid: string },
) {
  const refName = assertBranchName(args.branch);

  if (!isOid(args.commit_oid)) {
    throw badRequest(
      'commit_oid must be the 40-hex commitOid returned by git_propose',
      { commit_oid: args.commit_oid },
    );
  }
  const expectedOid = args.expected_oid ?? null;
  if (expectedOid !== null && !isOid(expectedOid)) {
    throw badRequest(
      'expected_oid must be a 40-hex oid, or null to CREATE the branch',
      { expected_oid: args.expected_oid },
    );
  }

  // ---- Fence, strengthened. ------------------------------------------------
  // push.ts step 2 checks `hasLoose(tip) || some complete pack pair exists`,
  // and that second disjunct passes vacuously once the repo contains ANY
  // complete pack -- 07-refs says so itself ("a full check would parse each
  // .idx fanout table"). Reading the commit through `readCommit` is the real
  // check: it exercises the exact code path every subsequent reader will use,
  // loose or packed. Still strictly BEFORE the CAS, so the §4.3 ordering
  // (objects -> fence -> fast-forward -> ref) is preserved, not weakened.
  try {
    await git.readCommit({
      fs: fsClient(deps(ctx)),
      gitdir: ctx.gitdir,
      cache: ctx.cache,
      oid: args.commit_oid,
    });
  } catch (err) {
    if (isNotFound(err) || isWrongType(err)) {
      throw new ToolError(
        'NOT_DURABLE',
        `refusing to move ${refName}: commit ${args.commit_oid} is not readable in the ` +
          `object store. Call git_propose first and push the commitOid it returns.`,
        { branch: args.branch, commit_oid: args.commit_oid },
      );
    }
    throw err;
  }

  let outcome: PushOutcome;
  try {
    outcome = await pushRef(
      {
        refs: ctx.refs,
        objects: ctx.objects,
        fs: fsClient(deps(ctx)),
        gitdir: ctx.gitdir,
        // Module-level, hoisted. Never a fresh object per request.
        cache: ctx.cache,
        // The 05-adapter fs writes straight through to GCS, so by the time
        // git_propose returned, every object was already durable in the bucket.
        // There is no separate upload phase to perform here -- but step 2 of
        // push.ts (the readability fence) still runs, and that is the check
        // that actually matters.
        uploadObjects: async () => {},
      },
      {
        repoId: ctx.cfg.repoId,
        refName,
        expectedOid,
        newOid: args.commit_oid,
        // No force. This API does not offer a force push; rewriting published
        // history is a human decision, not a tool parameter.
        force: false,
      },
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('push aborted:')) {
      throw new ToolError('NOT_DURABLE', err.message, {
        branch: args.branch,
        commit_oid: args.commit_oid,
      });
    }
    throw err;
  }

  if (outcome.ok) {
    return {
      ok: true as const,
      branch: args.branch,
      ref: outcome.ref,
      oid: outcome.oid,
      previousOid: outcome.previousOid,
      created: outcome.previousOid === null,
    };
  }

  if (outcome.reason === 'non-fast-forward') {
    return {
      ok: false as const,
      code: 'NON_FAST_FORWARD' as const,
      ref: outcome.ref,
      branch: args.branch,
      expectedOid,
      actualOid: outcome.remoteOid,
      message: outcome.message,
      // NOT retried. See below.
      retried: false,
      remedy:
        `${args.commit_oid} is not a descendant of ${expectedOid}. Re-read the branch ` +
        `with git_log, rebuild your change on top of it with git_propose, and push again.`,
    };
  }

  // ---- The lost race. -----------------------------------------------------
  // THIS IS NOT RETRIED, HERE OR ANYWHERE ELSE IN THIS PROCESS.
  //
  // 07-refs §1.5: "Re-reading the ref and re-issuing the CAS with the newly
  // observed value converts a compare-and-swap into a blind overwrite with
  // extra steps, and silently discards the winner's commits. A mismatch is a
  // semantic answer, not a transient fault."
  //
  // The agent is handed the winning oid so it can go back to the top: read the
  // new head, rebuild, propose, push. Only the caller knows whether that is
  // safe for its change.
  const code = casCode(expectedOid, outcome.remoteOid);
  return {
    ok: false as const,
    code,
    ref: outcome.ref,
    branch: args.branch,
    expectedOid,
    actualOid: outcome.remoteOid,
    nonFastForward: true,
    /** Rendered by 07-refs `formatCasFailure` -- git's own idiom. */
    message: outcome.message,
    retried: false,
    remedy:
      code === 'ALREADY_EXISTS'
        ? `Branch ${args.branch} already exists at ${outcome.remoteOid}. Push again with ` +
          `expected_oid=${JSON.stringify(outcome.remoteOid)} if you meant to update it.`
        : code === 'NOT_FOUND'
          ? `Branch ${args.branch} was deleted by another writer. Your update was NOT applied.`
          : `Your update was NOT applied and nothing was overwritten. The branch is now at ` +
            `${outcome.remoteOid}. Re-read it, rebuild your change on top of it with ` +
            `git_propose, and push again. This server will never retry a lost CAS for you.`,
  };
}

export type { Config };
