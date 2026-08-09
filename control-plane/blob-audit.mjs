// SPDX-License-Identifier: Apache-2.0
/*
 * NO BLOBS -- the build gate. Sibling of route-audit.mjs, same contract:
 * it runs as a BUILD STEP before esbuild, so a non-zero exit means no image
 * is produced and nothing can be deployed. It is the only layer of this that
 * a human in a hurry cannot skip.
 *
 * WHY IT EXISTS
 * On 2026-08-02, 402,066 of 711,822 characters of control-plane/src/index.ts
 * were base64 -- 57% of what we publish as source. Four HTML documents inlined
 * as constants. The release leak gate scanned plaintext, so it printed
 * RELEASABLE while the tree carried 7 operator-name occurrences and two
 * operator hostnames inside those blobs, including an ad rail and third-party
 * logo beaconing. It was caught only because a post-deploy check curled the
 * served page and grepped the response.
 *
 * WHAT IT DOES NOT DO, deliberately: it does not ban base64. gate.html carries
 * a legitimate data: URI, the installer runs `openssl rand -base64 32`, and
 * index.ts decodes AGENT_TOKENS_B64 from the environment at runtime. A blanket
 * ban is unsatisfiable, and an unsatisfiable gate gets deleted by whoever hits
 * it next -- which is worse than no gate. This targets ENCODED DOCUMENTS held
 * in string literals, and holds a committed BASELINE so it cannot break
 * today's build; it catches tomorrow's mistake.
 *
 * KNOWN LIMIT, stated so nobody mistakes this for more than it is: it sees
 * single-line runs of >=200 base64 characters. A document split across
 * concatenated literals evades it, and so does a payload small enough to fall
 * under the threshold once compressed. It closes the hole that actually bit
 * us; it is not a general obfuscation gate.
 *
 * Written in Node, not Python, to match route-audit.mjs: the build image is
 * node:24-slim and python3 is not guaranteed to be in it.
 *
 *   node blob-audit.mjs <dir> <baseline.json> [--write-baseline]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2];
const basePath = process.argv[3];
const writeBaseline = process.argv.includes('--write-baseline');

if (!root || !basePath) {
  console.error('usage: node blob-audit.mjs <dir> <baseline.json> [--write-baseline]');
  process.exit(2);
}

const SCAN_EXT = ['.ts', '.js', '.mjs', '.cjs', '.html', '.json', '.md'];

const B64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// Part of a data: URI? Those are legitimate and exempt.
function isDataUri(text, index) {
  const back = text.slice(Math.max(0, index - 120), index);
  return /data:[a-zA-Z0-9.+/-]+;base64,\s*$/.test(back);
}

// What did it decode to? Reported so a failure tells you WHAT was inlined,
// not merely that something long was present.
function describe(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip stream';
  const head = buf.slice(0, 4096).toString('utf8');
  const printable = (head.match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length / Math.max(1, head.length);
  if (printable < 0.85) return 'binary';
  if (/<!DOCTYPE|<html|<body|<div|<script|<svg|<\?xml/i.test(head)) return 'markup document';
  if (/\bfunction\b|=>|\bconst\b|\bclass\b|\bimport\b/.test(head)) return 'source code';
  return 'text';
}

const files = walk(root);
if (files.length === 0) {
  console.error('BLOB AUDIT: scanned zero files. The path is wrong or the walk is.');
  process.exit(2);
}

const found = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  B64_RUN.lastIndex = 0;
  let m;
  while ((m = B64_RUN.exec(text)) !== null) {
    if (isDataUri(text, m.index)) continue;
    const run = m[0];
    let buf;
    try {
      buf = Buffer.from(run, 'base64');
    } catch {
      continue;
    }
    if (buf.length < 64) continue;
    const line = text.slice(0, m.index).split('\n').length;
    found.push({
      file: relative(root, f),
      line,
      chars: run.length,
      kind: describe(buf),
      sha: createHash('sha256').update(run).digest('hex').slice(0, 16),
    });
  }
}

const key = (b) => `${b.file}:${b.sha}`;

if (writeBaseline) {
  writeFileSync(basePath, JSON.stringify({ allowed: found.map(key).sort() }, null, 2) + '\n');
  console.log(`BLOB AUDIT: baseline written with ${found.length} allowed run(s).`);
  process.exit(0);
}

const baseline = existsSync(basePath)
  ? JSON.parse(readFileSync(basePath, 'utf8'))
  : { allowed: [] };
const allowed = new Set(baseline.allowed || []);
const violations = found.filter((b) => !allowed.has(key(b)));

console.log(`BLOB AUDIT: ${files.length} files, ${found.length} long base64 run(s), ${allowed.size} baselined.`);

if (violations.length === 0) {
  console.log('BLOB AUDIT: ok, no new encoded document.');
  process.exit(0);
}

console.error('');
console.error('BLOB AUDIT FAILED -- an encoded document is not source. Ship the file.');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.chars} chars of base64 decoding to ${v.kind}  [${v.sha}]`);
}
console.error('');
console.error('  A scanner that reads plaintext cannot see inside these, so nothing');
console.error('  downstream -- the release leak gate included -- can tell you what is in');
console.error('  them. Write the content to a real file and read it at runtime, the way');
console.error('  index.ts does with pcHtml(). If a run is genuinely legitimate, add it to');
console.error(`  ${basePath} deliberately, with a reason in the commit message.`);
process.exit(1);
