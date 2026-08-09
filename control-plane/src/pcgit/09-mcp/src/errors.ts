/**
 * 09-mcp / errors.ts
 *
 * ONE RULE: a tool never returns a plausible-looking empty result for a
 * failure. An unreadable ref is an error. A missing path is an error. A file
 * that exceeds the size cap is an error carrying the size, not a truncated
 * string. An agent that cannot distinguish "empty file" from "I could not read
 * this" will confidently propose a commit that deletes the file's contents.
 *
 * Every tool result -- success or failure -- is a JSON object with a boolean
 * `ok`. Failures additionally set MCP's `isError` flag so a client that only
 * looks at the envelope still sees the failure.
 */

export type ErrorCode =
  /** The arguments themselves are wrong (bad ref syntax, empty path, ...). */
  | 'BAD_REQUEST'
  /** No ref of that name in the Firestore ref store. */
  | 'REF_NOT_FOUND'
  /** The ref resolved, but the path does not exist in that tree. */
  | 'PATH_NOT_FOUND'
  /** Asked to read a directory as a file. */
  | 'NOT_A_BLOB'
  /** Asked to list a file as a directory. */
  | 'NOT_A_TREE'
  /** Over the configured size cap. Carries the real size and the oid. */
  | 'FILE_TOO_LARGE'
  /** Too many files in one proposal, or too many changed files in one diff. */
  | 'TOO_MANY_FILES'
  /** A ref points at an object that is not in the store (07-refs §4.2 Case B). */
  | 'OBJECT_NOT_FOUND'
  /** The proposed commit is not a descendant of the ref's current value. */
  | 'NON_FAST_FORWARD'
  /** Lost the CAS race. The single most important error in this API. */
  | 'STALE'
  /** Tried to create a branch that another writer created first. */
  | 'ALREADY_EXISTS'
  /**
   * Produced ONLY by the ref CAS, and reported with the refs layer's own
   * spelling: the branch was deleted by another writer between the agent
   * reading it and pushing. See 07-refs model.ts CasFailureCode.
   */
  | 'NOT_FOUND'
  /** The tip object was not readable in GCS after writing. Push refused. */
  | 'NOT_DURABLE'
  /** Something tried to write a ref through the fs seam. Always a bug. */
  | 'REF_WRITE_FORBIDDEN'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export interface FailureEnvelope {
  ok: false;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/** isomorphic-git tags its errors with a stable string `code`. */
function isoGitCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Map anything thrown inside a tool onto the structured envelope.
 *
 * The default is INTERNAL with the original message preserved. We never
 * swallow an unrecognised error into a success, and we never return a bare
 * "something went wrong" -- the agent gets the real text so it can decide
 * whether to give up or ask a human.
 */
export function toFailure(err: unknown): FailureEnvelope {
  if (err instanceof ToolError) {
    return { ok: false, code: err.code, message: err.message, details: err.details };
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = isoGitCode(err);

  switch (code) {
    case 'NotFoundError':
      return {
        ok: false,
        code: 'PATH_NOT_FOUND',
        message,
        details: { isomorphicGitCode: code },
      };
    case 'ObjectTypeError':
      return {
        ok: false,
        code: 'NOT_A_BLOB',
        message,
        details: { isomorphicGitCode: code },
      };
    case 'InvalidOidError':
    case 'NoRefspecError':
      return { ok: false, code: 'BAD_REQUEST', message, details: { isomorphicGitCode: code } };
    default:
      return {
        ok: false,
        code: 'INTERNAL',
        message,
        details: code ? { isomorphicGitCode: code } : {},
      };
  }
}

export function badRequest(message: string, details: Record<string, unknown> = {}): ToolError {
  return new ToolError('BAD_REQUEST', message, details);
}
