// SPDX-License-Identifier: Apache-2.0
// [SHARED-BASE-V1] Foundational primitives extracted from index.ts (Wave 0, strangler
// modularization). Imports NOTHING from ./index -- every module imports from here, which breaks
// all import cycles.
import * as crypto from 'crypto';
import express from 'express';

export const PC_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
export const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || '';
export const PC_LAKE = DATA_LAKE_BUCKET || process.env.LAKE_BUCKET || '';
export const GCP_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
// [MODEL-PROVIDERS-MOD-V1] Pure model/provider config values read by BOTH index.ts and
// mods/model-providers.ts, moved here so both import one definition (strangler refactor).
export const HAR_OPUS5 = 'claude-opus-4-8';
export const HAR_GEMINI_THINKING_LEVELS = ['low', 'medium', 'high'];
export const HAR_GEMINI_MAX_TOKENS = Math.max(1024, Number(process.env.CHAT_MAX_TOKENS_GEMINI || 65536) || 65536);
export const HAR_GEMINI_SAFETY_OFF = String(process.env.CHAT_GEMINI_SAFETY || 'off').trim().toLowerCase() !== 'block';
export const PC_REPO_ID = process.env.PC_REPO_ID || 'paracoding-fleet';
export const GCP_BILLING_DATASET = process.env.GCP_BILLING_DATASET || 'billing_export';
export const PC_TTL_FIELD = 'expireAt';
export const PC_TTL_DAYS: { [coll: string]: number } = { chat_history: 120, pending_confirms: 60 };
export const PC_ARCHIVE_COLLS: { [coll: string]: string } = { journal: 'journal', chat_history: 'chat_history' };
export const FLEET_MODES = ['home', 'work', 'dual'];
export const AGENT_TOKENS: Record<string, string> = JSON.parse(
  Buffer.from(process.env.AGENT_TOKENS_B64 || '', 'base64').toString('utf8') || '{}'
);
export const waFetch: any = (globalThis as any).fetch;
export function waB64(buf: Buffer | Uint8Array): string { return Buffer.from(buf).toString('base64url'); }
export function waSha(s: string): Buffer { return crypto.createHash('sha256').update(s).digest(); }
export function waEq(a: string | Buffer, b: string | Buffer): boolean {
  const ba = Buffer.from(a as any); const bb = Buffer.from(b as any);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
export async function waIdToken(audience: string): Promise<string> {
  const r = await waFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(audience), { headers: { 'Metadata-Flavor': 'Google' } });
  return (await r.text()).trim();
}
export async function waAccessToken(): Promise<string> {
  const r = await waFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  const j: any = await r.json(); return (j && j.access_token) || '';
}
export function pcStableJson(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pcStableJson).join(',') + ']';
  const k = Object.keys(v).sort();
  const out: string[] = [];
  for (let i = 0; i < k.length; i++) out.push(JSON.stringify(k[i]) + ':' + pcStableJson(v[k[i]]));
  return '{' + out.join(',') + '}';
}
export function pcJobCommandSha(args: any): string {
  return crypto.createHash('sha256').update(pcStableJson(args === undefined ? null : args)).digest('hex');
}
export function tsMillis(t: any): number {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t._seconds) return t._seconds * 1000;
  if (t.seconds) return t.seconds * 1000;
  return 0;
}
export function pcLakeBucket(): string {
  if (!PC_LAKE) throw new Error('LAKE_BUCKET_UNCONFIGURED: neither DATA_LAKE_BUCKET nor LAKE_BUCKET is set on this service, so there is no data lake to read or write. Refusing to guess a bucket name from the project id.');
  return PC_LAKE;
}
export function pcTtlExpireAt(coll: string, nowMs: number): any {
  const days = PC_TTL_DAYS[coll];
  return days ? new Date(nowMs + days * 86400000) : null;
}
export function pcTtlStamp(coll: string, data: any, nowMs: number): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const exp = pcTtlExpireAt(coll, nowMs);
  if (!exp) return data;
  if (Object.prototype.hasOwnProperty.call(data, PC_TTL_FIELD)) return data;
  const out: any = {};
  for (const k of Object.keys(data)) out[k] = data[k];
  out[PC_TTL_FIELD] = exp;
  return out;
}
export function fleetTransportAllowed(mode: string, transport: string): boolean {
  if (mode === 'home') return false;
  if (mode === 'work') return transport === 'vertex';
  if (mode === 'dual') return transport === 'vertex' || transport === 'key';
  return false;
}
export function fleetRefusalText(mode: string, what: string, transport: string): string {
  return 'fleet_mode=' + mode + ': ' + what + ' needs the ' + transport + ' transport, so no '
    + 'call was made and nothing was billed. home refuses every model call, work allows '
    + 'keyless Vertex only, dual allows both. Change it at Firestore '
    + 'config/models.fleet_mode -- a privileged write, so stage it as a job (under PC_AUTO_APPROVE=1 it runs in that call).';
}
export function harErrId(): string { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
export function harFail(res: any, e: any, where: string): void {
  const id = harErrId();
  console.error('[' + where + '] handler error err_id=' + id, e);
  try { if (!res.headersSent) res.status(500).json({ error: 'internal error', err_id: id }); } catch (_e) {}
}
export function pcBodyHasToolsCall(body: any): boolean {
  try {
    const msgs = Array.isArray(body) ? body : [body];
    for (const mm of msgs) { if (mm && typeof mm === 'object' && String((mm as any).method || '') === 'tools/call') return true; }
  } catch (e) {}
  return false;
}
export function pcTouchActivity(): void {
  try { require('fs').writeFile('/run/fleet/last-activity', String(Date.now()), () => {}); } catch (e) {}
}
export function assertIdentity(req: express.Request): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('401 Unauthorized: Missing bearer token');
  }
  const token = authHeader.substring('Bearer '.length).trim();
  const agentId = AGENT_TOKENS[token];
  if (!agentId) {
    throw new Error('401 Unauthorized: Unknown agent token');
  }
  return agentId; // trusted identity from server-side map, never the caller's claim
}

