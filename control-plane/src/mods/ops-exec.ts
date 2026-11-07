// SPDX-License-Identifier: Apache-2.0
// [OPS-EXEC-V1] The control-plane -> on-box ops-exec root daemon (127.0.0.1:8022) client plus the
// OPS_TOKEN that authenticates it. Extracted VERBATIM from index.ts so modules (backup, ...) can
// run privileged box commands without importing index.ts. Self-contained: node http + fs + env,
// no store/shared deps; OPS_TOKEN resolves from env or /etc/fleet/ops-token at load, as before.

// ops-exec fast-shell: token that authenticates the control-plane -> on-box ops-exec (:8022).
// Same value lives in the box's `ops-token` instance metadata. Passed as OPS_TOKEN env at deploy.
export const OPS_TOKEN = (() => {
  const _e = process.env.OPS_TOKEN || '';
  if (_e) return _e;
  try { return require('fs').readFileSync('/etc/fleet/ops-token', 'utf8').trim(); } catch (_x) { return ''; }
})();
// [VMCP-SUDO-V1] control-plane -> on-box ops-exec root daemon (127.0.0.1:8022: runs bash -lc as
// root, returns {exit,stdout,stderr}). Localhost Node http, no proxy. OPS_TOKEN authenticates us.
export async function opsExecRoot(cmd: string, timeoutSec: number): Promise<{ exit: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    try {
      const http = require('http');
      const data = Buffer.from(String(cmd), 'utf8');
      const rq = http.request({ host: '127.0.0.1', port: 8022, method: 'POST', path: '/', headers: { 'X-Ops-Token': OPS_TOKEN, 'Content-Type': 'text/plain', 'Content-Length': data.length } }, (res: any) => {
        let buf = '';
        res.on('data', (d: any) => { buf += d.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve({ exit: res.statusCode || 500, stdout: '', stderr: 'ops-exec HTTP ' + res.statusCode + ': ' + buf.slice(0, 2000) }); return; }
          try { const j = JSON.parse(buf); resolve({ exit: Number(j.exit), stdout: String(j.stdout || ''), stderr: String(j.stderr || '') }); }
          catch (_j) { resolve({ exit: 500, stdout: '', stderr: 'ops-exec bad json: ' + buf.slice(0, 2000) }); }
        });
      });
      rq.on('error', (e: any) => resolve({ exit: 500, stdout: '', stderr: 'ops-exec connect error: ' + String((e && e.message) || e) }));
      rq.setTimeout((timeoutSec + 20) * 1000, () => { try { rq.destroy(); } catch (_d) {} resolve({ exit: 504, stdout: '', stderr: 'ops-exec client timeout' }); });
      rq.write(data); rq.end();
    } catch (e: any) { resolve({ exit: 500, stdout: '', stderr: 'ops-exec exception: ' + String((e && e.message) || e) }); }
  });
}
