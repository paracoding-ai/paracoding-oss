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

import { createHash } from 'crypto';

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
      //
      // [PCGIT-UNARMED-MSG-V1] AND THE COMMONEST CAUSE IS NOT CORRUPTION. This
      // message used to name repository repair and point at 07-refs repair.ts
      // verifyRepo. On a container whose git-object VAULT REGISTRY has not been
      // armed yet -- index.ts logs '[gittools] git-object vault registry NOT armed
      // at boot', and it re-arms on the first MCP connection -- a freshly promoted
      // revision reads a PERFECTLY INTACT object and cannot decrypt it, which
      // surfaces here as NotFound. Sending the reader to a repair tool for that is
      // worse than saying nothing: repair is destructive, the store is fine, and
      // the condition clears itself on the next call. Name the real cause first.
      throw new ToolError(
        'OBJECT_NOT_FOUND',
        `ref ${resolved.refName ?? ref} points at ${resolved.oid}, which is not readable ` +
          `in the object store. THIS IS ALMOST CERTAINLY NOT REPOSITORY CORRUPTION. On a ` +
          `freshly promoted revision it means the git-object VAULT REGISTRY IS NOT ARMED ` +
          `YET, so an intact object cannot be decrypted; the registry arms on an MCP ` +
          `connection. FIX: make any other ordinary MCP call (whoami will do), then retry ` +
          `this one. DO NOT attempt a repair -- do not run 07-refs repair.ts verifyRepo -- ` +
          `unless the retry fails the same way after the registry is confirmed armed ` +
          `(the service log line is '[gittools] git-object vault registry armed for epoch(s)').`,
        { ref, refName: resolved.refName, oid: resolved.oid, likely_cause: 'vault_registry_not_armed' },
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

// ---------------------------------------------------------------------------
// 5c. upload-the-bytes-over-HTTP, then NAME YOUR OWN UPLOAD  [SEC-PROPOSE-UPLOAD-V1]
// ---------------------------------------------------------------------------

/**
 * The TTL on an upload record. An hour is long enough for a caller to POST a
 * tree's worth of files and then propose them, and short enough that a record
 * is not a standing capability sitting in Firestore for a week.
 */
const UPLOAD_TTL_MS = 3600_000;

/**
 * The upload record's document id, and the ONLY place it is spelled, so the
 * writer and the resolver cannot drift into addressing two different documents.
 *
 * The agent name is checked rather than trusted: a `/` in it would turn one
 * document path into a collection path -- Firestore would throw an internal
 * error, and a name that merely SHIFTED the segments would address a document
 * belonging to nobody. An identity this API cannot spell is a refusal.
 */
function assertUploadAgent(agent: string): void {
  if (agent.indexOf('/') >= 0 || agent.indexOf('\0') >= 0) {
    throw badRequest(
      `agent ${JSON.stringify(agent)} cannot own an upload: an agent name may not contain a ` +
        `slash, because the upload record is addressed by it and a slash would name a ` +
        `different document than the one being checked. NOTHING was written.`,
      { agent },
    );
  }
}

function uploadDocId(blobOid: string, agent: string): string {
  assertUploadAgent(agent);
  return `${blobOid}.${agent}`;
}

/**
 * Take raw bytes off an HTTP request, write them as a git blob, and record that
 * THIS agent is the one who supplied them.
 *
 * WHY THIS EXISTS: `content` is bytes a language model retyped. For a 600KB
 * source file that is hundreds of thousands of generated tokens where a single
 * dropped space is a broken file, and it is the largest single cost in this
 * project. `copy_from` already removes that cost for bytes ALREADY in the
 * repository; this removes it for bytes that are not, by letting a machine PUT
 * them over HTTP where no model ever sees them.
 *
 * THE RECORD IS NOT BOOKKEEPING, IT IS THE AUTHORISATION. `resolveUploadSource`
 * refuses anything it cannot find here, so this write is the whole reason an
 * `uploaded` entry may name an oid at all. Read the doc comment on
 * `ProposeUploaded` for the argument.
 *
 * THE DOC ID IS COMPOSITE, `${blobOid}.${agent}`, AND THAT IS LOAD-BEARING. Two
 * agents uploading identical bytes produce the SAME oid; one shared document
 * would then mean agent A's upload authorises agent B's `uploaded` entry, which
 * is exactly the "an oid is a lookup key" hole this design refuses. Keying by
 * both makes a record a statement about ONE agent and nothing else.
 */
export async function gitUploadBlob(
  ctx: ServerContext,
  bytes: Buffer,
  agent: string,
): Promise<{ blobOid: string; sha256: string; size: number; expiresAtMs: number }> {
  if (typeof agent !== 'string' || agent.trim() === '') {
    throw badRequest(
      'an upload needs a resolved agent identity and none was supplied. The upload record ' +
        'is the only thing that later authorises files[].uploaded, so a record written ' +
        'without an owner would be one no agent could claim -- or one every agent could. ' +
        'NOTHING was written.',
    );
  }
  // Checked BEFORE the blob is written, so an unspellable identity costs nothing.
  assertUploadAgent(agent);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw badRequest(
      'the request body was empty. An upload must carry the raw bytes of exactly one file; ' +
        'an empty body would register a zero-byte blob that a later proposal would write ' +
        'over a real file. NOTHING was written.',
      { size: Buffer.isBuffer(bytes) ? bytes.length : 0 },
    );
  }
  if (bytes.length > ctx.cfg.maxBlobBytes) {
    throw new ToolError(
      'FILE_TOO_LARGE',
      `upload is ${bytes.length} bytes, over the ${ctx.cfg.maxBlobBytes}-byte limit. ` +
        `NOTHING was written.`,
      { bytes: bytes.length, limit: ctx.cfg.maxBlobBytes },
    );
  }

  // The SAME writeBlob the `content` arm performs, so an uploaded file and a
  // typed one produce byte-identical objects and the same oid. There is no
  // second write path into the object store.
  const blobOid = await git.writeBlob({
    fs: fsClient(deps(ctx)),
    gitdir: ctx.gitdir,
    blob: bytes,
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const nowMs = Date.now();
  const expiresAtMs = nowMs + UPLOAD_TTL_MS;

  // Written AFTER the blob and AWAITED. If this write fails the caller gets an
  // error and no usable record, which is the safe direction: an unreferenced
  // blob is 07-refs §4.2 Case A -- invisible and reclaimable -- while a record
  // pointing at bytes that were never stored would resolve and then build a
  // tree around an object that is not there.
  await ctx.firestore
    .collection('git_uploads')
    .doc(uploadDocId(blobOid, agent))
    .set({
      agent,
      blob_oid: blobOid,
      sha256,
      size: bytes.length,
      created_ms: nowMs,
      exp_ms: expiresAtMs,
    });

  return { blobOid, sha256, size: bytes.length, expiresAtMs };
}

/**
 * Name bytes THE CALLER THEMSELVES just uploaded as the source of a proposed
 * file, instead of retyping them into `content`.
 *
 * WHY THIS DOES NOT BREAK THE BARE-OID RULE ABOVE, AND THIS IS THE WHOLE
 * AUTHORISATION ARGUMENT. `copy_from`'s comment says an oid is NEVER a lookup
 * key, because handing an oid to the object store would let a caller mount ANY
 * object into a visible tree -- including another writer's abandoned proposal,
 * which is unreachable from every ref precisely so that it stays invisible.
 * That rule is unchanged here, because `blob_oid` is STILL not a lookup key.
 * It is a lookup key into the UPLOAD RECORD, `git_uploads/{blob_oid}.{agent}`,
 * and the record only exists because this same agent POSTed those exact bytes
 * to /git/blob minutes ago. So an `uploaded` entry reaches exactly one thing:
 * bytes the caller already had in their hand. It grants no read reach at all --
 * the caller cannot learn anything about an object they did not supply -- and
 * the write reach is identical to having typed the same bytes into `content`.
 *
 * THE RECORD IS THEREFORE LOAD-BEARING AND ITS ABSENCE IS ALWAYS A REFUSAL. If
 * a record does not exist, is expired, or belongs to a DIFFERENT agent, then
 * the sentence "these are bytes you supplied" is not true, and resolving anyway
 * would degrade this into the bare-oid form: agent B naming agent A's blob, or
 * naming any oid at all and discovering by the response whether it exists. So
 * every one of those cases REFUSES and NOTHING is written. There is no fallback
 * to the object store, and there must never be one.
 *
 * WHAT THIS DOES NOT WIDEN: the destination. An uploaded file goes through the
 * same `buildTree` onto the same branch as a `content` file, so every path
 * rule, every structural refusal and the branch-name check apply unchanged.
 */
export interface ProposeUploaded {
  /** The blobOid returned by the /git/blob upload this same agent performed. */
  blob_oid: string;
  /** OPTIONAL assertion. Refuse unless the recorded sha256 equals this. */
  sha256?: string | null;
}

async function resolveUploadSource(
  ctx: ServerContext,
  destPath: string,
  src: ProposeUploaded,
  uploader: string,
): Promise<{ oid: string; sha256: string; size: number }> {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) {
    throw badRequest(`files[${destPath}].uploaded must be an object { blob_oid }`, {
      path: destPath,
    });
  }
  if (typeof uploader !== 'string' || uploader.trim() === '') {
    // No identity means no record can be addressed, and there is deliberately no
    // "any agent's upload will do" branch: that IS the bare-oid form.
    throw badRequest(
      `files[${destPath}].uploaded needs a resolved agent identity, and this call carries ` +
        `none. An upload is authorised by being YOURS, so a proposal that cannot say who it ` +
        `is cannot claim one. The call was REFUSED rather than run unattributed, and ` +
        `NOTHING was written.`,
      { path: destPath },
    );
  }
  if (typeof src.blob_oid !== 'string' || !isOid(src.blob_oid)) {
    throw badRequest(`files[${destPath}].uploaded.blob_oid must be a 40-char lowercase hex oid`, {
      path: destPath,
      blob_oid: src.blob_oid,
    });
  }

  const snap = await ctx.firestore
    .collection('git_uploads')
    .doc(uploadDocId(src.blob_oid, uploader))
    .get();
  if (!snap.exists) {
    // ONE refusal for three real causes, and it names all three, because the
    // server must not tell the caller WHICH: "uploaded by someone else" versus
    // "never uploaded" is exactly the existence oracle that naming a bare oid
    // would have bought.
    throw badRequest(
      `files[${destPath}].uploaded names ${src.blob_oid}, which is not an upload this agent ` +
        `can claim. Either those bytes were never POSTed to /git/blob, or they were ` +
        `uploaded by a DIFFERENT agent, or the upload has expired (uploads live ` +
        `${UPLOAD_TTL_MS / 60000} minutes). An oid is never a lookup key here -- an upload ` +
        `is resolved only against a record of YOUR OWN upload. Re-POST the bytes to ` +
        `/git/blob and use the blobOid it returns. NOTHING was written.`,
      { path: destPath, blob_oid: src.blob_oid },
    );
  }
  const rec = (snap.data() || {}) as {
    agent?: unknown;
    sha256?: unknown;
    size?: unknown;
    exp_ms?: unknown;
  };
  const expMs = Number(rec.exp_ms ?? 0);
  if (!(expMs > 0) || Date.now() > expMs) {
    throw badRequest(
      `files[${destPath}].uploaded names ${src.blob_oid}, whose upload EXPIRED at ` +
        `${expMs > 0 ? new Date(expMs).toISOString() : '(no expiry recorded)'}. Uploads live ` +
        `${UPLOAD_TTL_MS / 60000} minutes; re-POST the bytes to /git/blob and use the ` +
        `blobOid it returns. NOTHING was written.`,
      { path: destPath, blob_oid: src.blob_oid, exp_ms: expMs, now_ms: Date.now() },
    );
  }

  const recordedSha = typeof rec.sha256 === 'string' ? rec.sha256 : '';
  if (src.sha256 !== undefined && src.sha256 !== null) {
    if (src.sha256 !== recordedSha) {
      throw badRequest(
        `files[${destPath}].uploaded.sha256 says ${src.sha256}, but the upload recorded for ` +
          `${src.blob_oid} is ${recordedSha || '(none recorded)'}. NOTHING was written. ` +
          `Either you are naming a different upload than you think, or the bytes that ` +
          `arrived are not the bytes you sent.`,
        {
          path: destPath,
          blob_oid: src.blob_oid,
          expected: src.sha256,
          actual: recordedSha || null,
        },
      );
    }
  }

  // THE RECORD IS NOT PROOF THE BLOB IS STILL THERE. Firestore and the object
  // store are two systems, and repair.ts reclaims unreferenced loose objects
  // after a grace period -- so a record can outlive its bytes. Building a tree
  // around a missing object would produce a commit that pushes and then fails
  // to read, which is the one failure this package refuses to ship. Checked
  // without materialising the blob: an upload may be tens of megabytes and its
  // presence is the only question being asked.
  const present =
    (await ctx.objects.hasLoose(src.blob_oid)) ||
    (await ctx.objects.packContaining(src.blob_oid)) !== null;
  if (!present) {
    throw new ToolError(
      'OBJECT_NOT_FOUND',
      `files[${destPath}].uploaded names ${src.blob_oid}, which this agent did upload, but ` +
        `that object is no longer readable in the object store. Re-POST the bytes to ` +
        `/git/blob and use the blobOid it returns. NOTHING was written.`,
      { path: destPath, blob_oid: src.blob_oid },
    );
  }

  return { oid: src.blob_oid, sha256: recordedSha, size: Number(rec.size ?? 0) };
}

/** One entry of a proposal after its bytes have been named, any of four ways. */
type NormalizedFile =
  | { path: string; content: string; copyFrom: null; uploaded: null; remove: false }
  | { path: string; content: null; copyFrom: ProposeCopyFrom; uploaded: null; remove: false }
  | { path: string; content: null; copyFrom: null; uploaded: ProposeUploaded; remove: false }
  | { path: string; content: null; copyFrom: null; uploaded: null; remove: true };

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
   * Byte length for a `content` entry, and for an `upload`, whose size the
   * upload record measured when the bytes arrived. `null` for a copy: the
   * source blob is deliberately never materialised, so the server does not know
   * its size and will not guess one. `blobOid` is what the caller verifies
   * against, and it is present for every form that writes. `null` for a
   * removal.
   */
  size: number | null;
  source:
    | { kind: 'content' }
    | { kind: 'copy'; path: string; ref: string; refName: string | null; commit: string }
    /**
     * `sha256` is the digest recorded when the bytes were uploaded, so a caller
     * can check the file it PUT is the file that landed in the tree without
     * reading anything back.
     */
    | { kind: 'upload'; sha256: string }
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
      uploaded?: ProposeUploaded | null;
      delete?: boolean | null;
    }>;
    message: string;
    author?: { name: string; email: string };
    /**
     * The agent this call is attributed to, resolved by the transport and NEVER
     * taken from the tool arguments a model wrote. It is the only thing that
     * can claim an upload, so a spoofable value here would hand one agent's
     * uploads to another.
     */
    uploader?: string;
  },
) {
  const refName = assertBranchName(args.branch);

  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw badRequest(
      'files must be a non-empty array of { path, content }, { path, copy_from }, ' +
        '{ path, uploaded } or { path, delete: true }',
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
    const hasUploaded = file.uploaded !== undefined && file.uploaded !== null;

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

    const chosen =
      (hasContent ? 1 : 0) + (hasCopy ? 1 : 0) + (hasUploaded ? 1 : 0) + (hasDelete ? 1 : 0);
    if (chosen > 1) {
      throw badRequest(
        `files[${path}] sets ${chosen} of content, copy_from, uploaded and delete. EXACTLY ` +
          `ONE is required: content sends the bytes, copy_from names an existing blob to ` +
          `reuse, uploaded names bytes you already POSTed to /git/blob, delete:true removes ` +
          `the path.`,
        {
          path,
          content: hasContent,
          copy_from: hasCopy,
          uploaded: hasUploaded,
          delete: hasDelete,
        },
      );
    }
    if (chosen === 0) {
      throw badRequest(
        `files[${path}] sets none of content, copy_from, uploaded and delete. Exactly one is ` +
          `required; an entry with none would write an empty file.`,
        { path, content: false, copy_from: false, uploaded: false, delete: false },
      );
    }
    if (hasContent && typeof file.content !== 'string') {
      throw badRequest(`files[${path}].content must be a string`, { path });
    }
    if (hasDelete) return { path, content: null, copyFrom: null, uploaded: null, remove: true };
    if (hasUploaded) {
      return {
        path,
        content: null,
        copyFrom: null,
        uploaded: file.uploaded as ProposeUploaded,
        remove: false,
      };
    }
    return hasContent
      ? { path, content: file.content as string, copyFrom: null, uploaded: null, remove: false }
      : {
          path,
          content: null,
          copyFrom: file.copy_from as ProposeCopyFrom,
          uploaded: null,
          remove: false,
        };
  });

  // Only bytes that actually CROSSED THE WIRE count against the cap. A copy
  // sends none, which is the entire point of it. NEITHER DOES AN UPLOAD, and
  // for the same reason read the other way: its bytes went over HTTP straight
  // into the object store before this call existed, so they never passed
  // through the tool transport and counting them here would cap the exact case
  // this feature exists to make cheap -- landing a file far larger than any
  // model should ever retype. The size the upload is allowed to be was already
  // decided at /git/blob, against cfg.maxBlobBytes.
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
    if (file.uploaded !== null) {
      // NO writeBlob HERE EITHER: the blob was written by /git/blob when the
      // bytes arrived, and this resolves the caller's own upload record to it.
      // A record that is absent, expired, or another agent's REFUSES inside
      // resolveUploadSource and this loop never reaches the tree build.
      const src = await resolveUploadSource(
        ctx,
        file.path,
        file.uploaded,
        String(args.uploader ?? ''),
      );
      written.push({
        path: file.path,
        blobOid: src.oid,
        size: src.size,
        source: { kind: 'upload', sha256: src.sha256 },
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
     * How many entries named bytes this agent had already POSTed to /git/blob.
     * Each one's recorded sha256 is in `files` above, as `source.sha256`.
     */
    uploaded: written.filter((w) => w.source.kind === 'upload').length,
    /**
     * How many entries REMOVED a path. The paths themselves, and the blob oid
     * each one held when it was removed, are in `files` above -- every removal
     * is an entry whose `source.kind` is `delete`.
     */
    deleted: written.filter((w) => w.source.kind === 'delete').length,
    /** Every path this commit removes, so a caller can verify at a glance. */
    deletedPaths: written.filter((w) => w.source.kind === 'delete').map((w) => w.path),
    /** Bytes that actually crossed the wire. A copy or an upload contributes zero. */
    bytesSent: totalBytes,
    /**
     * Bytes that arrived over /git/blob and were written into the tree WITHOUT
     * crossing this tool's wire. Counted separately from bytesSent on purpose:
     * adding them together would hide the one number this feature exists to
     * drive to zero.
     */
    bytesUploaded: written.reduce(
      (n, w) => n + (w.source.kind === 'upload' ? (w.size ?? 0) : 0),
      0,
    ),
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
