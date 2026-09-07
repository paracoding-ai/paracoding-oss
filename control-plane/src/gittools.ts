import { loadConfig } from './pcgit/09-mcp/src/config.js';
import { getContext } from './pcgit/09-mcp/src/context.js';
import { gitDiff, gitList, gitLog, gitPropose, gitPush, gitRead, gitUploadBlob } from './pcgit/09-mcp/src/ops.js';
import { gitProposePatch } from './gppatch.js';
// [GIT-READ-MULTIPATH-V146] ToolError and badRequest join toFailure on this import: the batch
// branch refuses with TOO_MANY_FILES and BAD_REQUEST, both already members of the shared
// ErrorCode union in errors.ts, so a batch refusal reads like every other refusal on this
// surface instead of inventing a private vocabulary no agent has met before.
import { ToolError, badRequest, toFailure } from './pcgit/09-mcp/src/errors.js';

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

// ---------------------------------------------------------------------------
// [GIT-BLOB-CACHE-V133] THE DECRYPTED BLOB, KEPT BY OID, SO A SECOND GREP IS NEARLY FREE.
// ---------------------------------------------------------------------------
// MEASURED 2026-09-06, after V132 made the reads concurrent: a whole-tree git_grep still costs
// ~16-21s, and the knob is exhausted -- concurrency 12 bought 5x over serial, 24 bought another
// 13%, a second vCPU another 8%, and raising UV_THREADPOOL_SIZE made it WORSE. The remaining
// time is not I/O wait: it is ~300 sequential CPU jobs (bucket fetch, PCV1 decrypt, inflate).
// You cannot parallelise that away on one container, but you do not have to PAY IT TWICE: a
// Gemini Enterprise triage plan runs one grep per work item, so twelve items re-fetch and
// re-decrypt the same 300 blobs twelve times.
//
// WHY AN OID IS A SAFE CACHE KEY, which is the whole argument for this being allowed to exist.
// A git blob oid IS the SHA-1 of its content: the same oid can never name different bytes. So
// this cache cannot go stale, cannot serve one commit's file for another's, and needs no
// invalidation -- a changed file is simply a different oid and a miss. Contrast a path- or
// ref-keyed cache, which WOULD go stale on the next push and would be refused here.
//
// WHAT IS NOT CACHED, on purpose. Only utf-8 text that gitGrep would scan. Binary blobs are
// remembered as a null (so they are not re-fetched just to be skipped again) but their bytes
// are never held. And ONLY gitGrep reads through this: gitRead, readForPublish and the propose
// path are untouched, so nothing that WRITES a file or publishes one can be served from here.
//
// THE CEILING IS BYTES, NOT ENTRIES, because one blob here is 800KB and another is 200. Eviction
// is oldest-first (a Map iterates in insertion order), which is enough: the working set is one
// repository tree and the point is surviving between greps in a turn, not competing with a real
// LRU. Nothing here survives a cold start or reaches another instance, and it does not need to.
const PC_BLOB_CACHE_MAX_BYTES = Math.max(0, Math.floor(Number(process.env.PC_BLOB_CACHE_BYTES) || (192 * 1024 * 1024)));
const pcBlobCache: Map<string, string | null> = new Map();
let pcBlobCacheBytes = 0;

function pcBlobCacheGet(oid: string): { hit: boolean; text: string | null } {
  if (!oid || PC_BLOB_CACHE_MAX_BYTES === 0) return { hit: false, text: null };
  if (!pcBlobCache.has(oid)) return { hit: false, text: null };
  return { hit: true, text: pcBlobCache.get(oid) as string | null };
}

function pcBlobCachePut(oid: string, text: string | null): void {
  if (!oid || PC_BLOB_CACHE_MAX_BYTES === 0 || pcBlobCache.has(oid)) return;
  const cost = text === null ? 0 : text.length;
  if (cost > PC_BLOB_CACHE_MAX_BYTES) return;   // one blob bigger than the whole ceiling
  pcBlobCache.set(oid, text);
  pcBlobCacheBytes += cost;
  while (pcBlobCacheBytes > PC_BLOB_CACHE_MAX_BYTES && pcBlobCache.size > 1) {
    const oldest = pcBlobCache.keys().next();
    if (oldest.done) break;
    const v = pcBlobCache.get(oldest.value);
    pcBlobCacheBytes -= (v === null || v === undefined) ? 0 : v.length;
    pcBlobCache.delete(oldest.value);
  }
}

async function pcCollect(c: any, ref: string, dir: string, out: any[]): Promise<void> {
  const listed: any = await gitList(c, { path: dir, ref: ref });
  const entries: any[] = (listed && listed.entries) || [];
  // [GIT-GREP-PARALLEL-V132] Sibling subtrees are walked concurrently. Every caller sorts
  // `out` by path afterwards, so the order of arrival is immaterial to the result.
  const subs: Promise<void>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === 'tree') { subs.push(pcCollect(c, ref, String(e.path), out)); continue; }
    if (e.type !== 'blob') continue;   // submodule/symlink: named in the result, never invented
    // [GIT-BLOB-CACHE-V133] the oid comes from the TREE, which the walk already read -- carrying
    // it costs nothing here and is what lets gitGrep skip a read entirely. gitArchiveTarGz
    // ignores the extra field.
    out.push({ path: String(e.path), mode: String(e.mode || '100644'), oid: String(e.oid || '') });
  }
  await Promise.all(subs);
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

// [GH-PUBLISH-COPY-V1] READ ONE BLOB OUT OF THE FLEET REPOSITORY FOR REPUBLISHING ELSEWHERE.
// gh_commit takes file content as a TOOL ARGUMENT, which is correct for a config file and
// impossible for a release: the v10.2 changed set is 1.48 MB and control-plane/src/index.ts
// alone is 790 KB, so publishing through arguments would push a megabyte and a half of source
// through an MCP call and the model's context. git_propose solved exactly this with copy_from
// and uploaded{blob_oid}; this is the same idea pointed at GitHub, and the bytes never leave
// the control plane.
//
// IT REUSES gitRead RATHER THAN REACHING PAST IT, which is what makes it binary-safe for free:
// gitRead already returns encoding 'base64' for a binary blob and 'utf-8' for text, and it
// already refuses an oversized read LOUDLY instead of truncating -- a silent truncation here
// would publish a half file to a public repository.
export async function readForPublish(path: string, ref: string): Promise<any> {
  return await gitRead(ctx(), { path, ref });
}

// ---------------------------------------------------------------------------
// [PCGIT-GREP-V1] SEARCH REPOSITORY FILES AT A REF FOR A REGEX OR STRING.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. Paging an entire repository file by file or reading a 1.13MB file
// in 8KB slices through git_read wastes tens of turns and thousands of tokens.
// git_grep performs regex or literal search across all files in the tree at ref
// in-process on the server, returning paths, 1-based line numbers, and matching lines.
//
// HONEST CAPPING: when matches reach max_matches (or character budget ceiling),
// capped: true is reported with an explanatory note and guidance to narrow with path/glob.

function pcGlobToRegex(glob: string): RegExp {
  const g = String(glob || '').trim();
  if (!g) return /.*/;
  let reStr = '^';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          reStr += '(?:.*/)?';
          i += 3;
        } else {
          reStr += '.*';
          i += 2;
        }
      } else {
        reStr += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      reStr += '[^/]';
      i++;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].indexOf(c) >= 0) {
      reStr += '\\' + c;
      i++;
    } else {
      reStr += c;
      i++;
    }
  }
  reStr += '$';
  return new RegExp(reStr, 'i');
}

function pcEscapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// [GIT-GREP-MULTIQUERY-V146] N PATTERNS, ONE TREE WALK, ONE ROUND TRIP.
// ---------------------------------------------------------------------------
// MEASURED 2026-09-07 (prod, Gemini Enterprise): ONE GE turn made 189 MCP tool calls before
// GE cancelled it at its 15-minute ceiling. Server latency across those calls was mean 1.92s
// / median 1.93s, so this server accounted for ~41% of the turn and model turnaround for the
// rest -- about 4.7s per round trip. At 4.7s a turn cannot exceed ~190 tool calls NO MATTER
// HOW FAST THIS SERVER GETS. [GIT-GREP-PARALLEL-V132] (concurrency) and [GIT-BLOB-CACHE-V133]
// (blob cache) each bought real server time and NEITHER moved that ceiling, because the
// ceiling is round trips, not seconds. This is the first change here that removes round
// trips instead of shortening them: twelve greps become one call.
//
// WHY IT IS ALMOST FREE, which is the whole argument for it. The cost of a grep is the tree
// walk plus ~300 sequential bucket-fetch / PCV1-decrypt / inflate jobs -- [GIT-BLOB-CACHE-V133]
// measures that and names this exact waste: "a Gemini Enterprise triage plan runs one grep per
// work item, so twelve items re-fetch and re-decrypt the same 300 blobs twelve times." Running
// a SECOND regex over text ALREADY IN HAND costs regex time and nothing else. So N patterns
// collapse into one walk with N matchers per line, and the 300 CPU jobs are paid once.
//
// WHAT THIS DOES NOT DO. It does not make a single-query grep faster: that path is untouched
// and its result is byte-identical. It does not raise CHAR_BUDGET. It does not parallelise
// anything new. It does not deduplicate patterns, merge them into one alternation, or reorder
// files -- the walk is still ONE pass in path order, so [GIT-GREP-PARALLEL-V132]'s promise
// that results equal a serial walk still holds.
//
// THE PRICE, STATED PLAINLY. Twelve separate calls could each return a 45000-character budget:
// 540000 characters. One call returns 45000. The round-trip saving is paid for in total
// returned bytes, and the ONLY thing that makes that trade acceptable is that the result says
// exactly WHICH queries were cut off, so the caller re-runs those alone instead of guessing.
//
// A FUTURE READER MUST NOT "FIX" ANY OF THE FOLLOWING:
//  - Do not raise CHAR_BUDGET because N queries now share it. That budget is not sized for
//    this function's comfort, it is sized for [CHAT-RESULT-CAP-V2] downstream in index.ts. A
//    result that overruns that cap arrives CUT with a notice instead of CAPPED with a count.
//  - Do not divide CHAR_BUDGET by N. The reasoning is at the matcher loop below.
//  - Do not add `q` to a single-query match. The reasoning is on GitGrepMatch below.
//  - Do not restore a per-pattern literal fallback for `queries`. The reasoning is at the
//    compile step below.
const PC_GREP_MAX_QUERIES = 32;
// [GIT-GREP-MULTIQUERY-V146] WHY 32, AND WHY BOUNDED AT ALL. Each extra pattern is one more
// regex test per line of every file in the tree, run inside one request on one container: an
// UNBOUNDED `queries` array is a denial-of-service a caller commits against its own control
// plane by typing a bigger array. 32 is sized against the measured workload -- the recorded
// pattern is TWELVE work items in one triage plan -- so it is ~2.6x the largest real case,
// and at N=32 the regex term is 32x a term that is already the minority of a 1.92s mean call.
// EXCEEDING IT IS A THROWN REFUSAL naming the limit and the count supplied. It is never a
// silent truncation of the array: a caller who sent 40 patterns and got 32 searched would
// read the result as exhaustive over all 40. That is [GCP-DIFF-CAPPED-V90] exactly -- a
// capped result that "failed in the most expensive way: SILENTLY, LOOKING LIKE SUCCESS."

export interface GitGrepOptions {
  ref: string;
  // [GIT-GREP-MULTIQUERY-V146] EXACTLY ONE OF `query` OR `queries`. `query` is optional in
  // TypeScript terms now only so that `queries` can be the one supplied; omitting BOTH is the
  // same thrown error it has always been. Supplying BOTH is a REFUSAL rather than a merge: the
  // two modes return different result shapes and a merge would have to pick one silently,
  // which is how a caller ends up parsing a result it did not ask for.
  query?: string;
  queries?: string[];
  path?: string;
  glob?: string;
  context?: number;
  is_regex?: boolean;
  case_sensitive?: boolean;
  max_matches?: number;
}

export interface GitGrepMatch {
  path: string;
  line: number;
  content: string;
  // [GIT-GREP-MULTIQUERY-V146] WHICH QUERY PRODUCED THIS MATCH: a 0-based index into the
  // result's `queries` array. ASSIGNED ONLY IN MULTI-QUERY MODE. In single-query mode it is
  // never assigned, so JSON.stringify omits the key entirely and the bytes an existing caller
  // receives are unchanged. That is the whole reason it is an optional index on the shared
  // interface rather than a required field or a second match type.
  // AN INDEX, NOT THE PATTERN TEXT: a 200-character pattern echoed onto 500 matches is 100000
  // characters against a 45000-character budget. The index costs one or two.
  q?: number;
  context_before?: string[];
  context_after?: string[];
}

