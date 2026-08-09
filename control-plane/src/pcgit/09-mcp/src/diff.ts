/**
 * 09-mcp / diff.ts
 *
 * Unified diff between two commits. isomorphic-git has no diff API at all, so
 * this is a tree walk plus a line differ.
 *
 * THE ONE OPTIMISATION THAT MATTERS: if two subtrees have the same oid, the
 * entire subtree is identical -- that is what content addressing buys you --
 * so recursion stops there. On a repo of any size the walk therefore touches
 * only the changed spine, not the whole tree.
 *
 * DIRECTION: `from_ref` is the "a" side (old), `to_ref` is the "b" side (new),
 * matching `git diff FROM TO`.
 */

import { structuredPatch } from 'diff';
import * as git from 'isomorphic-git';

import { ToolError } from './errors';
import {
  MODE_GITLINK,
  type GitDeps,
  type TreeEntry,
  fsClient,
  readTreeEntries,
} from './tree';

export type ChangeStatus = 'added' | 'deleted' | 'modified' | 'mode-changed';

export interface FileChange {
  path: string;
  status: ChangeStatus;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
  binary: boolean;
  /** Set when the file was skipped for size; the patch body says so too. */
  skipped?: string;
}

export interface DiffResult {
  changes: FileChange[];
  patch: string;
  truncated: boolean;
}

const NULL_OID = '0000000000000000000000000000000000000000';

export interface DiffOptions {
  maxFiles: number;
  maxFileBytes: number;
  /** Restrict to this path or anything beneath it. */
  pathFilter?: string;
}

export async function diffCommits(
  deps: GitDeps,
  fromCommit: string,
  toCommit: string,
  options: DiffOptions,
): Promise<DiffResult> {
  const fromTree = await commitTree(deps, fromCommit);
  const toTree = await commitTree(deps, toCommit);

  const changes: FileChange[] = [];
  await walk(deps, fromTree, toTree, '', changes, options);

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const truncated = changes.length > options.maxFiles;
  const kept = truncated ? changes.slice(0, options.maxFiles) : changes;

  const parts: string[] = [];
  for (const change of kept) {
    parts.push(await renderChange(deps, change, options));
  }
  if (truncated) {
    parts.push(
      `# diff truncated: ${changes.length} files changed, showing the first ` +
        `${options.maxFiles}. Narrow the diff with the "path" argument.\n`,
    );
  }

  return { changes: kept, patch: parts.join(''), truncated };
}

async function commitTree(deps: GitDeps, commitOid: string): Promise<string> {
  const { commit } = await git.readCommit({
    fs: fsClient(deps),
    gitdir: deps.gitdir,
    cache: deps.cache,
    oid: commitOid,
  });
  return commit.tree;
}

// ---------------------------------------------------------------------------
// tree walk
// ---------------------------------------------------------------------------

/** Does this subtree prefix intersect the caller's path filter? */
function mayContain(prefix: string, filter: string | undefined): boolean {
  if (filter === undefined || filter === '') return true;
  if (prefix === '') return true;
  return filter === prefix || filter.startsWith(`${prefix}/`) || prefix.startsWith(`${filter}/`);
}

function matches(path: string, filter: string | undefined): boolean {
  if (filter === undefined || filter === '') return true;
  return path === filter || path.startsWith(`${filter}/`);
}

async function entriesOf(deps: GitDeps, treeOid: string | null): Promise<Map<string, TreeEntry>> {
  if (treeOid === null) return new Map();
  const { entries } = await readTreeEntries(deps, treeOid);
  return new Map(entries.map((e) => [e.path, e]));
}

async function walk(
  deps: GitDeps,
  aTree: string | null,
  bTree: string | null,
  prefix: string,
  out: FileChange[],
  options: DiffOptions,
): Promise<void> {
  // Identical subtrees are identical all the way down. This is the whole
  // reason a content-addressed store can diff cheaply.
  if (aTree !== null && aTree === bTree) return;
  if (!mayContain(prefix, options.pathFilter)) return;

  const a = await entriesOf(deps, aTree);
  const b = await entriesOf(deps, bTree);

  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const name of names) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const ea = a.get(name);
    const eb = b.get(name);

    const aIsTree = ea?.type === 'tree';
    const bIsTree = eb?.type === 'tree';

    if (aIsTree || bIsTree) {
      // A tree on either side. Recurse for the tree halves, and emit an
      // add/delete for a non-tree half (a file replaced by a directory, or
      // vice versa -- git reports both events, and so do we).
      await walk(
        deps,
        aIsTree ? (ea as TreeEntry).oid : null,
        bIsTree ? (eb as TreeEntry).oid : null,
        path,
        out,
        options,
      );
      if (ea && !aIsTree) pushChange(out, blobChange(path, ea, undefined), options);
      if (eb && !bIsTree) pushChange(out, blobChange(path, undefined, eb), options);
      continue;
    }

    if (ea && eb && ea.oid === eb.oid && ea.mode === eb.mode) continue;
    pushChange(out, blobChange(path, ea, eb), options);
  }
}

