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
// [SEC-ONE-SCANNER-V2] node:crypto is a BUILTIN. This file stays
// builtins-only on purpose -- the build image is node:24-slim with no npm at
// this step -- and source_sha256 below must not be the thing that breaks that.
import { createHash } from 'node:crypto';

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
//
// [SEC-ROUTE-BLANKER-REGEX-V2] The scanner above tracked ' " ` and NOTHING ELSE, so a REGEX
// LITERAL containing a quote desynchronised it. index.ts:2209 is `return /...(-X\s*['"]?(DELETE
// |PUT)\b)|(--request[\s=]+['"]?(DELETE|PUT)\b).../i.test(cmd)` -- two ['"] character classes,
// four quote characters. The scanner is not in a string when it reaches them, so the first `'`
// OPENED one, the second `'` closed it, and the `"` at column 687 opened a double-quoted state
// that ran 41 lines to a `"` inside prose on line 2250. From there the parity never recovered:
// apostrophes in comment prose kept re-opening it, and 406 comment lines (2216-3691) were never
// blanked. SEVEN of them name a guard token, so in that whole region a guard mentioned in PROSE
// marked a handler guarded -- exactly the hole [SEC-ROUTE-VISIBILITY-V1] closed, reopened by a
// different mechanism. The MIRROR defect was live too: `/\//` at index.ts:5517 (an escaped slash
// inside a regex) was read as `//` and the rest of that REAL CODE LINE was erased -- the same bug
// deleting a guard call instead of preserving prose.
//
// THE OLD SELF-CHECK COULD NOT CATCH EITHER, and that is the lesson worth keeping: blankComments
// only ever assigns ' ' into slots of an array built by src.split(''). It never inserts or
// deletes, so CODE.length === SRC.length is a TAUTOLOGY, not a check. The blanker preserves
// LENGTH while corrupting STATE. A self-check has to assert something about the state.
//
// THE FIX IS THE STANDARD PRECEDING-TOKEN HEURISTIC, chosen over the two alternatives. A real
// tokenizer is not available: the build image is node:24-slim with no npm at this step, this file
// is deliberately Node-builtins-only, and index.ts is TYPESCRIPT, so a JS tokenizer would reject
// its type annotations anyway. Hard-failing on suspected desync is necessary but not sufficient
// on its own -- these regexes are legitimate and the gate would refuse every build. So we do
// BOTH: recognise regex literals, and hard-fail if the scanner still loses sync.
//
// IT IS CONSERVATIVE BY CONSTRUCTION. When the previous significant token is ambiguous -- `)`,
// `]`, `}`, an identifier, a number, `++`, `--` -- we choose DIVISION, the old behaviour. A regex
// literal cannot span a newline, so if the scan for the closing `/` hits one we were wrong and
// fall back to division. Guessing wrong costs nothing when the literal holds no quote, and when
// it does hold one the desync check below turns it into a LOUD REFUSAL rather than a silent
// mis-blanking. Measured on index.ts at 75a250cc: 72 regex literals recognised (all preceded by
// `(` `!` `=` `>` `:` `&` `,` or `return`) and 22 slashes left as division (all genuine
// arithmetic -- `t.length / 4`, `OPS_WINDOW_MS / 3600000`, `Math.floor(n / 2)` ...), with zero
// misclassifications in either direction.
const REGEX_OK_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);
// Can a '/' at this point START a regex literal? Only in expression position. Anything that could
// be the END of a value -- identifier, number, ) ] } string, ++ -- -- means division.
function regexCanStart(prev, prev2) {
  if (prev === '') return true;                                  // start of file
  if (/^[A-Za-z_$]/.test(prev)) return REGEX_OK_KEYWORDS.has(prev);
  if (/^[0-9]/.test(prev)) return false;
  if (prev === ')' || prev === ']' || prev === '}') return false;
  if (prev === "'" || prev === '"' || prev === '`') return false;
  if ((prev === '+' && prev2 === '+') || (prev === '-' && prev2 === '-')) return false;
  return true;
}
function blankComments(src, problems) {
  const a = src.split('');
  const n = src.length;
  const lineAt = (off) => { let L = 1; for (let k = 0; k < off; k++) if (src[k] === '\n') L++; return L; };
  const spans = [];          // [start,end) of every string / template / regex literal, for SELF-CHECK 4
  let i = 0, prev = '', prev2 = '';
  const push = (t) => { prev2 = prev; prev = t; };

  while (i < n) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {                        // line comment
      while (i < n && src[i] !== '\n') { a[i] = ' '; i++; }
      continue;                                                   // a comment is not a token: prev stands
    }
    if (c === '/' && src[i + 1] === '*') {                        // block comment
      const s = i; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= n) problems.push('unterminated /* block comment opened at line ' + lineAt(s));
      i += 2;
      for (let j = s; j < i && j < a.length; j++) if (a[j] !== '\n') a[j] = ' ';
      continue;
    }
    if (c === "'" || c === '"') {                                 // string literal
      // A ' or " string CANNOT contain an unescaped newline. That is a hard language invariant,
      // which makes reaching one PROOF that the scanner has lost sync -- see SELF-CHECK 2.
      const s = i; let j = i + 1, closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === c) { j++; closed = true; break; }
        j++;
      }
      if (!closed) problems.push('a ' + c + '-quoted string opened at line ' + lineAt(s) +
        ' is still open at the end of that line -- the scanner has LOST SYNC');
      spans.push([s, j]); i = j; push(c); continue;               // resync at the newline, never swallow the file
    }
    if (c === '`') {                                              // template literal
      const s = i; let j = i + 1, closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '`') { j++; closed = true; break; }
        j++;
      }
      if (!closed) problems.push('unterminated template literal opened at line ' + lineAt(s));
      j = closed ? j : n;
      spans.push([s, j]); i = j; push('`'); continue;
    }
    if (c === '/' && regexCanStart(prev, prev2)) {                // regex literal
      let j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }                     // \/ and \[ never delimit
        if (d === '\n') break;                                    // regexes cannot span lines: not a regex
        if (inClass) { if (d === ']') inClass = false; j++; continue; }
        if (d === '[') { inClass = true; j++; continue; }         // / inside [...] is literal
        if (d === '/') { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src[j])) j++;                // flags
        // A regex is a literal too: `/\//g` really does contain a `//`, so record its span or
        // SELF-CHECK 4 reports its own scanner's correct output as a survivor.
        spans.push([i, j]); i = j; push('/regex/'); continue;
      }
      // not a regex after all -- fall through and treat as division
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; push(src.slice(i, j)); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < n && /[\w.]/.test(src[j])) j++; push(src.slice(i, j)); i = j; continue; }
    push(c); i++;
  }
  return { code: a.join(''), spans };
}

