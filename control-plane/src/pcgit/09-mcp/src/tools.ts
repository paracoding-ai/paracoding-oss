/**
 * 09-mcp / tools.ts
 *
 * SEC-REVIEW-2 AUDIT NOTE: This standalone MCP server (09-mcp) is NOT built
 * or served on any active surface that an adopter or an agent can reach.
 * Only the individual files "server.ts" and "tools.ts" are excluded from run targets
 * (as explicitly defined and verified by the generator in oss/gen.py:831).
 * Consequently, the hardcoded inline ToolAnnotations here (e.g. readOnlyHint)
 * do not present any active risk of drifting from the primary surface's
 * centralized annotation mechanism, and are left intact for reference.
 *
 * The entire tool surface. Six tools. That is the whole API.
 *
 * "Simple tool, simple job; less complex is more secure." Every tool here
 * earns its place by being something an agent cannot do any other way. See the
 * README section "What this deliberately does NOT do" for the list of things
 * that were easy to add and were left out anyway.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';

import type { ServerContext } from './context';
import { toFailure } from './errors';
import { gitDiff, gitList, gitLog, gitPropose, gitPush, gitRead } from './ops';

const OID = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex object id');

const REF = z
  .string()
  .min(1)
  .describe(
    'A branch name (\"main\"), a full ref name (\"refs/heads/main\", \"refs/tags/v1\"), ' +
      'or a 40-hex commit oid. \"HEAD\" resolves to the configured default branch. ' +
      'Refs are resolved from the Firestore ref store, never from packed-refs.',
  );

const PATH = z
  .string()
  .describe('Repository-relative path with \"/\" separators. No leading \"/\", no \"..\".');

/**
 * Every tool answers with a single JSON object as text.
 *
 * Failures set `isError` AND carry `ok:false` plus a machine-readable `code`.
 * Nothing here ever answers a failure with an empty string, an empty list or a
 * bare `null` -- an agent that cannot tell \"this file is empty\" from \"I could
 * not read this file\" will happily commit the difference.
 */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(toFailure(err), null, 2) }],
    isError: true,
  };
}

/**
 * `git_push` reports a lost race as a VALUE (`ok:false, code:\'STALE\'`), not as
 * a thrown error, because losing a race is an ordinary outcome of a correct
 * concurrent system (07-refs §1.4). It is still flagged `isError` so a client
 * that only reads the envelope cannot mistake it for success.
 */
function result(value: { ok: boolean }): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(value.ok ? {} : { isError: true }),
  };
}