function pushChange(out: FileChange[], change: FileChange | null, options: DiffOptions): void {
  if (change === null) return;
  if (!matches(change.path, options.pathFilter)) return;
  out.push(change);
}

function blobChange(
  path: string,
  ea: TreeEntry | undefined,
  eb: TreeEntry | undefined,
): FileChange | null {
  if (!ea && !eb) return null;
  const status: ChangeStatus = !ea
    ? 'added'
    : !eb
      ? 'deleted'
      : ea.oid !== eb.oid
        ? 'modified'
        : 'mode-changed';
  return {
    path,
    status,
    oldOid: ea ? ea.oid : null,
    newOid: eb ? eb.oid : null,
    oldMode: ea ? ea.mode : null,
    newMode: eb ? eb.mode : null,
    binary: false,
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

async function readBlobBytes(deps: GitDeps, oid: string): Promise<Uint8Array> {
  const { blob } = await git.readBlob({
    fs: fsClient(deps),
    gitdir: deps.gitdir,
    cache: deps.cache,
    oid,
  });
  return blob;
}

async function renderChange(
  deps: GitDeps,
  change: FileChange,
  options: DiffOptions,
): Promise<string> {
  const header: string[] = [`diff --git a/${change.path} b/${change.path}`];

  if (change.oldMode === MODE_GITLINK || change.newMode === MODE_GITLINK) {
    // A submodule pointer. There is no blob to diff; report the oid move.
    header.push(
      `Subproject commit ${short(change.oldOid)} -> ${short(change.newOid)} (gitlink; not followed)`,
    );
    return `${header.join('\n')}\n`;
  }

  if (change.status === 'added') header.push(`new file mode ${change.newMode ?? '100644'}`);
  if (change.status === 'deleted') header.push(`deleted file mode ${change.oldMode ?? '100644'}`);
  if (change.status === 'mode-changed' && change.oldMode && change.newMode) {
    header.push(`old mode ${change.oldMode}`, `new mode ${change.newMode}`);
  }

  const indexModeSuffix =
    change.status === 'modified' && change.oldMode === change.newMode
      ? ` ${change.newMode}`
      : '';
  header.push(
    `index ${short(change.oldOid)}..${short(change.newOid)}${indexModeSuffix}`,
  );

  if (change.status === 'mode-changed') {
    return `${header.join('\n')}\n`;
  }

  const oldBytes = change.oldOid ? await readBlobBytes(deps, change.oldOid) : new Uint8Array(0);
  const newBytes = change.newOid ? await readBlobBytes(deps, change.newOid) : new Uint8Array(0);

  if (isBinary(oldBytes) || isBinary(newBytes)) {
    change.binary = true;
    header.push(`Binary files a/${change.path} and b/${change.path} differ`);
    return `${header.join('\n')}\n`;
  }

  const biggest = Math.max(oldBytes.length, newBytes.length);
  if (biggest > options.maxFileBytes) {
    change.skipped = `file is ${biggest} bytes, over the ${options.maxFileBytes}-byte diff cap`;
    header.push(
      `# contents not diffed: ${change.skipped}. Read it with git_read if you need it.`,
    );
    return `${header.join('\n')}\n`;
  }

  const oldText = Buffer.from(oldBytes).toString('utf8');
  const newText = Buffer.from(newBytes).toString('utf8');

  const patch = structuredPatch(
    `a/${change.path}`,
    `b/${change.path}`,
    oldText,
    newText,
    undefined,
    undefined,
    { context: 3 },
  );

  const body: string[] = [];
  body.push(change.status === 'added' ? '--- /dev/null' : `--- a/${change.path}`);
  body.push(change.status === 'deleted' ? '+++ /dev/null' : `+++ b/${change.path}`);
  for (const hunk of patch.hunks) {
    body.push(
      `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    );
    for (const line of hunk.lines) body.push(line);
  }

  if (patch.hunks.length === 0) {
    // Different oids but identical decoded text: only reachable if a blob
    // differs in bytes that survive utf8 round-tripping. Say so rather than
    // emitting an empty, misleading patch.
    body.push('# oids differ but no textual change was produced');
  }

  return `${[...header, ...body].join('\n')}\n`;
}

/**
 * Render one side of an `@@` header the way git does.
 *
 * Two conventions that are easy to get wrong, both verified against
 * `git diff` output:
 *  - a count of exactly 1 is written as a bare line number, with no `,1`;
 *  - a count of 0 means "nothing on this side", and git writes the line
 *    number BEFORE the insertion point -- `@@ -0,0 +1 @@` for a new file.
 *    jsdiff reports `oldStart: 1` there, so the decrement is ours to apply.
 */
function range(start: number, lines: number): string {
  if (lines === 1) return `${start}`;
  if (lines === 0) return `${Math.max(start - 1, 0)},0`;
  return `${start},${lines}`;
}

function short(oid: string | null): string {
  return (oid ?? NULL_OID).slice(0, 7);
}
