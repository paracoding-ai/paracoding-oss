import { loadConfig } from './pcgit/09-mcp/src/config.js';
import { getContext } from './pcgit/09-mcp/src/context.js';
import { gitDiff, gitList, gitLog, gitPropose, gitPush, gitRead, gitUploadBlob } from './pcgit/09-mcp/src/ops.js';
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

// ---------------------------------------------------------------------------
// [SEC-CI-EMIT-V1] THE PUBLISHER. A SUCCESSFUL CAS ON main IS THE ONLY MOMENT
// ANYTHING KNOWS THAT main MOVED, SO IT IS WHERE THE SIGNAL IS EMITTED.
// ---------------------------------------------------------------------------
// WHAT THIS PUBLISHES, AND WHAT IT DELIBERATELY DOES NOT.
//
// It publishes a REF-MOVED NOTICE: {"commit","short","ref"}. It does NOT publish
// the fixed-schema BUILD REQUEST {"commit","short","archive","sha256","ref"} that
// pipeline/cloudbuild-dev.yaml consumes, and it does not publish to that build
// request's topic. THIS IS THE WHOLE DESIGN AND IT IS NOT AN OMISSION:
//
//   `archive` and `sha256` name a single-commit git BUNDLE that is produced AFTER
//   this push, by pipeline/publish-build-request.sh's producer. `git bundle create`
//   is not byte-reproducible, so the digest of a bundle that does not exist yet
//   cannot be predicted -- not approximately, not at all. A message emitted here
//   carrying an invented archive or an invented digest would fire a build whose
//   step 1 verifies that digest, and a wrong digest is a RED BUILD THAT PROVES
//   NOTHING. The invariant is that a build is never fired against an archive that
//   does not exist or whose digest is wrong, so the half that cannot be told
//   truthfully is not told at all.
//
// THE TOPIC IS A DIFFERENT TOPIC, AND THAT IS MEASURED RATHER THAN stylistic.
// The build-request trigger carries no `filter`, so EVERY message on its topic
// fires a build; a notice landing there would bind an empty _ARCHIVE and die at
// `test -n "${_ARCHIVE}"` on every single push. Two topics keep "main moved" and
// "this exact archive is ready to build" as the two different facts they are.
//
// CONFIGURATION IS REQUIRED AND THERE IS NO DEFAULT. PC_CI_TOPIC is unset in a
// fresh install and this publisher is then OFF and says so. A hardcoded topic
// would also name a project inside a file that ships in the release tree, which
// the release leak gate refuses.
//
// A FAILED PUBLISH NEVER FAILS THE PUSH -- AND IS NEVER MERELY LOGGED.
// A CI notification is not a write-surface guarantee, so nothing below can turn a
// durable, successful ref move into an error. But "catch and log" is the pattern
// that converts a broken path into a silent one, so the outcome is written to TWO
// independent sinks, and a publisher that has been dead for a week is visible in
// either:
//   1. `ci_emit` in git_push's own JSON RESPONSE. This sink cannot itself fail --
//      it is the object the caller already reads -- so the agent that pushed sees
//      the failure in the same breath as the success.
//   2. A durable Firestore record under <refsRoot>/<repoId>/ci_emissions: one doc
//      per push keyed by commit oid, plus a `_state` doc carrying last_ok_at and
//      last_fail_at. "last_ok_at is eight days old" is the query that finds a
//      silently dead publisher, and no log line can answer it.
// Only if BOTH sinks fail does this fall back to console.error, tagged so it is
// greppable. That is a third resort, never the only one.

const CI_TIMEOUT_MS = 8000;

export interface CiEmitOutcome {
  attempted: boolean;
  ok: boolean;
  code: string;
  topic: string | null;
  ms: number;
  detail: string;
  recorded?: string;
}

function ciEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

