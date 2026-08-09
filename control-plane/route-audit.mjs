// SPDX-License-Identifier: Apache-2.0
/*
 * SEC 5 -- the route audit, given a home.
 *
 * The old verifier covered 2 of 3 route files and lived in the harness that is
 * now dead. Everything is one index.ts built by Cloud Build, so this runs as a
 * BUILD STEP: if it exits non-zero the image is never produced and nothing can
 * be deployed.
 *
 * WHAT IT DOES NOT DO, deliberately: it does not try to decide whether a route
 * SHOULD be public. That judgement belongs to a human and a naive version of it
 * would fail the build on every legitimately-public route and brick the deploy
 * pipeline. Instead it holds a committed BASELINE of the routes that are public
 * today, and fails only when a NEW unguarded route appears. It cannot break
 * today's deploy; it catches tomorrow's mistake.
 *
 * Written in Node, not Python, because the build image is node:24-slim and
 * python3 is not guaranteed to be in it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const srcPath = process.argv[2];
const basePath = process.argv[3];
const writeBaseline = process.argv.includes('--write-baseline');

const SRC = readFileSync(srcPath, 'utf8');

// [SEC-ROUTE-VISIBILITY-V1] Guard names are matched against CODE, never prose. A comment 154
// lines below GET /api/cowork-prompt -- describing a DIFFERENT route -- mentioned waSessionOk,
// and that alone was enough to mark the handler guarded. Deleting its real waGate changed
// nothing the audit could see. Comments are therefore blanked to spaces (never deleted, so every
// byte offset and line number below still refers to the real file). Measured: this changes NO
// route's verdict at head -- 88/71/17 either way -- and flips exactly the seeded unguarded
// handler to public, which is the whole point.
function blankComments(src) {
  const a = src.split('');
  let q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { a[i] = ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      const s = i; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      for (let j = s; j <= i && j < a.length; j++) if (a[j] !== '\n') a[j] = ' ';
      continue;
    }
  }
  return a.join('');
}
const CODE = blankComments(SRC);
if (CODE.length !== SRC.length) {
  console.error('ROUTE AUDIT: comment blanking changed the file length. Refusing to guess.');
  process.exit(2);
}

// Any call that establishes who the caller is, or bounds what they can do.
const GUARDS = [
  'waSessionOk', 'assertIdentity', 'waGate', 'waElevatedOk', 'oaBearerRole',
  'waEnrollTokenOk', 'bootstrapSecret', 'WA_BOOTSTRAP_SECRET',
  'rlCheck', 'checkLockout', 'oaGet(\'oauth_clients\'',
];

const RE = /^app\.(get|post|put|delete|patch|all|use)\(\s*(['"`])([^'"`]+)\2/gm;
const found = [];
let m;
while ((m = RE.exec(CODE)) !== null) {
  found.push({ method: m[1].toUpperCase(), path: m[3], at: m.index });
}
if (found.length === 0) {
  console.error('ROUTE AUDIT: found zero route registrations. The regex is wrong or the file is.');
  process.exit(2);
}
found.sort((a, b) => a.at - b.at);

// A route's handler is everything up to the next top-level registration.
for (let i = 0; i < found.length; i++) {
  const end = i + 1 < found.length ? found[i + 1].at : CODE.length;
  const body = CODE.slice(found[i].at, end);
  found[i].guarded = GUARDS.some((g) => body.includes(g));
}

const key = (r) => r.method + ' ' + r.path;
const publicRoutes = found.filter((r) => !r.guarded).map(key).sort();
const guardedRoutes = found.filter((r) => r.guarded).map(key).sort();

console.log('ROUTE AUDIT over ' + srcPath);
console.log('  total routes   : ' + found.length);
console.log('  guarded        : ' + guardedRoutes.length);
console.log('  public         : ' + publicRoutes.length);

// Hard failures that need no baseline.
const wildcards = found.filter((r) => r.path === '*' || r.path.includes('*'));
if (wildcards.length) {
  console.error('ROUTE AUDIT FAIL: wildcard route(s) registered: ' + wildcards.map(key).join(', '));
  console.error('  A catch-all registered before the MCP connector routes would swallow');
  console.error('  /.well-known/*, /oauth/* and /mcp. Do not add one.');
  process.exit(1);
}
const CONNECTOR = ['POST /mcp', 'GET /mcp', 'POST /oauth/token', 'GET /oauth/authorize',
                   'POST /oauth/register', 'GET /.well-known/oauth-protected-resource',
                   'GET /.well-known/oauth-authorization-server'];
const all = found.map(key);
const missing = CONNECTOR.filter((c) => !all.includes(c));
if (missing.length) {
  console.error('ROUTE AUDIT FAIL: MCP connector route(s) missing: ' + missing.join(', '));
  process.exit(1);
}

// A registration this audit CANNOT SEE is worse than one that is missing: its handler is never
// searched for a guard, so the guard could be deleted and nothing here would report it. That was
// live at head -- GET /api/cowork-prompt sat indented inside a try{} and was invisible. Indenting
// a route into an if, a try, or any block is therefore a hard failure, not a silent one-route
// drift in the totals. Run over CODE so that PROSE about app.get() can never brick the build.
const HIDDEN = /(?<![\w.$])app\.(get|post|put|delete|patch|all|use)\(\s*(['"`])([^'"`]+)\2/;
const hidden = [];
CODE.split('\n').forEach((line, i) => {
  const hm = HIDDEN.exec(line);
  if (hm && hm.index !== 0) hidden.push('line ' + (i + 1) + ': ' + hm[1].toUpperCase() + ' ' + hm[3]);
});
if (hidden.length) {
  console.error('ROUTE AUDIT FAIL: ' + hidden.length + ' route registration(s) NOT at column zero:');
  for (const h of hidden) console.error('    ' + h);
  console.error('  This audit is anchored at column zero, so an indented registration is invisible');
  console.error('  to it and its handler is never checked for a guard. Move it to column zero.');
  console.error('  If registration must be conditional, decide INSIDE app.get/app.post the way');
  console.error('  PC_SURFACE_MAP does, never in an if or a try wrapped around the registration.');
  process.exit(1);
}
console.log('  no wildcards, all 7 connector routes present, no hidden registrations');

if (writeBaseline) {
  writeFileSync(basePath, JSON.stringify({
    note: 'Routes that are PUBLIC (no auth guard found in the handler) as of the commit that created this file. A NEW public route not listed here fails the build. Removing an entry here is how you assert a route has been given a guard. Adding one is a deliberate decision to ship a public route -- say why in the commit message.',
    generated_from: srcPath,
    public: publicRoutes,
  }, null, 2) + '\n');
  console.log('  baseline WRITTEN to ' + basePath + ' with ' + publicRoutes.length + ' public routes');
  for (const p of publicRoutes) console.log('      public: ' + p);
  process.exit(0);
}

if (!existsSync(basePath)) {
  console.error('ROUTE AUDIT FAIL: no baseline at ' + basePath + '. Generate it with --write-baseline and commit it.');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(basePath, 'utf8'));
const allowed = new Set(baseline.public || []);
const novel = publicRoutes.filter((p) => !allowed.has(p));
// A baseline entry can leave the public set two ways and they are OPPOSITE in meaning. Either the
// route is STILL REGISTERED and has acquired a guard -- a real improvement -- or it is GONE from
// the table entirely. The old code called both 'now guarded (was public)' and exited 0, so a
// registration that was hidden, renamed or lost in a merge was reported as a security WIN and
// shipped. A check that reads a disappearance as success is worse than no check. The two are told
// apart by the FULL route table, never by the public set.
const registered = new Set(all);
const nowGuarded = [...allowed].filter((p) => !publicRoutes.includes(p) && registered.has(p));
const vanished = [...allowed].filter((p) => !registered.has(p));

for (const h of nowGuarded) console.log('  now guarded (was public, still registered): ' + h);

let failed = false;

if (vanished.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + vanished.length + ' baseline route(s) NO LONGER REGISTERED:');
  for (const v of vanished) console.error('    ' + v);
  console.error('');
  console.error('  These routes are not guarded now -- they are GONE. That is usually a');
  console.error('  registration indented into a block, renamed, or lost in a merge.');
  console.error('');
  console.error('  IF THE REMOVAL IS DELIBERATE this is not a veto: delete exactly those line(s)');
  console.error('  from the "public" list in ' + basePath + ' in the SAME commit and say why in');
  console.error('  the commit message. Do not regenerate the whole baseline to make this pass --');
  console.error('  that silently blesses every other change in the same breath.');
  failed = true;
}

if (novel.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + novel.length + ' NEW route(s) with no auth guard:');
  for (const n of novel) console.error('    ' + n);
  console.error('');
  console.error('  Either add a guard (' + GUARDS.slice(0, 4).join(', ') + ' ...),');
  console.error('  or, if the route is meant to be public, add it to ' + basePath);
  console.error('  in the same commit and say why. Do not regenerate the whole baseline');
  console.error('  to make this pass -- that silently blesses every other new hole too.');
  failed = true;
}

if (failed) process.exit(1);
console.log('  no new unguarded routes vs baseline (' + allowed.size + ' known public)');
console.log('  no baseline route vanished (' + allowed.size + ' checked against the live table)');
console.log('ROUTE AUDIT PASS');
