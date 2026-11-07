// SPDX-License-Identifier: Apache-2.0
// [BACKUP-V1] The VM backup subsystem (bk*): create / list / verify / restore of the fleet backups
// in the backup bucket, driven by ops/backup/*.sh via the ops-exec root daemon. Extracted VERBATIM
// from index.ts; BK_* consts stay private. Deps come from sibling mods — no import of index.ts.
// [BACKUP-CRYPT-V1] Archives are plain fleet-backup-*.tar.gz unless /etc/fleet/backup.env sets
// BACKUP_ENCRYPT_SECRET (the v21 OSS installer does), then fleet-backup-*.tar.gz.gpg (gpg AES256,
// passphrase in that Secret Manager secret). fleet-restore.sh decrypts automatically, so verify and
// restore just pass the object name through. The bucket is the one the script uploads to: the row's
// oa.backups.bucket, else BACKUP_BUCKET (env, then backup.env), else the production default.
import { getStorage } from 'firebase-admin/storage';
import { opsExecRoot } from './ops-exec.js';
import { harJournalAs } from './journal.js';
import { harPgQuery } from './gcp-api.js';

const BK_BUCKET_DEFAULT = 'your-project-id-backups';
const BK_ENV_FILE = '/etc/fleet/backup.env';
const BK_SCRIPT = '/srv/fleet/src/ops/backup/fleet-backup.sh';
const BK_RESTORE = '/srv/fleet/src/ops/backup/fleet-restore.sh';
const BK_OBJ_RE = /^fleet-backup-[0-9A-Za-z._-]+\.(tar\.gz|tgz|tar\.zst|tar\.gz\.gpg|tar\.zst\.gpg)$/;
const BK_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,220}$/;  // a GCS bucket / Secret Manager secret name, nothing else
// KEY=VALUE pairs of /etc/fleet/backup.env (the same file fleet-backup.sh sources). Missing file -> {}.
export function bkEnvFile(path?: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = '';
  try { raw = require('fs').readFileSync(path || BK_ENV_FILE, 'utf8'); } catch (e) { return out; }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?([^"'\s#]*)["']?\s*(?:#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export function bkBucket(): string {
  const b = String(process.env.BACKUP_BUCKET || bkEnvFile().BACKUP_BUCKET || '');
  return BK_NAME_RE.test(b) ? b : BK_BUCKET_DEFAULT;
}
// Whether NEW backups will be encrypted, and with which secret (its NAME only -- never the value).
export function bkEncryption(): { enabled: boolean; secret: string | null } {
  const s = String(bkEnvFile().BACKUP_ENCRYPT_SECRET || '');
  return /^[A-Za-z0-9_-]{1,255}$/.test(s) ? { enabled: true, secret: s } : { enabled: false, secret: null };
}
export function bkIsEncrypted(object: string): boolean { return /\.gpg$/.test(String(object || '')); }
async function bkBucketOf(object: string): Promise<string> {
  try {
    const r: any = await harPgQuery("select bucket from oa.backups where object='" + object + "' and bucket is not null order by created_at desc limit 1", 1);
    const b = String((r && r.rows && r.rows[0] && r.rows[0].bucket) || '');
    if (BK_NAME_RE.test(b)) return b;
  } catch (e) { /* fall through */ }
  return bkBucket();
}
export async function bkSignedUrl(object: string, bucket?: string): Promise<string> {
  const [url] = await getStorage().bucket(bucket || bkBucket()).file(object).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 24 * 3600 * 1000 });
  return url;
}
export function bkStagePass(prefix: string, pass: string): string {
  const pf = '/var/tmp/.' + prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  require('fs').writeFileSync(pf, pass, { mode: 0o600 });
  return pf;
}
export async function bkStart(scope: string, pass: string, by: string): Promise<any> {
  const sc = (scope === 'core') ? 'core' : 'full';
  const id = 'bk_' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 6);
  const cleanBy = String(by || 'operator').replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64) || 'operator';
  let passEnv = '';
  // pass is ignored: the archive is plain .tar.gz, or -- when backup.env sets BACKUP_ENCRYPT_SECRET --
  // .tar.gz.gpg with the passphrase the script reads from Secret Manager itself (never passed from here).
  const cmd = "setsid bash -c '" + passEnv + "BACKUP_SCOPE=" + sc + " BACKUP_ID=" + id + " BACKUP_BY=" + cleanBy + " " + BK_SCRIPT + "' >/dev/null 2>&1 < /dev/null &";
  opsExecRoot(cmd, 15).catch(() => {});
  const enc = bkEncryption();
  harJournalAs(cleanBy, 'backup_create', 'started ' + sc + ' backup ' + id + (enc.enabled ? ' (encrypted .tar.gz.gpg, key secret ' + enc.secret + ')' : ' (plain .tar.gz)'));
  return { ok: true, id, scope: sc, started: true, encrypted: enc.enabled, key_secret: enc.secret, note: 'running in background; poll /api/backup/list for status + download URL' };
}
export async function bkList(): Promise<any> {
  const r: any = await harPgQuery("select id,created_at,scope,status,object,bucket,size_bytes,sha256,error,finished_at,manifest->>'oss_git_sha' as oss_git_sha,manifest->>'key_secret' as key_secret from oa.backups order by created_at desc limit 10", 10);
  const rows = (r && r.rows) || [];
  for (const x of rows) x.encrypted = bkIsEncrypted(x.object);
  let download: any = null;
  const done = rows.find((x: any) => x.status === 'done' && x.object);
  if (done) {
    const bucket = BK_NAME_RE.test(String(done.bucket || '')) ? String(done.bucket) : bkBucket();
    try { download = { id: done.id, object: done.object, scope: done.scope, size_bytes: done.size_bytes, sha256: done.sha256, encrypted: done.encrypted, key_secret: done.encrypted ? (done.key_secret || bkEncryption().secret) : null, url: await bkSignedUrl(done.object, bucket), expires_in_sec: 24 * 3600 }; } catch (e: any) { download = { error: String((e && e.message) || e) }; }
  }
  return { ok: true, backups: rows, download, encryption: bkEncryption() };
}
export async function bkVerify(object: string, pass: string): Promise<any> {
  if (!BK_OBJ_RE.test(object)) return { ok: false, error: 'bad object name' };
  let pe = ''; if (pass) { const pf = bkStagePass('rvpass', pass); pe = 'BACKUP_PASSFILE=' + pf + ' '; }
  const r = await opsExecRoot(pe + BK_RESTORE + " --archive gs://" + (await bkBucketOf(object)) + "/" + object + " --verify", 800);
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch (e) { return { ok: false, error: 'verify produced no parseable result', stderr: (r.stderr || '').slice(0, 400) }; }
}
export async function bkRestore(object: string, pass: string, comps: string[], confirm: string, by: string): Promise<any> {
  if (!BK_OBJ_RE.test(object)) return { ok: false, error: 'bad object name' };
  if (confirm !== object) return { ok: false, error: 'confirm must equal the exact object name to run a DESTRUCTIVE restore' };
  const flags: string[] = [];
  if (comps.indexOf('db') >= 0) flags.push('--db', 'fleet');
  if (comps.indexOf('config') >= 0) flags.push('--config');
  if (comps.indexOf('secrets') >= 0) flags.push('--secrets');
  if (comps.indexOf('lake') >= 0) flags.push('--lake');
  if (!flags.length) return { ok: false, error: 'no components selected' };
  let pe = ''; if (pass) { const pf = bkStagePass('rspass', pass); pe = 'BACKUP_PASSFILE=' + pf + ' '; }
  const cmd = "setsid bash -c '" + pe + BK_RESTORE + " --archive gs://" + (await bkBucketOf(object)) + "/" + object + " " + flags.join(' ') + " --confirm' >/var/tmp/last-restore.log 2>&1 < /dev/null &";
  opsExecRoot(cmd, 15).catch(() => {});
  harJournalAs(String(by || 'operator'), 'backup_restore', 'started restore of ' + object + ' [' + comps.join(',') + ']');
  return { ok: true, started: true, object, components: comps, note: 'restore running in background; progress in /var/tmp/last-restore.log on the box' };
}