async function ciJson(url: string, init: any, what: string): Promise<any> {
  const res: any = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(what + ' HTTP ' + res.status + ' ' + text.slice(0, 300).replace(/\s+/g, ' '));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(what + ' returned a body that is not JSON: ' + text.slice(0, 200));
  }
}

/** The revision's own identity, from the metadata server. No key, no secret. */
async function ciOwnToken(signal: any): Promise<string> {
  const j = await ciJson(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal },
    'metadata token');
  const t = j && typeof j.access_token === 'string' ? j.access_token : '';
  if (t === '') throw new Error('metadata token response carried no access_token');
  return t;
}

/**
 * Impersonate the publishing identity. NO NEW IAM GRANT IS NEEDED FOR THIS and
 * that was verified rather than assumed: the target service account's own IAM
 * policy already lists this control plane's runtime service account under
 * roles/iam.serviceAccountTokenCreator. The narrower alternative -- binding
 * roles/pubsub.publisher directly on the topic -- could NOT be set, because the
 * dev-side editor identity lacks pubsub.topics.setIamPolicy. That binding belongs
 * in the project bootstrap, which runs as an owner.
 */
async function ciImpersonate(own: string, sa: string, signal: any): Promise<string> {
  const j = await ciJson(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
      + encodeURIComponent(sa) + ':generateAccessToken',
    { method: 'POST', signal,
      headers: { authorization: 'Bearer ' + own, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '300s' }) },
    'generateAccessToken');
  const t = j && typeof j.accessToken === 'string' ? j.accessToken : '';
  if (t === '') throw new Error('generateAccessToken returned no accessToken');
  return t;
}

/**
 * Publish exactly one ref-moved notice. NEVER THROWS: every failure comes back as
 * an outcome the caller reports.
 *
 * `messageIds.length !== 1` is an assertion and not decoration. Pub/Sub answers
 * 200 with an empty messageIds array in cases where nothing was actually
 * enqueued, and "the call succeeded and published nothing" is precisely the
 * silent-death shape this whole block exists to refuse.
 */
