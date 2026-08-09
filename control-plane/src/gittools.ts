import { loadConfig } from './pcgit/09-mcp/src/config.js';
import { getContext } from './pcgit/09-mcp/src/context.js';
import { gitDiff, gitList, gitLog, gitPropose, gitPush, gitRead } from './pcgit/09-mcp/src/ops.js';
import { gitProposePatch } from './gppatch.js';
import { toFailure } from './pcgit/09-mcp/src/errors.js';

// [PCV1-GIT-VAULT-WIRE-V2] Re-export the git-object vault registry setter FROM INSIDE THE BUNDLE.
// gittools.ts is the only esbuild --bundle target, so the object-encryption module record
// reached from here is the SAME one 05-adapter/src/gcs-store.ts and 07-refs/src/objects.ts
// read from. index.ts is transpiled, not bundled: if it required the standalone transpiled
// copy that the Dockerfile also emits, it would fill a different Map, report the epoch as
// loaded, and the writers would still throw. That failure mode was reproduced under real
// esbuild 0.21.5 and real node before this line was written. Same mechanism gitBlobOid uses.
export { setVaultMasterForEpoch, getVaultMasterForEpoch, loadedVaultEpochs } from './pcgit/05-adapter/src/vault-objenc.js';


let _ctx: any = null;
function ctx(): any {
  if (!_ctx) _ctx = getContext(loadConfig());
  return _ctx;
}
const okr = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const failr = (e: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(toFailure(e), null, 2) }], isError: true });

/**
 * [WIKI-ROUTE-V1] Resolve ONE path at ONE ref to its blob oid, for the /wiki freshness computer in
 * index.ts. It is exported from this module and not reimplemented there because index.ts is
 * TRANSPILED, not bundled -- ./pcgit/09-mcp/src/ops.js does not exist in dist/ and cannot be
 * required from index.js. dist/gittools.js IS a bundle and already carries ops.
 *
 * gitList, NOT gitRead, and that is the whole point of this function: gitRead throws FILE_TOO_LARGE
 * above cfg.maxBlobBytes, and the artifact almost every wiki page watches is control-plane/src/
 * index.ts at over 360,000 bytes. Reading the parent tree returns the entry oid and never
 * materialises the blob, so the size cap is irrelevant and the cost is one tree read.
 *
 * Throws on anything it cannot resolve. The caller turns a throw into RED "FRESHNESS UNKNOWN";
 * a resolver that returned a sentinel would let a missing file read as a match.
 */
export async function gitBlobOid(path: string, ref: string): Promise<string> {
  const clean = String(path || '').replace(/^\/+/, '');
  if (clean === '' || clean.slice(-1) === '/') throw new Error('gitBlobOid: path must name a file, got ' + JSON.stringify(path));
  const cut = clean.lastIndexOf('/');
  const dir = cut < 0 ? '' : clean.slice(0, cut);
  const name = cut < 0 ? clean : clean.slice(cut + 1);
  const listed: any = await gitList(ctx(), { path: dir, ref: String(ref) });
  const entries: any[] = (listed && listed.entries) || [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].name === name) {
      if (entries[i].type !== 'blob') throw new Error('gitBlobOid: ' + clean + ' at ' + ref + ' is a ' + entries[i].type + ', not a file');
      return String(entries[i].oid);
    }
  }
  throw new Error('gitBlobOid: no such file at ' + ref + ': ' + clean);
}

