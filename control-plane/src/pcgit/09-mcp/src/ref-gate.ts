/**
 * 09-mcp / ref-gate.ts
 *
 * ===========================================================================
 * THIS FILE IS THE COMPARE-AND-SWAP WRAPPER, AND IT SITS ABOVE ISOMORPHIC-GIT.
 * ===========================================================================
 *
 * 05-adapter states the limitation plainly: it does NOT implement ref CAS,
 * because isomorphic-git's `GitRefManager.writeRef` is
 *
 *     await fs.write(join(gitdir, ref), `${value.trim()}\n`, 'utf8')
 *
 * -- a blind overwrite -- and the `fs` seam has no compare-and-swap primitive
 * to hang a precondition on. You cannot fix that from below. So this package
 * fixes it from above, with two mechanisms that work together:
 *
 * (1) READS NEVER GO THROUGH isomorphic-git's REF RESOLUTION.
 *     `resolveRef` answers ref-name -> oid from the Firestore ref documents
 *     (07-refs `RefStore`), which are the authoritative value. Every
 *     isomorphic-git call in this package is then handed a 40-hex OID, never a
 *     symbolic name. `GitRefManager.resolve` short-circuits on a 40-hex string
 *     before it touches the filesystem at all (index.cjs:2255), so
 *     isomorphic-git never reads `.git/refs/**` and can never serve a stale or
 *     divergent ref value from the fs adapter.
 *
 * (2) WRITES THROUGH THE fs SEAM ARE FORBIDDEN, LOUDLY.
 *     `guardRefWrites` wraps the adapter and rejects any write, unlink or
 *     symlink aimed at `.git/refs/**`, `HEAD`, `packed-refs`, `FETCH_HEAD` or
 *     `ORIG_HEAD` with EPERM. Today nothing in this server calls a
 *     ref-mutating isomorphic-git API; the guard exists so that the day
 *     somebody adds `git.commit()` or `git.branch()` or `git.pull()`, they get
 *     an immediate, explanatory failure instead of a silent blind overwrite
 *     that quietly discards another agent's push. It converts an invisible
 *     correctness hazard into a crash at the first call.
 *
 * The only path that moves a ref is `RefStore.compareAndSetRef`, reached
 * through 07-refs' `pushRef`, reached through `gitPush`. ONE DOOR AT THIS
 * LAYER -- but gitPush itself has THREE callers, and this comment used to say
 * "through the `git_push` tool", which stopped being true when POST /git/sync
 * gained gitLaneSyncFromUpstream. Corrected rather than deleted, because the
 * narrowness below gitPush is real and load-bearing: it is why
 * [PCGIT-PROTECTED-REFS-V1] could be placed in gitPush and cover every caller.
 * See the callers enumerated there before adding a fourth.
 *
 * -- rmdir arity note ------------------------------------------------------
 * `FileSystem.js:130` adopts any `rmdir` whose `.length > 1` as the RECURSIVE
 * delete implementation. The wrapper below therefore declares `rmdir` with
 * exactly one parameter, and re-asserts it, exactly as 05-adapter does.
 */

import type { GitFs } from '../../05-adapter/src/firestore-gcs-fs.js';
import * as git from 'isomorphic-git';

import type { Oid } from '../../07-refs/src/model';
import { isOid } from '../../07-refs/src/model';
import type { RefStore } from '../../07-refs/src/refs';

import { ToolError, badRequest } from './errors';

// ---------------------------------------------------------------------------
// (2) the ref-write firewall
// ---------------------------------------------------------------------------

const REF_WRITE_PATHS =
  /(?:^|\/)(?:refs\/|HEAD$|packed-refs$|FETCH_HEAD$|ORIG_HEAD$|MERGE_HEAD$|CHERRY_PICK_HEAD$)/;

function refWriteAttempt(path: string, syscall: string): ToolError {
  return new ToolError(
    'REF_WRITE_FORBIDDEN',
    `${syscall}: refusing to write the git ref "${path}" through the fs adapter. ` +
      `Ref updates in this system are compare-and-swap operations against Firestore ` +
      `(07-refs RefStore) and MUST go through the git_push tool. isomorphic-git's ` +
      `writeRef is a blind overwrite and would silently discard a concurrent push.`,
    { path, syscall },
  );
}

/**
 * Wrap a `GitFs` so ref mutation through it is impossible.
 *
 * Reads are passed straight through: `.git/config` and friends are read
 * normally, and reading a ref file is harmless (it is just never consulted,
 * because we never hand isomorphic-git a symbolic name).
 */