async function ciPublishRefMoved(commit: string, refName: string): Promise<CiEmitOutcome> {
  const t0 = Date.now();
  const topic = ciEnv('PC_CI_TOPIC');
  const sa = ciEnv('PC_CI_PUBLISH_SA');
  const off = (code: string, detail: string): CiEmitOutcome =>
    ({ attempted: false, ok: false, code, topic: topic || null, ms: Date.now() - t0, detail });
  if (topic === '') {
    return off('DISABLED_NO_TOPIC',
      'PC_CI_TOPIC is unset, so nothing is published and no build is requested. This is '
      + 'the correct state for an install with no CI project. Set PC_CI_TOPIC to '
      + 'projects/<project>/topics/<topic> to arm it.');
  }
  if (!/^projects\/[a-z0-9-]+\/topics\/[A-Za-z0-9._~+%-]+$/.test(topic)) {
    return off('DISABLED_BAD_TOPIC',
      'PC_CI_TOPIC must be projects/<project>/topics/<topic>; refusing to guess from '
      + JSON.stringify(topic));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CI_TIMEOUT_MS);
  try {
    const own = await ciOwnToken(ctl.signal);
    const token = sa === '' ? own : await ciImpersonate(own, sa, ctl.signal);
    const payload = JSON.stringify({ commit, short: commit.slice(0, 8), ref: refName });
    const out = await ciJson(
      'https://pubsub.googleapis.com/v1/' + topic + ':publish',
      { method: 'POST', signal: ctl.signal,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{
          data: Buffer.from(payload, 'utf8').toString('base64'),
          attributes: { origin: 'git_push', kind: 'ref-moved', ref: refName, commit },
        }] }) },
      'pubsub publish');
    const ids: any[] = (out && out.messageIds) || [];
    if (ids.length !== 1) {
      throw new Error('publish returned ' + ids.length + ' messageIds, want exactly 1');
    }
    return { attempted: true, ok: true, code: 'PUBLISHED', topic,
             ms: Date.now() - t0, detail: 'messageId ' + String(ids[0]) };
  } catch (e: any) {
    const m = e && e.name === 'AbortError'
      ? 'timed out after ' + CI_TIMEOUT_MS + 'ms'
      : String((e && e.message) || e);
    return { attempted: true, ok: false, code: 'FAILED', topic, ms: Date.now() - t0, detail: m };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SINK 2. Durable, queryable, and the only one that answers "has this been dead
 * for a week". Returns a short status string that rides back in the response, so
 * a failure to RECORD is itself visible rather than swallowed.
 */
async function ciRecord(commit: string, refName: string, o: CiEmitOutcome): Promise<string> {
  try {
    const c = ctx();
    const col = c.firestore
      .collection(c.cfg.refsRootCollection)
      .doc(c.cfg.repoId)
      .collection('ci_emissions');
    const at = new Date().toISOString();
    const row: any = { commit, ref: refName, at, writer: c.cfg.writerId,
      attempted: o.attempted, ok: o.ok, code: o.code, topic: o.topic, ms: o.ms, detail: o.detail };
    // A 40-hex oid can never collide with the literal id `_state`.
    await col.doc(commit).set(row);
    await col.doc('_state').set(
      o.ok ? { last_ok_at: at, last_ok_commit: commit, last_code: o.code }
           : { last_fail_at: at, last_fail_commit: commit, last_code: o.code, last_detail: o.detail },
      { merge: true });
    return 'ok';
  } catch (e: any) {
    return 'RECORD_FAILED ' + String((e && e.message) || e).slice(0, 200);
  }
}

/**
 * Called from the git_push handler on a successful CAS, and AWAITED. Awaited on
 * purpose: Cloud Run throttles CPU once the response is written, so a
 * fire-and-forget emission is a publisher that works on a warm instance and
 * silently does not on a cold one. The bounded timeout above is what keeps the
 * cost of awaiting it bounded.
 */
async function ciOnRefMoved(refName: string, commit: string): Promise<CiEmitOutcome> {
  const o = await ciPublishRefMoved(commit, refName);
  o.recorded = await ciRecord(commit, refName, o);
  if (!o.ok && o.attempted && o.recorded !== 'ok') {
    // THIRD RESORT ONLY. Both durable sinks are gone; say so loudly and tagged.
    console.error('[SEC-CI-EMIT-V1] publish AND record both failed for ' + refName + ' '
      + commit + ': publish=' + o.detail + ' record=' + o.recorded);
  }
  return o;
}

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

// ---------------------------------------------------------------------------
// [PCGIT-ARCHIVE-V1] THE WHOLE TREE, AS A TARBALL, FROM THE ONE READER.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. Every deploy this fleet has ever done required a human holding a
// copy of the files. The repository is the authority and it is PCV1-SEALED in the
// lake: a build system reading those objects straight out of GCS gets ciphertext.
// So the source that builds went to two plaintext mirrors -- shared/repo/HEAD/ and a
// bare .git in the source bucket -- both of which went stale, and agents then read
// them AS the source and reported confident nonsense about code that had not existed
// for weeks. The operator's ruling: eliminate the mirrors and work with our git.
//
// WHY THE UNSEAL IS NOT DONE IN THE BUILD. Granting the build a KMS decrypt role is
// easy and would work. It also puts a SECOND implementation of the PCV1 format in a
// place that nothing tests, and two readers of one crypto format drift. When they
// drift this way the build does not go red -- it produces a subtly wrong tree and
// ships it. One reader, here, where the vault code already lives.
//
// WHY IT IS IN gittools.ts AND NOT index.ts, WHICH IS NOT A STYLE CHOICE. This is the
// only esbuild --bundle target, so the object-encryption module record reached from
// here is the SAME one the adapter reads from. index.ts is transpiled, not bundled: a
// walker written there would reach a different module instance whose vault registry is
// empty, and every blob would fail to decrypt. Same mechanism gitBlobOid documents.
//
// NOTHING IS SILENTLY OMITTED. A caller may narrow to a subtree with `path`, and what
// was included comes back in the result. An archive that quietly drops files is the
// mirror problem again wearing a different hat.

function pcTarPad(v: string, n: number): string {
  return v.length >= n ? v.slice(0, n) : v + '\0'.repeat(n - v.length);
}
function pcTarOct(v: number, n: number): string {
  return v.toString(8).padStart(n - 1, '0') + '\0';
}
// ustar splits a path over 100 bytes into name(100) + prefix(155) at a '/' boundary.
// PAX is deliberately not implemented: it is only needed past 255 bytes, no path in
// this repository is close, and an untested PAX writer is worse than a loud refusal.
function pcTarHeader(path: string, size: number, mode: number, mtime: number): Buffer {
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    let cut = path.lastIndexOf('/', 155);
    while (cut > 0 && Buffer.byteLength(path.slice(cut + 1)) > 100) cut = path.lastIndexOf('/', cut - 1);
    if (cut <= 0 || Buffer.byteLength(path.slice(0, cut)) > 155) {
      throw new Error('pcgit archive: path too long for ustar and PAX is not implemented: ' + path);
    }
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const h = Buffer.alloc(512);
  h.write(pcTarPad(name, 100), 0, 'utf8');
  h.write(pcTarOct(mode, 8), 100, 'utf8');
  h.write(pcTarOct(0, 8), 108, 'utf8');
  h.write(pcTarOct(0, 8), 116, 'utf8');
  h.write(pcTarOct(size, 12), 124, 'utf8');
  h.write(pcTarOct(mtime, 12), 136, 'utf8');
  h.write('        ', 148, 'utf8');
  h.write('0', 156, 'utf8');
  h.write(pcTarPad('ustar', 6), 257, 'utf8');
  h.write('00', 263, 'utf8');
  h.write(pcTarPad('root', 32), 265, 'utf8');
  h.write(pcTarPad('root', 32), 297, 'utf8');
  h.write(pcTarPad(prefix, 155), 345, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  return h;
}

// THE READ CAP IS RAISED FOR THIS CALLER ONLY, ON A COPY. ctx().cfg.maxBlobBytes exists
// so that a whole-file WRITE can never be built from a truncated READ; that reasoning does
// not apply to an archive, and index.ts alone is over 600KB, so the shared context is left
// exactly as it is and a copy carries the wider cap.
const PC_ARCHIVE_MAX_BLOB = 64 * 1024 * 1024;
function archiveCtx(): any {
  const base: any = ctx();
  return Object.assign({}, base, { cfg: Object.assign({}, base.cfg, { maxBlobBytes: PC_ARCHIVE_MAX_BLOB }) });
}

async function pcCollect(c: any, ref: string, dir: string, out: any[]): Promise<void> {
  const listed: any = await gitList(c, { path: dir, ref: ref });
  const entries: any[] = (listed && listed.entries) || [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === 'tree') { await pcCollect(c, ref, String(e.path), out); continue; }
    if (e.type !== 'blob') continue;   // submodule/symlink: named in the result, never invented
    out.push({ path: String(e.path), mode: String(e.mode || '100644') });
  }
}

/**
 * Read `ref` out of the repository and return it as a gzipped ustar archive.
 * Returns the buffer plus the manifest of what went in, so a caller can assert
 * coverage instead of trusting a byte count.
 */
export async function gitArchiveTarGz(
  ref: string,
  subPath?: string,
): Promise<{ tgz: Buffer; commit: string; files: number; bytes: number; paths: string[] }> {
  const c = archiveCtx();
  const root = String(subPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const listed: any = await gitList(c, { path: root, ref: String(ref) });
  const commit = String((listed && listed.commit) || '');
  const found: any[] = [];
  await pcCollect(c, String(ref), root, found);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const chunks: Buffer[] = [];
  let bytes = 0;
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    const r: any = await gitRead(c, { path: f.path, ref: String(ref) });
    const body = Buffer.from(String(r.content || ''), r.encoding === 'base64' ? 'base64' : 'utf8');
    // MODE COMES FROM THE TREE, NOT A DEFAULT. install.sh and the bootstrap scripts are
    // 100755 in git, and a release whose scripts arrive without the execute bit reproduces
    // the exact `bash x.sh` vs `./x.sh` defect this fleet has already paid for once.
    const mode = f.mode === '100755' ? 0o755 : 0o644;
    chunks.push(pcTarHeader(f.path, body.length, mode, 0));
    chunks.push(body);
    const rem = body.length % 512;
    if (rem) chunks.push(Buffer.alloc(512 - rem));
    bytes += body.length;
  }
  chunks.push(Buffer.alloc(1024));   // two zero blocks terminate a tar
  const zlib = require('zlib');
  // mtime 0 everywhere and level 9: the same commit must archive to the same bytes, so a
  // build can be compared against a previous one instead of merely re-run.
  const tgz: Buffer = zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  return { tgz, commit, files: found.length, bytes, paths: found.map((f: any) => f.path) };
}

// ---------------------------------------------------------------------------
// [PCGIT-UPLOAD-V1] BYTES IN, THE WAY /git/archive IS BYTES OUT.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. Landing a large file in this repository means a language model
// retyping every byte into git_propose's `content`. index.ts alone is over 600KB --
// hundreds of thousands of generated tokens where one dropped space breaks the file,
// and the single biggest cost in this project. GET /git/archive already lets a machine
// pull the tree OUT over HTTP with no model in the path. This is the counterpart, and
// the bytes go straight into the object store: no model ever sees them.
//
// THE WRITE CAP IS RAISED FOR THIS CALLER ONLY, ON A COPY, exactly as archiveCtx() does
// it and for a symmetrical reason. cfg.maxBlobBytes bounds what a TOOL CALL may carry,
// because a tool call is model-generated bytes; an HTTP PUT of a file is not, and a
// 600KB source file has to fit. The shared context is left exactly as it is -- mutating
// it would raise the cap for every other caller in the process, which is the one thing
// this must not do -- and a copy carries the wider cap.
const PC_UPLOAD_MAX_BLOB = 64 * 1024 * 1024;
function uploadCtx(): any {
  const base: any = ctx();
  return Object.assign({}, base, { cfg: Object.assign({}, base.cfg, { maxBlobBytes: PC_UPLOAD_MAX_BLOB }) });
}

/**
 * Write one uploaded file into the object store and record that `agent` supplied it.
 *
 * `agent` comes from the route's own credential check and never from the request body:
 * the upload record is the ONLY thing that later authorises a git_propose `uploaded`
 * entry, so an agent name the caller could choose would let anyone claim anyone's bytes.
 */
export async function gitUploadBlobForRoute(
  bytes: Buffer,
  agent: string,
): Promise<{ blobOid: string; sha256: string; size: number; expiresAtMs: number }> {
  return await gitUploadBlob(uploadCtx(), bytes, agent);
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
    { description: 'Create a commit on top of a branch head. WHOLE FILE writes only: each entry replaces the entire file. Each entry gives EXACTLY ONE of four options -- zero or two is refused. (1) content, the bytes. (2) copy_from {path, ref}, which REUSES A BLOB ALREADY IN THE REPOSITORY -- the server resolves path at ref and writes that blob oid straight into the tree, so none of its bytes cross the wire and the file cannot be corrupted in transit. copy_from goes through the same ref gate and the same path rules as git_read, so it reaches nothing you could not already read, and an oid is NEVER a lookup key. Optional copy_from.blob_oid is an ASSERTION: the whole call is refused if the source does not resolve to it. (3) uploaded {blob_oid}, for bytes that are NOT yet in the repository: POST the raw file to /git/blob with your session key first, then name the blobOid that call returned. The bytes go over HTTP straight into the object store, so they never cross THIS tool and nothing has to be retyped -- which is the only sane way to land a large file. It resolves ONLY against an upload the SAME agent made, and only while that upload is unexpired; an upload that was never made, has expired, or belongs to another agent is REFUSED and NOTHING is written. An oid is still NEVER a lookup key: you are naming bytes YOU supplied, not naming a blob in the store. Optional uploaded.sha256 is an ASSERTION against the digest recorded when the bytes arrived, and a mismatch refuses the whole call. (4) delete:true, which REMOVES the path. One explicit path per entry: there is no glob, no prefix and no recursive directory removal. Removing a path that does not exist is REFUSED, never a silent success, and a directory left empty by a removal is pruned so the resulting tree stays a valid git object. A removal is resolved against the branch you are already writing to and reaches nothing a write to the same path would not, so it is refused wherever an overwrite would be (a directory, a symlink, a submodule). A per-file blobOid comes back for every entry that writes, so you can still verify each against a locally computed sha1; a removal reports source.removedBlobOid instead -- the oid the path actually held -- plus top-level deleted and deletedPaths, and an uploaded entry reports source.sha256 plus top-level uploaded and bytesUploaded. Nothing becomes visible until git_push. Returns commitOid and baseOid.',
      inputSchema: { branch: z.string(), files: z.array(z.object({ path: z.string(), content: z.string().optional(), copy_from: z.object({ path: z.string(), ref: z.string(), blob_oid: z.string().optional() }).optional(), uploaded: z.object({ blob_oid: z.string(), sha256: z.string().optional() }).optional(), delete: z.boolean().optional() })).min(1), message: z.string(), ...AG } },
    wrap(gitPropose, (a: any) => ({
      branch: a.branch, files: a.files, message: a.message,
      ...(agentId ? { author: { name: agentId, email: agentId + '@' + ctx().cfg.authorEmailDomain } } : {}),
      // [PCGIT-UPLOAD-V1] The IDENTITY the transport resolved, not anything the model wrote.
      // An `uploaded` entry is authorised by the upload record being THIS agent's, so this is
      // the value that decides whose bytes a proposal may claim. With no agentId there is no
      // uploader, and every `uploaded` entry is refused rather than resolved unattributed.
      ...(agentId ? { uploader: agentId } : {}),
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
        // [SEC-CI-EMIT-V1] THE EMISSION POINT. A successful CAS is the only moment in this
        // system that knows BOTH the branch and the new oid, and it is code this fleet owns.
        // Guarded three ways: only a successful push, only main, and only a push that
        // actually MOVED the ref (expected_oid == commit_oid is a legal no-op CAS and is not
        // news). The inner catch is a second net, not the record: ciOnRefMoved does not
        // throw, and if it ever did, a DURABLE REF MOVE must still not be reported to the
        // caller as a failure. Either way the outcome lands in the response as ci_emit.
        const rn = String((r && r.ref) || ('refs/heads/' + String(a.branch)));
        if (r && r.ok === true && rn === 'refs/heads/main' && r.oid !== r.previousOid) {
          try { r.ci_emit = await ciOnRefMoved(rn, String(r.oid)); }
          catch (ce: any) {
            r.ci_emit = { attempted: true, ok: false, code: 'EMITTER_THREW', topic: null, ms: 0,
                          detail: String((ce && ce.message) || ce) };
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], ...(r && r.ok ? {} : { isError: true }) };
      } catch (e) { return failr(e); }
    });
  return ['git_read', 'git_list', 'git_log', 'git_diff', 'git_propose', 'git_propose_patch', 'git_push'];
}