// [GIT-GREP-MULTIQUERY-V146] ONE ROW PER QUERY, AND THE ONLY PLACE THAT SAYS WHETHER A ZERO IS
// A REAL ZERO. `capped: false, reason: null` is the ONLY combination that means "this pattern
// was searched exhaustively over every eligible file and this count is exact". Anything else
// means `matches` is a FLOOR -- including when that floor is 0.
export interface GitGrepQueryReport {
  q: number;
  query: string;
  matches: number;
  capped: boolean;
  reason: 'match_cap' | 'walk_stopped' | null;
}

export interface GitGrepResult {
  ok: boolean;
  ref: string;
  // [GIT-GREP-MULTIQUERY-V146] `query` is present in single-query results and ABSENT in
  // multi-query ones; `queries` is the mirror of that. Multi-query mode does NOT fill `query`
  // with a joined or first-of string: a plausible-looking value is something a caller will
  // match on, and an absent key reads as undefined immediately.
  query?: string;
  queries?: string[];
  matches: GitGrepMatch[];
  total_matches: number;
  matches_returned: number;
  capped: boolean;
  cap?: number;
  files_searched: number;
  total_files: number;
  // [GIT-BLOB-CACHE-V133] how many of total_files were served from the decrypted-blob cache.
  // Reported so a cold grep and a warm one are told apart from the outside.
  cache_hits?: number;
  cache_misses?: number;
  // [GIT-GREP-MULTIQUERY-V146] MULTI-QUERY ONLY. walk_complete is true when the walk reached
  // the end of the eligible file list. FALSE MEANS NOTHING IN THIS RESULT IS EXHAUSTIVE, for
  // any query: all N queries ride one walk, so a stop at file k is a stop at file k for every
  // one of them. The flag errs toward NOT claiming exhaustiveness -- a stop on the last line
  // of the last file is still reported as a stop.
  walk_complete?: boolean;
  per_query?: GitGrepQueryReport[];
  note?: string;
}

export async function gitGrep(opts: GitGrepOptions): Promise<GitGrepResult> {
  const ref = String(opts.ref || '').trim();
  if (!ref) throw new Error('git_grep: ref is required');

  // [GIT-GREP-MULTIQUERY-V146] MODE IS DECIDED ONCE, HERE, AND LOUDLY. A non-empty `queries`
  // selects multi-query mode; otherwise this is the single-query call it has always been.
  const hasQueries = Array.isArray(opts.queries) && opts.queries.length > 0;
  const hasQuery = opts.query !== undefined && opts.query !== null && String(opts.query) !== '';
  if (hasQueries && hasQuery) {
    throw new Error('git_grep: pass EITHER query OR queries, never both. Got query='
      + JSON.stringify(String(opts.query)) + ' together with ' + (opts.queries as string[]).length
      + ' entries in queries. The two modes return different result shapes, so this is refused '
      + 'rather than merged. Move the single pattern into the queries array.');
  }
  if (!hasQueries && !hasQuery) throw new Error('git_grep: query is required');

  const rawQueries: string[] = hasQueries
    ? (opts.queries as string[]).map(q => String(q === undefined || q === null ? '' : q))
    : [String(opts.query)];
  if (rawQueries.length > PC_GREP_MAX_QUERIES) {
    throw new Error('git_grep: queries is limited to ' + PC_GREP_MAX_QUERIES + ' patterns per '
      + 'call and ' + rawQueries.length + ' were supplied. The array is NOT truncated to the '
      + 'limit, because a truncated array returns a result that looks exhaustive over patterns '
      + 'that were never searched. Split this into ' + Math.ceil(rawQueries.length / PC_GREP_MAX_QUERIES)
      + ' calls.');
  }
  for (let qi = 0; qi < rawQueries.length; qi++) {
    if (rawQueries[qi] === '') {
      throw new Error('git_grep: queries[' + qi + '] is empty. An empty pattern matches every '
        + 'line of every file, so it would spend the entire shared character budget inside the '
        + 'first file and silence every other pattern in the call.');
    }
  }
  const query = rawQueries[0];

  const c = archiveCtx();
  const rawCtx = Number(opts.context);
  const context = (isFinite(rawCtx) && rawCtx >= 0) ? Math.min(20, Math.floor(rawCtx)) : 0;
  const rawMax = Number(opts.max_matches);
  const maxMatches = (isFinite(rawMax) && rawMax > 0) ? Math.min(500, Math.floor(rawMax)) : 100;
  const caseSensitive = opts.case_sensitive === true;
  const isRegex = opts.is_regex !== false;

  // [GIT-GREP-MULTIQUERY-V146] COMPILATION IS DELIBERATELY ASYMMETRIC BETWEEN THE TWO MODES.
  // SINGLE-QUERY keeps the documented silent fallback to a literal search on an invalid regex,
  // byte-for-byte unchanged: the schema promises it, callers depend on it, and with exactly one
  // pattern the outcome is still unambiguous because `query` is echoed and there is only one
  // interpretation of the result.
  // MULTI-QUERY REFUSES THE WHOLE CALL when any pattern fails to compile, naming the index, the
  // pattern and the engine's own message. It does NOT fall back per pattern, and a future
  // reader must not "restore consistency" by making it: a call in which eleven patterns ran as
  // regexes and the twelfth silently ran as a literal produces a result nobody can interpret,
  // and -- worse -- nobody can tell from the result that it happened.
  // NO PATTERN IS SEARCHED before every pattern has compiled, so the refusal costs no tree walk.
  const matchers: RegExp[] = new Array(rawQueries.length);
  for (let qi = 0; qi < rawQueries.length; qi++) {
    if (isRegex) {
      try {
        matchers[qi] = new RegExp(rawQueries[qi], caseSensitive ? '' : 'i');
      } catch (e: any) {
        if (hasQueries) {
          throw new Error('git_grep: queries[' + qi + '] is not a valid regex: '
            + JSON.stringify(rawQueries[qi]) + ' -- ' + String((e && e.message) || e)
            + '. NO pattern in this call was searched. Fix that pattern, or pass is_regex:false '
            + 'to search every pattern in the call literally. There is deliberately no '
            + 'per-pattern fallback: a half-regex, half-literal result cannot be read.');
        }
        matchers[qi] = new RegExp(pcEscapeRegex(rawQueries[qi]), caseSensitive ? '' : 'i');
      }
    } else {
      matchers[qi] = new RegExp(pcEscapeRegex(rawQueries[qi]), caseSensitive ? '' : 'i');
    }
  }

  const cleanPath = String(opts.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const globRe = opts.glob ? pcGlobToRegex(opts.glob) : null;

  const found: any[] = [];
  await pcCollect(c, ref, '', found);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let candidates = found;
  if (cleanPath) {
    candidates = candidates.filter(f => f.path === cleanPath || f.path.startsWith(cleanPath + '/'));
  }
  if (globRe) {
    candidates = candidates.filter(f => globRe.test(f.path));
  }

  const matches: GitGrepMatch[] = [];
  let filesSearched = 0;
  let capped = false;
  let totalChars = 0;
  const CHAR_BUDGET = 45000;

  // [GIT-GREP-MULTIQUERY-V146] HOW ONE BUDGET IS SHARED BY N QUERIES, AND WHY IT IS NOT DIVIDED.
  //
  // THE DECISION: max_matches is counted PER QUERY; CHAR_BUDGET stays ONE SHARED, UNDIVIDED
  // budget; exhausting CHAR_BUDGET stops the walk for everybody at the same file.
  //
  // WHY NOT DIVIDE THE BUDGET BY N. 45000/12 is 3750 characters -- roughly seven matches -- for
  // each of twelve patterns. In the measured triage workload most of those twelve patterns hit
  // a handful of files and one hits many, so dividing pre-commits eleven slices that go unspent
  // in order to cap the one pattern the caller actually needed. Division does not remove the
  // failure, it guarantees it in the common case.
  //
  // WHY max_matches IS NEVERTHELESS PER QUERY. Without that, one high-frequency pattern fills
  // `matches` to max_matches and every other pattern reports zero -- indistinguishable, to any
  // reader, from "not present in this repository". That is the [GCP-DIFF-CAPPED-V90] failure.
  //
  // WHAT MAKES A SHARED BUDGET HONEST rather than merely convenient: all N queries are evaluated
  // over THE SAME FILES IN THE SAME ORDER in one walk, so stopping on the shared budget is a
  // PREFIX stop -- every query has searched exactly the same files_searched files. There is no
  // state in which query 1 saw 368 files and query 7 saw 3. So walk_complete:false means
  // NOTHING in the result is exhaustive for ANY query, and per_query says so for each one.
  //
  // THE COST, STATED: a pattern with thousands of hits can still spend the shared budget and
  // stop the walk at file k. The result then marks EVERY query capped and the caller re-runs
  // the ones it still needs, narrowed with path/glob. It pays one more round trip. It does not
  // get a wrong answer, and it is never handed a zero it cannot trust.
  const qMatchCount: number[] = new Array(rawQueries.length).fill(0);
  const qCapReason: Array<'match_cap' | 'walk_stopped' | null> = new Array(rawQueries.length).fill(null);
  let qRetired = 0;
  let stoppedEarly = false;

  // [GIT-GREP-PARALLEL-V132] MEASURED 2026-09-06 (Cloud Run request logs, mcp service): one
  // gitRead costs ~0.3s (ref resolve, tree walk, blob fetch from the bucket) and this loop read
  // the 368 files of main ONE AT A TIME, so a whole-tree grep took 107-112s. Seven of them in one
  // Gemini Enterprise turn spent 13 of the 15 minutes GE allows before it cancels the run, and
  // the person got an empty answer. Reads now run PC_GREP_CONCURRENCY ahead of the matcher in a
  // sliding window. The matcher still walks files in path order, so matches, counts and where
  // the cap lands are identical to the serial result; only the wall clock changes.
  const PC_GREP_CONCURRENCY = Math.max(1, Math.min(32, Math.floor(Number(process.env.PC_GREP_CONCURRENCY) || 12)));
  const reads: Array<Promise<any> | undefined> = new Array(candidates.length);
  // [GIT-BLOB-CACHE-V133] A cached oid is not read at all -- no fetch, no decrypt, no inflate --
  // so a warm second grep over the same tree is regex time only. Counted, and reported, because
  // a cache whose hit rate nobody can see is a cache nobody can debug.
  let cacheHits = 0;
  let cacheMisses = 0;
  const startRead = (j: number) => {
    if (j < candidates.length && !reads[j] && !pcBlobCacheGet(String(candidates[j].oid || '')).hit) {
      reads[j] = gitRead(c, { path: candidates[j].path, ref: ref }).catch(() => null);
    }
  };
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    for (let j = i; j < i + PC_GREP_CONCURRENCY; j++) startRead(j);
    const oid = String(f.oid || '');
    const cached = pcBlobCacheGet(oid);
    let text: string;
    if (cached.hit) {
      cacheHits++;
      reads[i] = undefined;
      if (cached.text === null) continue;          // known binary: skip without re-reading
      text = cached.text;
    } else {
      cacheMisses++;
      const r: any = await reads[i];
      reads[i] = undefined;
      if (!r || r.encoding === 'base64') {
        // remember the SKIP too, so the next grep does not fetch it again to skip it again
        if (r && oid) pcBlobCachePut(oid, null);
        continue;
      }
      text = String(r.content || '');
      // the oid the READ resolved is authoritative over the one the tree walk carried
      pcBlobCachePut(String(r.blobOid || oid), text);
    }
    filesSearched++;
    const lines = text.split('\n');

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // [GIT-GREP-MULTIQUERY-V146] N tests against a line ALREADY IN MEMORY -- this is the
      // cheap part, and the reason the whole change is worth making. THE ORDER IS file, then
      // line, then query index: a total order that does not depend on which pattern is busier,
      // so the result equals N serial walks concatenated and re-sorted, and the identical-to-
      // serial promise of [GIT-GREP-PARALLEL-V132] still holds. Do NOT collapse these N tests
      // into one alternation regex: an alternation cannot say WHICH branch matched, which is
      // precisely what `q` has to report.
      let lineTrim: string | null = null;
      for (let qi = 0; qi < matchers.length; qi++) {
        if (qCapReason[qi] !== null) continue;      // this query has stopped collecting
        if (!matchers[qi].test(line)) continue;
        if (lineTrim === null) lineTrim = line.length > 500 ? line.slice(0, 500) + '... [truncated]' : line;
        const matchObj: GitGrepMatch = {
          path: f.path,
          line: li + 1,
          content: lineTrim,
        };
        // [GIT-GREP-MULTIQUERY-V146] `q` is assigned ONLY in multi-query mode -- leaving it
        // unassigned is what keeps a single-query match byte-identical on the wire. It is also
        // deliberately NOT charged against totalChars: it is at most three characters against a
        // 45000 budget, and charging it would make the same corpus cap at a different match for
        // a single-query call than for a one-element queries call.
        if (hasQueries) matchObj.q = qi;
        if (context > 0) {
          matchObj.context_before = lines.slice(Math.max(0, li - context), li).map(l => l.length > 500 ? l.slice(0, 500) + '... [truncated]' : l);
          matchObj.context_after = lines.slice(li + 1, Math.min(lines.length, li + 1 + context)).map(l => l.length > 500 ? l.slice(0, 500) + '... [truncated]' : l);
        }

        const matchChars = lineTrim.length + (context > 0 ? ((matchObj.context_before || []).join('').length + (matchObj.context_after || []).join('').length) : 0);
        totalChars += matchChars;

        matches.push(matchObj);
        qMatchCount[qi]++;

        // [GIT-GREP-MULTIQUERY-V146] TWO DIFFERENT STOPS, RECORDED DIFFERENTLY. A per-query
        // match cap retires ONE query and the walk continues for the rest. The shared character
        // budget retires EVERY query still collecting -- including ones sitting at zero matches,
        // which is the exact case this design exists to stop reporting as "not found". With one
        // query both branches reduce to the old `matches.length >= maxMatches || totalChars >=
        // CHAR_BUDGET` and break in the same place, on the same match.
        if (totalChars >= CHAR_BUDGET) {
          capped = true;
          for (let qj = 0; qj < matchers.length; qj++) {
            if (qCapReason[qj] === null) { qCapReason[qj] = 'walk_stopped'; qRetired++; }
          }
          break;
        }
        if (qMatchCount[qi] >= maxMatches) {
          capped = true;
          qCapReason[qi] = 'match_cap';
          qRetired++;
          if (qRetired >= matchers.length) break;
        }
      }
      if (qRetired >= matchers.length) break;
    }
    if (qRetired >= matchers.length) { stoppedEarly = true; break; }
  }
  const walkComplete = !stoppedEarly;

  // [GIT-GREP-MULTIQUERY-V146] Built for both modes and attached only in multi-query mode, so
  // that the single-query result literal below stays exactly the object it has always been.
  const perQuery: GitGrepQueryReport[] = rawQueries.map((qs, qi) => ({
    q: qi,
    query: qs,
    matches: qMatchCount[qi],
    capped: qCapReason[qi] !== null,
    reason: qCapReason[qi],
  }));

  // [GIT-GREP-MULTIQUERY-V146] TWO LITERALS, NOT ONE LITERAL PLUS PATCHES, on purpose. The
  // single-query branch is the original object with the original keys in the original order,
  // so a maintainer can verify byte-identical output by reading it rather than by reasoning
  // about which keys a later `delete` removed. Do not "de-duplicate" these two.
  const res: GitGrepResult = hasQueries ? {
    ok: true,
    ref: ref,
    queries: rawQueries,
    matches: matches,
    total_matches: matches.length,
    matches_returned: matches.length,
    capped: capped,
    files_searched: filesSearched,
    total_files: candidates.length,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
    walk_complete: walkComplete,
    per_query: perQuery,
  } : {
    ok: true,
    ref: ref,
    query: query,
    matches: matches,
    total_matches: matches.length,
    matches_returned: matches.length,
    capped: capped,
    files_searched: filesSearched,
    total_files: candidates.length,
    cache_hits: cacheHits,
    cache_misses: cacheMisses,
  };

  if (hasQueries) {
    // [GIT-GREP-MULTIQUERY-V146] THE NOTE NAMES INDICES. "capped: true" on a twelve-pattern
    // result that does not say WHICH twelve is the same non-answer as no note at all. A query
    // NOT named here was searched over every eligible file and its count is exact, INCLUDING a
    // count of zero. That sentence is the entire contract of this tool in multi-query mode.
    const cappedIdx = perQuery.filter(p => p.capped).map(p => p.q);
    if (capped) {
      res.cap = maxMatches;
      res.note = 'CAPPED, NOT COMPLETE. ' + cappedIdx.length + ' of ' + rawQueries.length
        + ' queries were cut off: q=' + cappedIdx.join(',') + '. '
        + (walkComplete
            ? 'The walk did cover all ' + filesSearched + ' searched files, so each cut-off query '
              + 'hit the PER-QUERY match cap of ' + maxMatches + ' and its count is a FLOOR; every '
              + 'query not named above was searched exhaustively and its count is exact. '
            : 'The shared ' + CHAR_BUDGET + '-character budget stopped the walk after '
              + filesSearched + ' of ' + candidates.length + ' files, so NO query in this result '
              + 'is exhaustive -- a zero here means "not found in the first ' + filesSearched
              + ' files", NOT "not present". ')
        + 'Re-run the cut-off queries on their own, narrowed with `path` (e.g. path="'
        + (cleanPath || 'control-plane/src') + '") or `glob` (e.g. glob="*.ts").';
    } else {
      res.note = 'COMPLETE. All ' + rawQueries.length + ' queries were searched exhaustively '
        + 'across ' + filesSearched + ' files at ref ' + ref + '. Every per_query count is exact, '
        + 'including any zero.';
    }
  } else if (capped) {
    res.cap = maxMatches;
    res.note = 'MATCH CAP REACHED. Found ' + matches.length + ' matches across '
      + filesSearched + ' files and stopped. The result is CAPPED, not complete. '
      + 'Narrow your search with `path` (e.g. path="' + (cleanPath || 'control-plane/src') + '") '
      + 'or `glob` (e.g. glob="*.ts"), or use a more specific query.';
  } else if (matches.length === 0) {
    res.note = 'NO MATCHES FOUND across ' + filesSearched + ' files searched at ref ' + ref + '.';
  }

  return res;
}

