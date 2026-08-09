/**
 * 09-mcp / tree.ts
 *
 * Path validation and tree construction.
 *
 * WHOLE-FILE WRITES ONLY. `buildTree` takes a set of (path -> blob oid) pairs
 * and rebuilds the affected trees from the base commit's tree. There is no
 * anchor, no hunk, no line range, no search-and-replace, and no partial write
 * anywhere in this module or in anything that calls it. That is a standing law
 * of this fleet, not a simplification: a patch API forces the server to guess
 * what the agent meant when the anchor is ambiguous, and a wrong guess writes
 * plausible, silently-wrong content into a commit.
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
}

function emptyDir(): DirNode {
  return { dirs: new Map(), files: new Map() };
}

/**
 * Build the nested shape of the paths being written, so each directory is
 * rewritten exactly once no matter how many files land in it.
 */
function planFrom(files: Array<{ path: string; oid: string }>): DirNode {
  const root = emptyDir();
  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i] as string;
      if (node.files.has(name)) {
        throw badRequest(
          `path conflict: ${file.path} requires ${name} to be a directory, but another ` +
            `file in this proposal writes it as a file`,
          { path: file.path },
        );
      }
      let next = node.dirs.get(name);
      if (!next) {
        next = emptyDir();
        node.dirs.set(name, next);
      }
      node = next;
    }
    const leaf = segments[segments.length - 1] as string;
    if (node.dirs.has(leaf)) {
      throw badRequest(
        `path conflict: ${file.path} is written as a file, but another file in this ` +
          `proposal writes something underneath it`,
        { path: file.path },
      );
    }
    node.files.set(leaf, { oid: file.oid });
  }
  return root;
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
 */
export async function buildTree(
  deps: GitDeps,
  baseTreeOid: string | null,
  files: Array<{ path: string; oid: string }>,
): Promise<string> {
  return writeSubtree(deps, baseTreeOid, planFrom(files), '');
}

async function writeSubtree(
  deps: GitDeps,
  baseOid: string | null,
  node: DirNode,
  prefix: string,
): Promise<string> {
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
