/**
 * 09-mcp / tree.ts
 *
 * Path validation and tree construction.
 *
 * WHOLE-FILE WRITES ONLY. `buildTree` takes a set of (path -> blob oid) pairs
 * and a set of paths to REMOVE, and rebuilds the affected trees from the base
 * commit's tree. There is no anchor, no hunk, no line range, no
 * search-and-replace, and no partial write anywhere in this module or in
 * anything that calls it. That is a standing law of this fleet, not a
 * simplification: a patch API forces the server to guess what the agent meant
 * when the anchor is ambiguous, and a wrong guess writes plausible,
 * silently-wrong content into a commit.
 *
 * REMOVAL, [SEC-PROPOSE-DELETE-V1]. Every entry NOT named by the caller is
 * still preserved verbatim; removal is not an exception to that rule but an
 * explicit, per-path instruction, and the same "no guessing" law governs it:
 *
 *   - ONE EXPLICIT PATH PER REMOVAL. There is no glob, no prefix, no recursive
 *     directory removal and no wildcard anywhere in this module. A caller that
 *     wants to remove ten files names ten paths, and the per-proposal file cap
 *     in ops.ts bounds the blast radius of the whole call.
 *   - A PATH THAT IS NOT THERE IS A REFUSAL, never a silent success. A removal
 *     that quietly removed nothing would ship as a "deletion" and leave the
 *     file in the tree -- the same class of plausible, silently-wrong commit
 *     that the whole-file rule exists to forbid.
 *   - REMOVAL IS NO MORE PERMITTED THAN A WRITE TO THE SAME PATH. A tree, a
 *     symlink and a gitlink are refused for removal for exactly the reasons
 *     they are refused for writing below. Nothing is reachable for deletion
 *     that was not already reachable for overwriting.
 *   - A DIRECTORY THAT BECOMES EMPTY IS PRUNED, AND THE REASON IS THE TREE OID,
 *     NOT VALIDITY. Measured, because the obvious claim is false: `git fsck
 *     --strict` does NOT report a zero-entry subtree; it exits 0. What is true
 *     is that GIT ITSELF NEVER PRODUCES ONE -- given the same content, real git
 *     writes a tree with the empty directory absent -- so a phantom entry makes
 *     the oid diverge from the canonical tree for identical content. Measured:
 *     two trees whose `ls-tree -r` output is byte-identical hash to
 *     0d913a50 (with the empty subtree) and b4ed9182 (without). A checkout of
 *     the first produces exactly the same files as a checkout of the second.
 *     So the entry is INVISIBLE IN CONTENT AND VISIBLE IN THE OID, which is the
 *     worst combination available: it silently breaks every comparison this
 *     fleet makes against a git-produced tree, including the identical-treeOid
 *     check that is how branch parity is proven here. It would also accumulate,
 *     one phantom per emptied directory, with nothing ever removing them.
 */

import * as git from 'isomorphic-git';
import type { GitFs } from '../../05-adapter/src/firestore-gcs-fs.js';

import { ToolError, badRequest } from './errors';

export interface GitDeps {
  fs: GitFs;
  gitdir: string;
  cache: object;
}

/** isomorphic-git's `FsClient` and 05-adapter's `GitFs` are the same ten
 *  methods; the cast is confined to this one helper. */
export function fsClient(deps: GitDeps): git.FsClient {
  return deps.fs as unknown as git.FsClient;
}

export const MODE_FILE = '100644';
export const MODE_EXEC = '100755';
export const MODE_SYMLINK = '120000';
export const MODE_TREE = '040000';
export const MODE_GITLINK = '160000';

/**
 * Normalise a repo-relative path.
 *
 * Rejects rather than repairs: absolute paths, `..`, `.git`, backslashes and
 * NUL. An agent that meant `src/a.ts` and typed `/src/a.ts` should be told,
 * not silently redirected.
 */
export function normalizeRepoPath(input: string, opts: { allowRoot: boolean }): string {
  if (typeof input !== 'string') throw badRequest('path must be a string');
  const path = input.trim();

  if (path === '' || path === '.' || path === '/') {
    if (opts.allowRoot) return '';
    throw badRequest('path must name a file');
  }
  if (path.startsWith('/')) {
    throw badRequest(`path must be repository-relative, got ${JSON.stringify(input)}`);
  }
  if (path.includes('\\')) {
    throw badRequest(`path must use '/' separators, got ${JSON.stringify(input)}`);
  }
  if (path.includes('\0')) throw badRequest('path must not contain NUL');
  if (path.length > 4096) throw badRequest('path is unreasonably long', { length: path.length });

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' ) {
      throw badRequest(`path must not contain empty segments: ${JSON.stringify(input)}`);
    }
    if (segment === '.' || segment === '..') {
      throw badRequest(`path must not contain '.' or '..': ${JSON.stringify(input)}`);
    }
    if (segment === '.git') {
      throw badRequest(`path must not traverse '.git': ${JSON.stringify(input)}`);
    }
  }
  return segments.join('/');
}

export interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
}

/** Read a tree's entries by tree/commit/tag oid. Peeling is isomorphic-git's. */
export async function readTreeEntries(
  deps: GitDeps,
  oid: string,
  filepath?: string,
): Promise<{ treeOid: string; entries: TreeEntry[] }> {
  const result = await git.readTree({
    fs: fsClient(deps),
    gitdir: deps.gitdir,
    cache: deps.cache,
    oid,
    ...(filepath !== undefined && filepath !== '' ? { filepath } : {}),
  });
  return { treeOid: result.oid, entries: result.tree as TreeEntry[] };
}

// ---------------------------------------------------------------------------
// tree construction
// ---------------------------------------------------------------------------

interface DirNode {
  dirs: Map<string, DirNode>;
  files: Map<string, { oid: string }>;
  /** Leaf names to REMOVE from this directory. [SEC-PROPOSE-DELETE-V1] */
  removals: Set<string>;
}

function emptyDir(): DirNode {
  return { dirs: new Map(), files: new Map(), removals: new Set() };
}

/**
 * Descend to the directory node that owns `path`'s leaf, creating interior
 * nodes as needed, and return that node with the leaf name.
 */
function descend(root: DirNode, path: string): { node: DirNode; leaf: string } {
  const segments = path.split('/');
  let node = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const name = segments[i] as string;
    let next = node.dirs.get(name);
    if (!next) {
      next = emptyDir();
      node.dirs.set(name, next);
    }
    node = next;
  }
  return { node, leaf: segments[segments.length - 1] as string };
}

/**
 * Build the nested shape of the paths being written and removed, so each
 * directory is rewritten exactly once no matter how many entries land in it.
 */
function planFrom(
  files: Array<{ path: string; oid: string }>,
  deletes: readonly string[],
): DirNode {
  const root = emptyDir();
  for (const file of files) {
    const { node, leaf } = descend(root, file.path);
    node.files.set(leaf, { oid: file.oid });
  }
  for (const path of deletes) {
    const { node, leaf } = descend(root, path);
    node.removals.add(leaf);
  }
  // Collision detection is a SEPARATE PASS on purpose: checking it while
  // descending made the answer depend on the order entries happened to arrive
  // in, so `write a/b` + `delete a` was caught but `delete a` + `write a/b`
  // was not. One pass over the finished plan is order-independent.
  assertNoNameCollisions(root, '');
  return root;
}

/**
 * A name may appear as at most ONE of: a directory this proposal writes into,
 * a file it writes, or a path it removes. Anything else is the caller asking
 * for two contradictory things and the server having to pick one.
 */
function assertNoNameCollisions(node: DirNode, prefix: string): void {
  for (const name of node.dirs.keys()) {
    if (node.files.has(name)) {
      throw badRequest(
        `path conflict: ${joinPath(prefix, name)} is written as a file, but another entry ` +
          `in this proposal writes something underneath it`,
        { path: joinPath(prefix, name) },
      );
    }
    if (node.removals.has(name)) {
      throw badRequest(
        `path conflict: ${joinPath(prefix, name)} is removed, but another entry in this ` +
          `proposal writes something underneath it. Name each file to remove; this API ` +
          `never removes a directory and its contents as one instruction.`,
        { path: joinPath(prefix, name) },
      );
    }
  }
  for (const name of node.files.keys()) {
    if (node.removals.has(name)) {
      throw badRequest(
        `path conflict: ${joinPath(prefix, name)} is both written and removed by this ` +
          `proposal`,
        { path: joinPath(prefix, name) },
      );
    }
  }
  for (const [name, child] of node.dirs) assertNoNameCollisions(child, joinPath(prefix, name));
}

/**
 * Rewrite the tree rooted at `baseTreeOid` with the given whole-file contents.
 *
 * Existing entries are preserved verbatim. When a path already exists as a
 * blob, its MODE IS PRESERVED -- replacing the contents of a 100755 script must
 * not silently drop its executable bit, and the tool surface has no mode
 * parameter to say otherwise. New files get 100644.
 *
 * A path that currently exists as a tree, a symlink or a gitlink is refused:
 * turning a directory into a file, or clobbering a submodule pointer, is a
 * structural change that should be an explicit human decision, not a side
 * effect of writing a file.
 *
 * `deletes` names paths to REMOVE. Each must exist at `baseTreeOid` and must be
 * a regular file there; see the module header for why both of those are
 * refusals rather than no-ops.
 */