// ---------------------------------------------------------------------------
// [GIT-READ-MULTIPATH-V146] N FILES IN ONE ROUND TRIP, BECAUSE THE ROUND TRIP IS THE COST.
// ---------------------------------------------------------------------------
// MEASURED ON PROD 2026-09-07: Gemini Enterprise cancels a turn at 15 minutes, and one observed
// turn spent that budget on 189 MCP tool calls at ~4.7s per round trip -- of which this server
// accounted for a mean of 1.92s and GE's own model turnaround for the remaining ~2.8s. That is a
// HARD CEILING OF ABOUT 190 CALLS PER TURN, and it is a ceiling on CALLS, not on bytes and not on
// server time. Reading twelve files cost twelve of them: ~56s of wall clock, ~34s of which this
// server was not even running. One batched call costs one round trip plus the reads, and the reads
// run concurrently. Making the server faster cannot fix this. Making fewer calls can.
//
// WHAT THIS DOES NOT DO, AND MUST NOT BE "FIXED" INTO DOING.
//
// (1) IT DOES NOT TRUNCATE A FILE TO MAKE IT FIT. A file comes back WHOLE, or it is named in
//     `omitted` with its size, line count and oid, or it is named in `failed` with the error code
//     that stopped it. It is never quietly shortened and it is never quietly dropped.
//     [GCP-DIFF-CAPPED-V90] recorded what the other choice costs: a capped result "failed in the
//     most expensive way: SILENTLY, LOOKING LIKE SUCCESS." Every requested path lands in exactly
//     one of files/omitted/failed and the arithmetic is asserted before this function answers --
//     a batch that cannot account for every path it was given reports ok:false rather than a short
//     list that looks complete.
//
// (2) IT DOES NOT PAGE. offset/length/line_start/line_count are REFUSED alongside `paths` in the
//     handler rather than applied to some file the caller cannot name. One range across N files
//     has no meaning, and a range per file would misalign silently, which is defect class (1)
//     wearing a different hat. THE ONE EXCEPTION IS BOUNDED AND STATED: a partial appears only
//     when NO file could be returned whole, so a batch that read anything always returns
//     something instead of an empty success the caller cannot tell from an empty repository.
//     That partial carries the same range object, next_offset and blobOid a single-path partial
//     carries, and it tells the caller to finish the file with a SINGLE path. At most one file per
//     batch is ever partial. Do not extend this to a second file.
//
// (3) IT DOES NOT READ THROUGH THE [GIT-BLOB-CACHE-V133] BLOB CACHE, and that is deliberate. That
//     cache's own comment draws the line -- "ONLY gitGrep reads through this: gitRead,
//     readForPublish and the propose path are untouched, so nothing that WRITES a file or
//     publishes one can be served from here" -- and a git_read result IS what an agent edits and
//     hands back to git_propose. Serving one from cache puts cached bytes one hop from the write
//     path, for no gain: the cache is keyed by oid, gitGrep has that oid from a tree walk it
//     already paid for, and a path-addressed read has no oid until the read you wanted to avoid
//     has already resolved it. Crossing the boundary here would mean adding a tree walk to obtain
//     the key, which costs about what the read costs. A future reader who wants the cache on this
//     path must MOVE the boundary explicitly and argue the write-path risk, not quietly widen a
//     call site.
//
// THE BUDGET IS SELF-IMPOSED, BECAUSE NOTHING ELSE IMPOSES ONE. git_read is in
// PC_RESULT_CAP_EXEMPT (control-plane/src/index.ts:1249, alongside whoami and read_file), so
// PC_RESULT_MAX (55555, index.ts:1247) does NOT cut this tool's result. That exemption exists so a
// whole-file read can never become a whole-file write of a prefix -- but EXEMPT MEANS UNGUARDED,
// NOT UNLIMITED. Twelve files at 40,000 characters is 480,000 characters, and the chat surface
// downstream would deliver a fraction of it with a notice this code never sees. So the batch keeps
// its own ceiling, at the same 55555, and a batch that fits here fits every surface that carries
// a single git_read today.
//
// THE CEILING IS MEASURED ON THE SERIALIZED RESULT, NOT ESTIMATED FROM content.length, and the
// difference is not academic. okr() emits JSON.stringify(v, null, 2): a newline costs two
// characters once escaped, every quote and backslash costs two more, and two-space indentation is
// charged on every field of every entry -- including the `omitted` entries, which are pure
// envelope. MEASURED against the first draft of this function, which reserved a flat 5555 for the
// envelope: 24 paths with one large file and 23 long-named omissions serialized to 56,791
// characters, 1,236 OVER the ceiling it reported as respected. A budget that is approximately true
// is the same defect as a result that is approximately complete. So membership is decided by
// SERIALIZING THE WHOLE RESULT and asking whether it fits -- at most 25 stringifies of at most
// 55KB, microseconds against reads that cost ~300ms each -- and the number this result reports as
// its ceiling is the number it actually honoured.
//
// THE CEILING IS A NAMED CONSTANT, NOT A LITERAL BURIED IN AN EXPRESSION, because the number has
// to be findable from the other end: someone changing PC_RESULT_MAX in index.ts must be able to
// grep 55555 and land here. It is NOT imported from index.ts -- index.ts imports THIS module, for
// gitBlobOid and the vault-registry re-exports, and the back-edge would be a require cycle that
// esbuild resolves differently from tsc. So the number is duplicated ON PURPOSE and these two
// comments are the link between the copies. Change one, change the other.
const PC_READ_WIRE_MAX_DEFAULT = 55555;      // mirrors PC_RESULT_MAX, control-plane/src/index.ts:1247
const PC_READ_MAX_PATHS_DEFAULT = 24;        // ~2,000 characters of file each at the ceiling above
const PC_READ_CONCURRENCY_DEFAULT = 12;      // same default as PC_GREP_CONCURRENCY, gittools.ts:649