// [GH-SECRET-LANE-PREFIX-V1] Lane-namespaced GitHub-token secret prefix; env-driven with the
// unprefixed name as default (install.sh sets the variable). Promoted from index.ts so the
// findings gate can read it without importing index. Pure env read, side-effect-free.
export const PC_GH_SECRET_PREFIX = (process.env.PC_GH_SECRET_PREFIX || 'github-token-');

// [GE-SEAT-BUDGET-V1] Per-seat/day Gemini Enterprise query budget, env-driven. Promoted from
// index.ts so the gemini-session meter can read them without importing index. Pure env reads.
export const GE_QUERIES_PER_SEAT = Math.max(1, Number(process.env.GE_QUERIES_PER_SEAT || 200) || 200);
export const GE_SEATS            = Math.max(1, Number(process.env.GE_SEATS || 2) || 2);
// [GE-CONFIGURED-V1] True when all four Gemini Enterprise env vars are set. Promoted from index.ts
// (index keeps its GE_PN/GE_ENGINE/GE_CLIENT/GE_SECRET consts for GE_ROOT/geMissing; those are just
// `process.env.X || ''`, so reading process.env here is the same truthiness test). Pure env reads.
export const geConfigured = (): boolean => !!(process.env.GE_PROJECT_NUMBER && process.env.GE_ENGINE && process.env.GE_OAUTH_CLIENT_ID && process.env.GE_OAUTH_CLIENT_SECRET);
// [GE-ENGINE-CONST-V1] Promoted from index.ts (strangler) so mods/gemini-enterprise can build the
// assistant resource root and send a model_id without importing index; index (geMissing, geChat,
// the chat route) still reads them. Pure env reads, byte-identical to the index originals.
export const GE_PN     = process.env.GE_PROJECT_NUMBER || '';
export const GE_ENGINE = process.env.GE_ENGINE || '';
export const GE_MODEL_ID = String(process.env.GE_MODEL_ID || '').trim();
// [SEC-OAUTH-TOKHASH] sha256-hex of a token; document ids are this, never the raw token. Promoted
// from index.ts (pure, side-effect-free) so modules can hash without importing index.
export function oaTokHash(t: string): string { return crypto.createHash('sha256').update(String(t), 'utf8').digest('hex'); }
// [SEC-OAUTH-PUBBASE] public base URL from MCP_PUBLIC_URL or the request host. Promoted from
// index.ts (pure) so modules (a2a cards, metadata) can build URLs without importing index.
export function oaPubBase(req: any): string { return String(process.env.MCP_PUBLIC_URL || ('https://' + req.get('host'))).replace(/\/$/, ''); }

// [CHAT-WIRE-V1] Promoted from index.ts for mods/chat-wire.ts (harChatResolved) while index still
// reads them too. Pure values: an env read and three joined string literals, no side effects.
export const HAR_CHAT_EFFORT = String(process.env.CHAT_EFFORT || 'medium');

