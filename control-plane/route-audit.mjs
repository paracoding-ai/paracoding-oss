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

// Any call that establishes who the caller is, or bounds what they can do.
const GUARDS = [
  'waSessionOk', 'assertIdentity', 'waGate', 'waElevatedOk', 'oaBearerRole',
  'waEnrollTokenOk', 'bootstrapSecret', 'WA_BOOTSTRAP_SECRET',
  'rlCheck', 'checkLockout', 'oaGet(\'oauth_clients\'',
];

const RE = /^app\.(get|post|put|delete|patch|all|use)\(\s*(['"`])([^'"`]+)\2/gm;
const found = [];
let m;
while ((m = RE.exec(SRC)) !== null) {
  found.push({ method: m[1].toUpperCase(), path: m[3], at: m.index });
}
if (found.length === 0) {
  console.error('ROUTE AUDIT: found zero route registrations. The regex is wrong or the file is.');
  process.exit(2);
}
found.sort((a, b) => a.at - b.at);

// A route's handler is everything up to the next top-level registration.
for (let i = 0; i < found.length; i++) {
  const end = i + 1 < found.length ? found[i + 1].at : SRC.length;
  const body = SRC.slice(found[i].at, end);
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
console.log('  no wildcards, all 7 connector routes present');

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
const healed = [...allowed].filter((p) => !publicRoutes.includes(p));

for (const h of healed) console.log('  now guarded (was public): ' + h);

if (novel.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + novel.length + ' NEW route(s) with no auth guard:');
  for (const n of novel) console.error('    ' + n);
  console.error('');
  console.error('  Either add a guard (' + GUARDS.slice(0, 4).join(', ') + ' ...),');
  console.error('  or, if the route is meant to be public, add it to ' + basePath);
  console.error('  in the same commit and say why. Do not regenerate the whole baseline');
  console.error('  to make this pass -- that silently blesses every other new hole too.');
  process.exit(1);
}
console.log('  no new unguarded routes vs baseline (' + allowed.size + ' known public)');
console.log('ROUTE AUDIT PASS');