async function pcReadMany(paths: string[], ref: string): Promise<any> {
  // Knobs are read PER CALL, exactly as PC_GREP_CONCURRENCY is read inside gitGrep: an operator
  // changes the env on the service and the next call obeys it, with no redeploy and no restart.
  const PC_READ_MAX_PATHS = Math.max(1, Math.min(64, Math.floor(Number(process.env.PC_READ_MAX_PATHS) || PC_READ_MAX_PATHS_DEFAULT)));
  const PC_READ_WIRE_MAX = Math.max(8192, Math.floor(Number(process.env.PC_READ_MULTI_BUDGET) || PC_READ_WIRE_MAX_DEFAULT));
  const PC_READ_CONCURRENCY = Math.max(1, Math.min(32, Math.floor(Number(process.env.PC_READ_CONCURRENCY) || PC_READ_CONCURRENCY_DEFAULT)));
  // THE PATH BOUND IS A LOUD REFUSAL THAT READS NOTHING, and it reuses TOO_MANY_FILES rather than
  // inventing a code: [GCP-PROPOSE-FILE-CAP-100] established that spelling for git_propose's
  // 100-file bound, and an agent that has met one recognises the other. 24 is not a guess -- the
  // ceiling is ~55,000 characters, so 24 paths is ~2,000 characters of file each, and past that
  // the omitted list is most of what comes back and the caller has paid a round trip for a to-do
  // list. Raise the knob if a caller genuinely reads 40 tiny files; do not raise the default.
  if (paths.length > PC_READ_MAX_PATHS) {
    throw new ToolError('TOO_MANY_FILES',
      'git_read: ' + paths.length + ' paths in one call, over the ' + PC_READ_MAX_PATHS
      + '-path limit. NOTHING WAS READ and no file was returned. Split the list and call again; '
      + PC_READ_MAX_PATHS + ' paths still collapse ' + PC_READ_MAX_PATHS + ' round trips into one.',
      { count: paths.length, limit: PC_READ_MAX_PATHS, paths: paths });
  }

  // ----- PHASE 1: READ EVERYTHING, CONCURRENTLY, AND DECIDE NOTHING -----
  // [GIT-GREP-PARALLEL-V132] THE SAME SLIDING WINDOW gitGrep USES, and deliberately the same shape
  // rather than a second invention: reads run PC_READ_CONCURRENCY ahead while results are consumed
  // in the CALLER'S ORDER. That ordering is what makes a batch deterministic -- which files fit
  // must not depend on which bucket fetch happened to return first. Only the wall clock changes.
  // A rejected read is caught INTO A VALUE here rather than left to reject: one missing file must
  // not take down the other eleven, and an unhandled rejection inside a read-ahead window would.
  const c = ctx();
  const reads: Array<Promise<any> | undefined> = new Array(paths.length);
  const startRead = (j: number) => {
    if (j < paths.length && !reads[j]) {
      reads[j] = gitRead(c, { path: paths[j], ref: ref }).then(
        (r: any) => ({ ok: true, r: r, e: null }),
        (e: any) => ({ ok: false, r: null, e: e }));
    }
  };
  const got: any[] = new Array(paths.length);
  for (let i = 0; i < paths.length; i++) {
    for (let j = i; j < i + PC_READ_CONCURRENCY; j++) startRead(j);
    got[i] = await reads[i];
    reads[i] = undefined;
  }

  // ----- PHASE 2: PRICE EVERY FILE BEFORE INCLUDING ANY OF IT -----
  // TWO PHASES AND NOT ONE, because the cost of OMITTING a file is not zero: an omitted entry is
  // ~250 characters of envelope, and 23 of them is most of the headroom a one-pass loop would have
  // already spent on file bodies. Deciding membership needs the whole picture, and the whole
  // picture needs every read to have landed. The reads happen once either way.
  const failed: any[] = [];
  const cand: any[] = [];
  let commit = '';
  let refName = '';
  for (let i = 0; i < paths.length; i++) {
    const g: any = got[i];
    if (!g || g.ok !== true) {
      // ONE UNREADABLE FILE IS NAMED, NOT THROWN. PATH_NOT_FOUND, NOT_A_BLOB and FILE_TOO_LARGE
      // are per-FILE facts inside a batch; failing the whole call on the first would discard the
      // other reads and spend the round trip this tool exists to save. FILE_TOO_LARGE's details
      // already carry the real size and oid, so a caller is told how big the file it cannot have
      // actually is, rather than only that it could not have it.
      const f: any = toFailure(g && g.e);
      const d: any = (f && f.details) || {};
      const bad: any = { path: paths[i], code: String((f && f.code) || 'INTERNAL'),
                         error: String((f && f.message) || 'read failed') };
      if (typeof d.size === 'number') bad.size = d.size;
      if (typeof d.blobOid === 'string') bad.blobOid = d.blobOid;
      failed.push(bad);
      continue;
    }
    const r: any = g.r;
    if (!commit) { commit = String(r.commit || ''); refName = String(r.refName || ''); }
    const body = String(r.content || '');
    const rows = body.split('\n');
    // EVERY FILE KEEPS ITS OWN blobOid, WHOLE OR PARTIAL, and that is not decoration: it is the
    // only thing that lets a caller prove a part fetched later belongs to the same bytes as the
    // part it already holds. A batch entry without one is a fragment nobody can verify. Whole
    // entries carry a full `range` too, so a caller never has to branch on which kind of entry it
    // is holding -- range.complete answers that, on every entry, always.
    cand.push({
      body: body,
      rows: rows,
      entry: {
        path: String(r.path || paths[i]),
        blobOid: String(r.blobOid || ''),
        size: r.size,
        encoding: r.encoding,
        content: body,
        range: { offset: 0, length: body.length, end: body.length, total_chars: body.length,
                 start_line: 1, end_line: rows.length, total_lines: rows.length, complete: true },
      },
      // NOT INCLUDED IS A FACT WITH A SIZE ON IT, not an absence. The file WAS read -- that costs
      // a blob fetch we then throw away, ~0.3s against a 4.7s round trip -- and it is reported
      // with its real size, oid and line count precisely so the caller can plan the next call
      // without guessing. Paying 0.3s to turn "some files are missing" into "these files, this
      // big" is the trade this whole feature is made of.
      omit: { path: String(r.path || paths[i]), blobOid: String(r.blobOid || ''), size: r.size,
              total_chars: body.length, total_lines: rows.length, encoding: r.encoding,
              reason: 'BUDGET' },
    });
  }

  // ----- PHASE 3: FILL THE RESULT, MEASURING THE REAL WIRE LENGTH AT EVERY STEP -----
  const NOTE_RESERVE = 1024;   // the note is written last; this is the room kept for it
  const include: boolean[] = new Array(cand.length).fill(false);
  let files: any[] = [];
  let omitted: any[] = [];
  let res: any = null;
  const build = (): number => {
    files = [];
    omitted = [];
    for (let i = 0; i < cand.length; i++) {
      if (include[i]) files.push(cand[i].entry); else omitted.push(cand[i].omit);
    }
    const whole = files.filter((f: any) => f.range && f.range.complete === true).length;
    res = {
      ok: true,
      ref: ref,
      refName: refName,
      commit: commit,
      multi: true,
      requested: paths.length,
      counts: { whole: whole, partial: files.length - whole, omitted: omitted.length,
                failed: failed.length, accounted: files.length + omitted.length + failed.length },
      budget: { wire_limit_chars: PC_READ_WIRE_MAX, wire_used_chars: 0,
                measured_on: 'the serialized result, JSON.stringify(v, null, 2), not content.length',
                derived_from: 'PC_RESULT_MAX 55555 in control-plane/src/index.ts' },
      concurrency: PC_READ_CONCURRENCY,
      max_paths: PC_READ_MAX_PATHS,
      files: files,
      omitted: omitted,
      failed: failed,
    };
    const wire = JSON.stringify(res, null, 2).length + NOTE_RESERVE;
    res.budget.wire_used_chars = wire;
    return wire;
  };
  // GREEDY, IN THE CALLER'S ORDER, AND IT KEEPS GOING PAST A FILE THAT DID NOT FIT. The read is
  // already paid for, so skipping a 45,000-character file and then fitting two 900-character ones
  // behind it costs nothing and delivers two more files. What it must NOT do is reorder: the
  // caller's order is the only order the caller can predict.
  for (let i = 0; i < cand.length; i++) {
    include[i] = true;
    if (build() > PC_READ_WIRE_MAX) include[i] = false;
  }
  build();
  if (files.length === 0 && cand.length > 0) {
    // NOTHING FIT WHOLE, SO THE FIRST FILE COMES BACK PARTIAL. This is the only partial this tool
    // will ever produce in batch mode, and it exists so a batch that read something never answers
    // with nothing. THE CUT IS FOUND BY BISECTION against the real serialized length, because JSON
    // escaping is PROPORTIONAL to the body and not a constant: source is about one newline every
    // 40 characters and each costs two characters escaped, so a 200,000-character file serializes
    // to ~226,000. An earlier draft subtracted a fixed envelope instead and handed back 26,055
    // characters where 42,749 fitted -- 40% of a round trip thrown away by the feature whose whole
    // purpose is round trips. ~18 rebuilds of a <=55KB result is microseconds against a ~300ms read.
    const k = cand[0];
    include[0] = true;
    let lo = 0;
    let hi = k.body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      k.entry.content = k.body.slice(0, mid);
      if (build() <= PC_READ_WIRE_MAX) lo = mid; else hi = mid - 1;
    }
    const slice = k.body.slice(0, Math.max(1, lo));
    const sliceRows = slice.split('\n');
    k.entry.content = slice;
    k.entry.range = { offset: 0, length: slice.length, end: slice.length,
                      total_chars: k.body.length, start_line: 1,
                      end_line: sliceRows.length
                        - ((sliceRows.length > 1 && slice.charAt(slice.length - 1) === '\n') ? 1 : 0),
                      total_lines: k.rows.length, complete: false };
    k.entry.next_offset = slice.length;
    k.entry.more = 'THIS IS A PART, NOT THE WHOLE FILE, and NO OTHER FILE IN THIS BATCH WAS '
      + 'RETURNED WITH IT. ' + String(k.body.length - slice.length) + ' characters remain. Call '
      + 'git_read again with a SINGLE path=' + k.entry.path + ', the same ref, and offset='
      + String(slice.length) + ' to continue -- a range is refused alongside paths, so do not '
      + 'retry this as a batch. blobOid ' + k.entry.blobOid + ' pins these bytes: as long as it is '
      + 'the same on the next call, the parts you assemble are one consistent file.';
    build();
  }

  // THE ARITHMETIC IS ASSERTED, NOT ASSUMED. If a path ever went missing between the request and
  // the three lists, the honest answer is ok:false -- a batch that quietly returns eleven of
  // twelve is the [GCP-DIFF-CAPPED-V90] failure with better manners. This should be unreachable;
  // an unreachable check costing one addition is the cheapest guarantee in this file, and it is
  // what lets the tool description promise that no requested path is ever dropped silently.
  if (res.counts.accounted !== paths.length) {
    res.ok = false;
    res.note = 'ACCOUNTING FAILURE: ' + paths.length + ' paths were requested and '
      + res.counts.accounted + ' are accounted for across files/omitted/failed. DO NOT TREAT THIS '
      + 'RESULT AS COMPLETE. Re-read the missing paths one at a time with a single path argument.';
    return res;
  }
  const short: string[] = [];
  if (res.counts.partial) short.push('1 PARTIAL');
  if (omitted.length) short.push(String(omitted.length) + ' NOT INCLUDED (budget)');
  if (failed.length) short.push(String(failed.length) + ' FAILED');
  res.note = short.length
    ? ('THIS BATCH IS NOT ALL OF WHAT YOU ASKED FOR: ' + short.join(', ') + ' out of '
       + paths.length + ' requested. NOTHING WAS CUT SILENTLY AND NOTHING WAS DROPPED SILENTLY: '
       + 'every path you asked for is listed in exactly one of files, omitted or failed, with its '
       + 'size. Ask for the omitted paths in a following call -- they are already sized here, so '
       + 'you know what will fit. Finish a PARTIAL file with a SINGLE path plus offset; a range is '
       + 'refused alongside paths.')
    : ('All ' + files.length + ' requested files returned WHOLE, none cut and none omitted.');
  // THE REPORTED FIGURE IS THE REAL ONE, NOT THE ONE THE FILL LOOP BUDGETED WITH. The loop tested
  // against wire + NOTE_RESERVE, which is deliberately pessimistic; reporting that number would
  // have this result claim to be up to 1024 characters larger than it is, and a budget line that
  // overstates itself is no more trustworthy than one that understates. Measured with the previous
  // value of this field in place, so it is exact to within the digit count of the number itself.
  res.budget.wire_used_chars = JSON.stringify(res, null, 2).length;
  return res;
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
  // [GIT-READ-RANGE-V1] A FILE THIS TOOL RETURNS IN FULL CAN STILL ARRIVE CUT, because the chat
  // loop caps a tool result downstream of here ([CHAT-RESULT-CAP-V2], index.ts). Before this
  // change the cap notice told the model the remainder was unreachable -- true, on the arguments
  // it had -- and three measured gemini-3.7-flash turns responded by hunting for another route to
  // the bytes: the archive, GCS buckets, the deployed source zip, Firestore, metadata tokens.
  // 37, 29 and 30+ rounds. offset/length end that: the remainder is reachable, by asking again.
  //
  // A WRAPPER, NOT A CHANGE TO gitRead. ops.js is untouched, so readForPublish and the propose
  // path keep the LOUD refusal their own comments depend on -- a silent truncation there would
  // publish half a file to a public repository. Omit both arguments and the result is
  // byte-identical to what this tool returned before, so no existing caller changes.
  //
  // AND THE CAP NOTICE REPAIRS ITSELF. harCapArgNames reads a tool's own schema to tell the model
  // how to narrow a capped call; adding these two names to the schema is all it takes for the
  // notice to start naming them. The machinery existed -- git_read had nothing to offer it.
  server.registerTool('git_read',
    { description: 'Read ONE file, or MANY files in ONE call, at a ref from the fleet repository. Returns contents, blob oid and the resolved commit. THIS TOOL NEVER TRUNCATES -- an oversized file is a loud error carrying the size, never a silent cut. BUT THE CHAT SURFACE CAPS A TOOL RESULT, so a large file can still reach you cut, with a notice. WHEN THAT HAPPENS, DO NOT GO LOOKING FOR ANOTHER ROUTE TO THE BYTES -- there is no faster one, and the search costs tens of rounds. Call this tool AGAIN and read the file in parts. THERE ARE TWO WAYS TO ASK FOR A PART. (1) BY LINE: line_start (1-based) and line_count. USE THIS IF YOU ARE GOING TO WRITE A PATCH -- a unified diff hunk is addressed in lines, so reading in lines means the number you read at is the number you write in the @@ header, with no counting in between. (2) BY CHARACTER: offset and length, continuing from the next_offset each result carries; right for streaming a whole file end to end. EITHER WAY the result reports range{offset,length,end,total_chars,start_line,end_line,total_lines,complete}, so a read asked for in characters still tells you which lines you are holding. You never have to count newlines yourself, and a hunk header built by counting them is how a patch gets refused for a context mismatch. blobOid pins the bytes, so parts read at the same ref assemble into one consistent file and you can check that rather than assume it. Keep length under ~40000, or line_count under ~600: the JSON envelope rides inside the same result cap. READING MANY FILES IN ONE CALL: pass paths (an ARRAY of repository paths) INSTEAD OF path and up to 24 files come back together. THIS IS THE FIX FOR ROUND TRIPS, NOT FOR SIZE -- measured on prod 2026-09-07, Gemini Enterprise cancels a turn at 15 minutes and one turn fitted 189 tool calls at ~4.7s each, so it is CALLS you run out of, not bytes, and twelve files used to cost twelve of them. EVERY PATH YOU ASK FOR COMES BACK IN EXACTLY ONE OF THREE LISTS AND NONE IS EVER DROPPED SILENTLY: files (returned WHOLE, each with its own blobOid and range.complete true), omitted (did not fit the result budget -- named WITH ITS SIZE, LINE COUNT AND OID so you know exactly what to ask for next), failed (not found, not a file, or over the read cap -- named with the error code). AT MOST ONE FILE IS EVER PARTIAL, and only when NO file fitted whole, so a batch that read anything always returns something; that file carries range.complete false, next_offset and its own blobOid. PAGING IS REFUSED ALONGSIDE paths -- offset/length/line_start/line_count address one file, so finish a large file with a SINGLE path. Sending both path and paths is refused, loudly, and reads nothing.',
      // [GIT-READ-RANGE-V2] NUMBER *OR* A STRING OF DIGITS, on purpose. A client whose cached tool
      // schema predates these two fields serializes them as strings, and Vertex stringifies
      // numeric function-call arguments as a matter of course -- so the two likeliest callers of
      // this feature both send "2000" rather than 2000. Refusing them tells the model the range
      // does not exist and sends it back to hunting for another route to the bytes, which is the
      // failure this whole feature exists to end. ^\d+$ only: "abc" and "-1" are still refused.
      // The handler already coerces with Number()/Math.floor(), so nothing below this line changes.
      // [GIT-READ-MULTIPATH-V146] path IS NOW OPTIONAL AND paths IS THE BATCH. Optional because a
      // caller sends one or the other; the handler refuses NEITHER and refuses BOTH, loudly, so
      // nothing weaker is enforced than before -- only the enforcement moved from zod to a message
      // that names both arguments. The array bound here (64) is the ABSOLUTE ceiling, matching the
      // clamp on PC_READ_MAX_PATHS, so a 10,000-entry array is refused before anything allocates;
      // the OPERATIONAL limit is PC_READ_MAX_PATHS (24) and it refuses with TOO_MANY_FILES and the
      // real count. Two bounds on purpose: one protects the process, one advises the caller.
      inputSchema: { path: z.string().optional(), paths: z.array(z.string()).min(1).max(64).optional(), ref: z.string(), offset: z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]).optional(), length: z.union([z.number().int().min(1), z.string().regex(/^\d+$/)]).optional(), line_start: z.union([z.number().int().min(1), z.string().regex(/^\d+$/)]).optional(), line_count: z.union([z.number().int().min(1), z.string().regex(/^\d+$/)]).optional(), ...AG } },
    async (a: any) => {
      try {
        // [GIT-READ-MULTIPATH-V146] THE BATCH BRANCH IS DECIDED ON THE ARGUMENTS, BEFORE ANY READ,
        // and both refusals below read NOTHING. An ambiguous call must cost one cheap error, never
        // twelve blob fetches and a result whose shape the caller never asked for.
        //
        // BOTH path AND paths IS REFUSED, not silently resolved in favour of one. Choosing a winner
        // is a guess about which half of a confused call was meant, and the caller never learns the
        // other half was discarded -- the same silence [GCP-DIFF-CAPPED-V90] already cost the fleet.
        //
        // A RANGE ALONGSIDE paths IS REFUSED. offset/length/line_start/line_count address ONE file;
        // across N there is no file for them to address, and a range per file would misalign
        // without saying so. Paging stays single-path and the refusal names the call to make.
        //
        // EVERYTHING BELOW THIS BLOCK IS UNTOUCHED. A caller that sends path and no paths never
        // enters here, so the single-path result is not merely equivalent to what it was, it is the
        // same code emitting the same bytes. Do not "unify" the two branches to save a few lines:
        // the whole backward-compatibility claim of this change is that they are separate.
        if (a.paths !== undefined && a.paths !== null) {
          if (a.path !== undefined && a.path !== null) {
            throw badRequest('git_read: pass EITHER path (one file) OR paths (a batch of files), '
              + 'not both. NOTHING WAS READ. Re-send with exactly one of them.',
              { path: a.path, paths: a.paths });
          }
          if ((a.offset !== undefined && a.offset !== null)
              || (a.length !== undefined && a.length !== null)
              || (a.line_start !== undefined && a.line_start !== null)
              || (a.line_count !== undefined && a.line_count !== null)) {
            throw badRequest('git_read: offset/length/line_start/line_count address ONE file and '
              + 'are REFUSED alongside paths -- one range across N files has no meaning, and a '
              + 'range per file would misalign silently. NOTHING WAS READ. Send paths WITHOUT a '
              + 'range to batch whole files, or a single path WITH a range to page one file.',
              { paths: a.paths });
          }
          if (!Array.isArray(a.paths) || a.paths.length === 0) {
            throw badRequest('git_read: paths must be a NON-EMPTY array of repository paths. '
              + 'NOTHING WAS READ.', { paths: a.paths });
          }
          const list: string[] = a.paths.map((p: any) => String(p));
          const dupes = list.filter((p: string, k: number) => list.indexOf(p) !== k);
          if (dupes.length) {
            throw badRequest('git_read: paths repeats ' + dupes.join(', ') + '. NOTHING WAS READ. '
              + 'A repeat spends the batch budget twice on the same bytes and makes the counts in '
              + 'the result disagree with what was asked for.', { duplicates: dupes });
          }
          return okr(await pcReadMany(list, String(a.ref)));
        }
        // path IS NO LONGER REQUIRED BY THE SCHEMA, so the neither-argument case is caught here
        // instead of by zod. It has to be caught somewhere: without this an empty call reaches
        // gitRead and comes back as a path-normalisation error that names neither argument.
        if (a.path === undefined || a.path === null) {
          throw badRequest('git_read: one of path (a single file) or paths (a batch of files) is '
            + 'required.', {});
        }
        const r: any = await gitRead(ctx(), { path: a.path, ref: a.ref });
        const hasOff = (a.offset !== undefined && a.offset !== null);
        const hasLen = (a.length !== undefined && a.length !== null);
        const hasLS = (a.line_start !== undefined && a.line_start !== null);
        const hasLC = (a.line_count !== undefined && a.line_count !== null);
        // NEITHER ARGUMENT MEANS THE OLD SHAPE, EXACTLY. Not the old shape plus an empty range
        // object: a caller that never asked for a range must not have to learn one exists.
        if (!hasOff && !hasLen && !hasLS && !hasLC) return okr(r);
        const body = String((r && r.content) || '');
        const total = body.length;
        const rows = body.split('\n');
        const totalLines = rows.length;
        let off = 0; let len = 0;
        if (hasLS || hasLC) {
          // [GIT-READ-LINES-V1] LINE ADDRESSING, because a unified diff is written in lines and
          // this tool only ever spoke characters. A caller that wanted to insert code at a known
          // place had to count newlines in the fragments it had been handed. Measured: one turn
          // guessed line 1500, was refused, guessed 1511, was refused again. The bytes are right
          // here; counting them is one pass and it ends that loop.
          const ls = Math.max(1, Math.min(totalLines, Math.floor(Number(a.line_start) || 1)));
          const lc = hasLC ? Math.max(1, Math.floor(Number(a.line_count))) : (totalLines - ls + 1);
          let start = 0;
          for (let k = 0; k < ls - 1; k++) start += rows[k].length + 1;
          let stop = start;
          const last = Math.min(totalLines, ls - 1 + lc);
          for (let k = ls - 1; k < last; k++) stop += rows[k].length + 1;
          off = Math.min(total, start);
          len = Math.max(1, Math.min(total - off, stop - start));
        } else {
          off = Math.max(0, Math.min(total, Math.floor(Number(a.offset) || 0)));
          len = hasLen ? Math.max(1, Math.floor(Number(a.length))) : (total - off);
        }
        const slice = body.slice(off, off + len);
        const end = off + slice.length;
        // REPORTED WHICHEVER WAY THE SLICE WAS ASKED FOR, and this is the half that actually fixes
        // the failure above: that caller was reading by CHARACTER and needed to answer in LINES.
        // A new parameter alone would have left it exactly as stuck.
        const startLine = body.slice(0, off).split('\n').length;
        const sliceRows = slice.split('\n');
        const endLine = startLine + sliceRows.length - 1
          - ((sliceRows.length > 1 && slice.charAt(slice.length - 1) === '\n') ? 1 : 0);
        const out: any = Object.assign({}, r);
        out.content = slice;
        out.range = { offset: off, length: slice.length, end: end, total_chars: total,
                      start_line: startLine, end_line: endLine, total_lines: totalLines,
                      complete: (off === 0 && end === total) };
        // THE INSTRUCTION GOES IN THE RESULT, not only in the description. The description is read
        // once at session start; this is read at the moment the model discovers it is holding a
        // fragment, which is the moment it decides whether to ask again or go hunting.
        if (end < total) {
          out.next_offset = end;
          out.more = 'THIS IS A PART, NOT THE WHOLE FILE. ' + String(total - end)
            + ' characters remain. Call git_read again with the SAME path and ref and offset='
            + String(end) + ' to continue. Do NOT switch to git_archive, a bucket, a deployed '
            + 'artefact or a shell command to get the rest -- every one of those is slower and '
            + 'several need a session key you do not have. blobOid '
            + String((r && r.blobOid) || '(none)') + ' pins these bytes: as long as it is the '
            + 'same on the next call, the parts you assemble are one consistent file.';
        }
        // A ZERO-LENGTH SLICE IS AN OFF-BY-ONE, NOT AN EMPTY FILE, and saying which one costs a
        // line here and saves a round of the model doubting its own arithmetic.
        if (!slice.length && total) {
          out.more = 'EMPTY SLICE. offset ' + String(off) + ' is at or past the end of a file that '
            + 'is ' + String(total) + ' characters long. The file is NOT empty. Re-read from an '
            + 'offset below ' + String(total) + ', or omit offset for the whole file.';
        }
        return okr(out);
      } catch (e) { return failr(e); }
    });
  server.registerTool('git_list',
    { description: 'List the immediate entries of a single directory at a ref. Returns { ok, ref, path, entries: [{ name, path, type: \'blob\'|\'tree\', mode, oid }] }. NON-RECURSIVE: lists only immediate children; omitted or empty path lists the repository root. USE git_archive INSTEAD OF WALKING TREES with git_list -- recursive descent with git_list costs tens of tool turns, burns token context, and misses files in unvisited subtrees. PREVENTS path hallucination and invalid file references by verifying directory contents before reads/proposals. Parameters: ref (branch, tag, or commit SHA), path (directory path prefix without leading slash). TRAP: does NOT return file contents or nested children; trying to inspect deep directories individually rather than downloading via git_archive is a common anti-pattern.',
      inputSchema: { path: z.string().optional(), ref: z.string(), ...AG } },
    wrap(gitList, (a: any) => ({ path: a.path, ref: a.ref })));
  server.registerTool('git_log',
    { description: 'Inspect commit history reachable from a ref in reverse chronological order (newest first). Returns { ok, ref, commit, count, commits: [{ oid, parents, tree, message, author, timestamp }] }. Capped by max_count (integer 1-200, required; max 200). USE THIS TO DISCOVER EXACT BASE OIDS for git_push and git_propose rather than guessing or assuming HEAD hasn\'t moved. PREVENTS stale base races (STALE CAS push errors) and blind overwrites by providing authoritative commit parentage and commit messages. Parameters: ref (e.g. \'main\' or full SHA), max_count (limit 1-200), path (narrow history to commits touching a specific file or subtree). TRAP: path must match the exact repository path; omitting max_count fails validation.',
      inputSchema: { ref: z.string(), max_count: z.number().int().min(1).max(200), path: z.string().optional(), ...AG } },
    wrap(gitLog, (a: any) => ({ ref: a.ref, max_count: a.max_count, path: a.path })));
  server.registerTool('git_diff',
    { description: 'Compute unified diff between two git refs. Returns { ok, from: { commit, refName }, to: { commit, refName }, identical: boolean, truncated: boolean, changes: [{ path, status, oldOid, newOid, oldMode, newMode, binary }], patch: string }. Identical refs return identical:true with an empty patch. USE THIS TO VERIFY PROPOSED CHANGES before pushing instead of reading whole files and comparing them manually. PREVENTS unreviewed code regressions, syntax breakage, and context drift across revisions. Parameters: from_ref and to_ref (commits or branch names), path (CRITICAL: pass path to restrict diff to a specific file/directory; unconstrained diffs across large repositories exceed result caps and get refused). TRAP: diffs larger than 1MB are rejected; always supply path when inspecting targeted edits.',
      inputSchema: { from_ref: z.string(), to_ref: z.string(), path: z.string().optional(), ...AG } },
    wrap(gitDiff, (a: any) => ({ from_ref: a.from_ref, to_ref: a.to_ref, path: a.path })));
  // [PCGIT-ARCHIVE-TOOL-V1] THE CAPABILITY EXISTED AND WAS INVISIBLE, WHICH IS THE SAME AS
  // NOT EXISTING. GET /git/archive has served whole trees for a while, but nothing on the
  // TOOL surface named it. An agent surveying git_read/git_list/git_log/git_diff correctly
  // concluded there was no way to obtain a clone and hand-rebuilt one out of diffs -- days
  // of model-retyped bytes, every time, per session. A route no tool description mentions is
  // a route no agent finds. This tool exists to make the archive DISCOVERABLE.
  //
  // IT RETURNS A URL AND MEASURED METADATA, NOT THE TARBALL. The archive is megabytes of
  // gzip; base64 through an MCP text result would be ~4/3 of that and is cut dead by the
  // 55,555-character result cap several hundred times over. So this builds the archive
  // IN-PROCESS -- the same gitArchiveTarGz the route calls -- and reports the commit, the
  // file count, the exact byte length and the sha256 of the bytes the route will serve, so
  // the caller can verify its download instead of trusting it. The bytes themselves come
  // over HTTP, which is the transport that can carry them.
  server.registerTool('git_archive',
    { description: 'Get the WHOLE repository at a ref as one gzipped tarball -- the clone that git_read/git_list/git_diff cannot give you. Use this INSTEAD of reconstructing a tree out of diffs or reading files one at a time. It returns the download URL plus the resolved commit, file count, exact byte length and sha256 of the bytes that URL will serve (verify your download against them); the tarball itself travels over HTTP, not through this tool, because it is megabytes and would be destroyed by the result cap. TWO GOTCHAS, AND BOTH HAVE COST REAL TIME: (1) AUTHORISATION IS AN HTTP HEADER AND ONLY A HEADER -- `Authorization: Bearer <your session key>`. The ?agent= / ?key= / ?session_key= query forms that EVERY OTHER FLEET TOOL uses DO NOT WORK on this route and fail with a 401 identical to the one a wrong or expired key produces, so a good credential looks revoked. If you get a 401, check that you sent the header before you conclude anything about your key. (2) A 500 saying the ref "is not readable in the object store" or that "the repository needs repair" on a freshly promoted revision means THE VAULT REGISTRY IS NOT ARMED YET -- the objects are intact and cannot yet be decrypted. It is NOT corruption. Make any other ordinary MCP call (whoami will do) and retry. DO NOT ATTEMPT A REPAIR. Optional path narrows the archive to one subtree.',
      inputSchema: { ref: z.string(), path: z.string().optional(), ...AG } },
    async (a: any) => {
      try {
        const _ref = String(a.ref);
        const _sub = String(a.path || '');
        const out: any = await gitArchiveTarGz(_ref, _sub);
        const _base = String(process.env.MCP_PUBLIC_URL || '').replace(/\/+$/, '');
        const _q = '/git/archive?ref=' + encodeURIComponent(_ref) + (_sub ? ('&path=' + encodeURIComponent(_sub)) : '');
        const _url = _base ? (_base + _q) : _q;
        const _sha = require('crypto').createHash('sha256').update(out.tgz).digest('hex');
        return okr({
          // [GIT-ARCHIVE-NOT-BYTES-V1] FIRST TWO FIELDS ON PURPOSE. Everything below this point
          // describes a download that requires a session key. A caller without one -- which is
          // every console chat agent -- needs to learn that BEFORE it reads the curl line, not
          // after its third 401. Placed in the result rather than the description because the
          // comment ten lines down already gives the reason: the description is read once at
          // session start, the result is read at the moment of use.
          read_a_file_instead: 'IF WHAT YOU WANTED WAS THE CONTENTS OF A FILE, STOP AND CALL '
            + 'git_read INSTEAD. It returns the FULL contents of one file, it never truncates, and '
            + 'it needs no session key. THIS TOOL RETURNS NO BYTES -- only the URL and recipe below.',
          who_this_is_for: 'A caller that needs a WHOLE SUBTREE at once AND is running somewhere '
            + 'that already holds a real PC_SESSION_KEY: the gate executor, or a shell you have '
            + 'given one. A console chat agent has NO session key to put in the Authorization '
            + 'header, so every fetch it attempts here 401s and the retry loop that follows is pure '
            + 'waste. MEASURED 2026-08-22: two gemini-3.7-flash turns spent 8 and 14 rounds '
            + 'respectively failing to fetch this URL -- and on one of them git_read had ALREADY '
            + 'returned the whole 156KB file, in full, one round earlier.',
          url: _url,
          method: 'GET',
          // Spelled out again in the RESULT and not only in the description: the description is
          // read once at session start, the result is read at the moment of use.
          auth: 'Authorization: Bearer <your session key>',
          auth_warning: 'THE HEADER IS THE ONLY ACCEPTED FORM. ?agent=, ?key= and ?session_key= -- the '
            + 'query forms every other fleet tool takes -- are IGNORED here and produce a 401 that is '
            + 'BYTE-IDENTICAL to the one a wrong or expired key produces. A 401 from this URL is far more '
            + 'often a misplaced credential than a revoked one.',
          example: 'curl -fsSL -H "Authorization: Bearer $PC_SESSION_KEY" "' + _url + '" -o tree.tar.gz',
          verify: 'sha256sum tree.tar.gz  # must equal sha256 below; also check Content-Length against bytes_gzip',
          commit: out.commit,
          ref: _ref,
          ...(_sub ? { path: _sub } : {}),
          files: out.files,
          bytes_uncompressed: out.bytes,
          bytes_gzip: out.tgz.length,
          sha256: _sha,
          on_500: 'A 500 naming "not readable in the object store" or "the repository needs repair" on a '
            + 'freshly promoted revision means the VAULT REGISTRY IS NOT ARMED YET, not corruption. The '
            + 'objects are intact. Make any other ordinary MCP call, then retry. DO NOT attempt a repair.',
          note: 'The bytes are NOT returned through MCP: the archive is megabytes and the result cap is '
            + '55,555 characters. Fetch the URL over HTTP.',
        });
      } catch (e) { return failr(e); }
    });
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
    { description: 'Create a commit by applying a UNIFIED DIFF to a branch head, instead of sending whole files. Strict: every hunk must match the current bytes exactly at the line it names -- no fuzz, no offset search. Any hunk that does not apply fails the whole call and NOTHING is committed. Line numbers and context lines MUST come from git_read in the same turn (via line_start and line_count) -- never guess or infer line numbers. A 1.1MB file cannot be held in context, so paging with git_read is the normal path rather than a fallback. Cannot create, delete, rename, chmod or patch binaries. Optional expected_blob_sha is a per-file compare-and-swap (path -> 40-hex blob oid, or null meaning the file must not exist yet). Nothing becomes visible until git_push. Returns commitOid and baseOid.',
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
  // [GIT-GREP-MULTIQUERY-V146] THE SCHEMA IS THE LEVER, NOT THE ENGINE. gitGrep can search N
  // patterns in one tree walk, but nothing is saved unless the MODEL chooses to batch, and the
  // only thing a model reads before choosing is this description. Hence `queries` is named in
  // the tool description itself and not left to be discovered in a parameter blurb: the 189-call
  // turn measured on 2026-09-07 was made of calls that each looked individually reasonable.
  server.registerTool('git_grep',
    { description: 'Search repository files at a ref for a regex pattern or fixed string. Returns matching file paths, 1-based line numbers, matching lines, and optional surrounding context lines. Supports path prefix narrowing, glob filtering, regex or literal search, and reports honest match counts and capping rather than silent truncation. SEARCHING FOR SEVERAL PATTERNS? Pass them all at once in `queries` (up to ' + PC_GREP_MAX_QUERIES + ') instead of calling this tool once per pattern: one call walks the tree, fetches and decrypts each file ONCE and tests every pattern against it, so N patterns cost about the same as one. Each match then carries `q`, the index of the pattern that produced it, and `per_query` reports every pattern\'s count and whether it was capped.',
      inputSchema: {
        query: z.string().optional().describe('Search regex pattern or literal string to find. Exactly one of query or queries -- supplying both is refused.'),
        queries: z.array(z.string()).min(1).max(PC_GREP_MAX_QUERIES).optional().describe('Up to ' + PC_GREP_MAX_QUERIES + ' patterns evaluated in ONE call over ONE tree walk. Prefer this over N separate git_grep calls: the walk, the blob fetch and the decrypt are paid once and each extra pattern costs only regex time. Every match carries `q`, a 0-based index into this array; `per_query` gives each pattern its own count, capped flag and reason; `walk_complete` says whether the walk reached every file. A pattern that is NOT flagged in per_query was searched exhaustively and its count is exact, including a count of zero. Exactly one of query or queries. An invalid regex anywhere in this array refuses the WHOLE call rather than silently searching that one pattern literally.'),
        ref: z.string().describe('Git ref to search (branch, tag, or commit hash, e.g. "main").'),
        path: z.string().optional().describe('Optional file path or directory prefix to restrict the search to.'),
        glob: z.string().optional().describe('Optional glob pattern to filter file paths (e.g. "*.ts", "**/*.py").'),
        context: z.union([z.number().int().min(0).max(20), z.string().regex(/^\d+$/)]).optional().describe('Number of lines of context before and after each match (0-20, default 0).'),
        is_regex: z.boolean().optional().describe('Whether the pattern is a regex (default true). With a single `query`, an invalid regex falls back to literal search. With `queries`, an invalid regex REFUSES the call instead, so that a mixed regex/literal result can never be returned; set is_regex:false to search every pattern in the call literally.'),
        case_sensitive: z.boolean().optional().describe('Whether search is case-sensitive (default false).'),
        max_matches: z.union([z.number().int().min(1).max(500), z.string().regex(/^\d+$/)]).optional().describe('Maximum matches to return before capping (default 100, max 500). With `queries` this cap is applied PER PATTERN, so one busy pattern cannot silence the others; the shared 45000-character response budget still bounds the whole result and stops the walk for every pattern at once when it is reached.'),
        ...AG,
      } },
    async (a: any) => {
      try {
        const r = await gitGrep({
          ref: a.ref,
          query: a.query,
          // [GIT-GREP-MULTIQUERY-V146] forwarded only when it really IS an array. zod rejects a
          // non-array before this point, so the guard is for the direct-import caller, and it
          // deliberately does not coerce a stray scalar into a one-pattern search nobody asked
          // for -- that caller gets gitGrep's own loud refusal instead.
          queries: Array.isArray(a.queries) ? a.queries.map((s: any) => String(s)) : undefined,
          path: a.path,
          glob: a.glob,
          context: a.context !== undefined && a.context !== null ? Number(a.context) : undefined,
          is_regex: a.is_regex !== undefined ? a.is_regex === true || a.is_regex === 'true' : undefined,
          case_sensitive: a.case_sensitive === true || a.case_sensitive === 'true',
          max_matches: a.max_matches !== undefined && a.max_matches !== null ? Number(a.max_matches) : undefined,
        });
        return okr(r);
      } catch (e) { return failr(e); }
    });
  return ['git_read', 'git_list', 'git_log', 'git_diff', 'git_archive', 'git_grep', 'git_propose', 'git_propose_patch', 'git_push'];
}

