/**
 * POSIX-shaped errors for the isomorphic-git `fs` contract.
 *
 * Per 02-fs-interface.md §3.4, `err.code` is the ONLY property isomorphic-git
 * reads. But it also `console.log`s the whole error out of
 * `FileSystem.exists()` and `checkout.js`, so the message is worth getting
 * right.
 *
 * §3.4 also warns: never emit a code containing the substring `ENS`.
 * `FileSystem.js` does `(err.code || '').includes('ENS')` in three places and
 * treats a match as "does not exist". Every code below is drawn from the fixed
 * POSIX set and none contains `ENS`.
 */

export type FsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'ENOTEMPTY'
  | 'EPERM'
  | 'EINVAL'
  | 'ELOOP'
  | 'EFBIG'
  | 'EIO';

const MESSAGES: Record<FsErrorCode, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty',
  EPERM: 'operation not permitted',
  EINVAL: 'invalid argument',
  ELOOP: 'too many symbolic links encountered',
  EFBIG: 'file too large',
  // Only ever raised when a document says its bytes are spilled to the
  // overflow store and they are not there. Reported as an I/O error rather than
  // ENOENT ON PURPOSE: ENOENT would be swallowed by FileSystem.read's
  // catch-and-return-null and read as "this file does not exist", which is
  // precisely the silent-data-loss path in §3.3.
  EIO: 'input/output error',
};

export interface FsError extends Error {
  code: FsErrorCode;
  syscall: string;
  path: string;
  errno: number;
}

export function fsError(
  code: FsErrorCode,
  syscall: string,
  path: string,
  detail?: string,
): FsError {
  const suffix = detail ? ` (${detail})` : '';
  const err = new Error(
    `${code}: ${MESSAGES[code]}, ${syscall} '${path}'${suffix}`,
  ) as FsError;
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  err.errno = -1; // cosmetic; isomorphic-git never inspects it
  return err;
}

/** True when `err` looks like a not-found from either GCP client. */
export function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // GCS ApiError uses numeric HTTP status; Firestore gRPC uses code 5 = NOT_FOUND.
  return code === 404 || code === 5 || code === 'ENOENT';
}

/** True when a GCS precondition (ifGenerationMatch) lost the race. */
export function isPreconditionFailed(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 412;
}
