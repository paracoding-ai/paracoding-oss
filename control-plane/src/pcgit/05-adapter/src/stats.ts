/**
 * The Stats object isomorphic-git expects back from `stat`/`lstat`.
 *
 * 02-fs-interface.md §4. Two things here are hard `TypeError`s inside
 * isomorphic-git if you get them wrong, and one is a silent-corruption bug.
 */

export type NodeKind = 'file' | 'dir' | 'symlink';

/** Backend-agnostic description of one stored entry. */
export interface StoredNode {
  kind: NodeKind;
  size: number;
  /** Whether the execute bit should be reported. `normalizeMode` collapses
   *  permissions to 0755-if-any-execute-bit / 0644 otherwise, so a single
   *  boolean is all the fidelity git can use (§4.3). */
  executable: boolean;
  /** ms since epoch, derived from the backing store's real modification time. */
  mtimeMs: number;
  /** ms since epoch. We report the same value as mtimeMs -- neither GCS nor
   *  Firestore exposes a separate inode-change time, and `compareStats` only
   *  requires that it MOVE when the content moves. */
  ctimeMs: number;
  /** 32-bit change counter. See the comment on `makeStats` -- this is the
   *  field that prevents silent data loss. */
  ino: number;
  /** Symlink target, only when `kind === 'symlink'`. */
  target?: string;
}

/**
 * Exactly the shape `normalizeStats` (src/utils/normalizeStats.js) reads, and
 * nothing else. `nlink`, `blocks`, `blksize`, `rdev`, `atime*` and
 * `birthtime*` are never referenced by isomorphic-git (§4.2), so they are
 * deliberately absent.
 */
export interface GitStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  size: number;
  ino: number;
  dev: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  ctimeMs: number;
  type: 'dir' | 'file' | 'symlink';
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * ### THE MTIME TRAP -- read this before changing anything below.
 *
 * `compareStats` (src/utils/compareStats.js) declares a file UNCHANGED when
 * mode, mtimeSeconds, ctimeSeconds, uid, gid, ino and size all match the
 * snapshot recorded in `.git/index` at `add` time. When it reports unchanged,
 * `GitWalkerFs.oid` (GitWalkerFs.js:139-165) **skips reading and hashing the
 * file entirely** and reuses the SHA cached in the index.
 *
 * So an adapter that returns constant `mtimeMs`/`ctimeMs`/`ino` -- the natural
 * first cut for an object store, where zeroes look harmless -- makes every
 * SAME-SIZE edit invisible. The prior agent reproduced exactly this:
 *
 *     init; write a.txt = "AAAAA"; add; commit
 *     write a.txt = "BBBBB"          // same length
 *     statusMatrix -> [["a.txt",1,1,1]]   // "unchanged"
 *     0 files staged; commit recorded "AAAAA" while the file held "BBBBB"
 *
 * No error, no warning. With zeroed timestamps, file SIZE is the only thing
 * standing between this system and silent data loss, and any same-length edit
 * (a flipped boolean, a corrected typo, a swapped UUID) walks straight through.
 *
 * Therefore `mtimeMs`/`ctimeMs`/`ino` MUST come from a value the backing store
 * genuinely changes on every write:
 *
 *   - Cloud Storage: `mtimeMs` <- Date.parse(object.updated),
 *                    `ino`     <- low 32 bits of object.generation
 *                                 (a NEW content generation is assigned on
 *                                 every overwrite).
 *   - Firestore:     `mtimeMs` <- snapshot.updateTime,
 *                    `ino`     <- updateTime microseconds XOR a stored
 *                                 monotonic `rev` counter.
 *
 * `ino` is not optional for us even though it is optional for isomorphic-git:
 * `compareStats` compares mtime at ONE-SECOND granularity, so two writes
 * inside the same wall-clock second with identical size are indistinguishable
 * by time alone (the classic "racy git" window). `ino` closes it.
 *
 * The panic switch, if a real change counter is ever unavailable, is
 * `ino: undefined` -- `normalizeStats` yields NaN, `NaN !== NaN`, so every
 * file reports permanently stale and is re-hashed on every status. Correct but
 * slow. NEVER ship constants; they are correct-looking and wrong.
 */
export function makeStats(node: StoredNode): GitStats {
  const isDir = node.kind === 'dir';
  const isLink = node.kind === 'symlink';
  const perm = node.executable ? 0o755 : 0o644;

  let mode: number;
  if (isDir) mode = S_IFDIR | 0o755;
  else if (isLink) mode = S_IFLNK;
  else mode = S_IFREG | perm;

  return {
    // MUST be callable methods, not fields and not booleans. Stripping them
    // and returning a LightningFS-style `type` field instead fails at
    // `git.init` with "TypeError: dotgitStat.isDirectory is not a function".
    // There is no field-based fallback (§4.1). Exactly one must be true --
    // an all-false triple classifies the entry as 'special' in
    // GitWalkerFs.js:84-87 and silently drops it from every commit.
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,

    mode,
    size: isDir ? 0 : node.size,

    // See the block comment above. Never constants.
    ino: node.ino >>> 0,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,

    // Read by normalizeStats and written into the index. `dev` is not
    // compared by compareStats; `uid`/`gid` are, so they must at least be
    // stable -- 0 is fine because they never change for us.
    dev: 0,
    uid: 0,
    gid: 0,

    // Ignored by isomorphic-git; useful when debugging.
    type: node.kind,
  };
}

/** ms-since-epoch -> a 32-bit-safe pseudo-inode. Helper for the backends. */
export function to32(n: number | bigint): number {
  if (typeof n === 'bigint') return Number(((n % 4294967296n) + 4294967296n) % 4294967296n);
  return Math.abs(Math.trunc(n)) % 4294967296;
}
