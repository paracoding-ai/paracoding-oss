// SPDX-License-Identifier: Apache-2.0
// [PC-STATUS-V1] /api/status health checks, extracted from index.ts (strangler). The VM-meta cache
// (_pcStatusVm), the timeout/fetch helpers (pcStRace/pcStGcp/pcStGitlab) and the PcStChk type are
// private to this module. Moved verbatim from index.ts; the only change is that db, _SSN/_spg,
// waFetch/waAccessToken/GCP_PROJECT/geConfigured, harSecretGet/harKey and harPgQuery now come from
// sibling mods / ../shared instead of index-local definitions.
import { db } from './store.js';
import { _SSN, _spg } from './collections.js';
import { waFetch, waAccessToken, GCP_PROJECT, geConfigured } from '../shared.js';
import { harSecretGet, harKey } from './secrets-keys.js';
import { harPgQuery } from './gcp-api.js';

let _pcStatusVm: { name: string; zone: string } | null = null;
export async function pcStatusVmMeta(): Promise<{ name: string; zone: string }> {
  if (_pcStatusVm) return _pcStatusVm;
  try {
    const h: any = { 'Metadata-Flavor': 'Google' };
    const n: any = await waFetch('http://metadata/computeMetadata/v1/instance/name', { headers: h });
    const z: any = await waFetch('http://metadata/computeMetadata/v1/instance/zone', { headers: h });
    _pcStatusVm = { name: (await n.text()).trim(), zone: (((await z.text()).trim().split('/').pop()) || '') };
  } catch (e) { _pcStatusVm = { name: 'paracoding-vmcp', zone: 'us-east1-b' }; }
  return _pcStatusVm;
}
export function pcStRace<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return Promise.race([Promise.resolve(p).catch(() => onTimeout), new Promise<T>((res) => setTimeout(() => res(onTimeout), ms))]);
}
export async function pcStGcp(url: string): Promise<any> {
  try {
    const tok = await waAccessToken();
    const r: any = await waFetch(url, { headers: { Authorization: 'Bearer ' + tok } });
    const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch (e) { b = t; }
    return { http: r.status, body: b };
  } catch (e) { return { http: 0, body: null }; }
}
export async function pcStGitlab(pathx: string): Promise<any> {
  try {
    const pat = await harSecretGet('gitlab-api-token');
    const r: any = await waFetch('http://127.0.0.1/gitlab/api/v4' + pathx, { headers: { 'PRIVATE-TOKEN': pat || '' } });
    const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch (e) { b = t; }
    return { ok: r.ok, status: r.status, body: b };
  } catch (e) { return { ok: false, status: 0, body: null }; }
}
type PcStChk = { group: string; name: string; status: string; detail: string };
export async function pcStatusChecks(): Promise<PcStChk[]> {
  const proj = GCP_PROJECT;
  const now = Date.now();
  const ageH = (x: string) => (now - new Date(x).getTime()) / 3600000;
  const vm = await pcStatusVmMeta();
  const z = (u: string) => pcStRace(pcStGcp(u), 9000, { http: 0, body: null });
  const [runR, sinkR, snapR, bakR, vmR] = await Promise.all([
    z('https://run.googleapis.com/v2/projects/' + proj + '/locations/us-east1/services'),
    z('https://logging.googleapis.com/v2/projects/' + proj + '/sinks/mcp-armor-denies'),
    z('https://compute.googleapis.com/compute/v1/projects/' + proj + '/global/snapshots?orderBy=creationTimestamp%20desc&maxResults=25&fields=items(name,creationTimestamp,sourceDisk)'),
    z('https://storage.googleapis.com/storage/v1/b/' + proj + '-backups/o?prefix=vmcp-gitlab-config-backup/&fields=items(name,timeCreated)'),
    z('https://compute.googleapis.com/compute/v1/projects/' + proj + '/zones/' + vm.zone + '/instances/' + vm.name + '?fields=status,machineType'),
  ]);
  const checks: PcStChk[] = [];
  checks.push({ group: 'Core', name: 'Control plane', status: 'up', detail: 'serving' });
  const gl = await pcStRace(pcStGitlab('/version'), 6000, { ok: false, body: null });
  checks.push({ group: 'Core', name: 'GitLab', status: gl.ok ? 'up' : 'down', detail: gl.ok ? ('v' + ((gl.body && gl.body.version) || '?')) : 'unreachable' });
  const fsOk = await pcStRace((_SSN ? _spg.scanSnap(1) : db.collection('strains').limit(1).get()).then(() => true), 6000, false);
  checks.push({ group: 'Core', name: 'Firestore', status: fsOk ? 'up' : 'down', detail: fsOk ? 'reachable' : 'unreachable' });
  const vmStatus = vmR.body && vmR.body.status;
  checks.push({ group: 'Core', name: 'VM (' + vm.name + ')', status: vmStatus === 'RUNNING' ? 'up' : (vmStatus ? 'degraded' : 'unknown'), detail: vmStatus ? (vmStatus + ' · ' + String((vmR.body.machineType || '')).split('/').pop()) : 'unknown' });
  let ips: string[] = ['', '', ''];
  try {
    const dnsP: any = require('dns').promises;
    ips = await pcStRace(Promise.all(['console.example.com', 'mcp.example.com', 'gitlab.paracoding.ai'].map((hn: string) => dnsP.resolve4(hn).then((a: string[]) => a[0]).catch(() => ''))), 6000, ['', '', '']);
  } catch (e) {}
  const okIps = ips.filter((x: string) => x);
  checks.push({ group: 'Edge', name: 'DNS (flowhood/mcp/gitlab)', status: okIps.length === 3 ? 'up' : (okIps.length ? 'degraded' : 'down'), detail: okIps.length ? ('-> ' + okIps[0]) : 'no resolve' });
  const sinkFilter = (sinkR.body && sinkR.body.filter) || '';
  const sinkOk = String(sinkFilter).indexOf('fleet-vm-urlmap') >= 0;
  let _pk: any = { active: 0, perm: 0 };
  try { const _pr: any = await harPgQuery("SELECT count(*) FILTER (WHERE permanent OR until > " + now + ") AS active, count(*) FILTER (WHERE permanent) AS perm FROM picket.bans", 1); const _row = (_pr && _pr.rows && _pr.rows[0]) || {}; _pk = { active: Number(_row.active || 0), perm: Number(_row.perm || 0) }; } catch (e) {}
  checks.push({ group: 'Security / automation', name: 'Picket (edge auto-ban)', status: 'up', detail: 'enforce \u00b7 ' + _pk.active + ' banned' + (_pk.perm ? (' \u00b7 ' + _pk.perm + ' permanent') : '') });
  const runItems: any[] = (runR.body && runR.body.services) || [];
  const runNames = runItems.map((s2: any) => String(s2.name || '').split('/').pop());
  const wkr = runNames.indexOf('vmcp-waker') >= 0;
  checks.push({ group: 'Security / automation', name: 'Wake service (Cloud Run)', status: wkr ? 'up' : 'unknown', detail: wkr ? 'vmcp-waker (min=0)' : 'not found' });
  const runnersR = await pcStRace(pcStGitlab('/runners/all?scope=online'), 6000, { ok: false, body: null });
  const runnersUp = runnersR.ok && Array.isArray(runnersR.body) && runnersR.body.length > 0;
  checks.push({ group: 'Security / automation', name: 'CI runner', status: runnersUp ? 'up' : (runnersR.ok ? 'down' : 'unknown'), detail: runnersUp ? (runnersR.body.length + ' online') : (runnersR.ok ? 'none online' : 'unknown') });
  const pipeR = await pcStRace(pcStGitlab('/projects/1/pipelines?ref=main&per_page=1'), 6000, { ok: false, body: null });
  const lastPipe = pipeR.ok && Array.isArray(pipeR.body) && pipeR.body[0];
  const pipeStatus = lastPipe ? String(lastPipe.status) : '';
  checks.push({ group: 'Security / automation', name: 'Last pipeline (main)', status: (pipeStatus === 'success' || pipeStatus === 'skipped' || pipeStatus === 'manual') ? 'up' : ((pipeStatus === 'running' || pipeStatus === 'pending' || pipeStatus === 'created') ? 'degraded' : (pipeStatus ? 'down' : 'unknown')), detail: pipeStatus || 'unknown' });
  const subs = [['claude', 'Claude'], ['gemini', 'Gemini'], ['deepseek', 'DeepSeek']];
  for (const pr of subs) {
    const k = await pcStRace(harKey(pr[0]).then((x: string) => !!x), 5000, false);
    checks.push({ group: 'Chat substrates', name: pr[1] + ' key', status: k ? 'up' : 'down', detail: k ? 'present' : 'not set' });
  }
  checks.push({ group: 'Chat substrates', name: 'GE seat', status: geConfigured() ? 'up' : 'degraded', detail: geConfigured() ? 'configured' : 'not configured' });
  const bakItems: any[] = (bakR.body && bakR.body.items) || [];
  let newestBak = ''; bakItems.forEach((o: any) => { if (o.timeCreated && o.timeCreated > newestBak) newestBak = o.timeCreated; });
  const bakAge = newestBak ? ageH(newestBak) : null;
  checks.push({ group: 'Backups', name: 'GitLab -> GCS backup', status: bakAge == null ? 'unknown' : (bakAge < 36 ? 'up' : 'degraded'), detail: bakAge == null ? 'none found' : ('last ' + Math.round(bakAge) + 'h ago') });
  const snapItems: any[] = ((snapR.body && snapR.body.items) || []).filter((o: any) => String(o.sourceDisk || '').endsWith('/' + vm.name));
  let newestSnap = ''; snapItems.forEach((o: any) => { if (o.creationTimestamp && o.creationTimestamp > newestSnap) newestSnap = o.creationTimestamp; });
  const snapAgeD = newestSnap ? ageH(newestSnap) / 24 : null;
  checks.push({ group: 'Backups', name: 'VM disk snapshot', status: snapAgeD == null ? 'unknown' : (snapAgeD < 8 ? 'up' : 'degraded'), detail: snapAgeD == null ? 'none found' : ('last ' + Math.round(snapAgeD) + 'd ago') });
  try {
    const _fbR: any = await harPgQuery("select scope, size_bytes, extract(epoch from (now()-finished_at))/3600 as age_h from oa.backups where status='done' and finished_at is not null order by created_at desc limit 1", 1);
    const _fb = _fbR && _fbR.rows && _fbR.rows[0];
    if (_fb) {
      const _ah = Number(_fb.age_h) || 0; const _gb = (Number(_fb.size_bytes) || 0) / 1e9;
      checks.push({ group: 'Backups', name: 'Full-system backup (one-file DR)', status: _ah < 24 * 8 ? 'up' : 'degraded', detail: 'last ' + (_ah < 48 ? (Math.round(_ah) + 'h') : (Math.round(_ah / 24) + 'd')) + ' ago · ' + String(_fb.scope) + ' · ' + _gb.toFixed(1) + 'GB (encrypted)' });
    } else {
      checks.push({ group: 'Backups', name: 'Full-system backup (one-file DR)', status: 'degraded', detail: 'none yet — ask me to create one (backup_create)' });
    }
  } catch (e) { checks.push({ group: 'Backups', name: 'Full-system backup (one-file DR)', status: 'unknown', detail: 'status unavailable' }); }
  return checks;
}