export function buildMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'projb-git-mcp', version: '1.0.0' },
    {
      instructions:
        'Read and write a single git repository stored in Cloud Storage + Firestore.\n' +
        'Writes are WHOLE-FILE ONLY: git_propose replaces the entire contents of each ' +
        'path it names. There is no patch, anchor or string-replace operation, by design.\n' +
        'Publishing a change is two steps on purpose: git_propose creates the commit ' +
        'objects (nothing becomes visible), then git_push moves the branch through a ' +
        'compare-and-swap. git_push NEVER retries a lost race -- if it returns ' +
        'code "STALE", re-read the branch, rebuild your change on the new head, and ' +
        'propose again.',
    },
  );

  // -- 1. git_read ---------------------------------------------------------
  server.registerTool(
    'git_read',
    {
      title: 'Read a file at a ref',
      description:
        'Return the full contents of one file as of a ref, plus its blob oid and the ' +
        'commit the ref resolved to. Binary files come back base64-encoded with ' +
        'encoding:"base64". A file over the size cap is an error carrying the size and ' +
        'blob oid, never a truncated body.',
      inputSchema: {
        path: PATH,
        ref: REF,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await gitRead(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- 2. git_list ---------------------------------------------------------
  server.registerTool(
    'git_list',
    {
      title: 'List a directory at a ref',
      description:
        'List the immediate entries of a directory as of a ref. Omit path (or pass "") ' +
        'for the repository root. Each entry carries its name, full path, type ' +
        '(blob/tree/submodule), mode and oid.',
      inputSchema: {
        path: PATH.optional().describe('Directory path; omit or "" for the repository root.'),
        ref: REF,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await gitList(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- 3. git_log ----------------------------------------------------------
  server.registerTool(
    'git_log',
    {
      title: 'List commits',
      description:
        'Commits reachable from a ref, newest first. With path, only commits that ' +
        'changed that file or directory. A path that never existed is an error, not an ' +
        'empty list.',
      inputSchema: {
        ref: REF,
        max_count: z
          .number()
          .int()
          .min(1)
          .max(ctx.cfg.maxLogCount)
          .describe(`How many commits to return (1..${ctx.cfg.maxLogCount}).`),
        path: PATH.optional().describe('Restrict history to this file or directory.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await gitLog(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- 4. git_diff ---------------------------------------------------------
  server.registerTool(
    'git_diff',
    {
      title: 'Unified diff between two refs',
      description:
        'Unified diff from from_ref to to_ref, in git\'s own format. Identical refs ' +
        'return identical:true with an empty patch -- the one legitimately empty ' +
        'answer in this API, and it says so explicitly. Binary and oversized files are ' +
        'reported by name rather than diffed.',
      inputSchema: {
        from_ref: REF.describe('The "a" side (old). Same meaning as in `git diff FROM TO`.'),
        to_ref: REF.describe('The "b" side (new).'),
        path: PATH.optional().describe('Restrict the diff to this file or directory.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return ok(await gitDiff(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- 5. git_propose ------------------------------------------------------
  server.registerTool(
    'git_propose',
    {
      title: 'Create a commit (does not move the branch)',
      description:
        'Write WHOLE FILE CONTENTS as a new commit on top of the branch\'s current head. ' +
        'Each entry REPLACES the entire file at that path; there is no patch, hunk, ' +
        'anchor or string-replace semantics anywhere in this API. Existing files keep ' +
        'their mode (an executable file stays executable). NOTHING BECOMES VISIBLE: the ' +
        'branch is not moved. The returned commitOid and baseOid are the arguments to ' +
        'git_push. If the branch does not exist, this builds a root commit and baseOid ' +
        'is null.',
      inputSchema: {
        branch: z
          .string()
          .min(1)
          .describe('Bare branch name, e.g. "main". Not a full ref, not an oid.'),
        files: z
          .array(
            z.object({
              path: PATH,
              content: z
                .string()
                .describe('The COMPLETE new contents of the file, as UTF-8 text.'),
            }),
          )
          .min(1)
          .max(ctx.cfg.maxProposeFiles)
          .describe('Whole-file writes. Each path is replaced in full.'),
        message: z.string().min(1).describe('Commit message.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return ok(await gitPropose(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -- 6. git_push ---------------------------------------------------------
  server.registerTool(
    'git_push',
    {
      title: 'Move a branch through a compare-and-swap',
      description:
        'Point branch at commit_oid, but ONLY if the branch currently holds expected_oid. ' +
        'expected_oid is required and must be stated explicitly: pass the baseOid from ' +
        'git_propose, or null to assert the branch does not exist yet. On a lost race ' +
        'this returns {ok:false, code:"STALE", expectedOid, actualOid} with the winning ' +
        'oid, and DOES NOT RETRY -- re-reading and re-CASing would be a blind overwrite ' +
        'that discards the winner\'s commits. There is no force push.',
      inputSchema: {
        branch: z.string().min(1).describe('Bare branch name, e.g. "main".'),
        expected_oid: OID.nullable().describe(
          'The oid you believe the branch currently holds, or null to CREATE it. ' +
            'Required -- there is no "just overwrite it" mode.',
        ),
        commit_oid: OID.describe('The commitOid returned by git_propose.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return result(await gitPush(ctx, args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