export function guardRefWrites(fs: GitFs): GitFs {
  const guarded: GitFs = {
    async readFile(path: string, options?: unknown) {
      return fs.readFile(path, options);
    },
    async writeFile(path: string, data: unknown, options?: unknown) {
      if (REF_WRITE_PATHS.test(path)) throw refWriteAttempt(path, 'writeFile');
      return fs.writeFile(path, data, options);
    },
    async unlink(path: string) {
      if (REF_WRITE_PATHS.test(path)) throw refWriteAttempt(path, 'unlink');
      return fs.unlink(path);
    },
    async readdir(path: string) {
      return fs.readdir(path);
    },
    async mkdir(path: string) {
      return fs.mkdir(path);
    },
    // EXACTLY ONE PARAMETER. See the note at the top of this file.
    async rmdir(path: string) {
      return fs.rmdir(path);
    },
    async stat(path: string) {
      return fs.stat(path);
    },
    async lstat(path: string) {
      return fs.lstat(path);
    },
    async readlink(path: string, options?: unknown) {
      return fs.readlink(path, options);
    },
    async symlink(target: string, path: string) {
      if (REF_WRITE_PATHS.test(path)) throw refWriteAttempt(path, 'symlink');
      return fs.symlink(target, path);
    },
  };

  if (guarded.rmdir.length !== 1) {
    throw new Error(
      `guarded fs.rmdir must declare exactly one parameter (got ${guarded.rmdir.length}); ` +
        'isomorphic-git treats rmdir.length > 1 as a recursive-delete implementation',
    );
  }
  return guarded;
}

// ---------------------------------------------------------------------------
// (1) authoritative ref resolution
// ---------------------------------------------------------------------------

export interface ResolvedRef {
  /** Exactly what the caller passed. */
  requested: string;
  /** Full ref name that matched, or null when an oid was passed directly. */
  refName: string | null;
  /** The ref's value. For an annotated tag this is still the tag object oid. */
  oid: Oid;
}

/**
 * Candidate full ref names for a user-supplied string, in git's own order.
 *
 * `HEAD` is special: the Firestore ref store holds branch/tag documents only,
 * there is no HEAD document, and a symbolic HEAD would be a second piece of
 * mutable state needing its own CAS. HEAD is therefore an alias for the
 * configured default branch. Documented, not inferred.
 */
export function refCandidates(ref: string, defaultBranch: string): string[] {
  if (ref === 'HEAD') return [`refs/heads/${defaultBranch}`];
  if (ref.startsWith('refs/')) return [ref];
  return [
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/remotes/${ref}`,
    `refs/${ref}`,
  ];
}

const BAD_REF_CHARS = /[\0\x20~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^@$/;

export function assertRefSyntax(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw badRequest('ref must be a non-empty string');
  }
  if (ref.length > 512) throw badRequest('ref is unreasonably long', { length: ref.length });
  if (isOid(ref)) return;
  if (BAD_REF_CHARS.test(ref)) {
    throw badRequest(
      `ref ${JSON.stringify(ref)} is not a valid git ref name (see git check-ref-format)`,
      { ref },
    );
  }
}

export class RefGate {
  constructor(
    private readonly refs: RefStore,
    private readonly repoId: string,
    private readonly defaultBranch: string,
  ) {}

  /**
   * ref-name -> oid, from Firestore. Never from isomorphic-git, never from the
   * fs adapter, never from `.git/refs/**`.
   *
   * An unresolvable ref is a REF_NOT_FOUND error. It is emphatically NOT an
   * empty string, an empty listing, or an empty log.
   */
  async resolveRef(ref: string): Promise<ResolvedRef> {
    assertRefSyntax(ref);

    if (isOid(ref)) return { requested: ref, refName: null, oid: ref };

    const candidates = refCandidates(ref, this.defaultBranch);
    for (const name of candidates) {
      const oid = await this.refs.readRef(this.repoId, name);
      if (oid !== null) return { requested: ref, refName: name, oid };
    }

    throw new ToolError('REF_NOT_FOUND', `no such ref: ${ref}`, {
      ref,
      tried: candidates,
      hint: 'Pass a branch name, a full ref name (refs/heads/...), or a 40-hex commit oid.',
    });
  }

  /** Read a full ref name with no candidate expansion. `null` if absent. */
  async readExactRef(refName: string): Promise<Oid | null> {
    return this.refs.readRef(this.repoId, refName);
  }

  async listRefs(): Promise<Array<{ ref: string; oid: Oid }>> {
    return this.refs.listRefs(this.repoId);
  }
}

/**
 * Peel a ref value down to a commit oid.
 *
 * `readTree`/`readBlob` peel internally via `resolveTree`, but `log` and the
 * fast-forward check want a commit, and the *reported* commit oid must be the
 * peeled one or an agent will pass a tag oid back into `git_push` as an
 * `expected_oid`. Peeling explicitly, with a bounded loop, keeps that honest.
 */
export async function peelToCommit(
  deps: { fs: GitFs; gitdir: string; cache: object },
  oid: Oid,
): Promise<Oid> {
  let current: string = oid;
  for (let hop = 0; hop < 10; hop++) {
    const obj = await git.readObject({
      fs: deps.fs as git.FsClient,
      gitdir: deps.gitdir,
      cache: deps.cache,
      oid: current,
      format: 'parsed',
    });
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = (obj.object as git.TagObject).object;
      continue;
    }
    throw new ToolError(
      'BAD_REQUEST',
      `object ${current} is a ${obj.type}, not a commit; refs used here must point at a commit or an annotated tag`,
      { oid: current, type: obj.type },
    );
  }
  throw new ToolError('BAD_REQUEST', `tag chain from ${oid} is more than 10 deep`, { oid });
}