const BLANK_PROBLEMS = [];
const { code: CODE, spans: LITERAL_SPANS } = blankComments(SRC, BLANK_PROBLEMS);

// SELF-CHECK 1 (structural). Kept, but it is very nearly a tautology -- the blanker only writes
// ' ' into existing slots -- and it demonstrably did NOT catch [SEC-ROUTE-BLANKER-REGEX-V2].
if (CODE.length !== SRC.length) {
  console.error('ROUTE AUDIT: comment blanking changed the file length. Refusing to guess.');
  process.exit(2);
}
// SELF-CHECK 2 + 3 (THE REAL ONES). A ' or " string reaching an unescaped newline, an unterminated
// template literal, or an unterminated block comment each PROVE the scanner is no longer where it
// thinks it is. Once that is true every later verdict is worthless, so the gate REFUSES rather
// than reporting a number nobody can trust. This is the check that fires on the pre-fix scanner.
if (BLANK_PROBLEMS.length) {
  console.error('ROUTE AUDIT: comment blanking LOST SYNC in ' + BLANK_PROBLEMS.length + ' place(s):');
  for (const p of BLANK_PROBLEMS.slice(0, 10)) console.error('    ' + p);
  console.error('  A desynchronised blanker leaves real comments unblanked, so a guard token in');
  console.error('  PROSE can mark an unguarded handler as guarded. Refusing to report a verdict.');
  process.exit(2);
}
// SELF-CHECK 4 (plausibility). Blanking that produces no change at all on a file this commented
// is broken, and after a correct pass no // or /* may survive OUTSIDE a string or template.
const inLiteral = (off) => { for (const [s, e] of LITERAL_SPANS) if (off >= s && off < e) return true; return false; };
if (CODE === SRC) {
  console.error('ROUTE AUDIT: comment blanking changed NOTHING. The blanker is broken.');
  process.exit(2);
}
const stray = [];
for (let i = 0; i < CODE.length - 1; i++) {
  if (CODE[i] !== '/') continue;
  if (CODE[i + 1] !== '/' && CODE[i + 1] !== '*') continue;
  if (inLiteral(i)) continue;
  let L = 1; for (let k = 0; k < i; k++) if (SRC[k] === '\n') L++;
  stray.push('line ' + L + ': ' + SRC.slice(i, i + 60).split('\n')[0]);
  if (stray.length > 10) break;
}
if (stray.length) {
  console.error('ROUTE AUDIT: ' + stray.length + ' comment opener(s) survived blanking outside any string:');
  for (const s of stray) console.error('    ' + s);
  process.exit(2);
}