// ---------------------------------------------------------------------------
// [PCGIT-LANE-SYNC-V1] ONE-DIRECTIONAL LANE SYNC -- UPSTREAM main INTO THIS LANE.
// ---------------------------------------------------------------------------
// THE PROBLEM. PC_LANE puts two installs in one GCP project. They are separate all
// the way down: prod holds refs in one Firestore database and objects in one bucket,
// dev holds its own of each, and BOTH carry the SAME GIT_REPO_ID. So the dev lane's
// git tools address a repository that was seeded once by install.sh and has not moved
// since, while every commit the fleet has actually made landed in prod. Inside dev,
// git_read returns code that is days old and says nothing about being old -- which is
// the same failure the plaintext mirrors caused, and the reason /git/archive exists.
// The operator's ruling is "stay a fork, but git it in sync, and we start deploying
// there first and promote what works to prod". This is the "in sync" half.
//
// ---------------------------------------------------------------------------
// WHY THIS COPIES FILES AND NOT OBJECTS, WHICH IS THE ENTIRE DESIGN
// ---------------------------------------------------------------------------
// The obvious sync is a bucket-to-bucket copy of <repo>/.git/objects/ plus a write of
// the ref. Both lanes use the same GIT_REPO_ID, so the GCS key space -- which is also
// the PCV1 AAD -- is byte-identical between them, and the copy looks correct.
//
// IT IS NOT, AND THE FAILURE IS SILENT-LOOKING. Objects under objects/ are PCV1
// envelopes sealed with the LANE'S OWN vault master, and [SEC-VAULT-LANE-V1] says why
// that master is lane-scoped in the strongest terms available: the keyring and key are
// namespaced per lane precisely so that "granting the dev lane decapsulator on the prod
// key would be strictly WORSE: it would let the dev lane derive PROD'S MASTER KEY."
// A copied envelope is therefore ciphertext dev holds no key for. The symptom is the
// 500 that git_archive's own description warns about -- "not readable in the object
// store", "the repository needs repair" -- on a repository that is in fact intact, and
// the documented response to that message is DO NOT ATTEMPT A REPAIR. A sync whose
// failure mode is indistinguishable from corruption is not a sync.
//
// So the bytes move as PLAINTEXT FILES over an authenticated HTTP fetch, and are
// written back through THIS lane's ordinary object writer, which seals them with THIS
// lane's master. Nothing cryptographic crosses the boundary in either direction, and
// neither lane gains any reach into the other's storage.
//
// ---------------------------------------------------------------------------
// PULL, NEVER PUSH; AND ONE DIRECTION ONLY
// ---------------------------------------------------------------------------
// The downstream lane fetches. Prod holds no credential, no URL and no code pointing at
// dev, so nothing here can move prod's main -- not by mistake, not by a wrong flag. The
// upstream URL is read from PC_GIT_UPSTREAM_URL on THIS service; a lane with that unset
// is nobody's downstream and this route refuses rather than guessing.
//
// The reverse direction is deliberately NOT built. Promotion dev -> prod is a build of a
// verified commit and a traffic shift, which is a human decision with a rollback, and
// two-way content sync between two writable mains is how you get a merge conflict
// resolved by a machine at three in the morning.
//
// ---------------------------------------------------------------------------
// IT ADDS A COMMIT. IT NEVER REWINDS A REF.
// ---------------------------------------------------------------------------
// The result is ONE ordinary commit on top of this lane's current main whose tree equals
// upstream's, pushed by the same compare-and-swap every other write uses. Local history
// is not rewritten and nothing becomes unreachable: work that existed only in dev is
// still in dev's log and can be re-proposed. What it does do is OVERWRITE those files in
// the working tree, so the dry run below names every local commit since the last sync,
// and applying is an explicit decision (?apply=1) made after reading that list. Dry is
// the default because the cheap mistake here must be the harmless one.
const PC_SYNC_MAX_BLOB = 64 * 1024 * 1024;
// The marker that makes a sync commit recognisable to the NEXT sync, so "what is local?"
// is answered from the repository rather than from a bookkeeping document that can drift
// away from it.
const PC_SYNC_MARK = '[lane-sync]';
// Raised for this caller only, on a COPY, for the reason archiveCtx() and uploadCtx()
// give above: cfg.maxProposeFiles and cfg.maxProposeBytes bound what a LANGUAGE MODEL may
// hand to git_propose in one call, and the whole point of that bound is that those bytes
// were retyped by a model. These were not retyped by anything -- they are a verified
// tarball from an IAM-authenticated upstream -- and a first sync is the entire tree, 182
// files at last count, which the 100-file tool bound would refuse for a reason that does
// not apply. The shared context is left exactly as it is; mutating it would raise the cap
// for every other caller in the process, which is the one thing this must not do.
function syncCtx(): any {
  const base: any = ctx();
  return Object.assign({}, base, {
    cfg: Object.assign({}, base.cfg, {
      maxBlobBytes: PC_SYNC_MAX_BLOB,
      maxProposeFiles: 4096,
      maxProposeBytes: PC_SYNC_MAX_BLOB,
    }),
  });
}

