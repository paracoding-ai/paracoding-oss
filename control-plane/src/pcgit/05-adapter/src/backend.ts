/**
 * The narrow contract each storage backend implements.
 *
 * Deliberately dumb: backends do raw get/put/list and NOTHING else. All POSIX
 * semantics -- ENOENT / EEXIST / ENOTDIR / ENOTEMPTY, parent-existence checks,
 * symlink resolution, path normalisation -- live in `firestore-gcs-fs.ts`, in
 * one place, so the two backends cannot drift apart on the rules that
 * isomorphic-git actually branches on (02-fs-interface.md §3.1).
 *
 * Every method takes an already-normalised absolute POSIX path.
 * "Missing" is always signalled by `null`, never by throwing -- the adapter
 * converts absence into the correct POSIX error for the calling syscall.
 */

import type { StoredNode } from './stats.js';

export interface Backend {
  /** Metadata for one path, or null if nothing is stored there. */
  getNode(path: string): Promise<StoredNode | null>;

  /** Raw bytes of a regular file, or null if there is no regular file there. */
  readFile(path: string): Promise<Buffer | null>;

  /** Create or overwrite a regular file. Parent existence is NOT checked here. */
  writeFile(
    path: string,
    data: Buffer,
    opts: { executable: boolean },
  ): Promise<void>;

  /** Remove a regular file or symlink. Missing is not an error at this layer. */
  removeFile(path: string): Promise<void>;

  /** Create exactly one directory level. Existence is NOT checked here. */
  makeDir(path: string): Promise<void>;

  /** Remove one directory marker. Emptiness is NOT checked here. */
  removeDir(path: string): Promise<void>;

  /**
   * Immediate child basenames. MUST NOT include `.` or `..` -- including them
   * made `git.statusMatrix` hang indefinitely in the prior agent's test
   * (§5.3), because the walker resolves `.` back to the same directory and
   * recurses forever. MUST include subdirectories alongside files, or every
   * nested file is silently absent from every commit. MUST be complete -- no
   * pagination truncation.
   */
  listChildren(path: string): Promise<string[]>;

  /** Cheap emptiness probe for the ENOTEMPTY check in `rmdir`. */
  hasChildren(path: string): Promise<boolean>;

  /** Create a symlink at `path` pointing at `target`, or reject with EPERM. */
  makeSymlink(target: string, path: string): Promise<void>;
}
