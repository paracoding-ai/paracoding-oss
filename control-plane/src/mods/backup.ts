// SPDX-License-Identifier: Apache-2.0
// [BACKUP-V1] The VM backup subsystem (bk*): create / list / verify / restore of the plain
// .tar.gz fleet backups in gs://your-project-id-backups, driven by ops/backup/*.sh via the
// ops-exec root daemon. Extracted VERBATIM from index.ts; BK_* consts stay private. Deps come
// from sibling mods — no import of index.ts.
import { getStorage } from 'firebase-admin/storage';
import { opsExecRoot } from './ops-exec.js';
import { harJournalAs } from './journal.js';
import { harPgQuery } from './gcp-api.js';

const BK_BUCKET = 'your-project-id-backups';
const BK_SCRIPT = '/srv/fleet/src/ops/backup/fleet-backup.sh';
const BK_RESTORE = '/srv/fleet/src/ops/backup/fleet-restore.sh';
const BK_OBJ_RE = /^fleet-backup-[0-9A-Za-z._-]+\.(tar\.gz|tgz|tar\.zst|tar\.zst\.gpg)$/;
export async function bkSignedUrl(object: string): Promise<string> {
  const [url] = await getStorage().bucket(BK_BUCKET).file(object).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 24 * 3600 * 1000 });
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
  // plain .tar.gz backup -- no passphrase, no key, no gpg (pass is ignored).
  const cmd = "setsid bash -c '" + passEnv + "BACKUP_SCOPE=" + sc + " BACKUP_ID=" + id + " BACKUP_BY=" + cleanBy + " " + BK_SCRIPT + "' >/dev/null 2>&1 < /dev/null &";
  opsExecRoot(cmd, 15).catch(() => {});
  harJournalAs(cleanBy, 'backup_create', 'started ' + sc + ' backup ' + id + ' (plain .tar.gz)');
  return { ok: true, id, scope: sc, started: true, note: 'running in background; poll /api/backup/list for status + download URL' };
}
export async function bkList(): Promise<any> {
  const r: any = await harPgQuery("select id,created_at,scope,status,object,size_bytes,sha256,error,finished_at,manifest->>'oss_git_sha' as oss_git_sha from oa.backups order by created_at desc limit 10", 10);
  const rows = (r && r.rows) || [];
  let download: any = null;
  const done = rows.find((x: any) => x.status === 'done' && x.object);
  if (done) { try { download = { id: done.id, object: done.object, scope: done.scope, size_bytes: done.size_bytes, sha256: done.sha256, url: await bkSignedUrl(done.object), expires_in_sec: 24 * 3600 }; } catch (e: any) { download = { error: String((e && e.message) || e) }; } }
  return { ok: true, backups: rows, download };
}
export async function bkVerify(object: string, pass: string): Promise<any> {
  if (!BK_OBJ_RE.test(object)) return { ok: false, error: 'bad object name' };
  let pe = ''; if (pass) { const pf = bkStagePass('rvpass', pass); pe = 'BACKUP_PASSFILE=' + pf + ' '; }
  const r = await opsExecRoot(pe + BK_RESTORE + " --archive gs://" + BK_BUCKET + "/" + object + " --verify", 800);
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
  const cmd = "setsid bash -c '" + pe + BK_RESTORE + " --archive gs://" + BK_BUCKET + "/" + object + " " + flags.join(' ') + " --confirm' >/var/tmp/last-restore.log 2>&1 < /dev/null &";
  opsExecRoot(cmd, 15).catch(() => {});
  harJournalAs(String(by || 'operator'), 'backup_restore', 'started restore of ' + object + ' [' + comps.join(',') + ']');
  return { ok: true, started: true, object, components: comps, note: 'restore running in background; progress in /var/tmp/last-restore.log on the box' };
}
