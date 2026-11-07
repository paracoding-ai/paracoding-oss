// SPDX-License-Identifier: Apache-2.0
// [EXEC-INGEST-V1] Executor-bucket ingest, extracted from index.ts (strangler). The executor
// writes its single-use claim, run results and journal entries as immutable GCS objects; this
// module copies those rows back into the collections the console reads. Idempotent by object
// name, fired-not-awaited off a console poll. Moved verbatim from index.ts; the module-level
// nudge throttle/running flags (PC_EXEC_INGEST_AT / _RUNNING) and config consts are private here,
// and crypto / db / FieldValue / waFetch / waAccessToken / pxCol / pcCol now come from sibling
// mods / ../shared instead of index-local definitions.
import * as crypto from 'crypto';
import { db, FieldValue } from './store.js';
import { waFetch, waAccessToken } from '../shared.js';
import { pxCol, pcCol } from './collections.js';

// ---- [EXEC-BUCKET-INGEST-V1] THE EXECUTOR RECORDS ARRIVE AS OBJECTS, NOT AS WRITES ----
// WHAT MOVED AND WHY. gate-exec held project-wide roles/datastore.user -- read and write on
// every document in every collection -- for exactly three things: the single-use claim, the
// result of a run, and its own journal entries. All three are now objects in one bucket on
// which the executor holds roles/storage.objectCreator and nothing else: create, no read, no
// overwrite, no delete. It can append an audit record and can never edit the record
// afterwards, which is strictly stronger than the grant it is losing.
//
// WHAT THIS CODE IS. The other end: the control plane can read that bucket, so it copies the
// rows back into the collections the console already reads. It is a CONVENIENCE, not custody.
//
// IF THIS NEVER RUNS, NOTHING IS LOST. The result of every job is an object named
// deterministically from the job id, and it is recoverable in one command by anyone who can
// read the bucket:
//     gcloud storage cat gs://$PC_EXEC_BUCKET/results/<job-id>-<digest>.json
// The journal entries are likewise objects under journal/<job-id>/. An ingest that is off,
// broken, rate-limited or simply never triggered costs a stale console view and nothing else.
// That is the whole reason the executor writes the object BEFORE it returns rather than
// handing the result to a caller that may already be gone.
//
// NO SCHEDULER, AND THAT IS DELIBERATE. Cloud Scheduler would be a new resource, a new
// service account, a new IAM binding and a new thing to uninstall, to move rows between two
// stores this service already talks to. Instead the sweep rides GET /api/dash/summary --
// a path an open console page already polls -- at most once every PC_EXEC_INGEST_MIN_MS, and
// never twice at once. No poll waits on it: it is fired and not awaited, so a slow or failing
// bucket cannot delay or break the queue the operator is looking at.
//
// IDEMPOTENT BY CONSTRUCTION, NOT BY BOOKKEEPING. Every row is written to a document id
// derived from the OBJECT NAME, and every field comes from the immutable object -- including
// the timestamp, which is read out of the record instead of stamped at ingest. Running the
// sweep twice over the same objects therefore rewrites identical documents in place: same
// ids, same values, no duplicate rows, no second journal line for one refusal. That also
// means no delete is ever needed, so this service is granted READ on the bucket and not
// more: neither end of this pipe can destroy the audit trail.
const PC_EXEC_BUCKET = process.env.PC_EXEC_BUCKET || '';
const PC_EXEC_INGEST_MIN_MS = parseInt(process.env.PC_EXEC_INGEST_MIN_MS || '30000', 10);
const PC_EXEC_INGEST_PAGE = parseInt(process.env.PC_EXEC_INGEST_PAGE || '100', 10);
let PC_EXEC_INGEST_AT = 0;
let PC_EXEC_INGEST_RUNNING = false;
const PC_EXEC_GCS = process.env.PC_GCS_HOST || 'https://storage.googleapis.com';
export async function pcExecBucketList(prefix: string, pageToken: string): Promise<any> {
  const tok = await waAccessToken();
  if (!tok) return null;
  const u = PC_EXEC_GCS + '/storage/v1/b/' + encodeURIComponent(PC_EXEC_BUCKET) + '/o?prefix=' +
    encodeURIComponent(prefix) + '&maxResults=' + String(PC_EXEC_INGEST_PAGE) +
    (pageToken ? ('&pageToken=' + encodeURIComponent(pageToken)) : '');
  const r: any = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r || !r.ok) return null;
  return await r.json();
}
export async function pcExecBucketGet(name: string): Promise<any> {
  const tok = await waAccessToken();
  if (!tok) return null;
  const u = PC_EXEC_GCS + '/storage/v1/b/' + encodeURIComponent(PC_EXEC_BUCKET) + '/o/' +
    encodeURIComponent(name) + '?alt=media';
  const r: any = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r || !r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
// The document id of an ingested row is a function of the OBJECT NAME and of nothing else.
// That is what makes a second sweep a no-op instead of a second row.
export function pcExecIngestId(name: string): string {
  return 'gcs-' + crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 32);
}
// The executor stamps its own times as RFC3339 strings. They are read back here rather than
// re-stamped, so an ingested row is IDENTICAL on every sweep -- a serverTimestamp would make
// each pass rewrite the row with a new value and reorder the journal under the operator.
export function pcExecIngestWhen(v: any): any {
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? FieldValue.serverTimestamp() : new Date(t);
}
export async function pcExecIngestSweep(): Promise<any> {
  const out: any = { journal: 0, results: 0, listed: 0 };
  if (!PC_EXEC_BUCKET) return out;
  const stateRef = pxCol().doc('state');
  const snap: any = await stateRef.get().catch(() => null);
  const cur: any = (snap && snap.exists) ? (snap.data() || {}) : {};
  for (const kind of ['journal', 'results']) {
    // ONE PAGE PER SWEEP, with the page token carried in Firestore. A sweep does bounded
    // work no matter how many objects exist, and the token resuming where the last one
    // stopped is an optimisation only: when the listing runs out the token is cleared and
    // the next sweep starts again from the top, which is free precisely because ingest is
    // idempotent. No object can be skipped for good by a cursor that got ahead of itself.
    const listing: any = await pcExecBucketList(kind + '/', String(cur[kind + '_token'] || ''));
    if (!listing) continue;
    for (const it of (listing.items || [])) {
      const name = String((it && it.name) || '');
      if (!name) continue;
      out.listed++;
      const doc: any = await pcExecBucketGet(name);
      if (!doc) continue;
      if (kind === 'journal') {
        await db.collection('journal').doc(pcExecIngestId(name)).set({
          agent_id: String(doc.agent_id || 'fleet-gate-exec'),
          action: String(doc.action || ''),
          message: String(doc.message || ''),
          job_id: String(doc.job_id || ''),
          timestamp: pcExecIngestWhen(doc.written_at),
          ingested_from: name,
        });
        out.journal++;
      } else {
        const jid = String(doc.job_id || '');
        if (!jid) continue;
        // merge:true, and only the fields the console projects. The job document carries the
        // approval, the staging identity and the reason chain; an ingest that replaced it
        // would destroy the record it exists to complete.
        await pcCol().doc(jid).set({
          status: 'executed',
          exit_code: (typeof doc.exit_code === 'number') ? doc.exit_code : -1,
          stdout_tail: String(doc.stdout || '').slice(-6000),
          stderr_tail: String(doc.stderr || '').slice(-6000),
          executed_at: pcExecIngestWhen(doc.executed_at),
          exec_result_object: name,
        }, { merge: true });
        out.results++;
      }
    }
    const patch: any = {};
    patch[kind + '_token'] = String(listing.nextPageToken || '');
    await stateRef.set(patch, { merge: true }).catch(() => {});
  }
  return out;
}
// FIRED, NEVER AWAITED. The caller is a page poll; it gets its answer whatever this does.
export function pcExecIngestNudge(): void {
  if (!PC_EXEC_BUCKET) return;
  const now = Date.now();
  if (PC_EXEC_INGEST_RUNNING) return;
  if (now - PC_EXEC_INGEST_AT < PC_EXEC_INGEST_MIN_MS) return;
  PC_EXEC_INGEST_AT = now;
  PC_EXEC_INGEST_RUNNING = true;
  pcExecIngestSweep()
    .then((n: any) => { if (n && (n.journal || n.results)) { try { console.error('[gate] EXEC-BUCKET-INGEST-V1: ingested ' + String(n.journal) + ' journal object(s) and ' + String(n.results) + ' result(s) from the executor bucket.'); } catch (e) {} } })
    .catch((e: any) => { try { console.error('[gate] EXEC-BUCKET-INGEST-V1: the sweep failed. NOTHING IS LOST -- the executor records are objects in the bucket and are recoverable with gcloud storage cat. Reason:', (e && e.message) || e); } catch (e2) {} })
    .finally(() => { PC_EXEC_INGEST_RUNNING = false; });
}