// Any call that establishes who the caller is, or bounds what they can do.
const GUARDS = [
  'waSessionOk', 'assertIdentity', 'waGate', 'waElevatedOk', 'oaBearerRole',
  'waEnrollTokenOk', 'bootstrapSecret', 'WA_BOOTSTRAP_SECRET',
  'rlCheck', 'checkLockout', 'oaGet(\'oauth_clients\'',
  // [PCGIT-ARCHIVE-V1] GET /git/archive is guarded by a Google-signed service-account ID
  // token, audience-pinned and allowlisted. Recorded here as a guard rather than listed
  // public, because it IS one -- and recorded at all because a genuinely new guard that
  // the audit cannot see would make its route read as newly unauthenticated and fail the
  // build for the wrong reason.
  'pcArchiveCaller',
  // [PCGIT-LANE-SYNC-V1] POST /git/sync's guard, added for exactly the reason the
  // pcArchiveCaller note above gives. It resolves a session key through pcSessionLookup and
  // then requires BOTH the read and write tool classes, so it is a real guard -- and a real
  // guard the scanner cannot see makes its route read as newly unauthenticated and fails the
  // build for the wrong reason.
  'pcSyncCaller',
  // [OSS-IAPAUTH-V54] Two names, added for exactly the reason the pcArchiveCaller note above
  // gives, and NOT to quiet a failure. POST /oauth/authorize/complete has always been guarded;
  // what the audit used to SEE was its inline oaGet('oauth_clients' call, and that call moved
  // into the shared oaMintAndRedirect() when the IAP, Google and key branches were merged onto
  // one mint path. The route did not become less guarded -- the guard the scanner recognised
  // moved one function away. oaAllowed() is the real check on both identity branches: it
  // resolves the live allowed-account list and fails closed on an empty one.
  'oaAllowed',
  // POST /oauth/authorize/key is guarded by a constant-time comparison against the connector
  // secret, after a Firestore-backed rate limit that refuses when the limiter is unreachable.
  // THE TOKEN IS THE CALL, NOT THE ENV VAR NAME, AND THAT IS NOT A STYLE CHOICE: 'PC_CONNECT_SECRET'
  // was tried first and it silently flipped POST /oauth/register to guarded, because this
  // scanner blanks COMMENTS but not STRING LITERALS, and an unrelated user-facing message
  // naming that variable happened to fall inside the slice the scanner reads as /oauth/register's
  // body. A guard token that can appear in prose will eventually mark the wrong route guarded,
  // which is the exact erosion this file exists to prevent. Match on code that cannot be prose.
  'waSha(supplied)',
  // [PCGIT-UPLOAD-V1] POST /git/blob is guarded by the agent session key, resolved by the
  // SAME pcSessionLookup every tool call goes through. Recorded here for the same reason
  // pcArchiveCaller is: a real guard the audit cannot see makes its route read as newly
  // unauthenticated and fails the build for the wrong reason.
  'pcUploadCaller',
  // [SEC-CI-PRODUCE-V1] POST /ci/produce is guarded by pcCiPushCaller, which verifies a
  // Google-signed OIDC push token from the Pub/Sub subscription: a three-segment shape
  // check before anything is forwarded, then tokeninfo, then email === PC_CI_PUSH_SA,
  // email_verified, and aud === this exact route URL. Recorded here for the same reason
  // pcArchiveCaller and pcUploadCaller are: a real guard this scanner cannot see would
  // make the route read as newly unauthenticated and fail the build for the wrong reason.
  'pcCiPushCaller',
  // [PCLAKE-BLOB-V1] POST /lake/blob and GET /lake/blob are guarded by pcLakeBlobCaller,
  // which resolves the agent session key through the SAME pcSessionLookup every tool call
  // goes through AND additionally narrows on tool CLASSES -- 'write' for the upload, 'read'
  // for the download -- so a key that cannot call put_file cannot write the lake at the door
  // instead. Recorded here for the reason pcArchiveCaller and pcUploadCaller are: a real
  // guard this scanner cannot see makes its route read as newly unauthenticated and fails
  // the build for the wrong reason.
  //
  // AND FOR A SECOND REASON THIS FILE PREDICTED. Before this line existed, GET /lake/blob
  // already scanned as GUARDED -- not on its own merit, but because the slice read as its
  // handler body runs to the next top-level registration and swept up the neighbouring
  // `async function oaBearerRole` declaration, and 'oaBearerRole' is a guard token. That is
  // [SEC-ROUTE-VISIBILITY-V1] and the waSha(supplied) note above, live, on a route added
  // today: a genuinely unguarded route in that position would have scanned green. Naming the
  // real guard makes the verdict true rather than lucky.
  'pcLakeBlobCaller',
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

// A registration this audit CANNOT SEE is worse than one that is missing: its handler is never
// searched for a guard, so the guard could be deleted and nothing here would report it. That was
// live at head -- GET /api/cowork-prompt sat indented inside a try{} and was invisible. Indenting
// a route into an if, a try, or any block is therefore a hard failure, not a silent one-route
// drift in the totals. Run over CODE so that PROSE about app.get() can never brick the build.
//
// [SEC-ONE-SCANNER-V2] COMPUTED HERE, ABOVE --emit-table, because it is now EMITTED and not
// merely printed. It used to sit below, next to the failure it raises. That was fine while the
// only consumer was this process; it is not fine now that pipeline/collect-evidence.py has no
// scanner of its own and smoke F7.3 ("every registration is VISIBLE to route-audit.mjs",
// devgate/smoke.py:1758) has nothing else to read. Moving the COMPUTATION changes no verdict --
// `hidden` is derived from CODE and `found`, both already final at this point -- and the
// FAILURE stays exactly where it was, so failure ordering is unchanged.
const HIDDEN = /(?<![\w.$])app\.(get|post|put|delete|patch|all|use)\(\s*(['"`])([^'"`]+)\2/;
const hidden = [];
CODE.split('\n').forEach((line, i) => {
  const hm = HIDDEN.exec(line);
  if (hm && hm.index !== 0) hidden.push('line ' + (i + 1) + ': ' + hm[1].toUpperCase() + ' ' + hm[3]);
});

// [SEC-ONE-SCANNER-V3] server.registerTool('<name>') CALL SITES -- THE LAST THING THE
// COLLECTOR STILL SCANNED FOR ITSELF. pipeline/collect-evidence.py kept a python port of
// blankComments() alive for exactly ONE caller, its scan_tools(); that port and its four
// self-checks are deleted in the same commit as this line, so smoke F2.1's
// source.registered_tools (devgate/smoke.py:823) is now read from the `tools` key below.
// The pattern is the CHARACTER EQUIVALENT of the RE_REGISTER_TOOL it replaces.
//
// IT RUNS OVER CODE, NOT SRC, AND THAT IS THE WHOLE REASON THIS BELONGS IN THIS FILE. The
// blanked view is already computed above for the route scan and is already proven sane by
// SELF-CHECKS 1-4, so the protection against PROSE naming registerTool is INHERITED here
// rather than re-implemented -- which is what made the python copy worth DELETING instead
// of worth maintaining. Measured at this commit over index.ts: blanked and raw scanning
// agree exactly, 45 names either way, delta zero.
//
// Plain `.sort()` -- code-unit order, never localeCompare -- for the same reason the table
// sort below says so: the consumer sorted these in python and the two must agree.
const RE_TOOL = /registerTool\(\s*['\"]([A-Za-z0-9_]+)['\"]/g;
const tools = [...new Set([...CODE.matchAll(RE_TOOL)].map((t) => t[1]))].sort();

// [SEC-ROUTE-F71-REPORT-V1] --emit-table=<path> writes the FULL table -- every
// method+path with its guarded verdict -- so that pipeline/collect-evidence.py's port
// of blankComments() can be checked against this one BY A MACHINE instead of being
// trusted to have been copied correctly. That port DID drift: it was written from the
// pre-[SEC-ROUTE-BLANKER-REGEX-V2] blanker, so it read the word oaBearerRole out of a
// COMMENT and called POST /api/jobs/fire guarded, reporting 85/70/15 against this
// file's 85/69/16 on every run since f68f7a36 -- a guaranteed false red in smoke F7.1.
//
// [SEC-ONE-SCANNER-V2] THE PORT IS GONE AND THIS IS NO LONGER A CROSS-CHECK: IT IS THE
// ONLY MEASUREMENT. collect-evidence.py's scan_routes() has been deleted, so nothing
// anywhere else scans index.ts for routes. Every route field in the evidence bundle --
// smoke F7.1's counts, F7.2's partition, F7.3's visibility check, F2.5's public-route
// set -- is now rebuilt from THIS file. Cross-checking two implementations was the
// emergency repair for the drift above; deleting one of them is the fix.
//
// TWO FIELDS ARE NEW BECAUSE THE CONSUMER LOST ITS OWN COPY OF THEM.
//   hidden         smoke F7.3 asserts that no registration is indented out of reach of
//                  the column-zero regex. The python used to compute that itself. It
//                  cannot now, and inferring "the table exists, therefore the audit
//                  passed its hidden check, therefore hidden is empty" is an inference
//                  across two build steps rather than a measurement. So it is emitted.
//   source_sha256  the ONLY thing tying this table to the index.ts the collector read.
//                  With the port gone there is no second reading of the source to
//                  disagree with a stale or foreign table, and a table for the WRONG
//                  index.ts is worse than none: it is a confident wrong answer. The
//                  collector re-hashes its own bytes and refuses on a mismatch.
//
// THE THREE COUNTS ARE NOT THE CONTRACT. Two readers can agree on 84/69/15 and
// disagree about WHICH route is public. Only the full table catches that, so the full
// table is what is emitted, and the counts are recorded for a human.
//
// EMITTED HERE, BEFORE the wildcard / connector / hidden / baseline checks, so a build
// that is about to FAIL still leaves a table to compare against. A parity check that
// stops running exactly when the audit gets interesting is not a parity check -- and
// that mattered more, not less, once the table became the only source: a red audit
// still hands the collector something true to report.
const emitArg = process.argv.find((x) => x.startsWith('--emit-table='));
if (emitArg) {
  const emitPath = emitArg.slice('--emit-table='.length);
  if (!emitPath) {
    console.error('ROUTE AUDIT: --emit-table= was given with no path.');
    process.exit(2);
  }
  const rowKey = (r) => r.method + ' ' + r.path;
  const table = found.map((r) => ({ method: r.method, path: r.path, guarded: r.guarded }));
  // Plain codepoint ordering, never localeCompare: the consumer sorts in python and the
  // two must agree byte for byte regardless of the build image's locale.
  table.sort((x, y) => (rowKey(x) < rowKey(y) ? -1 : rowKey(x) > rowKey(y) ? 1 : 0));
  // Hashed as UTF-8 TEXT, not as the raw buffer, because the consumer reads its copy
  // with encoding='utf-8' and hashes the decoded string's UTF-8 bytes. Hashing the
  // buffer here would disagree on any file carrying a BOM for no benefit.
  const sourceSha256 = createHash('sha256').update(SRC, 'utf8').digest('hex');
  writeFileSync(emitPath, JSON.stringify({
    note: 'route-audit.mjs full route table -- THE route measurement for pipeline/collect-evidence.py, which has no scanner of its own [SEC-ONE-SCANNER-V2]. Counts are a convenience; `table` is the contract. `hidden` is smoke F7.3\'s input. `source_sha256` ties this table to the exact index.ts it was cut from. `tools` is smoke F2.1\'s input -- registerTool call sites in the comment-blanked source, which is a SOURCE scan and therefore cannot see the git_* tools gittools.js registers at runtime through registerGitTools(), so their absence from this list is expected and is not a finding [SEC-ONE-SCANNER-V3].',
    source: srcPath,
    source_sha256: sourceSha256,
    total: found.length,
    guarded: guardedRoutes.length,
    public: publicRoutes.length,
    hidden,
    tools,
    table,
  }, null, 2) + '\n');
  console.log('  table EMITTED to ' + emitPath + ' (' + found.length + ' routes, ' +
              hidden.length + ' hidden, source sha256 ' + sourceSha256.slice(0, 12) + ')');
}

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

// THE HIDDEN SCAN ITSELF IS HOISTED ABOVE --emit-table (see [SEC-ONE-SCANNER-V2] there);
// only the FAILURE stays here, so the order in which this audit reports failures --
// wildcards, then connector routes, then hidden registrations -- is exactly what it was.
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

// [SEC-ROUTE-VANISH-ANY-V1] WRITING A BASELINE NEVER PRODUCES A PASS.
//
// This block used to exit 0. That made `--write-baseline` a way for a build to RE-MEASURE
// its own gate and then report success in the same run: whatever had just disappeared was
// recorded as the new truth and the audit printed nothing about it. A gate that can bless
// itself is not a gate. It writes, it prints exactly what it wrote, and it FAILS -- the same
// property PC_LEAK_BASELINE_WRITE has in oss/gen.py, which writes the measured leak table
// and then fails the cut so a contaminated tree cannot be laundered inside it.
//
// IT IS ALSO NOT A MERGE. It emits `note`, `generated_from`, `public` and `registered` and
// NOTHING ELSE, so every hand-written key in the committed file -- the dated change log in
// `note`, the whole `surface_split` block smoke.py compares against -- is DESTROYED by it.
// That is another reason it must not be the way a route removal is recorded: read the diff
// before you keep one byte of what this produced.
if (writeBaseline) {
  writeFileSync(basePath, JSON.stringify({
    note: 'Routes that are PUBLIC (no auth guard found in the handler) as of the commit that created this file. A NEW public route not listed here fails the build. Removing an entry here is how you assert a route has been given a guard. Adding one is a deliberate decision to ship a public route -- say why in the commit message. `registered` is EVERY route the audit can see, public and guarded alike: a route that leaves it without leaving this file in the same commit fails the build. Removing a line from `registered` is how a deliberate route deletion is recorded.',
    generated_from: srcPath,
    public: publicRoutes,
    registered: [...new Set(all)].sort(),
  }, null, 2) + '\n');
  console.log('  baseline WRITTEN to ' + basePath + ' with ' + publicRoutes.length +
              ' public routes and ' + new Set(all).size + ' registered routes');
  for (const p of publicRoutes) console.log('      public: ' + p);
  console.error('');
  console.error('ROUTE AUDIT FAIL: a baseline was WRITTEN this run (--write-baseline), so this');
  console.error('  run does NOT pass. Re-measuring the gate is not the same act as passing it.');
  console.error('  Review the file that was just written -- it does not carry the change log or');
  console.error('  the surface_split block the committed one does -- put back what it dropped,');
  console.error('  commit it, and re-run WITHOUT --write-baseline.');
  process.exit(1);
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

// [SEC-ROUTE-VANISH-ANY-V1] A GUARDED ROUTE CAN DISAPPEAR TOO, AND THAT USED TO BE FREE.
//
// The check above ran over baseline.public, so it could only notice the loss of a route the
// baseline had listed as PUBLIC -- 16 of 85 at the commit that added this. Delete the whole
// registration of a GUARDED route and every count moved (85/69/16 -> 84/68/16), no list the
// audit read had ever named it, and the build PASSED. Measured, not assumed: deleting
// GET /api/models exited 0 and printed ROUTE AUDIT PASS, while deleting GET /dash on the same
// tree exited 1. Sixty-nine routes could be lost in a merge without a word.
//
// WHAT THE BASELINE NOW RECORDS, AND WHY IT IS THIS AND NOT SOMETHING ELSE. `registered` is
// the flat, sorted set of METHOD PATH keys for EVERY route the audit can see. Not a count: a
// count cannot name the route that went, which is the only output worth printing, and it is
// satisfied by any swap -- lose one route, add another, the total is unchanged. This file's
// own [SEC-ROUTE-F71-REPORT-V1] block already says it: two scanners can agree on 85/69/16 and
// disagree about WHICH route is which, so the SET is the contract and the count is a
// convenience. Not the guarded verdict either: guard loss is already a hard failure through
// `public` (a route that loses its guard becomes a NEW public route), guard GAIN is a
// deliberate non-failure printed as 'now guarded', and recording the verdict twice would fail
// the build on every legitimate guard addition while giving two sources of truth for one
// fact. And NOT the surface: surface_split's own note rules that this audit parses SOURCE
// before esbuild, knows nothing of which Cloud Run service registers what, and must not be
// taught -- so surface stays in the key this audit provably never reads.
//
// A MISSING LIST IS A REFUSAL, NOT A DEFAULT. `baseline.public || []` is safe because an
// absent public list only ever makes the gate stricter. An absent `registered` list would
// make it VANISH, so a baseline without one cannot be evaluated and this exits 2 like the
// other checks that cannot trust their own inputs.
//
// [SEC-ONE-SCANNER-V1] THERE IS ONE ROUTE SCANNER AND IT IS THIS FILE. It both AUDITS and,
// with --write-baseline, GENERATES. There used to be a second implementation in python --
// control-plane/gen-baseline.py, the generator half for the gate executor, which has
// python3 and no node -- and it is RETIRED. Not because two languages is untidy, but
// because the pair failed in both directions at once:
//   - It never emitted `registered`, so the check immediately below REFUSED any baseline
//     it wrote. It could not do its stated job.
//   - It disagreed with this file about which routes are PUBLIC. It has no blankComments(),
//     so the word oaBearerRole in a COMMENT at src/index.ts:3752 -- prose about the NEXT
//     route -- fell inside the slice it read for POST /api/jobs/fire and marked that
//     handler guarded. Measured side by side: 84/70/14 against this file's 84/69/15. That
//     is [SEC-ROUTE-VISIBILITY-V1] again, in the half that never received the fix.
//   - Its docstring claimed the two were cross-tested on identical input before staging,
//     and that a disagreement meant the build check was dead. Both halves of that were
//     true except the cross-test, which is the half that would have caught it.
// A baseline is regenerated where node exists -- the node:24-slim build image, or a
// workstation -- and --write-baseline deliberately FAILS the run so a human reviews and
// commits what it wrote. Regenerating a gate is not an unattended executor's job, so the
// executor never needed its own copy of this scanner. Do not add one back: a second
// implementation is not a convenience, it is a second opinion this file then has to
// arbitrate, and the arbitration is what nobody was running.
if (!Array.isArray(baseline.registered)) {
  console.error('ROUTE AUDIT: ' + basePath + ' has no "registered" list, so there is nothing to');
  console.error('  compare the live route table against and a route that disappeared would be');
  console.error('  invisible. Refusing to report a verdict rather than reporting a weaker one.');
  console.error('  Generate it with --write-baseline, put back the keys that writer drops, and');
  console.error('  commit it.');
  process.exit(2);
}
const known = new Set(baseline.registered);
const gone = [...known].filter((r) => !registered.has(r)).sort();
const unrecorded = [...registered].filter((r) => !known.has(r)).sort();
const orphanPublic = [...allowed].filter((p) => !known.has(p)).sort();

for (const h of nowGuarded) console.log('  now guarded (was public, still registered): ' + h);

let failed = false;

if (gone.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + gone.length + ' baseline route(s) NO LONGER REGISTERED:');
  for (const v of gone) console.error('    ' + v + (allowed.has(v) ? '   (also listed public)' : ''));
  console.error('');
  console.error('  A route that leaves this list has NOT been given a guard -- it is GONE. That');
  console.error('  is usually a registration indented into a block, renamed, or lost in a merge.');
  console.error('  Guarded or public makes no difference here: both are listed and both fail.');
  console.error('');
  console.error('  IF THE REMOVAL IS DELIBERATE this is not a veto: delete exactly those line(s)');
  console.error('  from the "registered" list in ' + basePath + ' -- and the line(s) marked');
  console.error('  (also listed public) from the "public" list as well -- in the SAME commit and');
  console.error('  say why in the commit message. Do not regenerate the whole baseline to make');
  console.error('  this pass -- that silently blesses every other change in the same breath, and');
  console.error('  --write-baseline now fails the run for exactly that reason.');
  failed = true;
}

if (unrecorded.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + unrecorded.length + ' registered route(s) NOT IN THE BASELINE:');
  for (const u of unrecorded) console.error('    ' + u);
  console.error('');
  console.error('  The disappearance check above is only a ratchet while this list is COMPLETE.');
  console.error('  A route added today and left unrecorded could be dropped tomorrow with');
  console.error('  nothing to compare against, and the gate would erode one route at a time.');
  console.error('  It also catches the opposite accident: a merge that RESURRECTS a route the');
  console.error('  fleet deliberately deleted comes back named, instead of silently.');
  console.error('');
  console.error('  Add exactly those line(s) to the "registered" list in ' + basePath + ' in');
  console.error('  the SAME commit. A route that is also UNGUARDED is named again below and');
  console.error('  needs a line in "public" too: two lists, two lines, one commit.');
  failed = true;
}

if (orphanPublic.length) {
  console.error('');
  console.error('ROUTE AUDIT FAIL: ' + orphanPublic.length + ' entr(y/ies) in "public" are absent');
  console.error('  from "registered" in ' + basePath + ':');
  for (const o of orphanPublic) console.error('    ' + o);
  console.error('');
  console.error('  These two lists are not independent: "public" is the subset of "registered"');
  console.error('  whose handler holds no guard token. An entry in one and not the other is a');
  console.error('  hand-edit that stopped half way, and it matters because the disappearance');
  console.error('  check cannot see a route "registered" does not name. Put the line back in');
  console.error('  "registered", or delete it from "public" too.');
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
console.log('  no baseline route vanished, guarded or public (' + known.size +
            ' recorded, all still registered)');
console.log('  no route registered that the baseline does not record (' + registered.size + ' live)');
console.log('ROUTE AUDIT PASS');