export function registerGitTools(server: any, z: any, AG: any, agentId?: string) {
  // [SEC-GITTOOLS-UNCONFIGURED-V1] REGISTER NOTHING WHEN THERE IS NO REPOSITORY TO SERVE.
  // loadConfig() requireEnv's GIT_REPO_ID and GIT_BUCKET, and ctx() is deferred into the
  // handler rather than evaluated at registration -- so before this guard all seven git
  // tools registered CLEANLY on every install and threw on their FIRST CALL. Nothing in a
  // fresh install sets either variable, so that was every install: seven tools that
  // advertise themselves and then fail. An adopter must see no tool rather than a tool
  // that lies about what it can do.
  //
  // CHECKED HERE AND NOT IN loadConfig(): index.ts also imports this module for gitBlobOid
  // and for the vault-registry re-exports, and both must keep working. The guard withholds
  // the TOOL SURFACE; it does not disable the module.
  //
  // THE THIRD VARIABLE IS NAMED IN THE MESSAGE ON PURPOSE. Setting only the first two
  // leaves the database id to config.ts, and getting that wrong used to produce an EMPTY
  // repository rather than an error. config.ts now reconciles FIRESTORE_DATABASE with
  // PC_FIRESTORE_DB and refuses a conflict, but the operator still has to know it exists.
  const _repoId = String(process.env.GIT_REPO_ID || '');
  const _bucket = String(process.env.GIT_BUCKET || '');
  if (_repoId === '' || _bucket === '') {
    const _absent = [_repoId === '' ? 'GIT_REPO_ID' : '', _bucket === '' ? 'GIT_BUCKET' : '']
      .filter(function (s) { return s !== ''; }).join(' and ');
    console.log('[gittools] git tools NOT registered: ' + _absent + ' unset. This server '
      + 'serves exactly one repository and none is configured, so the tools are withheld '
      + 'rather than registered to fail on first call. To enable them set GIT_REPO_ID and '
      + 'GIT_BUCKET (and FIRESTORE_DATABASE, or leave it unset to follow PC_FIRESTORE_DB) '
      + 'on this service.');
    return [];
  }
  const wrap = (fn: any, shape: any) => async (a: any) => {
    try { return okr(await fn(ctx(), shape(a))); } catch (e) { return failr(e); }
  };
  server.registerTool('git_read',
    { description: 'Read one file at a ref from the fleet repository. Returns full contents, blob oid and the resolved commit. Never truncates: an oversized file is an error carrying the size.',
      inputSchema: { path: z.string(), ref: z.string(), ...AG } },
    wrap(gitRead, (a: any) => ({ path: a.path, ref: a.ref })));
  server.registerTool('git_list',
    { description: 'List the immediate entries of a directory at a ref. Omit path for the repository root. Each entry carries name, path, type, mode and oid.',
      inputSchema: { path: z.string().optional(), ref: z.string(), ...AG } },
    wrap(gitList, (a: any) => ({ path: a.path, ref: a.ref })));
  server.registerTool('git_log',
    { description: 'Commits reachable from a ref, newest first. With path, only commits that changed that file or directory.',
      inputSchema: { ref: z.string(), max_count: z.number().int().min(1).max(200), path: z.string().optional(), ...AG } },
    wrap(gitLog, (a: any) => ({ ref: a.ref, max_count: a.max_count, path: a.path })));
  server.registerTool('git_diff',
    { description: 'Unified diff from from_ref to to_ref in git format. Identical refs return identical:true with an empty patch.',
      inputSchema: { from_ref: z.string(), to_ref: z.string(), path: z.string().optional(), ...AG } },
    wrap(gitDiff, (a: any) => ({ from_ref: a.from_ref, to_ref: a.to_ref, path: a.path })));
  server.registerTool('git_propose',
    { description: 'Create a commit on top of a branch head. WHOLE FILE writes only: each entry replaces the entire file. Each entry gives EXACTLY ONE of three options -- zero or two is refused. (1) content, the bytes. (2) copy_from {path, ref}, which REUSES A BLOB ALREADY IN THE REPOSITORY -- the server resolves path at ref and writes that blob oid straight into the tree, so none of its bytes cross the wire and the file cannot be corrupted in transit. copy_from goes through the same ref gate and the same path rules as git_read, so it reaches nothing you could not already read, and an oid is NEVER a lookup key. Optional copy_from.blob_oid is an ASSERTION: the whole call is refused if the source does not resolve to it. (3) delete:true, which REMOVES the path. One explicit path per entry: there is no glob, no prefix and no recursive directory removal. Removing a path that does not exist is REFUSED, never a silent success, and a directory left empty by a removal is pruned so the resulting tree stays a valid git object. A removal is resolved against the branch you are already writing to and reaches nothing a write to the same path would not, so it is refused wherever an overwrite would be (a directory, a symlink, a submodule). A per-file blobOid comes back for every entry that writes, so you can still verify each against a locally computed sha1; a removal reports source.removedBlobOid instead -- the oid the path actually held -- plus top-level deleted and deletedPaths. Nothing becomes visible until git_push. Returns commitOid and baseOid.',
      inputSchema: { branch: z.string(), files: z.array(z.object({ path: z.string(), content: z.string().optional(), copy_from: z.object({ path: z.string(), ref: z.string(), blob_oid: z.string().optional() }).optional(), delete: z.boolean().optional() })).min(1), message: z.string(), ...AG } },
    wrap(gitPropose, (a: any) => ({
      branch: a.branch, files: a.files, message: a.message,
      ...(agentId ? { author: { name: agentId, email: agentId + '@' + ctx().cfg.authorEmailDomain } } : {}),
    })));
  server.registerTool('git_propose_patch',
    { description: 'Create a commit by applying a UNIFIED DIFF to a branch head, instead of sending whole files. Strict: every hunk must match the current bytes exactly at the line it names -- no fuzz, no offset search. Any hunk that does not apply fails the whole call and NOTHING is committed. Cannot create, delete, rename, chmod or patch binaries. Optional expected_blob_sha is a per-file compare-and-swap (path -> 40-hex blob oid, or null meaning the file must not exist yet). Nothing becomes visible until git_push. Returns commitOid and baseOid.',
      inputSchema: { branch: z.string(), patch: z.string(), message: z.string(), expected_blob_sha: z.record(z.string(), z.string().nullable()).optional(), ...AG } },
    wrap(gitProposePatch, (a: any) => ({
      branch: a.branch, patch: a.patch, message: a.message,
      ...(a.expected_blob_sha ? { expected_blob_sha: a.expected_blob_sha } : {}),
      ...(agentId ? { author: { name: agentId, email: agentId + '@' + ctx().cfg.authorEmailDomain } } : {}),
    })));
  server.registerTool('git_push',
    { description: 'Move a branch by compare-and-swap. expected_oid is required: the baseOid from git_propose, or null to create. A lost race returns ok:false code:STALE and does NOT retry. There is no force push.',
      inputSchema: { branch: z.string(), expected_oid: z.string().nullable(), commit_oid: z.string(), ...AG } },
    async (a: any) => {
      try {
        const r: any = await gitPush(ctx(), { branch: a.branch, expected_oid: a.expected_oid, commit_oid: a.commit_oid } as any);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], ...(r && r.ok ? {} : { isError: true }) };
      } catch (e) { return failr(e); }
    });
  return ['git_read', 'git_list', 'git_log', 'git_diff', 'git_propose', 'git_propose_patch', 'git_push'];
}