export const HAR_LAW_NO_RUNNERS = [
  'DISPATCH LAW: nothing in this install runs unattended. The operator drives it from an MCP client.',
  'Work items are a shared list, not a queue anything claims. Nothing runs unattended.',
  'A parked status (needs_claude / needs_cowork / needs_supervisor) is a note for a human, not a handover to a runner.',
].join(' ');

export const HAR_LAW_SURFACES = [
  'TWO CLAUDE SURFACES. (1) THIS console: chat PLUS a real executor -- run_command runs shell on the',
  'gate executor, the git_* tools read and write the store, and gcp_api reaches the GCP REST surface.',
  'Your script runs with PATH restricted to an enumerated set of binaries, so a BARE NAME not on',
  'the list does not resolve -- gsutil and ssh answer "command not found". Builtins and keywords',
  'are unaffected, so set -uo pipefail is fine. That is the whole of it: it narrows bare-name',
  'lookup for an already-approved script. It is NOT a sandbox and it does not confine you. An',
  'ABSOLUTE PATH never consults PATH, and python3, python, bash, sh, env, xargs and find are ON',
  'the list and each runs an arbitrary binary. Both are by design and both are stated here:',
  'that is the specified behaviour of this control, not a weakness discovered in it.',
  'What primarily gates you is the signed command pin, not a person: with PC_AUTO_APPROVE=1',
  '(the shipped default) a staged command is KMS-signed and executed in the same call with no',
  'per-job approval step, and the executor refuses any script whose sha256 does not match the',
  'signed hash. With it off a staged job sits at pending; nothing comes to approve it.',
  'Use `gcloud storage`, never gsutil -- gsutil is not on the executor image at all. You CAN build a',
  'container and deploy a Cloud Run service from here; see BUILD AND DEPLOY below. What you cannot',
  'do is hold a long-running interactive session. (2) COWORK: disposable containers',
  'with a full checkout, arbitrary tooling and a much longer clock -- better for multi-file refactors',
  'and anything needing real iteration. Use cowork_prompt when the work genuinely wants that, NOT as a',
  'way to decline work this surface can do. Never cite "doctrine" as a reason you cannot build:',
  'if a tool would refuse you, say which tool and why; if it would not, do the work.',
].join(' ');