export async function buildTree(
  deps: GitDeps,
  baseTreeOid: string | null,
  files: Array<{ path: string; oid: string }>,
  deletes: readonly string[] = [],
): Promise<string> {
  const oid = await writeSubtree(deps, baseTreeOid, planFrom(files, deletes), '');
  if (oid !== null) return oid;
  // The root emptied out -- every path in the repository was removed. Git DOES
  // have a canonical empty tree object (4b825dc6...), and the root is the one
  // place it is legal, so write it rather than pruning upward into nothing.
  return git.writeTree({
    fs: fsClient(deps),
    gitdir: deps.gitdir,
    tree: [] as unknown as git.TreeObject,
  });
}

/**
 * Returns the new subtree oid, or `null` meaning THIS SUBTREE IS NOW EMPTY and
 * the caller must drop its entry instead of pointing at a malformed empty tree.
 *
 * `null` can only arise from a removal. A proposal that only writes always
 * leaves every node it touches holding at least the entry it just wrote, so
 * this return value changes nothing for the write-only path.
 */
async function writeSubtree(
  deps: GitDeps,
  baseOid: string | null,
  node: DirNode,
  prefix: string,
): Promise<string | null> {
  const byName = new Map<string, TreeEntry>();
  if (baseOid !== null) {
    const { entries } = await readTreeEntries(deps, baseOid);
    for (const entry of entries) byName.set(entry.path, entry);
  }

  for (const [name, child] of node.dirs) {
    const existing = byName.get(name);
    if (existing && existing.type !== 'tree') {
      throw new ToolError(
        'BAD_REQUEST',
        `cannot write under ${joinPath(prefix, name)}: it exists as a ${existing.type}, not a directory`,
        { path: joinPath(prefix, name), existingType: existing.type },
      );
    }
    const childOid = await writeSubtree(
      deps,
      existing ? existing.oid : null,
      child,
      joinPath(prefix, name),
    );
    if (childOid === null) {
      // Everything under here was removed. Drop the entry entirely; leaving a
      // zero-entry subtree behind is content-invisible but changes the tree
      // oid, so the result would no longer match the tree git itself builds
      // from the same files. See the module header.
      byName.delete(name);
      continue;
    }
    byName.set(name, { mode: MODE_TREE, path: name, oid: childOid, type: 'tree' });
  }

  for (const [name, file] of node.files) {
    const existing = byName.get(name);
    if (existing && existing.type !== 'blob') {
      throw new ToolError(
        'BAD_REQUEST',
        `cannot write ${joinPath(prefix, name)}: it exists as a ${existing.type}, not a file`,
        { path: joinPath(prefix, name), existingType: existing.type },
      );
    }
    if (existing && existing.mode === MODE_SYMLINK) {
      throw new ToolError(
        'BAD_REQUEST',
        `cannot write ${joinPath(prefix, name)}: it is a symlink. Replacing a symlink ` +
          `with a regular file is a structural change this API does not perform.`,
        { path: joinPath(prefix, name) },
      );
    }
    byName.set(name, {
      // Preserve an existing executable bit; default new files to 100644.
      mode: existing ? existing.mode : MODE_FILE,
      path: name,
      oid: file.oid,
      type: 'blob',
    });
  }

  // Removals last, so a name this proposal also writes has already been
  // rejected by `assertNoNameCollisions` and can never reach here.
  for (const name of node.removals) {
    const full = joinPath(prefix, name);
    const existing = byName.get(name);
    if (existing === undefined) {
      // NEVER a silent no-op. ops.ts resolves every removal against the base
      // tree before anything is written and refuses there with the better
      // message; this is the invariant restated at the layer that actually
      // holds the tree, so no future caller of buildTree can lose it.
      throw new ToolError(
        'PATH_NOT_FOUND',
        `cannot remove ${full}: it does not exist in the base tree. NOTHING was ` +
          `written. A removal that silently succeeded would report a deletion that ` +
          `deleted nothing.`,
        { path: full },
      );
    }
    if (existing.type !== 'blob') {
      throw new ToolError(
        'BAD_REQUEST',
        `cannot remove ${full}: it is a ${existing.type}, not a file. This API removes ` +
          `one named file per entry and never a directory or a submodule pointer.`,
        { path: full, existingType: existing.type, mode: existing.mode },
      );
    }
    if (existing.mode === MODE_SYMLINK) {
      // Refused for the same reason writing over one is: a symlink is a
      // structural entry, and removal must be no more permitted than a write
      // to the same path.
      throw new ToolError(
        'BAD_REQUEST',
        `cannot remove ${full}: it is a symlink. Removing a symlink is a structural ` +
          `change this API does not perform.`,
        { path: full, mode: existing.mode },
      );
    }
    byName.delete(name);
  }

  if (byName.size === 0) return null;

  // GitTree sorts entries into git's canonical order on construction, so the
  // insertion order of this Map does not affect the resulting oid.
  return git.writeTree({
    fs: fsClient(deps),
    gitdir: deps.gitdir,
    tree: [...byName.values()] as git.TreeObject,
  });
}

function joinPath(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}
