// SPDX-License-Identifier: Apache-2.0
// [LAKE-LOCAL-V1] Local-disk PLAINTEXT backend for the data lake.
//
// When PC_LAKE_LOCAL_ROOT is set, the agent filesystem (read_file / write_file / list_files /
// wiki / lakeview and the harReadLake / harWriteLake primitives) reads and writes plaintext files
// under that root instead of the vault-sealed GCS bucket. When it is unset, every lake handle is
// the blessed GCS one -- getStorage().bucket(pcLakeBucket()) -- exactly as before, so this module
// is a no-op until the flag is turned on. The flag lets the migration deploy dark and flip cleanly.
//
// Imports node builtins + firebase-admin/storage + ../shared.js ONLY -- never ../index.js.
import * as fs from 'fs';
import * as path from 'path';
import { pcLakeBucket } from '../shared.js';

export function lakeLocalRoot(): string { return String(process.env.PC_LAKE_LOCAL_ROOT || '').trim(); }
export function lakeLocalOn(): boolean { return lakeLocalRoot().length > 0; }

// Owner is cosmetic (a banner on read_file / list_files). On GCS it rode in custom object
// metadata; on local disk we derive it from the path, which is where it came from anyway:
// agents/<role>/... is owned by <role>, shared/... is shared.
function ownerFor(key: string): string {
  const m = /^agents\/([^/]+)\//.exec(key);
  if (m) return m[1];
  if (key.indexOf('shared/') === 0) return 'shared';
  return 'unknown';
}
const CT_BY_EXT: { [k: string]: string } = {
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/plain; charset=utf-8',
  '.css': 'text/css', '.csv': 'text/csv', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
export function ctForPath(key: string): string { return CT_BY_EXT[path.extname(String(key || '')).toLowerCase()] || 'application/octet-stream'; }

// Confine every resolved path to the root. A key with ../ that escapes is rejected rather than
// allowed to read or write outside the lake, the same boundary the GCS bucket gives for free.
function safeJoin(root: string, key: string): string {
  const clean = String(key || '').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('lake-local: path escapes root: ' + String(key));
  return full;
}

class LocalFile {
  root: string; key: string; name: string; metadata: any;
  constructor(root: string, key: string) { this.root = root; this.key = key; this.name = key; this.metadata = {}; }
  async exists(): Promise<[boolean]> {
    try { const p = safeJoin(this.root, this.key); return [fs.existsSync(p) && fs.statSync(p).isFile()]; } catch (e) { return [false]; }
  }
  async download(): Promise<[Buffer]> {
    try { return [fs.readFileSync(safeJoin(this.root, this.key))]; }
    catch (e: any) { const err: any = new Error('lake-local read ' + this.key + ': ' + (e && e.message)); err.code = (e && e.code === 'ENOENT') ? 404 : 500; throw err; }
  }
  async save(body: Buffer | string, _opts?: any): Promise<void> {
    const full = safeJoin(this.root, this.key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = full + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    fs.renameSync(tmp, full); // atomic replace so a concurrent reader never sees a half-written file
  }
  async getMetadata(): Promise<[any]> {
    const full = safeJoin(this.root, this.key);
    let size = 0; let updated = '';
    try { const st = fs.statSync(full); size = st.size; updated = new Date(st.mtimeMs).toISOString(); } catch (e) {}
    return [{ size: size, updated: updated, metadata: { owner: ownerFor(this.key), pcv1_ct: ctForPath(this.key) } }];
  }
}

class LocalBucket {
  root: string;
  constructor(root: string) { this.root = root; }
  file(key: string): LocalFile { return new LocalFile(this.root, key); }
  // Mirrors Bucket.getFiles({prefix}): returns every FILE whose key starts with the prefix.
  async getFiles(opts?: any): Promise<[LocalFile[]]> {
    const prefix = String((opts && opts.prefix) || '').replace(/^\/+/, '');
    const base = path.resolve(this.root);
    const out: LocalFile[] = [];
    const walk = (dir: string) => {
      let ents: fs.Dirent[]; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.isFile()) {
          const key = path.relative(base, fp).split(path.sep).join('/');
          if (prefix && key.indexOf(prefix) !== 0) continue;
          const f = new LocalFile(this.root, key);
          let size = 0; let updated = '';
          try { const st = fs.statSync(fp); size = st.size; updated = new Date(st.mtimeMs).toISOString(); } catch (e2) {}
          f.metadata = { size: size, updated: updated, metadata: { owner: ownerFor(key), pcv1_ct: ctForPath(key) } };
          out.push(f);
        }
      }
    };
    walk(base);
    return [out];
  }
}

let _lb: LocalBucket | null = null;
export function localBucket(): any {
  const root = lakeLocalRoot();
  if (!_lb || _lb.root !== root) _lb = new LocalBucket(root);
  return _lb;
}

// THE lake handle selector. Local shim when the flag is on; otherwise the blessed GCS handle,
// written inline here so [SEC-LAKE-NOGUESS-V1] still sees getStorage().bucket(pcLakeBucket()).
export function lakeBucket(): any {
  if (lakeLocalOn()) return localBucket();
  const { getStorage } = require('firebase-admin/storage');
  return getStorage().bucket(pcLakeBucket());
}