export const HAR_LAW_BUILD = [
  'BUILD AND DEPLOY (measured working from this surface; PROJECT=' + String(process.env.GCP_PROJECT || '<project>'),
  'REGION=' + String(process.env.GCP_REGION || '<region>') + '):',
  '1. WRITE THE SOURCE with run_command python3 -- open() the files under a fresh /tmp/<name>/ dir',
  '(a Dockerfile plus your app). /tmp survives between jobs only OPPORTUNISTICALLY, so never assume a',
  'previous job left files there: re-check, and rebuild the directory if it is missing.',
  '2. SUBMIT THE BUILD, always --async, because the executor has a hard timeout around 4-5 minutes and',
  'a synchronous build will be killed mid-flight:',
  'gcloud builds submit /tmp/<name> --tag <REGION>-docker.pkg.dev/<PROJECT>/cloud-run-source-deploy/<name>:<tag>',
  '--service-account=projects/<PROJECT>/serviceAccounts/<the executor SA> --region=<REGION>',
  '--gcs-source-staging-dir=gs://run-sources-<PROJECT>-<REGION>/builds',
  '--gcs-log-dir=gs://run-sources-<PROJECT>-<REGION>/buildlogs',
  '--default-buckets-behavior=regional-user-owned-bucket --async --format=value(id)',
  'FOUR FLAGS ARE NOT OPTIONAL AND ALL FOUR FAIL CONFUSINGLY IF OMITTED. Keep',
  '--default-buckets-behavior -- it governs SOURCE staging -- but it does NOT redirect logs.',
  'Without --gcs-log-dir the build writes to gs://<PROJECT NUMBER>-<REGION>-cloudbuild-logs, which',
  'you have no storage.objects.get on, and comes back FAILURE with its only step still QUEUED --',
  'dead before it ran anything -- on "Failure setting up GCS logging ... Error 403 ... does not',
  'have storage.objects.get access". THAT FAILURE HIDES ITSELF: the logs are in the bucket you are',
  'locked out of, so `gcloud builds log` and `gcloud storage cat` answer 403 too. It is NOT a sign',
  'that you cannot build -- add the flag and submit again. If you must read a build that already',
  'failed this way, use the Cloud Logging API instead: POST logging.googleapis.com/v2/entries:list',
  'with filter resource.type="build" AND resource.labels.build_id="<id>". Without',
  '--gcs-source-staging-dir you get "The user is forbidden from accessing the bucket',
  '[<PROJECT>_<REGION>_cloudbuild]" -- that is the bucket Cloud Build picks for itself, which nothing',
  'granted you rights on; gs://run-sources-<PROJECT>-<REGION> is created by the installer and the',
  'executor holds objectAdmin on it, so stage there and the 403 does not happen. And',
  '--service-account MUST be the full resource name projects/<PROJECT>/serviceAccounts/<email>: a bare',
  'email answers "Failed to parse resource name", which looks like an auth failure and is a syntax one.',
  '3. POLL IN A SEPARATE CALL: gcloud builds describe <id> --region=<REGION> --format=value(status)',
  'until SUCCESS or FAILURE. Do not sleep through the timeout inside one job.',
  '4. DEPLOY: gcloud run deploy <name> --image <the tag you built> --region=<REGION>',
  '--service-account=<the executor SA> --allow-unauthenticated --quiet --format=value(status.url)',
  '5. VERIFY ANONYMOUSLY OR YOU HAVE NOT VERIFIED IT. curl the URL with NO credentials --',
  '`curl -sS -o /dev/null -w "%{http_code}" <url>` in a shell that has no gcloud auth applied to it.',
  'A check made as yourself proves only that YOU can reach it, and you hold run.invoker; the operator',
  'opening that URL in a browser does not. Reporting "HTTP 200 OK" from an authenticated probe while',
  'the operator sees "Error: Forbidden -- your client does not have permission to get URL" is the exact',
  'failure this step exists to prevent, and it has happened.',
  '6. A DEPLOY THAT PRINTS "Setting IAM policy failed", OR WHOSE ANONYMOUS CHECK RETURNS 403, STILL',
  'DEPLOYED. The service is live and the URL is real; what failed is the public binding. CONFIRM it',
  'rather than guessing: `gcloud run services get-iam-policy <svc> --region <REGION>` on a service',
  'with no allUsers comes back as bare {"etag":...} with no bindings at all. Trying to add it answers',
  'FAILED_PRECONDITION: "One or more users named in the policy do not belong to a permitted customer,',
  'perhaps due to an organization policy" -- that is Domain Restricted Sharing',
  '(constraints/iam.allowedPolicyMemberDomains) refusing allUsers.',
  'DO NOT CONCLUDE THE PROJECT CANNOT HOST PUBLIC SERVICES. The constraint blocks NEW allUsers',
  'bindings; ones created before it was applied keep working, so a project can contain several',
  'genuinely public services AND refuse to make the next one public. Both facts are true at once and',
  'the operator will rightly point at their existing public sites.',
  'SAY BOTH THINGS: the build and deploy succeeded, AND the service is not publicly reachable, with',
  'the error above as evidence. Do not call it verified, do not retry the deploy over it, and never',
  'report your own authenticated 200 in place of the anonymous result. Only an org admin can lift it,',
  'by exempting the project from that constraint; offer that and let the operator decide.',
  'DO NOT GO LOOKING FOR YOUR OWN IDENTITY OR YOUR OWN BUCKETS -- you are told both above and',
  'project-wide listing is DENIED BY DESIGN, not broken. `gcloud iam service-accounts list` answers',
  '"iam.serviceAccounts.list denied" and `gcloud storage ls` with no bucket answers',
  '"storage.buckets.list denied". Both refusals are correct and neither will be granted: this',
  'account is scoped to the one staging bucket named above. Listing INSIDE that bucket works',
  '(`gcloud storage ls gs://run-sources-<PROJECT>-<REGION>/`) and so does copying into it. Spending',
  'rounds rediscovering this is the single most common way a build runs out of turns.',
  'STORAGE IS ALWAYS `gcloud storage`, NEVER `gsutil`. gsutil is NOT on the executor image, and it',
  'also ignores the injected approver token and falls back to an identity with no access, so even',
  'where it exists it fails 403 for a reason the output does not explain. `gcloud storage ls`,',
  '`gcloud storage cp`, `gcloud storage rsync` -- these are the ones that work.',
  'CLEAN UP after a demo: gcloud run services delete <name> --region=<REGION> --quiet. Note that the',
  'executor CANNOT delete the Artifact Registry image (artifactregistry.packages.delete is not granted),',
  'so say the image is left behind rather than claiming a clean teardown.',
].join(' ');