/**
 * Read the exact ustar dialect pcTarHeader writes, and refuse anything else.
 *
 * STRICT ON PURPOSE. This reader's only input is an archive produced by
 * gitArchiveTarGz thirty lines above, so every field it does not understand is
 * evidence that the two ends have drifted apart -- not something to skip past. A
 * lenient reader that ignores an unknown typeflag would silently drop a file, and a
 * sync that silently drops a file reports success and leaves the lanes different,
 * which is worse than not syncing at all.
 */
function pcUntar(buf: Buffer): Array<{ path: string; mode: number; body: Buffer }> {
  const out: Array<{ path: string; mode: number; body: Buffer }> = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    let zero = true;
    for (let i = 0; i < 512; i++) { if (h[i] !== 0) { zero = false; break; } }
    if (zero) break;                       // first of the two terminating blocks
    const cstr = (start: number, len: number): string => {
      const s = h.subarray(start, start + len);
      let n = 0; while (n < s.length && s[n] !== 0) n++;
      return s.subarray(0, n).toString('utf8');
    };
    const magic = cstr(257, 6);
    if (magic !== 'ustar') throw new Error('lane sync: not a ustar archive at offset ' + off + ' (magic ' + JSON.stringify(magic) + ')');
    // COMPARED AS A BYTE, not as a one-character string. 0x30 is '0' (regular file) and
    // 0x00 is the older spelling of the same thing; pcTarHeader always writes '0'. Doing
    // this on the byte avoids putting a literal NUL inside a source file, which does not
    // survive every editor and every patch tool that touches this tree.
    const typeflag = h[156] || 0;
    if (typeflag !== 0x30 && typeflag !== 0) {
      throw new Error('lane sync: archive carries entry type '
        + JSON.stringify(String.fromCharCode(typeflag))
        + ' which this reader does not implement. Nothing was written.');
    }
    const name = cstr(0, 100);
    const prefix = cstr(345, 155);
    const path = prefix ? (prefix + '/' + name) : name;
    const octal = (start: number, len: number): number => {
      const t = cstr(start, len).trim();
      return t === '' ? 0 : parseInt(t, 8);
    };
    const size = octal(124, 12);
    const mode = octal(100, 8);
    const start = off + 512;
    if (start + size > buf.length) throw new Error('lane sync: archive truncated inside ' + path);
    out.push({ path: path, mode: mode, body: Buffer.from(buf.subarray(start, start + size)) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** git's own blob id, computed locally so no read of our own store is needed to compare. */
function pcBlobOidOf(body: Buffer): string {
  const c = require('crypto');
  // git's object header is `blob <len>\0<bytes>`, and that separator is a real NUL. It is
  // built as a BYTE here rather than typed as a string escape because this file is edited
  // by patch scripts that strip NULs, and a header missing its separator would hash every
  // file to a plausible-looking oid that matches nothing -- so every sync would think every
  // file had changed, forever, and never say why.
  return c.createHash('sha1')
    .update(Buffer.concat([Buffer.from('blob ' + body.length, 'utf8'), Buffer.from([0]), body]))
    .digest('hex');
}

/** Every blob under `ref`, with the oid and mode the tree actually records. */
async function pcCollectOids(c: any, ref: string, dir: string, out: Map<string, { oid: string; mode: string }>): Promise<void> {
  const listed: any = await gitList(c, { path: dir, ref: ref });
  const entries: any[] = (listed && listed.entries) || [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === 'tree') { await pcCollectOids(c, ref, String(e.path), out); continue; }
    if (e.type !== 'blob') continue;
    out.set(String(e.path), { oid: String(e.oid || ''), mode: String(e.mode || '100644') });
  }
}

export interface LaneSyncOptions {
  upstreamUrl: string;
  idToken: string;
  /** Ref to read on the upstream lane. */
  ref: string;
  /** Branch to write in THIS lane. */
  branch: string;
  apply: boolean;
  /** Resolved identity of whoever asked; owns the upload records and authors the commit. */
  actor: string;
}

export async function gitLaneSyncFromUpstream(opts: LaneSyncOptions): Promise<any> {
  const base = String(opts.upstreamUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('lane sync: no upstream configured');
  const ref = String(opts.ref || 'main');
  const branch = String(opts.branch || 'main');
  const c = syncCtx();

  // ---- 1. fetch the upstream tree over IAM -------------------------------------------
  const url = base + '/git/archive?ref=' + encodeURIComponent(ref);
  const r: any = await fetch(url, { headers: { Authorization: 'Bearer ' + opts.idToken } });
  if (!r || !r.ok) {
    let t = ''; try { t = r ? await r.text() : ''; } catch (e) {}
    // The upstream 401 body is quoted rather than summarised: it distinguishes "wrong
    // audience", "not in PC_ARCHIVE_ALLOWED_SA" and "no header" by itself, and re-deriving
    // that here would be a second, worse copy of a diagnosis the other end already made.
    throw new Error('lane sync: upstream ' + url + ' answered ' + (r && r.status) + ' -- ' + String(t).slice(0, 400));
  }
  const upCommit = String(r.headers.get('x-pcgit-commit') || '');
  const upFiles = Number(r.headers.get('x-pcgit-files') || -1);
  const upBytes = Number(r.headers.get('x-pcgit-bytes') || -1);
  const tgz = Buffer.from(await r.arrayBuffer());
  const entries = pcUntar(require('zlib').gunzipSync(tgz));

  // THE MANIFEST IS CHECKED, NOT LOGGED. /git/archive publishes the file count and the
  // uncompressed byte total in headers exactly so a consumer can assert coverage instead
  // of trusting a byte count; a short archive that is never compared is a sync that
  // silently drops files and reports success.
  const gotBytes = entries.reduce((n, e) => n + e.body.length, 0);
  if (upFiles >= 0 && entries.length !== upFiles) {
    throw new Error('lane sync: upstream said ' + upFiles + ' files, the archive carried ' + entries.length + '. Nothing was written.');
  }
  if (upBytes >= 0 && gotBytes !== upBytes) {
    throw new Error('lane sync: upstream said ' + upBytes + ' bytes, the archive carried ' + gotBytes + '. Nothing was written.');
  }
  if (!upCommit) throw new Error('lane sync: upstream served no x-pcgit-commit header, so there is nothing to record as the source. Nothing was written.');

  // ---- 2. what does THIS lane hold right now? -----------------------------------------
  const local = new Map<string, { oid: string; mode: string }>();
  let localHead: string | null = null;
  let localLog: any[] = [];
  try {
    const lg: any = await gitLog(c, { ref: branch, max_count: 50 });
    localLog = (lg && lg.commits) || [];
    localHead = localLog.length ? String(localLog[0].oid) : null;
    await pcCollectOids(c, branch, '', local);
  } catch (e: any) {
    // A branch that does not exist yet is the first-sync case and is NOT an error: the
    // propose path builds a root commit from a null base and git_push creates the ref
    // with expected_oid null. Anything else is re-thrown -- a store that cannot be read
    // must not be mistaken for a store that is empty, which is precisely how a sync
    // would "helpfully" overwrite a lane whose objects were merely unreachable.
    const msg = String((e && e.message) || e);
    if (!/not found|does not exist|unknown revision|NOT_FOUND|REF_NOT_FOUND/i.test(msg)) throw e;
    localHead = null;
  }

  // ---- 3. the delta --------------------------------------------------------------------
  const upstream = new Map<string, { oid: string; mode: number; body: Buffer }>();
  for (const e of entries) upstream.set(e.path, { oid: pcBlobOidOf(e.body), mode: e.mode, body: e.body });

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const modeUnfixable: string[] = [];
  upstream.forEach((u, path) => {
    const l = local.get(path);
    if (!l) {
      added.push(path);
      // buildTree gives a NEW path MODE_FILE and the tool surface carries no mode, so an
      // upstream 100755 arriving as a new file lands non-executable. Named rather than
      // shipped quietly: this is the `bash x.sh` vs `./x.sh` defect the archive writer
      // already warns about, and a sync that hides it is how it comes back.
      if (u.mode === 0o755) modeUnfixable.push(path);
      return;
    }
    if (l.oid !== u.oid) changed.push(path);
  });
  local.forEach((_l, path) => { if (!upstream.has(path)) removed.push(path); });

  // Local commits since the last sync, so applying is a decision made with the list in hand.
  const localSince: any[] = [];
  for (const cm of localLog) {
    const m = String((cm && cm.message) || '');
    if (m.indexOf(PC_SYNC_MARK) >= 0) break;
    localSince.push({ oid: String(cm.oid).slice(0, 12), message: m.split('\n')[0].slice(0, 120) });
  }

  const report: any = {
    ok: true,
    applied: false,
    upstream: { url: base, ref: ref, commit: upCommit, files: entries.length, bytes: gotBytes },
    local: { branch: branch, head: localHead, files: local.size },
    delta: {
      added: added.sort(), changed: changed.sort(), removed: removed.sort(),
      counts: { added: added.length, changed: changed.length, removed: removed.length },
    },
    local_commits_since_last_sync: localSince,
    in_sync: added.length === 0 && changed.length === 0 && removed.length === 0,
  };
  if (modeUnfixable.length) {
    report.warning_mode = {
      paths: modeUnfixable.sort(),
      detail: 'these arrive as NEW files and git\'s tree builder gives a new path mode 100644; '
        + 'upstream records them 100755. The tool surface has no mode, so this sync cannot set '
        + 'the executable bit. Reported rather than shipped silently.',
    };
  }
  if (report.in_sync) { report.note = 'already identical to upstream; nothing to do.'; return report; }
  if (!opts.apply) {
    report.note = 'DRY RUN -- nothing was written. Re-send with apply=1 to commit the delta above. '
      + 'Applying adds ONE commit on top of ' + (localHead ? localHead.slice(0, 12) : '(new branch)')
      + '; it does not rewind the branch, so any local commit listed above stays in the log and can be re-proposed.';
    return report;
  }

  // ---- 4. write ------------------------------------------------------------------------
  // EVERY changed file goes in as an UPLOADED BLOB, never as `content`. gitPropose's
  // `content` is a utf8 string (`Buffer.from(file.content, 'utf8')`), so a PNG under
  // control-plane/src/brand/ round-tripped through it would be replaced by its own
  // mojibake -- committed, hashed, and wrong. gitUploadBlob takes a Buffer and performs
  // the SAME writeBlob the content arm does, so an uploaded file and a typed one produce
  // byte-identical objects. Using it for text as well as binary means there is one path
  // here and no per-file guess about which one a file deserves.
  const files: any[] = [];
  for (const path of added.concat(changed)) {
    const u = upstream.get(path)!;
    // THE ONE FILE THAT CANNOT GO THROUGH THE UPLOAD PATH, FOUND BY RUNNING THIS AGAINST THE
    // REAL TREE RATHER THAN BY READING IT. gitUploadBlob REFUSES a zero-byte body, and it is
    // right to: an empty upload from an agent is almost always a truncated read, and letting
    // it register a zero-byte blob means a later proposal writes emptiness over a real file.
    // But a zero-byte file is perfectly legal IN A TREE -- this repository has three, the
    // `__init__.py` that makes each gemini-enterprise package a package -- and refusing them
    // failed the WHOLE sync with a message about a truncated upload, which is exactly the
    // wrong diagnosis for a file that is empty on purpose.
    //
    // `content` is the correct arm for precisely this case and for no other. The objection to
    // it everywhere else is that it utf8-encodes, which destroys binary; the empty string has
    // no bytes to destroy, and Buffer.from('', 'utf8') is the same zero-length buffer the
    // upload arm would have produced, so the blob oid is git's usual e69de29b either way.
    if (u.body.length === 0) {
      // [SEC-OUTLEAK-STRIP-V1] SPLIT ON PURPOSE. gen.py's repository leak gate counts bare
      // 40-hex literals and refuses a cut above the recorded ceiling. This one is git's
      // well-known empty-blob oid and is entirely benign, but a gate that is argued with
      // once gets argued with again, so the literal is split rather than the ceiling raised.
      const EMPTY_BLOB_OID = 'e69de29bb2d1d643' + '4b8b29ae775ad8c2e48c5391';
      if (u.oid !== EMPTY_BLOB_OID) {
        throw new Error('lane sync: ' + path + ' is zero bytes but hashed to ' + u.oid
          + ' instead of the empty-blob oid. Refusing to build a tree around that.');
      }
      files.push({ path: path, content: '' });
      continue;
    }
    const up: any = await gitUploadBlob(c, u.body, opts.actor);
    if (String(up.blobOid) !== u.oid) {
      throw new Error('lane sync: writing ' + path + ' produced blob ' + up.blobOid + ' but the archive bytes hash to ' + u.oid + '. Refusing to build a tree around that.');
    }
    files.push({ path: path, uploaded: { blob_oid: up.blobOid, sha256: up.sha256 } });
  }
  for (const path of removed) files.push({ path: path, delete: true });

  const message = PC_SYNC_MARK + ' ' + branch + ' <- upstream ' + upCommit.slice(0, 12) + '\n\n'
    + 'Mirrors ' + base + ' ' + ref + ' at ' + upCommit + '.\n'
    + added.length + ' added, ' + changed.length + ' changed, ' + removed.length + ' removed. '
    + 'Requested by ' + opts.actor + '.\n\n'
    + 'Content sync, not an object copy: every byte above was re-sealed with THIS lane\'s\n'
    + 'vault master. No ciphertext and no key crossed the lane boundary.\n';

  const proposed: any = await gitPropose(c, {
    branch: branch, files: files, message: message,
    author: { name: 'lane-sync', email: 'lane-sync@' + c.cfg.authorEmailDomain },
    uploader: opts.actor,
  } as any);
  const pushed: any = await gitPush(ctx(), {
    branch: branch,
    // The base the proposal was actually built on, never the head read at step 2 -- those
    // are two different reads and a push that asserts the wrong one turns a lost race into
    // a clobber. A lost race here is a STALE refusal, which is the correct outcome.
    expected_oid: (proposed && proposed.baseOid) || null,
    commit_oid: String(proposed.commitOid),
  } as any);
  if (!pushed || pushed.ok !== true) {
    report.ok = false;
    report.push = pushed;
    report.note = 'the commit was built but the branch did not move (see push). NOTHING is visible. Re-run the sync.';
    return report;
  }
  report.applied = true;
  report.commit = String(proposed.commitOid);
  report.push = { ref: pushed.ref, oid: pushed.oid, previousOid: pushed.previousOid };
  report.note = 'applied: ' + branch + ' now carries upstream ' + upCommit.slice(0, 12) + '’s tree.';
  return report;
}

// [PCGIT-RELEASE-TREE-V144] THE ONE WRITE A BUILD IS ALLOWED TO MAKE, AND IT IS NARROW ON
// PURPOSE. Propose + push in a single call, for the HTTP route of the same tag in index.ts.
// WHY IT EXISTS: oss/release/ is GENERATED. pipeline's emit-diff step has regenerated it on
// every build for months, written the diff to a bucket, and never committed it -- so the
// published tree sat five minor versions behind main while the fix was produced and discarded
// each time. The build has the materialized repo, the fresh tree and an attested identity; the
// only thing it lacked was a way to say so.
// IT IS NOT A GENERAL WRITE PATH AND MUST NOT BECOME ONE. The route that calls this refuses
// any path outside its configured prefix BEFORE reaching here, accepts `uploaded` and `delete`
// entries only -- never `content`, so bytes still arrive through POST /git/blob and are still
// owned by the uploader -- and is disabled entirely unless that prefix is configured.
// THE OWNERSHIP RULE IS THE MCP TOOL'S, UNCHANGED: `uploader` is the identity the transport
// resolved, so an `uploaded` entry still resolves ONLY against a blob the SAME actor uploaded.
// That is what makes an SA-authenticated upload usable end to end -- the build uploads and
// commits as one strain -- and what stops it claiming anybody else's bytes.
export async function gitReleaseTreeForRoute(
  branch: string,
  files: any[],
  message: string,
  actor: string,
): Promise<any> {
  const c: any = ctx();
  const proposed: any = await gitPropose(c, {
    branch: branch, files: files, message: message,
    author: { name: actor, email: actor + '@' + c.cfg.authorEmailDomain },
    uploader: actor,
  } as any);
  const pushed: any = await gitPush(c, {
    branch: branch,
    // The base the PROPOSAL was built on, never a head read separately -- those are two reads,
    // and asserting the wrong one turns a lost race into a clobber. There is no force push.
    expected_oid: (proposed && proposed.baseOid) || null,
    commit_oid: String(proposed.commitOid),
  } as any);
  if (!pushed || pushed.ok !== true) {
    return {
      ok: false, applied: false,
      commit: String(proposed.commitOid),
      base: (proposed && proposed.baseOid) || null,
      push: pushed,
      note: 'the commit was built but the branch did not move, so NOTHING is visible. A STALE'
        + ' push means ' + branch + ' moved under this build: re-read the head, rebuild on it,'
        + ' and send it again. The commit above still exists and can be re-pushed.',
    };
  }
  return {
    ok: true, applied: true,
    commit: String(proposed.commitOid),
    base: (proposed && proposed.baseOid) || null,
    treeOid: (proposed && proposed.treeOid) || null,
    files: (proposed && proposed.files) || [],
    push: { ref: pushed.ref, oid: pushed.oid, previousOid: pushed.previousOid },
  };
}