// [OAUTH-MOD-V1] Pure OAuth config values read by BOTH index.ts (routes + oaSelfPrincipal) and
// mods/oauth.ts, moved here so both import one definition (strangler refactor).
export const OAUTH_ALLOW = String(process.env.WA_APPROVER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const OA_REG_WINDOW_MS = 3600000;

// [APPROVAL-MOD-V1] Approval-signing config read by BOTH index.ts (the auto-sign caller)
// and mods/approval.ts (the canon/sign helpers). Pure module-level values; moved here so
// neither side imports the other.
export const PC_APPROVAL_CANON_V2_ID = 'PC-APPROVAL-CANON-V2';
// The key version is CONFIGURATION and is never derived from the job, the request or the
// document: anything that let an attacker choose it would let them name a key they hold.
// Unset means Stage C is simply not emitted and Stage A/B behaviour is bit-for-bit unchanged.
export const PC_APPROVAL_SIG_KEY = String(process.env.APPROVAL_SIG_KEY_VERSION || '');

// [VAULT-CRYPTO-MOD-V1] Pure vault envelope constants read by BOTH index.ts (the staying
// master-key machinery plus the lv*/harDecryptLakeBuf readers) and mods/vault-crypto.ts (the
// pure encrypt/decrypt helpers), moved here so both import one definition (strangler refactor).
export const VAULT_MAGIC = Buffer.from('PCV1', 'ascii');
export const VAULT_EPOCH = 2;  // [PCV1-XWING-EPOCH2-PIVOT] was 1 (ML-KEM-1024 era); 2 == KEM_XWING

// [CHAT-ENGINE-MOD-V1] Boot-identity consts moved out of index.ts for the chat-engine strangler
// extraction: harTurnCheckpoint/harTurnRecoverOnBoot (now in mods/chat-engine.ts) and the argon
// build-recovery sweep (still in index.ts) all read them, so both import one definition. Pure
// module-load values -- hostname:port and the boot timestamp.
export const PC_INSTANCE_KEY = String(require('os').hostname()) + ':' + String(process.env.PORT || '8080');
export const PC_BOOT_AT = new Date().toISOString();

// [LAKE-VAULT-MOD-V1] Gate-session secret + the lakeview TTL. Pure env-derived values read by
// BOTH index.ts (the staying gate-session mint/verify and the /api/lakeview/link route) and
// mods/lake-vault.ts (lvSign/lvVerify/lvMint), moved here so neither side imports the other.
export const WA_SESSION_SECRET = process.env.WA_SESSION_SECRET || '';
// HFC4: a gate session is an HMAC(payload, WA_SESSION_SECRET). An empty/weak secret makes the
// signature forgeable (empty-key HMAC), which would let anyone mint a valid gate_session cookie.
// Require a strong secret; if it is missing/short we FAIL CLOSED (never issue, never verify).
export const WA_SESSION_SECRET_MIN = 16;
export const WA_SESSION_SECRET_OK = typeof WA_SESSION_SECRET === 'string' && WA_SESSION_SECRET.length >= WA_SESSION_SECRET_MIN;
export const LV_TTL_SEC = Math.max(30, Math.min(900, parseInt(process.env.LAKEVIEW_TTL_SEC || '300', 10) || 300));

// [IDENTITY-MOD-V1] Pure env-derived values read by BOTH index.ts and mods/identity.ts, moved here
// so both import one definition (strangler refactor). Values are byte-identical to their former
// index.ts definitions.
export const WA_APPROVER_EMAILS = (process.env.WA_APPROVER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
export const PC_KEY_TTL_DAYS = Math.max(1, Number(process.env.PC_KEY_TTL_DAYS || 7));

// [HISTORY-TOOLS-MOD-V1] PQC-TLS policy identifiers: pure env-derived values read by BOTH the
// staying /api/security/pqc-tls route in index.ts and the moved pqc* readers in
// mods/history-tools.ts (strangler refactor). Byte-identical to their former index.ts defs --
// HAR_PROJECT there is the same GCP_PROJECT||GOOGLE_CLOUD_PROJECT||PC_PROJECT chain as GCP_PROJECT here.
export const PQC_POLICY_NAME: string = process.env.PQC_POLICY_NAME || 'pqc-pqc-policy';
export const PQC_POLICY_URL: string = 'https://compute.googleapis.com/compute/v1/projects/' + GCP_PROJECT + '/global/sslPolicies/' + PQC_POLICY_NAME;
export const PQC_PROXIES_URL: string = 'https://compute.googleapis.com/compute/v1/projects/' + GCP_PROJECT + '/aggregated/targetHttpsProxies?returnPartialSuccess=true&fields=items/*/targetHttpsProxies/name,items/*/targetHttpsProxies/sslPolicy';
