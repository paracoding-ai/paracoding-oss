// SPDX-License-Identifier: Apache-2.0
// [SEC-DEPERSONALISE-V1] No operator name and no operator hostname in a public
// tree. WA_USER defaults to 'operator'; gate URLs are whatever the installer
// printed, never a host this software does not own.
// [SEC-UV-MAC-V1] WebAuthn user verification is REQUIRED on every ceremony and
// ENFORCED on every verify. A presence tap is not an approval. Credentials
// enrolled before this change without user verification must be re-enrolled.
import express from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as crypto from 'crypto';
// [SEC-DEBLOB-V1] The gate, dash and harness documents are FILES, not base64 constants.
// They are read once at module load. The Dockerfile does `COPY src ./src` and esbuild
// transpiles to dist/index.js, so __dirname is /app/dist and ../src/<f> is /app/src/<f>.
// A missing file throws HERE, at boot: the container never becomes ready and Cloud Run
// keeps the previous revision serving. Fail-closed beats an empty gate page.
import * as fs from 'fs';
import * as path from 'path';
// [EXEC-LONGRUN-V1] Node's own HTTP clients, used by exactly one function in this file
// (waPostLong, beside waCallExec). Global fetch is undici, whose headersTimeout is a fixed
// 300s that no per-call option raises, and Node does not export undici, so a dispatcher means
// reaching through globalThis[Symbol.for('undici.globalDispatcher.1')] -- undocumented, and on
// a path that carries a KMS-signed approval envelope. Two stdlib imports instead. NO new npm
// dependency: `grep -n "^import \* as node"` on this file returns exactly these two lines, and
// package.json is untouched -- both modules are Node stdlib.
import * as nodeHttp from 'http';
import * as nodeHttps from 'https';
const pcHtml = (f: string): string => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
// [MCP2-BOOT-V1] SDK v2 (@modelcontextprotocol/server 2.0.0, a DIFFERENT package from the
// pinned @modelcontextprotocol/sdk 1.29.0 above -- they coexist, no conflict). Loaded here
// only to prove the dependency resolves at boot. It registers nothing and serves nothing;
// every route, buildMcpServer, who() and the OAuth surface are untouched by it.
const { assertMcp2Loadable } = require('./mcp2.js');
// [MCP2026-DUAL-ERA-V1] The MODERN half of the endpoint: revision 2026-07-28. This module
// contains the era router and every byte the modern branch emits. It has NO npm dependency
// of its own -- tools, identity and origin policy are injected -- which is what lets the
// 2026-07-28 conformance harness drive these exact bytes over a local port before they ship.
const { mcp2026IsModernRequest, mcp2026Handle } = require('./mcp2026.js');
import { z } from 'zod';
// ---- passkey/FaceID + god-mode gate: additive imports (injected after the zod import) ----
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

// ---- Paracoding Agentic Harness: additive imports (injected after passkey imports) ----
// VERIFY-GREP: ADS-REMOVED-V1 (operator ruling 2026-07-29: no ads; donations instead)
// (no new npm deps — uses existing waFetch / waAccessToken / db / app / express from base+passkey)
const httpProxy = require('http-proxy');

// ---- Paracoding MCP OAuth: additive imports (injected after harness imports) ----
// Adds a clean, tokenless connector at POST /mcp using OAuth 2.1 (RFC 9728 + 8414 + 7591 + PKCE),
// identity delegated to Google (GIS ID token, no client secret — same pattern as the gate).
// The existing /mcp/:token route is UNTOUCHED and keeps working. Uses base symbols in scope:
// app, express, db, buildMcpServer, McpServer, StreamableHTTPServerTransport, waFetch.
const oaCrypto = require('crypto');


if (getApps().length === 0) {
  initializeApp();
}
// [SEC-NAMED-DB-V1] Never squat on the project's (default) database. Our own named database
// means the installer never touches data it did not create, works in projects already using
// Firestore (including DATASTORE mode), and leaves no guessable name to probe for.
const db = getFirestore(process.env.PC_FIRESTORE_DB || '(default)');

// ==================== [SEC-TTL-CHOKEPOINT-V1] retention stamping, ONE chokepoint ====================
// Firestore TTL is FAIL-OPEN: a document that does not carry the TTL field is NEVER deleted,
// and the console does not say which documents are covered. So the stamp must be impossible
// to forget: it happens HERE, on the CollectionReference/DocumentReference write methods the
// `db` handle above hands out, not at the ~70 individual write sites -- including every write
// site somebody adds later. The getFirestore line above is deliberately untouched.
//
// WHAT IS COVERED: every db.collection(<coll>).add(...), .doc(...).set(...) and
// .doc(...).create(...) on the three retention collections below. That is every creation of
// a journal, chat_history or pending_confirms document in this file (measured at the commit
// that added this block: 45 journal .add + 2 journal .doc().set, 5 chat_history .add +
// 1 chat_history .doc().set, and every pending_confirms .doc().set, including the
// pcExecIngestSweep writes that carry gate-exec's GCS-relayed journal into Firestore).
// WHAT IS NOT, measured not assumed: no WriteBatch and no Transaction in this file CREATES a
// document in these three collections -- batches touch memory-entity and oauth docs, and the
// transactions only .update() pending_confirms documents that were stamped at creation. If
// that ever changes, stamp there too or the new documents are immortal.
// Direct Firestore writers OUTSIDE this process (src/runner/*.py) carry their own stamp --
// see [SEC-TTL-STAMP-V1] in those files. gate-exec holds no Firestore client at all
// ([SEC-EXEC-NO-DATASTORE-V1]); its journal arrives via GCS and pcExecIngestSweep, which
// lands on this chokepoint.
//
// RETENTION (operator parameters, 2026-08): journal 120 days, chat_history 120 days,
// pending_confirms ("terminal jobs") 60 days -- 60 days from CREATION, so a job that is
// still pending at 60 days expires with its history; that is deliberate, stale staged jobs
// are dead weight on the gate. A set with {merge:true} re-stamps, which only ever EXTENDS
// a document's life -- the safe direction. A write that already carries the field is left
// alone, so a future caller can opt a specific document out (or further in) explicitly.
//
// ORDERING HAZARD -- DO NOT ENABLE THE TTL POLICY BEFORE THE ARCHIVE IS SEEDED. This stamp
// is inert until the Firestore TTL policy on `expireAt` is enabled, and enabling it before
// the BigQuery archive is seeded DESTROYS every pre-deploy transcript with no copy. The
// exact sequence and the gcloud/bq commands are in deploy/TTL-BIGQUERY-INFRA.md.
const PC_TTL_FIELD = 'expireAt';
const PC_TTL_DAYS: { [coll: string]: number } = { journal: 120, chat_history: 120, pending_confirms: 60 };
// The forever-archive mirrors journal + chat_history ONLY ("the point of the journal was to
// never lose history"). pending_confirms is deliberately absent: jobs are 60-day terminal
// state, their durable record (what ran, as whom, exit) already lands in the journal.
const PC_ARCHIVE_COLLS: { [coll: string]: string } = { journal: 'journal', chat_history: 'chat_history' };
// PURE (extracted-function tests drive this): the expiry for a collection, or null.
function pcTtlExpireAt(coll: string, nowMs: number): any {
  const days = PC_TTL_DAYS[coll];
  return days ? new Date(nowMs + days * 86400000) : null;
}
// PURE: stamp a document payload. Non-objects, arrays, non-retention collections and
// payloads that already carry the field pass through UNTOUCHED (same object identity).
function pcTtlStamp(coll: string, data: any, nowMs: number): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const exp = pcTtlExpireAt(coll, nowMs);
  if (!exp) return data;
  if (Object.prototype.hasOwnProperty.call(data, PC_TTL_FIELD)) return data;
  const out: any = {};
  for (const k of Object.keys(data)) out[k] = data[k];
  out[PC_TTL_FIELD] = exp;
  return out;
}
{
  // Install on the PROTOTYPES so the patched objects are the SDK's own (instanceof, internal
  // state and Transaction/WriteBatch argument validation all see unmodified instances).
  // Sub/other collections pass through pcTtlStamp unchanged, so behaviour moves for the three
  // retention collections and for nothing else.
  const _pcTtlColl: any = db.collection('journal');
  const _pcTtlCollProto: any = Object.getPrototypeOf(_pcTtlColl);
  const _pcTtlDocProto: any = Object.getPrototypeOf(_pcTtlColl.doc());
  const _pcTtlRawAdd: any = _pcTtlCollProto.add;
  const _pcTtlRawSet: any = _pcTtlDocProto.set;
  const _pcTtlRawCreate: any = _pcTtlDocProto.create;
  _pcTtlCollProto.add = function (this: any, data: any): any {
    const coll = String(this.path || '');
    const stamped = pcTtlStamp(coll, data, Date.now());
    const p = _pcTtlRawAdd.call(this, stamped);
    // BEST-EFFORT dual-write (operator parameter). A separate promise chain: the caller's
    // write neither waits for the archive nor fails with it. add() resolves to the new ref,
    // which is where the document id comes from. add() internally creates via .create(),
    // which is why .create() below does NOT mirror -- one write, one archive row.
    if (PC_ARCHIVE_COLLS[coll]) {
      Promise.resolve(p).then((ref: any) => pcArchiveOnWrite(coll, String((ref && ref.id) || ''), stamped)).catch(function () {});
    }
    return p;
  };
  _pcTtlDocProto.set = function (this: any, data: any, ...rest: any[]): any {
    const coll = String((this.parent && this.parent.path) || '');
    const stamped = pcTtlStamp(coll, data, Date.now());
    const p = _pcTtlRawSet.apply(this, ([stamped] as any[]).concat(rest));
    if (PC_ARCHIVE_COLLS[coll]) {
      const id = String(this.id || '');
      Promise.resolve(p).then(() => pcArchiveOnWrite(coll, id, stamped)).catch(function () {});
    }
    return p;
  };
  _pcTtlDocProto.create = function (this: any, data: any): any {
    const coll = String((this.parent && this.parent.path) || '');
    return _pcTtlRawCreate.call(this, pcTtlStamp(coll, data, Date.now()));
  };
}
// ================== end [SEC-TTL-CHOKEPOINT-V1] ==================

// ---- [FLEET-MODE-V1] the model-spend switch, AT THE TRANSPORTS and nowhere else ----
// THE MODEL-CALLING CODE SHIPS. WHETHER IT CALLS ANYTHING IS A SETTING. This control
// plane reaches three model endpoints and only three: harClaudePost() (Anthropic
// Messages -- api.anthropic.com/v1/messages with a key, or Vertex :rawPredict on the
// service account), harChatGemini() (Gemini -- generativelanguage /v1beta/models with a
// key, or Vertex :generateContent), and memEmbed() (Vertex text-embedding :predict).
//
// THE CHECK IS AT THE TRANSPORT AND IN NO CALLER, for the reason it always was: a check
// written per caller is a list, and a list drifts -- the next caller somebody adds is
// covered by nobody. WHAT CHANGED IS WHICH TRANSPORTS IT IS AT.
// [SEC-FLEETMODE-CONSOLE-V1] took it off the three CONSOLE transports -- harClaudePost(),
// harChatGemini(), and the key-verification probe inside POST /api/keys -- and left it on
// memEmbed(), which is the only one of the four an unattended caller can reach.
//
// WHAT THIS SWITCH PROTECTS AGAINST, stated here because a bare instruction with no
// statement of what it protects is how it came to be misapplied: spend that NOBODY ASKED
// FOR. The rule it serves is that this system may automate deterministic work but may
// never START model work by itself -- a queue tick, a sweep, a retry loop or a background
// runner waking up and billing a card or a project while its owner is asleep. Unattended,
// machine-initiated spend. A signed-in human typing into his own console and pressing send
// is the opposite of that case, and is out of scope by the same sentence that defines it.
// Gating the console took the product's main surface dark, refused the operator his own
// API key, and bought nothing: the unattended path the rule is actually about was a set of
// scheduled runners that decided in their own python modules and never read a line of this
// file. [FLEET-NO-SCHEDULED-RUNNERS-V125] THOSE RUNNERS ARE GONE AS OF 12.5 -- every
// component that walked a queue on a timer is deleted, in prod and in this tree -- so
// nothing in this install can start model work unattended at all. Each of the three ungated
// sites carries the full argument where it stands.
//
// config/models.fleet_mode IS THE ONLY SOURCE OF TRUTH, and since 12.5 it has exactly one
// reader: this file.
// THERE IS DELIBERATELY NO MIRRORED ENVIRONMENT VARIABLE. A second copy of a spend
// policy drifts from the first, and while it drifts a REDEPLOY -- which needs no
// approval -- could carry the stale copy and change what this install is allowed to
// spend. Changing the Firestore document is a privileged write and goes through the
// gate. That asymmetry is the whole reason the value lives in exactly one place.
//
// FAIL CLOSED IN EVERY DIRECTION. Absent document, absent field, empty string, wrong
// case, wrong type, or a Firestore exception all resolve to 'home', which spends
// nothing. There is no code path below that returns a permissive mode from a value it
// could not read, and no parameter anywhere defaults to 'allowed'.
const FLEET_MODES = ['home', 'work', 'dual'];
const FLEET_MODE_FALLBACK = 'home';
// A SHORT TTL THAT A FAILED READ NEVER EXTENDS. The cache is written on the success
// path only; the catch returns the fallback WITHOUT touching it. So a Firestore outage
// can neither pin a permissive answer in memory nor keep an already-cached permissive
// answer alive one millisecond past its window.
const FLEET_MODE_TTL_MS = 15000;
const fleetModeCache: { mode: string; at: number } = { mode: '', at: 0 };
async function fleetMode(): Promise<string> {
  const now = Date.now();
  if (fleetModeCache.mode && (now - fleetModeCache.at) < FLEET_MODE_TTL_MS) return fleetModeCache.mode;
  let mode = FLEET_MODE_FALLBACK;
  try {
    const doc = await db.collection('config').doc('models').get();
    const raw: any = doc.exists ? (doc.data() as any).fleet_mode : null;
    // NO .trim() AND NO .toLowerCase(). ' work ' and 'Home' are values this file does not
    // recognise, and an unrecognised value is REFUSED rather than repaired: repairing it
    // means guessing an intent, and the thing being guessed at is what gets billed.
    mode = (typeof raw === 'string' && FLEET_MODES.indexOf(raw) >= 0) ? raw : FLEET_MODE_FALLBACK;
  } catch (e) {
    return FLEET_MODE_FALLBACK;
  }
  fleetModeCache.mode = mode; fleetModeCache.at = now;
  return mode;
}
// THE TRUTH TABLE. The single place that decides. Every transport asks this and nothing
// else in this file has an opinion about model spend.
//
//   fleet_mode      | 'vertex' (keyless, service account, billed to this project)
//                   |            | 'key' (an API key, billed to whoever owns the card)
//   ----------------+------------+------------------------------------------------
//   home            | REFUSE     | REFUSE
//   work            | ALLOW      | REFUSE
//   dual            | ALLOW      | ALLOW
//   anything else   | REFUSE     | REFUSE
//
// 'home' REFUSES UNCONDITIONALLY -- it is the first statement, it reads no other
// argument, and no later branch can reach past it.
//
// 'work' MEANS KEYLESS, AND IT REFUSES THE KEY TRANSPORTS RATHER THAN MERELY NOT
// PREFERRING THEM. Vertex is already the DEFAULT for both providers, but a default is
// not a control: CHAT_CLAUDE_PROVIDER=anthropic or CHAT_GEMINI_PROVIDER=studio is one
// environment variable away from moving it, and a leftover chat-key-claude secret is
// then enough to start billing a personal card on a work install. Under 'work' that
// combination gets a refusal instead of an invoice.
//
// [FLEET-NO-SCHEDULED-RUNNERS-V125] THIS POLICY USED TO EXIST IN TWO LANGUAGES AND NOW
// EXISTS IN ONE. Until 12.5 the same table was implemented a second time in python, inside
// the scheduled runners, and the two halves drifted: the python tested only mode == home,
// so it permitted the keyed transport under 'work' on the same terms as 'dual'. Those
// runners are deleted, in prod and in this tree, so there is no second implementation left
// to drift from and nothing here starts model work on a timer. This function is the policy.
function fleetTransportAllowed(mode: string, transport: string): boolean {
  if (mode === 'home') return false;
  if (mode === 'work') return transport === 'vertex';
  if (mode === 'dual') return transport === 'vertex' || transport === 'key';
  return false;
}
// OFF IS A REFUSAL WITH A REASON, NOT A SILENT NULL. Its one remaining caller is memEmbed(),
// which must not throw -- its contract is that a null embedding degrades search and never
// blocks a write -- so it LOGS this text instead of swallowing the refusal. Before
// [SEC-FLEETMODE-CONSOLE-V1] the same text was thrown into /api/chat's catch and surfaced as
// `detail`; the console transports no longer consult the switch, so nothing throws it now,
// and the Error factory that used to wrap it is DELETED rather than left standing as an
// uncalled constructor next to a security decision. It names the mode, says no call was
// made, and says where to change it.
function fleetRefusalText(mode: string, what: string, transport: string): string {
  return 'fleet_mode=' + mode + ': ' + what + ' needs the ' + transport + ' transport, so no '
    + 'call was made and nothing was billed. home refuses every model call, work allows '
    + 'keyless Vertex only, dual allows both. Change it at Firestore '
    + 'config/models.fleet_mode -- a privileged write, which goes through the approval gate.';
}

// Normalize a Firestore timestamp (Admin Timestamp, or JSON {_seconds}) to millis.
function tsMillis(t: any): number {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t._seconds) return t._seconds * 1000;
  if (t.seconds) return t.seconds * 1000;
  return 0;
}

// --- SECURITY: server-verified identity (no self-asserted emails) ---
const AGENT_TOKENS: Record<string, string> = JSON.parse(
  Buffer.from(process.env.AGENT_TOKENS_B64 || '', 'base64').toString('utf8') || '{}'
);
const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || '';
// [SEC-LEGACY-CONFIRM-RETIRE-V1] THE SHARED-SECRET CONFIRM PATH IS GONE, KEY AND ALL.
// POST /api/confirm/verify, humanTokenOk(), HUMAN_CONFIRM_SECRET and its length floor are
// all deleted together in this commit. The route approved privileged jobs on a single
// shared bearer secret in an x-human-token header -- no passkey, no job binding, no danger
// classification, no approver allowlist, and none of the approval stamping every other
// approval path performs -- and it could not execute anything anyway: it POSTed the
// executor with NO Authorization header, which the edge drops because gate-exec is private,
// so an approved job was left stranded in 'confirmed' having run nothing.
// A retired route's key must retire with it. Leaving HUMAN_CONFIRM_SECRET bound to both
// services would keep a credential in the environment that nothing reads and nothing can
// check, which is the shape of a secret that quietly turns back on.
// The passkey path -- POST /api/webauthn/confirm/verify -- is the only confirm path and is
// untouched. POST /api/confirm/stage is a DIFFERENT route on a DIFFERENT credential
// (assertIdentity) and deliberately survives: it stages, it does not approve.
// [PARAM-PROJECT-V1] 2026-08-01. This file hardcoded one operator's project id and lake
// bucket. In a public release that is not a naming problem: a stranger's control plane would
// point at somebody else's bucket and fail with a 403 they cannot explain. Resolved from the
// environment instead, with NO fallback to the old values -- an empty value fails loudly
// where a wrong one fails quietly, and a fallback would keep the release leaking.
const PC_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
// [SEC-LAKE-NOGUESS-V1] THE LAKE BUCKET IS NEVER DERIVED FROM THE PROJECT ID. This line used
// to end `|| (PC_PROJECT ? PC_PROJECT + <project>-datalake : '')`, so a service redeployed
// WITHOUT its lake variable did not fail -- it built a plausible bucket name out of
// GCP_PROJECT and carried on. With two lanes in ONE project both lanes carry the SAME
// GCP_PROJECT, so that guess resolves to the OTHER lane's lake, and harWriteLake() below is a
// WRITE: the wrong-lane write would succeed and report success. An environment variable
// dropped on a redeploy is not hypothetical -- it happened on 2026-08-04. The comment
// directly above already says an empty value fails loudly where a wrong one fails quietly,
// and that a fallback keeps the leak; this line was the exception to its own rule.
//
// BOTH VARIABLE NAMES STILL WORK AND THAT IS LOAD-BEARING. Existing installs are split:
// some set DATA_LAKE_BUCKET, others set LAKE_BUCKET only. The precedence here is exactly
// what the six call sites below used to spell out one at a time -- DATA_LAKE_BUCKET first,
// then LAKE_BUCKET -- so no configured install changes behaviour. ONLY THE THIRD RUNG, THE
// GUESS, IS GONE.
const PC_LAKE = DATA_LAKE_BUCKET || process.env.LAKE_BUCKET || '';
// FAIL CLOSED PER CALL, WITH A NAMED ERROR, AND NOT AT BOOT. A module-level refusal was
// considered and rejected: it turns a missing variable into a crash-looping revision and
// takes down the gate, the console and every route that never touches the lake, which is a
// worse outage than the one it prevents. This file already answers an unconfigured lake with
// a visible per-call error rather than a dead process -- see [SEC-LAKE-UNCONFIGURED-V1] on
// the four MCP lake tools -- and this is the same doctrine on the vault and git-object paths.
// The throw reaches the caller as a real message; nothing downstream can read it as an empty
// file or as a successful write. The boot log below makes the condition visible immediately
// instead of at first use, which is what a dropped-variable redeploy needs.
function pcLakeBucket(): string {
  if (!PC_LAKE) throw new Error('LAKE_BUCKET_UNCONFIGURED: neither DATA_LAKE_BUCKET nor LAKE_BUCKET is set on this service, so there is no data lake to read or write. Refusing to guess a bucket name from the project id.');
  return PC_LAKE;
}
if (!PC_LAKE) {
  console.error('[cp] SECURITY: neither DATA_LAKE_BUCKET nor LAKE_BUCKET is set -- every lake read and write will fail closed with LAKE_BUCKET_UNCONFIGURED. Set DATA_LAKE_BUCKET on this service.');
}
// [SEC-REPOID-PARAM-V1] The fleet's git repository id. It is an operator-private name and
// must not be baked into a public tree, but it IS load-bearing at three call sites below --
// the MCP server name, twice, and the pinned memory-digest entity -- so it is parameterised
// here instead of being edited out of them. In THIS tree the default is the literal those
// sites carried before; in the PUBLIC tree oss/gen.py rewrites it to a neutral id at
// emit time, so the two trees differ here by design. This is the ONLY occurrence of the id
// in this file, which is what makes that one-line substitution sufficient.
const PC_REPO_ID = process.env.PC_REPO_ID || 'paracoding';
const app = express();
// [SEC-HEADERS-V1] 2026-08-01. This origin holds a cloud-platform OAuth token and serves the
// approval gate, and it was returning NO security headers at all -- verified against the
// deployed responses, not inferred. Registered here, immediately after the app is created,
// because a header middleware mounted after a route leaves that route answering bare.
app.use((req: any, res: any, next: any) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // The gate URL carries a next= parameter; today it leaks in full to any third party.
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // SAMEORIGIN rather than DENY: the threat is a cross-origin page framing the approval
  // button and stealing the tap. DENY would also stop our own pages framing each other,
  // which is a behaviour change nobody asked for and cannot be verified from here.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  // No includeSubDomains and no preload on this pass: both are effectively irreversible
  // once a browser has cached them, and neither is needed to close the finding.
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  // REPORT-ONLY, deliberately. The gate page carries inline script blocks with no nonces,
  // so an enforcing policy would have to permit all inline script -- which buys almost
  // nothing -- or carry a nonce on every block, which is a larger change than a header.
  // accounts.google.com is required: Google Identity Services is the one cross-origin
  // script, and it is unversioned by design, which is why it must never be SRI-pinned.
  res.setHeader(
    "Content-Security-Policy-Report-Only",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://accounts.google.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://accounts.google.com; " +
    "frame-src https://accounts.google.com; " +
    "frame-ancestors 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none'"
  );
  next();
});

app.use(express.json());

// [SEC-AUDIT-V105-CORS-WILDCARD] WHY THE WILDCARD IS SAFE HERE, AND WHEN IT STOPS BEING SAFE.
// This runs on BOTH surfaces and sets Access-Control-Allow-Origin: * on every route, with
// OPTIONS answered 200 unconditionally. That is deliberate: the public MCP surface exists for
// browser-based MCP clients on origins this server cannot enumerate in advance, and locking the
// origin down would break exactly the clients it is here to serve.
// It is safe ONLY because Access-Control-Allow-Credentials is never set anywhere in this
// middleware. Per the fetch/CORS spec, a wildcard origin without that header means the browser
// will NOT attach cookies, and will not expose the response to script, for any cross-origin
// request made in credentialed mode -- so the console session cookie (gate_session) and the IAP
// cookie never ride along cross-origin, and a bearer-token route still needs a token the
// attacker does not have. That is the entire reason this wildcard is not exploitable today.
// DO NOT ADD Access-Control-Allow-Credentials TO THIS MIDDLEWARE. The instant this handler
// pairs `*` (or a reflected origin) with credentials: true, every cookie-authenticated console
// route (waSessionOk, the passkey gate, IAP) becomes readable cross-origin by any page on the
// internet that gets a logged-in operator to load it -- the exact CSRF-via-CORS hole this
// comment exists to keep someone from reintroducing under a "just fix the CORS error" commit.
// If a future change genuinely needs credentialed cross-origin requests, it needs a real origin
// allow-list on THIS middleware first, not a credentials flag bolted onto the wildcard.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ================= [SEC-SURFACE-SPLIT-V1] TWO CLOUD RUN SERVICES, ONE IMAGE =================
// IAP on Cloud Run is ONE SWITCH PER SERVICE. The console (gate, dash, harness, flow, wiki,
// lakeview) is the bootstrap path into a brand-new install and must sit BEHIND IAP: it is how
// the operator reaches the gate before any passkey exists. The MCP surface must NOT, because
// IAP consumes the Authorization header and an MCP client has no Google identity. One service
// cannot be both, so the same image is deployed TWICE and PC_SURFACE tells each copy which half
// of the route table to register. Shipping one service with IAP on made /mcp unreachable;
// turning IAP off destroyed the bootstrap path. This is the third option and the only correct one.
//
//   PC_SURFACE unset    EVERY route registers -- today's behaviour, byte for byte. Nothing below
//                       runs: no wrapper is installed, no lookup happens, not one registration is
//                       touched. The operator's live single-service prod does not change.
//   PC_SURFACE=console  browser pages plus the browser-facing /api/* those pages call. No /mcp.
//   PC_SURFACE=mcp      the MCP surface, the OAuth and discovery endpoints a connector needs, and
//                       the legacy bearer-token agent API. No browser pages.
//
// WHY A WRAPPER ON app RATHER THAN AN if AROUND EACH REGISTRATION: route-audit.mjs runs as a
// BUILD STEP before esbuild and parses THIS SOURCE with a pattern anchored at column zero.
// Indenting a registration into a conditional would hide it from the audit and silently move
// 87/70/17. Every registration below therefore stays exactly where it is, unindented, and the
// surface decision is taken INSIDE app.get/app.post at registration time instead.
//
// EVERY ROUTE MUST NAME ITS SURFACE. A path missing from this table THROWS at boot rather than
// defaulting to anything: a route that lands on NEITHER service is a silently broken install, and
// that is the exact failure this table exists to make impossible. Adding a route means adding a
// line here. It can only bite when PC_SURFACE is set, so it can never brick the single service.
//
// HOW THE SPLIT WAS DECIDED -- by the auth mechanism each handler actually uses, not by its name.
// A cookie/passkey session (waSessionOk, waGate) is reachable ONLY from a browser that has been
// through the gate, so every such route is console. A bearer token or an OAuth access token
// (assertIdentity, oaBearerRole) is reachable only from a
// machine client, so every such route is mcp. The two mechanisms partition the table with no
// overlap, which is why nothing is marked 'both' today -- 'both' is still honoured so that a
// future dual-caller route can say so in one word. Measured, not assumed: gate-exec never calls
// back into this service (it answers /run and writes Firestore directly), the OAuth consent page
// fetches only /oauth/authorize/complete and /oauth/token, and /oauth/strains -- despite its
// prefix -- is passkey-gated and the consent page does not call it, so it is console.
const PC_SURFACE = String(process.env.PC_SURFACE || '').trim().toLowerCase();
// Keys are exactly METHOD + one space + the path string as registered. Values: console | mcp | both.
const PC_SURFACE_MAP: { [k: string]: string } = {
  // ---- console: browser pages ----
  'GET /': 'console',
  'GET /dash': 'console',
  'GET /harness': 'console',
  'GET /chat': 'console',
  'GET /flow': 'console',
  'GET /flowhood': 'console',
  'GET /git/archive': 'mcp',
  'POST /git/blob': 'mcp',
  'GET /wiki': 'console',
  'GET /wiki/:slug': 'console',
  'GET /wiki/assets/:name': 'console',
  'GET /brand/logo.png': 'console',
  'GET /favicon.ico': 'both',
  'GET /icon.png': 'both',
  'GET /lakeview': 'console',
  // ---- console: the /api/* those pages call (all cookie/passkey-session gated) ----
  'GET /api/webauthn/status': 'console',
  'POST /api/webauthn/register/options': 'console',
  'POST /api/webauthn/register/verify': 'console',
  'POST /api/webauthn/enroll/link': 'console',
  'POST /api/webauthn/enroll/options': 'console',
  'POST /api/webauthn/enroll/verify': 'console',
  'POST /api/webauthn/unlock/options': 'console',
  'POST /api/webauthn/unlock/verify': 'console',
  'POST /api/webauthn/elevate/options': 'console',
  'POST /api/webauthn/elevate/verify': 'console',
  'GET /api/webauthn/pending': 'console',
  'GET /api/webauthn/job/:id': 'console',
  'POST /api/webauthn/confirm/options': 'console',
  'POST /api/webauthn/confirm/verify': 'console',
  'POST /api/webauthn/preapprove': 'console',
  'GET /api/dash/summary': 'console',
  'GET /api/dash/usage': 'console',
  'GET /api/dash/gcp': 'console',
  'GET /api/security/pqc-tls': 'console',
  'POST /api/security/pqc-tls': 'console',
  'POST /api/ops/token': 'console',
  'GET /api/ops/session': 'console',
  'POST /api/ops/end': 'console',
  'GET /api/models': 'console',
  'GET /api/usage': 'console',
  'GET /api/keys/status': 'console',
  'POST /api/keys': 'console',
  // [GH-TOOLS-V1] CONSOLE ONLY, and this table is why. The gh_* TOOLS run on the MCP surface,
  // but they never call these routes -- they read Secret Manager and config/github directly,
  // in-process. These three are the operator's panel: a human behind IAP pasting a token. A
  // route registered on a surface that has no reason to serve it is reach nobody asked for.
  //
  // This entry is not paperwork. Omitting it is what took the first v10.2 MCP revision down at
  // boot -- pcSurfaceGuard threw '[surface] GET /api/github/status names no surface', the
  // container never listened, and Cloud Run refused the revision. At ZERO TRAFFIC, before
  // anything moved, which is the entire point of deploying that way and of the guard existing.
  'GET /api/github/status': 'console',
  'POST /api/github/token': 'console',
  'POST /api/github/config': 'console',
  'GET /api/fleet/agents': 'console',
  'POST /api/strain/delete': 'console',
  'POST /api/strain/subculture': 'console',
  'POST /api/strain/create': 'console',
  'GET /api/chat/history': 'console',
  'POST /api/chat': 'console',
  'GET /api/flow': 'console',
  'POST /api/lakeview/link': 'console',
  'GET /api/strains': 'console',
  'POST /api/strains/provision': 'console',
  'POST /api/strains/retire': 'console',
  'GET /oauth/strains': 'console',
  'POST /api/sessions/mint': 'console',
  'GET /api/sessions': 'console',
  'POST /api/sessions/roleflags': 'console',
  'GET /api/sessions/roles': 'console',
  'POST /api/sessions/revoke': 'console',
  'GET /api/oauth/allowed': 'console',
  'POST /api/oauth/allowed': 'console',
  // ---- mcp: the connector transports ----
  'POST /mcp': 'mcp',
  'GET /mcp': 'mcp',
  'DELETE /mcp': 'mcp',
  'POST /mcp/:token': 'mcp',
  // ---- mcp: the legacy bearer-token agent API ----
  'POST /api/queue/post': 'mcp',
  'POST /api/queue/claim': 'mcp',
  'POST /api/journal/log': 'mcp',
  'POST /api/confirm/stage': 'mcp',
  'POST /api/jobs/fire': 'mcp',
  'POST /api/jobs/supersede': 'mcp',
  // ---- mcp: OAuth 2.1 and discovery, advertised on the MCP host by oaPubBase ----
  'POST /oauth/register': 'mcp',
  // [OSS-IAPAUTH-V54] 'both', not 'mcp'. The authorize PAGE is the only part of the OAuth flow a
  // human's browser visits, so it is the only part that can be put behind IAP -- and IAP is the
  // one Google sign-in an installer can provision with no console visit, because Cloud Run IAP
  // uses a Google-managed OAuth client. Registering the pair on the console surface too lets the
  // metadata point a browser at the IAP-protected host while /oauth/token, /oauth/register and
  // /mcp stay on the public mcp host where the connector needs them. OAuth allows exactly this:
  // authorization_endpoint and token_endpoint are separate entries and need not share a host.
  'GET /oauth/authorize': 'both',
  'POST /oauth/authorize/complete': 'both',
  'POST /oauth/authorize/key': 'both',
  'POST /oauth/token': 'mcp',
  'GET /.well-known/oauth-protected-resource': 'mcp',
  'GET /.well-known/oauth-protected-resource/mcp': 'mcp',
  'GET /.well-known/oauth-authorization-server': 'mcp',
  'GET /.well-known/oauth-authorization-server/mcp': 'mcp',
  'GET /.well-known/openid-configuration': 'mcp',
  'GET /.well-known/agents': 'mcp',
  'GET /.well-known/agent.json': 'mcp',
  'GET /agents/:role/.well-known/agent-card.json': 'mcp',
  'GET /agents/:role/.well-known/agent.json': 'mcp',
};
// Installed ONLY when PC_SURFACE is set. No try/catch anywhere in here on purpose: a surface that
// cannot be built must fail the boot loudly, not log and serve half a service.
if (PC_SURFACE) {
  if (PC_SURFACE !== 'console' && PC_SURFACE !== 'mcp') {
    throw new Error('PC_SURFACE=' + PC_SURFACE + ' is not a surface. Use console, use mcp, or'
      + ' leave it unset for one service carrying every route.');
  }
  const pcSurfaceSkipped: string[] = [];
  const pcSurfaceKept: string[] = [];
  const pcVerbs = ['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'];
  for (const pcVerb of pcVerbs) {
    const pcOrig = (app as any)[pcVerb].bind(app);
    (app as any)[pcVerb] = function (pcPath: any, ...pcRest: any[]) {
      // app.get('some setting') is Express's settings accessor: one argument, no handler. Never a route.
      if (typeof pcPath !== 'string' || pcRest.length === 0) return pcOrig(pcPath, ...pcRest);
      const pcKey = pcVerb.toUpperCase() + ' ' + pcPath;
      const pcWant = PC_SURFACE_MAP[pcKey];
      if (!pcWant) {
        throw new Error('[surface] ' + pcKey + ' names no surface in PC_SURFACE_MAP. Every route'
          + ' must name the service(s) it belongs to; a route on neither is a silently broken'
          + ' install. Add it to the table beside the routes it sits with.');
      }
      if (pcWant !== 'both' && pcWant !== PC_SURFACE) { pcSurfaceSkipped.push(pcKey); return app; }
      pcSurfaceKept.push(pcKey);
      return pcOrig(pcPath, ...pcRest);
    };
  }
  (app as any).pcSurfaceKept = pcSurfaceKept;
  (app as any).pcSurfaceSkipped = pcSurfaceSkipped;
  process.nextTick(() => {
    console.error('[surface] PC_SURFACE=' + PC_SURFACE + ' registered ' + pcSurfaceKept.length
      + ' route(s), withheld ' + pcSurfaceSkipped.length + ' belonging to the other surface.');
  });
}
// =============== end [SEC-SURFACE-SPLIT-V1] ===============


function assertIdentity(req: express.Request): string {
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

app.post('/api/queue/post', async (req, res) => {
  try {
    const callerId = assertIdentity(req);
    const { title, assigned_role, payload } = req.body;
    const taskRef = db.collection('work_items').doc();
    await taskRef.set({
      id: taskRef.id, title, assigned_role, status: 'pending',
      payload: payload || {}, created_by: callerId,
      created_at: FieldValue.serverTimestamp()
    });
    res.status(201).json({ success: true, taskId: taskRef.id });
  } catch (err: any) {
    const _em = String((err && err.message) || '');
        console.error('handler error:', _em);
        if (_em.indexOf('401') === 0) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.status(400).json({ error: 'request failed' });
  }
});

app.post('/api/queue/claim', async (req, res) => {
  try {
    const callerId = assertIdentity(req);
    const { role } = req.body;
    // [SEC-AUDIT-V105-QUEUE-CLAIM-SCOPE] callerId is the AGENT_TOKENS VALUE for this bearer --
    // the same "role name" principal that the MCP-side equivalents (buildMcpServer's who(a),
    // used directly as `.where('assigned_role', '==', agentId)` at the list/claim tools) already
    // treat as one namespace with assigned_role. This route trusted the CLIENT-SUPPLIED `role`
    // instead, so any holder of a valid agent token could claim another role's queued work by
    // naming it in the body. Refuse instead of silently substituting callerId, so a caller that
    // passes a mismatched role gets an explicit 403 rather than a claim that quietly changed identity.
    if (role !== callerId) { res.status(403).json({ error: 'forbidden: role does not match caller identity' }); return; }
    const snapshot = await db.collection('work_items')
      .where('assigned_role', '==', role)
      .where('status', '==', 'pending')
      .orderBy('created_at', 'asc')
      .limit(1)
      .get();
    if (snapshot.empty) {
      res.status(200).json({ task: null });
      return;
    }
    const taskDoc = snapshot.docs[0];
    await taskDoc.ref.update({
      status: 'claimed', claimed_by: callerId,
      claimed_at: FieldValue.serverTimestamp()
    });
    res.status(200).json({ task: taskDoc.data() });
  } catch (err: any) {
    const _em = String((err && err.message) || '');
        console.error('handler error:', _em);
        if (_em.indexOf('401') === 0) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.status(400).json({ error: 'request failed' });
  }
});

app.post('/api/journal/log', async (req, res) => {
  try {
    const callerId = assertIdentity(req);
    const { action, message } = req.body;
    const logRef = db.collection('journal').doc();
    await logRef.set({
      id: logRef.id, agent_id: callerId, action, message,
      timestamp: FieldValue.serverTimestamp()
    });
    res.status(201).json({ success: true });
  } catch (err: any) {
    const _em = String((err && err.message) || '');
        console.error('handler error:', _em);
        if (_em.indexOf('401') === 0) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.status(400).json({ error: 'request failed' });
  }
});

// [GATE-QUEUE-COEXIST-V1] EVERY STAGED JOB STAYS STAGED UNTIL SOMEBODY DECIDES IT.
// WHAT WAS HERE BEFORE, AND WHY IT HAD TO GO. GET /api/webauthn/pending carried a loop that,
// on EVERY load of the gate, flipped every non-newest pending job sharing a
// staged_by|command_type key to 'superseded' -- writing only status and superseded_at, so
// supersede_note, superseded_by_job and superseded_by_role stayed null and read_job_log
// answered reason: null. Two chats of one role using one command_type destroyed each other's
// work, newest wins, and the record said nothing about why. run_command hardcodes
// command_type 'run_cmd', so a role could hold exactly ONE live run_command; the fleet had
// learned to work around that by minting distinct command_types (harVmGateStage says so in
// its own comment) rather than by fixing it.
// NOTHING IN THIS REPOSITORY EVER STATED A REASON FOR THAT LOOP. It is not a passkey-window
// optimisation: an elevation is already minted per job id AND per that job's command sha
// (waElevatedForJob, [F6]) and [SEC-ASSERT-EVERY-V1] demands a fresh assertion for every
// approval, so N staged jobs already cost N taps and collapsing the queue bought no tap back.
// The two real concerns it could only ever have addressed by accident are kept, and each is
// keyed on something narrower and answered LOUDLY instead of by silent destruction:
//   DOUBLE SUBMIT -> pcAdmitStage refuses a second job whose staged_by, command_type and
//     command_sha256 all match one already waiting. That is the EXACT COMMAND BYTES, not
//     role+command_type: two different commands of the same type are two different intentions
//     and both now sit on the gate. The already-waiting job is returned and LEFT UNTOUCHED --
//     nothing pending is ever written by the deduplicator.
//   RUNAWAY STAGING -> a per-role cap on jobs already waiting. Over it, the stage is REFUSED,
//     journalled, and the queue is left exactly as it was. A cap that refuses is strictly
//     better than one that deletes: the operator keeps what he has not yet read, and the
//     agent gets a sentence telling it what happened instead of a job that vanishes.
// A READ FAILURE REFUSES THE STAGE. It cannot be told from an empty queue, and admitting on
// an unreadable queue is how a cap is bypassed by inducing an error. The cost is one refused
// stage that can be retried; nothing waiting is touched and nothing already approved is
// affected. That is the opposite trade from [F2] -- there a read failure would have
// PERMANENTLY quarantined jobs, here it delays one proposal.
const PC_PENDING_MAX_PER_ROLE = parseInt(process.env.PC_PENDING_MAX_PER_ROLE || '25', 10);
const PC_PENDING_LIST_MAX = parseInt(process.env.PC_PENDING_LIST_MAX || '500', 10);
// The command sha is over the STAGED ARGUMENTS, serialised by pcStableJson so that key order
// cannot make one intention look like two. It is stored on the job as command_sha256 and is
// what the deduplicator compares; it is NOT an approval binding and does not replace
// approved_sha256, waElevatedForJob or the [SEC-APPROVE-BIND-V1] displayed-job compare.
function pcJobCommandSha(args: any): string {
  return crypto.createHash('sha256').update(pcStableJson(args === undefined ? null : args)).digest('hex');
}
async function pcAdmitStage(stagedBy: string, commandType: string, args: any): Promise<any> {
  const sha = pcJobCommandSha(args);
  const mine0 = String(stagedBy || '');
  const type0 = String(commandType || '');
  let snap: any;
  try { snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(PC_PENDING_LIST_MAX + 1).get(); }
  catch (e: any) {
    console.error('[gate] GATE-QUEUE-COEXIST-V1: the pending queue could not be read while admitting a stage by ' + mine0 + '; REFUSED rather than admitted.');
    return { ok: false, sha: sha, refusal: 'refused: the gate queue could not be read, so this stage could not be checked against the per-role cap or against an identical job already waiting. NOTHING WAS STAGED and nothing already waiting was touched. Retry; if it keeps failing the control plane cannot reach Firestore, in which case no job could be approved either.' };
  }
  let mineN = 0; let dup = '';
  for (const d of snap.docs) {
    const x: any = d.data() || {};
    if (String(x.staged_by || '') !== mine0) continue;
    mineN++;
    if (!dup && String(x.command_type || '') === type0 && String(x.command_sha256 || '') === sha) dup = String(x.job_id || d.id);
  }
  if (dup) {
    try { await db.collection('journal').add({ agent_id: mine0, action: 'stage_deduped', message: 'Did NOT stage a second ' + type0 + ' for ' + mine0 + ': job ' + dup + ' is already waiting at the gate with byte-identical arguments. The waiting job was left untouched and nothing was destroyed.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    return { ok: false, sha: sha, duplicate_of: dup, refusal: 'NOT STAGED, AND NOTHING WAS DESTROYED: job ' + dup + ' is already waiting at the gate with byte-identical arguments, so a second card would ask the operator to decide one intention twice. Approve or deny THAT job, or change the command if you meant something different. Read it with read_job_log job_id=' + dup };
  }
  if (mineN >= PC_PENDING_MAX_PER_ROLE) {
    try { await db.collection('journal').add({ agent_id: mine0, action: 'stage_refused_cap', message: 'REFUSED to stage ' + type0 + ' for ' + mine0 + ': ' + String(mineN) + ' jobs staged by this role are already waiting at the gate and the cap is ' + String(PC_PENDING_MAX_PER_ROLE) + ' (PC_PENDING_MAX_PER_ROLE). Nothing was staged and nothing waiting was touched.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    return { ok: false, sha: sha, refusal: 'refused: ' + String(mineN) + ' jobs staged by ' + mine0 + ' are already waiting at the gate and the cap is ' + String(PC_PENDING_MAX_PER_ROLE) + ' (PC_PENDING_MAX_PER_ROLE). NOTHING WAS STAGED AND NOTHING WAITING WAS DESTROYED. Wait for the operator to work the queue down, or retire the proposals you no longer want with POST /api/jobs/supersede, which records who did it and why.' };
  }
  return { ok: true, sha: sha };
}
app.post('/api/confirm/stage', async (req, res) => {
  try {
    const callerId = assertIdentity(req);
    const { command_type, arguments: args } = req.body;
    const _adm = await pcAdmitStage(callerId, String(command_type || ''), args || {});
    if (!_adm.ok) { res.status(409).json({ error: _adm.refusal, staged: false, duplicate_of: _adm.duplicate_of || null }); return; }
    const jobRef = db.collection('pending_confirms').doc();
    await jobRef.set({
      job_id: jobRef.id, staged_by: callerId, command_type,
      arguments: args || {}, status: 'pending',
      created_at: FieldValue.serverTimestamp(), command_sha256: _adm.sha
    });
    await db.collection('journal').add({
      agent_id: callerId, action: 'stage_job',
      message: `Staged privileged job ${command_type} (${jobRef.id}) awaiting human approval.`,
      timestamp: FieldValue.serverTimestamp()
    });
    res.status(201).json({ success: true, jobId: jobRef.id });
  } catch (err: any) {
    const _em = String((err && err.message) || '');
        console.error('handler error:', _em);
        if (_em.indexOf('401') === 0) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.status(400).json({ error: 'request failed' });
  }
});



// ---- Streamable-HTTP MCP endpoint for the Claude app (token in URL path) ----
// [PC-TOOLS-V1] Which tool CLASSES a role holds. Absent field == every class, so a strain
// that predates this behaves exactly as it did. Cache shaped like mcpStrainAdmit: one
// doc.get() behind a Map with a TTL, last-known-good on error, because this sits on the hot
// path of every MCP request.
const PC_TOOLS_ENFORCE = String(process.env.PC_TOOLS_ENFORCE || '') === '1';
const PC_ALL_CLASSES = ['read', 'write', 'stage', 'infra'];
const PC_TOOL_CLASS: any = {
  git_read: 'read',
  git_list: 'read',
  git_log: 'read',
  git_diff: 'read',
  // [TOOL-SURFACE-V1] git_grep WAS ABSENT FROM THIS TABLE, AND THAT ABSENCE WITHHELD IT FROM
  // EVERY ROLE ON EVERY INSTALL. Counted: index.ts + gittools.ts + ghtools.ts register 63
  // distinct tool names; this table classified 62. The one unclassified name was git_grep, so
  // it fell to 'other' -- a class no strain document holds and pcNarrowClasses can never
  // produce -- and with PC_TOOLS_ENFORCE=1 (install.sh sets it on BOTH services) it was
  // unregistered for fleet-advisor, for the operator, for everyone. The only trace was the
  // token 'git_grep:other' buried in a tool_surface_withheld journal line nobody reads.
  // 'read' is the honest class and grants nothing new: git_grep searches the same refs that
  // git_read already serves whole files from, in one request instead of N.
  git_grep: 'read',
  // [PCGIT-ARCHIVE-TOOL-V1] 'read', and it grants nothing git_read does not: the archive is
  // the same reach in one request. GET /git/archive already gates its session-key branch on
  // this exact class, so classifying it any other way would let one path serve what the other
  // withholds. An unclassified tool falls to 'other' and would be withheld from every role.
  git_archive: 'read',
  git_propose: 'write',
  git_propose_patch: 'write',
  git_push: 'write',
  // [GH-TOOLS-V1] THE SAME TWO CLASSES AS THE git_* TOOLS, NOT A THIRD ONE, AND THE REASON IS
  // that a class no strain holds is a tool nobody can call. pcToolClasses() reads each strain's
  // recorded tool_classes, PC_TOOLS_ENFORCE ships 1 on a real install, and an unrecognised class
  // falls to 'other' and is withheld from every role -- so classifying these as 'github' would
  // have shipped ten tools that register for nobody until every strain document is rewritten.
  // Reading GitHub is a read and writing to it is a write; that is honest, and it works on the
  // install that already exists. A narrower class is a later change that has to move the strain
  // documents in the same commit, and it should not ride along with the feature landing.
  gh_whoami: 'read',
  gh_repos: 'read',
  gh_read: 'read',
  gh_list: 'read',
  gh_log: 'read',
  gh_diff: 'read',
  gh_commit: 'write',
  gh_branch: 'write',
  gh_fork: 'write',
  gh_pr: 'write',
  // [GH-RELEASE-V1] Both are 'write' and neither is 'infra'. They publish, which is a write to
  // a repository this install already holds a credential for -- the same class gh_commit has,
  // and the same blast radius. Leaving either UNCLASSIFIED is the TOOL-SURFACE-GITGREP defect
  // verbatim: PC_TOOLS_ENFORCE=1 withholds an unclassified name from every role including the
  // operator's, and the tool is then registered, invisible, and blamed on the wrong thing.
  gh_tag: 'write',
  gh_release: 'write',
  whoami: 'read',
  create_entities: 'write',
  create_relations: 'write',
  add_observations: 'write',
  delete_entities: 'write',
  delete_observations: 'write',
  delete_relations: 'write',
  read_graph: 'read',
  search_nodes: 'read',
  open_nodes: 'read',
  list_work_items: 'read',
  read_journal: 'read',
  list_pending_confirm: 'read',
  read_file: 'read',
  list_files: 'read',
  read_history: 'read',
  search_history: 'read',
  get_time: 'read',
  read_job_log: 'read',
  run_status: 'read',
  list_my_messages: 'read',
  check_answer: 'read',
  append_journal: 'write',
  post_work_item: 'write',
  complete_work_item: 'write',
  cancel_work_item: 'write',
  log_history: 'write',
  write_file: 'write',
  put_file: 'write',
  answer_message: 'write',
  ask_agent: 'write',
  refresh: 'write',
  stage_privileged_job: 'stage',
  run_command: 'stage',
  gcp_api: 'infra',
  run_roll: 'infra',
};
const pcClassCache: Map<string, any> = new Map();
const PC_CLASS_TTL_MS = 60000;
async function pcToolClasses(role: string): Promise<string[]> {
  const now = Date.now();
  const hit: any = pcClassCache.get(role);
  if (hit && (now - hit.at) < PC_CLASS_TTL_MS) return hit.v;
  try {
    const d = await db.collection('strains').doc(role).get();
    const row: any = d.exists ? (d.data() || {}) : {};
    const raw = row.tool_classes;
    // Absent, empty or malformed == every class. Only an explicit non-empty array narrows.
    const v = (Array.isArray(raw) && raw.length) ? raw.map((x: any) => String(x)) : PC_ALL_CLASSES;
    pcClassCache.set(role, { at: now, v: v });
    return v;
  } catch (e) {
    // Registry unreachable: prefer last-known-good, else every class. This must never be the
    // reason a fleet loses its tools -- admission control above already fails closed on the
    // question of whether this principal may be here at all.
    if (hit) return hit.v;
    return PC_ALL_CLASSES;
  }
}

// [WP4B-KEY-CLASSES-V1] A SESSION KEY MAY HOLD LESS THAN ITS STRAIN. IT MAY NEVER HOLD MORE.
//
// WHY THIS EXISTS AT ALL. pcToolClasses above answers "what does this ROLE hold", and the role
// is the wrong grain for a subagent. A subagent must stay the SAME role -- same private lake
// folder (resolveKey confines reads to agents/<role>/), same journal attribution, same
// admission verdict -- while being structurally unable to stage a gated job or write the lake.
// Minting it a separate strain purely to get a narrower tool_classes would change its identity
// and cut it off from the parent's folder, which is the opposite of what is wanted. So the
// narrowing rides on the session_keys row: same role, narrower credential.
//
// THE ONE INVARIANT, and the whole security claim:
//
//     pcNarrowClasses(base, anything) is ALWAYS a SUBSET of base.
//
// There is no input -- absent, empty, malformed, hostile, or naming a class that does not
// exist -- that ADDS a class. A key restriction can only subtract. That is precisely why it is
// safe to honour a field that arrives out of Firestore with no schema behind it, and why the
// operator's own key (which carries no such field) keeps every capability it has today.
//
// THE READINGS, and why each one is the SAFE one:
//   undefined / null    -> base, unchanged. This is EVERY key in the collection today, because
//                          before this patch nothing wrote the field. Absence therefore means
//                          "this key predates the mechanism" and must behave exactly as it did.
//                          Absence is not a hole: it grants nothing the strain did not already
//                          grant. A key that is meant to be a boundary SAYS SO; a key that says
//                          nothing was never claimed to be one.
//   not an array        -> the FLOOR (sight only), NOT base. A malformed restriction is a
//   []                     restriction that was MEANT, so it must never evaporate back into
//   ['nonsense']           full capability. Reading a broken narrowing as "no narrowing" is
//                          exactly the fail-open shape this work package exists to remove.
//   ['read','write']    -> base INTERSECT that. Unrecognised members are dropped BEFORE the
//                          intersection, so a typo neither becomes the class it resembles nor
//                          re-opens everything: ['stagee'] filters to empty and falls to the
//                          floor, which holds no 'stage'.
//
// The floor is 'read' and it is itself intersected with base, so a strain that does not hold
// 'read' does not acquire it here. Sight is the floor rather than nothing because a subagent
// that cannot read is useless, and the object is to remove WRITE and STAGE, not sight. whoami
// sits below even this floor: buildMcpServer registers it unconditionally, so a restricted key
// can always still say what it is.
const PC_KEY_FLOOR_CLASSES = ['read'];
function pcNarrowClasses(base: any, raw: any): string[] {
  const b: string[] = Array.isArray(base) ? base.filter((x: any) => typeof x === 'string') : [];
  // The ONLY branch that returns base untouched, and it is reached only when the row states
  // no restriction at all. A copy, never the PC_ALL_CLASSES const itself.
  if (typeof raw === 'undefined' || raw === null) return b.slice();
  let want: string[] = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (typeof c === 'string' && PC_ALL_CLASSES.indexOf(c) >= 0 && want.indexOf(c) < 0) want.push(c);
    }
  }
  if (!want.length) want = PC_KEY_FLOOR_CLASSES;
  return b.filter((x: string) => want.indexOf(x) >= 0);
}

// ================== [TOOL-SURFACE-V1] REFUSE, DO NOT DISAPPEAR ==================
// WHAT WAS WRONG, MEASURED. A Claude Max/Pro user adds this server as a custom connector.
// A tools/list request CARRIES NO ARGUMENTS -- the MCP schema has nowhere to put one -- so the
// `agent` session key CANNOT travel on it. pcExtract() therefore sees no tools/call, and
// pcResolveIdentity takes its enumeration carve-out and answers with the BEARER role. That
// bearer is OAUTH_ROLE, which install.sh pins to fleet-onboarder, whose seeded tool_classes is
// exactly ['read'] (SEC-AUDIT-V105-ONBOARDER-CLASSES). With PC_TOOLS_ENFORCE=1 the shadow in
// buildMcpServer then declined to register every non-read tool, so the ONLY list the connector
// ever saw was 28 read tools: 23 write + 2 stage + 5 infra, plus git_grep stranded in 'other',
// were never enumerated (3 browser_* are separately env-gated off). A model cannot call a tool
// it never enumerated. Pasting a fleet-advisor key into the chat did not help either: the key
// fixes the ROLE on tools/call, but the client is holding a cached tool list with no write_file
// in it and has no reason to ask for another. The product shipped read-only through its own
// connector, and no log line said so.
//
// WHY A STUB AND NOT A CARVE-OUT IN pcResolveIdentity. The tempting patch is "enumerate the
// full surface when the request contains no tools/call". That makes ENUMERATION depend on
// REQUEST SHAPE, and request shape is caller-chosen: one body carrying both tools/list and
// tools/call, or any later path that reuses a built server across methods, and a widened
// server is sitting there holding LIVE handlers. This instead registers the withheld tool with
// its REAL name, REAL description and REAL inputSchema -- and a handler that is NOT the real
// handler. The real handler is bound ONLY on the fall-through, i.e. only where the class check
// PASSED. Enumeration cannot become authorization by CONSTRUCTION rather than by invariant:
// there is no ordering, batch shape or cache state in which the refusing registration yields
// the capability, because the capability is not in that closure at all.
//
// WHY WIDENING IS SAFE HERE AT ALL: every MCP request rebuilds the server. POST /mcp resolves
// identity, then calls buildMcpServerAdmitted(role, tc) fresh; the modern branch calls
// deps.tools(role) AGAIN for tools/call and resolves the handler out of THAT list
// (mcp2026.ts, the tools/call dispatch). Nothing survives a request except pcSessCache and
// pcClassCache, which are 60s caches of the ANSWER to "what does this principal hold", not of
// the tool table. The class check was ALREADY a call-time check; it was merely also being used
// as an enumeration filter, and only that second job is being taken away from it.
//
// COST: one refusal string per withheld tool per build, built lazily inside the closure only
// when the tool is actually called. The wire cost is the schema of ~31 more tools on tools/list
// for an unbound connector -- which is the entire point: the model must SEE what it may ask for.
function pcRefusalTool(name: string, klass: string, why: string, held: string[]): any {
  return async () => ({
    content: [{ type: 'text', text:
      'REFUSED: `' + name + '` is tool class `' + klass + '` and this connection does not hold that class.\n\n'
      + why + '\n\n'
      + 'Classes this connection holds: ' + (held.length ? held.join(', ') : '(none)') + '.\n'
      + 'THIS CALL DID NOTHING. The tool is LISTED so you can see the fleet has it and ask for the '
      + 'right credential; listing is not permission. Pass a session key that holds `' + klass
      + '` as the `agent` argument ON THE CALL -- it is the line beginning PC-SESSION-KEY in this '
      + 'chat bootstrap paste, and the operator mints one at the Flow Hood (Autoclave, New strain '
      + 'session). A role NAME is not a key and resolves to nothing. Do not retry this call '
      + 'unchanged; do not report the work as done.' }],
    isError: true
  });
}

// ============================ [MCP-RESULT-CAP-V1] ============================
// A CEILING ON ONE TOOL RESULT, AT THE SURFACE, BECAUSE AN OVERSIZED RESULT IS A
// CORRECTNESS BUG AND NOT AN AESTHETIC ONE.
//
// WHAT WAS HERE BEFORE: nothing. Every tool handler below returns
// { content: [{ type: 'text', text }] } and that object was handed to the
// transport verbatim. There is no truncation anywhere on the MCP result path --
// not in the shadow, not in mcp2026Handle, not in the SDK -- so the size of a
// result was whatever the underlying query happened to return.
//
// WHY THAT WAS WRONG. Measured on this deployment: list_work_items returned
// 128,929 characters in ONE call and run_status returned 52,039. A model reading
// a 128,929-character tool result spends roughly 36,800 tokens on it (pretty-
// printed JSON runs about 3.5 characters per token), which is ~18% of a
// 200,000-token window consumed by a single call whose useful answer was "here
// are the open work items". Three of them evict the conversation that asked for
// them. That is not a cosmetic problem: an agent that loses its own instructions
// mid-task does the wrong thing confidently, and the eviction is invisible to it.
//
// The growth is unbounded by construction, not by accident. list_work_items does
// db.collection('work_items').limit(50) and JSON.stringify(d.data()) with no field
// projection: 128,929 / 50 = 2,579 characters PER WORK ITEM, and a work item grows
// every time somebody adds a field. run_status returns the Cloud Run services list
// body straight out of harGcpApi, which grows with every revision, env var and
// annotation on every service in the project. Neither number is a limit anyone
// chose; both are a side effect of how much data happened to exist.
//
// WHY THE CAP LIVES HERE AND NOT IN THE TOOLS. This shadow is the ONE funnel every
// tool result passes through on the way out. Both eras are downstream of it: the
// legacy 2025 branch gets the handler through _pcReg into the SDK, and the modern
// 2026-07-28 branch calls t.handler out of _pcTools (mcpServeModern -> deps.tools
// -> Mcp2026Tool.call). gittools.registerGitTools() is handed THIS server, so its
// seven git tools flow through here too. Wrapping once here therefore caps 50-odd
// tools and every tool added after today, with no per-tool edit and no way for a
// new tool to opt out by forgetting.
//
// THE NUMBER, AND THE ARITHMETIC BEHIND IT. PC_RESULT_MAX = 55,555 characters.
//   - RAISED FROM 24,000 to 55,555 on 2026-08-15 by operator decision, alongside
//     the list_work_items projection below. They are a pair and the reasoning only
//     holds as a pair: the projection stops the worst offender from needing the
//     budget at all, and the raise covers tools that still return one indivisible
//     blob. Raising the number ALONE was considered and rejected -- it buys only a
//     handful more work items before the cap returns, and it pays the larger result
//     on every call forever. Projection is the fix; budget is the allowance.
//   - It is NO LONGER the same number as CTX_MEM_MAX, which stays 24,000. That
//     equality was previously offered as a reason ('one fleet, one answer to the
//     same question') and it no longer holds, so it is removed rather than left
//     standing as a false justification. They answer different questions: one
//     bounds an INJECTED blob the strain did not ask for, this one bounds a
//     result the strain requested by calling a tool.
//   - ~55,555 chars is ~16,000 tokens, ~8.0% of a 200,000-token window. This is a
//     CEILING, not a target: almost every tool returns far less, and the projection
//     work is what keeps the common case cheap.
//   - Against the two measured offenders: list_work_items NO LONGER APPROACHES IT.
//     It serves a ~150-character projection per item and drills in by id, so the
//     14-item queue that cost 46,838 characters now costs ~2,000. run_status was
//     measured at 52,039 and now FITS, with 3,516 characters to spare -- and that
//     is LUCK, NOT DESIGN, so do not read it as solved. Nothing BOUNDS run_status:
//     52,039 was one sample of a result that grows with the fleet, and the next
//     reading can exceed any constant chosen here. An earlier draft of this block
//     said run_status 'STILL EXCEEDS' the cap, which was true at 50,000 and false
//     at 55,555; it is corrected rather than left standing. Its fix is unchanged
//     and is the one below: project the result, do not enlarge the budget.
//   - It is a CONSTANT, not an env var, and that is deliberate twice over. Every
//     other context budget in this file is a named constant (CTX_MEM_MAX,
//     CTX_MEM_OBS_CHARS, the 48,000 runaway stop in ctxBuild), and a cap that any
//     deployment can raise from the environment is how a cap quietly becomes
//     unbounded again with nothing in the diff to review.
//
// WHICH END IT KEEPS. The head, for everything except the one tool that serves
// oldest-first: see PC_RESULT_CAP_TAIL below. Keeping the head of an ascending
// result is a cap that reliably discards the answer, which is a different way of
// being wrong from being expensive but not a better one.
//
// HOW IT TRUNCATES, AND THE ONE THING IT REFUSES TO DO. It cuts the STRING and
// marks the cut. It does NOT parse the JSON, drop array elements and re-serialise.
// Re-serialising is the tempting option and it is the worse bug: it produces a
// result that PARSES, so the agent reads a 9-item array as the complete answer and
// reasons from a subset it believes is the whole set -- silently, with nothing on
// screen to contradict it. Cutting the string leaves the text unparseable ON
// PURPOSE: an unclosed brace is a loud failure, and the marker states in words
// that the text stops mid-value. The surface also cannot safely do the smart
// thing: it sees an opaque string and has no idea whether it holds pretty JSON,
// a unified diff, a markdown lesson file or a sentence, and half the tools here
// return prose.
//
// WHAT THE MARKER MUST CARRY, because a silent clip is worse than the original
// defect: (1) WHICH END SURVIVED, in words, placed at the edge the model is
// reading toward -- after the text for a head cut, before it for a tail cut;
// (2) the TRUE total character count, so "9 items" cannot be mistaken for
// "9 items exist"; (3) the actual argument names of THAT tool, read off its own
// spec.inputSchema, so the instruction for getting the rest is specific and needs
// no per-tool table here.
//
// EXEMPT, AND WHY EACH ONE. Three tools return a WHOLE ARTIFACT the agent is
// expected to act on or write back, where a prefix is dangerous rather than merely
// lossy. A truncating read feeding a whole-file write DESTROYS the file, and
// The fleet's law 9.4 mandates exactly that read-whole/edit-whole/write-whole loop:
//   whoami    -- the context-delivery channel. It carries the memory digest and
//                the injected bootstrap. A truncated rule is indistinguishable
//                from an absent one to the model reading it; that failure is
//                already written up in the fleet laws document. Bounded elsewhere:
//                CTX_MEM_MAX 24,000 plus the 48,000 runaway stop in ctxBuild.
//   read_file -- lake read under read-whole/write-whole. Bounded by
//                PC_LAKE_READ_MAX (175,000 characters) at its definition below:
//                an explicit FILE_TOO_LARGE refusal carrying the file's actual
//                size and the bound, never a truncation that would corrupt lake
//                objects.
//   git_read  -- repository read feeding git_propose, which does WHOLE FILE writes
//                only. Bounded by GIT_MAX_BLOB_BYTES (2 MiB) with an explicit
//                FILE_TOO_LARGE error carrying the size -- which is the RIGHT
//                shape for a whole-artifact read and the shape read_file now
//                has. 2 MiB is still ~600,000 tokens, so this cap does not solve
//                git_read; lowering that bound is a separate change.
// The general rule, so the set does not grow by habit: a REPORT may be capped, an
// ARTIFACT must refuse with its size instead. git_diff is the closest call and is
// deliberately left CAPPED: it is read to understand a change, not applied
// verbatim, and git_propose_patch takes a patch the agent authors.
//
// WHAT DELIBERATELY DOES NOT CHANGE.
//   - Every tool's own logic, query limit and output text. Nothing below this
//     block is edited; a result under 24,000 characters is returned byte-identical.
//   - isError is preserved as-is. An oversized error is capped like anything else;
//     it does not become a success and a success does not become an error.
//   - The withholding decision above still runs FIRST and is untouched: a withheld
//     tool never reaches the wrap, so PC_TOOLS_ENFORCE behaviour is unchanged.
//   - Both eras stay byte-identical for uncapped results, and the wrap forwards
//     arguments with a rest parameter so the SDK's (args, extra) call and the
//     modern branch's (args) call both arrive at the original handler unchanged.
//   - buildDeniedMcpServer builds a SECOND McpServer that does not go through this
//     shadow. It is left alone on purpose: it registers whoami and nothing else,
//     whoami is exempt anyway, and its text is a constant. A tool added THERE would
//     not inherit this cap -- but adding a tool to the denied server contradicts
//     what the denied server is for.
//   - structuredContent is not capped. No tool in this file or in gittools emits
//     it; pruning a structured object is precisely the parses-but-is-a-subset
//     failure this block exists to prevent, so a future tool that emits an
//     oversized one must page instead.
//   - No route is added, moved or renamed, and no new process.env read is
//     introduced.
const PC_RESULT_MAX = 55555;
const PC_RESULT_CAP_TAG = '[MCP-RESULT-CAP-V1]';
const PC_RESULT_CAP_EXEMPT = new Set(['whoami', 'read_file', 'git_read']);
// CUT FROM THE FRONT, NOT THE BACK, FOR A TOOL WHOSE RESULT IS OLDEST-FIRST.
// A prefix is only the useful half when the useful end is the TOP. read_history
// sorts ASCENDING and then takes the last N -- `rows.sort(x - y)` then
// `rows.slice(-(limit || 30))` -- so its newest turn is the LAST line of the
// result, and its own description is "most recent history in chronological order
// ... to refresh at session start". Head-truncating that serves the thirty-turn
// window's OLDEST end and cuts precisely what the caller asked for: a strain
// refreshing at session start would read what it was doing an hour ago and never
// reach what it was doing last. The marker would say so, so the failure is loud
// rather than silent -- but a cap that reliably keeps the wrong half is still the
// cap choosing wrong, and 30 turns of prose passes 24,000 characters at only 800
// characters a turn, so this is the ordinary case and not a corner.
//
// MEASURED, NOT ASSUMED: read_history is the ONLY tool on this surface that
// serves ascending. search_history sorts DESCENDING (`tsMillis(y) - tsMillis(x)`),
// read_journal and git_log are newest-first by query, and list_work_items,
// run_status and the rest are unordered sets where neither end is the answer.
// Every other ascending sort in this file is on an HTTP route, not a tool. So
// this set has exactly one member on purpose, and a second name belongs in it
// only after someone checks the sort the same way.
const PC_RESULT_CAP_TAIL = new Set(['read_history']);
// The tool's own argument names, straight off the spec it registered with, minus
// `agent` (a credential, never a narrowing filter). This is what lets the marker
// tell the caller HOW to get the rest without this file holding a table of tools.
function pcCapArgNames(spec: any): string[] {
  const shape: any = spec && spec.inputSchema;
  if (!shape || typeof shape !== 'object') return [];
  return Object.keys(shape).filter((k: string) => k !== 'agent');
}
function pcCapNote(toolName: string, argNames: string[], shown: number, total: number, keptTail: boolean): string {
  const pct = Math.round((shown / total) * 1000) / 10;
  const hasLimit = argNames.indexOf('limit') >= 0;
  const how = argNames.length
    ? ((hasLimit ? 'pass a SMALLER limit, or narrow with ' : 'narrow the call with ')
       + argNames.join(', ') + ', then call again.')
    : ('this tool takes no narrowing arguments, so the rest is not reachable from here -- '
       + 'tell the operator, who can raise PC_RESULT_MAX in control-plane/src/index.ts.');
  // The marker names WHICH END SURVIVED. 'a prefix' and 'a suffix' are different
  // facts about what is missing, and an agent that reads the wrong one draws the
  // wrong conclusion about whether it has the latest state or the earliest.
  const kept = keptTail ? 'THIS IS THE END OF THE RESULT, NOT THE WHOLE OF IT'
                        : 'THIS IS A PREFIX, NOT THE RESULT';
  const edge = keptTail
    ? 'THE TEXT BELOW STARTS MID-VALUE, and the OLDEST entries were cut. It is NOT valid JSON,\nit is NOT the whole list, and the number of entries visible is NOT the number that exist.'
    : 'THE TEXT ABOVE STOPS MID-VALUE, and the entries after the cut are gone. It is NOT valid\nJSON, it is NOT the whole list, and the number of entries visible is NOT the number that exist.';
  // [PCGIT-DIFF-CAP-V1] TWO EXTRA LINES FOR THE GIT READERS, AND THE SECOND ONE IS THE
  // IMPORTANT ONE. git_diff is not on PC_RESULT_CAP_EXEMPT and must not be: a whole-tree
  // diff is unbounded, and exempting it would let a single call return megabytes, which is
  // the failure this cap exists to prevent. But its own payload carries "truncated": false,
  // and that flag describes gitDiff's CHANGE LIST -- it is set before this cap is applied
  // and knows nothing about it. An agent that reads it after a byte cut concludes it holds
  // a complete diff when it holds a fragment that does not even parse. So the marker
  // contradicts the flag by name, and points at the tool that returns a whole tree in one
  // request instead of leaving the caller to page a diff that has no pager.
  const gitAdvice = (toolName === 'git_diff' || toolName === 'git_log' || toolName === 'git_list')
    ? ('IGNORE ANY "truncated": false IN THE PAYLOAD ABOVE -- that flag describes ' + toolName
       + "'s own\nchange list and is written BEFORE this byte cap is applied. It does not know "
       + 'about this cut.\nFOR A WHOLE TREE, USE git_archive: it returns the entire repository at a ref as one\n'
       + 'tarball over HTTP and is not subject to this cap. Rebuilding a tree out of capped diffs\n'
       + 'is the exact waste git_archive exists to end.\n')
    : '';
  const body = '======== ' + PC_RESULT_CAP_TAG + ' TRUNCATED -- ' + kept + ' ========\n'
    + 'tool: ' + toolName + '\n'
    + 'shown: ' + shown + ' of ' + total + ' characters (' + pct + '%); '
    + (total - shown) + ' characters were CUT from the ' + (keptTail ? 'START' : 'END') + '.\n'
    + edge + '\n'
    + 'Do not parse it, do not count it, and do not report what it contains as complete.\n'
    + 'TO GET THE REST: ' + how + '\n'
    + 'There is no cursor or offset on this surface: fleet tools narrow by FILTER, not by page.\n'
    + gitAdvice
    + '======== END ' + PC_RESULT_CAP_TAG + ' ========';
  return keptTail ? (body + '\n\n') : ('\n\n' + body);
}
// Budget is PER RESULT, not per content block: ten blocks of 24,000 is 240,000
// characters and would defeat the cap it passed.
function pcCapResult(toolName: string, argNames: string[], out: any): any {
  if (!out || typeof out !== 'object' || !Array.isArray(out.content)) return out;
  const items: any[] = out.content;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const b: any = items[i];
    if (b && b.type === 'text' && typeof b.text === 'string') total += b.text.length;
  }
  if (total <= PC_RESULT_MAX) return out;
  // TAIL TOOLS TAKE A SEPARATE, SIMPLER PATH. Walking blocks from the end to spend
  // the same budget backwards would be the symmetric version of the loop below, and
  // every tool in this set today returns exactly ONE text block, so the general
  // machinery would be untested generality guarding a case that does not arise.
  // Joining and cutting once is the whole behaviour, and it is right for any block
  // count: the LAST PC_RESULT_MAX characters of the result are the last characters
  // whatever produced them.
  if (PC_RESULT_CAP_TAIL.has(toolName)) {
    const joined = items.map((b: any) =>
      (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('');
    let tail = joined.slice(joined.length - PC_RESULT_MAX);
    // Never START on a lone LOW surrogate (0xDC00-0xDFFF) -- the mirror of the
    // high-surrogate rule below, and the only cut that would change the BYTES of a
    // surviving character. charCodeAt, not a regex, for the reason given there.
    const _tc = tail.charCodeAt(0);
    if (_tc >= 0xDC00 && _tc <= 0xDFFF) tail = tail.slice(1);
    console.warn('[cp] ' + PC_RESULT_CAP_TAG + ' ' + toolName + ' produced ' + total
      + ' characters; served the LAST ' + tail.length + ' and marked the cut in-band.');
    return { ...out, content: [{ type: 'text',
      text: pcCapNote(toolName, argNames, tail.length, total, true) + tail }] };
  }
  const blocks: any[] = [];
  let shown = 0;
  let alreadyCut = false;
  for (let i = 0; i < items.length; i++) {
    const b: any = items[i];
    if (!b || b.type !== 'text' || typeof b.text !== 'string') { blocks.push(b); continue; }
    if (alreadyCut) {
      blocks.push({ ...b, text: PC_RESULT_CAP_TAG + ' content block ' + i
        + ' was dropped WHOLE: the result budget was already spent by the blocks above.' });
      continue;
    }
    const room = PC_RESULT_MAX - shown;
    if (b.text.length <= room) { shown += b.text.length; blocks.push(b); continue; }
    let head = b.text.slice(0, room);
    // Never end on a lone HIGH surrogate (0xD800-0xDBFF). That is the one cut that
    // would change the BYTES of a character that survives, rather than only how many
    // survive. Written as a charCodeAt comparison and not a regex on purpose: a
    // backslash-u escape in this file has to survive being copied through a patch, a
    // code review and a model's own emission to get here, and it does not always. A
    // number cannot be silently decoded into the character it names.
    const _hc = head.charCodeAt(head.length - 1);
    if (_hc >= 0xD800 && _hc <= 0xDBFF) head = head.slice(0, head.length - 1);
    shown += head.length;
    blocks.push({ ...b, text: head + pcCapNote(toolName, argNames, shown, total, false) });
    alreadyCut = true;
  }
  console.warn('[cp] ' + PC_RESULT_CAP_TAG + ' ' + toolName + ' produced ' + total
    + ' characters; served ' + shown + ' and marked the cut in-band.');
  return { ...out, content: blocks };
}
// Rest parameter, not a fixed arity: the legacy SDK calls a handler as
// (args, extra) and the modern branch calls it as (args). Forwarding whatever
// arrived is the only shape that is transparent to both.
function pcCapWrap(name: string, spec: any, handler: any): any {
  if (PC_RESULT_CAP_EXEMPT.has(name)) return handler;
  const argNames = pcCapArgNames(spec);
  return async (...a: any[]) => pcCapResult(name, argNames, await handler(...a));
}
// ========================== end [MCP-RESULT-CAP-V1] ==========================

// ============================ [LAKE-READ-BOUND-V1] ===========================
// read_file's size bound: an explicit refusal carrying the file's actual size,
// NEVER a truncation. WHAT THIS PROTECTS AGAINST: read_file is a whole-artifact
// lake read under the read-whole / edit-whole / write-whole loop law 9.4
// mandates, so its result is what an agent EDITS AND WRITES BACK WHOLE with
// write_file. A truncating read feeding that loop writes the surviving prefix
// back over the object and DESTROYS the lake artifact -- silently, because the
// write itself reports success. That is why read_file is on PC_RESULT_CAP_EXEMPT
// above, and why the only safe bound is the shape git_read already has: refuse,
// and say how big the file actually is and what the bound is, so the caller can
// decide what to do (split the artifact, or move the bytes with a staged job
// that never round-trips them through a model's context).
//
// THE NUMBER, DERIVED RATHER THAN COPIED. git_read's GIT_MAX_BLOB_BYTES (2 MiB)
// is ~600,000 tokens: a bound no read/edit/write loop through a model can ever
// round-trip, so copying it here would bound nothing. What the loop must afford
// is the artifact TWICE in one 200,000-token window -- once as the read result,
// once re-emitted as the write_file content -- plus instructions, the diff and
// the reasoning between them. Giving the round trip half the window, 100,000
// tokens at the ~3.5 characters/token this file's other budgets use, yields
// 175,000 characters. Against the fleet's real artifacts (measured 2026-08-13
// via list_files and git_read at head 63c04748): the fleet laws doc at 39,343
// chars, lane-state scripts 60,000-85,000, and the largest whole-edited
// source artifact, devgate/smoke.py, 166,873 -- all under the bound, and the
// largest of them is already close to the practical ceiling of the loop itself,
// which is the point: the bound tracks what the loop can DO, not what happens
// to exist. What this refuses today (a 625,340-char rollback bundle and a
// 462,167-char machine-written report in the lake) could never complete the
// loop anyway: serving such a read whole is how a context window gets evicted,
// and truncating it is how the object gets destroyed on write-back. A CONSTANT,
// not an env var, for the reason PC_RESULT_MAX gives above.
const PC_LAKE_READ_MAX = 175000;
// Pure -- (path, size) in, refusal text or null out, no I/O -- so the refusal
// path can be exercised off this surface with real sizes.
function pcLakeReadRefusal(path: string, chars: number): string | null {
  if (chars <= PC_LAKE_READ_MAX) return null;
  return 'FILE_TOO_LARGE: ' + path + ' is ' + chars + ' characters, over the '
    + PC_LAKE_READ_MAX + '-character read_file bound. Contents were NOT returned and NOT '
    + 'truncated: a truncated read fed back through the read-whole/edit-whole/write-whole '
    + 'loop would write the prefix over the lake object and destroy it. The file is intact. '
    + 'Split the artifact, or move the bytes with a staged job instead of reading them into '
    + 'a model context.';
}
// ========================= end [LAKE-READ-BOUND-V1] ==========================

// [SEC-AUTORUN-SCOPE-V1] THIS BLOCK LIVED INSIDE buildMcpServer() AND THAT WAS A REAL BUG,
// not a tidiness problem. pcAutoRun had exactly ONE call site -- the run_command handler --
// so every OTHER staging path wrote status:'pending' and waited for a human approval at a
// console route that was deleted the same day. stage_privileged_job, vm_start/vm_stop/
// vm_resize, run_roll and gcp_api all parked work forever and reported success while doing
// it, which is the worst failure shape available: the tool says STAGED, the operator reads
// it as done, and nothing ever runs. run_roll said it out loud -- "pending your gate
// approval -- naming a page that returns 404.
//
// harGcpStage() is defined well below buildMcpServer() and could not see this function at
// all, so the fix is scope: module level, reachable from every stager. The consts are read
// at CALL time, not at definition time, so their textual position below this point is not
// a temporal-dead-zone hazard -- nothing here runs during module evaluation.
// ---- [GCP-CLICK-REMOVAL-V1] RUN A CLEAN JOB WITHOUT A HUMAN TAP ----
// The click is not a control in itself; it is the DELIVERY MECHANISM for one. The control
// is deploy/LOCKOUT-CLASS.md's nine categories, and gate-exec/lockout_check.py now applies
// them pre-execute, fail-closed, on every body. This function moves the delivery: a body
// that is not dangerous and not lockout-class runs immediately; everything else stays at
// 'pending' exactly as before and waits for a human. Nothing is skipped -- the executor's
// rungs (approved_sha256 pin, approval signature, single-use claim, lockout check) all
// still run, because this stamps a REAL pre-approval rather than bypassing the path.
//
// OFF BY DEFAULT, AND THE SWITCH IS DELIBERATELY OUT OF REACH OF THE THING IT SWITCHES.
// PC_AUTO_APPROVE is a deploy-time env var, so it is a Cloud Run configuration revision,
// NOT a gated job. That matters both ways: arming it cannot be done by a job, and if it
// ever needs to come back off, that undo is a revision rollback and therefore still
// available even in the state where no job can be approved. Landing this code with the
// var unset changes nothing at all.
//
// DANGEROUS NO LONGER STAYS HUMAN BY DEFAULT, AND THIS PARAGRAPH USED TO SAY THE OPPOSITE.
// It read "DANGEROUS STAYS HUMAN, ON PURPOSE AND FOR A MEASURED REASON" and pointed at
// /api/webauthn/preapprove, which hard-refuses a destructive body while the human is away.
// That reasoning was sound while there was a human path to fall back to. [SEC-NOBRAKES-V1]
// removed it: PC_GUARDRAILS defaults to 0, so a destructive body runs here rather than
// being handed back as a question. waIsDangerous() is still re-run over the command text
// rather than trusted from the caller, and the caller's structural verdict is still OR-ed
// in, because the classification still decides what gets JOURNALLED and what the operator
// is told -- it just no longer decides whether the work happens.
//
// THE EXPIRY IS SHORT BECAUSE NOTHING HERE IS WAITING FOR A PERSON. Pre-approval for an
// absent human is 12h; this fires in the same breath, so 15 minutes is generous and keeps
// a stamped-but-unfired token from lingering as a usable credential.
const PC_AUTO_APPROVE = String(process.env.PC_AUTO_APPROVE || '0') === '1';
// [SEC-NOBRAKES-V1] One name for one idea: do runtime refusals exist at all. Read by this
// service and by gate-exec/exec_server.py, defaulting to OFF in both, so there is a single
// thing to flip and a single thing to document rather than a flag per brake.
const PC_GUARDRAILS = String(process.env.PC_GUARDRAILS || '0') === '1';
async function pcAutoRun(ref: any, jobId: string, commandType: string, command: string, danger: boolean, confirm: boolean): Promise<string | null> {
  if (!PC_AUTO_APPROVE) return null;
  if (!command) return null;
  // [SEC-NOBRAKES-V1] 2026-08-14, OPERATOR RULING. This used to stop a destructive command
  // and hand the question back to chat. It no longer does, by default. Verbatim: 'we don't add
  // speed bumps we add accelerators' -- the operator issues the instruction, the chat is their
  // hands, and a second 'are you sure' to the person who just said do it is friction that buys
  // nothing. Breakage is the accepted cost and rolling forward is the accepted cure.
  //
  // THE PRE-SHIP CHECKS ARE UNTOUCHED AND THAT IS THE WHOLE DISTINCTION. oss/gen.py still
  // refuses a bad cut, route-audit still fails the build on a vanished route, the leak
  // ceilings still bite. Those cost nothing at runtime and catch the defect before it ships.
  // What is gone is the refusal that stops work already asked for.
  //
  // IT IS STILL JOURNALLED. Detection is not friction, and the record is what makes the
  // roll-forward possible. PC_GUARDRAILS=1 restores the old behaviour for an adopter who
  // wants brakes; it defaults to 0 because the operator's posture is the shipped posture.
  if ((danger || waIsDangerous(command)) && !confirm && PC_GUARDRAILS) {
    await ref.delete().catch(() => {});
    await db.collection('journal').add({ agent_id: 'auto_approve', action: 'auto_run_asked_human', message: 'Job ' + jobId + ' (' + commandType + ') is destructive; not run, returned to the operator in chat for a decision: ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() }).catch(() => {});
    return 'NEEDS YOUR OK — NOT RUN, NOT QUEUED.\n' +
           'This is a destructive command, so it did not run and nothing is waiting anywhere.\n' +
           'command: ' + command.slice(0, 800) + '\n' +
           'If you want it, say so and I will re-issue it with confirm=true.';
  }
  const cmdSha = crypto.createHash('sha256').update(command, 'utf8').digest('hex');
  const runToken = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + 15 * 60 * 1000;
  // Stamped under the SAME field names /api/webauthn/preapprove writes and
  // /api/jobs/fire and exec_server.py read. A different shape here would be a second
  // approval format for the executor to understand, and two formats is how a rung
  // starts accepting the weaker one.
  await ref.update({
    status: 'preapproved', preapproved_by: 'auto:lockout-check', preapproved_at: FieldValue.serverTimestamp(),
    cmd_sha: cmdSha, approved_sha256: cmdSha, approved_sha256_at: new Date().toISOString(),
    expiry, single_use: true, run_token: runToken,
  });
  // [SEC-APPROVAL-KMSSIG-V1] SIGN IT. Without this the envelope waApprovalEnvelope()
  // builds carries no approval_sig, and the executor -- which runs APPROVAL_REQUIRE_SIGNED=1
  // and is deliberately FAIL-CLOSED where this writer is fail-soft -- refuses every job.
  // The refusal is silent from here (exit -1, no stdout), which is exactly what an unsigned
  // auto-run looked like before this block existed.
  //
  // THE APPROVER FIELD SAYS WHAT IS TRUE. There is no human in this path, so it does not
  // name one. 'auto:lockout-check' goes into the SIGNED bytes, so the audit trail can never
  // later be read as a person having approved it. The signature's job is unchanged: it
  // proves the approval came from the control plane's KMS key rather than from anyone who
  // can write the Firestore document, and it binds the job id and the command digest so it
  // cannot be lifted onto a different job.
  const _macKey = process.env.APPROVAL_MAC_KEY || '';
  const _sigStamp: any = { approved_sha256: cmdSha, approved_sha256_at: new Date().toISOString() };
  if (_macKey) {
    _sigStamp.approval_mac = crypto.createHmac('sha256', _macKey).update(jobId + '|' + cmdSha, 'utf8').digest('hex');
    _sigStamp.approval_mac_v = 1;
  }
  if (PC_APPROVAL_SIG_KEY) {
    try {
      const _appr = 'auto:lockout-check';
      const _now = Date.now();
      const _iat = new Date(_now).toISOString();
      const _exp = new Date(_now + PC_APPROVAL_SIG_TTL_SEC * 1000).toISOString();
      const _sigDoc = await db.collection('pending_confirms').doc(String(jobId)).get();
      const _sigJx: any = _sigDoc.exists ? (_sigDoc.data() || {}) : {};
      const _canon = pcApprovalCanonV2({
        alg: PC_APPROVAL_SIG_ALG, jid: String(jobId), csha: cmdSha,
        ctyp: String(_sigJx.command_type || ''), asha: pcApprovalArgsSha(_sigJx.arguments),
        appr: _appr, kver: PC_APPROVAL_SIG_KEY, iat: _iat, exp: _exp });
      _sigStamp.approval_sig = await pcApprovalSign(_canon);
      _sigStamp.approval_sig_v = 4;
      _sigStamp.approval_sig_canon = PC_APPROVAL_CANON_V2_ID;
      _sigStamp.approval_sig_alg = PC_APPROVAL_SIG_ALG;
      _sigStamp.approval_sig_key = PC_APPROVAL_SIG_KEY;
      _sigStamp.approval_sig_approver = _appr;
      _sigStamp.approval_sig_iat = _iat;
      _sigStamp.approval_sig_exp = _exp;
    } catch (e) {
      console.error('[auto] signing failed for ' + jobId + ': ' + String(e));
    }
  }
  await ref.set(_sigStamp, { merge: true });
  await ref.update({ status: 'executing', started_by: 'auto:lockout-check', started_at: FieldValue.serverTimestamp() }).catch(() => {});
  let r: any;
  try {
    // EMPTY token, for the same reason /api/jobs/fire forwards an empty one: there is no
    // human in this path, so gate-exec must run under its own scoped identity rather than
    // borrowing a live human's credential.
    r = await waExecuteApproved(jobId, command, '');
  } catch (e: any) {
    // Back to 'pending', NOT to a failure state. The job was never run, so the human path
    // must still be able to pick it up -- a job that auto-running dropped on the floor
    // would be the silent-drop failure LOCKOUT-CLASS.md forbids.
    await ref.update({ status: 'pending', fire_refused_reason: 'auto-run exec call failed', fire_refused_at: FieldValue.serverTimestamp() }).catch(() => {});
    await db.collection('journal').add({ agent_id: 'auto_approve', action: 'auto_run_failed', message: 'Auto-run of job ' + jobId + ' could not reach the executor; returned to the human queue.', timestamp: FieldValue.serverTimestamp() }).catch(() => {});
    return null;
  }
  const exec = r.exec; const exit = r.exit;
  await ref.update({
    status: 'executed', ran_as: 'auto-approve', exit_code: exit,
    stdout_tail: String((exec && exec.stdout) || '').slice(-6000), stderr_tail: String((exec && exec.stderr) || (exec && exec.raw) || '').slice(-6000),
    confirmed_by: 'auto:lockout-check', ran_at: FieldValue.serverTimestamp(),
    single_use_consumed: true, used: true, used_at: FieldValue.serverTimestamp(), run_token: FieldValue.delete(),
  });
  await db.collection('journal').add({ agent_id: 'auto_approve', action: confirm ? 'auto_run_executed_confirmed' : 'auto_run_executed', message: 'Auto-ran job ' + jobId + ' (' + commandType + ', exit ' + exit + (confirm ? ', OPERATOR-CONFIRMED IN CHAT' : '') + '): ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() });
  // THE EXECUTOR'S LOCKOUT REFUSAL IS RELAYED, NOT SWALLOWED. The control plane cannot
  // evaluate the nine categories itself -- lockout_check.py is Python and lives in the
  // executor, and a TypeScript second copy is exactly the drift this fleet has already
  // been bitten by. So the executor refuses, and this turns that refusal into the chat
  // question, naming the rule that fired.
  // exec.error is where a REFUSAL lands (waCallExec parses the executor's JSON body);
  // stderr/raw only carry output from a job that actually ran. Reading only the latter two
  // made an unsigned-approval refusal look like a silent exit -1 with no explanation.
  const _stderr = String((exec && exec.stderr) || (exec && exec.error) || (exec && exec.raw) || '');
  if (exit !== 0 && /lockout-class/.test(_stderr)) {
    const _rules = (_stderr.match(/LC[1-9]/g) || []).join(',') || 'unnamed';
    return 'NEEDS YOUR OK — REFUSED BY THE LOCKOUT CHECK, NOT RUN.\n' +
           'rule(s): ' + _rules + '\n' +
           'These are the changes that destroy the way back in (deploy/LOCKOUT-CLASS.md).\n' +
           'command: ' + command.slice(0, 800) + '\n' +
           'detail: ' + _stderr.slice(-800) + '\n' +
           'If you want it anyway, say so and I will re-issue it with confirm=true.';
  }
  return 'RAN job ' + jobId + ' (' + commandType + ') exit ' + exit + (confirm ? ' [operator-confirmed]' : '') + '\n' +
         String((exec && exec.stdout) || '').slice(-6000) +
         (_stderr ? '\nstderr: ' + _stderr.slice(-2000) : '');
}

async function buildMcpServer(agentId: string, keyClasses?: any): Promise<any> {
  const server = new McpServer({ name: PC_REPO_ID, version: '1.0.0' });
  // [PC-TOOLS-V1] Shadow registerTool ONCE rather than editing 36 call sites. Every
  // registration below flows through this unchanged.
  const _pcStrainClasses = await pcToolClasses(agentId);
  const _pcAllowed = new Set(_pcStrainClasses);
  // [WP4B-KEY-CLASSES-V1] The SECOND, narrower set: what the presented SESSION KEY holds.
  // null means the key stated no restriction (or there is no key at all, as on the
  // /mcp/:token connector mount, whose callers pass nothing here) -- in which case this
  // whole mechanism is inert and the strain set alone decides, exactly as before.
  // pcNarrowClasses guarantees _pcHard is a SUBSET of _pcAllowed, so this can only ever
  // take tools away and never hand one back.
  const _pcHard: Set<string> | null = (typeof keyClasses === 'undefined' || keyClasses === null)
    ? null : new Set(pcNarrowClasses(_pcStrainClasses, keyClasses));
  let _pcHardN = 0;
  const _pcWithheld: string[] = [];
  const _pcReg = (server as any).registerTool.bind(server);
  // [MCP2026-DUAL-ERA-V1] The 2026-07-28 branch needs the SAME tool set this server just
  // built -- same admission verdict, same withholding, same who() closure -- and it must not
  // reach into the SDK's private registry to get it. Recording here, INSIDE the shadow that
  // already decides what registers, is the only place where "the tools this role actually
  // has" is a fact rather than a re-derivation: a withheld tool returns above this line and
  // is therefore absent from both eras by construction. Legacy behaviour is unchanged --
  // nothing below reads __pcTools.
  const _pcTools: any[] = [];
  (server as any).__pcTools = _pcTools;
  (server as any).registerTool = (name: string, spec: any, handler: any) => {
    const klass = PC_TOOL_CLASS[name] || 'other';
    // whoami is the floor: a role that cannot say what it is cannot be debugged, and the
    // denied-server path already treats it that way.
    //
    // [WP4B-KEY-CLASSES-V1] THE KEY RESTRICTION IS NOT GATED ON PC_TOOLS_ENFORCE, and that
    // asymmetry is deliberate. PC_TOOLS_ENFORCE guards a change to what EXISTING strains hold:
    // flipping it could silently take tools from a fleet that never asked, so it ships off and
    // observes. A key restriction has no such population to protect -- it is written ONCE, by
    // the operator, at mint, on ONE key, for exactly the purpose of taking those tools away.
    // Honouring it only when a separate global flag happens to be on would make the boundary a
    // config revision away from not existing, which is the same prose-not-boundary failure this
    // is meant to end. So: unregistered, unconditionally, and therefore absent from tools/list
    // in BOTH eras -- a tool the subagent cannot see is one it cannot be talked into trying.
    //
    // [TOOL-SURFACE-V1] THAT LAST SENTENCE IS NOW WRONG ABOUT tools/list AND WAS ALWAYS WRONG
    // ABOUT THE KEY PATH. A session key travels in params.arguments.agent, and tools/list HAS
    // no arguments -- so keyClasses is ALWAYS undefined during enumeration and _pcHard is
    // ALWAYS null there. The key restriction has therefore never hidden anything from any tool
    // list; it only ever refused a CALL, and it refused it as an SDK "Unknown tool" error that
    // named neither the class nor the fix. Both branches now register a REFUSING handler
    // instead of returning undefined. The boundary is byte-for-byte the same -- the real
    // handler is unreachable on both -- and it is now legible to the model that hit it.
    let _pcH: any = handler;
    let _pcDenied = false;
    if (name !== 'whoami' && _pcHard && !_pcHard.has(klass)) {
      _pcHardN++;
      _pcWithheld.push(name + ':' + klass + ':key');
      _pcH = pcRefusalTool(name, klass,
        'The SESSION KEY presented on this call carries a tool_classes restriction that does not '
        + 'include `' + klass + '`. pcNarrowClasses can only ever SUBTRACT from the strain set, and '
        + 'no tool argument reaches it, so nothing you send on this call can widen it.',
        Array.from(_pcHard as Set<string>));
      _pcDenied = true;
    } else if (name !== 'whoami' && !_pcAllowed.has(klass)) {
      _pcWithheld.push(name + ':' + klass);
      // PC_TOOLS_ENFORCE governs THIS branch exactly as it did: off means observe-only and the
      // REAL handler is registered, unchanged. Only the shape of the enforced outcome moved,
      // from invisible to visible-and-refusing. The flag's meaning is untouched.
      // OAUTH_ROLE is a module-scope const declared far below; reading it here is safe for the
      // same reason STRAIN_SEED is read below (STRAIN-TDZ-V1) -- buildMcpServer runs only from
      // a REQUEST handler, never during module evaluation. Do not hoist this.
      if (PC_TOOLS_ENFORCE) {
        _pcH = pcRefusalTool(name, klass,
          'The strain `' + agentId + '` does not hold `' + klass + '` in its tool_classes. If this '
          + 'is an unbound OAuth connector it is acting as the fail-closed identity ' + OAUTH_ROLE
          + ', which holds `read` only until you present a key for a strain that holds more.',
          Array.from(_pcAllowed));
        _pcDenied = true;
      }
    }
    // [MCP-RESULT-CAP-V1] ONE wrap, here, and BOTH eras inherit it: the legacy SDK
    // receives the wrapped handler through _pcReg, and the modern 2026-07-28 branch
    // calls t.handler out of _pcTools -- which is now the SAME wrapped function.
    // Wrapping at either call site alone would cap one era and leave the other
    // uncapped, and the two would drift apart on the next edit.
    const _pcCapped = pcCapWrap(name, spec, _pcH);
    // [TOOL-SURFACE-V1] `denied` is recorded, not consulted: every consumer of __pcTools
    // (mcpServeModern, harChatToolset) reads name/spec/handler and is unaffected. It exists so
    // a test or an audit can assert "this build refused N tools" against the registry itself
    // rather than by string-matching a result.
    _pcTools.push({ name: name, spec: spec, handler: _pcCapped, denied: _pcDenied });
    return _pcReg(name, spec, _pcCapped);
  };
  void (async () => {
    if (!_pcWithheld.length) return;
    try {
      await db.collection('journal').add({
        agent_id: 'mcp_gateway',
        // [WP4B-KEY-CLASSES-V1] 'would_withhold' is a LIE the moment one tool was actually
        // withheld by a key restriction, and an audit line that misreports a real refusal as a
        // hypothetical is worse than no line. Any hard withholding makes this a WITHHELD record.
        // [TOOL-SURFACE-V1] By that same standard 'withheld' became a lie here: an enforced tool
        // is no longer ABSENT, it is LISTED AND REFUSING. Same trigger, honest verb. The
        // observe-only value is untouched, because in that mode nothing happens at all.
        action: (PC_TOOLS_ENFORCE || _pcHardN) ? 'tool_surface_refused' : 'tool_surface_would_withhold',
        message: (PC_TOOLS_ENFORCE ? 'Listed-but-REFUSING ' : 'WOULD have withheld ') + _pcWithheld.length
          + ' tool(s) from ' + agentId + ' (classes held: '
          + Array.from(_pcAllowed).join(',') + '): ' + _pcWithheld.join(' ')
          + (_pcHardN ? ' -- of these, ' + _pcHardN + ' (marked :key) are refused '
            + 'unconditionally, by the presented session key\'s tool_classes restriction '
            + '(effective: ' + Array.from(_pcHard as Set<string>).join(',') + '); '
            + 'PC_TOOLS_ENFORCE does not govern those.' : ''),
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (e) {}
  })();

  // IDENTITY, IN TWO LAYERS. Do not collapse them -- the old comment here did, and it was
  // wrong for a full afternoon while agents read it as authoritative.
  //
  // LAYER 1, RESOLUTION, happens ONCE in the POST /mcp handler BEFORE buildMcpServer is
  // called. The role comes from the connector bearer, or from a SESSION KEY the caller
  // presents as the `agent` argument, which is looked up server-side in session_keys.
  // Connectors in Claude are ACCOUNT-level, so without that key every chat in the account
  // resolves to the same role. The key is what separates them.
  //
  // LAYER 2, BINDING, is what this closure does, and it is unchanged: buildMcpServer(role)
  // closes over the ALREADY-RESOLVED role and who() returns it. Nothing a tool is passed can
  // change it here. who() ignoring a.agent is CORRECT at this layer -- by the time control
  // reaches it, `agent` has already been consumed upstream and agentId IS the answer.
  //
  // So `agent` is a CREDENTIAL, not a self-asserted role name. A role name resolves to
  // nothing. An unrecognised key is REFUSED outright -- it is never downgraded to a weaker
  // role and never silently upgraded to a stronger one. That last direction is not
  // hypothetical: the first cut of this fell back to fleet-advisor, the one role permitted
  // to stage gated jobs, so a single mistyped character PROMOTED a chat. fleet-curator found
  // it by mutating one character of its own key.
  // Impersonation is bounded by the key being unguessable and server-minted, NOT by any
  // claim in this file.
  // [RELEASE-ROSTER-V1] ONE LIST. This was a SECOND, hand-maintained roster that contradicted
  // STRAIN_SEED three lines under a comment claiming there was only one: it named twelve roles
  // where the shipped seed names six, and seven of those names no install has ever created. It
  // is now DERIVED from STRAIN_SEED -- the same single source STRAIN_PASTEABLE is derived from
  // -- so the two cannot drift and the release extractor still has exactly ONE declaration to
  // trim.
  //
  // WHAT THIS SET ACTUALLY DOES, because the name oversells it: it is NOT an authorisation
  // table and it admits nothing. Both branches below return agentId unchanged. It decides ONE
  // thing -- whether the `agent` argument is echoed VERBATIM into the log line, or only as a
  // fingerprint. Shrinking it therefore CANNOT widen access; the only behavioural effect is
  // that a role name outside the seed takes the generic C1 branch instead of the specific
  // IMPERSONATION-ATTEMPT branch. Shrinking is also the SAFE direction for an allowlist that
  // gates verbatim printing of a possibly-credential value: a shorter list can only print
  // FEWER values, never more.
  //
  // [STRAIN-TDZ-V1] STRAIN_SEED is a module-scope const declared far below this line. Reading
  // it here is safe because this runs inside buildMcpServer, which is reached only from the
  // /mcp and /mcp/:token REQUEST handlers -- never during module evaluation. Do not hoist this
  // set to module scope, where it would be read before STRAIN_SEED is initialised.
  const ROLES = new Set(STRAIN_SEED);
  // VERIFY-GREP: IDENTITY-TRUTH-V1
  const who = (a: any): string => {
    if (a && typeof a.agent === 'string' && a.agent !== agentId) {
      // C1-KEYFP-V1 -- the agent argument carries a server-minted SESSION KEY, not a role name.
      // Under per-chat identity a.agent !== agentId is therefore true on EVERY call, so this branch
      // is the NORMAL path, not an anomaly -- and it used to print the key, writing a live
      // credential to Cloud Logging in cleartext once per tool call for every strain.
      // Log a FINGERPRINT instead: the first 8 hex chars of sha256(value). A hash prefix is not a
      // credential (the same property LAKE_EXEC_BOUNDARY_SHA256 relies on below), it is stable, so
      // one chat is still correlatable across calls, and a real impersonation attempt is still loud.
      // The verbatim value is printed ONLY for members of ROLES -- an ALLOWLIST of public role
      // names. That is the deliberate inverse of testing whether a value looks key-shaped: an
      // allowlist cannot leak a value it does not contain, whereas a shape test leaks every
      // credential whose shape it failed to predict.
      const agFp = crypto.createHash('sha256').update(a.agent, 'utf8').digest('hex').slice(0, 8);
      if (ROLES.has(a.agent)) {
        console.warn('[cp] C1 IMPERSONATION ATTEMPT: the agent argument was the role NAME ' + a.agent + ' (fp=' + agFp + '). Role names resolve to nothing; agent must carry a server-minted session key. Acting as the resolved principal ' + agentId + '.');
      } else {
        console.warn('[cp] C1: agent fp=' + agFp + ' differs from the resolved principal ' + agentId + '. EXPECTED: the agent argument carries a session key, not a role name. Acting as ' + agentId + '.');
      }
    }
    return agentId;
  };
  const AG = { agent: z.string().optional() };

  server.registerTool('whoami',
    { description: 'CALL THIS FIRST, EVERY SESSION, BEFORE ANYTHING ELSE. It delivers the fleet memory digest of what earlier strains already measured, then the bootstrap that says how you work here. Skipping it means re-deriving what the fleet already paid to learn. Return the role you are acting as. Your role is RESOLVED SERVER-SIDE: from the connector bearer, or from a session key you present as the `agent` argument (minted by the operator at the Autoclave, looked up in session_keys). `agent` is a CREDENTIAL, not a role name -- a role name resolves to nothing, and a key that does not resolve is REFUSED, never downgraded to a weaker role or silently upgraded to a stronger one. Once resolved the role is fixed for the request and no tool argument can change it. Privileged execution runs under PC_AUTO_APPROVE, which ships as 1: a staged job is signed and executed in the same call, and the journal records it. Set it to 0 and staged work sits instead.', inputSchema: { ...AG } },
    async (a: any) => {
      const role = who(a);
      const c = await ctxBuild();
      const charter = await ctxCharter(role);
      const body = [
        'ROLE: ' + role,
        'context_sha: ' + c.sha,
        '',
        '================ FLEET MEMORY -- WHAT IS ALREADY KNOWN ================',
        'Measured by earlier strains. Do not re-derive it and do not contradict it',
        'without measuring first. open_nodes gives full detail including superseded',
        'and retracted history.',
        '',
        c.mem,
        '',
        '================ BOOTSTRAP -- HOW YOU WORK HERE ================',
        c.boot,
        '',
        ...(charter
          ? ['================ YOUR CHARTER -- WHAT THIS STRAIN OWNS ================', charter, '']
          : []),
        '================ END ================'
      ].join('\n');
      return { content: [{ type: 'text', text: body }] };
    });

  server.registerTool('list_work_items',
    { description: 'List work items. BOUNDED BY DEFAULT: returns id, title, role, status and a payload SIZE HINT, not the payload itself, so the queue cannot flood your context. ids:["<id>","<id>"] reads those items IN FULL and is how you read a payload. detail:true expands every match and is NOT budgeted. status defaults to any; "all" means the same thing explicitly.',
      inputSchema: { role: z.string().optional(), status: z.string().optional(), ids: z.array(z.string()).optional(), detail: z.boolean().optional(), limit: z.number().optional(), ...AG } },
    async ({ role, status, ids, detail, limit }: any) => {
      // WHY THIS TOOL IS NOT TEN LINES ANY MORE. It used to JSON.stringify whole
      // documents with no projection, which is the 2,579-characters-per-item figure
      // the cap block above cites: a 14-item queue cost 46,838 characters and the
      // tail was UNREACHABLE, because this surface has no cursor and this tool had
      // no id filter. Three v7.0 work items sat unread by every session for that
      // reason alone. Summary + ids drill-in is the fix; the cap raise is not.
      //
      // THE BOUND IS ENFORCED BY CONSTRUCTION, NOT BY ARITHMETIC. A draft of this
      // patch clamped rows using a per-row character estimate. The estimate was
      // wrong by 5% and the local proof caught it emitting 25,163 characters against
      // the 24,000 cap then in force. Any such number is also only correct until
      // someone adds a field to proj(). So the summary path FILLS A CHARACTER BUDGET
      // and stops, and SAYS HOW MANY IT DROPPED -- a silently short list reads as
      // 'that is all there is', which is the exact failure this tool already caused.
      const lim = Math.min(Number(limit) || 60, 300);
      // Coupled to the cap in the SAFE DIRECTION ONLY: a summary must never outgrow
      // the cap, but it must not inflate just because the cap did -- the whole point
      // is that a routine queue check stays cheap.
      const SUM_BUDGET = Math.min(20000, PC_RESULT_MAX - 4000);
      const whole = (d: any) => ({ ...(d.data() || {}), id: d.id });
      const proj = (d: any) => {
        const v = d.data() || {};
        const p = (v && typeof v.payload === 'object' && v.payload) ? v.payload : {};
        return { id: d.id, title: String(v.title || '').slice(0, 90),
          role: v.assigned_role || '', status: v.status || '',
          at: (v.created_at && v.created_at._seconds) || null,
          pk: Object.keys(p).length, pc: JSON.stringify(p).length };
      };
      // ids[] is a DRILL-IN, not a filter: it reads whole documents BY ID and ignores
      // role/status, because the reason to name an id is that the summary already told
      // you which one you want. Doc-ref reads rather than a where-in: Firestore caps an
      // 'in' clause at 30 terms, and a query that refuses past 30 is a trap here.
      if (Array.isArray(ids) && ids.length) {
        const out: any[] = [], missing: string[] = [];
        for (const i of ids.slice(0, 25)) {
          const d = await db.collection('work_items').doc(String(i)).get();
          if (d.exists) out.push(whole(d)); else missing.push(String(i));
        }
        return { content: [{ type: 'text', text: JSON.stringify({ mode: 'ids',
          requested: ids.length, shown: out.length, missing,
          truncated: ids.length > 25 ? 'only the first 25 ids were read' : undefined,
          items: out }, null, 2) }] };
      }
      let q: any = db.collection('work_items');
      if (role) q = q.where('assigned_role', '==', role);
      if (status && status !== 'all') q = q.where('status', '==', status);
      const snap = await q.limit(lim).get();
      const matched = snap.docs.length;
      if (detail) {
        // detail:true is the caller explicitly asking for everything and accepting the
        // cap's truncation. It is deliberately NOT budgeted: budgeting it would drop
        // items on the one path whose entire purpose is completeness.
        return { content: [{ type: 'text', text: JSON.stringify({ mode: 'detail',
          count: matched, limit: lim, detail: true, items: snap.docs.map(whole) }, null, 2) }] };
      }
      const items: any[] = [];
      let used = 0;
      for (const d of snap.docs) {
        const row = proj(d);
        const cost = JSON.stringify(row).length + 1;
        if (used + cost > SUM_BUDGET) break;
        used += cost; items.push(row);
      }
      const dropped = matched - items.length;
      // Summary is emitted COMPACT; the indent is ~30% of a summary result and buys
      // nothing a machine reads. detail keeps the indent -- there a person is reading
      // the payload.
      return { content: [{ type: 'text', text: JSON.stringify({ mode: 'summary',
        count: items.length, matched, limit: lim, detail: false,
        dropped_for_budget: dropped > 0 ? dropped : undefined,
        note: dropped > 0 ? ('THIS LIST IS SHORT BY ' + dropped + ' ITEM(S): the character budget ran out, NOT the queue. Narrow with role/status, or pass a smaller limit.') : undefined,
        legend: 'pk=payload key count, pc=payload chars, at=created_at epoch seconds',
        hint: 'payload omitted -- call again with ids:["<id>","<id>"] to read them in full',
        items }, null, 0) }] };
    });

  server.registerTool('read_journal',
    { description: 'Read recent fleet journal entries.', inputSchema: { limit: z.number().optional(), ...AG } },
    async ({ limit }: any) => {
      const snap = await db.collection('journal').orderBy('timestamp', 'desc').limit(limit || 25).get();
      return { content: [{ type: 'text', text: JSON.stringify(snap.docs.map((d: any) => d.data()), null, 2) }] };
    });

  // ---- MEMORY-V1 -- knowledge-graph memory over Firestore -----------------
  // Observations are DOCUMENTS, not strings: each carries confidence, author,
  // evidence, status and supersedes. That is what stops a retracted claim from
  // reading with the same authority as the correction that replaced it.
  const MEM_SIM = 0.86;
  const memScope = (s?: any) => (String(s || 'fleet') === 'own' ? agentId : 'fleet');
  const memKey = (s: string) => String(s).replace(/[^A-Za-z0-9_.:@-]/g, '_').slice(0, 180);
  const memEid = (sc: string, n: string) => memKey(sc) + '__' + memKey(n);
  const memOk = (v: any) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, ...v }, null, 2) }] });
  const memErr = (code: string, message: string) =>
    ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message }, null, 2) }], isError: true });

  // Embeddings fail OPEN: a null embedding degrades search to substring, it never
  // blocks a write. Memory that refuses to record because a side service is down
  // is the empty-pipe failure wearing a new hat.
  const memEmbed = async (text: string): Promise<number[] | null> => {
    try {
      // [FLEET-MODE-V1] EMBEDDINGS FAIL OPEN ON FUNCTION AND CLOSED ON SPEND, AND THAT
      // LOOKS LIKE AN EXCEPTION TO THE RULE. IT IS NOT, SO READ THIS BEFORE CHANGING IT.
      // Everywhere else in this file an off mode THROWS, because the caller is a chat turn
      // and a human is waiting for an answer that is not coming. Here the caller is a
      // memory WRITE, and this function's existing contract -- stated eleven lines above --
      // is that a null embedding degrades search to substring and NEVER blocks the write.
      // Throwing here would make memory refuse to RECORD an observation because a side
      // service is off. That is the empty-pipe failure wearing a new hat: the record of
      // what happened is lost, permanently, to protect a budget it never touched.
      // The spend half is still CLOSED -- returning null is a refusal, and it happens
      // BEFORE the metadata server is asked for anything, so no request leaves the process.
      // Vertex is the only transport this function has ever had: it authenticates off the
      // instance metadata server and there is no API key path to reach.
      // [SEC-FLEETMODE-CONSOLE-V1] AND THIS IS THE ONE TRANSPORT THAT KEEPS THE CHECK.
      // The other three are reached only from a request a signed-in human made at the
      // console, and are ungated there. This one is reached from an MCP tool, which a
      // runner-driven strain can call with nobody watching -- the unattended,
      // machine-initiated spend the switch exists to refuse. So it stays, and the refusal
      // now SAYS SO: a bare `return null` left an operator whose memory search had quietly
      // degraded to substring with nothing to read. Nothing else changes -- no request
      // leaves the process, and the write it serves still goes through.
      const _fmMode = await fleetMode();
      if (!fleetTransportAllowed(_fmMode, 'vertex')) {
        console.log('[memory/embed] ' + fleetRefusalText(_fmMode, 'the memory embedding', 'vertex'));
        return null;
      }
      const LOC = process.env.VERTEX_LOCATION || 'us-central1';
      // [SEC-NO-OPERATOR-PROJECT-V1] No hardcoded project id. It leaked the operator's
      // project into every adopter's tree, where it is also simply WRONG -- their
      // embeddings would call Vertex in someone else's project. The metadata server
      // already answers this, and this function queries it for a token anyway.
      let PROJ = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
      if (!PROJ) {
        const pr: any = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id',
          { headers: { 'Metadata-Flavor': 'Google' } } as any);
        if (pr.ok) PROJ = (await pr.text()).trim();
      }
      // Fails OPEN, per the contract stated six lines above: a null embedding degrades
      // search to substring and never blocks a write.
      if (!PROJ) return null;
      const tr: any = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } } as any);
      if (!tr.ok) return null;
      const tok = (await tr.json()).access_token;
      const r: any = await fetch('https://' + LOC + '-aiplatform.googleapis.com/v1/projects/' + PROJ +
        '/locations/' + LOC + '/publishers/google/models/text-embedding-005:predict',
        { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances: [{ content: String(text).slice(0, 8000) }] }) } as any);
      if (!r.ok) return null;
      const j: any = await r.json();
      const v = j && j.predictions && j.predictions[0] && j.predictions[0].embeddings && j.predictions[0].embeddings.values;
      return Array.isArray(v) ? v : null;
    } catch (e) { return null; }
  };
  const memCos = (a: number[], b: number[]) => {
    let d = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
  const memOverlap = (a: string, b: string) => {
    const tk = (s: string) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
    const A = tk(a), B = tk(b); if (!A.size || !B.size) return 0;
    let i = 0; A.forEach(w => { if (B.has(w)) i++; });
    return i / Math.min(A.size, B.size);
  };
  const memEntCol = () => db.collection('memory_entities');

  // ---- CONTEXT DELIVERY: whoami CARRIES memory, then the bootstrap ----------
  // Availability is not delivery. Both the bootstrap and the graph were correct,
  // reachable and unread on 2026-08-05. whoami is the one call no strain can
  // skip, so it is where context arrives.
  // MEMORY COMES FIRST, BOOTSTRAP SECOND: the rules are the thing most likely to
  // be forgotten, so they sit closest to the end of the payload.
  // ONE bootstrap file. No fallback. Two files is how a fleet ends up obeying
  // the stale one.
  const CTX_BOOTSTRAP_PATH = 'shared/fleet/BOOTSTRAP.md';
  const CTX_TTL_MS = 60000;
  const ctxCache: any = { at: 0, boot: '', mem: '', sha: '' };

  const ctxBootstrap = async (): Promise<string> => {
    try {
      const t = await harReadLake(CTX_BOOTSTRAP_PATH);
      if (t && t.trim().length > 200) return t;
    // [SEC-BOOTSTRAP-ABSENT-V90] ABSENT AND EMPTY ARE DIFFERENT PROBLEMS AND THIS REPORTED BOTH
    // AS "empty or truncated". harReadLake returns '' for a MISSING object and for a zero-byte
    // one alike, so a FRESH INSTALL -- where nothing has ever written this file -- told the agent
    // the file existed. MEASURED on a real adopter install 2026-08-16: that prefix was entirely
    // empty and the message still claimed the file was there. An operator cannot act on that:
    // repairing a truncated file and creating the first one are different jobs. The probe runs
    // only on the already-degraded path, so the healthy case costs nothing.
    let pcPresent = false;
    try {
      pcPresent = (await getStorage().bucket(pcLakeBucket()).file(CTX_BOOTSTRAP_PATH).exists())[0];
    } catch (e2) { pcPresent = false; }
    if (!pcPresent) {
      return 'BOOTSTRAP_ABSENT: ' + CTX_BOOTSTRAP_PATH + ' does not exist in this lake, so no '
        + 'rules have ever been delivered to this install. You are operating with NO delivered '
        + 'rules: tell the operator before you do anything privileged. It is fixed by creating '
        + 'the file -- write_file ' + CTX_BOOTSTRAP_PATH + ' -- and every agent picks it up '
        + 'within a minute.';
    }
    return 'BOOTSTRAP_EMPTY: ' + CTX_BOOTSTRAP_PATH + ' exists but holds only '
      + String((t || '').trim().length) + ' characters, under the 200 this check requires. '
      + 'You are operating with NO delivered rules. Tell the operator before you do anything privileged.';
  } catch (e) {
    return 'BOOTSTRAP_UNREADABLE: ' + CTX_BOOTSTRAP_PATH + ' exists but could not be read -- a '
      + 'decrypt failure or a storage error, NOT a missing file. '
      + 'You are operating with NO delivered rules. Tell the operator before you do anything privileged. '
      + 'Do NOT substitute another file.';
    }
  };

  // [MEM-DIGEST-RETRIEVE-V1] THE DIGEST IS AN INDEX, NOT THE WHOLE GRAPH.
  // It used to be a fleet-wide CHARACTER SLICE over entities in ASCII name order, and it
  // silently lost everything past 'l'. The repository entity -- which carries WHERE THE
  // REPOSITORY LIVES -- and pc-git-mcp -- whose entire content is a "stop measuring this
  // dead service" warning -- both sort past the cut and reached no strain at all.
  // Doctrine is LAWS INJECT, LESSONS RETRIEVE. The graph is lessons, so it retrieves.
  // Four properties, in the order they are load-bearing:
  //   A EVERY entity NAME always ships, uncapped, and FIRST, so no later budget can cut
  //     it. A strain that sees a name knows to search_nodes for the rest.
  //   C The header states the REAL NUMBERS. A silent cut is indistinguishable from an
  //     empty graph -- which is exactly how a strain read two git entities and concluded
  //     the graph knew git BEHAVIOURS but not the repository's LOCATION.
  //   B The observation budget is PER ENTITY, not per fleet, so the alphabetically lucky
  //     stop spending the whole allowance. Rank WITHIN an entity by confidence
  //     (measured > inferred > reported) then recency. 'inferred' used to be filtered out
  //     of the digest entirely; it is ranked below measured now instead of discarded.
  //   D A PINNED set always ships in full and is never dropped for budget. A constant
  //     here, deliberately, rather than a new schema field: no migration, and the list is
  //     visible to whoever reads this function.
  // The DETAILED tier is still ORDERED -- something has to choose who gets depth -- but by
  // pinned-then-recency, never by name. Entities are NOT renamed to win a sort: that would
  // break every supersedes chain pointing at them.
  const CTX_MEM_MAX = 24000;
  // Entity names pinned to the top of the digest. These four are the PRODUCT's own entities
  // and exist in every install. An operator who keeps a governance document as a graph entity
  // pins it by NAME with MEM_PINNED_EXTRA=<name>[,<name>] rather than by editing this file.
  const CTX_MEM_PIN_EXTRA = String(process.env.MEM_PINNED_EXTRA || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const CTX_MEM_PINNED = [PC_REPO_ID + '.git', 'pc-git-mcp', 'bootstrap-paste', 'MEMORY-V1'].concat(CTX_MEM_PIN_EXTRA);
  const CTX_MEM_PIN_OBS = 8;
  const CTX_MEM_DETAIL_OBS = 2;
  const CTX_MEM_OBS_CHARS = 400;
  const CTX_MEM_HEAD_RESERVE = 400;
  const memConfRank = (c: any) => (c === 'measured' ? 0 : c === 'inferred' ? 1 : 2);

  const ctxMemory = async (): Promise<string> => {
    try {
      const ents: any[] = [];
      for (const sc of ['fleet', agentId]) {
        const snap = await db.collection('memory_entities').where('scope', '==', sc).limit(400).get();
        for (const d of snap.docs) {
          const e = d.data();
          if (e.status === 'retracted') continue;
          const os = await d.ref.collection('observations').where('status', '==', 'active')
            .orderBy('createdAt', 'desc').limit(25).get();
          // Firestore returned these createdAt DESC, so the array index IS the recency
          // rank. Carry it explicitly rather than leaning on the sort being stable.
          const obs = os.docs.map((o: any, i: number) => {
            const v = o.data();
            return { conf: String(v.confidence || 'reported'), text: String(v.text || ''), rec: i };
          });
          obs.sort((x: any, y: any) => (memConfRank(x.conf) - memConfRank(y.conf)) || (x.rec - y.rec));
          const nm = String(e.name || '');
          ents.push({
            name: nm, type: String(e.entityType || '?'), scope: sc,
            pin: CTX_MEM_PINNED.indexOf(nm),
            upd: (e.updatedAt && typeof e.updatedAt.toMillis === 'function') ? e.updatedAt.toMillis() : 0,
            obs
          });
        }
      }
      // [SEC-FRESH-INSTALL-V1] AN EMPTY GRAPH IS THE NORMAL STATE OF A NEW INSTALL, AND
      // '(memory empty)' READ LIKE A BROKEN ONE. Operator report 2026-08-18: agents on a
      // first run were confused about what they were looking at. This is the first thing
      // whoami hands them, so it is the right place to say which situation they are in --
      // and to point at the one capability a first session most often needs and cannot see
      // from the tool list alone, which is that a build starts with git_archive.
      if (!ents.length) return [
        'THIS INSTALL HAS NO FLEET MEMORY YET. That is the expected state of a NEW install,',
        'not a fault and not a read failure: nothing has been measured here yet, so there is',
        'nothing for you to be contradicting. You are the first session.',
        '',
        'WHAT THAT MEANS FOR YOU RIGHT NOW:',
        '  * Do not go looking for prior context. There is none. Measure what you need.',
        '  * Write back what you measure, with add_observations, in the same session. The next',
        '    agent starts with whatever you leave and nothing else.',
        '  * The repository is NOT empty even though memory is -- install.sh seeded the shipped',
        '    release tree into it. git_archive returns the whole ref in ONE call and is how you',
        '    get a buildable tree; git_read/git_list work file by file. Do not reconstruct a',
        '    checkout out of diffs.',
        '  * Build and deploy from that tree: build, deploy at ZERO traffic behind a tag,',
        '    verify the tagged URL, then shift. Read the serving revision out of the service,',
        '    never out of the deploy command output.',
      ].join('\n');

      // A -- the complete name list, uncapped, emitted BEFORE anything a budget can trim.
      const namesBlock = ents.slice()
        .sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((e: any) => '    ' + e.name + ' (' + e.type + ')').join('\n');

      // The DETAILED tier: pinned in declared order, then most recently updated.
      const order = ents.slice().sort((a: any, b: any) => {
        const ap = a.pin >= 0, bp = b.pin >= 0;
        if (ap !== bp) return ap ? -1 : 1;
        if (ap && bp) return a.pin - b.pin;
        if (a.upd !== b.upd) return b.upd - a.upd;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      let budget = CTX_MEM_MAX - namesBlock.length - CTX_MEM_HEAD_RESERVE;
      const detail: string[] = [];
      let detailed = 0;
      for (const e of order) {
        if (!e.obs.length) continue;
        const pinned = e.pin >= 0;
        const lines = e.obs.slice(0, pinned ? CTX_MEM_PIN_OBS : CTX_MEM_DETAIL_OBS)
          .map((v: any) => '    [' + v.conf + '] ' + v.text.slice(0, CTX_MEM_OBS_CHARS));
        const block = '  ' + e.name + ' (' + e.type + ', ' + e.scope + ')\n' + lines.join('\n');
        // D -- a pinned entity is never dropped for budget. Everything else yields.
        if (!pinned && (block.length + 1) > budget) continue;
        detail.push(block); budget -= block.length + 1; detailed++;
      }

      // C -- real numbers, always, even when nothing was trimmed.
      const namesOnly = ents.length - detailed;
      const head = ents.length + ' entities: ' + detailed + ' detailed, ' + namesOnly
        + ' names only. THIS IS AN INDEX, NOT THE WHOLE GRAPH -- search_nodes or open_nodes'
        + ' by name for anything not expanded below.';
      return [head, '', '  ALL ENTITIES (' + ents.length + '):', namesBlock, '', detail.join('\n')].join('\n');
    } catch (e: any) { return 'MEMORY_DIGEST_UNAVAILABLE: ' + String((e && e.message) || e); }
  };

  // [SEC-STRAIN-CHARTER-V90] EACH STRAIN IS ALSO HANDED ITS OWN JOB, NOT ONLY THE FLEET RULES.
// BOOTSTRAP.md says how every strain works here; this says what THIS one owns, what to ask it,
// and what it must not do. Both are lake objects the operator can edit, and editing the charter
// is the intended way to steer a strain -- not repeating yourself in every chat.
// A strain with no charter file is normal and silent: the section is simply omitted. This is
// additive, so an install that predates the charters, or an operator who deletes one, loses
// nothing.
// THE ROLE IS VALIDATED BEFORE IT BECOMES A PATH. It arrives from a resolved session key rather
// than from a tool argument, but it is still concatenated into an object name, and a component
// that can contain a slash or a dot-dot is how a read escapes its prefix. Anything that is not
// a plain lowercase role name yields no charter rather than a guess.
// Derived from the bootstrap path rather than written out again, so the two cannot drift and
// the fleet prefix is defined in exactly one place.
const CTX_CHARTER_DIR = CTX_BOOTSTRAP_PATH.replace(/[^/]+$/, '') + 'strains/';
const ctxCharterCache: any = {};
const ctxCharter = async (role: string): Promise<string> => {
  if (!role || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(role)) return '';
  const now = Date.now();
  const hit = ctxCharterCache[role];
  if (hit && (now - hit.at) < CTX_TTL_MS) return hit.text;
  let text = '';
  try {
    const t = await harReadLake(CTX_CHARTER_DIR + role + '.md');
    if (t && t.trim().length > 100) text = t;
  } catch (e) { text = ''; }
  ctxCharterCache[role] = { at: now, text: text };
  return text;
};
const ctxBuild = async () => {
    const now = Date.now();
    if (ctxCache.sha && (now - ctxCache.at) < CTX_TTL_MS) return ctxCache;
    // ctxMemory budgets itself now. This is only a RUNAWAY STOP, set well above
    // CTX_MEM_MAX so it never trims a normal digest -- and the name list is emitted
    // FIRST precisely so that even this net cannot cost a strain an entity name.
    const mem = (await ctxMemory()).slice(0, 48000);
    const boot = await ctxBootstrap();
    const sha = require('crypto').createHash('sha256').update(mem + '\u0000' + boot).digest('hex').slice(0, 16);
    ctxCache.at = now; ctxCache.mem = mem; ctxCache.boot = boot; ctxCache.sha = sha;
    return ctxCache;
  };
  // ---- end CONTEXT DELIVERY -------------------------------------------------
  const memRelCol = () => db.collection('memory_relations');

  const memReindex = async (eref: any) => {
    const act = await eref.collection('observations').where('status', '==', 'active')
      .orderBy('createdAt', 'desc').limit(25).get();
    const e = (await eref.get()).data() || {};
    const txt = [e.name, e.entityType].concat(act.docs.map((d: any) => String(d.data().text || ''))).join(' | ').slice(0, 6000);
    await eref.update({ searchText: txt, embedding: await memEmbed(txt), updatedAt: FieldValue.serverTimestamp() });
  };

  const memAddObs = async (sc: string, entityName: string, c: any) => {
    const eref = memEntCol().doc(memEid(sc, entityName));
    if (!(await eref.get()).exists) throw new Error('ENTITY_NOT_FOUND: ' + entityName);
    const o = (typeof c === 'string') ? { text: c } as any : (c || {});
    const text = String(o.text || '').trim();
    if (!text) throw new Error('EMPTY_OBSERVATION');
    // A bare string defaults to the WEAKEST confidence on purpose: laziness must
    // degrade trust, never inflate it.
    const conf = ['measured', 'inferred', 'reported'].indexOf(String(o.confidence)) >= 0 ? String(o.confidence) : 'reported';
    const emb = await memEmbed(text);
    const act = await eref.collection('observations').where('status', '==', 'active').limit(100).get();
    const contradictions: any[] = [];
    act.docs.forEach((d: any) => {
      const p = d.data(); const prev = String(p.text || '');
      if (prev === text) return;
      const sim = (emb && Array.isArray(p.embedding) && p.embedding.length) ? memCos(emb, p.embedding) : memOverlap(text, prev);
      if (sim >= MEM_SIM) contradictions.push({ obsId: d.id, text: prev, confidence: p.confidence, similarity: Number(sim.toFixed(3)) });
    });
    const oref = eref.collection('observations').doc();
    await db.runTransaction(async (tx: any) => {
      tx.set(oref, { text, confidence: conf, evidence: o.evidence || null, author: agentId,
        session: o.session || null, createdAt: FieldValue.serverTimestamp(), status: 'active',
        supersedes: o.supersedes || null, supersededBy: null, embedding: emb });
      if (o.supersedes) tx.update(eref.collection('observations').doc(String(o.supersedes)),
        { status: 'superseded', supersededBy: oref.id });
      else tx.update(eref, { obsActive: FieldValue.increment(1) });
    });
    await memReindex(eref);
    return { entity: entityName, obsId: oref.id, confidence: conf, embedded: !!emb, contradictions };
  };

  server.registerTool('create_entities',
    { description: 'Create knowledge-graph entities. IDEMPOTENT: a name already present in the scope comes back as existing, never duplicated. scope: "fleet" (default, shared and attributed) or "own" (your role only). Optional observations follow add_observations rules.',
      inputSchema: { entities: z.array(z.object({ name: z.string(), entityType: z.string(), observations: z.array(z.any()).optional() })), scope: z.string().optional(), ...AG } },
    async ({ entities, scope }: any) => { try {
      const sc = memScope(scope); const created: string[] = [], existing: string[] = [], obs: any[] = [];
      for (const e of (entities || [])) {
        const ref = memEntCol().doc(memEid(sc, e.name));
        if ((await ref.get()).exists) existing.push(e.name);
        else { await ref.set({ scope: sc, name: String(e.name), entityType: String(e.entityType || 'thing'),
          aliases: [], createdBy: agentId, createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(), obsActive: 0, status: 'active', searchText: '', embedding: null });
          created.push(e.name); }
        for (const c of (e.observations || [])) obs.push(await memAddObs(sc, e.name, c));
      }
      return memOk({ scope: sc, created, existing, observations: obs });
    } catch (e: any) { return memErr('CREATE_ENTITIES_FAILED', String((e && e.message) || e)); } });

  server.registerTool('add_observations',
    { description: 'Attach atomic facts to entities. Each content is a plain string (recorded as confidence "reported", the weakest) or an object { text, confidence: "measured"|"inferred"|"reported", evidence?: {job_id,path,generation,url,revision}, supersedes?: obsId }. Claim "measured" ONLY for something a tool actually returned. The result carries contradictions[] when a new fact closely matches an existing active one -- re-issue with supersedes to replace it explicitly. Nothing is auto-superseded.',
      inputSchema: { observations: z.array(z.object({ entityName: z.string(), contents: z.array(z.any()) })), scope: z.string().optional(), ...AG } },
    async ({ observations, scope }: any) => { try {
      const sc = memScope(scope); const out: any[] = [];
      for (const o of (observations || [])) for (const c of (o.contents || [])) out.push(await memAddObs(sc, o.entityName, c));
      return memOk({ scope: sc, written: out, contradicted: out.filter((x: any) => x.contradictions && x.contradictions.length).length });
    } catch (e: any) { return memErr('ADD_OBSERVATIONS_FAILED', String((e && e.message) || e)); } });

  server.registerTool('create_relations',
    { description: 'Create directed edges between entities, in active voice (fleet-security -> staged -> job:QxqG). Idempotent on (from, relationType, to) within a scope.',
      inputSchema: { relations: z.array(z.object({ from: z.string(), relationType: z.string(), to: z.string() })), scope: z.string().optional(), ...AG } },
    async ({ relations, scope }: any) => { try {
      const sc = memScope(scope); const created: any[] = [], existing: any[] = [];
      for (const r of (relations || [])) {
        const id = memKey(sc) + '__' + memKey(r.from) + '__' + memKey(r.relationType) + '__' + memKey(r.to);
        const ref = memRelCol().doc(id);
        if ((await ref.get()).exists) existing.push(r);
        else { await ref.set({ scope: sc, from: String(r.from), to: String(r.to), relationType: String(r.relationType),
          createdBy: agentId, createdAt: FieldValue.serverTimestamp(), status: 'active' }); created.push(r); }
      }
      return memOk({ scope: sc, created, existing });
    } catch (e: any) { return memErr('CREATE_RELATIONS_FAILED', String((e && e.message) || e)); } });

  // The three delete_* tools RETRACT. Nothing is erased: status becomes "retracted" and the
  // record stays readable -- that IS the undo, and it is the only one. NOTE THE SCOPE, because
  // it is narrower than it looks: the
  // DATA LAKE has no delete tool, so a stray lake write cannot be undone by any role. The
  // REPOSITORY is NOT covered by that -- the git tools can remove a path outright. Hard
  // deletion of a memory record is a gated job, never a tool call.
  server.registerTool('delete_entities',
    { description: 'RETRACT entities and their active observations. Nothing is erased: status becomes "retracted" and stays readable with includeRetracted:true. Hard deletion is a gated job.',
      inputSchema: { entityNames: z.array(z.string()), scope: z.string().optional(), ...AG } },
    async ({ entityNames, scope }: any) => { try {
      const sc = memScope(scope); const done: string[] = [];
      for (const n of (entityNames || [])) {
        const eref = memEntCol().doc(memEid(sc, n));
        if (!(await eref.get()).exists) continue;
        const act = await eref.collection('observations').where('status', '==', 'active').get();
        const b = db.batch();
        act.docs.forEach((d: any) => b.update(d.ref, { status: 'retracted' }));
        b.update(eref, { status: 'retracted', obsActive: 0, updatedAt: FieldValue.serverTimestamp() });
        await b.commit(); done.push(n);
      }
      return memOk({ scope: sc, retracted: done });
    } catch (e: any) { return memErr('DELETE_ENTITIES_FAILED', String((e && e.message) || e)); } });

  server.registerTool('delete_observations',
    { description: 'RETRACT specific observations by obsId or exact text. The record is kept, marked "retracted".',
      inputSchema: { deletions: z.array(z.object({ entityName: z.string(), observations: z.array(z.string()) })), scope: z.string().optional(), ...AG } },
    async ({ deletions, scope }: any) => { try {
      const sc = memScope(scope); let total = 0;
      for (const d of (deletions || [])) {
        const eref = memEntCol().doc(memEid(sc, d.entityName));
        const act = await eref.collection('observations').where('status', '==', 'active').get();
        const b = db.batch(); let n = 0;
        act.docs.forEach((doc: any) => {
          const t = String(doc.data().text || '');
          if ((d.observations || []).some((x: string) => x === doc.id || x === t)) { b.update(doc.ref, { status: 'retracted' }); n++; }
        });
        if (n) { b.update(eref, { obsActive: FieldValue.increment(-n), updatedAt: FieldValue.serverTimestamp() });
          await b.commit(); await memReindex(eref); total += n; }
      }
      return memOk({ scope: sc, retracted: total });
    } catch (e: any) { return memErr('DELETE_OBSERVATIONS_FAILED', String((e && e.message) || e)); } });

  server.registerTool('delete_relations',
    { description: 'RETRACT edges. Kept with status "retracted".',
      inputSchema: { relations: z.array(z.object({ from: z.string(), relationType: z.string(), to: z.string() })), scope: z.string().optional(), ...AG } },
    async ({ relations, scope }: any) => { try {
      const sc = memScope(scope); let n = 0;
      for (const r of (relations || [])) {
        const id = memKey(sc) + '__' + memKey(r.from) + '__' + memKey(r.relationType) + '__' + memKey(r.to);
        const ref = memRelCol().doc(id);
        if ((await ref.get()).exists) { await ref.update({ status: 'retracted' }); n++; }
      }
      return memOk({ scope: sc, retracted: n });
    } catch (e: any) { return memErr('DELETE_RELATIONS_FAILED', String((e && e.message) || e)); } });

  server.registerTool('read_graph',
    { description: 'Read the graph. BOUNDED BY DEFAULT: returns counts by type and recently updated entities so memory cannot flood your context. detail:true adds active observations, still capped by limit. Reads merge the fleet scope and your own.',
      inputSchema: { scope: z.string().optional(), entityType: z.string().optional(), limit: z.number().optional(), detail: z.boolean().optional(), includeRetracted: z.boolean().optional(), ...AG } },
    async ({ scope, entityType, limit, detail, includeRetracted }: any) => { try {
      const lim = Math.min(Number(limit) || 100, 300);
      const scopes = scope ? [memScope(scope)] : ['fleet', agentId];
      const byType: any = {}; const nodes: any[] = []; const rels: any[] = [];
      for (const sc of scopes) {
        let q: any = memEntCol().where('scope', '==', sc);
        if (entityType) q = q.where('entityType', '==', entityType);
        const snap = await q.limit(lim).get();
        for (const d of snap.docs) {
          const e = d.data();
          if (!includeRetracted && e.status === 'retracted') continue;
          byType[e.entityType] = (byType[e.entityType] || 0) + 1;
          const node: any = { scope: e.scope, name: e.name, entityType: e.entityType, obsActive: e.obsActive || 0 };
          if (detail) {
            const os = await d.ref.collection('observations').where('status', '==', 'active')
              .orderBy('createdAt', 'desc').limit(25).get();
            node.observations = os.docs.map((o: any) => { const v = o.data();
              return { obsId: o.id, text: v.text, confidence: v.confidence, author: v.author, evidence: v.evidence }; });
          }
          nodes.push(node);
        }
        const rs = await memRelCol().where('scope', '==', sc).limit(lim).get();
        rs.docs.forEach((d: any) => { const r = d.data();
          if (includeRetracted || r.status !== 'retracted') rels.push({ from: r.from, relationType: r.relationType, to: r.to }); });
      }
      return memOk({ scopes, entityCount: nodes.length, byType, relationCount: rels.length, entities: nodes, relations: rels, detail: !!detail });
    } catch (e: any) { return memErr('READ_GRAPH_FAILED', String((e && e.message) || e)); } });

  server.registerTool('search_nodes',
    { description: 'Find entities by meaning. Ranks by embedding cosine similarity when embeddings exist, falling back to substring over name, type and observation text. minConfidence:"measured" returns only entities carrying at least one measured fact -- use it when you are about to act on what you find.',
      inputSchema: { query: z.string(), scope: z.string().optional(), limit: z.number().optional(), minConfidence: z.string().optional(), includeRetracted: z.boolean().optional(), ...AG } },
    async ({ query, scope, limit, minConfidence, includeRetracted }: any) => { try {
      const lim = Math.min(Number(limit) || 20, 100);
      const scopes = scope ? [memScope(scope)] : ['fleet', agentId];
      const qe = await memEmbed(String(query));
      const scored: any[] = [];
      for (const sc of scopes) {
        const snap = await memEntCol().where('scope', '==', sc).limit(400).get();
        for (const d of snap.docs) {
          const e = d.data();
          if (!includeRetracted && e.status === 'retracted') continue;
          const hay = String(e.searchText || (e.name + ' ' + e.entityType));
          const s = (qe && Array.isArray(e.embedding) && e.embedding.length) ? memCos(qe, e.embedding) : memOverlap(String(query), hay);
          const sub = hay.toLowerCase().indexOf(String(query).toLowerCase()) >= 0;
          if (s > 0.2 || sub) scored.push({ ref: d.ref, scope: e.scope, name: e.name, entityType: e.entityType,
            score: Number((sub ? Math.max(s, 0.5) : s).toFixed(3)) });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const out: any[] = [];
      for (const t of scored.slice(0, lim)) {
        const os = await t.ref.collection('observations').where('status', '==', 'active')
          .orderBy('createdAt', 'desc').limit(10).get();
        let obs = os.docs.map((o: any) => { const v = o.data();
          return { obsId: o.id, text: v.text, confidence: v.confidence, author: v.author, evidence: v.evidence }; });
        if (minConfidence === 'measured') { obs = obs.filter((o: any) => o.confidence === 'measured'); if (!obs.length) continue; }
        out.push({ scope: t.scope, name: t.name, entityType: t.entityType, score: t.score, observations: obs });
      }
      return memOk({ query, scopes, matched: out.length, embedded: !!qe, results: out });
    } catch (e: any) { return memErr('SEARCH_NODES_FAILED', String((e && e.message) || e)); } });

  server.registerTool('open_nodes',
    { description: 'Open entities by exact name with their observations and the edges touching them. includeRetracted:true shows superseded and retracted history -- that is how you tell a corrected claim from a current one.',
      inputSchema: { names: z.array(z.string()), scope: z.string().optional(), includeRetracted: z.boolean().optional(), ...AG } },
    async ({ names, scope, includeRetracted }: any) => { try {
      const scopes = scope ? [memScope(scope)] : ['fleet', agentId];
      const out: any[] = [], missing: string[] = [];
      for (const n of (names || [])) {
        let found = false;
        for (const sc of scopes) {
          const eref = memEntCol().doc(memEid(sc, n)); const d = await eref.get();
          if (!d.exists) continue; found = true; const e = d.data();
          let q: any = eref.collection('observations');
          if (!includeRetracted) q = q.where('status', '==', 'active');
          const os = await q.orderBy('createdAt', 'desc').limit(50).get();
          const rf = await memRelCol().where('scope', '==', sc).where('from', '==', n).limit(50).get();
          const rt = await memRelCol().where('scope', '==', sc).where('to', '==', n).limit(50).get();
          out.push({ scope: sc, name: e.name, entityType: e.entityType, status: e.status,
            observations: os.docs.map((o: any) => { const v = o.data();
              return { obsId: o.id, text: v.text, confidence: v.confidence, status: v.status, author: v.author,
                evidence: v.evidence, supersedes: v.supersedes, supersededBy: v.supersededBy }; }),
            relations: { out: rf.docs.map((x: any) => x.data()), in: rt.docs.map((x: any) => x.data()) } });
        }
        if (!found) missing.push(n);
      }
      return memOk({ scopes, found: out.length, missing, nodes: out });
    } catch (e: any) { return memErr('OPEN_NODES_FAILED', String((e && e.message) || e)); } });
  // ---- end MEMORY-V1 ------------------------------------------------------

  server.registerTool('append_journal',
    { description: 'Append a fleet journal entry, attributed to your resolved role (see whoami).',
      inputSchema: { action: z.string(), message: z.string(), ...AG } },
    async (a: any) => {
      await db.collection('journal').add({ agent_id: who(a), action: a.action, message: a.message, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `journaled as ${who(a)}` }] };
    });

  server.registerTool('post_work_item',
    { description: 'Create a work item for a role.',
      inputSchema: { title: z.string(), assigned_role: z.string(), payload: z.record(z.string(), z.any()).optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('work_items').doc();
      await ref.set({ id: ref.id, title: a.title, assigned_role: a.assigned_role, status: 'pending', payload: a.payload || {}, created_by: who(a), created_at: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `created work item ${ref.id}` }] };
    });

  server.registerTool('complete_work_item',
    { description: 'Close a work item (bookkeeping; any role may close). Sets status=completed, records who closed it, and journals it.',
      inputSchema: { id: z.string(), note: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('work_items').doc(a.id);
      const snap = await ref.get();
      if (!snap.exists) return { content: [{ type: 'text', text: `no work item ${a.id}` }] };
      await ref.update({ status: 'completed', completed_by: who(a), completed_at: FieldValue.serverTimestamp() });
      await db.collection('journal').add({ agent_id: who(a), action: 'complete_work_item', message: `Completed work item ${a.id}${a.note ? ': ' + a.note : ''}.`, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `completed work item ${a.id} as ${who(a)}` }] };
    });

  server.registerTool('cancel_work_item',
    { description: 'Cancel a work item (bookkeeping; any role may cancel). Sets status=cancelled, records who cancelled it, and journals it.',
      inputSchema: { id: z.string(), note: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('work_items').doc(a.id);
      const snap = await ref.get();
      if (!snap.exists) return { content: [{ type: 'text', text: `no work item ${a.id}` }] };
      await ref.update({ status: 'cancelled', cancelled_by: who(a), cancelled_at: FieldValue.serverTimestamp() });
      await db.collection('journal').add({ agent_id: who(a), action: 'cancel_work_item', message: `Cancelled work item ${a.id}${a.note ? ': ' + a.note : ''}.`, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `cancelled work item ${a.id} as ${who(a)}` }] };
    });

  server.registerTool('stage_privileged_job',
    { description: 'Run a privileged job. With PC_AUTO_APPROVE=1 (THE SHIPPED DEFAULT -- install.sh sets it to 1) it is pre-approved, KMS-signed and EXECUTED in this call, and the result comes straight back -- there is no approval console and nothing to go and tap. Read the first word of the result: RAN means it executed, STAGED means PC_AUTO_APPROVE is off and it is sitting unrun. Destructive bodies also run by default, because install.sh ships PC_GUARDRAILS=0; set PC_GUARDRAILS=1 to have them refused and returned to chat instead. Both defaults are a deliberate product decision -- this fleet is built to ACCELERATE security-minded agentic engineering, so the pre-ship checks stay and the runtime speed bumps go; the work is still classified, KMS-signed and journalled.',
      inputSchema: { command_type: z.string(), command: z.string().optional(), target: z.string().optional(), ...AG } },
    async (a: any) => {
      const _sdr = pcSecretDestroyRefusal(String(a.command || ''));
      if (_sdr) return { content: [{ type: 'text', text: _sdr }], isError: true };
      const ref = db.collection('pending_confirms').doc();
      const jargs: any = {}; if (a.command) jargs.command = a.command; if (a.target) jargs.targetNode = a.target;
      const _adm = await pcAdmitStage(who(a), String(a.command_type || ''), jargs);
      if (!_adm.ok) return { content: [{ type: 'text', text: _adm.refusal }], isError: true };
      await ref.set({ job_id: ref.id, staged_by: who(a), command_type: a.command_type, arguments: jargs, status: 'pending', created_at: FieldValue.serverTimestamp(), command_sha256: _adm.sha });
      // [SEC-JOURNAL-TRUTH-V1] THIS LINE USED TO ASSERT AN APPROVAL THAT NEVER HAPPENED.
      // It wrote 'awaiting human approval' UNCONDITIONALLY, five lines above the pcAutoRun
      // call that executes the job in this same request. On a default install
      // (PC_AUTO_APPROVE=1) that made the FIRST journal entry about every auto-run job false,
      // and the journal is the audit trail an incident is reconstructed from -- the one record
      // that is supposed to outrank an agent's memory of what it believed. Read off the same
      // constant pcAutoRun branches on, so the two cannot drift.
      await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: PC_AUTO_APPROVE ? `Staged ${a.command_type} (${ref.id}) -- PRE-APPROVED AND EXECUTING IN THIS CALL under PC_AUTO_APPROVE=1. No human approved it.` : `Staged ${a.command_type} (${ref.id}) awaiting human approval.`, timestamp: FieldValue.serverTimestamp() });
      // [SEC-AUTORUN-SCOPE-V1] Auto-run like run_command does. Before this line the job was
      // written at 'pending' and left there for an approval console that no longer exists,
      // so this tool reported STAGED and then nothing ever happened. Same pre-approval, same
      // KMS signature, same executor rungs -- only the delivery of the approval changed.
      const _auto = await pcAutoRun(ref, ref.id, String(a.command_type || ''), String((jargs && jargs.command) || ''), false, a.confirm === true);
      if (_auto) return { content: [{ type: 'text', text: _auto }] };
      return { content: [{ type: 'text', text: `STAGED job ${ref.id} (${a.command_type}) — PC_AUTO_APPROVE is off, so this is waiting. There is no approval console: set PC_AUTO_APPROVE=1 or run it yourself.` }] };
    });

  server.registerTool('list_pending_confirm',
    { description: 'List privileged jobs sitting at pending. On a DEFAULT INSTALL this list SHOULD BE EMPTY, because install.sh sets PC_AUTO_APPROVE=1: a job is pre-approved, KMS-signed and EXECUTED in the call that staged it, so nothing accumulates here. That is a deliberate posture -- this fleet accelerates security-minded agentic engineering rather than putting a tap in front of work the operator has already asked for; every rung the executor checks still runs and every job is still journalled. A NON-EMPTY list therefore means one of two things: a job failed to reach the executor and was returned to pending, or this install has set PC_AUTO_APPROVE=0 to keep the per-job tap -- in which case a staged job sits here until the operator runs it themselves, because there is no approval console and it is NOT a queue anyone is going to come and tap.', inputSchema: { ...AG } },
    async () => {
      const snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(50).get();
      return { content: [{ type: 'text', text: JSON.stringify(snap.docs.map((d: any) => d.data()), null, 2) }] };
    });


  server.registerTool('run_command',
    { description: 'Run a shell command on the executor. The executor runs your script with PATH restricted to a directory of symlinks to an enumerated set of binaries, so an unlisted binary does not resolve -- `gsutil` and `ssh` answer "command not found". Shell builtins and keywords do not use PATH, so `set -uo pipefail` is unaffected. KNOWN GAP: an ABSOLUTE PATH still runs, so this is a real control and not a sandbox. What primarily gates this tool is unchanged: a human approved this exact command, and the executor refuses any script whose sha256 does not match the approval-time hash.',
      inputSchema: { command: z.string(), confirm: z.boolean().optional(), ...AG } },
    async (a: any) => {
      const _sdr = pcSecretDestroyRefusal(String(a.command || ''));
      if (_sdr) return { content: [{ type: 'text', text: _sdr }], isError: true };
      const ref = db.collection('pending_confirms').doc();
      // lockout_ack rides INSIDE arguments, so it is written before command_sha256 is
      // computed and is therefore covered by the approval signature the executor verifies.
      // An ack bolted on afterwards would be a field the signature does not cover, which is
      // the same shape as the approved_sha256 gap this fleet already had to close.
      const _confirm = a.confirm === true;
      const _jargs: any = _confirm ? { command: a.command, lockout_ack: true } : { command: a.command };
      const _adm = await pcAdmitStage(who(a), 'run_cmd', _jargs);
      if (!_adm.ok) return { content: [{ type: 'text', text: _adm.refusal }], isError: true };
      await ref.set({ job_id: ref.id, staged_by: who(a), command_type: 'run_cmd', arguments: _jargs, status: 'pending', created_at: FieldValue.serverTimestamp(), command_sha256: _adm.sha });
      await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: `Staged run_cmd (${ref.id})${_confirm ? ' [operator-confirmed in chat]' : ''}: ${a.command}`, timestamp: FieldValue.serverTimestamp() });
      const _auto = await pcAutoRun(ref, ref.id, 'run_cmd', String(a.command || ''), false, _confirm);
      if (_auto) return { content: [{ type: 'text', text: _auto }] };
      return { content: [{ type: 'text', text: `STAGED run_cmd job ${ref.id} — awaiting your confirm; runs only after you approve.` }] };
    });
  // [SEC-SSHTOOL-REMOVED-V1] ssh_executor USED TO BE REGISTERED HERE AND IS GONE.
  // It was an artifact of an earlier architecture that had addressable nodes. MEASURED before
  // removal, not assumed: no installer this product ships has ever created the private-key
  // secret it needed, and EXEC_SSH_KEY_SECRET is unset on BOTH prod services -- control plane
  // and gate-exec -- so every ssh job this tool could stage was refused, in every deployment
  // that has ever existed. It was never a path to the workstation VM either: that instance is
  // created --no-address with OS Login enforced and is reached with
  // `gcloud compute ssh --tunnel-through-iap`, which needs no key of ours and no route from
  // Cloud Run. A tool that cannot succeed anywhere is not a capability, it is a rake.
  //
  // THE EXECUTOR'S ssh BRANCH WENT WITH IT, so exec_server.py now has exactly one execution
  // path. The ctyp and asha fields stay in the V2 approval canon below -- see the comment
  // there. They were added BECAUSE an unsigned command_type could redirect an approved
  // command into the ssh branch, and they must outlive it: the day a second branch is added,
  // the gap reopens if the canon has meanwhile been narrowed to the one branch that remains.

  // ---- Chat-history log: per-ROLE, private, searchable (the operator's memory augmentation) ----
  server.registerTool('log_history',
    { description: "Append ONE turn to YOUR ROLE's private searchable history (scoped to your resolved role). role='user' for the operator, role='assistant' for you. This is the operator's memory augmentation; add short topic tags to make it findable. DECISIONS: tag an entry exactly `decision` ONLY when the operator genuinely has to choose something -- it will be put in front of him on every refresh until it is closed. CLOSE one by logging a later entry tagged `resolves:<id>`, id taken from open_decisions in refresh. A topic tag that merely contains the word (gate-exec, open_decisions) does NOT raise a decision.",
      inputSchema: { role: z.string(), text: z.string(), tags: z.array(z.string()).optional(), session: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('chat_history').doc();
      await ref.set({
        id: ref.id, agent_id: who(a), role: a.role, text: a.text,
        // [TAGS-COERCE-V1] THE THIRD SITE, and the one that does not throw -- which is why it is
        // the worse of the three. A bare string here is written to Firestore as a string, and
        // every reader of chat_history.tags in this file is already `Array.isArray(...) ? ... :
        // <empty>` (the decision/closure predicates, the topic tally, the history search), so a
        // string-tagged entry is stored successfully and is then invisible to every one of them.
        // A silent write that can never be read back is a worse outcome than a TypeError, so the
        // same coercion is applied here and the malformed field is dropped at the boundary.
        tags: Array.isArray(a.tags) ? a.tags : [], session: a.session || '',
        timestamp: FieldValue.serverTimestamp()
      });
      return { content: [{ type: 'text', text: `logged ${a.role} turn ${ref.id} as ${who(a)}` }] };
    });

  server.registerTool('search_history',
    { description: "Search YOUR ROLE's chat-history (scoped to your resolved role). Case-insensitive substring over text + tags. Empty query = most recent. Use FIRST when the operator references something from before. When live Firestore under-delivers, the BigQuery forever-archive is consulted too and an in-band [SEC-BQ-ARCHIVE-V1] notice reports the outcome.",
      inputSchema: { query: z.string().optional(), limit: z.number().optional(), role: z.string().optional(), ...AG } },
    async (a: any) => pcSearchHistoryImpl(who(a), a));

  server.registerTool('read_history',
    { description: "Read YOUR ROLE's most recent history in chronological order (scoped to your resolved role) to refresh at session start. When live Firestore under-delivers, the BigQuery forever-archive is consulted too and an in-band [SEC-BQ-ARCHIVE-V1] notice reports the outcome.",
      inputSchema: { limit: z.number().optional(), ...AG } },
    async (a: any) => pcReadHistoryImpl(who(a), a));

  // ---- Fleet DATA LAKE on Cloud Storage: private-per-agent + one shared drop zone ----
  // Layout: agents/<agent_id>/<path> = YOUR private space (no other agent can read it);
  //         shared/<path>            = the common drop zone every agent can read + write.
  // The boundary is enforced here against your SERVER-VERIFIED identity (token principal, C3), so an
  // agent cannot even address another agent's private folder — blast-radius containment.
  const lake = DATA_LAKE_BUCKET ? getStorage().bucket(DATA_LAKE_BUCKET) : null;
  // Private-per-ROLE (agents/<role>/) + one shared/ drop zone. Scoped to your RESOLVED role (see whoami) —
  // a role cannot address another role's private folder, and `agent` carries the session key that RESOLVES your role, so it selects which private folder is yours -- it cannot reach outside whichever role it resolves to.
  // ---- F1/F2: EXECUTABLE-WRITE BOUNDARY ------------------------------------------------------
  // The control plane LOADS AND EXECUTES objects under these prefixes: the loader require()s
  // shared/deploy/live/index.js on every boot, and deploy-cp-harness.sh cats shared/harness/,
  // shared/passkey/, shared/mcp-oauth/, shared/vault/ and shared/security/ into the served binary,
  // and shared/runner/ held the python the scheduled runners loaded before 12.5 deleted them;
  // that prefix stays denied anyway, for the reason FINDING 5.1 gives below. So a token-bound
  // role must never be able to WRITE them, or any strain token is RCE as the control plane.
  // READS are deliberately unaffected -- agents review this code, and denying reads would break
  // audit work without closing the hole.
  //
  // FINDING 5.1 -- READ THIS BEFORE YOU EDIT THE LIST. [FLEET-NO-SCHEDULED-RUNNERS-V125]
  // Until 12.5 this was ONE boundary with TWO independent implementations: this list, and
  // LAKE_EXEC_PREFIXES in the python the scheduled runners ran. Different languages, different
  // deploy scripts, different schedules, and nothing keeping them in sync -- changing one
  // without the other was a SECURITY REGRESSION. Those runners are deleted, so this list is
  // the only implementation left. THE LIST ITSELF IS UNCHANGED AND MUST STAY THAT WAY: a
  // prefix nothing loads today is still a prefix a future loader could, and the compiled-in
  // digest below pins exactly these strings. If you change it, recompute the digest here:
  //   python3 -c "import hashlib;p=[...];print(hashlib.sha256(('\n'.join(sorted(p))+'\n').encode()).hexdigest())"
  // NOT the same thing as VAULT_CLEARTEXT_PREFIXES (an at-rest ENCRYPTION exemption injected by
  // patch-cp-encrypt.py). That list grants and denies nothing. Do not conflate them.
  // The digest is compiled in; it is NEVER fetched from the lake, because a lake-hosted boundary
  // would be writable by the principals it restrains.
  // VERIFY-GREP: F1-EXEC-WRITE-BOUNDARY-WIRED
  const LAKE_EXEC_PREFIXES: string[] = ['shared/deploy/', 'shared/harness/', 'shared/passkey/', 'shared/mcp-oauth/', 'shared/vault/', 'shared/security/', 'shared/runner/', 'shared/gate-exec/', 'shared/reaper/'];
  const LAKE_EXEC_BOUNDARY_SHA256 = 'c51a6cf76ceedc0e4a401ad961d12c52ef2e10fb8d9e4cb835cde23998b2e51e';
  {
    const canon = LAKE_EXEC_PREFIXES.slice().sort().join('\n') + '\n';
    const got = crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
    if (got !== LAKE_EXEC_BOUNDARY_SHA256) {
      console.error('[cp] FATAL F1/F2: executable-write boundary digest mismatch. want=' +
        LAKE_EXEC_BOUNDARY_SHA256 + ' got=' + got);
      throw new Error('F1/F2 executable-write boundary is unverified -- refusing to serve lake tools.');
    }
  }
  function lakeExecPrefix(clean: string): string | null {
    for (const px of LAKE_EXEC_PREFIXES) if (clean.indexOf(px) === 0) return px;
    return null;
  }
  // mode='write' additionally refuses the executable prefixes (F1/F2). Read callers keep the default.
  function resolveKey(path: string, me: string, mode: 'read' | 'write' = 'read'): { key?: string; err?: string } {
    const myPrefix = `agents/${me}/`;
    const clean = String(path).replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
    if (clean === '' ) return { err: 'path is required' };
    if (clean === 'shared' || clean === 'shared/') return { err: 'include a filename under shared/, e.g. shared/handoff/brief.md' };
    if (clean.startsWith('shared/')) {
      if (mode === 'write') {
        const px = lakeExecPrefix(clean);
        if (px) return { err: `denied: ${px} is an EXECUTABLE prefix -- the control plane loads and runs code from it, so no role (including ${me}) may write there. Reads are still allowed. Write your change as a SPEC under shared/state/ (e.g. shared/state/security-fixes/) and let a human deploy it. shared/state/, shared/handoff/, shared/oss-release/ and agents/${me}/ are unaffected.` };
      }
      return { key: clean };
    }
    if (clean.startsWith('agents/')) {
      if (clean.startsWith(myPrefix)) return { key: clean };
      return { err: `denied: as ${me} you can only access agents/${me}/ or shared/. Another role's private files are off-limits.` };
    }
    return { key: myPrefix + clean };
  }

  server.registerTool('write_file',
    { description: "Write a file to the data lake as your resolved role. A bare name goes to YOUR PRIVATE folder (agents/<role>/) no other role can read. Use 'shared/...' for the common drop zone every role picks up (e.g. shared/handoff/book3.md).",
      inputSchema: { path: z.string(), content: z.string(), tags: z.array(z.string()).optional(), ...AG } },
    async (a: any) => {
      if (!lake) return { content: [{ type: 'text', text: 'data lake not configured (DATA_LAKE_BUCKET unset)' }], isError: true };  // [SEC-LAKE-UNCONFIGURED-V1] isError, not a 2xx success: an unconfigured lake used to read as A PASS to every client that judges failure by status or exception, which is why green runs went green over a dead lake.
      const me = who(a); const r = resolveKey(a.path, me, 'write');
      if (r.err) return { content: [{ type: 'text', text: r.err }] };
      // [PCV1-LAKE-TOOLS-V1] Through the vault, not straight to GCS. harWriteLake encrypts unless the path is
      // cleartext-allowlisted and FAILS CLOSED -- if the master cannot load it throws and NOTHING
      // is written, rather than falling back to plaintext. resolveKey's write-boundary check above
      // still runs FIRST and is unchanged; owner/tags metadata and the text/plain contentType
      // intent are carried through it.
      // [TAGS-COERCE-V1] Array.isArray, not `|| []`. MEASURED with grep on this file: three
      // sites read a.tags off tool input -- these two joins and the chat_history store below.
      // `(a.tags || []).join(',')` defends against ABSENT and against null, and against nothing
      // else: a caller that sends tags as a bare string (which the zod schema rejects on the MCP
      // path, but this handler is also reached from the console tool dispatcher) reaches .join on
      // a String, which has no such method, and the tool throws a TypeError instead of writing
      // the file. The read side already coerces this way -- see the Array.isArray guards on
      // h.tags in refresh() and on r.tags in the history search -- so this is the write side
      // catching up with a rule the file already follows, not a new one.
      // DELIBERATELY NOT DONE: coercing a bare string INTO a one-element array. That would
      // invent a tag the caller did not send; dropping a malformed field and writing the object
      // is the behaviour every other guard in this file already has.
      await harWriteLake(r.key!, a.content || '', 'text/plain; charset=utf-8', { owner: me, tags: (Array.isArray(a.tags) ? a.tags : []).join(',') });
      const where = r.key!.startsWith('shared/') ? 'SHARED drop zone' : `${me}'s private folder`;
      return { content: [{ type: 'text', text: `wrote gs://${DATA_LAKE_BUCKET}/${r.key} (${(a.content || '').length} chars) — ${where}` }] };
    });

  server.registerTool('put_file',
    { description: "Write a BINARY file to the data lake (as your resolved role). Pass base64_data (the file contents encoded in base64) and an optional content_type (e.g. 'image/png'). Returns a stable lake path and a fetchable direct link.",
      inputSchema: { path: z.string(), base64_data: z.string(), content_type: z.string().optional(), tags: z.array(z.string()).optional(), ...AG } },
    async (a: any) => {
      if (!lake) return { content: [{ type: 'text', text: 'data lake not configured (DATA_LAKE_BUCKET unset)' }], isError: true };  // [SEC-LAKE-UNCONFIGURED-V1] isError, not a 2xx success: an unconfigured lake used to read as A PASS to every client that judges failure by status or exception, which is why green runs went green over a dead lake.
      const me = who(a); const r = resolveKey(a.path, me, 'write');
      if (r.err) return { content: [{ type: 'text', text: r.err }] };
      const buf = Buffer.from(a.base64_data, 'base64');
      // [PCV1-LAKE-TOOLS-V1] Same vault path as write_file. The caller's content_type intent is preserved in
      // custom metadata when the body is encrypted, because the stored bytes are then binary.
      // [TAGS-COERCE-V1] Same guard, same reason as write_file above.
      await harWriteLake(r.key!, buf, a.content_type || 'application/octet-stream', { owner: me, tags: (Array.isArray(a.tags) ? a.tags : []).join(',') });
      const where = r.key!.startsWith('shared/') ? 'SHARED drop zone' : `${me}'s private folder`;
      const link = `https://storage.googleapis.com/${DATA_LAKE_BUCKET}/${r.key}`;
      return { content: [{ type: 'text', text: `wrote gs://${DATA_LAKE_BUCKET}/${r.key} (${buf.length} bytes) — ${where}\nLink: ${link}` }] };
    });

  server.registerTool('read_file',
    { description: "Read a file from the data lake (as your resolved role). You can read YOUR private folder (agents/<role>/...) and anything in shared/... Not another role's private folder. Use list_files to discover paths.",
      inputSchema: { path: z.string(), ...AG } },
    async (a: any) => {
      if (!lake) return { content: [{ type: 'text', text: 'data lake not configured (DATA_LAKE_BUCKET unset)' }], isError: true };  // [SEC-LAKE-UNCONFIGURED-V1] isError, not a 2xx success: an unconfigured lake used to read as A PASS to every client that judges failure by status or exception, which is why green runs went green over a dead lake.
      const me = who(a); const r = resolveKey(a.path, me);
      if (r.err) return { content: [{ type: 'text', text: r.err }] };
      const f = lake.file(r.key!);
      const [exists] = await f.exists();
      if (!exists) return { content: [{ type: 'text', text: `no file at ${r.key}` }] };
      const [buf] = await f.download();
      const [md] = await f.getMetadata();
      const owner = (md.metadata && (md.metadata as any).owner) || 'unknown';
      // [PCV1-LAKE-TOOLS-V1] DUAL-READ. Every lake object written before this landed is plaintext, so a buffer
      // WITHOUT the PCV1 magic is returned byte-for-byte unchanged. Only a PCV1 object is
      // decrypted, and with the master for its OWN epoch byte, so epoch-1 objects stay readable.
      // A decrypt failure THROWS: an unreadable object must never render as an empty file.
      // The banner below is unchanged.
      const text = await harDecryptLakeBuf(r.key!, buf);
      // [LAKE-READ-BOUND-V1] Refusal, never truncation: see the block above buildMcpServer.
      const tooBig = pcLakeReadRefusal(r.key!, text.length);
      if (tooBig) return { content: [{ type: 'text', text: tooBig }], isError: true };
      return { content: [{ type: 'text', text: `# ${r.key} (owner: ${owner})\n\n${text}` }] };
    });

  server.registerTool('list_files',
    { description: "List files you can see (as your resolved role): YOUR private folder + the shared/ drop zone. Optional prefix, within your own folder or shared/.",
      inputSchema: { prefix: z.string().optional(), ...AG } },
    async (a: any) => {
      if (!lake) return { content: [{ type: 'text', text: 'data lake not configured (DATA_LAKE_BUCKET unset)' }], isError: true };  // [SEC-LAKE-UNCONFIGURED-V1] isError, not a 2xx success: an unconfigured lake used to read as A PASS to every client that judges failure by status or exception, which is why green runs went green over a dead lake.
      const me = who(a); const myPrefix = `agents/${me}/`;
      let prefixes: string[];
      if (a.prefix) {
        const clean = String(a.prefix).replace(/^\/+/, '');
        if (clean === 'shared' || clean.startsWith('shared/')) prefixes = [clean];
        else if (clean.startsWith('agents/')) {
          if (!clean.startsWith(myPrefix)) return { content: [{ type: 'text', text: `denied: as ${me} you can only list agents/${me}/ or shared/.` }] };
          prefixes = [clean];
        } else prefixes = [myPrefix + clean];
      } else {
        prefixes = [myPrefix, 'shared/'];
      }
      const rows: any[] = [];
      for (const p of prefixes) {
        const [files] = await lake.getFiles({ prefix: p });
        for (const f of files as any[]) {
          rows.push({
            path: f.name,
            owner: (f.metadata && f.metadata.metadata && f.metadata.metadata.owner) || 'unknown',
            bytes: Number(f.metadata && f.metadata.size) || 0,
            updated: f.metadata && f.metadata.updated
          });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    });

  // ---- refresh: per-role catch-up from the DURABLE history (not the app scrollback) ----
  server.registerTool('refresh',
    { description: "Catch-up for YOUR resolved role. Call when the operator says 'refresh' (e.g. after switching between the Claude app and Spark). Returns your recent durable history + anything awaiting the operator's human-gate approval + recent open A/B/C decisions. After calling, give the operator a SHORT 3–5 line 'where we are' and re-surface any choice/approval they owes, answerable with one letter.",
      inputSchema: { limit: z.number().optional(), ...AG } },
    async (a: any) => {
      const me = who(a); const n = a.limit || 8;
      const hSnap = await db.collection('chat_history').where('agent_id', '==', me).limit(3000).get();
      const hist = hSnap.docs.map((d: any) => d.data());
      hist.sort((x: any, y: any) => tsMillis(y.timestamp) - tsMillis(x.timestamp));
      const recent = hist.slice(0, n).reverse().map((h: any) => ({
        role: h.role, at: h.timestamp, tags: h.tags, text: (h.text || '').slice(0, 600)
      }));
      // [DEC-CLOSE-V1] This used to be a WORD SEARCH with no state. It matched any history
      // entry whose tags contained decision|await|choice|abc|gate as a SUBSTRING, so a note
      // tagged `gate-exec` (a service name) or `open_decisions` (a bug being investigated) was
      // presented to the operator as a question he owed an answer to. Nothing recorded an
      // answer either, so the list only ever got more wrong -- and writing history CORRECTLY
      // made it worse, because good tags contain those words. Two changes, both about state:
      //   RAISE  a decision by tagging the entry exactly `decision`. Nothing else counts.
      //   CLOSE  it by logging any later entry tagged `resolves:<id>`, id from open_decisions.
      // The operator's attention is the scarcest thing in this system; a list that cries wolf
      // spends it. Under-reporting is the correct direction to be wrong in.
      const resolvedIds = new Set<string>();
      for (const h of hist) {
        if (!Array.isArray(h.tags)) continue;
        for (const t of h.tags) {
          const rm = /^resolves:(.+)$/i.exec(String(t).trim());
          if (rm) resolvedIds.add(rm[1].trim());
        }
      }
      const isDecision = (h: any) => Array.isArray(h.tags) &&
        h.tags.some((t: any) => String(t).trim().toLowerCase() === 'decision');
      const isClosure = (h: any) => Array.isArray(h.tags) &&
        h.tags.some((t: any) => /^resolves:/i.test(String(t).trim()));
      const openAll = hist.filter((h: any) => h.role === 'assistant' && isDecision(h) &&
        !isClosure(h) && !resolvedIds.has(String(h.id || '')));
      const openDecisions = openAll
        .slice(0, 3)
        .map((h: any) => ({ id: h.id || '', at: h.timestamp, text: (h.text || '').slice(0, 900) }));
      // [DEC-CLOSE-V1] THE LANE'S ACTUAL WORK STATE. refresh returned recent history, a
      // word-search called open_decisions, and the gate queue -- and NOT work_items, which is
      // the one store in this system with real open/closed state: a status field, a
      // completed_by, a cancelled_by, and complete_work_item / cancel_work_item as genuine
      // close operations. That omission is why every chat kept reaching for a hand-maintained
      // status document: the state existed, refresh just never showed it. Anything not
      // done/completed/cancelled is OPEN, including error and blocked -- a failed item is not
      // a finished one.
      const DONE_STATES = new Set(['done', 'completed', 'cancelled']);
      const wiSnap = await db.collection('work_items').where('assigned_role', '==', me).limit(500).get();
      const wiAll = wiSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() || {}) }))
        .filter((w: any) => !DONE_STATES.has(String(w.status || '').toLowerCase()));
      wiAll.sort((a: any, b: any) => tsMillis(b.created_at) - tsMillis(a.created_at));
      const openWork = wiAll.slice(0, 20).map((w: any) => ({
        id: w.id, title: String(w.title || '').slice(0, 200), status: w.status,
        created_at: w.created_at, note: String(w.result_note || w.error || '').slice(0, 300)
      }));
      const pcSnap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(50).get();
      const pending = pcSnap.docs.map((d: any) => {
        const x = d.data();
        return { job_id: x.job_id, staged_by: x.staged_by, command_type: x.command_type, arguments: x.arguments, created_at: x.created_at, yours: x.staged_by === me };
      });
      const payload = {
        agent: me,
        server_time: new Date().toISOString() + " / " + new Date().toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
        history_turns_total: hist.length,
        recent_history: recent,
        open_decisions: openDecisions,
        // Both lists below are capped. A cap that hides its own count is how a backlog looks
        // smaller than it is, so the true number ships beside each one.
        open_decisions_total: openAll.length,
        open_work: openWork,
        open_work_total: wiAll.length,
        awaiting_your_approval: pending,
        note: recent.length === 0
          ? `No durable history yet for ${me} — log turns with log_history so future refreshes have something to recall.`
          : "Summarize recent_history in 3–5 lines for the operator. Then state open_work (what is actually still open in this lane, with real status — this is the lane's work state, not a guess), then awaiting_your_approval, then open_decisions, as A/B/C so they can answer with one letter. If open_work_total exceeds what is listed, say so."
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    });

  // ---- Agent-to-agent messaging: a shared inbox, answered by the target's next session ----
  server.registerTool('ask_agent',
    { description: "Ask another fleet role a question with no human relay. Writes to the shared inbox; the target's next session answers. Returns a message id to check_answer.",
      inputSchema: { to: z.string(), question: z.string(), context: z.string().optional(), urgency: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('agent_messages').doc();
      await ref.set({ id: ref.id, from: who(a), to: a.to, question: a.question, context: a.context || '', urgency: a.urgency || 'normal', status: 'open', answer: '', created_at: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `asked ${a.to} (msg ${ref.id})` }] };
    });

  server.registerTool('list_my_messages',
    { description: "Messages addressed to YOUR role (open by default). Answer with answer_message.",
      inputSchema: { status: z.string().optional(), ...AG } },
    async (a: any) => {
      const me = who(a);
      const snap = await db.collection('agent_messages').where('to','==',me).limit(50).get();
      const rows = snap.docs.map((d:any)=>d.data()).filter((m:any)=> a.status ? m.status===a.status : m.status==='open');
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    });

  server.registerTool('answer_message',
    { description: "Answer a message addressed to your role.",
      inputSchema: { id: z.string(), answer: z.string(), ...AG } },
    async (a: any) => {
      await db.collection('agent_messages').doc(a.id).update({ answer: a.answer, status: 'answered', answered_by: who(a), answered_at: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `answered ${a.id}` }] };
    });

  server.registerTool('check_answer',
    { description: "Check a message YOU sent for its answer.",
      inputSchema: { id: z.string(), ...AG } },
    async (a: any) => {
      const d = await db.collection('agent_messages').doc(a.id).get();
      if (!d.exists) return { content: [{ type: 'text', text: `no message ${a.id}` }] };
      const m:any = d.data();
      return { content: [{ type: 'text', text: JSON.stringify({ status:m.status, answer:m.answer, from:m.from, to:m.to }, null, 2) }] };
    });

  server.registerTool('get_time',
    { description: "Get the current authoritative fleet server time (UTC and Eastern). Establish time-first before answering.",
      inputSchema: { ...AG } },
    async () => {
      const now = new Date();
      return { content: [{ type: 'text', text: now.toISOString() + " / " + now.toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) }] };
    });

  // VERIFY-GREP: F13-JOBLOG-OWNERSHIP-V1
  // F13. read_job_log had no ownership check: any principal holding any connector token read any job's
  // stdout_tail (up to 6 KB of privileged output staged by other strains). who(a) is the token-bound
  // principal and cannot be spoofed, and every stager already writes staged_by: who(a) -- so the
  // predicate already existed, this tool just never applied it. Operator principals still read
  // EVERYTHING: read_job_log is the operator's only transport for job output, and a fix that locks them out of
  // his own logs gets reverted the first night it bites. LOG_READ_ALL is an env allowlist (accepts '*')
  // so that set changes without a redeploy. Second half: surface the reason fields the projection
  // dropped -- a refusal that looks identical to a malfunction trains the operator to route around the
  // control that is working.
  server.registerTool('read_job_log',
    { description: 'Read the full output (stdout/stderr/exit) of a gate job by id, from Firestore -- so the human never pastes logs. Pass job_id. You may read jobs YOU staged; operator principals (LOG_READ_ALL) read everything. If a job was refused, quarantined, superseded, or its executor failed, the reason comes back in `reason` and ran=false -- a refusal is NOT a malfunction, do not re-stage blindly.', inputSchema: { job_id: z.string(), ...AG } },
    async (a: any) => { try { const me = who(a); const d = await db.collection('pending_confirms').doc(a.job_id).get(); if (!d.exists) { return { content: [{ type: 'text', text: JSON.stringify({ error: 'job not found' }) }] }; } const x: any = d.data(); const OPS = String(process.env.LOG_READ_ALL || 'fleet-advisor').split(',').map((s: string) => s.trim()).filter(Boolean); const isOperator = OPS.indexOf('*') >= 0 || OPS.indexOf(me) >= 0; const stagedBy = String(x.staged_by || ''); if (!isOperator && stagedBy !== me) { console.warn('[cp] F13: ' + me + ' denied read_job_log on ' + a.job_id + ' (staged_by ' + (stagedBy || '(unset)') + ')'); return { content: [{ type: 'text', text: JSON.stringify({ error: 'not your job: ' + a.job_id + ' was staged by another principal. You can read the jobs you staged; ask the operator (or fleet-advisor) for this one.', job_id: a.job_id, staged_by: stagedBy || null, denied: true }) }] }; } const reason = x.fire_refused_reason || x.quarantine_reason || x.exec_failed_reason || x.supersede_note || x.expired_reason || x.error || null; return { content: [{ type: 'text', text: JSON.stringify({ job_id: a.job_id, status: x.status, ran: x.status === 'executed', exit_code: x.exit_code, ran_as: x.ran_as, staged_by: stagedBy || null, command_type: x.command_type || null, reason: reason, quarantine_reason: x.quarantine_reason || null, quarantined_at: x.quarantined_at || null, fire_refused_reason: x.fire_refused_reason || null, fire_refused_at: x.fire_refused_at || null, supersede_note: x.supersede_note || null, superseded_by_job: x.superseded_by_job || null, superseded_by_role: x.superseded_by_role || null, superseded_at: x.superseded_at || null, expired_reason: x.expired_reason || null, expired_at: x.expired_at || null, exec_failed_reason: x.exec_failed_reason || null, exec_http: (typeof x.exec_http === 'number') ? x.exec_http : null, stdout: x.stdout_tail || '', stderr: x.stderr_tail || '' }) }] }; } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ error: String((e && e.message) || e) }) }] }; } });
  server.registerTool('gcp_api',
    { description: 'Call ANY GCP REST endpoint (https://*.googleapis.com) directly — no gcloud, no Cloud Build, no VM. TRUST LADDER: blessed READS (GET on compute/run/storage/logging/monitoring in our project) run instantly as the least-privilege control-plane identity; if it is not permitted it auto-escalates to the gate. EVERYTHING else — any mutation, DELETE, IAM, Secret Manager, a brand-new API — goes through the executor and, with PC_AUTO_APPROVE=1 (THE SHIPPED DEFAULT -- install.sh sets it to 1), RUNS IN THIS CALL and returns { mode:"ran", result }. There is no approval step and no second Face ID; destructive verbs are still classified, but the classification decides what is journalled, not whether it happens. { mode:"staged" } comes back only when PC_AUTO_APPROVE is off, which is NOT how this ships. That is deliberate: the product accelerates security-minded agentic engineering, so every check that fails a CUT is kept and the per-call tap is not. Pass method (GET/POST/PATCH/DELETE...), url (full https), optional body (object), optional reason (why).', inputSchema: { method: z.string(), url: z.string(), body: z.record(z.string(), z.any()).optional(), reason: z.string().optional(), ...AG } },
    async (a: any) => { const r = await harGcpApi(who(a), a.method, a.url, a.body, a.reason || ''); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('run_status',
    { description: 'List Cloud Run services in our project/region (blessed read via control-plane identity; auto-escalates to the gate if not permitted). Optional region (default us-east1, where our services live).', inputSchema: { region: z.string().optional(), ...AG } },
    async (a: any) => { const region = a.region || process.env.GCP_REGION || 'us-east1'; const url = 'https://run.googleapis.com/v2/projects/' + (process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT) + '/locations/' + region + '/services'; const r = await harGcpApi(who(a), 'GET', url, null, 'run_status'); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('run_roll',
    { description: 'Roll a fresh revision of a Cloud Run service (force a restart / pick up new lake code) by bumping DEPLOY_TS. Deploys are a MUTATION, so this is ALWAYS staged to the operator gate (fast: no Cloud Build) and runs as them on approval. Defaults to THIS control-plane service in us-east1. Optional service, region.', inputSchema: { service: z.string().optional(), region: z.string().optional(), ...AG } },
    async (a: any) => { const service = a.service || process.env.K_SERVICE || ''; if (!service) { return { content: [{ type: 'text', text: JSON.stringify({ error: 'run_roll: no service argument and K_SERVICE is unset, so the service to roll cannot be determined. Cloud Run always sets K_SERVICE; pass service explicitly otherwise. Refusing rather than guessing a bare name, which in a shared project would stage a roll of the OTHER lane.' }) }], isError: true }; } const region = a.region || process.env.GCP_REGION || 'us-east1'; const cmd = 'gcloud run services update ' + service + ' --region ' + region + ' --update-env-vars DEPLOY_TS=$(date +%s) --quiet && echo ROLLED ' + service; const jobId = 'gcp_' + crypto.randomBytes(6).toString('hex'); const _rargs: any = { command: cmd, service, region }; const _adm = await pcAdmitStage(who(a), 'run_roll ' + service, _rargs); if (!_adm.ok) { return { content: [{ type: 'text', text: JSON.stringify({ mode: 'refused', staged: false, duplicate_of: _adm.duplicate_of || null, note: _adm.refusal }) }], isError: true }; } const _rref = db.collection('pending_confirms').doc(jobId); await _rref.set({ job_id: jobId, command_type: 'run_roll ' + service, staged_by: who(a), arguments: _rargs, status: 'pending', created_at: FieldValue.serverTimestamp(), command_sha256: _adm.sha }); /* [SEC-AUTORUN-SCOPE-V1] This said 'pending your gate approval' -- naming a route that returns 404 -- and then waited forever. */ const _auto = await pcAutoRun(_rref, jobId, 'run_roll ' + service, cmd, false, a.confirm === true); if (_auto) return { content: [{ type: 'text', text: _auto }] }; return { content: [{ type: 'text', text: JSON.stringify({ mode: 'staged', job_id: jobId, note: 'NOT run: PC_AUTO_APPROVE is off and there is no approval console.' }) }] }; });
  try {
    // [PCV1-GIT-VAULT-WIRE-V2] BELT BEGIN
    // Removes the cold-start race in which the first git write reaches an unarmed
    // registry. It is INSIDE the enclosing try, and its own catch only LOGS, on
    // purpose and against the obvious instinct: rejecting here would make
    // buildMcpServer reject, and the agent would lose every tool -- whoami,
    // read_file, gcp_api -- i.e. exactly the tools needed to diagnose a vault fault.
    // Not registering the git tools would be no better: the agent would see an
    // unknown tool instead of the fail-closed message the writer was worded to emit.
    // So the tools stay registered and the write site names the fault. This is not
    // fail-open: no master means no write, enforced in vault-objwrite.ts.
    try { await ensureGitVaultMaster(); }
    catch (_ve: any) { console.error('[gittools] vault registry unarmed: ' + String(_ve && _ve.message ? _ve.message : _ve) + ' -- git tools ARE registered; object writes fail closed at the write site'); }
    // [PCV1-GIT-VAULT-WIRE-V2] BELT END
    const _gt = require('./gittools.js');
    const _n = _gt.registerGitTools(server, z, AG, agentId);
    console.log('[gittools] registered ' + _n.length + ' tools');
  } catch (e: any) {
    console.error('[gittools] not registered: ' + String(e && e.message ? e.message : e));
  }
  // [GH-TOOLS-V1] REGISTERED UNCONDITIONALLY, WHICH DEPARTS FROM [SEC-GITTOOLS-UNCONFIGURED-V1]
  // ON PURPOSE. That rule -- do not advertise a tool that will fail on its first call -- was
  // written about git tools that threw an opaque configuration error at an adopter who had no
  // way to know what was missing. These do the opposite: with no token stored, every gh_* tool
  // returns one sentence naming the console panel that fixes it. Withholding them instead would
  // mean the ONLY way to discover the capability exists is to read the release notes, and a tool
  // surface nobody can see is the failure [PCGIT-ARCHIVE-TOOL-V1] already cost this fleet days
  // over. A clear refusal is documentation; an absent tool is not.
  try {
    const _ght = require('./ghtools.js');
    const _gn = _ght.registerGithubTools(server, z, AG, agentId, {
      secretGet: harSecretGet,
      secretPrefix: PC_GH_SECRET_PREFIX,
      // [GH-PUBLISH-COPY-V1] The SAME module instance the git tools use, required the same way,
      // so the vault registry it reads through is the one that is actually armed. Requiring a
      // second transpiled copy would load a different module record with an empty key map --
      // the exact failure [PCV1-GIT-VAULT-WIRE-V2] documents for gitBlobOid.
      pcgitRead: async (p: string, r: string) => require('./gittools.js').readForPublish(p, r),
      configGet: ghConfig,
      journal: async (action: string, message: string) => {
        // The journal is the audit trail and a GitHub write is at least as consequential as a
        // privileged GCP call, which is journalled. It is best-effort ON PURPOSE: the commit has
        // already landed on GitHub by the time this runs, so throwing here would report a failure
        // for work that succeeded -- the exact shape of lie [SEC-JOURNAL-TRUTH-V1] removed.
        try {
          await db.collection('journal').add({
            agent_id: agentId, action, message, timestamp: FieldValue.serverTimestamp(),
          });
        } catch (_e) { /* never fail a write that already happened */ }
      },
    });
    console.log('[ghtools] registered ' + _gn.length + ' tools');
  } catch (e: any) {
    console.error('[gittools] not registered: ' + String(e && e.message ? e.message : e));
  }
  return server;
}

// ============ MCP ADMISSION CONTROL (fleet-security S32 / S34) ============
// Authentication answered "which principal is this". It never answered "may this principal call
// fleet tools at all". That second question is what the `strains` registry exists to answer, and
// until now nothing asked it at connection time. This does. A principal that is not a provisioned,
// ACTIVE strain is served whoami and nothing else.
// VERIFY-GREP: MCP-ADMISSION-CONTROL-WIRED
const ADMIT_TTL_MS = 60000;
const ADMIT_JOURNAL_COOLDOWN_MS = 300000;
const admitCache: Map<string, any> = new Map();
const admitJournaledAt: Map<string, number> = new Map();

// Resolve strains/{agentId} -> may this principal be handed the fleet toolset?
// Cached briefly so a busy connector does not cost one Firestore read per connection.
async function mcpStrainAdmit(agentId: string): Promise<any> {
  const now = Date.now();
  const cached: any = admitCache.get(agentId);
  if (cached && (now - cached.at) < ADMIT_TTL_MS) {
    return { ok: cached.ok, reason: cached.reason, cached: true };
  }
  try {
    const snap = await db.collection('strains').doc(agentId).get();
    if (!snap.exists) {
      admitCache.set(agentId, { ok: false, reason: 'no strain document in the registry', at: now });
      return { ok: false, reason: 'no strain document in the registry' };
    }
    const row: any = snap.data() || {};
    const ok = row.status === 'active';
    const reason = ok ? 'active strain' : ('strain status is ' + String(row.status || 'unset'));
    admitCache.set(agentId, { ok: ok, reason: reason, at: now });
    return { ok: ok, reason: reason };
  } catch (e: any) {
    // Registry unreachable. Prefer the last known good decision so a Firestore blip cannot lock the
    // fleet out mid-flight; with nothing cached, FAIL CLOSED rather than admit blindly.
    console.error('[admission] strains registry read failed for ' + agentId + ': ' + String(e && e.message ? e.message : e));
    if (cached) {
      return { ok: cached.ok, reason: cached.reason + ' (stale: registry unreachable)', cached: true };
    }
    return { ok: false, reason: 'strain registry unreachable and no cached decision - failing closed' };
  }
}

// The denied server. whoami only. It explains itself, because the failure mode being fixed is a chat
// that had no idea it was unprovisioned and reported success on work it had no right to do.
function buildDeniedMcpServer(agentId: string, reason: string): any {
  const server = new McpServer({ name: PC_REPO_ID, version: '1.0.0' });
  const msg = 'NOT PROVISIONED. The identity "' + agentId + '" is not an active strain in the fleet '
    + 'registry (' + reason + '). This connection has been admitted with NO fleet tools: it cannot '
    + 'read or write the data lake, append to the journal, stage or approve gate jobs, touch a VM, or '
    + 'message another agent. Nothing you do here reaches the fleet. Ask the operator to provision this identity at '
    + 'your gate URL and then reconnect. Do not report work as done from this '
    + 'connection - no tool call you make here has any effect.';
  server.registerTool('whoami',
    { description: 'Return the role you are acting as. This connector is NOT provisioned as a fleet strain and carries no other tools.',
      inputSchema: { agent: z.string().optional() } },
    async () => ({ content: [{ type: 'text', text: msg }] }));
  return server;
}

// The chokepoint. Both MCP mounts call this instead of buildMcpServer directly.
// [WP4B-KEY-CLASSES-V1] keyClasses is threaded, never re-derived. It is read ONCE, from the
// session_keys row, by pcSessionLookup, and passed down as an opaque value; nothing between
// here and pcNarrowClasses interprets it, and no tool argument can reach it. Callers that have
// no session key (the /mcp/:token connector mount) simply omit it and behave as before.
async function buildMcpServerAdmitted(agentId: string, keyClasses?: any): Promise<any> {
  const verdict: any = await mcpStrainAdmit(agentId);
  if (verdict && verdict.ok) return await buildMcpServer(agentId, keyClasses);
  const reason = String((verdict && verdict.reason) || 'unknown');
  console.error('[admission] DENIED ' + agentId + ' - ' + reason + ' - issued a whoami-only server.');
  const last = admitJournaledAt.get(agentId) || 0;
  if (Date.now() - last > ADMIT_JOURNAL_COOLDOWN_MS) {
    admitJournaledAt.set(agentId, Date.now());
    try {
      await db.collection('journal').add({
        agent_id: 'mcp_gateway', action: 'admission_denied',
        message: 'Refused the fleet toolset to unprovisioned principal "' + agentId + '": ' + reason
          + '. Connection served whoami only.',
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (e) {}
  }
  return buildDeniedMcpServer(agentId, reason);
}

// Boot audit: name every connector principal that would now be denied, so a behaviour change shows up
// in the startup logs and not as an operator wondering where their tools went.
// AGENT_TOKENS VALUES only (role names). The KEYS are the connector tokens and are never logged.
void (async () => {
  try {
    await new Promise((r: any) => setTimeout(r, 8000));   // let the strain registry finish seeding
    const keys = Object.keys(AGENT_TOKENS);
    const seen: any = {};
    const principals: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const v = String(AGENT_TOKENS[keys[i]] || '');
      if (v && !seen[v]) { seen[v] = 1; principals.push(v); }
    }
    const denied: string[] = [];
    for (let i = 0; i < principals.length; i++) {
      const v: any = await mcpStrainAdmit(principals[i]);
      if (!v || !v.ok) denied.push(principals[i] + ' (' + String((v && v.reason) || 'unknown') + ')');
    }
    if (denied.length) {
      console.error('[admission] BOOT AUDIT: ' + denied.length + ' of ' + principals.length
        + ' connector principals would be DENIED the fleet toolset: ' + denied.join(', '));
    } else {
      console.error('[admission] BOOT AUDIT: all ' + principals.length
        + ' connector principals resolve to active strains.');
    }
  } catch (e) { console.error('[admission] boot audit failed', e); }
})();
// ============ end MCP admission control ============

app.post('/mcp/:token', async (req, res) => {
  const agentId = AGENT_TOKENS[req.params.token];
  if (!agentId) { res.status(401).json({ error: 'Unknown agent token' }); return; }
  try {
    const server = await buildMcpServerAdmitted(agentId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});



// ================= Passkey / FaceID human gate + GOD-MODE + DASHBOARD + COST (ADDITIVE) =================
const WA_RP_ID = process.env.WA_RP_ID || '';
const WA_RP_ORIGIN_RAW = process.env.WA_RP_ORIGIN || ''; const WA_RP_ORIGINS = WA_RP_ORIGIN_RAW.split(',').map((s)=>s.trim()).filter(Boolean); const WA_RP_ORIGIN: any = WA_RP_ORIGINS.length > 1 ? WA_RP_ORIGINS : WA_RP_ORIGIN_RAW;
const WA_RP_NAME = process.env.WA_RP_NAME || 'Paracoding.AI Fleet Human Approval Gate';
const WA_SESSION_SECRET = process.env.WA_SESSION_SECRET || '';
// HFC4: a gate session is an HMAC(payload, WA_SESSION_SECRET). An empty/weak secret makes the
// signature forgeable (empty-key HMAC), which would let anyone mint a valid gate_session cookie.
// Require a strong secret; if it is missing/short we FAIL CLOSED (never issue, never verify).
const WA_SESSION_SECRET_MIN = 16;
const WA_SESSION_SECRET_OK = typeof WA_SESSION_SECRET === 'string' && WA_SESSION_SECRET.length >= WA_SESSION_SECRET_MIN;
const WA_BOOTSTRAP_SECRET = process.env.WA_BOOTSTRAP_SECRET || '';
const WA_USER = process.env.WA_USER || 'operator';
const WA_GOOGLE_CLIENT_ID = process.env.WA_GOOGLE_CLIENT_ID || '';
const GATE_EXEC_URL = (process.env.GATE_EXEC_URL || '').replace(/\/+$/, '');
const WA_APPROVER_EMAILS = (process.env.WA_APPROVER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
// [SEC-PASSKEY-TOGGLE-V1] Two independent switches, both deploy-time env vars so a compromised
// control plane cannot flip them: it would need run.admin, which its own service account does not
// hold. PC_REQUIRE_PASSKEY=0 trades the passkey for speed during development; IAP still
// authenticates a real human at the edge. Default is ON.
const PC_REQUIRE_PASSKEY = String(process.env.PC_REQUIRE_PASSKEY || '1') !== '0';
const PC_IAP_AUD = String(process.env.PC_IAP_AUD || '');
let PC_IAP_KEYS: any = null;
let PC_IAP_KEYS_AT = 0;
const WA_SESSION_MIN = parseInt(process.env.WA_SESSION_MIN || '10', 10);
const GCP_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
const GCP_BILLING_DATASET = process.env.GCP_BILLING_DATASET || 'billing_export';
const WA_LOCK_HTML: string = pcHtml('locked.html');
// [SEC-LOGIN-RECOVER-V1] THE SECOND LOCKED-STAGE DOCUMENT, AND WHY THERE ARE TWO.
// locked.html carries the passkey flows -- unlock, first-setup, enrol -- and every one of them
// needs WebAuthn. With PC_REQUIRE_PASSKEY=0 none of them can run, so on an install with no
// credential registered and no WA_BOOTSTRAP_SECRET that page reaches its terminal branch and
// tells the caller "No way in from here" over what was usually a two-second timing problem.
// login.html is the document for THAT posture: it re-checks /api/webauthn/status until the IAP
// key cache is warm, retries the request itself, and only stops -- capped, so the front door
// cannot spin -- to say what it measured. Neither file replaces the other; the switch that
// decides which auth applies decides which page explains it.
const WA_LOGIN_HTML: string = pcHtml('login.html');
// [SEC-NOGATE-V1] /gate IS GONE -- the route, the 142KB document behind it, and every redirect
// into it. Two human URLs remain, /harness and /wiki, plus /mcp for connectors. There is
// therefore nothing left for a bounce to point AT: a 302 to a route this file no longer
// registers is a redirect into a 404, and the installer's own guard check read that 302 as
// proof the console was guarded. Every former redirect site now ENDS HERE INSTEAD, serving the
// locked document in place, at the URL the caller actually asked for, under a 401.
//
// THREE CONSEQUENCES, ALL DELIBERATE.
//   1. ?next= is deleted rather than reimplemented. The caller's URL never changed, so the
//      unlock lands them where they already were by reloading -- there is no target to carry,
//      and with it goes the enumeration oracle the /wiki sites were written to avoid.
//   2. The status is 401, not 200 behind a redirect. An anonymous curl now gets a code that
//      MEANS refused; the old 302 was indistinguishable from a working page that happened to
//      move. No WWW-Authenticate header is sent, so no browser credential dialog appears.
//   3. The passkey path did NOT go away with the gate. It lost the larger of its two documents
//      and kept the small one: with PC_REQUIRE_PASSKEY=1 this IS the working unlock page, and
//      it is the way back in if the identity provider in front of the console ever fails.
function waSendLocked(res: express.Response): void {
  res.status(401);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(PC_REQUIRE_PASSKEY ? WA_LOCK_HTML : WA_LOGIN_HTML);
}
const WA_DASH_HTML: string = pcHtml('dash.html');
const waFetch: any = (globalThis as any).fetch;
if (!WA_SESSION_SECRET_OK) {
  console.error('[gate] SECURITY: WA_SESSION_SECRET is missing or shorter than ' + WA_SESSION_SECRET_MIN + ' chars — gate sessions are DISABLED (fail-closed). Set a strong WA_SESSION_SECRET to enable the human gate.');
}

function waSafe(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return async (req: express.Request, res: express.Response) => {
    try { await fn(req, res); }
    catch (e: any) { console.error('[gate] handler error', e); if (!res.headersSent) res.status(500).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); }
  };
}
function waB64(buf: Buffer | Uint8Array): string { return Buffer.from(buf).toString('base64url'); }
function waSha(s: string): Buffer { return crypto.createHash('sha256').update(s).digest(); }
function waEq(a: string | Buffer, b: string | Buffer): boolean {
  const ba = Buffer.from(a as any); const bb = Buffer.from(b as any);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function waCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie; if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
function waSetChal(res: express.Response, name: string, value: string): void {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 5 * 60 * 1000, path: '/' });
}
function waMakeSession(): string {
  // HFC4 fail-closed: refuse to ISSUE a session when the signing secret is missing/weak.
  if (!WA_SESSION_SECRET_OK) throw new Error('WA_SESSION_SECRET missing or too weak (min ' + WA_SESSION_SECRET_MIN + ' chars) — refusing to issue a gate session.');
  const payload = waB64(Buffer.from(JSON.stringify({ u: WA_USER, exp: Date.now() + WA_SESSION_MIN * 60 * 1000 })));
  const sig = crypto.createHmac('sha256', WA_SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
// [SEC-PASSKEY-TOGGLE-V1] IAP identity, consulted ONLY when PC_REQUIRE_PASSKEY=0.
// X-Goog-Authenticated-User-Email is NOT trusted on its own: that header is trivially forged by
// anyone who reaches this service directly if IAP is ever detached from it. The ES256 assertion is
// the real evidence, so it is verified against Google's IAP JWKS. waSessionOk is synchronous, so
// the keys are cached; a cold cache FAILS CLOSED and schedules a refresh rather than admitting an
// unverified caller.
//
// [SEC-IAP-JWKS-COLDCACHE-V1] FAILING CLOSED ON A COLD CACHE IS CORRECT. ANSWERING FROM ONE IS NOT.
// This function used to be fire-and-forget and was called once at module load, so the keys were
// still absent when the first request arrived: pcIapEmail returned '' for a caller carrying a
// perfectly valid assertion, waSessionOk said no, and every console URL answered 401 with
// locked.html. On an install running PC_REQUIRE_PASSKEY=0 with no passkey registered and no
// WA_BOOTSTRAP_SECRET, that page has no usable flow -- it renders "No way in from here" -- so a
// cold start dead-ended the operator on his own console until he reloaded and hit the now-warm
// cache. Reproduced deterministically against this exact code with a synthetic ES256 JWKS:
// request at t=0 refused, same request at t=400ms admitted.
//
// THREE CHANGES, and the third is the one that is not obvious.
//   1. It returns a promise, so boot can AWAIT the first fill before app.listen (see the bottom
//      of this file). The port opens with usable keys instead of opening and refusing.
//   2. An in-flight fetch is shared. The 1h guard needs PC_IAP_KEYS truthy to short-circuit, so
//      while the cache was empty EVERY request fired its own request to gstatic -- the repro
//      above fired three for two calls. A cold-start burst was a stampede.
//   3. AN EMPTY KEY SET IS REFUSED. `PC_IAP_KEYS = m` assigned unconditionally, and `{}` is
//      truthy, so one malformed or empty JWKS response installed a map that satisfies the 1h
//      guard and matches no kid: refresh suppressed, every caller refused, for a FULL HOUR, with
//      no way back except a redeploy. That is lockout-class and it is why this now keeps the
//      previous keys and says so on stderr rather than overwriting them.
const PC_IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
let PC_IAP_KEYS_INFLIGHT: Promise<void> | null = null;
function pcIapRefreshKeys(): Promise<void> {
  if (PC_IAP_KEYS && Date.now() - PC_IAP_KEYS_AT < 3600000) return Promise.resolve();
  if (PC_IAP_KEYS_INFLIGHT) return PC_IAP_KEYS_INFLIGHT;
  PC_IAP_KEYS_AT = Date.now();
  PC_IAP_KEYS_INFLIGHT = (async () => {
    try {
      const r: any = await (globalThis as any).fetch(PC_IAP_JWKS_URL);
      const j: any = await r.json();
      const m: any = {};
      for (const k of (j.keys || [])) m[k.kid] = k;
      if (Object.keys(m).length) PC_IAP_KEYS = m;
      else console.error('[iap-jwks] refused an empty key set; keeping the previous keys');
    } catch (e: any) {
      console.error('[iap-jwks] refresh failed: ' + ((e && e.message) || String(e)));
    } finally {
      PC_IAP_KEYS_INFLIGHT = null;
    }
  })();
  return PC_IAP_KEYS_INFLIGHT;
}
pcIapRefreshKeys();
function pcIapEmail(req: express.Request): string {
  const tok = String(req.headers['x-goog-iap-jwt-assertion'] || '');
  if (!tok) return '';
  const parts = tok.split('.');
  if (parts.length !== 3) return '';
  pcIapRefreshKeys();
  if (!PC_IAP_KEYS) return '';
  let hdr: any; let body: any;
  try {
    hdr = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch (e) { return ''; }
  const jwk = PC_IAP_KEYS[hdr && hdr.kid];
  if (!jwk) return '';
  try {
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' } as any);
    const ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
      { key: pub, dsaEncoding: 'ieee-p1363' } as any, Buffer.from(parts[2], 'base64url'));
    if (!ok) return '';
  } catch (e) { return ''; }
  if (body.iss !== 'https://cloud.google.com/iap') return '';
  if (!body.exp || body.exp * 1000 <= Date.now()) return '';
  // [SEC-IAP-GODMODE-V1] no PC_IAP_AUD means no audience binding, so log what IAP
  // actually sent and make the correct value discoverable at install time.
  if (!PC_IAP_AUD) console.error('[iap-aud-probe] observed aud=' + String(body.aud || ''));
  if (PC_IAP_AUD && body.aud !== PC_IAP_AUD) return '';
  return String(body.email || '').toLowerCase();
}
function waSessionOk(req: express.Request): boolean {
  // [SEC-IAP-IS-THE-DOOR-V124] A verified IAP identity on the approver allow-list IS the
  // authentication. This used to sit behind `if (!PC_REQUIRE_PASSKEY)`, which was true on every
  // install install.sh has ever produced, so the branch is now what it always was in practice.
  // [SEC-AUDIT-V105-IAP-AUD-GUARD] FAIL-CLOSED, UNCHANGED: no PC_IAP_AUD, no IAP admission --
  // pcIapEmail() only checks audience `if (PC_IAP_AUD && ...)`, so calling it unconditionally
  // would let an assertion minted for ANY IAP-protected app satisfy this gate.
  const em = PC_IAP_AUD ? pcIapEmail(req) : '';
  if (em && WA_APPROVER_EMAILS.length && WA_APPROVER_EMAILS.indexOf(em) >= 0) return true;
  // HFC4 fail-closed: never VERIFY a session when the signing secret is missing/weak (an empty-key
  // HMAC is forgeable). With no strong secret there are no valid sessions — the gate stays locked.
  if (!WA_SESSION_SECRET_OK) return false;
  const c = waCookie(req, 'gate_session'); if (!c || c.indexOf('.') < 0) return false;
  const parts = c.split('.'); const payload = parts[0]; const sig = parts[1];
  const expect = crypto.createHmac('sha256', WA_SESSION_SECRET).update(payload).digest('base64url');
  if (!waEq(sig, expect)) return false;
  // [SEC-PASSKEY-TOGGLE-REVOKE-V1] RETIRED WITH THE PASSKEY. The `pk` field it guarded is no
  // longer stamped by waMakeSession, and a cookie minted before this deploy still carries one --
  // it is ignored rather than rejected, so live sessions survive the upgrade. Stamping without
  // checking, or checking without stamping, is a total lockout in one direction or the other.
  try { const sess = JSON.parse(Buffer.from(payload, 'base64url').toString()); return sess.exp > Date.now(); } catch (e) { return false; }
}
const WA_ELEVATE_MIN = parseInt(process.env.WA_ELEVATE_MIN || '5', 10);
const WA_JOB_TTL_MIN = parseInt(process.env.WA_JOB_TTL_MIN || '60', 10);
function waMakeElevated(jobId: string, cmdSha: string): string {
  // Fail closed on a missing/weak signing secret, exactly as waMakeSession does: an empty-key
  // HMAC is forgeable, and a forgeable elevation is a forgeable destructive approval.
  if (!WA_SESSION_SECRET_OK) throw new Error('WA_SESSION_SECRET missing or too weak (min ' + WA_SESSION_SECRET_MIN + ' chars) - refusing to issue an elevation.');
  const payload = waB64(Buffer.from(JSON.stringify({ u: WA_USER, k: 'elev', j: String(jobId || ''), c: String(cmdSha || ''), exp: Date.now() + WA_ELEVATE_MIN * 60 * 1000 })));
  const sig = crypto.createHmac('sha256', WA_SESSION_SECRET).update('elev:' + payload).digest('base64url');
  return payload + '.' + sig;
}
// [F6] An elevation is granted FOR ONE JOB, for ONE command. A generic "the human did a Face ID
// recently" cookie must never satisfy a destructive approval - that is what let one Face ID
// approve anything staged inside the window. jobId is compared with the constant-time waEq, and
// the command is re-hashed from the job's CURRENT arguments, so an edited command is refused.
function waElevatedForJob(req: express.Request, jobId: string, command: string): boolean {
  if (!waElevatedOk(req)) return false;
  if (!jobId || !command) return false;
  const c = waCookie(req, 'gate_elevated'); if (!c || c.indexOf('.') < 0) return false;
  let p: any;
  try { p = JSON.parse(Buffer.from(c.split('.')[0], 'base64url').toString()); } catch (e) { return false; }
  if (!p || p.k !== 'elev') return false;
  if (!p.j || !waEq(String(p.j), String(jobId))) return false;
  const curSha = crypto.createHash('sha256').update(String(command)).digest('hex');
  if (!p.c || !waEq(String(p.c), curSha)) return false;
  return true;
}
function waElevatedOk(req: express.Request): boolean {
  if (!WA_SESSION_SECRET_OK) return false;
  const c = waCookie(req, 'gate_elevated'); if (!c || c.indexOf('.') < 0) return false;
  const parts = c.split('.'); const payload = parts[0]; const sig = parts[1];
  const expect = crypto.createHmac('sha256', WA_SESSION_SECRET).update('elev:' + payload).digest('base64url');
  if (!waEq(sig, expect)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
async function waGetCreds(): Promise<any[]> {
  const snap = await db.collection('webauthn_credentials').where('user', '==', WA_USER).get();
  return snap.docs.map((d: any) => d.data());
}
async function waStoreCredential(v: any, req: express.Request): Promise<string> {
  const info: any = v.registrationInfo;
  const credentialID: string = info.credentialID;
  if (!credentialID) throw new Error('no credentialID in registrationInfo');
  await db.collection('webauthn_credentials').doc(credentialID).set({
    user: WA_USER, credentialID, publicKey: isoBase64URL.fromBuffer(info.credentialPublicKey), counter: info.counter || 0,
    transports: (req.body.response && req.body.response.response && req.body.response.response.transports) || [], created_at: FieldValue.serverTimestamp(),
  });
  return credentialID;
}
async function waRegOptions(res: express.Response): Promise<void> {
  const creds = await waGetCreds();
  const options = await generateRegistrationOptions({
    rpName: WA_RP_NAME, rpID: WA_RP_ID, userID: Buffer.from(WA_USER), userName: WA_USER, attestationType: 'none',
    excludeCredentials: creds.map((c: any) => ({ id: c.credentialID, transports: c.transports || undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  waSetChal(res, 'wa_reg', options.challenge);
  res.json(options);
}
async function waVerifyAssertion(response: any, expectedChallenge: string): Promise<boolean> {
  if (!response || !response.id) return false;
  const doc = await db.collection('webauthn_credentials').doc(response.id).get();
  if (!doc.exists) return false;
  const c: any = doc.data();
  let v: any;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: WA_RP_ORIGIN, expectedRPID: WA_RP_ID, requireUserVerification: true,
      authenticator: { credentialID: c.credentialID, credentialPublicKey: isoBase64URL.toBuffer(c.publicKey), counter: c.counter || 0, transports: c.transports || undefined },
    });
  } catch (e) { console.error('[gate] SECURITY: verifyAuthenticationResponse THREW -- treating as not-verified. This is almost always a library/parameter mismatch, not a bad passkey. Do not remove this log: its absence turned a @simplewebauthn v11 rename into a silent lockout.', e); return false; }
  if (!v.verified) return false;
  await doc.ref.update({ counter: v.authenticationInfo.newCounter });
  return true;
}
async function waLegacyApply(jobId: string, action: string): Promise<void> {
  const cpAction = action === 'approve' ? 'confirmed' : 'denied';
  await db.collection('pending_confirms').doc(jobId).update({ status: cpAction, confirmed_by: 'passkey:' + WA_USER, confirmed_at: FieldValue.serverTimestamp() });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'human_' + cpAction, message: 'Passkey/FaceID ' + cpAction + ' job ID ' + jobId + '.', timestamp: FieldValue.serverTimestamp() });
}
// [GATE-GOOGLE-EXPIRY-V1] AN EXPIRED CONNECTION IS NOT A REFUSAL, AND THE TWO MUST NOT
// SHARE ONE ANSWER. This function returned null for FOUR different facts -- the token had
// expired or been revoked, the token was minted for a different OAuth client, the token
// carried no verified address, or tokeninfo could not be reached at all -- and its one
// caller turned every one of them into "Google identity not an authorized approver". The
// operator therefore read a LAPSED CREDENTIAL as a REFUSED PERSON. That wording sends him
// looking for a permission problem he does not have, and the only recovery anyone ever
// found was to destroy the page, because the lapsed token lives nowhere else.
// waGoogleIdentity() reports WHICH. Nothing about WHO is admitted changes: the caller still
// requires a verified address that is on WA_APPROVER_EMAILS, and every outcome that is not
// 'ok' still refuses. This widens the EXPLANATION, never the ADMISSION.
//   'ok'           verified, audience-bound address returned
//   'unconfigured' WA_GOOGLE_CLIENT_ID unset -- no token can be bound to this app
//   'rejected'     GOOGLE ITSELF would not resolve the token: expired, revoked or malformed
//   'audience'     a valid token, but minted for a DIFFERENT OAuth client
//   'unverified'   a valid token carrying no verified email address
//   'transport'    tokeninfo could not be reached, so we do not know and must not guess
async function waGoogleIdentity(token: string): Promise<{ email: string | null; why: string }> {
  // HFC5 fail-closed: an access token is only evidence of identity TO THE CLIENT IT WAS
  // ISSUED TO. /oauth2/v3/userinfo happily resolves a token minted for any other OAuth
  // client, so trusting it alone lets any relying party the approver has signed into mint
  // a token that passes this gate. Verify the AUDIENCE first, then the address.
  if (!WA_GOOGLE_CLIENT_ID) {
    console.error('[gate] SECURITY: WA_GOOGLE_CLIENT_ID is unset — cannot bind a Google token to this app, god-mode identity DENIED (fail-closed).');
    return { email: null, why: 'unconfigured' };
  }
  try {
    // [SEC-TOKENINFO-POST] the credential travels in the request BODY, never the URL. A query
    // string is logged by every hop (our egress proxy, Google's front end, any corporate MITM),
    // lands in Referer headers, and survives in shell/process listings. tokeninfo accepts the
    // same parameter form-encoded over POST and returns the identical JSON, so only the
    // transport changed here -- the response handling below is untouched.
    const ti = await waFetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'access_token=' + encodeURIComponent(token) });
    if (!ti) return { email: null, why: 'transport' };
    // GOOGLE REJECTING THE TOKEN AND US FAILING TO ASK ARE DIFFERENT FACTS. tokeninfo answers
    // 4xx for a token it will not resolve -- the expired/revoked case, which is the one the
    // operator meets daily -- and 5xx when Google itself is unwell. Neither admits anybody;
    // they are separated only so the caller can say which happened.
    if (!ti.ok) return { email: null, why: (ti.status >= 400 && ti.status < 500) ? 'rejected' : 'transport' };
    const t: any = await ti.json();
    // aud must be OUR client id. Google returns aud as a string; compare in constant time.
    const aud = String((t && (t.aud || t.audience)) || '');
    if (!aud || !waEq(aud, WA_GOOGLE_CLIENT_ID)) {
      console.error('[gate] SECURITY: god-mode token audience mismatch (aud=' + aud.slice(0, 24) + '...) — DENIED.');
      return { email: null, why: 'audience' };
    }
    // Google returns email_verified as the string 'true' on this endpoint.
    const verified = String((t && t.email_verified) || '') === 'true' || (t && t.email_verified) === true;
    const email = String((t && t.email) || '').toLowerCase().trim();
    if (!email || !verified) {
      console.error('[gate] SECURITY: god-mode token has no verified email — DENIED.');
      return { email: null, why: 'unverified' };
    }
    return { email, why: 'ok' };
  } catch (e) { return { email: null, why: 'transport' }; }
}
// Unchanged contract for every caller that only needs the address: an email, or null. The
// approval-signature approver resolution below reads it exactly as it did before.
async function waGoogleEmail(token: string): Promise<string | null> {
  return (await waGoogleIdentity(token)).email;
}
async function waIdToken(audience: string): Promise<string> {
  const r = await waFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(audience), { headers: { 'Metadata-Flavor': 'Google' } });
  return (await r.text()).trim();
}
async function waAccessToken(): Promise<string> {
  const r = await waFetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  const j: any = await r.json(); return (j && j.access_token) || '';
}

// ---- [SEC-APPROVAL-KMSSIG-V1] Stage C: ASYMMETRIC approval signatures (signing half) ----
// The Stage-A/B control is an HMAC whose key gate-exec ALSO holds, so the executor can mint
// a valid approval for any command it likes -- it is a signing oracle for its own approvals.
// Only asymmetry closes that: the control plane signs with a Cloud KMS EC_SIGN_P256_SHA256
// key version it alone may use, and the executor verifies with the PUBLIC key. This is the
// SIGNING half; the verifier is gate-exec/exec_server.py.
//
// CANONICALISATION IS THE ENTIRE SECURITY ARGUMENT, which is why it is a named, documented,
// separately testable function and not an inline concat. `jobId + '|' + _cmdSha` was safe
// only by accident: both operands happen to be fixed-shape. The moment approver identity, a
// key version and an expiry join the message, '|' becomes forgeable -- an approver string
// ending in '|<a key version>' is indistinguishable from a different approver plus that key
// version, and a signature over one tuple verifies as a signature over the other. Every
// field below is preceded by its UTF-8 BYTE length, so no value can impersonate a delimiter.
//
// SPEC AND CROSS-LANGUAGE TEST VECTORS: pcApprovalCanonV1 below IS the specification. Every
// field is length-prefixed and emitted in the fixed order named by PC_APPROVAL_CANON_ORDER,
// and any verifier -- in any language -- must reproduce these bytes exactly.
const PC_APPROVAL_CANON_ID = 'PC-APPROVAL-CANON-V1';
const PC_APPROVAL_SIG_ALG = 'EC_SIGN_P256_SHA256';
// Fixed order. Not sorted at runtime, not derived from Object.keys: a locale-, insertion- or
// engine-dependent order would silently produce different bytes on the two sides.
const PC_APPROVAL_CANON_ORDER: string[] = ['alg', 'jid', 'csha', 'appr', 'kver', 'iat', 'exp'];
// [PC-APPROVAL-CANON-V2] THIS FUNCTION IS NO LONGER CALLED BY THE SIGNER AND IS KEPT ANYWAY.
// gate-exec still ACCEPTS V1 stamps during migration, so V1's bytes are still a live part of
// the system's behaviour, and this remains their executable specification -- the thing the
// cross-language equivalence vectors are run against. It is deleted in the commit that sets
// APPROVAL_ACCEPT_CANON_V1=0 everywhere, not before: deleting the spec while the verifier
// still implements it is how a canon quietly acquires two meanings.
function pcApprovalCanonV1(f: { alg: string; jid: string; csha: string; appr: string; kver: string; iat: string; exp: string }): Buffer {
  const parts: Buffer[] = [Buffer.from(PC_APPROVAL_CANON_ID + '\n', 'utf8')];
  for (const n of PC_APPROVAL_CANON_ORDER) {
    const v = (f as any)[n];
    // A non-string here would stringify differently in the two languages (null, undefined,
    // 3 vs '3'). Refuse instead: an unsigned approval is recoverable, a mis-signed one is not.
    if (typeof v !== 'string') throw new Error('approval canon: field ' + n + ' must be a string');
    const nb = Buffer.from(n, 'utf8');
    // Buffer.byteLength semantics, NEVER String.length. '—'.length is 1 and its UTF-8
    // length is 3; Python's len() over a str counts the other one again. A verifier that
    // counts characters derives different bytes and refuses every genuine approval.
    const vb = Buffer.from(v, 'utf8');
    parts.push(Buffer.from(String(nb.length) + ':', 'ascii'), nb,
               Buffer.from('=' + String(vb.length) + ':', 'ascii'), vb,
               Buffer.from(';', 'ascii'));
  }
  return Buffer.concat(parts);
}
// ---- [PC-APPROVAL-CANON-V2] THE EXECUTION CONTEXT JOINS THE SIGNED BYTES ----
// WHAT V1 LEFT OUT. V1 signs alg, jid, csha, appr, kver, iat, exp. That proves a named human
// approved THIS COMMAND TEXT for THIS JOB ID under THIS KEY inside THIS WINDOW, and it says
// nothing whatever about HOW the text is executed. gate-exec reads command_type and
// arguments.targetNode off the job document and those two select
//     ssh -o StrictHostKeyChecking=no -i <key> <targetNode> <command>
// versus a local bash. NEITHER WAS SIGNED. So a principal holding roles/datastore.user could
// take a command a human genuinely approved for local execution, set command_type to 'ssh',
// point targetNode at a machine the approver never saw, and every signed byte still verified.
// Firestore integrity was the only thing standing in that gap, and the removal of gate-exec's
// roles/datastore.user grant is the direction of travel, so it cannot stay the only thing.
//
// [SEC-SSHTOOL-REMOVED-V1] THE ssh BRANCH DESCRIBED ABOVE NO LONGER EXISTS -- ssh_executor and
// the executor's ssh path were both removed as dead, and gate-exec now has one execution path.
// ctyp AND asha STAY SIGNED ANYWAY, AND NARROWING THE CANON TO "THE ONE BRANCH THAT REMAINS"
// WOULD BE A MISTAKE. What these two fields actually buy is that the approval names WHICH
// execution semantics were authorised; the ssh branch was merely the first thing that could
// diverge from them. Sign only what today's code branches on and the gap silently reopens the
// day a second branch is added -- by whoever adds it, who will not read this. The canon is
// unchanged; only the example above is now historical.
//
// THE V2 FIELD SET, AND WHY THESE NAMES IN THIS ORDER:
//
//     alg  jid  csha  ctyp  asha  appr  kver  iat  exp
//
// The two new fields are INSERTED after csha, not appended after exp, and that is a choice
// rather than a convenience. Fields 2-5 now say WHAT IS BEING AUTHORISED -- which job, which
// command text, which execution branch, which arguments -- and fields 6-9 say WHO AUTHORISED
// IT, UNDER WHICH KEY, AND FOR HOW LONG. That is the grouping V1 already had; the new facts
// go in the group they belong to instead of being parked at the end. A reviewer diffing V1
// against V2 then reads an INSERTION INTO ONE GROUP rather than a nine-field permutation, and
// a permutation is the change most likely to be waved through unread.
//
//   ctyp  the job's command_type, verbatim, '' when the field is absent. It is the branch
//         selector, so it is the single smallest edit that redirects an approved command.
//   asha  sha256, lowercase hex, of the canonicalised arguments object. THE HASH, NOT THE
//         OBJECT: arguments is unbounded and inlining it would carry a whole script into the
//         signed message twice, once inside asha and once inside csha.
//
// WHY A HASH OF THE WHOLE ARGUMENTS OBJECT RATHER THAN A targetNode FIELD. targetNode lives
// INSIDE arguments. Hashing the object covers targetNode and every other argument in one
// field, including arguments gate-exec does not read today but may read tomorrow. A dedicated
// targetNode field would be a second, weaker statement of a fact asha already makes, and it
// would need its own convention for absence that could disagree with the object's.
//
// csha IS KEPT even though asha covers arguments.command, because csha is taken over the
// command string AFTER gate-exec's command/cmd precedence, which is not recoverable from asha
// alone. Retiring a control that works in order to tidy a field list is not a trade made here.
//
// THE FRAMING IS V1'S, UNCHANGED: the same length-prefixed fields, the same Buffer.byteLength
// semantics, so ':' '=' ';' '|', LF and NUL stay legal inside ctyp and asha with no escaping
// and no rejection. The two new fields inherit that property rather than needing a fresh
// argument for it. Only the DOMAIN line changes besides the fields, and it must: a V1 message
// and a V2 message begin with different bytes, so a signature over one can never be replayed
// as a signature over the other -- which is what makes accepting both during migration a
// bounded decision rather than an open one.
const PC_APPROVAL_CANON_V2_ID = 'PC-APPROVAL-CANON-V2';
const PC_APPROVAL_CANON_V2_ORDER: string[] = ['alg', 'jid', 'csha', 'ctyp', 'asha', 'appr', 'kver', 'iat', 'exp'];
function pcApprovalCanonV2(f: { alg: string; jid: string; csha: string; ctyp: string; asha: string; appr: string; kver: string; iat: string; exp: string }): Buffer {
  const parts: Buffer[] = [Buffer.from(PC_APPROVAL_CANON_V2_ID + '\n', 'utf8')];
  for (const n of PC_APPROVAL_CANON_V2_ORDER) {
    const v = (f as any)[n];
    // Same refusal as V1: a non-string would stringify differently in the two languages.
    if (typeof v !== 'string') throw new Error('approval canon: field ' + n + ' must be a string');
    const nb = Buffer.from(n, 'utf8');
    // Buffer.byteLength semantics, NEVER String.length -- see the V1 note above.
    const vb = Buffer.from(v, 'utf8');
    parts.push(Buffer.from(String(nb.length) + ':', 'ascii'), nb,
               Buffer.from('=' + String(vb.length) + ':', 'ascii'), vb,
               Buffer.from(';', 'ascii'));
  }
  return Buffer.concat(parts);
}
// [PC-APPROVAL-CANON-V2] THE ARGUMENTS ARE CANONICALISED BY pcStableJson, WHICH ALREADY EXISTS
// AND IS ALREADY TRUSTED. It is the function pcApproveDrift uses to decide whether a displayed
// job and a stored job are the same job, precisely so key order cannot make one intention look
// like two, and it is deliberately reused here rather than reimplemented: two canonicalisers
// in one file is two things to keep in step, and this fleet has already paid for that lesson.
//
// WHAT THIS ADDS IS A GUARD, NOT A SECOND SERIALISER. gate-exec has to rebuild these exact
// bytes in Python, and there are values pcStableJson will happily serialise that the two
// languages DO NOT SPELL THE SAME WAY:
//   * non-integral and out-of-safe-range numbers -- V8 and CPython switch to exponent notation
//     at different magnitudes, and Firestore hands Python an int where it hands us a Number;
//   * anything that is not null/boolean/number/string/array/plain object -- a Date, a Buffer,
//     a Firestore Timestamp or DocumentReference has no agreed JSON spelling at all;
//   * strings carrying an unpaired UTF-16 surrogate, which [SEC-CANON-SURROGATE-V1] already
//     refuses for the command and which are refused here for every other argument too.
// Each of those THROWS. The throw is caught by the fail-soft wrapper around the signing block
// below, so the effect is that no V2 signature is stamped for a job whose arguments we could
// not honestly promise the verifier can rebuild -- rather than stamping one that will fail to
// verify later, at the executor, after the human has already spent a tap.
function pcCanonUnsafeArg(v: any): string {
  if (v === null || v === undefined) return '';
  const t = typeof v;
  if (t === 'boolean') return '';
  if (t === 'number') {
    if (!Number.isFinite(v)) return 'a non-finite number';
    if (!Number.isInteger(v)) return 'a non-integral number';
    if (!Number.isSafeInteger(v)) return 'an integer outside the safe range';
    return '';
  }
  if (t === 'string') return pcLoneSurrogate(v) ? 'a string containing an unpaired UTF-16 surrogate' : '';
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const w = pcCanonUnsafeArg(v[i]); if (w) return w; }
    return '';
  }
  if (t === 'object') {
    // PLAIN OBJECTS ONLY. A class instance serialises through pcStableJson as its own
    // enumerable keys and would silently drop everything else, so it is refused rather than
    // half-signed.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return 'an object that is not a plain object';
    const k = Object.keys(v);
    for (let i = 0; i < k.length; i++) {
      if (pcLoneSurrogate(k[i])) return 'an object key containing an unpaired UTF-16 surrogate';
      const w = pcCanonUnsafeArg(v[k[i]]); if (w) return w;
    }
    return '';
  }
  return 'a value of type ' + t;
}
// ABSENT AND NULL ARE THE SAME VALUE HERE, DELIBERATELY, and gate-exec's pc_canon_args_sha
// makes the same choice: a job with no arguments field and a job whose arguments field is null
// both canonicalise to the four bytes 'null'. Note that the verifier must read the RAW field
// for this and not its own {} default -- '{}' and 'null' are different bytes.
function pcApprovalArgsSha(args: any): string {
  const a = args === undefined ? null : args;
  const why = pcCanonUnsafeArg(a);
  if (why) throw new Error('approval canon: the arguments cannot be canonicalised identically by the verifier (' + why + ')');
  return crypto.createHash('sha256').update(pcStableJson(a), 'utf8').digest('hex');
}
// The key version is CONFIGURATION and is never derived from the job, the request or the
// document: anything that let an attacker choose it would let them name a key they hold.
// Unset means Stage C is simply not emitted and Stage A/B behaviour is bit-for-bit unchanged.
const PC_APPROVAL_SIG_KEY = String(process.env.APPROVAL_SIG_KEY_VERSION || '');
const PC_APPROVAL_SIG_TTL_SEC = Math.max(60, Number(process.env.APPROVAL_SIG_TTL_SEC || 3600));
const PC_APPROVAL_SIG_TIMEOUT_MS = Math.max(1000, Number(process.env.APPROVAL_SIG_TIMEOUT_MS || 8000));
async function pcApprovalSign(canonBytes: Buffer): Promise<string> {
  if (!PC_APPROVAL_SIG_KEY) throw new Error('approval sign: APPROVAL_SIG_KEY_VERSION unset');
  const digest = crypto.createHash('sha256').update(canonBytes).digest('base64');
  const tok = await waAccessToken();
  // EXPLICIT DEADLINE. A stalled KMS connection resolves neither way for minutes, and this
  // sits directly in front of a human waiting on their own approval tap. The vault reader was
  // bitten by exactly this shape of hang.
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, PC_APPROVAL_SIG_TIMEOUT_MS);
  try {
    const r = await waFetch('https://cloudkms.googleapis.com/v1/' + PC_APPROVAL_SIG_KEY + ':asymmetricSign', {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest: { sha256: digest } }),
    });
    if (!r || !r.ok) { let t = ''; try { t = r ? await r.text() : ''; } catch (e) {} throw new Error('KMS asymmetricSign failed: ' + (r && r.status) + ' ' + String(t).slice(0, 200)); }
    const j: any = await r.json();
    const sig = j && j.signature;
    if (!sig) throw new Error('KMS asymmetricSign: no signature in response');
    // KMS echoes the key version it ACTUALLY signed with. If that is not the version we asked
    // for, the stamp would name a key that did not make this signature and every verifier
    // would fetch the wrong public key. Refuse rather than emit a mislabelled stamp.
    const used = String((j && j.name) || '');
    if (used && used !== PC_APPROVAL_SIG_KEY) throw new Error('KMS asymmetricSign: signed by ' + used + ', expected ' + PC_APPROVAL_SIG_KEY);
    return String(sig);
  } finally { clearTimeout(timer); }
}
async function waBqBillingTable(): Promise<string> {
  const tok = await waAccessToken();
  const r = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/datasets/' + GCP_BILLING_DATASET + '/tables?maxResults=100', { headers: { Authorization: 'Bearer ' + tok } });
  const j: any = await r.json();
  const ids = (j.tables || []).map((x: any) => (x.tableReference && x.tableReference.tableId) || '').filter((x: string) => x.indexOf('gcp_billing_export_v1_') === 0);
  return ids[0] || '';
}
async function waBqQuery(sql: string): Promise<any> {
  const tok = await waAccessToken();
  const r = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/queries', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25000 }),
  });
  return await r.json();
}

// ==================== [SEC-BQ-ARCHIVE-V1] the forever-archive in BigQuery ====================
// journal and chat_history rows expire from Firestore ([SEC-TTL-CHOKEPOINT-V1]); the archive
// in BigQuery is kept FOREVER (operator parameter). Raw REST against bigquery.googleapis.com
// with the metadata-server token, the exact pattern waBqQuery above already uses -- NO new npm
// dependency, deliberately: the Dockerfile transpiles rather than bundles, so every import
// must resolve from node_modules at runtime, and the Storage Write API client would be a new
// one. Streaming insertAll is enough for a best-effort mirror.
//
// ORDERING HAZARD: the dual-write captures NEW writes only. Enabling the Firestore TTL
// policy before the archive dataset is created AND seeded from the existing collections
// destroys every pre-deploy transcript with no copy. Sequence and commands:
// deploy/TTL-BIGQUERY-INFRA.md (create dataset/tables -> seed -> deploy this -> only then TTL).
//
// COST DISCIPLINE, all four teeth:
//   - maximumBytesBilled = 2 GiB on EVERY query, enforced SERVER-SIDE by BigQuery, so no
//     future edit of the SQL string can quietly bypass it;
//   - tables are DAY-partitioned on ts, clustered on agent_id, require_partition_filter=true
//     (DDL in the infra doc), and every query here carries a partition filter;
//   - a per-instance scan budget of ~144 GB per UTC month (~14% of the 1 TiB free tier);
//   - the archive is consulted ONLY when live Firestore under-delivers, so the common path
//     costs zero and stays byte-identical to the pre-archive behaviour.
// Rows written to Firestore by src/runner/*.py are TTL-stamped there but NOT dual-written
// (those processes have no archive path); they reach BigQuery via the idempotent re-seed
// MERGE in the infra doc. Dedup on read is by document id either way.
const PC_ARCHIVE_DATASET = process.env.PC_ARCHIVE_DATASET || 'pc_archive';
const PC_ARCHIVE_OFF = String(process.env.PC_ARCHIVE || '').toLowerCase() === 'off';
const PC_ARCH_MAX_BYTES_BILLED = '2147483648';
const PC_ARCH_MONTH_BYTES_CAP = 144000000000;
const PC_ARCH_BUDGET: { month: string; bytes: number } = { month: '', bytes: 0 };
let PC_ARCH_WARN_AT = 0;
// The dual-write is BEST EFFORT by operator parameter, so a failure is a rate-limited log
// line and never the caller's problem. This catch-and-log is the DECREED behaviour for this
// side channel, not a swallowed deploy error: the Firestore write it mirrors has already
// succeeded, and Firestore remains the source of truth for 120 days.
function pcArchWarn(msg: string): void {
  const now = Date.now();
  if (now - PC_ARCH_WARN_AT < 300000) return;
  PC_ARCH_WARN_AT = now;
  try { console.warn('[SEC-BQ-ARCHIVE-V1] ' + msg); } catch (e) {}
}
// PURE: shape one BigQuery row from a Firestore payload. FieldValue.serverTimestamp()
// sentinels carry no time yet, so a sentinel timestamp becomes nowIso -- within clock skew
// of what Firestore will record, and exact enough for an archive keyed by doc_id.
function pcArchiveRow(coll: string, docId: string, data: any, nowIso: string): any {
  const d: any = (data && typeof data === 'object') ? data : {};
  const s = (v: any): string => (typeof v === 'string') ? v : ((typeof v === 'number' || typeof v === 'boolean') ? String(v) : '');
  const when = (v: any): string => {
    const ms = tsMillis(v);
    if (ms) return new Date(ms).toISOString();
    if (v instanceof Date) return v.toISOString();
    return nowIso;
  };
  if (coll === 'journal') {
    return { doc_id: docId, agent_id: s(d.agent_id), action: s(d.action), message: s(d.message), job_id: s(d.job_id), ts: when(d.timestamp) };
  }
  return { doc_id: docId, agent_id: s(d.agent_id), role: s(d.role), text: s(d.text), tags: JSON.stringify(Array.isArray(d.tags) ? d.tags : []), session: s(d.session), ts: when(d.timestamp) };
}
// Fire-and-forget mirror of one just-written document. Never throws; see pcArchWarn above.
// insertId = the Firestore document id, so BigQuery's own streaming dedup and the read-side
// dedup agree on what "the same row" means.
async function pcArchiveOnWrite(coll: string, docId: string, data: any): Promise<void> {
  if (PC_ARCHIVE_OFF || !docId) return;
  const table = PC_ARCHIVE_COLLS[coll];
  if (!table) return;
  try {
    const row = pcArchiveRow(coll, docId, data, new Date().toISOString());
    const tok = await waAccessToken();
    const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/datasets/' + PC_ARCHIVE_DATASET + '/tables/' + table + '/insertAll', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'bigquery#tableDataInsertAllRequest', rows: [{ insertId: docId, json: row }] }),
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || (j && Array.isArray(j.insertErrors) && j.insertErrors.length)) {
      pcArchWarn('dual-write to ' + PC_ARCHIVE_DATASET + '.' + table + ' FAILED (HTTP ' + String(r.status) + '). The Firestore write succeeded; the archive is missing this row until the next re-seed (deploy/TTL-BIGQUERY-INFRA.md). If the dataset does not exist yet, run the infra doc steps IN ORDER.');
    }
  } catch (e: any) {
    pcArchWarn('dual-write threw: ' + String((e && e.message) || e) + '. The Firestore write succeeded; the archive catches up at the next re-seed.');
  }
}
// PURE: the one parameterised query both history tools use. STRPOS, never LIKE -- the needle
// is DATA and must not be interpretable as a pattern -- and every string is a named query
// parameter, never spliced into the SQL. The only inlined values are the project/dataset
// identifiers (env-derived, identifiers cannot be parameterised in SQL) and the two integer
// literals produced by clamping below. The partition filter (ts >= 3650 days back) satisfies
// require_partition_filter; widen it in one place if the archive ever outlives a decade.
function pcArchSql(project: string, dataset: string, lim: number): string {
  const n = Math.max(1, Math.min(500, Math.floor(Number(lim) || 0) || 30));
  return 'SELECT doc_id, agent_id, role, text, tags, session, ts FROM `' + project + '.' + dataset + '.chat_history`'
    + ' WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3650 DAY)'
    + ' AND agent_id = @agent'
    + " AND (@q = '' OR STRPOS(LOWER(text), @q) > 0 OR STRPOS(LOWER(tags), @q) > 0)"
    + " AND (@role = '' OR role = @role)"
    + ' ORDER BY ts DESC LIMIT ' + String(n);
}
// PURE: named string parameters in BigQuery REST shape.
function pcArchParams(vals: { [k: string]: string }): any[] {
  const out: any[] = [];
  for (const k of Object.keys(vals)) {
    out.push({ name: k, parameterType: { type: 'STRING' }, parameterValue: { value: String(vals[k]) } });
  }
  return out;
}
async function pcArchQuery(sql: string, params: { [k: string]: string }): Promise<any> {
  const tok = await waAccessToken();
  const r: any = await waFetch('https://bigquery.googleapis.com/bigquery/v2/projects/' + GCP_PROJECT + '/queries', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, parameterMode: 'NAMED', queryParameters: pcArchParams(params), maximumBytesBilled: PC_ARCH_MAX_BYTES_BILLED, timeoutMs: 20000 }),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) {
    const msg = String((j && j.error && j.error.message) || ('HTTP ' + String(r && r.status)));
    return { ok: false, err: msg, tooExpensive: /bytesbilled|bytes billed|byte limit/i.test(msg) };
  }
  if (j.jobComplete === false) return { ok: false, err: 'query did not complete within timeoutMs', tooExpensive: false };
  const fields: any[] = (j.schema && j.schema.fields) || [];
  const rows: any[] = (j.rows || []).map((rw: any) => {
    const o: any = {};
    (rw.f || []).forEach((c: any, i: number) => { o[String((fields[i] && fields[i].name) || i)] = c && c.v; });
    return o;
  });
  return { ok: true, rows: rows, bytes: Number(j.totalBytesProcessed || 0) };
}
// PURE: one archive result row in the same shape the live rows serve. BigQuery serves
// TIMESTAMP as epoch SECONDS in a decimal string; timestamp becomes an ISO string here, which
// pcRowMillis below understands alongside live Firestore Timestamps. archived:true marks
// provenance so a reader can tell which half of a merged answer each row came from.
function pcArchHistRow(r: any): any {
  let tags: any = [];
  try { tags = JSON.parse(String((r && r.tags) || '[]')); } catch (e) { tags = []; }
  if (!Array.isArray(tags)) tags = [];
  const ms = Math.round(Number((r && r.ts) || 0) * 1000) || 0;
  return { id: String((r && r.doc_id) || ''), agent_id: String((r && r.agent_id) || ''), role: String((r && r.role) || ''), text: String((r && r.text) || ''), tags: tags, session: String((r && r.session) || ''), timestamp: ms ? new Date(ms).toISOString() : '', archived: true };
}
// PURE: millis for sorting across BOTH row kinds (live Firestore Timestamp / archive ISO string).
function pcRowMillis(row: any): number {
  const t = row && row.timestamp;
  const ms = tsMillis(t);
  if (ms) return ms;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string' && t) { const p = Date.parse(t); if (!isNaN(p)) return p; }
  return 0;
}
// PURE: dedup BY DOCUMENT ID. fsIds is every id the live read FETCHED (not only the ones
// served): a document the live side saw and filtered out must not sneak back in through its
// archive copy, and a duplicate among the archive rows themselves is dropped the same way.
function pcArchMergeDedup(fsRows: any[], fsIds: string[], archRows: any[]): any[] {
  const seen: { [id: string]: boolean } = {};
  for (const id of (fsIds || [])) { if (id) seen[id] = true; }
  const merged = (fsRows || []).slice();
  for (const r of (archRows || [])) {
    const id = String((r && r.id) || '');
    if (!id || seen[id]) continue;
    seen[id] = true;
    merged.push(r);
  }
  return merged;
}
// PURE: consult the archive ONLY when live Firestore under-delivers -- either it served
// fewer rows than asked for, or its pre-existing 3000-document no-orderBy scan window was
// FULL, in which case the live subset is arbitrary and recall cannot be trusted.
function pcArchFallbackDecision(served: number, requested: number, fsScanTruncated: boolean): { consult: boolean; reason: string } {
  if (fsScanTruncated) return { consult: true, reason: 'the live Firestore scan hit its 3000-document window' };
  if (served < requested) return { consult: true, reason: 'live Firestore served ' + String(served) + ' of the ' + String(requested) + ' rows requested' };
  return { consult: false, reason: 'live Firestore served the full request' };
}
// PURE: the in-band notice. Every consultation says what happened -- served / unreachable /
// budget-spent / too-expensive -- and the pre-existing 3000-document truncation is REPORTED
// rather than left silent.
function pcArchNotice(why: string, outcome: string, fsScanTruncated: boolean): string {
  const parts: string[] = ['[SEC-BQ-ARCHIVE-V1]'];
  if (fsScanTruncated) parts.push('WARNING: the live Firestore read is capped at 3000 documents with NO orderBy and that cap was HIT, so the live half of this answer is an arbitrary subset.');
  parts.push('The BigQuery archive was consulted because ' + why + '.');
  parts.push(outcome);
  return parts.join(' ');
}
// PURE: notice placement, chosen by which end survives that tool's result-cap truncation.
// read_history is in PC_RESULT_CAP_TAIL (cut from the FRONT, tail survives): notice TRAILS.
// search_history is head-kept (cut from the BACK): notice LEADS.
function pcArchPlaceNotice(body: string, notice: string, keptTail: boolean): string {
  if (!notice) return body;
  return keptTail ? (body + '\n\n' + notice) : (notice + '\n\n' + body);
}
// PURE: per-instance monthly scan budget over UTC calendar months.
function pcArchMonthKey(nowMs: number): string { return new Date(nowMs).toISOString().slice(0, 7); }
function pcArchBudgetSpent(state: any, nowMs: number, capBytes: number): boolean {
  if (!state || state.month !== pcArchMonthKey(nowMs)) return false;
  return (Number(state.bytes) || 0) >= capBytes;
}
function pcArchBudgetCharge(state: any, nowMs: number, addBytes: number): { month: string; bytes: number } {
  const mkey = pcArchMonthKey(nowMs);
  const cur = (state && state.month === mkey) ? (Number(state.bytes) || 0) : 0;
  return { month: mkey, bytes: cur + Math.max(0, Number(addBytes) || 0) };
}
// PURE: classify the archive attempt into rows + the exact in-band outcome sentence. The
// failure paths are first-class here so the extracted-function tests can drive them.
function pcArchOutcome(budgetSpent: boolean, res: any, dataset: string): { rows: any[]; notice: string; bytes: number } {
  if (budgetSpent) {
    return { rows: [], bytes: 0, notice: 'Outcome: BUDGET-SPENT -- this instance has used its ~144 GB archive scan budget for the current UTC month, so the archive was NOT searched this time; older rows exist in BigQuery dataset ' + dataset + '. Narrow the query, or retry after the month rolls over.' };
  }
  if (!res || res.ok !== true) {
    const err = String((res && res.err) || 'no response');
    if (res && res.tooExpensive) {
      return { rows: [], bytes: 0, notice: 'Outcome: TOO-EXPENSIVE -- BigQuery refused the query at the server-side 2 GiB maximumBytesBilled cap (' + err + '); older rows were NOT searched. Narrow with query/role/limit.' };
    }
    // [SEC-BQ-UNPROVISIONED-V49] NOT PROVISIONED IS NOT BROKEN, AND SAYING SO IS THE WHOLE FIX.
    // MEASURED 2026-08-15 on prod: gen.py and install.sh mention bigquery ZERO times, and
    // `bq datasets list` returns 0 items -- so the archive does not exist on THIS fleet and has
    // never existed on ANY adopter's install. The tools ship; the provisioning does not. Until
    // now every one of those installs surfaced a raw 'Access Denied ... bigquery.jobs.create'
    // through this branch, which reads as a broken system rather than an optional feature that
    // was never switched on. That is the same defect shape the installer's 0/10 Firestore-region
    // check already paid for: a check that cries wolf on every fresh install is worse than no
    // check, because the operator who needs it is the one who has learned to scroll past it.
    // THREE OUTCOMES, NOT TWO, and the third one is the common case. Detection is on the error
    // BigQuery itself returns, not on a config flag, because a flag would claim provisioning
    // that may have been half-done: jobs.create denied is the IAM half missing, 'Not found:
    // Dataset' is the dataset half missing, and an unenabled API is neither. All three mean the
    // same thing to a reader -- nobody built this yet -- and none of them means the archive is
    // malfunctioning. A genuine fault still falls through to UNREACHABLE below, so this cannot
    // swallow a real failure: it recognises only the fingerprints of an install that never ran
    // the runbook.
    // CORRECTED 2026-08-15, WITHIN MINUTES OF DEPLOY, BY THE FLEET'S OWN PROD. After the
    // project-level grant landed, the next failure was NOT 'Not found: Dataset' but:
    //   Access Denied: Table <p>:pc_archive.chat_history: User does not have permission to
    //   query table <p>:pc_archive.chat_history, or perhaps it does not exist.
    // BigQuery answers a MISSING TABLE with an access-denied shape on purpose, so it does not
    // leak whether the table exists. The first version of this test only knew the dataset
    // wording, so it classified a half-provisioned install as a FAULT and told the reader the
    // archive 'appears to BE provisioned'. That is the exact wrong answer for the exact case
    // this branch exists to catch, and only a real install produced it.
    if (/bigquery[.]jobs[.]create|Not found: Dataset|Not found: Table|or perhaps it does not exist|permission to query table|has not been used in project|accessNotConfigured/i.test(err)) {
      return { rows: [], bytes: 0, notice: 'Outcome: NOT-PROVISIONED -- the BigQuery forever-archive is OPTIONAL and this install has not created it, so there are no older rows to search and nothing is broken. This answer is live Firestore only, which holds the most recent 120 days. To enable it, follow deploy/TTL-BIGQUERY-INFRA.md: it needs BOTH the dataset ' + dataset + ' (created and seeded) AND roles/bigquery.jobUser on this service on the project -- BigQuery requires jobs.create at project level to run any query, whatever the dataset ACL says. Do NOT enable the Firestore TTL until the archive is created and seeded, or pre-deploy transcripts are destroyed with no copy. Reported cause: ' + err + '.' };
    }
    return { rows: [], bytes: 0, notice: 'Outcome: UNREACHABLE -- the archive query failed (' + err + '); this answer is live Firestore only and older rows were NOT searched. The archive appears to BE provisioned on this install, so this is a fault rather than a missing setup.' };
  }
  const rows = (res.rows || []).map(pcArchHistRow);
  return { rows: rows, bytes: Math.max(0, Number(res.bytes) || 0), notice: 'Outcome: SERVED -- ' + String(rows.length) + ' archived row(s) considered, deduplicated against live rows by document id.' };
}
// The one archive entry point for both history tools. Thin on purpose: budget check (pure),
// one bounded query, outcome classification (pure), budget charge (pure).
async function pcArchHistFallback(agent: string, q: string, role: string, lim: number): Promise<{ rows: any[]; notice: string }> {
  if (PC_ARCHIVE_OFF) {
    return { rows: [], notice: 'Outcome: UNREACHABLE -- the archive is switched off on this service (PC_ARCHIVE=off); older rows were NOT searched.' };
  }
  const spent = pcArchBudgetSpent(PC_ARCH_BUDGET, Date.now(), PC_ARCH_MONTH_BYTES_CAP);
  let res: any = null;
  if (!spent) {
    try {
      res = await pcArchQuery(pcArchSql(GCP_PROJECT, PC_ARCHIVE_DATASET, lim), { agent: String(agent || ''), q: String(q || '').toLowerCase(), role: String(role || '') });
    } catch (e: any) {
      res = { ok: false, err: String((e && e.message) || e), tooExpensive: false };
    }
  }
  const out = pcArchOutcome(spent, res, PC_ARCHIVE_DATASET);
  if (out.bytes) {
    const st = pcArchBudgetCharge(PC_ARCH_BUDGET, Date.now(), out.bytes);
    PC_ARCH_BUDGET.month = st.month; PC_ARCH_BUDGET.bytes = st.bytes;
  }
  return { rows: out.rows, notice: out.notice };
}
// The two history tools' full logic, extracted to module scope so the verification suite can
// drive these exact bodies. The FIRST HALF of each is the pre-archive behaviour verbatim; on
// the common path (no consultation) the served bytes are IDENTICAL to what it served before.
async function pcSearchHistoryImpl(agent: string, a: any): Promise<any> {
  const snap = await db.collection('chat_history').where('agent_id', '==', agent).limit(3000).get();
  let rows = snap.docs.map((d: any) => d.data());
  rows.sort((x: any, y: any) => tsMillis(y.timestamp) - tsMillis(x.timestamp));
  if (a.role) rows = rows.filter((r: any) => r.role === a.role);
  if (a.query) {
    const q = String(a.query).toLowerCase();
    rows = rows.filter((r: any) =>
      (r.text || '').toLowerCase().includes(q) ||
      (Array.isArray(r.tags) ? r.tags.join(' ').toLowerCase().includes(q) : false));
  }
  const requested = a.limit || 20;
  rows = rows.slice(0, requested);
  const fsTrunc = snap.size >= 3000;
  const dec = pcArchFallbackDecision(rows.length, requested, fsTrunc);
  if (!dec.consult) {
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
  const arch = await pcArchHistFallback(agent, String(a.query || ''), String(a.role || ''), requested);
  const fsIds = snap.docs.map((d: any) => String(d.id));
  let merged = pcArchMergeDedup(rows, fsIds, arch.rows);
  merged.sort((x: any, y: any) => pcRowMillis(y) - pcRowMillis(x));
  merged = merged.slice(0, requested);
  // search_history is cut from the BACK by [MCP-RESULT-CAP-V1]: the notice LEADS.
  return { content: [{ type: 'text', text: pcArchPlaceNotice(JSON.stringify(merged, null, 2), pcArchNotice(dec.reason, arch.notice, fsTrunc), false) }] };
}
async function pcReadHistoryImpl(agent: string, a: any): Promise<any> {
  const snap = await db.collection('chat_history').where('agent_id', '==', agent).limit(3000).get();
  let rows = snap.docs.map((d: any) => d.data());
  rows.sort((x: any, y: any) => tsMillis(x.timestamp) - tsMillis(y.timestamp));
  const requested = a.limit || 30;
  rows = rows.slice(-requested);
  const fsTrunc = snap.size >= 3000;
  const dec = pcArchFallbackDecision(rows.length, requested, fsTrunc);
  if (!dec.consult) {
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
  const arch = await pcArchHistFallback(agent, '', '', requested);
  const fsIds = snap.docs.map((d: any) => String(d.id));
  let merged = pcArchMergeDedup(rows, fsIds, arch.rows);
  merged.sort((x: any, y: any) => pcRowMillis(x) - pcRowMillis(y));
  merged = merged.slice(-requested);
  // read_history is in PC_RESULT_CAP_TAIL (cut from the FRONT): the notice TRAILS.
  return { content: [{ type: 'text', text: pcArchPlaceNotice(JSON.stringify(merged, null, 2), pcArchNotice(dec.reason, arch.notice, fsTrunc), true) }] };
}
// ================== end [SEC-BQ-ARCHIVE-V1] ==================
function waIsDangerous(cmd: string): boolean {
  // [SEC-DANGER-GCLOUD-REST-V2] The original alternatives are kept VERBATIM and in order; this
  // change is PURELY ADDITIVE so anything that greps the old text still matches. What the old
  // regex missed, measured against real staged commands: `gcloud storage rm` (only `gsutil rm`
  // was covered, and gsutil is deprecated), `gcloud compute instances stop` (no verb but
  // `delete` was covered), and `curl -X DELETE .../instances/...` (no REST verb at all). All
  // three returned false and therefore skipped the second Face ID. Deliberately NOT added:
  // bare `start`, `create`, `describe`, `list`, `cp`, `deploy` -- a classifier that flags every
  // gcloud invocation gets clicked through, which is the same as having no classifier.
  return /(\bgcloud\b[^\n]*\bdelete\b)|(remove-iam-policy-binding)|(add-iam-policy-binding[^\n]*roles\/(owner|editor|resourcemanager|iam))|(\bsecrets\b[^\n]*\baccess\b)|(\brm\s+-rf\b)|(\bgsutil\b[^\n]*\brm\b)|(\bdestroy\b)|(\bmkfs\b)|(--no-backup)|(\bdrop\b\s+(table|database))|(\bgcloud\b[^\n]*\bstorage\b[^\n]*\b(rm|rb)\b)|(\bgcloud\b[^\n]*\b(compute|sql|container|run|functions|redis|spanner|dataproc|composer|notebooks|workstations)\b[^\n]*\b(stop|suspend|reset|terminate|abandon|detach)\b)|(\bgcloud\b[^\n]*\biam\b[^\n]*\b(disable|remove|purge)\b)|(\bservice-accounts\b[^\n]*\b(disable|delete)\b)|(\bset-iam-policy\b)|(\bsetIamPolicy\b)|(-X\s*['"]?(DELETE|PUT)\b)|(--request[\s=]+['"]?(DELETE|PUT)\b)|(\binstances\b[^\n]*\b(stop|delete|reset|terminate)\b)|(\bbuckets\b[^\n]*\bdelete\b)/i.test(cmd || '');
}
async function waJobCommand(jobId: string): Promise<{ ok: boolean; command?: string; err?: string; danger?: boolean }> {
  const jdoc = await db.collection('pending_confirms').doc(jobId).get();
  if (!jdoc.exists) return { ok: false, err: 'job not found' };
  const jx: any = jdoc.data();
  const command = (jx.arguments && (jx.arguments.command || jx.arguments.cmd)) || '';
  // SEC-DANGER-UNION-V1: carry the stager's own structured danger verdict out to the approval path.
  // harGcpStage already writes arguments.danger (from harGcpDanger) on every staged gcp_api job and
  // the gate read NONE of it -- the second Face ID hung entirely on a word inside a generated
  // comment. Returned on the no-command path too, deliberately: a job flagged dangerous by its
  // stager stays dangerous even when there is no command text left to classify (fail-dangerous).
  const danger = !!(jx.arguments && jx.arguments.danger === true);
  if (!command) return { ok: false, err: 'job has no command to run as approver', danger };
  return { ok: true, command, danger };
}
async function waExecuteApproved(jobId: string, command: string, token: string, assertion: any = null): Promise<{ exec: any; exit: number }> {
  // Shared execution CORE (refactored out of waRunGodmode). Base64 the command, hand it to the exec
  // engine, normalize the exit code, and return the raw result. Callers own the status/journal writes and
  // the identity attribution. `token` is the access_token forwarded to gate-exec: the human god-mode token
  // for confirm/verify; EMPTY for /api/jobs/fire (see preapprove-notes.md — gate-exec must then run under
  // its OWN scoped service identity, NOT a human token).
  const scriptB64 = Buffer.from(command, 'utf8').toString('base64');
  const exec: any = await waCallExec(scriptB64, token, jobId, assertion);
  const exit = (exec && typeof exec.exit_code === 'number') ? exec.exit_code : -1;
  return { exec, exit };
}
async function waRunGodmode(res: express.Response, jobId: string, command: string, gtoken: string, iapEmail: string = '', assertion: any = null): Promise<void> {
  // [SEC-IAP-GODMODE-V1] Google token when the client sent one; otherwise the IAP-verified
  // identity. Both are verified server-side; neither is client-asserted.
  let email = '';
  let _gwhy = 'ok';
  if (gtoken) { const _gi = await waGoogleIdentity(gtoken); email = _gi.email || ''; _gwhy = _gi.why; }
  else { email = String(iapEmail || '').toLowerCase().trim(); }
  // [GATE-GOOGLE-EXPIRY-V1] SAY WHICH OF THE TWO THINGS HAPPENED, AND SAY IT BEFORE THE
  // ALLOWLIST CHECK SO THE ALLOWLIST IS NEVER BLAMED FOR A LAPSED CREDENTIAL.
  // REACHED ONLY WHEN the client sent a token and Google would not resolve it. No identity
  // was established, and NOTHING BELOW THIS LINE HAS RUN: the job document is untouched, no
  // approval is stamped, claimed, spent or journalled as approved, and the queue is unchanged.
  // This is exactly as fail-closed as the 403 it replaces -- same evidence, same refusal,
  // nobody new admitted. It differs only in TELLING THE TRUTH about the cause, and in
  // carrying needGoogle so the gate can offer a reconnect IN PLACE. Without that, the page's
  // only signal was a red REFUSED, which is why the recovery the operator found by trial was
  // to close the browser tab -- the lapsed token lives in the page and nowhere else.
  if (gtoken && !email && (_gwhy === 'rejected' || _gwhy === 'transport')) {
    const _gexp = _gwhy === 'rejected';
    try { await db.collection('journal').add({ agent_id: 'human_operator', action: _gexp ? 'approve_google_expired' : 'approve_google_uncheckable', message: 'NOT APPROVED AND NOT REFUSED: job ' + String(jobId) + ' — ' + (_gexp ? 'the approver Google connection is expired or revoked, so no identity could be established' : 'Google could not be reached to resolve the approver identity') + '. Nothing was approved, stamped or executed and the job is still waiting.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    res.status(_gexp ? 412 : 503).json({
      error: _gexp ? 'google_expired' : 'google_check_failed',
      needGoogle: true, reconnect: _gexp, jobId: String(jobId), action: 'approve',
      message: _gexp
        ? 'Your Google connection has EXPIRED. This job was NOT refused and NOT approved — it is still waiting. Reconnect Google and approve once. You do not need to close this tab or unlock again.'
        : 'Google could not be reached to check who you are, so nothing was approved and this job is still waiting. This is not a refusal — try once more.'
    });
    return;
  }
  // HFC3 fail-closed: an EMPTY/unset approver allowlist must DENY god-mode entirely (previously an
  // empty list short-circuited the check and accepted ANY authenticated Google identity). Require a
  // configured allowlist AND a verified identity that is on it.
  if (!WA_APPROVER_EMAILS.length || !email || WA_APPROVER_EMAILS.indexOf(email) < 0) { res.status(403).json({ error: WA_APPROVER_EMAILS.length ? 'Google identity not an authorized approver' : 'god-mode disabled: no approver allowlist configured (set WA_APPROVER_EMAILS)' }); return; }
  const _pcRef = db.collection('pending_confirms').doc(jobId);
  // VERIFY-GREP: GATE-LOG-NOCLOBBER-V1   (fleet-advisor 2026-07-30)
  // A second Approve on a stale gate page used to DESTROY a finished job's record: this write
  // set status 'executing', gate-exec then correctly refused the replay with 409, and the
  // !execOk branch below wrote exec_failed / exit_code null / an EMPTY stdout_tail over the
  // real result. The single-use claim worked; the bookkeeping erased the proof that it had,
  // and the audit trail then read "nothing ran" for a job that had already run.
  // A COMPLETED job's document is APPEND-ONLY from here: a re-fire lands in refire_refused and
  // nothing else on the document is touched. `ran` is NOT stored -- read_job_log derives it as
  // status === 'executed' -- so both gates test status, never a `ran` field that is undefined.
  const _pcSnap = await _pcRef.get().catch(() => null);
  const _pcPrev = (_pcSnap && _pcSnap.exists) ? (_pcSnap.data() || {}) : {};
  // VERIFY-GREP: GATE-INFLIGHT-NOCLOBBER-V2   (fleet-advisor 2026-07-30)
  // V1 guarded 'executed' only, which is the wrong window. The command runs SYNCHRONOUSLY
  // inside this request (waCallExec is awaited before anything is written to res), waFetch has
  // NO timeout, and both Cloud Run services take the unset 300s default while gate-exec is
  // configured for 900s -- so the browser's fetch dies while the job is STILL RUNNING and the
  // status is still 'executing'. The second click walked past V1, gate-exec refused the replay
  // 409, and the !execOk branch overwrote a running job with exit_code null and "DID NOT RUN".
  // Nothing double-executed. The operator was simply lied to about a job that was working.
  //
  // STALE-LOCK ESCAPE HATCH, deliberate: a bare 'executing' refusal would be a self-inflicted
  // lockout, because a control plane that dies mid-flight leaves the document 'executing'
  // forever and the job becomes permanently unapprovable. 20 minutes sits comfortably above
  // gate-exec's own 900s ceiling. A missing or unreadable started_at reads 0 -> stale ->
  // ALLOWED. The escape hatch must never be the thing that jams.
  const _pcSt: any = (_pcPrev as any).started_at;
  let _pcMs = 0;
  try {
    if (_pcSt && typeof _pcSt.toMillis === 'function') { _pcMs = _pcSt.toMillis(); }
    else if (_pcSt && typeof _pcSt._seconds === 'number') { _pcMs = _pcSt._seconds * 1000; }
  } catch (e) { _pcMs = 0; }
  const _pcInflight = _pcPrev.status === 'executing' && _pcMs > 0 && (Date.now() - _pcMs) < 20 * 60 * 1000;
  if (_pcPrev.status === 'executed' || _pcInflight) {
    const _pcStage = _pcInflight ? 'pre-exec-inflight' : 'pre-exec';
    const _pcWhy = _pcInflight
      ? 'this job is still running from an earlier approval; its record is preserved and was not overwritten'
      : 'this job already ran; its record is preserved and was not overwritten';
    await _pcRef.update({ refire_refused: FieldValue.arrayUnion({ by: email, at: new Date().toISOString(), stage: _pcStage }) }).catch(() => {});
    await db.collection('journal').add({ agent_id: 'human_operator', action: 'godmode_refire_refused', message: 'replay approve refused for job ' + jobId + ' by ' + email + ': ' + _pcWhy, timestamp: FieldValue.serverTimestamp() });
    res.status(409).json({ ok: false, jobId, action: 'approve', mode: 'godmode', status: String(_pcPrev.status || ''), inflight: _pcInflight, error: _pcWhy, preserved_exit_code: (typeof _pcPrev.exit_code === 'number') ? _pcPrev.exit_code : null });
    return;
  }
  await _pcRef.update({ status: 'executing', started_by: email, started_at: FieldValue.serverTimestamp() }).catch(() => {});
  let exec: any; let exit: number;
  try { const _r = await waExecuteApproved(jobId, command, gtoken, assertion); exec = _r.exec; exit = _r.exit; }
  catch (e: any) { res.status(502).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); return; }
  // [F7] BRANCH ON THE EXECUTOR HTTP STATUS. waCallExec already stamps `j.http = r.status` and
  // nobody read it: a 403/404/500/502 from gate-exec was written as status 'executed' with
  // exit_code -1 and journalled 'godmode_executed', so a job that NEVER RAN was indistinguishable
  // from a job that ran and failed. Lead the message with DID NOT RUN.
  const httpStatus = (exec && typeof exec.http === 'number') ? exec.http : 0;
  const execOk = httpStatus >= 200 && httpStatus < 300;
  const outTail = String((exec && exec.stdout) || '').slice(-6000);
  const errTail = String((exec && exec.stderr) || (exec && exec.raw) || '').slice(-6000);
  if (!execOk) {
    const failReason = 'DID NOT RUN: the exec engine returned HTTP ' + String(httpStatus || 'no status') + ' and the command was never executed. This is a transport or authorization failure at gate-exec, not a failure of the command itself. The approval stands; nothing ran.';
    // VERIFY-GREP: GATE-LOG-NOCLOBBER-V1   (second gate -- the race the pre-exec check cannot cover)
    const _lateSnap = await _pcRef.get().catch(() => null);
    const _lateStatus = (_lateSnap && _lateSnap.exists) ? (((_lateSnap.data() || {}).status) || '') : '';
    if (_lateStatus === 'executed') {
      await _pcRef.update({ refire_refused: FieldValue.arrayUnion({ by: email, at: new Date().toISOString(), stage: 'post-exec', http: httpStatus }) }).catch(() => {});
      await db.collection('journal').add({ agent_id: 'human_operator', action: 'godmode_refire_refused', message: 'replay approve refused for job ' + jobId + ': exec engine returned HTTP ' + String(httpStatus || '?') + ' for a job that had ALREADY RUN; record preserved', timestamp: FieldValue.serverTimestamp() });
      res.status(409).json({ ok: false, jobId, action: 'approve', mode: 'godmode', status: 'executed', http_status: httpStatus, exec_http: httpStatus, error: 'this job already ran; its record is preserved and was not overwritten' });
      return;
    }
    await db.collection('pending_confirms').doc(jobId).update({
      status: 'exec_failed', ran_as: email, exit_code: null, http_status: httpStatus, exec_http: httpStatus,
      exec_failed_reason: failReason, stdout_tail: outTail, stderr_tail: errTail,
      confirmed_by: 'godmode:' + email, confirmed_at: FieldValue.serverTimestamp(), exec_failed_at: FieldValue.serverTimestamp(),
    });
    await db.collection('journal').add({ agent_id: 'human_operator', action: 'godmode_exec_failed', message: 'DID NOT RUN: god-mode approval by ' + email + ' for job ' + jobId + ' was accepted but the exec engine returned HTTP ' + String(httpStatus || '?') + '. The command was NOT executed: ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() });
    res.status(502).json({ ok: false, jobId, action: 'approve', mode: 'godmode', ran_as: email, status: 'exec_failed', http_status: httpStatus, error: failReason, stdout: outTail, stderr: errTail });
    return;
  }
  await db.collection('pending_confirms').doc(jobId).update({
    status: 'executed', ran_as: email, exit_code: exit, http_status: httpStatus, exec_http: httpStatus,
    stdout_tail: outTail, stderr_tail: errTail,
    confirmed_by: 'godmode:' + email, confirmed_at: FieldValue.serverTimestamp(), ran_at: FieldValue.serverTimestamp(),
  });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'godmode_executed', message: 'God-mode: ' + email + ' approved+ran job ' + jobId + ' (exit ' + exit + ', http ' + httpStatus + '): ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: exit === 0, jobId, action: 'approve', mode: 'godmode', ran_as: email, exit_code: exit, http_status: httpStatus, stdout: outTail, stderr: errTail });
}
// ---- [SEC-EXEC-NO-DATASTORE-V1] THE APPROVAL TRAVELS IN THE REQUEST, NOT THROUGH THE DATABASE ----
// WHY THIS FUNCTION EXISTS. gate-exec has lost roles/datastore.user -- read AND write on every
// document in every collection, the largest standing grant in the fleet. It therefore cannot
// read pending_confirms/{jobId} any more, and everything it used to read off that document has
// to arrive some other way. This control plane still holds the read, so it does the read and
// forwards the result.
//
// FORWARDING IS SAFE BECAUSE THE SIGNATURE COVERS WHAT MATTERS, NOT BECAUSE THIS CHANNEL IS
// TRUSTED. Of the fields below, arguments and command_type are inside the PC-APPROVAL-CANON-V2
// signed bytes as asha and ctyp, and approval_sig_approver / _key / _iat / _exp are appr, kver,
// iat and exp. Altering any of them between here and the executor does not redirect a job; it
// makes the signature fail to verify and the job is refused. THAT is what made removing the
// grant possible, and it is why this must not be read as "the control plane now asserts the
// approval to the executor" -- it relays a stamp it cannot forge, and the executor rebuilds
// the signed message from the relayed fields and checks it against a PUBLIC key.
//
// EVERY FIELD IS NAMED, AND NOTHING IS SPREAD. `...jx` would forward the whole document,
// including staged_by, the reason chain, stdout_tail from an earlier run and any field a
// future commit adds -- an unbounded body whose contents nobody decided to send. The list is
// explicit so that adding to it is a deliberate act, reviewable as one.
//
// arguments USES === undefined, NOT ||. The signer canonicalises `args === undefined ? null :
// args`, and "null", "{}" and "false" are three different signed messages. Collapsing them
// with || would produce a body that cannot rebuild the signature for any job whose arguments
// are absent, empty or falsy -- a fail-closed break, but a break.
//
// TWO FIELDS ARE DELIBERATELY ABSENT: status and confirmed_at. Neither is in any canon, so
// neither could be trusted here whatever we sent, and sending them would invite the executor
// to check something a caller can freely state about itself. See exec_server.py
// claim_job_for_execution() note 5 for the argument that nothing is lost by that.
async function waApprovalEnvelope(jobId: string): Promise<any> {
  const d = await db.collection('pending_confirms').doc(String(jobId)).get();
  if (!d.exists) return null;
  const jx: any = d.data() || {};
  return {
    command_type: jx.command_type,
    arguments: jx.arguments === undefined ? null : jx.arguments,
    approved_sha256: jx.approved_sha256,
    approval_sig: jx.approval_sig,
    approval_sig_canon: jx.approval_sig_canon,
    approval_sig_alg: jx.approval_sig_alg,
    approval_sig_key: jx.approval_sig_key,
    approval_sig_approver: jx.approval_sig_approver,
    approval_sig_iat: jx.approval_sig_iat,
    approval_sig_exp: jx.approval_sig_exp,
  };
}
// ============ [EXEC-LONGRUN-V1] THE SECOND 300-SECOND CEILING, AND IT IS IN THIS PROCESS ============
// The executor call below was a bare `waFetch(GATE_EXEC_URL + '/run', ...)`, and waFetch is
// `(globalThis as any).fetch` -- one line, at the top of this file, MEASURED by grep: a single
// definition, so every outbound call in this process is undici. undici applies its OWN 300-second
// headersTimeout, and gate-exec sends no response headers until the command it is running has
// finished. So an executor job over about five minutes was killed BY THE CALLER, and the console
// reported "could not reach the executor" -- a message that points at the network, the platform
// and the far end, and is wrong about all three.
//
// WHY RAISING Cloud Run's timeoutSeconds DOES NOT FIX IT: that is a different 300s ceiling, from a
// different vendor, that happens to land on the same number. Lifting the platform one leaves this
// one exactly where it was, which is why the obvious fix looks like it should work and does not.
//
// WHY NOT A GLOBAL DISPATCHER: setting one lifts the ceiling for EVERY outbound call this process
// makes -- token fetches, GCS reads, BigQuery -- which is a far larger blast radius than the
// problem needs, and it removes a bound that is correct nearly everywhere. This is one explicit,
// configurable timeout on the paths that actually need it.
//
// WHY node:https RATHER THAN fetch-with-a-dispatcher: Node does not export undici, so a dispatcher
// means reusing the constructor off globalThis[Symbol.for('undici.globalDispatcher.1')]. That
// works today and is undocumented. This request carries a KMS-signed approval envelope and an
// identity token; it does not get to depend on an internal symbol.
//
// THE DEFAULT IS DELIBERATELY LONGER THAN gate-exec's OWN Cloud Run timeout, so a real refusal or
// error from the executor always wins the race against a guess made from this side. Tunable with
// EXEC_HTTP_TIMEOUT_MS, floored at 60s so a typo cannot produce a timeout shorter than a normal job.
const PC_EXEC_HTTP_TIMEOUT_MS = Math.max(60000, Number(process.env.EXEC_HTTP_TIMEOUT_MS || 1860000));
function waPostLong(urlStr: string, headers: { [k: string]: string }, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('waPostLong: bad url')); return; }
    // Scheme chosen from the URL rather than hardcoded https. gate-exec and every model host are
    // https in production; the http branch exists so this function can be driven against a local
    // server that accepts a connection and never answers, which is the ONLY way to exercise the
    // timeout behaviour this whole block is about.
    const mod: any = u.protocol === 'http:' ? nodeHttp : nodeHttps;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
    }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (c: any) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    // OUR deadline, and it NAMES ITSELF and its env var in the error. The failure this replaces
    // surfaced as a bare 'fetch failed' with no number in it, so nobody reading a dead job could
    // tell which of the two 300s ceilings had fired.
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('waPostLong: no response within ' + timeoutMs + 'ms (EXEC_HTTP_TIMEOUT_MS)')); });
    req.on('error', (e: any) => reject(e));
    req.end(body);
  });
}
// ============ [MODEL-LONGRUN-V1] THE SAME CEILING SITS ON THE MODEL CALLS ============
// waPostLong above was written for the executor, where the ceiling was actively killing jobs. It
// is not special to that path. MEASURED by grep on this file: THREE model POST sites --
// harClaudePost (Anthropic /v1/messages and Vertex :rawPredict), harChatGemini (the toolless
// Gemini path) and harGeminiPost (the tool-capable one) -- and all three were plain waFetch, i.e.
// all three carried undici's 300s headersTimeout. A non-streaming completion sends NO response
// headers until the whole answer has been generated, so the ceiling is real, not theoretical.
//
// THIS ONE IS LATENT RATHER THAN LIVE AND IS STILL WORTH FIXING. Ordinary rounds on this install
// finish in seconds; what a 300s cap costs is the LONGEST, most expensive request of a build --
// a 16-round tool loop against a large context -- and it costs it as a bare `fetch failed` at the
// worst possible moment, with the tokens already paid for.
//
// A SHIM, NOT A REWRITE. All three sites are `const r = await waFetch(url, {...}); await r.json()`,
// so this returns the same four members fetch's Response gives those sites (ok, status, json,
// text). json() THROWS on an unparseable body exactly as fetch's does, which is what the
// parse_error catch at two of the three sites is already written against, so no error handling
// changes. NON-POST FALLS THROUGH to the ordinary global fetch: waPostLong is POST-only by
// construction (it always sets Content-Length and always writes a body) and quietly mishandling a
// GET here would be a worse bug than the one being fixed.
//
// DELIBERATELY NOT DONE: streaming. With SSE the headers arrive immediately and no timeout of this
// shape can ever apply, and the tokens become available to the progress bubble as they are made.
// That is the real fix and a much larger change; it is recorded here as the intended direction
// rather than quietly skipped.
const PC_MODEL_HTTP_TIMEOUT_MS = Math.max(60000, Number(process.env.MODEL_HTTP_TIMEOUT_MS || 1800000));
async function waFetchLong(url: string, init: any): Promise<any> {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'POST') return await waFetch(url, init);
  const r = await waPostLong(String(url), (init && init.headers) || {}, String((init && init.body) || ''), PC_MODEL_HTTP_TIMEOUT_MS);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    async json(): Promise<any> { return JSON.parse(r.text); },
    async text(): Promise<string> { return r.text; },
  };
}
async function waCallExec(scriptB64: string, token: string, jobId: string, assertion: any = null): Promise<any> {
  const idt = await waIdToken(GATE_EXEC_URL);
  // [SEC-EXEC-NO-DATASTORE-V1] A MISSING JOB IS REFUSED HERE, WITHOUT A ROUND TRIP. The
  // executor used to answer 404 for a job id with no document; it cannot know that any more,
  // so the fact is established where the read still lives. Shaped like an executor refusal so
  // every caller's existing error handling reads it unchanged.
  const _appr = await waApprovalEnvelope(jobId);
  if (!_appr) return { http: 404, error: 'refused: job ' + String(jobId) + ' has no approval document to execute' };
  // [EXEC-LONGRUN-V1] waPostLong, not waFetch. Everything about the request is otherwise
  // IDENTICAL -- same URL, same two headers, same body object, same JSON -- so the only thing
  // that changed is which deadline the caller applies to the response.
  // [SEC-ASSERT-FORWARD-V1] gate-exec verifies the operator assertion ITSELF, independently
  // of anything the control plane claims. Forwarding it is what lets PC_REQUIRE_ASSERTION=1.
  const r = await waPostLong(GATE_EXEC_URL + '/run',
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idt },
    JSON.stringify({ script_b64: scriptB64, access_token: token, job_id: jobId, assertion: assertion || undefined, approval: _appr }),
    PC_EXEC_HTTP_TIMEOUT_MS);
  const txt = r.text;
  try { const j = JSON.parse(txt); j.http = r.status; return j; } catch (e) { return { http: r.status, raw: txt }; }
}

// PUBLIC-BY-DESIGN: static HTML shell only, holding no data. Each of its three data calls (/api/dash/summary, /api/dash/usage, /api/dash/gcp) checks waSessionOk and 401s an anonymous caller BEFORE touching Firestore or BigQuery.
app.get('/dash', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;   // [PC-CANONICAL-HOST-V48]
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // VERIFY-GREP: GATE-NOSTORE-V1   (a long-lived tab reused a cached console document and an
  // operator read a job that HAD RUN as refused off it; every fix was undeliverable until this)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(WA_DASH_HTML);
});
// PUBLIC-BY-DESIGN: returns two booleans (registered, setupEnabled) and nothing else. The gate page must read them before a session exists, to choose the setup flow or the unlock flow.
app.get('/api/webauthn/status', waSafe(async (req, res) => {
  const creds = await waGetCreds();
  // [SEC-IAP-GODMODE-V1] third boolean: did THIS request carry a valid IAP identity. Not a
  // secret -- it says nothing the caller does not already know about their own request, and
  // only IAP-admitted callers reach this handler at all. The gate page needs it on reload,
  // when there is a live session and no unlock/verify round trip to learn it from.
  // [SEC-STATUS-SETUPFLAG-V83] setupEnabled is reported ONLY while there is no credential.
  // WHY THIS IS FREE: locked.html reaches its setupEnabled branch only after `else if
  // (st.registered)` has already failed, so the field is READ ONLY WHEN registered is false.
  // Reporting it once a passkey exists therefore has zero effect on the page and is pure
  // disclosure -- it is a standing answer to "is the first-registration window open" for the
  // entire life of the install, which is exactly the steady state where it can never be acted
  // on legitimately.
  // WHAT THIS IS AND IS NOT. It is NOT the escalation it reads like: this route is mapped
  // 'console', so IAP has already admitted the caller against an in-domain Google account,
  // and BOTH setup endpoints refuse without a constant-time waEq() match on
  // WA_BOOTSTRAP_SECRET -- knowing the window is open buys nothing without the secret. So
  // this is a small information disclosure to an already-authenticated caller, narrowed here
  // because narrowing costs nothing, NOT a hole being closed. The honest description is now
  // in the header comment of locked.html and in SECURITY.md; it previously said "anonymous",
  // which overstated it in the direction that frightens a reader.
  res.json({ registered: creds.length > 0, setupEnabled: creds.length === 0 && !!WA_BOOTSTRAP_SECRET, sessionMin: WA_SESSION_MIN, iap: (!!PC_IAP_AUD && !!pcIapEmail(req)) });
}));
app.get('/api/dash/summary', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const now = Date.now();
  const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { agent: a, last_ts: 0, last_action: '', tail: [], backlog: 0, open_msgs: 0 }; return agents[a]; };
  const jsnap = await db.collection('journal').orderBy('timestamp', 'desc').limit(300).get();
  jsnap.docs.forEach((d: any) => {
    const e = d.data(); const a = ensure(e.agent_id); if (!a) return;
    const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds * 1000 : (e.timestamp && e.timestamp.toMillis ? e.timestamp.toMillis() : 0);
    if (ts > a.last_ts) { a.last_ts = ts; a.last_action = e.action || ''; }
    if (a.tail.length < 6) a.tail.push({ ts, action: e.action || '', msg: String(e.message || '').slice(0, 160) });
  });
  try { const w = await db.collection('work_items').where('status', '==', 'pending').limit(300).get(); w.docs.forEach((d: any) => { const x = d.data(); const a = ensure(x.assigned_role); if (a) a.backlog++; }); } catch (e) {}
  try { const m = await db.collection('agent_messages').where('status', '==', 'open').limit(300).get(); m.docs.forEach((d: any) => { const x = d.data(); const a = ensure(x.to); if (a) a.open_msgs++; }); } catch (e) {}
  let pending = 0; try { const p = await db.collection('pending_confirms').where('status', '==', 'pending').limit(100).get(); pending = p.size; } catch (e) {}
  const list = Object.keys(agents).map((k) => {
    const a = agents[k]; const ageMin = a.last_ts ? (now - a.last_ts) / 60000 : 999999;
    a.status = ageMin < 5 ? 'working' : ((a.open_msgs > 0 || a.backlog > 0) ? 'waiting' : 'idle');
    a.age_min = Math.round(ageMin); return a;
  }).sort((x: any, y: any) => y.last_ts - x.last_ts);
  res.json({ generated: now, agents: list, pending_confirm: pending });
}));
// Self-tracked Anthropic token usage (last 7d) from token_usage docs.
app.get('/api/dash/usage', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  let snap: any;
  try { snap = await db.collection('token_usage').orderBy('ts', 'desc').limit(3000).get(); } catch (e) { res.json({ enabled: false, note: 'no token_usage yet' }); return; }
  const cutoff = Date.now() - 7 * 86400000;
  const days: any = {}; const models: any = {}; let ti = 0, to = 0;
  snap.docs.forEach((d: any) => {
    const x = d.data(); const ts = (x.ts && x.ts._seconds) ? x.ts._seconds * 1000 : (x.ts && x.ts.toMillis ? x.ts.toMillis() : 0);
    if (ts && ts < cutoff) return;
    const day = ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown';
    const inp = (x.input_tokens || 0) + (x.cache_creation_input_tokens || 0) + (x.cache_read_input_tokens || 0);
    const outp = x.output_tokens || 0;
    const dd = days[day] || (days[day] = { date: day, input: 0, output: 0 }); dd.input += inp; dd.output += outp;
    const mk = x.model || '?'; const mm = models[mk] || (models[mk] = { model: mk, input: 0, output: 0 }); mm.input += inp; mm.output += outp;
    ti += inp; to += outp;
  });
  res.json({ enabled: snap.size > 0, days: Object.keys(days).sort().map((k) => days[k]), models: Object.keys(models).map((k) => models[k]).sort((a: any, b: any) => (b.input + b.output) - (a.input + a.output)), totals: { input: ti, output: to } });
}));
// Real GCP spend (last 7d by service) from the BigQuery billing export; auto-discovers the table.
//
// [DASH-GCP-CACHE-V1] THIS QUERY WAS ON A 20-SECOND POLLING PATH AND IT COST REAL MONEY.
//
// dash.html calls refresh() from setInterval(refresh, 20000), refresh() calls loadGCP(), and
// loadGCP() hit this route, which ran a REAL BigQuery jobs.query with NO cache. BigQuery bills
// a MINIMUM OF 10 MB per query and per table referenced, however few bytes the query actually
// touches, and this one references one table.
//
// THE ARITHMETIC BEFORE, for ONE open tab: 3 queries/min * 60 * 24 = 4,320 queries/day.
// 4,320 * 10 MB = 43.2 GB/day = ~1,296 GB/month = ~1.27 TiB against a 1 TiB/month free tier.
// ONE TAB EXCEEDS THE ENTIRE FREE ALLOWANCE BY ~27%. Two tabs is ~2.53 TiB, so ~1.53 TiB is
// billable at $6.25/TiB = ~$9.56/month. This is a personal-budget install.
//
// AND IT BOUGHT NOTHING. The billing export lands roughly DAILY, so 4,320 queries a day were
// re-reading a number that changes once a day. The refresh was not measuring anything the
// previous refresh had not already measured; it was paying to re-read the same row.
//
// THE ARITHMETIC AFTER: the TTL below is SIX HOURS, so a measured result costs at most
// 4 upstream queries/day for the WHOLE SERVICE -- not per tab, not per poll. 4 * 10 MB =
// 40 MB/day = ~1.2 GB/month = ~0.12% of the 1 TiB free tier, and $0 billable. A hundred tabs
// polling every second would not raise that number, because the ceiling is the TTL and not
// the caller.
//
// THE TTL AND THE POLLING INTERVAL ARE INDEPENDENT ON PURPOSE and dash.html still polls every
// 20 seconds. A UI that refreshes often is fine as long as it refreshes FROM CACHE; coupling
// the two would mean slowing the whole dashboard down to make one card cheap.
//
// THE AGE IS SERVED WITH THE VALUE (`cached`, `age_ms`, `fetched_at`, `ttl_ms`) so a reader
// can tell stale from fresh instead of assuming live. A cached number presented as if it were
// live is a different defect from an expensive one, and shipping the first to fix the second
// would not be a trade worth making. dash.html renders that age.
//
// A FAILED OR NOT-YET-AVAILABLE READ GETS A SHORT RETRY FLOOR, NOT THE SIX-HOUR TTL. A query
// that errors is still billed the 10 MB minimum, so an export that is broken must not be
// retried every 20 seconds; but a fresh install whose export table appears an hour from now
// must not wait six hours to notice. DASH_GCP_RETRY_MS bounds the bad case at 6 attempts/hour
// = 144/day = ~1.44 GB/day worst case, still inside the free tier, and the good case converges
// within ten minutes of the export appearing.
//
// THE CACHE IS PER INSTANCE, which is the honest description of a module-scope object on Cloud
// Run: N serving instances cost at most N * 4 queries/day. This service scales to zero and
// carries one instance at this traffic level, so the ceiling above is the real one, but it is
// a ceiling per instance and is recorded as such rather than overstated.
const DASH_GCP_TTL_MS = 6 * 3600 * 1000;
const DASH_GCP_RETRY_MS = 10 * 60 * 1000;
const dashGcpCache: { at: number; v: any } = { at: 0, v: null };
// The upstream read, lifted out of the handler unchanged so the handler decides only whether to
// CALL it. Returns the payload it used to res.json() directly; it never touches res, so there is
// exactly one place that writes the response and exactly one place that spends money.
async function dashGcpMeasure(): Promise<any> {
  let table = '';
  try { table = await waBqBillingTable(); }
  catch (e: any) { return { enabled: true, pending: true, note: 'cannot list billing dataset — check control-plane-sa BigQuery IAM' }; }
  if (!table) { return { enabled: true, pending: true, note: 'billing export table not created yet (first data within ~a day)' }; }
  const sql = 'SELECT service.description AS svc, ROUND(SUM(cost),2) AS cost FROM `' + GCP_PROJECT + '.' + GCP_BILLING_DATASET + '.' + table + '` WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) GROUP BY svc ORDER BY cost DESC LIMIT 25';
  let q: any;
  try { q = await waBqQuery(sql); } catch (e: any) { return { enabled: true, pending: true, note: 'query error' }; }
  if (q.error || (q.errors && q.errors.length)) { console.error('[gate] BigQuery error withheld from client:', q.error || q.errors); return { enabled: true, pending: true, note: 'billing query failed' }; }
  const rows = (q.rows || []).map((r: any) => ({ svc: (r.f[0] && r.f[0].v) || '?', cost: parseFloat((r.f[1] && r.f[1].v) || '0') || 0 }));
  const total = rows.reduce((a: number, x: any) => a + x.cost, 0);
  return { enabled: true, pending: false, table, total: Math.round(total * 100) / 100, services: rows };
}
const dashGcpTtlFor = (v: any): number => (v && v.pending === false) ? DASH_GCP_TTL_MS : DASH_GCP_RETRY_MS;
app.get('/api/dash/gcp', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const now = Date.now();
  if (dashGcpCache.v && (now - dashGcpCache.at) < dashGcpTtlFor(dashGcpCache.v)) {
    res.json(Object.assign({}, dashGcpCache.v, { cached: true, age_ms: now - dashGcpCache.at, fetched_at: dashGcpCache.at, ttl_ms: dashGcpTtlFor(dashGcpCache.v) }));
    return;
  }
  const v = await dashGcpMeasure();
  dashGcpCache.at = Date.now(); dashGcpCache.v = v;
  res.json(Object.assign({}, v, { cached: false, age_ms: 0, fetched_at: dashGcpCache.at, ttl_ms: dashGcpTtlFor(v) }));
}));
// AUTH-NON-SESSION: authenticated by constant-time waEq() against WA_BOOTSTRAP_SECRET, not by the gate cookie -- first-credential enrolment necessarily precedes any session. Refuses outright (403) once a credential exists.
app.post('/api/webauthn/register/options', waSafe(async (req, res) => {
  if ((await waGetCreds()).length) { res.status(403).json({ error: 'already set up — add new devices from an existing unlocked device' }); return; }
  if (!WA_BOOTSTRAP_SECRET || !waEq(String((req.body && req.body.bootstrapSecret) || ''), WA_BOOTSTRAP_SECRET)) { res.status(403).json({ error: 'setup password required/incorrect' }); return; }
  await waRegOptions(res);
}));
// AUTH-NON-SESSION: authenticated by constant-time waEq() against WA_BOOTSTRAP_SECRET, not by the gate cookie -- first-credential enrolment necessarily precedes any session. Refuses outright (403) once a credential exists.
app.post('/api/webauthn/register/verify', waSafe(async (req, res) => {
  if ((await waGetCreds()).length) { res.status(403).json({ error: 'already set up' }); return; }
  if (!WA_BOOTSTRAP_SECRET || !waEq(String((req.body && req.body.bootstrapSecret) || ''), WA_BOOTSTRAP_SECRET)) { res.status(403).json({ error: 'setup password required/incorrect' }); return; }
  const expectedChallenge = waCookie(req, 'wa_reg');
  if (!expectedChallenge) { res.status(400).json({ error: 'no challenge cookie' }); return; }
  let v: any;
  try { v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge, expectedOrigin: WA_RP_ORIGIN, expectedRPID: WA_RP_ID, requireUserVerification: true }); }
  catch (e: any) { console.error('[gate] verifyRegistrationResponse threw:', e); res.status(400).json({ error: 'registration could not be verified' }); return; }
  res.clearCookie('wa_reg', { path: '/' });
  if (!v.verified || !v.registrationInfo) { res.status(400).json({ error: 'not verified' }); return; }
  await waStoreCredential(v, req);
  res.json({ ok: true });
}));
async function waEnrollTokenOk(req: express.Request): Promise<boolean> {
  const tok = String((req.body && req.body.enrollToken) || '');
  if (!tok) return false;
  const d = await db.collection('enroll_tokens').doc(tok).get();
  if (!d.exists) return false;
  const x: any = d.data();
  if (x.used) return false;
  return typeof x.exp === 'number' && x.exp > Date.now();
}
async function waEnrollTokenConsume(tok: string): Promise<void> {
  try { await db.collection('enroll_tokens').doc(tok).update({ used: true, used_at: FieldValue.serverTimestamp() }); } catch (e) {}
}
app.post('/api/webauthn/enroll/link', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first to create a pairing link' }); return; }
  const tok = crypto.randomBytes(24).toString('base64url');
  const ttlMin = 5;
  await db.collection('enroll_tokens').doc(tok).set({ user: WA_USER, exp: Date.now() + ttlMin * 60 * 1000, used: false, created_at: FieldValue.serverTimestamp() });
  res.json({ token: tok, url: (WA_RP_ORIGINS[0] || WA_RP_ORIGIN_RAW) + '/harness?enroll=' + tok, ttl_min: ttlMin });
}));
app.post('/api/webauthn/enroll/options', waSafe(async (req, res) => {
  if (!(waSessionOk(req) || await waEnrollTokenOk(req))) { res.status(401).json({ error: 'unlock, or open a valid pairing link, first' }); return; }
  await waRegOptions(res);
}));
app.post('/api/webauthn/enroll/verify', waSafe(async (req, res) => {
  if (!(waSessionOk(req) || await waEnrollTokenOk(req))) { res.status(401).json({ error: 'unlock, or open a valid pairing link, first' }); return; }
  const expectedChallenge = waCookie(req, 'wa_reg');
  if (!expectedChallenge) { res.status(400).json({ error: 'no challenge cookie' }); return; }
  let v: any;
  try { v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge, expectedOrigin: WA_RP_ORIGIN, expectedRPID: WA_RP_ID, requireUserVerification: true }); }
  catch (e: any) { console.error('[gate] verifyRegistrationResponse threw:', e); res.status(400).json({ error: 'registration could not be verified' }); return; }
  res.clearCookie('wa_reg', { path: '/' });
  if (!v.verified || !v.registrationInfo) { res.status(400).json({ error: 'not verified' }); return; }
  const id = await waStoreCredential(v, req);
  { const _t = String((req.body && req.body.enrollToken) || ''); if (_t) await waEnrollTokenConsume(_t); }
  res.json({ ok: true, credentialID: id });
}));
// PUBLIC-BY-DESIGN: this IS the login handshake and is pre-session by necessity. It returns a WebAuthn challenge only, and 400s when no passkey is registered.
app.post('/api/webauthn/unlock/options', waSafe(async (req, res) => {
  const creds = await waGetCreds();
  if (!creds.length) { res.status(400).json({ error: 'no registered passkey yet' }); return; }
  const options = await generateAuthenticationOptions({ rpID: WA_RP_ID, userVerification: 'required', allowCredentials: creds.map((c: any) => ({ id: c.credentialID, transports: c.transports || undefined })) });
  waSetChal(res, 'wa_unlock', options.challenge);
  res.json(options);
}));
// PUBLIC-BY-DESIGN: this IS the login handshake and is pre-session by necessity. It mints a gate session ONLY after verifyAuthenticationResponse succeeds against a registered credential.
app.post('/api/webauthn/unlock/verify', waSafe(async (req, res) => {
  const expectedChallenge = waCookie(req, 'wa_unlock');
  if (!expectedChallenge) { res.status(400).json({ error: 'no challenge' }); return; }
  const ok = await waVerifyAssertion(req.body.response, expectedChallenge);
  res.clearCookie('wa_unlock', { path: '/' });
  if (!ok) { res.status(400).json({ error: 'not verified' }); return; }
  res.cookie('gate_session', waMakeSession(), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: WA_SESSION_MIN * 60 * 1000, path: '/' });
  // [SEC-IAP-GODMODE-V1] the banner must not lie: IAP identity is a real god-mode path,
  // so report it. Without PC_IAP_AUD there is no audience binding and this stays false.
  const pcIapStatusOk = !!PC_IAP_AUD && !!pcIapEmail(req);
  res.json({ ok: true, godmode: !!(GATE_EXEC_URL && (WA_GOOGLE_CLIENT_ID || pcIapStatusOk)), passkeyRequired: PC_REQUIRE_PASSKEY, iap: pcIapStatusOk });
}));
app.post('/api/webauthn/elevate/options', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const creds = await waGetCreds();
  if (!creds.length) { res.status(400).json({ error: 'no registered passkey' }); return; }
  // [F6] OPTIONAL per-job binding. The approvals UI sends jobId (+action) and gets back an
  // elevation usable ONLY for that job while its command still hashes the same. A caller that
  // sends no jobId (the harness Face ID for /api/strain/*) gets the old generic elevation, which
  // waElevatedForJob refuses for approvals.
  const jobId = String((req.body && req.body.jobId) || '');
  const action = String((req.body && req.body.action) || 'approve');
  let challenge: any = undefined;
  if (jobId) {
    if (action !== 'approve' && action !== 'deny') { res.status(400).json({ error: 'bad action' }); return; }
    const jc = await waJobCommand(jobId);
    if (!jc.ok) { res.status(jc.err === 'job not found' ? 404 : 400).json({ error: jc.err }); return; }
    challenge = Buffer.concat([crypto.randomBytes(24), waSha(jobId + '|' + action)]);
  }
  const options = await generateAuthenticationOptions({ rpID: WA_RP_ID, userVerification: 'required', challenge, allowCredentials: creds.map((c: any) => ({ id: c.credentialID, transports: c.transports || undefined })) });
  waSetChal(res, 'wa_elev', options.challenge);
  res.json(options);
}));
app.post('/api/webauthn/elevate/verify', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const expectedChallenge = waCookie(req, 'wa_elev');
  if (!expectedChallenge) { res.status(400).json({ error: 'no challenge' }); return; }
  // [F6] Re-derive the job binding and compare it timing-safe, exactly as confirm/verify does, so
  // a challenge minted for one job cannot be spent on another. No jobId => generic elevation.
  const vJobId = String((req.body && req.body.jobId) || '');
  const vAction = String((req.body && req.body.action) || 'approve');
  let vCmdSha = '';
  if (vJobId) {
    if (vAction !== 'approve' && vAction !== 'deny') { res.status(400).json({ error: 'bad action' }); return; }
    const jc = await waJobCommand(vJobId);
    if (!jc.ok) { res.status(jc.err === 'job not found' ? 404 : 400).json({ error: jc.err }); return; }
    const raw = Buffer.from(expectedChallenge, 'base64url');
    if (raw.length < 32 || !waEq(raw.subarray(raw.length - 32), waSha(vJobId + '|' + vAction))) { res.clearCookie('wa_elev', { path: '/' }); res.status(400).json({ error: 'binding mismatch' }); return; }
    vCmdSha = crypto.createHash('sha256').update(String(jc.command || '')).digest('hex');
  }
  const ok = await waVerifyAssertion(req.body.response, expectedChallenge);
  res.clearCookie('wa_elev', { path: '/' });
  if (!ok) { res.status(400).json({ error: 'not verified' }); return; }
  res.cookie('gate_elevated', waMakeElevated(vJobId, vCmdSha), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: WA_ELEVATE_MIN * 60 * 1000, path: '/' });
  res.json({ ok: true, elevated_min: WA_ELEVATE_MIN, jobId: vJobId });
}));
// ---- [EXEC-BUCKET-INGEST-V1] THE EXECUTOR RECORDS ARRIVE AS OBJECTS, NOT AS WRITES ----
// WHAT MOVED AND WHY. gate-exec held project-wide roles/datastore.user -- read and write on
// every document in every collection -- for exactly three things: the single-use claim, the
// result of a run, and its own journal entries. All three are now objects in one bucket on
// which the executor holds roles/storage.objectCreator and nothing else: create, no read, no
// overwrite, no delete. It can append an audit record and can never edit the record
// afterwards, which is strictly stronger than the grant it is losing.
//
// WHAT THIS CODE IS. The other end: the control plane can read that bucket, so it copies the
// rows back into the collections the console already reads. It is a CONVENIENCE, not custody.
//
// IF THIS NEVER RUNS, NOTHING IS LOST. The result of every job is an object named
// deterministically from the job id, and it is recoverable in one command by anyone who can
// read the bucket:
//     gcloud storage cat gs://$PC_EXEC_BUCKET/results/<job-id>-<digest>.json
// The journal entries are likewise objects under journal/<job-id>/. An ingest that is off,
// broken, rate-limited or simply never triggered costs a stale console view and nothing else.
// That is the whole reason the executor writes the object BEFORE it returns rather than
// handing the result to a caller that may already be gone.
//
// NO SCHEDULER, AND THAT IS DELIBERATE. Cloud Scheduler would be a new resource, a new
// service account, a new IAM binding and a new thing to uninstall, to move rows between two
// stores this service already talks to. Instead the sweep rides GET /api/webauthn/pending --
// a path an open gate page already polls -- at most once every PC_EXEC_INGEST_MIN_MS, and
// never twice at once. No poll waits on it: it is fired and not awaited, so a slow or failing
// bucket cannot delay or break the queue the operator is looking at.
//
// IDEMPOTENT BY CONSTRUCTION, NOT BY BOOKKEEPING. Every row is written to a document id
// derived from the OBJECT NAME, and every field comes from the immutable object -- including
// the timestamp, which is read out of the record instead of stamped at ingest. Running the
// sweep twice over the same objects therefore rewrites identical documents in place: same
// ids, same values, no duplicate rows, no second journal line for one refusal. That also
// means no delete is ever needed, so this service is granted READ on the bucket and not
// more: neither end of this pipe can destroy the audit trail.
const PC_EXEC_BUCKET = process.env.PC_EXEC_BUCKET || '';
const PC_EXEC_INGEST_MIN_MS = parseInt(process.env.PC_EXEC_INGEST_MIN_MS || '30000', 10);
const PC_EXEC_INGEST_PAGE = parseInt(process.env.PC_EXEC_INGEST_PAGE || '100', 10);
let PC_EXEC_INGEST_AT = 0;
let PC_EXEC_INGEST_RUNNING = false;
const PC_EXEC_GCS = process.env.PC_GCS_HOST || 'https://storage.googleapis.com';
async function pcExecBucketList(prefix: string, pageToken: string): Promise<any> {
  const tok = await waAccessToken();
  if (!tok) return null;
  const u = PC_EXEC_GCS + '/storage/v1/b/' + encodeURIComponent(PC_EXEC_BUCKET) + '/o?prefix=' +
    encodeURIComponent(prefix) + '&maxResults=' + String(PC_EXEC_INGEST_PAGE) +
    (pageToken ? ('&pageToken=' + encodeURIComponent(pageToken)) : '');
  const r: any = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r || !r.ok) return null;
  return await r.json();
}
async function pcExecBucketGet(name: string): Promise<any> {
  const tok = await waAccessToken();
  if (!tok) return null;
  const u = PC_EXEC_GCS + '/storage/v1/b/' + encodeURIComponent(PC_EXEC_BUCKET) + '/o/' +
    encodeURIComponent(name) + '?alt=media';
  const r: any = await waFetch(u, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r || !r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
// The document id of an ingested row is a function of the OBJECT NAME and of nothing else.
// That is what makes a second sweep a no-op instead of a second row.
function pcExecIngestId(name: string): string {
  return 'gcs-' + crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 32);
}
// The executor stamps its own times as RFC3339 strings. They are read back here rather than
// re-stamped, so an ingested row is IDENTICAL on every sweep -- a serverTimestamp would make
// each pass rewrite the row with a new value and reorder the journal under the operator.
function pcExecIngestWhen(v: any): any {
  const t = Date.parse(String(v || ''));
  return isNaN(t) ? FieldValue.serverTimestamp() : new Date(t);
}
async function pcExecIngestSweep(): Promise<any> {
  const out: any = { journal: 0, results: 0, listed: 0 };
  if (!PC_EXEC_BUCKET) return out;
  const stateRef = db.collection('pc_exec_ingest').doc('state');
  const snap: any = await stateRef.get().catch(() => null);
  const cur: any = (snap && snap.exists) ? (snap.data() || {}) : {};
  for (const kind of ['journal', 'results']) {
    // ONE PAGE PER SWEEP, with the page token carried in Firestore. A sweep does bounded
    // work no matter how many objects exist, and the token resuming where the last one
    // stopped is an optimisation only: when the listing runs out the token is cleared and
    // the next sweep starts again from the top, which is free precisely because ingest is
    // idempotent. No object can be skipped for good by a cursor that got ahead of itself.
    const listing: any = await pcExecBucketList(kind + '/', String(cur[kind + '_token'] || ''));
    if (!listing) continue;
    for (const it of (listing.items || [])) {
      const name = String((it && it.name) || '');
      if (!name) continue;
      out.listed++;
      const doc: any = await pcExecBucketGet(name);
      if (!doc) continue;
      if (kind === 'journal') {
        await db.collection('journal').doc(pcExecIngestId(name)).set({
          agent_id: String(doc.agent_id || 'fleet-gate-exec'),
          action: String(doc.action || ''),
          message: String(doc.message || ''),
          job_id: String(doc.job_id || ''),
          timestamp: pcExecIngestWhen(doc.written_at),
          ingested_from: name,
        });
        out.journal++;
      } else {
        const jid = String(doc.job_id || '');
        if (!jid) continue;
        // merge:true, and only the fields the console projects. The job document carries the
        // approval, the staging identity and the reason chain; an ingest that replaced it
        // would destroy the record it exists to complete.
        await db.collection('pending_confirms').doc(jid).set({
          status: 'executed',
          exit_code: (typeof doc.exit_code === 'number') ? doc.exit_code : -1,
          stdout_tail: String(doc.stdout || '').slice(-6000),
          stderr_tail: String(doc.stderr || '').slice(-6000),
          executed_at: pcExecIngestWhen(doc.executed_at),
          exec_result_object: name,
        }, { merge: true });
        out.results++;
      }
    }
    const patch: any = {};
    patch[kind + '_token'] = String(listing.nextPageToken || '');
    await stateRef.set(patch, { merge: true }).catch(() => {});
  }
  return out;
}
// FIRED, NEVER AWAITED. The caller is a page poll; it gets its answer whatever this does.
function pcExecIngestNudge(): void {
  if (!PC_EXEC_BUCKET) return;
  const now = Date.now();
  if (PC_EXEC_INGEST_RUNNING) return;
  if (now - PC_EXEC_INGEST_AT < PC_EXEC_INGEST_MIN_MS) return;
  PC_EXEC_INGEST_AT = now;
  PC_EXEC_INGEST_RUNNING = true;
  pcExecIngestSweep()
    .then((n: any) => { if (n && (n.journal || n.results)) { try { console.error('[gate] EXEC-BUCKET-INGEST-V1: ingested ' + String(n.journal) + ' journal object(s) and ' + String(n.results) + ' result(s) from the executor bucket.'); } catch (e) {} } })
    .catch((e: any) => { try { console.error('[gate] EXEC-BUCKET-INGEST-V1: the sweep failed. NOTHING IS LOST -- the executor records are objects in the bucket and are recoverable with gcloud storage cat. Reason:', (e && e.message) || e); } catch (e2) {} })
    .finally(() => { PC_EXEC_INGEST_RUNNING = false; });
}
app.get('/api/webauthn/pending', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  // [EXEC-BUCKET-INGEST-V1] The piggyback. Rate-limited, non-blocking, and it runs only for
  // a caller that already holds an unlocked session -- the gate page polling its own queue.
  pcExecIngestNudge();
  // [GATE-QUEUE-COEXIST-V1] THE CAP IS NOW BIGGER THAN THE QUEUE CAN GET, AND IT SAYS SO
  // WHEN IT IS HIT. The old limit(100) silently truncated: past 100 pending documents the
  // gate rendered a subset and nothing anywhere said which jobs were missing. With the
  // automatic supersede gone the queue is allowed to be long, so the read is widened and a
  // truncation is reported to the log. It is console.error and NOT a journal write on
  // purpose: this runs on every poll of an open gate page, and [F22] is the record of what
  // a per-poll journal write does to the fleet's signal.
  const snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(PC_PENDING_LIST_MAX + 1).get();
  if (snap.size > PC_PENDING_LIST_MAX) { try { console.error('[gate] GATE-QUEUE-COEXIST-V1: more than PC_PENDING_LIST_MAX (' + String(PC_PENDING_LIST_MAX) + ') pending jobs exist; the gate page is showing a SUBSET. Raise PC_PENDING_LIST_MAX or work the queue down.'); } catch (e) {} }
  const nowMs = Date.now(); const ttlMs = WA_JOB_TTL_MIN * 60000; const cand: any[] = [];
  for (const d of snap.docs) { const x: any = d.data();
    const ts = (x.created_at && x.created_at._seconds) ? x.created_at._seconds * 1000 : (x.created_at && x.created_at.toMillis ? x.created_at.toMillis() : 0);
    // [GATE-QUEUE-COEXIST-V1] EXPIRY NOW WRITES ITS REASON, AND A FAILED EXPIRY DOES NOT
    // HIDE THE JOB. expired_reason had no writer anywhere in this file while three readers
    // projected it, so an expired job came back from read_job_log with reason null -- the
    // exact refusal-indistinguishable-from-malfunction shape [F4c] exists to kill. And the
    // `continue` used to sit OUTSIDE the try, so a job whose expiry write FAILED was still
    // dropped from this response: it stayed 'pending' in Firestore and became invisible to
    // the only page that can approve it, with no record of either fact. It is now skipped
    // only when the write is known to have landed; otherwise it is listed and logged.
    if (ts && (nowMs - ts) > ttlMs) { const _xr = 'EXPIRED AND NEVER RAN: this job sat staged for longer than WA_JOB_TTL_MIN (' + String(WA_JOB_TTL_MIN) + ' minutes) without anyone approving or denying it, so the gate retired it on this load. Nothing ran. Re-stage it if the work is still wanted.'; let _xok = false;
      try { await d.ref.update({ status: 'expired', expired_at: FieldValue.serverTimestamp(), expired_reason: _xr }); _xok = true; try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'job_expired', message: 'EXPIRED AND NEVER RAN: job ' + String(x.job_id || '') + ' [' + String(x.command_type || '') + '] staged by ' + String(x.staged_by || '') + ', past its time-to-live. ' + _xr, timestamp: FieldValue.serverTimestamp() }); } catch (e2) {} }
      catch (e) { try { console.error('[gate] GATE-QUEUE-COEXIST-V1: the expiry write for job ' + String(x.job_id || '') + ' FAILED; it is still pending and is being LISTED rather than hidden.'); } catch (e3) {} }
      if (_xok) continue; }
    cand.push({ ref: d.ref, job_id: x.job_id, command_type: x.command_type, staged_by: x.staged_by, arguments: x.arguments, workstream: x.workstream || '', ts: ts, age_min: ts ? Math.round((nowMs - ts) / 60000) : null });
  }
  // [GATE-QUEUE-COEXIST-V1] THE AUTOMATIC SUPERSEDE IS DELETED. It stood here and, on every
  // load of this list, wrote status 'superseded' onto every pending job that was not the
  // newest of its staged_by|command_type key -- and wrote no note, no superseding job id and
  // no role with it, so the job it destroyed reported reason null forever after. Two chats of
  // one role sharing one command_type therefore erased each other's staged work at the moment
  // the operator opened the page to read it. Nothing in this repository ever stated a purpose
  // for it; the concerns it could have served -- a double submit, a runaway stager -- are
  // answered at STAGE time now, by pcAdmitStage, on the exact command bytes and with a loud
  // refusal that destroys nothing. LISTING A JOB IS NOT APPROVING IT: every job below still
  // needs its own passkey assertion bound to its own id and command sha, its own displayed-job
  // compare-and-swap, and its own provisioned-identity check. More cards on the page do not
  // make any one of them cheaper to approve.
  const outJobs: any[] = [];
  for (const j of cand) { outJobs.push({ job_id: j.job_id, status: 'pending', command_type: j.command_type, staged_by: j.staged_by, arguments: j.arguments, age_min: j.age_min, workstream: waWorkstreamOf(j) }); }
  const _provSnap: any = await db.collection('strains').where('status', '==', 'active').get().catch(() => null);
  const _prov: any = {}; if (_provSnap && _provSnap.docs) _provSnap.docs.forEach((d: any) => { _prov[d.id] = true; });
  if (!_provSnap || !_provSnap.docs || Object.keys(_prov).length === 0) { try { console.error('[gate] SECURITY S24: strains registry read empty or failed - identity filter SKIPPED this request. Nothing quarantined. The approve path refuses a non-provisioned identity independently.'); } catch (e) {} res.json(outJobs); return; }
  const _banned3: any = { 'fleet-drafter': 1, 'fleet-courier': 1 };
  const _shown: any[] = [];
  for (const _j of outJobs) {
    const _sb = String(_j.staged_by || '');
    if (_sb && !_banned3[_sb] && _prov[_sb]) { _shown.push(_j); continue; }
    // [F22] Quarantine ONCE. The old code hid the job but never resolved it, and
    // journalled on EVERY poll of an open gate page -- an unbounded write loop that
    // buried real fleet signal. The transaction makes the journal write fire exactly
    // on the pending -> quarantined transition and never again.
    try {
      const _ref = db.collection('pending_confirms').doc(String(_j.job_id));
      const _did = await db.runTransaction(async (_tx: any) => {
        const _snap = await _tx.get(_ref);
        if (!_snap.exists) return false;
        if (String((_snap.data() as any).status || '') !== 'pending') return false;
        _tx.update(_ref, { status: 'quarantined', quarantined_at: FieldValue.serverTimestamp(), quarantine_reason: 'staged_by not an active provisioned strain: ' + _sb });
        return true;
      });
      if (_did) { try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'security_quarantine', message: 'Quarantined job ' + _j.job_id + ' - non-provisioned identity "' + _sb + '". It can no longer be approved.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
    } catch (e) { try { console.error('[gate] GATE-QUEUE-COEXIST-V1: the quarantine write for job ' + String(_j.job_id || '') + ' (staged_by ' + _sb + ') FAILED. It is being withheld from the gate because its identity is not provisioned -- the approve path refuses it independently -- but it is still pending in Firestore and carries no quarantine_reason. This line is the only record of that.'); } catch (e4) {} }
  }
  res.json(_shown);
}));
app.get('/api/webauthn/job/:id', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const d = await db.collection('pending_confirms').doc(String(req.params.id)).get();
  if (!d.exists) { res.status(404).json({ error: 'not found' }); return; }
  const x: any = d.data() || {};
  // [F4c] project the REASON fields. quarantine_reason / fire_refused_reason / supersede_note /
  // expired_reason are all written to Firestore and were all dropped here, so a job that was
  // security-refused, superseded or expired returned the same empty stdout+stderr and undefined
  // exit_code as a job whose binary was simply missing. A refusal indistinguishable from a
  // malfunction is the most expensive defect in this project. Strictly additive: no field removed.
  const _reason = x.quarantine_reason || x.fire_refused_reason || x.supersede_note || x.expired_reason || x.exec_failed_reason || '';
  res.json({ job_id: x.job_id, status: x.status, command_type: x.command_type, staged_by: x.staged_by, arguments: x.arguments, exit_code: x.exit_code, stdout_tail: x.stdout_tail, stderr_tail: x.stderr_tail, ran_as: x.ran_as, reason: _reason, quarantine_reason: x.quarantine_reason || null, fire_refused_reason: x.fire_refused_reason || null, supersede_note: x.supersede_note || null, superseded_by_job: x.superseded_by_job || null, superseded_by_role: x.superseded_by_role || null, expired_reason: x.expired_reason || null, exec_failed_reason: x.exec_failed_reason || null, http_status: (typeof x.http_status === 'number') ? x.http_status : null });
}));
// [SEC-APPROVE-BIND-V1] AN APPROVAL APPLIES TO THE JOB THE HUMAN WAS SHOWN, OR IT IS REFUSED.
// WHAT THIS PROTECTS, stated here because a bare rule with no stated purpose gets applied to
// things it was never meant to touch: the gate renders the queue at time T and the human taps at
// T+n. In that window the server's own GET /api/webauthn/pending has already rewritten state --
// its supersede loop flips every non-newest job of a staged_by|command_type key to 'superseded'
// on EVERY load of the list -- and any strain may stage, re-stage or supersede besides. Before
// this, confirm/verify took a jobId and applied the human's decision to WHATEVER that document
// held at the instant the request ran. The tap therefore authorised the CURRENT CONTENTS OF A JOB
// ID, not the job the human read. The fleet's whole safety property is that a human with a
// passkey authorises privileged execution; that property does not survive the approved job
// differing from the displayed one.
// This is a COMPARE-AND-SWAP, not a signature. The client sends back the fields it DISPLAYED and
// the server refuses -- 409, nothing written, nothing stamped, nothing executed -- when its own
// copy differs. It is not an anti-forgery control and must not be described as one: the browser
// is the operator's own and anything that can forge this already holds his session. It detects
// DRIFT between what was shown and what would run.
// NOT a duplicate of approved_sha256 / approval_mac / approval_sig below. Those bind the command
// to the approval FOR THE EXECUTOR, after the decision is taken. This binds what was DISPLAYED to
// the decision itself, before it is taken.
// EVERY UNCERTAINTY RESOLVES TO REFUSE. A missing `expect`, an unreadable one, a job that has gone
// away, or a serialisation this file and the browser disagree about all produce a 409 and a
// reload, never an execution. That direction is the whole point: the cost of a false refusal is
// one reload, and the cost of a false acceptance is a command the human never saw running as him.
function pcStableJson(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pcStableJson).join(',') + ']';
  const k = Object.keys(v).sort();
  const out: string[] = [];
  for (let i = 0; i < k.length; i++) out.push(JSON.stringify(k[i]) + ':' + pcStableJson(v[k[i]]));
  return '{' + out.join(',') + '}';
}
// Returns '' when the displayed job and the stored job agree, otherwise a sentence naming the ONE
// field that drifted. It names the field because "binding mismatch" tells the operator nothing and
// this refusal is the only place he will ever learn that his queue moved under him.
function pcApproveDrift(job: any, expect: any): string {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
    return 'this gate page sent no record of what it displayed for this job, so the server cannot '
         + 'confirm you are approving the job you were shown. Reload the gate and approve again.';
  }
  const pairs: string[][] = [
    ['status', String((job as any).status || ''), String(expect.status || '')],
    ['command_type', String((job as any).command_type || ''), String(expect.command_type || '')],
    ['staged_by', String((job as any).staged_by || ''), String(expect.staged_by || '')],
  ];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][1] !== pairs[i][2]) {
      return pairs[i][0] + ' has changed since the gate drew this job: the gate showed "'
           + pairs[i][2] + '", the server now holds "' + pairs[i][1] + '".';
    }
  }
  if (pcStableJson((job as any).arguments) !== pcStableJson(expect.arguments)) {
    return 'the arguments have changed since the gate drew this job: the command shown on screen '
         + 'is not the command now stored against this job id.';
  }
  return '';
}
// The one funnel. Loads the job, refuses a missing one, and refuses drift. Returns the job data
// on success so the caller does not read the document twice.
async function pcBindOrRefuse(res: express.Response, jobId: string, action: string, expect: any): Promise<any> {
  const d = await db.collection('pending_confirms').doc(String(jobId)).get();
  if (!d.exists) { res.status(404).json({ error: 'job not found' }); return null; }
  const x: any = d.data() || {};
  const drift = pcApproveDrift(x, expect);
  if (!drift) return x;
  try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'approval_refused_drift', message: 'REFUSED a ' + String(action) + ' of job ' + String(jobId) + ' - it is not the job the gate displayed. ' + drift + ' Nothing was approved, stamped or executed.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
  res.status(409).json({
    error: 'stale_gate_view', staleView: true, jobId: String(jobId), drift: drift,
    message: 'This job is not what the gate showed you, so nothing was done to it. ' + drift
           + ' Reload the gate, read the job again, and approve it there if it is still what you want.'
  });
  return null;
}
app.post('/api/webauthn/confirm/options', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const jobId = req.body && req.body.jobId; const action = req.body && req.body.action;
  if (!jobId || (action !== 'approve' && action !== 'deny')) { res.status(400).json({ error: 'bad jobId/action' }); return; }
  const creds = await waGetCreds();
  const challenge = Buffer.concat([crypto.randomBytes(24), waSha(jobId + '|' + action)]);
  const options = await generateAuthenticationOptions({ rpID: WA_RP_ID, userVerification: 'required', challenge, allowCredentials: creds.map((c: any) => ({ id: c.credentialID, transports: c.transports || undefined })) });
  waSetChal(res, 'wa_confirm', options.challenge);
  res.json(options);
}));
// [SEC-CANON-SURROGATE-V1] LONE SURROGATES ARE REFUSED, NOT SUBSTITUTED.
// The approval digest stamped below is computed here in Node and re-computed in Python by
// gate-exec's verifier. The two languages do not agree on an unpaired UTF-16 surrogate:
// Node's UTF-8 encoder substitutes U+FFFD and happily produces a digest, while Python's
// str.encode('utf-8') raises UnicodeEncodeError. The Python call site has no try/except, so
// such a command escapes as a 500 -- an unjournalled crash whose cause nobody can read --
// instead of a refusal anyone can audit. Refusing here makes the divergence unreachable
// from the side that WRITES the document: nothing is stamped, nothing is signed, nothing
// executes, and the refusal is journalled and returned as a 403.
// Firestore stores well-formed UTF-8, so this is not reachable through the staging path
// today. It is armed BEFORE the verifier lands rather than after, because after is when a
// 500 has already happened.
function pcLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xDC00 && c <= 0xDFFF) return true;
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n < 0xDC00 || n > 0xDFFF) return true;
      i++;
    }
  }
  return false;
}
app.post('/api/webauthn/confirm/verify', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const jobId = req.body && req.body.jobId; const action = req.body && req.body.action;
  if (!jobId || (action !== 'approve' && action !== 'deny')) { res.status(400).json({ error: 'bad jobId/action' }); return; }
  // [SEC-APPROVE-BIND-V1] FIRST, before deny, before the identity check, before anything is read
  // for a second time: prove this job id still holds the job the gate drew. DENY is bound too --
  // a deny aimed at the wrong id silently destroys a staged job that nobody chose to discard.
  if (!(await pcBindOrRefuse(res, String(jobId), String(action), req.body && req.body.expect))) return;
  if (action === 'deny') { await waLegacyApply(jobId, 'deny'); res.json({ ok: true, jobId, action: 'deny' }); return; }
  // [FAIL-CLOSED IDENTITY] refuse approval of any job whose staged_by is not an active provisioned strain.
  {
    const _qd = await db.collection('pending_confirms').doc(jobId).get();
    const _sb = _qd.exists ? String((_qd.data() as any).staged_by || '') : '';
    const _banned: any = { 'fleet-drafter': 1, 'fleet-courier': 1, '': 1, 'unknown': 1 };
    let _okId = false;
    if (_sb && !_banned[_sb]) { try { const _s = await db.collection('strains').doc(_sb).get(); _okId = _s.exists && (_s.data() as any).status === 'active'; } catch (e) { _okId = false; } }
    if (!_okId) {
      try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'security_quarantine', message: 'Refused approval of job ' + jobId + ' - non-provisioned identity "' + _sb + '".', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
      try { await db.collection('pending_confirms').doc(jobId).update({ status: 'quarantined', quarantined_at: FieldValue.serverTimestamp(), quarantine_reason: 'staged_by not an active provisioned strain: ' + _sb }); } catch (e) {}
      res.status(403).json({ error: 'quarantined: identity "' + _sb + '" is not a provisioned strain; cannot approve', quarantined: true }); return;
    }
  }
  const gtoken = (req.body && req.body.googleAccessToken) || '';
  // [SEC-IAP-GODMODE-V1] IAP identity substitutes for the Google token: IAP verifies the
  // JWT itself and binds aud to THIS backend, strictly narrower than tokeninfo, whose aud
  // is any client the approver signed into. FAIL-CLOSED: no PC_IAP_AUD, no IAP god-mode.
  const pcIapGodEmail = PC_IAP_AUD ? pcIapEmail(req) : '';
  const pcIapGod = !!pcIapGodEmail && WA_APPROVER_EMAILS.length > 0 && WA_APPROVER_EMAILS.indexOf(pcIapGodEmail) >= 0;
  const godmode = !!GATE_EXEC_URL && (!!gtoken || pcIapGod);
  // [F21] MANDATORY DANGER ASSERTION - never put this back behind `if (godmode)`.
  // Before this fix `danger` was only computed inside `if (godmode)`, and godmode is
  // `!!gtoken && !!GATE_EXEC_URL` - the CLIENT decides it, by choosing whether to send
  // googleAccessToken. Omitting that one field left danger === false, skipped the 428 +
  // assertion branch entirely, and a destructive command (waIsDangerous) was approved on the
  // unlock cookie alone with NO fresh job-bound Face ID, journalled as an ordinary legacy
  // confirm. The command is now loaded and classified on EVERY approve, god-mode and legacy
  // alike, so the danger branch below is reachable on both paths.
  let command = ''; let danger = false;
  {
    const jc = await waJobCommand(jobId);
    if (!jc.ok && jc.err === 'job not found') { res.status(404).json({ error: jc.err }); return; }
    if (!jc.ok && godmode) { res.status(400).json({ error: jc.err }); return; }
    if (!jc.ok) {
      // The job exists but carries no arguments.command/cmd (a gcp_api / run_roll / vm_resize
      // proposal, for example). waIsDangerous only ever inspects command TEXT, so there is
      // nothing here for it to classify and no assertion to demand. Approval continues on the
      // legacy path exactly as it did before. This is deliberately NOT a hard refusal: making
      // every non-command job unapprovable would lock the operator out of their own queue.
      console.error('[gate] F21: job ' + jobId + ' has no command field to classify (' + String(jc.err) + '); danger classification not applicable, continuing on the legacy approve path.');
    }
    // SEC-DANGER-UNION-V1: FAIL-DANGEROUS UNION. The text classifier inspects command TEXT only.
    // For a staged gcp_api call the ONLY alternative it matches is (\bdestroy\b) hitting the word
    // "destroy" inside the generated '# DANGER destroy-class GCP call' COMMENT line that
    // harGcpStage builds. Reword that adjective and every gcp_api mutation on every verb silently
    // loses its second factor. jc.danger is the STAGER'S STRUCTURED VERDICT (arguments.danger,
    // written by harGcpStage from harGcpDanger). Either is sufficient; neither is load-bearing
    // alone. The regex is kept VERBATIM on purpose -- deploy-cp-harness.sh seds the format-word
    // alternative and greps for the result, so editing waIsDangerous kills the deploy.
    // NOT COVERED: vm_start/vm_stop/vm_resize/run_roll stage via harVmGateStage and carry no
    // arguments.danger at all. That is item D1 and needs its own separate change.
    command = jc.command || ''; danger = waIsDangerous(command) || jc.danger === true;
  }
  // [SEC-CANON-SURROGATE-V1] see pcLoneSurrogate above. Refuse BEFORE anything is stamped,
  // signed, journalled as approved, or handed to god-mode.
  if (command && pcLoneSurrogate(command)) {
    try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'approve_refused_canon', message: 'Refused approval of job ' + String(jobId) + ' - the command contains an unpaired UTF-16 surrogate, which this control plane and the Python approval verifier canonicalise differently. Nothing was approved, stamped or executed.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    res.status(403).json({ error: 'cannot approve: the command contains an unpaired UTF-16 surrogate and cannot be canonicalised identically by the approval verifier', canon: 'lone-surrogate' });
    return;
  }
  // [APPROVED-SHA256-WRITER-V1] 2026-08-01. Record the digest of the command the human is
  // approving, AT APPROVAL TIME. exec_server.py pins a presented script against
  // arguments.command re-read from Firestore at execution time; fleet-gate-exec-sa holds
  // project-level roles/datastore.user, so anything able to rewrite the job document moves
  // both sides of that comparison together and the pin still passes.
  // NOTHING READS THIS YET, on purpose. Enforcement shipped alone 403s every gated job
  // forever including its own undo, so the writer lands first and soaks; the executor gets a
  // fallback for documents written before this field existed.
  // Never allowed to block an approval: a Firestore hiccup must not cost a human tap.
  // Stamped only when there is a command to hash -- a gcp_api or vm_resize proposal has none.
  if (command) {
    try {
      // [C3-APPROVAL-MAC-V1] The digest alone is not a control. It lives in the same
      // document as the command, and every principal with project-wide roles/datastore.user
      // -- fleet-gate-exec-sa and executor-sa both hold it -- can rewrite both sides in one
      // transaction plus the journal that would show it. Firestore IAM has no per-collection
      // granularity, so that grant cannot be narrowed. Signing can still close it: the key
      // lives in Secret Manager and is granted only to the control plane and gate-exec, so a
      // principal that can WRITE the document still cannot FORGE the approval.
      // jobId is inside the MAC so a signature cannot be lifted onto a different job.
      // FAIL-SOFT: with no key configured this writes exactly what it wrote before. A missing
      // secret must never stop a human approving their own job.
      const _cmdSha = crypto.createHash('sha256').update(command, 'utf8').digest('hex');
      const _macKey = process.env.APPROVAL_MAC_KEY || '';
      const _stamp: { approved_sha256: string; approved_sha256_at: string; approval_mac?: string; approval_mac_v?: number; approval_sig?: string; approval_sig_v?: number; approval_sig_canon?: string; approval_sig_alg?: string; approval_sig_key?: string; approval_sig_approver?: string; approval_sig_iat?: string; approval_sig_exp?: string } = {
        approved_sha256: _cmdSha,
        approved_sha256_at: new Date().toISOString()
      };
      if (_macKey) {
        _stamp.approval_mac = crypto.createHmac('sha256', _macKey).update(jobId + '|' + _cmdSha, 'utf8').digest('hex');
        _stamp.approval_mac_v = 1;
      }
      // [SEC-APPROVAL-KMSSIG-V1] Stage C, DUAL-EMITTED beside the MAC above. The MAC line is
      // deliberately untouched so an existing deployment can migrate A -> B -> C on its own
      // schedule; a fresh install sets APPROVAL_SIG_KEY_VERSION and goes straight to C.
      //
      // FAIL-SOFT HERE, FAIL-CLOSED THERE, and the split is the design, not an oversight.
      // A KMS outage must never cost a human their approval tap, so this logs and continues.
      // The control therefore lives ENTIRELY IN THE VERIFIER, which MUST refuse a job that
      // carries no valid signature. A writer that fails closed bricks the queue including its
      // own undo; a verifier that fails open is not a control at all. CANON-SPEC.md section 6.
      if (PC_APPROVAL_SIG_KEY) {
        try {
          // Approver identity is RESOLVED, never self-asserted. IAP identity is preferred
          // because IAP verifies the JWT itself and binds aud to this backend; otherwise the
          // Google token is exchanged through waGoogleEmail, which checks the audience before
          // it believes the address. Neither available means we say so in the signed bytes
          // rather than quietly naming somebody.
          let _appr = pcIapGodEmail || '';
          if (!_appr && gtoken) _appr = (await waGoogleEmail(gtoken)) || '';
          if (!_appr) _appr = 'unverified:' + WA_USER;
          const _now = Date.now();
          const _iat = new Date(_now).toISOString();
          const _exp = new Date(_now + PC_APPROVAL_SIG_TTL_SEC * 1000).toISOString();
          // [PC-APPROVAL-CANON-V2] THE EXECUTION CONTEXT, READ FROM THE JOB WE ARE APPROVING.
          // This is a second read of the same document, and it is safe to make one: the
          // [SEC-APPROVE-BIND-V1] pcBindOrRefuse call at the top of this handler has ALREADY
          // refused this approval if command_type or arguments moved since the gate drew the
          // job, so what is signed here is what was displayed. Signing values the operator
          // never saw would be worse than not signing them at all.
          const _sigDoc = await db.collection('pending_confirms').doc(String(jobId)).get();
          const _sigJx: any = _sigDoc.exists ? (_sigDoc.data() || {}) : {};
          const _ctyp = String(_sigJx.command_type || '');
          const _asha = pcApprovalArgsSha(_sigJx.arguments);
          const _canon = pcApprovalCanonV2({
            alg: PC_APPROVAL_SIG_ALG, jid: String(jobId), csha: _cmdSha, ctyp: _ctyp,
            asha: _asha, appr: _appr,
            kver: PC_APPROVAL_SIG_KEY, iat: _iat, exp: _exp });
          _stamp.approval_sig = await pcApprovalSign(_canon);
          _stamp.approval_sig_v = 4;
          // Every field that entered the signed bytes is also stored, because the verifier
          // REBUILDS the canonical bytes from these and never parses the signed blob. It must
          // take jid and csha from the job it is about to run, NOT from this document.
          // [PC-APPROVAL-CANON-V2] ctyp AND asha ARE NOT STORED, AND THAT IS THE POINT. appr,
          // kver, iat and exp are facts about the approval that the job document does not
          // otherwise carry, so the verifier has nowhere else to get them. ctyp and asha are
          // facts about the JOB, which the verifier is holding anyway -- storing them would
          // hand the adversary who can rewrite command_type the matching value to rewrite
          // beside it, which is precisely the move V2 exists to stop.
          _stamp.approval_sig_canon = PC_APPROVAL_CANON_V2_ID;
          _stamp.approval_sig_alg = PC_APPROVAL_SIG_ALG;
          _stamp.approval_sig_key = PC_APPROVAL_SIG_KEY;
          _stamp.approval_sig_approver = _appr;
          _stamp.approval_sig_iat = _iat;
          _stamp.approval_sig_exp = _exp;
        } catch (e) {
          console.error('[gate] SEC-APPROVAL-KMSSIG-V1 signing failed for ' + jobId + ': ' + String(e));
        }
      }
      await db.collection('pending_confirms').doc(jobId).set(_stamp, { merge: true });
    } catch (e) { console.error('[gate] APPROVED-SHA256-WRITER-V1 stamp failed for ' + jobId + ': ' + String(e)); }
  }
  if (godmode) { await waRunGodmode(res, jobId, command, gtoken, pcIapGodEmail, (req.body as any).response || null); return; }
  // [GATE-LOOP-V1] 2026-08-01. An approve with no Google access token CANNOT execute.
  // gtoken is forwarded to gate-exec as access_token so the job runs as the approver.
  // Without it this falls to waLegacyApply, which writes status 'confirmed' and runs
  // nothing, while the legacy REST path posts /run with no Authorization header that our
  // own edge drops. The job strands and is later reported refused -- AFTER the human has
  // spent a tap and, on a dangerous job, a fresh Face ID.
  // Re-unlocking the passkey reloads the page and the browser-held Google token dies with
  // it, so this fired every time the session was re-minted. Refuse BEFORE touching the job:
  // nothing written, nothing consumed, queue unchanged, reconnect and tap once.
  // DENY is untouched: it executes nothing by design, so legacy is correct there.
  if (!gtoken) {
    res.status(412).json({
      error: 'google_not_connected',
      needGoogle: true,
      jobId: jobId,
      action: 'approve',
      message: 'Approvals run as you, so they need a Google connection. Nothing was changed and this job is still waiting. Connect Google, then approve once.'
    });
    return;
  }
  await waLegacyApply(jobId, 'approve');
  res.json({ ok: true, jobId, action: 'approve', mode: 'legacy-confirmed' });
}));
// ---- "pre-approve now, run later" (ADDITIVE) ----
// (2) Human PRE-AUTHORIZES a job now (Face-ID gated session + approver allowlist). Executes NOTHING; it
//     stamps pending_confirms with a single-use run_token, a command hash, and a 12h expiry.
app.post('/api/webauthn/preapprove', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const gtoken = (req.body && req.body.googleAccessToken) || '';
  const email = await waGoogleEmail(gtoken);
  // Mirror the god-mode approver allowlist check inside waRunGodmode: an EMPTY allowlist DENIES entirely.
  if (!WA_APPROVER_EMAILS.length || !email || WA_APPROVER_EMAILS.indexOf(email) < 0) { res.status(403).json({ error: WA_APPROVER_EMAILS.length ? 'Google identity not an authorized approver' : 'pre-approve disabled: no approver allowlist configured (set WA_APPROVER_EMAILS)' }); return; }
  const jobId = req.body && req.body.jobId;
  if (!jobId) { res.status(400).json({ error: 'bad jobId' }); return; }
  // [SEC-APPROVE-BIND-V1] Pre-approval mints a single-use run_token that /api/jobs/fire redeems
  // with NO human present, so a pre-approval aimed at a job the human did not read is the most
  // expensive version of this defect, not the cheapest. Same binding, same refusal.
  if (!(await pcBindOrRefuse(res, String(jobId), 'preapprove', req.body && req.body.expect))) return;
  // VERIFY-GREP: PREAPPROVE-STATUS-PRECONDITION-V1   (fleet-advisor 2026-07-30)
  // FAIL-CLOSED STATUS PRECONDITION. Pre-approval mints a single-use run_token that
  // /api/jobs/fire redeems with NO human present, and the ONLY state gate on /api/jobs/fire is
  // status === 'preapproved' -- which this route had just written. Without this check every
  // state was pre-approvable: an already-'executed' job was re-armed and fired a SECOND time on
  // ONE human intent; a 'superseded', 'denied', 'expired' or 'quarantined' job was resurrected,
  // silently overturning the refusal that put it there. A missing or absent status reads as NOT
  // PENDING -- absence is never permission. Same 409 shape /api/jobs/supersede already uses.
  // NOT a narrowing of any real path: /api/webauthn/pending only ever returns
  // status === 'pending', and it is the only source of job ids the gate renders, so per-job,
  // batch and workstream pre-approve all act on cards that were pending when rendered.
  {
    const _pdoc = await db.collection('pending_confirms').doc(String(jobId)).get();
    if (!_pdoc.exists) { res.status(404).json({ error: 'job not found' }); return; }
    const _px: any = _pdoc.data() || {};
    const _pstatus = String(_px.status || '');
    if (_pstatus !== 'pending') {
      try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'preapprove_refused', message: 'Refused to pre-approve job ' + String(jobId) + ': status is ' + (_pstatus || '(none)') + '; only a pending proposal can be pre-approved.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
      res.status(409).json({ error: 'cannot pre-approve: status is ' + (_pstatus || '(none)') + ' (only a pending proposal can be pre-approved)' });
      return;
    }
  }
  // VERIFY-GREP: PREAPPROVE-IDENTITY-DANGER-V1   (fleet-security 2026-07-30)
  // FAIL-CLOSED IDENTITY. patch-identity-failclosed.py installs the same gate on confirm/verify
  // and its header claims 'A phantom job renders quarantined and PHYSICALLY CANNOT be approved'.
  // That claim was FALSE on this route: pre-approve never looked at staged_by, so a job staged by
  // a non-provisioned identity could be pre-approved -- minting a single-use run_token that
  // /api/jobs/fire later redeems with NO session and NO human. Same banned set, same active-strain
  // requirement, same 403 shape. Absence is never permission: a missing doc, a blank staged_by and
  // an unknown strain all REFUSE.
  //
  // [F2] A READ FAILURE IS NOT A NEGATIVE ANSWER -- and this route FANS OUT.
  // The confirm/verify gate collapses catch(e) into _okId = false and then writes status
  // 'quarantined'. There that costs one job, with a human watching it happen. Here it would cost a
  // workstream: preapproveSelected() and preapproveGroup(ids) loop over every ticked job and break
  // ONLY on 401, so one transient strains blip would quarantine the whole selection -- and the
  // status precondition above (an allow-list of exactly 'pending') would then make every one of
  // those jobs PERMANENTLY un-pre-approvable. That is a worse outage than the hole it closes. The
  // pending-list filter in patch-identity-failclosed.py already separates these two cases and says
  // so in-source ('identity filter SKIPPED this request. Nothing quarantined.'); its [F22] note
  // records a prior incident of the same shape. So: THREE verdicts, not two.
  //   'ok'         -> proceed.
  //   'bad'        -> a DEFINITIVE negative answer. The ONLY verdict that quarantines.
  //   'unreadable' -> the registry did not answer. Refuse THIS request, journal it, quarantine
  //                   NOTHING, leave the job 'pending' and therefore fully retryable once the
  //                   registry recovers. Fail-closed on authorisation, non-destructive on state.
  // A banned or blank staged_by needs no registry read at all, so it stays 'bad' by construction
  // and a registry outage can never launder it into 'unreadable'.
  {
    const _iaDoc = await db.collection('pending_confirms').doc(String(jobId)).get();
    const _iaSb = _iaDoc.exists ? String((_iaDoc.data() as any).staged_by || '') : '';
    const _iaBanned: any = { 'fleet-drafter': 1, 'fleet-courier': 1, '': 1, 'unknown': 1 };
    let _iaVerdict = 'bad';
    if (_iaSb && !_iaBanned[_iaSb]) {
      try { const _iaS = await db.collection('strains').doc(_iaSb).get(); _iaVerdict = (_iaS.exists && (_iaS.data() as any).status === 'active') ? 'ok' : 'bad'; }
      catch (e) { _iaVerdict = 'unreadable'; }
    }
    if (_iaVerdict === 'unreadable') {
      try { console.error('[gate] SECURITY: strains registry read FAILED while pre-approving job ' + String(jobId) + ' (staged_by ' + _iaSb + '). Pre-approval REFUSED, NOTHING quarantined, job left pending and retryable.'); } catch (e) {}
      try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'preapprove_identity_unverifiable', message: 'Could not pre-approve job ' + String(jobId) + ' - the strains registry read failed, so staged_by (' + _iaSb + ') could not be verified either way. NOTHING was quarantined; the job is still pending and pre-approval can be retried.', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
      res.status(503).json({ error: 'cannot pre-approve: identity registry unreadable, try again', retryable: true, quarantined: false });
      return;
    }
    if (_iaVerdict !== 'ok') {
      try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'preapprove_quarantine', message: 'Refused to pre-approve job ' + String(jobId) + ' - staged_by is not an active provisioned strain (' + _iaSb + ').', timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
      try { await db.collection('pending_confirms').doc(String(jobId)).update({ status: 'quarantined', quarantined_at: FieldValue.serverTimestamp(), quarantine_reason: 'staged_by not an active provisioned strain: ' + _iaSb }); } catch (e) {}
      res.status(403).json({ error: 'cannot pre-approve: identity not provisioned (' + _iaSb + ')', quarantined: true });
      return;
    }
  }
  const jc = await waJobCommand(jobId);
  if (!jc.ok) { res.status(jc.err === 'job not found' ? 404 : 400).json({ error: jc.err }); return; }
  const command = jc.command || '';
  // VERIFY-GREP: PREAPPROVE-IDENTITY-DANGER-V1   (danger half)
  // [F21] + SEC-DANGER-UNION-V1 PARITY. confirm/verify classifies EVERY approve with the UNION
  //     command = jc.command || ''; danger = waIsDangerous(command) || jc.danger === true;
  // and escalates a destructive command to a FRESH, job-bound Face ID. Pre-approve had no danger
  // gate at all. This ships the SAME UNION -- not the text classifier alone.
  //
  // WHY THE SECOND TERM IS THE WHOLE POINT: waIsDangerous inspects command TEXT only. For a
  // staged gcp_api call the single alternative it matches, it matches BY ACCIDENT -- on one
  // adjective inside the generated DANGER comment line harGcpStage builds. Reword that adjective
  // and every gcp_api mutation on every verb silently loses this gate. jc.danger is the STAGER'S
  // STRUCTURED VERDICT (arguments.danger, written by harGcpStage from harGcpDanger) and
  // waJobCommand already returns it on this exact call. Either term is sufficient; neither is
  // load-bearing alone. Dropping the second term reopens precisely the class SEC-DANGER-UNION-V1
  // was written to close, on the one route where the human is NOT present at execution time.
  // jc IS IN SCOPE HERE: this block is inserted immediately after const command = jc.command,
  // which the route places immediately after const jc = await waJobCommand(jobId).
  //
  // WHY REFUSE OUTRIGHT RATHER THAN ACCEPT A JOB-BOUND ELEVATION HERE:
  // the escalation confirm/verify performs is a fresh human assertion AT THE MOMENT OF
  // EXECUTION. Pre-approval's entire purpose is that /api/jobs/fire runs LATER, unattended --
  // that route's own marker reads AUTH-NON-SESSION: run_token only, no gate cookie, by design.
  // A Face ID collected now cannot be re-demanded at fire time, so accepting one here would
  // only buy a signature authorising an unattended destructive run up to 12h afterwards, with
  // nobody present to abort it. A destructive command is precisely what must NOT be fireable
  // unattended, so it stays on confirm/verify where a human is present. This narrows nothing
  // that pre-approval was ever meant to cover; it removes a capability it should never have had.
  if (waIsDangerous(command) || jc.danger === true) {
    try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'preapprove_refused_danger', message: 'Refused to pre-approve job ' + String(jobId) + ' - destructive command; it must be approved live via confirm/verify with a fresh Face ID: ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    res.status(403).json({ error: 'cannot pre-approve: destructive command must be approved live with a fresh Face ID', danger: true });
    return;
  }
  const cmdSha = crypto.createHash('sha256').update(command).digest('hex');
  const runToken = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  // [APPROVED-SHA256-WRITER-V2] STAMP THE PIN ON THIS PATH TOO. Measured: this route and
  // /api/jobs/fire are a COMPLETE approval-to-execution path that never touches
  // /api/webauthn/confirm/verify, and confirm/verify held the ONLY writer of
  // approved_sha256. So every job pre-approved here reached exec_server.py's
  // approved_sha256 rung carrying NO pin, and was allowed only by that rung's
  // absent-field fallback -- which is why the absence journal could never drain and the
  // pin could never be hardened. The fallback is DELETED in this same change; this writer
  // is the half that makes deleting it safe.
  // cmd_sha ALREADY holds exactly this digest and /api/jobs/fire ALREADY rechecks it with
  // the same command precedence and the same hash, so this adds NO new refusal: the
  // executor can only refuse a fire that fire itself has already refused. It is written
  // under the name the executor reads.
  await db.collection('pending_confirms').doc(jobId).update({
    status: 'preapproved', preapproved_by: email, preapproved_at: FieldValue.serverTimestamp(),
    cmd_sha: cmdSha, approved_sha256: cmdSha, approved_sha256_at: new Date().toISOString(),
    expiry, single_use: true, run_token: runToken,
  });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'preapproved', message: 'Pre-approved job ' + jobId + ' by ' + email + ' (expires ' + new Date(expiry).toISOString() + '): ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, jobId, action: 'preapprove', mode: 'preapprove', preapproved_by: email, expiry });
}));
// (3) Fire a PRE-APPROVED job later. Authenticated ONLY by the run_token (the connector has no gate
//     cookie), compared with the existing constant-time waEq(). NO waSessionOk here.
// AUTH-NON-SESSION: single-use run_token compared with the constant-time waEq() against the stored value, plus status must be 'preapproved', a 12h expiry, and a cmd_sha recheck that refuses if the command changed since pre-approval; any failure reverts the job to 'pending' and returns 409. Deliberately NO gate cookie -- the connector fires this while the human is away. Privileged job control: do NOT restamp this as PUBLIC-BY-DESIGN.
app.post('/api/jobs/fire', waSafe(async (req, res) => {
  const jobId = (req.body && req.body.jobId) || '';
  const runToken = String((req.body && req.body.run_token) || '');
  if (!jobId || !runToken) { res.status(400).json({ error: 'bad jobId/run_token' }); return; }
  const ref = db.collection('pending_confirms').doc(jobId);
  const doc = await ref.get();
  if (!doc.exists) { res.status(404).json({ error: 'job not found' }); return; }
  const x: any = doc.data();
  const command = (x.arguments && (x.arguments.command || x.arguments.cmd)) || '';
  const curSha = crypto.createHash('sha256').update(command).digest('hex');
  const stored = String(x.run_token || '');
  // ALL preconditions. run_token compared with the constant-time waEq(). ANY failure => refuse the fire,
  // revert status to 'pending', journal the reason, and return 409 (execute NOTHING).
  const reason =
    // VERIFY-GREP: FIRE-STATUS-REVERT-V1  (AUTH FIRST -- fleet-advisor 2026-07-30)
    // The run_token comparison MUST be the first term. With the status term first, a caller who
    // knew only a jobId and sent any non-empty token short-circuited here and never reached
    // waEq -- and the refusal handler below then wrote status 'pending' over a FINISHED job,
    // putting it back in the human approval queue with no session and no valid token. The old
    // order also leaked state: the 409 body read 'not preapproved (status=executed)', a free
    // oracle for an anonymous caller. Do not reorder these two terms back.
    (!stored || !waEq(runToken, stored)) ? 'run_token mismatch' :
    (x.status !== 'preapproved') ? ('not preapproved (status=' + String(x.status) + ')') :
    (!(typeof x.expiry === 'number' && Date.now() < x.expiry)) ? 'preapproval expired' :
    (!command) ? 'job has no command' :
    (curSha !== String(x.cmd_sha || '')) ? 'command changed since pre-approval (cmd_sha mismatch)' : '';
  if (reason) {
    // VERIFY-GREP: FIRE-STATUS-REVERT-V1  (SCOPED REVERT -- fleet-advisor 2026-07-30)
    // The revert to 'pending' used to be unconditional. A successful fire DELETES run_token, so
    // an already-EXECUTED job is exactly what lands here -- and 'pending' is the status
    // /api/webauthn/pending filters on, so a finished job walked back into the approval queue.
    // 'pending' is now written ONLY for a job actually sitting in 'preapproved', the one state
    // this revert was designed for. Anything else is recorded and LEFT ALONE.
    //
    // The probe record is arrayUnion(reason), NOT a timestamped append. arrayUnion de-duplicates
    // identical strings and there are only five distinct reasons, so a hostile client cannot
    // grow this document. A timestamped append would have handed an unauthenticated caller an
    // unbounded write primitive -- a worse bug than the one being fixed.
    const _frRevert = (x.status === 'preapproved');
    const _frPatch: any = { fire_refused_reason: reason, fire_refused_at: FieldValue.serverTimestamp() };
    if (_frRevert) { _frPatch.status = 'pending'; }
    else { _frPatch.fire_refused_probes = FieldValue.arrayUnion(reason); }
    await ref.update(_frPatch).catch(() => {});
    await db.collection('journal').add({ agent_id: 'human_operator', action: 'fire_refused', message: 'Refused to fire pre-approved job ' + jobId + ': ' + reason + (_frRevert ? ' (reverted to pending)' : ' (status PRESERVED, not reverted: ' + String(x.status || '') + ')'), timestamp: FieldValue.serverTimestamp() });
    res.status(409).json({ error: 'refused: ' + reason, status_preserved: !_frRevert }); return;
  }
  await ref.update({ status: 'executing', started_by: 'connector:fire', started_at: FieldValue.serverTimestamp() }).catch(() => {});
  // The human is AWAY: we MUST NOT reuse a live human Google access_token. gate-exec has to run this under
  // its OWN scoped service identity (see preapprove-notes.md). We forward an EMPTY token as that signal —
  // do NOT substitute the human or control-plane token here.
  const PREAPPROVE_EXEC_TOKEN = '';
  let r: any;
  try { r = await waExecuteApproved(jobId, command, PREAPPROVE_EXEC_TOKEN); }
  catch (e: any) {
    await ref.update({ status: 'pending', fire_refused_reason: 'exec engine call failed', fire_refused_at: FieldValue.serverTimestamp() }).catch(() => {});
    res.status(502).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); return;
  }
  const exec = r.exec; const exit = r.exit;
  await ref.update({
    status: 'executed', ran_as: 'preapprove-connector', exit_code: exit,
    stdout_tail: String((exec && exec.stdout) || '').slice(-6000), stderr_tail: String((exec && exec.stderr) || (exec && exec.raw) || '').slice(-6000),
    confirmed_by: 'preapprove:' + String(x.preapproved_by || '?'), ran_at: FieldValue.serverTimestamp(),
    single_use_consumed: true, used: true, used_at: FieldValue.serverTimestamp(), run_token: FieldValue.delete(),
  });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'fire_executed', message: 'Fired pre-approved job ' + jobId + ' (exit ' + exit + ', pre-approved by ' + String(x.preapproved_by || '?') + '): ' + command.slice(0, 200), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: exit === 0, jobId, action: 'fire', mode: 'preapprove', exit_code: exit, stdout: (exec && exec.stdout) || '', stderr: (exec && exec.stderr) || (exec && exec.raw) || '' });
}));
// ---- GATE v2 (ADDITIVE): workstream derivation + safe supersede of a staged proposal ----
// Workstream for a staged job: prefer a native `workstream` field (stamped at stage time — see
// gatev2-notes.md), else parse the `[workstream: X]` token STANDING-RULES rule 9 requires at the
// start of every #DESC. Returns '' when unknown (the UI buckets those as "Ungrouped").
function waWorkstreamOf(j: any): string {
  try {
    if (j && j.workstream) return String(j.workstream).trim();
    const args = (j && j.arguments) || {};
    if (args.workstream) return String(args.workstream).trim();
    const cmd = String(args.command || args.cmd || '');
    const m = cmd.match(/\[workstream:\s*([a-z0-9._\-\/ ]+)\]/i);
    if (m) return m[1].trim();
    return '';
  } catch (e) { return ''; }
}
// (1) Supersede a staged approval. NON-privileged: it only retires a not-yet-run proposal, so it does
// NOT go through the human gate. Auth = the connector's bound OAuth role (oaBearerRole, hoisted from
// the assembled MCP-OAuth module) — the same principal that staged. Only a still-`pending` job can be
// superseded; anything already approved/pre-approved/executing is immutable here (fail-safe).
app.post('/api/jobs/supersede', waSafe(async (req, res) => {
  const role = await oaBearerRole(req);
  if (!role) { res.status(401).json({ error: 'connector bearer token required (bind a strain first)' }); return; }
  const jobId = String((req.body && (req.body.job_id || req.body.jobId)) || '');
  if (!jobId) { res.status(400).json({ error: 'job_id required' }); return; }
  const ref = db.collection('pending_confirms').doc(jobId);
  const doc = await ref.get();
  if (!doc.exists) { res.status(404).json({ error: 'job not found' }); return; }
  const x: any = doc.data();
  if (x.status !== 'pending') { res.status(409).json({ error: 'cannot supersede: status is ' + String(x.status) + ' (only a pending proposal can be superseded)' }); return; }
  const supersededBy = String((req.body && req.body.superseded_by) || '').slice(0, 200);
  // [GATE-QUEUE-COEXIST-V1] A SUPERSEDE ALWAYS LEAVES A SENTENCE. An empty note stored '',
  // which is falsy, so read_job_log's reason chain fell through it to null and the job read
  // exactly like one that was never touched. The caller's note is preferred and never
  // altered; this is only what gets written when the caller supplies none.
  const _rawNote = String((req.body && req.body.note) || '').slice(0, 500);
  const note = _rawNote || ('SUPERSEDED AND NEVER RAN: retired by ' + role + ' through POST /api/jobs/supersede' + (supersededBy ? (', replaced by job ' + supersededBy) : '') + '. The staging role withdrew this proposal before any human decided it; no note was supplied, so this sentence is the whole record.');
  await ref.update({ status: 'superseded', superseded_by_job: supersededBy, supersede_note: note, superseded_by_role: role, superseded_at: FieldValue.serverTimestamp() });
  await db.collection('journal').add({ agent_id: role, action: 'superseded', message: 'Superseded staged job ' + jobId + (supersededBy ? (' (superseded_by ' + supersededBy + ')') : '') + (note ? (': ' + note) : ''), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, job_id: jobId, status: 'superseded', by: role });
}));
// =============== end passkey + god-mode gate + dashboard + cost ===============


// [PC-CANONICAL-HOST-V48] 2026-08-15. THIS IS NO LONGER A REDIRECT, AND THAT REVERSES WHAT THE
// TWO NOTES BELOW SETTLED. It used to read "PUBLIC-BY-DESIGN: a bare unconditional redirect to
// /harness. It reads no data, holds no secret and issues no session; the destination does its own
// gating." Both halves of that stop holding here. The operator's measurement of the live URL --
// <hood-host>/harness -- is that it says the same word twice, so the Flow Hood is SERVED at the
// root and /harness is now the redirect, the opposite way round. The root therefore reads a
// document and needs a gate, and it has exactly the gate /harness has always carried: the same
// waSessionOk / waSendLocked pair, in the same order, from the SAME function body -- moving a page
// to a shorter URL must not move it out from behind the passkey, and a second hand-copied gate is
// a gate that can be half-edited.
//   [LAND-ON-GATE-V1] 2026-08-01. This handler once read req.headers.host and sent anything that
//   was not one named hostname to /harness. That hostname was retired the same day, so the other
//   branch could never be taken -- a host check that outlived its hostname, exactly like the front
//   door that caused the outage. It was deleted rather than repaired.
//   [SEC-NOGATE-V1] 2026-08-14: the target became /harness because the route this used to name no
//   longer exists.
// WHAT SURVIVES BOTH OF THOSE, UNCHANGED, IS THE PROPERTY oss/gen.py ASSERTS: this handler is ONE
// statement and it does NOT BRANCH ON THE REQUEST HOST. The outage was the branch, never the name,
// and the cut still compares these executable lines against a literal list. The gate decision and
// the canonical-host decision both live inside harFlowHood() beside the document they protect, so
// there is one copy of each and a reintroduced host branch here still fails the cut.
app.get('/', (req: any, res: any) => {
  harFlowHood(req, res);
});
// ================= PARACODING AGENTIC HARNESS (harness + chat + VM control) — ADDITIVE =================
// SECURITY (H1): every route below is GATED behind an unlocked passkey session (waGate). There is NO
// unauthenticated path: a fresh clone is closed by default and unauthenticated requests get 403.
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const p = req.path;
  const isHarness = p === '/chat' || p === '/api/chat' || p.startsWith('/api/keys') || p.startsWith('/api/ops/') || p.startsWith('/api/security/');
  if (isHarness) {
    if (!waSessionOk(req)) {
      if (p === '/chat') { waSendLocked(res); return; }
      // [SEC-NOGATE-V1] This said 'unlock the gate first'. The gate is deleted, and the operator
      // read this exact string in a console tab and went looking for a page that no longer exists.
      // It is also the message a request to the WRONG SERVICE gets: this app.use is not wrapped by
      // the PC_SURFACE registration filter, so it answers on the mcp surface too, where there is no
      // IAP and never a session cookie. Name both possibilities rather than only the one.
      res.status(403).json({ error: 'forbidden: no console session. Open the console host in a browser and sign in. If you are calling the MCP host, this path is not on that surface.' }); return;
    }
  }
  next();
});

const HAR_HARNESS_HTML: string = pcHtml('harness.html');
// [SEC-DEBLOB-V1] The chat document constant is gone: it decoded byte-identical to the harness document, so both routes now serve one file, harness.html, through one constant.
// [SEC-VM-UNCONFIGURED-V1] NO INSTANCE CONFIGURED MEANS NO VM CALLS -- ON THE HTTP SURFACE TOO.
// The MCP tool path has refused on an empty WS_VM since that marker was introduced, but these two
// constants still carried DEFAULTS, and the /api/vm/* HTTP routes below were behind waGate and
// nothing else. The workstation is a y/n install option that DEFAULTS TO NO, so the COMMON install
// issued Compute API calls against an instance name it had invented. The defaults are removed
// (a guessed instance name is indistinguishable at runtime from one we cannot see -- unset ==
// withheld) and the refusal is applied at BOTH the single read chokepoint and each route.
const WS_VM = process.env.WS_VM || '';
const WS_ZONE = process.env.WS_ZONE || '';
const HAR_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
// ops-exec fast-shell: token that authenticates the control-plane -> on-box ops-exec (:8022).
// Same value lives in the box's `ops-token` instance metadata. Passed as OPS_TOKEN env at deploy.
const OPS_TOKEN = process.env.OPS_TOKEN || '';
// "off the gate once in the morning" window: gcloud-as-you stays live this long off a single gate auth.
// The control-plane owns the window (durable); the box only ever sees short-lived (~1h) forwarded tokens.
const OPS_WINDOW_MS = Number(process.env.OPS_WINDOW_HOURS || 12) * 3600 * 1000;
// Model catalog is env-driven so it always reflects what's actually available (id -> real API model string).
// Set CHAT_MODELS (JSON) to override. Defaults are placeholders — tune the `api` strings to current models.
// [HARNESSUI-MODEL-DERIVE-V1] The catalog is BUILT from the CHAT_API_* environment and every
// LABEL is DERIVED from the api id. Measured on the live service 2026-08-07 (revision
// paracoding-control-plane-00267-nex): CHAT_API_OPUS was set to a real opus id and CHAT_MODELS
// was unset, while this file read neither CHAT_API_OPUS nor CHAT_API_FABLE anywhere -- zero
// occurrences. So the operator's configuration was inert, the harness kept calling the sonnet
// default, and the badge kept printing a hand-typed label to match. Correcting the label alone
// would be the same defect with a different string: the label must be UNABLE to disagree with
// the model actually called, which means deriving both from one value.
// The trailing literals are the last-resort floor for a fleet that has configured nothing;
// they preserve today's behaviour exactly rather than failing to boot, and they are still
// never displayed verbatim -- harModelLabel() renders them like any other id.
function harModelLabel(api: string): string {
  return String(api || '').replace(/^models\//, '').replace(/^(claude|gemini|anthropic|google)[-.]/i, '')
    .replace(/-\d{6,8}$/, '').replace(/-(preview|latest|exp)$/i, '')
    .split(/[-_]/).filter((w: string) => !!w)
    .map((w: string) => (/^[0-9]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
// [CHAT-OPUS5-DEFAULT-V1] OPUS 5 FLOOR, by operator ruling on 2026-07-24. Any legacy
// claude-opus-4*/3* id arriving from CHAT_API_OPUS or from a hand-written CHAT_MODELS JSON is
// force-upgraded, so stale configuration can never pin the chat back to an older Opus.
// The same floor was duplicated in the scheduled runners; 12.5 deleted them, so this is the only one.
const HAR_OPUS5 = 'claude-opus-5';
// [CHAT-OPUS5-FLOOR-NARROW-V104] THE PREFIX MATCH SWALLOWED MODELS NEWER THAN THE ONES IT WAS
// PROTECTING AGAINST. `s.indexOf('claude-opus-4') === 0` was written when opus-4 meant 4.0 and 4.1
// and the only risk was stale config pinning the chat backwards. The family kept gaining members:
// it now also catches claude-opus-4-5, claude-opus-4-6 and claude-opus-4-8, which POSTDATE this
// floor. MEASURED 2026-08-18 on a real project: 4-5 and 4-6 are the two Anthropic models with the
// LARGEST regional quota there (6,000,000 input tokens/min in each of us-east5, europe-west1 and
// asia-southeast1) while claude-opus-5 has no regional bucket at all. So the operator could not
// pin the only models that would actually serve -- CHAT_API_OPUS was silently rewritten to
// claude-opus-5 and the chat kept failing for a reason the setting appeared to have addressed.
// Now it names the ids it actually means. A version suffix (@20250805) still matches.
function harOpus5(m: string): string {
  const s = String(m || '').trim();
  if (!s) return HAR_OPUS5;
  // the opus-3 family is stale end to end; there is no opus-3-x that postdates opus-5.
  if (s.indexOf('claude-opus-3') === 0) return HAR_OPUS5;
  // opus-4: ONLY bare 4 and 4-1, optionally version-suffixed. NOT 4-5, 4-6, 4-8 or anything later.
  if (/^claude-opus-4(-1)?(@|$)/.test(s)) return HAR_OPUS5;
  return s;
}
function harModelEntry(api: string): any {
  const a = harOpus5(String(api || ''));
  return { id: a, label: harModelLabel(a), sub: '', api: a };
}
function harModelList(apis: string[], floor: string): any[] {
  const seen: any = {}; const out: any[] = [];
  for (const a of apis) { const s = String(a || '').trim(); if (!s || seen[s]) continue; seen[s] = 1; out.push(harModelEntry(s)); }
  return out.length ? out : [harModelEntry(floor)];
}
// [CHAT-OPUS5-DEFAULT-V1] THIS IS THE BUG THE OPERATOR HIT. The claude floor used to be the single
// literal 'claude-sonnet-5', and a floor here is not a fallback nobody sees -- it is THE DEFAULT.
// With CHAT_API_OPUS unset the catalog contained exactly ONE claude entry, sonnet, so:
//   * harApiFor() below fell through to m[0] -> sonnet on EVERY request, and
//   * harness.html loadModels() selects MODELS.claude[0].id -> the only button was sonnet.
// A fresh install could therefore NEVER reach Opus without setting an env var and redeploying.
// Now both ids are floored, OPUS FIRST, so m[0] is opus-5 with nothing configured at all. Setting
// CHAT_API_OPUS / CHAT_API_SONNET still overrides either slot; order (opus first) is preserved.
// [CHAT-GFLASH37-V1] The gemini side had the SAME shape of bug the claude line above was fixed for:
// one slot, and an EMPTY string in it, so with CHAT_API_GPRO unset harModelList() fell through to the
// floor and the catalog held exactly ONE gemini entry. A fresh install could never reach a second
// Gemini model without hand-writing CHAT_MODELS JSON. Now BOTH slots carry a floored literal, so m[0]
// is a real entry with nothing configured at all and the other model is reachable from the same
// fresh install.
// ORDER IS SIGNIFICANT, AND [GCP-FLOWHOOD-DEFAULT-V70] MOVED IT DELIBERATELY. This comment used to
// end "AND 3.1 PRO STAYS FIRST ... the operator's default must not move". That instruction is
// SUPERSEDED, by the operator, for the reason the Flowhood exists: a fresh install has no Anthropic
// key, Gemini needs none because it rotates through Vertex OAuth, and the first thing an adopter
// does is ask a strain to build something. Flash is first because it is the cheap, fast model to
// meet the product on, not because Pro was demoted -- Pro is one click away and one env var from
// being first again. m[0] is still what harApiFor() returns for an unknown id and what
// harness.html loadModels() preselects; only which entry sits there has changed.
// gemini-3.7-flash is VERIFIED, not inferred from the announcement: Model Garden
// (GET publishers/google/models/gemini-3.7-flash) answers 200 launchStage=GA, while
// -preview / -001 / -latest / gemini-flash-3.7 all answer 404 NOT_FOUND. It is a GA id and carries
// no '-preview' suffix; harGeminiGlobalOnly()'s /^gemini-3/ still pins it to the global endpoint,
// which is where the sibling 3.x publisher model is served.
// [CHAT-ROUNDS-16-V74] ONE NUMBER FOR BOTH LOOPS. It was written as a bare 8 in two places, so
// raising it meant finding both -- exactly the two-registries shape this codebase keeps paying
// for. Named once, used twice, and reported in the cut-off message so a user who hits it is told
// the number rather than left guessing why the model stopped.
const HAR_CHAT_MAX_ROUNDS = 16;
const HAR_MODELS_DEFAULT = {
  claude: harModelList([process.env.CHAT_API_OPUS || HAR_OPUS5, process.env.CHAT_API_SONNET || 'claude-sonnet-5'], HAR_OPUS5),
  // [GCP-FLOWHOOD-DEFAULT-V70] FLASH IS FIRST, AND THE ORDER IS THE DEFAULT -- there is no
  // separate "default model" field anywhere. harness.html seeds MODEL.gemini from MODELS.gemini[0]
  // (loadModels), so whichever entry is listed first is what a fresh Flowhood opens on. The
  // operator asked for Gemini 3.7 by default; swapping these two is the whole of that change, and
  // reordering here without also changing setProvider() in harness.html leaves the page on Claude.
  // Pro is NOT removed -- it is one click away in the MODEL block, same as it was.
  gemini: harModelList([process.env.CHAT_API_GFLASH || 'gemini-3.7-flash', process.env.CHAT_API_GPRO || 'gemini-3.1-pro-preview'], 'gemini-3.7-flash'),
};
function harModels(): any { try { return process.env.CHAT_MODELS ? JSON.parse(process.env.CHAT_MODELS) : HAR_MODELS_DEFAULT; } catch (e) { return HAR_MODELS_DEFAULT; } }
function harApiFor(provider: string, id: string): string {
  // harOpus5 again here because a CHAT_MODELS JSON override never passes through harModelEntry().
  const m = harModels()[provider] || []; const hit = m.find((x: any) => x.id === id);
  const api = (hit && hit.api) || (m[0] && m[0].api) || '';
  return provider === 'claude' ? harOpus5(api) : api;
}

// ---- SECURITY (H1): harness auth gate. Requires an unlocked passkey session (waSessionOk, defined in
// the passkey additions injected before this block). Unauthenticated => 403. This makes EVERY harness
// route deny-by-default; there is no route that runs without a human-approved gate session. ----
// L2: never put exception text in a response body. The client gets a correlation id; the
// full error still goes to Cloud Logging via console.error, which is already access
// controlled - the operator loses nothing. These are WRAPPERS, so a leak in any one handler is a
// leak on every route they wrap.
// Deliberately harness-local and dependency-free: the L2 spec's waFail() belongs to
// cp-passkey-additions.ts (not edited here), and `crypto` is not imported in this file.
function harErrId(): string { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
function harFail(res: any, e: any, where: string): void {
  const id = harErrId();
  console.error('[' + where + '] handler error err_id=' + id, e);
  try { if (!res.headersSent) res.status(500).json({ error: 'internal error', err_id: id }); } catch (_e) {}
}
function waGate(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return async (req: express.Request, res: express.Response) => {
    if (!waSessionOk(req)) { res.status(403).json({ error: 'forbidden: unlock the gate first (passkey session required)' }); return; }
    try { await fn(req, res); }
    catch (e: any) { harFail(res, e, 'harness'); }
  };
}

// ---- Secret Manager REST (keys never touch the browser) ----
async function harSecretGet(name: string): Promise<string | null> {
  const tok = await waAccessToken();
  const r = await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets/' + name + '/versions/latest:access', { headers: { Authorization: 'Bearer ' + tok } });
  if (!r || !r.ok) return null;
  const j: any = await r.json();
  try { return Buffer.from(j.payload.data, 'base64').toString('utf8'); } catch (e) { return null; }
}
// [SEC-SECRETWRITE-ALLOWLIST-V1] A POSITIVE ALLOWLIST OF WHAT THIS FUNCTION MAY WRITE, ENFORCED
// BEFORE ANY REQUEST LEAVES THE PROCESS. Operator's requirement, and he is right to have raised
// it: "make sure it can not over write an existing x-wing key ... to prevent some future attack
// using that to overwrite the data lake key locking me out of my own data."
//
// WHAT THE THREAT ACTUALLY IS, measured rather than assumed. The X-Wing key itself is a CLOUD KMS
// key (VAULT_KMS_KEY, KEM_XWING) and no Secret Manager write can touch it. The wrapped master is
// a lake object living under one of the LAKE_EXEC_PREFIXES, and resolveKey() already refuses every
// write beneath those prefixes for every role. So the specific attack is blocked twice over
// today, in two other systems. This function is still where a future one would come from: it
// takes an arbitrary NAME, it has always taken an arbitrary name, and the only thing keeping it
// safe was that both of its callers happened to compose the name themselves. That is a property
// of today's call sites, not a property of the function -- exactly the shape of guarantee this
// codebase keeps learning not to trust.
//
// AN ALLOWLIST, NOT A DENYLIST, AND THAT CHOICE IS THE POINT. A denylist of critical names has to
// be edited every time a secret is added and is wrong the first time somebody forgets -- and the
// failure is silent and permanent, because a clobbered key is not recoverable from a backup of
// ciphertext. An allowlist fails the other way: a NEW legitimate write is refused loudly until
// someone adds it here deliberately, which is a build-time argument rather than a lockout.
//
// IT MATTERS MORE THAN IT LOOKS BECAUSE THE GRANT IS ABOUT TO WIDEN. github-token-<slug> is a name
// this install has never created, so the control plane needs create-and-add on Secret Manager
// where it previously only read. The narrower the code path behind a widened credential, the
// better, and this keeps it to two shapes.
//
// [GH-SECRET-LANE-PREFIX-V1] THE PREFIX COMES FROM THE ENVIRONMENT, WITH THE UNPREFIXED NAME AS
// THE DEFAULT, WHICH IS THE PATTERN THE LANE-LITERAL GATE ASKS FOR IN SO MANY WORDS: "compiled
// code cannot see ${PC_LP}, so reach it through process.env with the unprefixed name as the
// DEFAULT, and have install.sh set the variable." Every other secret this product creates is
// lane-namespaced so that two installs can share one GCP project. The first version of this
// wrote a bare github-token-<identity>, and the consequence is not cosmetic: in a two-lane
// project both installs would share one secret, and lane B's installer would grant lane B's
// service account read access to lane A's GitHub token. That is a cross-lane credential leak
// created by a naming choice, and it is the reason this indirection exists at all.
const PC_GH_SECRET_PREFIX = (process.env.PC_GH_SECRET_PREFIX || 'github-token-');
const PC_GH_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
function pcGhSecretName(slug: string): string { return PC_GH_SECRET_PREFIX + slug; }
function pcSecretWriteRefusal(name: string): string | null {
  if (/^chat-key-(claude|gemini)$/.test(name)) return null;
  // Anchored on BOTH ends: the prefix must match exactly and what follows must be a whole slug.
  // A startsWith() test alone would admit <prefix>../chat-key-claude, which is the leak the
  // sabotaged-list test in this commit's sibling proved a prefix-only rule lets through.
  if (name.startsWith(PC_GH_SECRET_PREFIX)
      && PC_GH_SLUG_RE.test(name.slice(PC_GH_SECRET_PREFIX.length))) return null;
  return 'REFUSED: this service does not write the secret "' + name + '". Secret writes are '
    + 'restricted to an explicit allowlist -- the chat API keys and ' + PC_GH_SECRET_PREFIX
    + '<identity> -- so that no route, present or future, can overwrite a key this install '
    + 'cannot regenerate. Nothing was sent to Secret Manager.';
}

async function harSecretSet(name: string, value: string): Promise<boolean> {
  return (await harSecretSetX(name, value)).ok;
}
// [SEC-SECRETWRITE-REASON-V1] The reason travels back. harSecretSet returned a bare boolean and
// threw the Secret Manager response away, so the console could only say "could not write the token
// to Secret Manager" -- which is what it said to the operator, and it cost a diagnostic job to
// learn the real answer was PERMISSION_DENIED on secrets.create. A failure report that names no
// cause is the same defect as a check that cannot fail: it looks like diligence and carries no
// information.
async function harSecretSetX(name: string, value: string): Promise<{ ok: boolean; detail?: string }> {
  const refusal = pcSecretWriteRefusal(name);
  if (refusal) { console.error('[secret] ' + refusal); return { ok: false, detail: refusal }; }
  const tok = await waAccessToken();
  // ensure secret exists (ignore 409 already-exists)
  await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets?secretId=' + encodeURIComponent(name), {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  const r = await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets/' + name + ':addVersion', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
  });
  if (r && r.ok) return { ok: true };
  let detail = 'HTTP ' + (r ? r.status : '?');
  try { const j: any = await r.json(); if (j && j.error && j.error.message) detail += ': ' + j.error.message; } catch (_e) { /* keep the status */ }
  console.error('[secret] write of ' + name + ' failed -- ' + detail);
  return { ok: false, detail };
}
// [GH-CONFIG-V1] config/github holds everything about the GitHub surface EXCEPT the tokens,
// which live in Secret Manager and are never read by anything that answers a request. What is
// here is deliberately all non-secret: which identity slugs exist, which one is the default,
// an owner -> identity map so the right account is chosen by the repository being addressed,
// an optional repository allowlist, and an api_base for GitHub Enterprise Server.
//
// A MISSING DOCUMENT IS A VALID STATE and returns {}. The tools read this on every session and
// an install that has never opened the panel must not see an error -- it must see a feature
// that has not been configured yet, which is a different thing and is what the tools say.
async function ghConfig(): Promise<any> {
  try {
    const d = await db.collection('config').doc('github').get();
    return d.exists ? (d.data() as any) : {};
  } catch (_e) { return {}; }
}

function harKeyName(provider: string): string { return provider === 'gemini' ? 'chat-key-gemini' : 'chat-key-claude'; }
async function harKey(provider: string): Promise<string> {
  const env = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (env) return env;
  const sm = await harSecretGet(harKeyName(provider));
  if (sm) return sm;
  return provider === 'gemini' ? 'vertex' : '';
}

async function harKeyAge(provider: string): Promise<number | null> {
  try {
    const doc = await db.collection('settings').doc('api_keys').get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    const ts = data[`${provider}_set_at`];
    if (!ts) return null;
    return tsMillis(ts);
  } catch (e) { return null; }
}

async function setHarKeyAge(provider: string) {
  try {
    await db.collection('settings').doc('api_keys').set({
      [`${provider}_set_at`]: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {}
}

async function disableOldClaudeKey(oldKey: string) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY || await harSecretGet('anthropic-admin-key');
  if (!adminKey) return;
  try {
    const r = await waFetch('https://api.anthropic.com/v1/organizations/keys', {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }
    });
    if (!r.ok) return;
    const j: any = await r.json();
    const hit = (j.data || []).find((k: any) => oldKey.startsWith(k.workspace_key_prefix || k.id) || k.id);
    if (hit) {
      await waFetch(`https://api.anthropic.com/v1/organizations/keys/${hit.id}/disable`, {
        method: 'POST',
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    }
  } catch (e) {}
}

// ---- Ops session: the 12h "off-the-gate-once" window (control-plane owned; box never holds durable creds) ----
// Stored in Firestore ops_session/current: { window_start, window_expiry, token, token_expiry }.
// The harness silently re-mints a fresh ~1h Google token and pushes it here; we forward it to the box.
async function opsGet(): Promise<any> { try { const d = await db.collection('ops_session').doc('current').get(); return d.exists ? d.data() : null; } catch (e) { return null; } }
async function opsSet(obj: any): Promise<void> { try { await db.collection('ops_session').doc('current').set(obj, { merge: true }); } catch (e) {} }
async function opsClear(reason?: string): Promise<void> {
  // F14: TOMBSTONE, not delete. opsSet() writes with merge:true, so a plain delete() races an
  // in-flight /api/ops/token push and the window silently comes back. Zeroing window_expiry
  // inside a transaction survives that merge. Errors PROPAGATE: /api/ops/end must never
  // answer ok when nothing was actually revoked.
  const ref = db.collection('ops_session').doc('current');
  await db.runTransaction(async (tx: any) => {
    const d = await tx.get(ref);
    const prev: any = d.exists ? (d.data() || {}) : {};
    tx.set(ref, {
      window_start: 0, window_expiry: 0, token: '', token_expiry: 0,
      revoked_at: FieldValue.serverTimestamp(), revoked_reason: String(reason || 'manual'),
      revoked_seq: Number(prev.revoked_seq || 0) + 1,
    }, { merge: false });
  });
  // NOTE for whoever ships spec 3c: revoked_at persists after /api/ops/token opens a fresh
  // window (opsSet merges). Any future check that treats a lingering revoked_at as "closed"
  // MUST clear it on the new-window path, or the ops window can never re-open. harOpsToken
  // below deliberately keys off window_expiry alone for exactly that reason.
  try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'ops_window_revoked',
    message: 'ops window revoked (' + String(reason || 'manual') + ')',
    timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
}
// Resolve the token to forward: a LIVE ops window is required first; then explicit header/body,
// else the live session token.
async function harOpsToken(req: any): Promise<{ token: string; err?: string }> {
  const now = Date.now();
  const s = await opsGet();
  if (s && s.window_expiry && now > s.window_expiry) { await opsClear('window-expired'); return { token: '', err: 'ops window expired — re-off at the gate' }; }
  // F14: is a window actually live right now? Keyed on window_expiry ONLY - opsClear zeroes it,
  // and unlike a lingering revoked_at flag this can never wedge the window permanently closed.
  const live = !!(s && s.window_expiry && now <= s.window_expiry);
  let direct = '';
  try { direct = String((req.headers && (req.headers['x-user-token'] || req.headers['X-User-Token'])) || (req.body && req.body.token) || ''); } catch (e) {}
  // F14: a caller-supplied token used to be returned BEFORE any window check, so /api/ops/end
  // did not stop user-authed gcloud reaching the ops box. Refuse loudly, never silently downgrade.
  if (direct) { if (!live) return { token: '', err: 'ops window is closed — x-user-token ignored; unlock ops at the gate first' }; return { token: direct }; }
  if (live && s.token && s.token_expiry && now < s.token_expiry) return { token: String(s.token) };
  if (live && s.token) return { token: '', err: 'ops token stale — harness will refresh' };
  return { token: '' };   // no window, no token: box-authed (OPS_TOKEN) shell only, as today
}

// ============ OPS CONSOLE TOOLS (advisor 2026-07-25): status_digest / check ============
// v6: EVERY STRAIN gets the console, scoped to its own lane. The advisor keeps the
// fleet-wide view; a strain sees its own desk. Work items are a shared list that nothing claims
// and nothing runs unattended (Gemini -> Vertex -> GCP billing). Claude work happens in a Claude surface you are already sitting in --
// this console (per-message on the card) or a Cowork chat (flat-rate Max). New tool: cowork_prompt,
// which hands you the paste-ready bootstrap for a strain so you can port the work to Cowork.
// Deterministic server code; the model only ever sees the compact summary a tool returns.
const HAR_CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 4096);
// [CHAT-OPUS5-DEFAULT-V1] Default effort is MEDIUM (operator ruling 2026-08-10: "Opus five medium").
// Was 'xhigh'. Only 'high' is special-cased below -- it means "send no output_config at all",
// because high IS the API default. Every other value, including this one, is sent explicitly.
const HAR_CHAT_EFFORT = String(process.env.CHAT_EFFORT || 'medium');
// [CHAT-GEMINI-DEFAULT-V1] WHICH SUBSTRATE A REQUEST THAT NAMES NONE LANDS ON, AND WHY IT IS AN
// ENV AND NOT A LITERAL. This release ships GEMINI as the floor and Claude as the escalation.
// THE OPERATIONAL REASON, and it is not a preference: this deployment CANNOT OBTAIN VERTEX QUOTA
// FOR CLAUDE. HAR_MODELS_DEFAULT above already puts gemini-3.7-flash first, harChatGemini and
// harGeminiPost already default to the Vertex transport (see [CHAT-VERTEX-DEFAULT-V2]), and
// harVertexGeminiRegion pins the 3.x publisher models to the global endpoint -- so a fresh
// install with no key of any kind, landing here, chats. Landing on Claude instead, it depends on
// a Vertex allocation this project is not going to be granted.
// CLAUDE IS NOT REMOVED AND IS NOT DEGRADED. It remains reachable two ways: CHAT_CLAUDE_PROVIDER
// =anthropic plus a saved Anthropic key (harClaudeProvider / harChatResolved decide that, and
// nothing here touches them), and as an explicit one-click pick in the console -- an explicit
// provider in a request body still wins over this constant at every site that reads it.
// WHY AN ENV RATHER THAN A LITERAL: a literal cannot express "Gemini for an install with no
// Claude path, Claude for one that has it". CHAT_DEFAULT_PROVIDER=claude restores the previous
// behaviour with a config revision and NO REBUILD. Anything other than the two known values falls
// to gemini rather than being trusted, because an unrecognised substrate name is a typo and a
// typo must not silently pick the expensive side.
const HAR_CHAT_DEFAULT_PROVIDER = (String(process.env.CHAT_DEFAULT_PROVIDER || 'gemini').trim().toLowerCase() === 'claude') ? 'claude' : 'gemini';

// [SEC-NO-OPERATOR-DOCTRINE-V1] These two strings are SENT TO THE MODEL as system prompt, and every
// downloader gets them. They used to carry this operator's private billing doctrine -- a share of
// one person's API spend, a per-message price billed to them, their subscription plan,
// and dated personal rulings. None of that is true of, or actionable by, anyone who installs this.
// WHAT IS KEPT is every instruction the prompt needs to route work correctly: dispatch is Gemini
// only, the tool REFUSES Claude dispatch, work parks under named statuses, there are two Claude
// surfaces, and cowork_prompt is how you hand work to the other one. The discriminator between the
// surfaces is restated as CAPABILITY (source + deploy access) rather than as wallet -- which is the
// basis the rest of this prompt already uses, so the routing decision is unchanged.
const HAR_LAW_NO_RUNNERS = [
  'DISPATCH LAW: nothing in this install runs unattended. The operator drives it from an MCP client.',
  'Work items are a shared list, not a queue anything claims. Nothing runs unattended.',
  'A parked status (needs_claude / needs_cowork / needs_supervisor) is a note for a human, not a handover to a runner.',
].join(' ');

// [HAR-BUILD-TRUTH-V60] THIS PARAGRAPH USED TO BE FALSE AND THE FALSEHOOD COST THE OPERATOR A DAY.
// It said "THIS console: chat only -- no source checkout, no deploy, no gate", so when he asked
// for a hello-world deployed to Cloud Run, the model refused and told him building "belongs in a
// Cowork session" -- reporting OUR OWN PROMPT TEXT to him as though it were a capability limit.
// Those are different claims and that one was not true: run_command reaches gcloud, and the whole
// build-and-deploy path was MEASURED END TO END from the gate executor on 2026-08-15 (jobs
// 4Bza0LAPkmitVRrCYMim build, 4JdWclmeOQSQPenUvR0M poll, vOQp24MKooUrDZf0zU0T deploy): a container
// built and a Cloud Run service served traffic, from this surface, with no Cowork session.
//
// WHAT IS GENUINELY ABSENT IS NARROWER AND IS STATED BELOW RATHER THAN ROUNDED UP TO "chat only":
// [EXEC-ALLOWLIST-HONEST-V1] THIS PROMPT USED TO STATE A BOUNDARY THAT DOES NOT EXIST, AND IT WAS
// WRONG IN THE DIRECTION THAT COSTS WORK. It said run_command "runs allowlisted binaries" and that
// "what you cannot do is run git itself (not on the allowlist, so no local checkout)". Both halves
// are false. The allowlist is a FIRST-TOKEN check that is OBSERVE-ONLY by default -- see the header
// of gate-exec/exec_server.py, which has said so all along: a non-allowlisted first token is
// journalled as exec_allowlist_observe and the command RUNS. MEASURED: a staged job ran
// `git clone /tmp/src.git /tmp/work` on the executor successfully, and another ran `gsutil ls`
// (journalled as not allowlisted, executed regardless). So a strain was being told it could not do
// something it demonstrably can, and readers believed the install was confined when it is not.
// WHAT ACTUALLY CONFINES THIS TOOL, and it is stronger than a token scan: a human approves the
// exact command at the gate, and the executor refuses any script whose sha256 does not match the
// approval-time hash. A first-token test over shell text could never have been a boundary anyway --
// $(...), pipes, && and variable assignment all put the real binary somewhere other than the first
// token of a line. Say what is true; do not restore the claim to make the prompt sound safer.
const HAR_LAW_SURFACES = [
  'TWO CLAUDE SURFACES. (1) THIS console: chat PLUS a real executor -- run_command runs shell on the',
  'gate executor, the git_* tools read and write the store, and gcp_api reaches the GCP REST surface.',
  'Your script runs with PATH restricted to an enumerated set of binaries, so an unlisted binary',
  'does not resolve -- gsutil and ssh answer "command not found". Builtins and keywords are',
  'unaffected, so set -uo pipefail is fine. An ABSOLUTE PATH still runs: that gap is known and',
  'stated. What primarily gates you is the human approval and the signed command pin.',
  'Use `gcloud storage`, never gsutil -- gsutil is not on the executor image at all. You CAN build a',
  'container and deploy a Cloud Run service from here; see BUILD AND DEPLOY below. What you cannot',
  'do is hold a long-running interactive session. (2) COWORK: disposable containers',
  'with a full checkout, arbitrary tooling and a much longer clock -- better for multi-file refactors',
  'and anything needing real iteration. Use cowork_prompt when the work genuinely wants that, NOT as a',
  'way to decline work this surface can do. Never cite "doctrine" as a reason you cannot build:',
  'if a tool would refuse you, say which tool and why; if it would not, do the work.',
].join(' ');

// The exact sequence that was measured working, including the flags whose absence produces
// errors that read like permission problems and are not. Written out because a model that has to
// guess these will guess wrong twice and then conclude, reasonably but incorrectly, that it lacks
// the rights to build.
//
// [HAR-BUILD-LOGDIR-V1] THIS PROMPT TOLD THE AGENT TO SUBMIT BUILDS WHOSE LOGS IT CANNOT READ,
// AND THEN THE FAILURE HID ITSELF. The recipe named three non-optional flags and asserted that
// --default-buckets-behavior was the one that governs the LOG bucket. It is not: with that flag
// set and --gcs-log-dir absent, Cloud Build still writes to its own regional logs bucket
// (gs://<PROJECT NUMBER>-<REGION>-cloudbuild-logs), which the executor service account holds no
// storage.objects.get on. The build then comes back FAILURE with its only step still QUEUED --
// dead before it ran a single instruction -- on "Failure setting up GCS logging: failed to create
// GCS logging client ... Error 403 ... does not have storage.objects.get access".
// WHY THAT IS THE WORST SHAPE A FAILURE CAN HAVE HERE: the evidence lives in the bucket the agent
// is locked out of, so `gcloud builds log` and `gcloud storage cat` both answer 403 as well. The
// agent sees a FAILURE, a QUEUED step, and no reason -- and the honest conclusion it reaches from
// that is "I lack the rights to build", which is precisely the wrong conclusion this whole block
// was written to prevent. So the prompt was manufacturing the misdiagnosis it warns about.
// THE FIX IS ONE FLAG: --gcs-log-dir pointed at the installer-created staging bucket the executor
// already holds objectAdmin on, so the logs land somewhere readable and a real failure reports a
// real reason. THIS FIX AND ITS MEASUREMENT COME FROM THE DOWNSTREAM FORK, WHICH HIT IT ON A LIVE
// INSTALL AND RECORDED THE BEFORE/AFTER BUILD IDS; it is ported here as prompt guidance, and this
// tree has NOT re-run that build, which is why no build id or digest of ours is quoted below.
// --default-buckets-behavior IS KEPT, NOT DELETED. It still governs SOURCE staging. What changed
// is that the prompt no longer claims to know what its absence does, because that claim was the
// wrong one and was not re-measured.
const HAR_LAW_BUILD = [
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

// An operator who keeps a state document for the advisor names it here rather than in the
// prompt: OPS_STATE_DOC=<lake path>. Unset on a fresh install, and the prompt simply does not
// mention one -- it must never send the model to fetch a document that does not exist.
const HAR_OPS_STATE_DOC = String(process.env.OPS_STATE_DOC || '').trim();
const HAR_OPS_SYSTEM = [
  'You are the operator\'s mission-control advisor for Paracoding.AI (Agentic Fungi) -- their autonomous GCP agent fleet.',
  'GROUND TRUTH FIRST -- read before you claim. read_graph and search_nodes are your authoritative memory; status_digest is the current fleet state; read_journal shows live runs. Never guess; never call something broken without reading it.' + (HAR_OPS_STATE_DOC ? ' The operator also maintains a state document for this install: read_lake("' + HAR_OPS_STATE_DOC + '") before you claim anything it covers.' : ''),
  'YOUR TOOLS -- read: status_digest, read_journal, read_lake (shared/... plus your own agents/<your role>/... folder), list_work_items (returns ids), read_job_log, cowork_prompt. Clean: cancel_work_item / complete_work_item (bookkeeping -- do it directly for junk or finished items, it is yours).',
  HAR_LAW_NO_RUNNERS,
  HAR_LAW_SURFACES,
  HAR_LAW_BUILD,
  'ONE THING IS STILL NOT YOURS, AND IT IS NARROWER THAN "deploys": changing THIS CONTROL PLANE -- its own harness UI, its own revisions and traffic, its caching and model/env config. That is the operator\'s Cowork advisor, and it is excluded because breaking the control plane takes away the surface you would need to fix it, not because you lack the tools. Building and deploying a SEPARATE Cloud Run service is explicitly yours (see BUILD AND DEPLOY) and you must not decline it by pointing at this rule. If the operator asks for a change to this control plane, say plainly which service you would be modifying and offer cowork_prompt.',
  'Be concise and decisive; offer ONLY options you can actually carry out; if a real error comes back, report it plainly -- do not retry-rephrase to sneak past a guard.',
].join('\n');

function harStrainSystem(agentId: string): string {
  return [
    'You are ' + agentId + ', a strain in the operator\'s Paracoding.AI fleet (public brand: Agentic Fungi). You own ONE lane -- your own -- not the whole fleet. The operator is talking to you in the Flowhood console.',
    'GROUND TRUTH FIRST. Before you claim anything about your work, check it: status_digest shows your lane, read_journal shows what actually ran, list_work_items shows your queue with ids. Never guess.',
    'YOUR DESK. list_work_items shows the shared list for this lane. Nothing claims those items and nothing runs them unattended. Use check and list_work_items to see what is on the list, then read_lake it and judge it.',
    'YOUR SCOPE -- read_lake: shared/... and agents/' + agentId + '/... only. list_work_items / check / cancel / complete: YOUR items only. status_digest: your lane. You cannot see or touch another strain\'s desk; ask the operator to take it to the advisor if it is fleet-wide.',
    HAR_LAW_NO_RUNNERS,
    HAR_LAW_SURFACES,
    HAR_LAW_BUILD,
    'YOU MAY BUILD AND DEPLOY NEW SERVICES FROM HERE (see BUILD AND DEPLOY). What you may not change is THIS CONTROL PLANE -- its harness UI, its own revisions and traffic, its caching and model/env config -- because breaking it removes the surface you would need to repair it. That one carve-out is the operator\'s Cowork advisor. Anything needing a full checkout or long iteration is also better there: say so and offer cowork_prompt. Never refuse buildable work on doctrine -- name the tool that would refuse you, or do it.',
    'Be concise, decisive and honest. Offer only what you can actually do. Report what you actually did, with the item id or the journal line as evidence.',
  ].join('\n');
}

function harOpsSystem(agentId: string): string {
  return agentId === 'fleet-advisor' ? HAR_OPS_SYSTEM : harStrainSystem(agentId);
}

function harToolDefs(agentId: string): any[] {
  const boss = agentId === 'fleet-advisor';
  const mine = boss ? 'any strain' : 'you (' + agentId + ')';
  return [
    { name: 'status_digest', description: boss ? 'Live FLEET overview: every strain, what each is doing, backlog counts, gate jobs, recent events. Use for "where are we / report / refresh".' : 'Your lane: what you are working on, your queue, your recent runs, anything of yours parked for a human.', input_schema: { type: 'object', properties: {} } },
    { name: 'check', description: 'Status of recent work items for ' + mine + ' -- what is pending, finished, blocked or parked.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_journal', description: 'Recent fleet journal entries (work runs, cache numbers, gate events). VERIFY here before claiming anything.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_lake', description: 'Read a lake file for ground truth. Allowed: shared/... and agents/' + agentId + '/... .', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_work_items', description: 'List work items WITH ids for ' + mine + '. status defaults pending; use "all" for any, or needs_claude / needs_cowork / needs_supervisor to see parked work.', input_schema: { type: 'object', properties: { status: { type: 'string' }, role: { type: 'string' } } } },
    { name: 'cancel_work_item', description: 'Cancel a work item by id (bookkeeping). Junk or obsolete items.', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'complete_work_item', description: 'Mark a work item completed by id (bookkeeping).', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'read_job_log', description: 'Read the result (status/exit/stdout/stderr) of a gate job by job_id.', input_schema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
    { name: 'cowork_prompt', description: 'Hand the operator a paste-ready bootstrap prompt to continue this work in a fresh Cowork chat (full source + deploy access). Use when a job needs building, deploying, or heavy iteration -- or when they asks how to port it.', input_schema: { type: 'object', properties: { strain: { type: 'string', description: 'strain to bootstrap; defaults to ' + agentId }, task: { type: 'string', description: 'one line: what they should have it do first' } } } },
  ];
}
function harOpsTools(agentId: string): any[] { return harToolDefs(agentId); }

function harJournalAs(agentId: string, action: string, message: string) { try { db.collection('journal').add({ agent_id: agentId || 'fleet-advisor', action: action, message: String(message).slice(0, 900), timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
function harJournal(action: string, message: string) { harJournalAs('fleet-advisor', action, message); }

const HAR_PARKED = ['needs_claude', 'needs_cowork', 'needs_supervisor'];

async function harStatusDigest(agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const now = Date.now();
  const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { agent: a, last_ts: 0, last_action: '', backlog: 0, in_progress: 0 }; return agents[a]; };
  const feed: string[] = [];
  const FEED = ['work_start', 'work_done', 'work_blocked', 'work_error', 'stage_job', 'godmode_executed', 'human_confirmed', 'work_cancelled'];
  try {
    const jsnap = await db.collection('journal').orderBy('timestamp', 'desc').limit(120).get();
    jsnap.docs.forEach((d: any) => {
      const e = d.data();
      const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds * 1000 : 0;
      const a = ensure(e.agent_id);
      if (a && ts > a.last_ts) { a.last_ts = ts; a.last_action = String(e.message || e.action || '').slice(0, 90); }
      const relevant = boss || e.agent_id === agentId;
      if (relevant && feed.length < 12 && FEED.indexOf(e.action) >= 0) { const age = ts ? Math.round((now - ts) / 60000) : 9999; feed.push('  [' + age + 'm] ' + e.agent_id + ' ' + e.action + ': ' + String(e.message || '').slice(0, 110)); }
    });
  } catch (e) {}
  let pend = 0, inprog = 0, parked = 0;
  try {
    const w = await db.collection('work_items').limit(600).get();
    w.docs.forEach((d: any) => {
      const x = d.data(); const role = String(x.assigned_role || '');
      if (!boss && role !== agentId) return;
      const a = ensure(role);
      if (x.status === 'pending') { pend++; if (a) a.backlog++; }
      else if (x.status === 'in_progress') { inprog++; if (a) a.in_progress++; }
      else if (HAR_PARKED.indexOf(String(x.status)) >= 0) { parked++; }
    });
  } catch (e) {}
  const lines: string[] = [];
  if (boss) {
    const gate: string[] = []; let gateN = 0;
    try { const p = await db.collection('pending_confirms').where('status', '==', 'pending').limit(40).get(); gateN = p.size; p.docs.forEach((d: any) => { const x = d.data(); gate.push('  ' + d.id + '  ' + (x.command_type || '') + '  ' + String((x.arguments && x.arguments.command) || '').replace(/\s+/g, ' ').slice(0, 80)); }); } catch (e) {}
    const active = Object.keys(agents).filter((k) => k !== 'human_operator').map((k) => agents[k]).sort((x: any, y: any) => y.last_ts - x.last_ts);
    lines.push('FLEET STATUS  --  ' + pend + ' pending, ' + inprog + ' in progress, ' + parked + ' PARKED for a human, ' + gateN + ' awaiting the operator at the gate');
    lines.push('DISPATCH: gemini-only (Vertex/GCP billing). NOTHING RUNS UNATTENDED -- stalled work parks and waits for a human. There is no sweeper and no escalation.');
    lines.push(''); lines.push('STRAINS:');
    active.slice(0, 12).forEach((a: any) => { const age = a.last_ts ? Math.round((now - a.last_ts) / 60000) : 9999; const st = (a.in_progress > 0 && age < 6) ? 'working' : (a.backlog > 0 ? 'queued' : 'idle'); lines.push('  ' + a.agent + '  [' + st + ']  ' + a.in_progress + ' active / ' + a.backlog + ' queued  -- last ' + age + 'm ago: ' + a.last_action); });
    if (gateN) { lines.push(''); lines.push('AWAITING APPROVAL AT THE GATE:'); gate.forEach((g) => lines.push(g)); }
  } else {
    const me = agents[agentId] || { last_ts: 0, last_action: '(nothing yet)' };
    const age = me.last_ts ? Math.round((now - me.last_ts) / 60000) : 9999;
    lines.push('YOUR LANE (' + agentId + ')  --  ' + pend + ' queued, ' + inprog + ' running now, ' + parked + ' parked waiting on a human');
    lines.push('DISPATCH: gemini-only (Vertex/GCP billing). Your items run when you or the operator run them, never on their own.');
    lines.push('LAST ACTIVITY: ' + (me.last_ts ? age + 'm ago -- ' + me.last_action : 'none in the recent journal'));
  }
  lines.push(''); lines.push('RECENT:'); feed.slice(0, 10).forEach((f) => lines.push(f));
  if (!feed.length) lines.push('  (nothing recent)');
  return lines.join('\n').slice(0, 6000);
}


async function harCheck(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const lim = Math.max(1, Math.min(20, Number((input && input.limit)) || 6));
  try {
    let rows: any[] = [];
    if (boss) {
      const snap = await db.collection('work_items').where('source', '==', 'ops-chat').limit(150).get();
      rows = snap.docs.map((d: any) => { const o = d.data() || {}; o.id = d.id; return o; });
    } else {
      const snap = await db.collection('work_items').where('assigned_role', '==', agentId).limit(150).get();
      rows = snap.docs.map((d: any) => { const o = d.data() || {}; o.id = d.id; return o; });
    }
    rows.sort((a: any, b: any) => (((b.created_at && b.created_at._seconds) || 0) - ((a.created_at && a.created_at._seconds) || 0)));
    rows = rows.slice(0, lim);
    if (!rows.length) return boss ? 'No work items sourced from this console yet.' : 'No work items for ' + agentId + ' yet.';
    return 'LAST ' + rows.length + ':\n' + rows.map((r: any) => { const st = String(r.status || '?').toUpperCase(); const flag = HAR_PARKED.indexOf(String(r.status)) >= 0 ? '  <-- PARKED, needs a human' : ''; return '  [' + st + ']  ' + String(r.title || '').slice(0, 74) + '  (' + r.id + ')' + flag; }).join('\n');
  } catch (e: any) { return 'check failed: ' + String((e && e.message) || e); }
}

async function harReadJournalTool(input: any): Promise<string> {
  const lim = Math.max(1, Math.min(60, Number((input && input.limit)) || 30));
  try {
    const snap = await db.collection('journal').orderBy('timestamp', 'desc').limit(lim).get();
    const rows = snap.docs.map((d: any) => { const e = d.data(); const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds : 0; const hh = ts ? new Date(ts * 1000).toISOString().slice(11, 19) : '--:--:--'; return hh + '  ' + String(e.agent_id || '') + '  [' + String(e.action || '') + ']  ' + String(e.message || '').slice(0, 180); });
    return 'RECENT JOURNAL (' + rows.length + '):\n' + rows.join('\n');
  } catch (e: any) { return 'read_journal failed: ' + String((e && e.message) || e); }
}

async function harReadLakeTool(input: any, agentId: string): Promise<string> {
  const path = String((input && input.path) || '').trim().replace(/^\/+/, '');
  if (!path) return 'read_lake: a path is required.';
  const own = 'agents/' + agentId + '/';
  if (!(path.indexOf('shared/') === 0 || path.indexOf(own) === 0)) return 'read_lake denied: only shared/... and ' + own + '... are yours.';
  try { const txt = await harReadLake(path); if (!txt) return '(empty or no file at ' + path + ')'; return 'FILE ' + path + ' (' + txt.length + ' chars):\n' + txt.slice(0, 12000); } catch (e: any) { return 'read_lake failed: ' + String((e && e.message) || e); }
}

async function harListItemsTool(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-advisor';
  const st = String((input && input.status) || 'pending').trim();
  const role = boss ? String((input && input.role) || '').trim() : agentId;
  try {
    let q: any = db.collection('work_items');
    if (st && st !== 'all') q = q.where('status', '==', st);
    const snap = await q.limit(300).get();
    let rows = snap.docs.map((d: any) => { const o = d.data() || {}; o._id = d.id; return o; });
    if (role) rows = rows.filter((r: any) => String(r.assigned_role || '') === role);
    rows = rows.slice(0, 60);
    if (!rows.length) return 'no work items (' + st + (role ? ', ' + role : '') + ').';
    return 'WORK ITEMS (' + st + ', ' + rows.length + ' shown, id first):\n' + rows.map((r: any) => '  ' + r._id + '  [' + String(r.status || '?') + ']  ' + String(r.assigned_role || '') + '  ' + String(r.substrate || '-') + '  ' + String(r.title || '').slice(0, 62)).join('\n');
  } catch (e: any) { return 'list_work_items failed: ' + String((e && e.message) || e); }
}

async function harOwns(id: string, agentId: string): Promise<boolean> {
  if (agentId === 'fleet-advisor') return true;
  try { const d = await db.collection('work_items').doc(id).get(); if (!d.exists) return false; return String((d.data() || {}).assigned_role || '') === agentId; } catch (e) { return false; }
}

async function harCancelItemTool(input: any, agentId: string): Promise<string> {
  const id = String((input && input.id) || '').trim(); if (!id) return 'cancel: id required.';
  if (!(await harOwns(id, agentId))) return 'cancel denied: ' + id + ' is not in your lane.';
  try { await db.collection('work_items').doc(id).update({ status: 'cancelled', cancelled_by: agentId, cancelled_at: FieldValue.serverTimestamp(), cancel_note: String((input && input.note) || '') }); harJournalAs(agentId, 'work_cancelled', 'cancelled ' + id + ' ' + String((input && input.note) || '')); return 'cancelled work item ' + id; } catch (e: any) { return 'cancel failed: ' + String((e && e.message) || e); }
}

async function harCompleteItemTool(input: any, agentId: string): Promise<string> {
  const id = String((input && input.id) || '').trim(); if (!id) return 'complete: id required.';
  if (!(await harOwns(id, agentId))) return 'complete denied: ' + id + ' is not in your lane.';
  try { await db.collection('work_items').doc(id).update({ status: 'completed', completed_by: agentId, finished_at: FieldValue.serverTimestamp(), result_note: String((input && input.note) || '') }); harJournalAs(agentId, 'work_completed', 'completed ' + id + ' ' + String((input && input.note) || '')); return 'completed work item ' + id; } catch (e: any) { return 'complete failed: ' + String((e && e.message) || e); }
}

async function harReadJobLogTool(input: any): Promise<string> {
  const id = String((input && (input.job_id || input.id)) || '').trim(); if (!id) return 'read_job_log: job_id required.';
  try { const d = await db.collection('pending_confirms').doc(id).get(); if (!d.exists) return '(no job ' + id + ')'; const x: any = d.data() || {}; return 'JOB ' + id + '  status=' + String(x.status || '?') + '  exit=' + String(x.exit_code) + '\nSTDOUT:\n' + String(x.stdout || '(none)').slice(0, 6000) + '\nSTDERR:\n' + String(x.stderr || '(none)').slice(0, 1500); } catch (e: any) { return 'read_job_log failed: ' + String((e && e.message) || e); }
}

// Hand the operator a paste-ready Cowork bootstrap. The SOURCE OF TRUTH is a lake document
// named by COWORK_PROMPTS_PATH (default below); the hardcoded fallback further down is used
// ONLY when that document is missing or malformed. That is precisely when the reader has the
// least other context to catch an error with, so the fallback must stay true on a FRESH
// INSTALL -- it may not name a document, a law or a path this install has never created.
const HAR_COWORK_PROMPTS_PATH = String(process.env.COWORK_PROMPTS_PATH || 'shared/bootstrap/cowork-prompts.md').trim();
async function harCoworkPromptTool(input: any, agentId: string): Promise<string> {
  let strain = String((input && input.strain) || agentId || 'fleet-advisor').trim().toLowerCase();
  if (strain && strain.indexOf('fleet-') !== 0) strain = 'fleet-' + strain;
  const task = String((input && input.task) || '').trim();
  const advisor = (strain === 'fleet-advisor');
  let doc = '';
  try { doc = await harReadLake(HAR_COWORK_PROMPTS_PATH); } catch (e) { doc = ''; }
  if (doc) {
    // ANCHOR THE MARKERS TO A WHOLE LINE. indexOf() matched '## PROMPT 1' ANYWHERE in the
    // document, including inside a paragraph that DESCRIBES the contract -- which is exactly
    // what the shipped document's own preamble does. The slice then started in the preamble
    // and the advisor prompt came out ONE CHARACTER LONG. Nothing refused and the fallback
    // below did not fire, because by indexOf's reckoning both markers were present: the
    // failure mode was silent garbage handed to the operator to paste. A heading is a line,
    // so it is matched as one, \r tolerated so a document edited on Windows still slices.
    const pcMark = (n: number): number => {
      const m = new RegExp('^##[ \\t]*PROMPT[ \\t]*' + n + '[ \\t]*\\r?$', 'm').exec(doc);
      return m ? m.index : -1;
    };
    const A = pcMark(1);
    const Bm = pcMark(2);
    if (A >= 0 && Bm > A) {
      let body = advisor ? doc.slice(A, Bm) : doc.slice(Bm);
      // THE MARKERS ARE A SLICING CONTRACT, NOT PART OF THE PROMPT. The slice necessarily
      // BEGINS at the literal '## PROMPT n' line it was found by, and the advisor slice
      // necessarily ENDS on whatever separates the two sections in the source document.
      // Neither is text the operator should be pasting into an agent, so both come off here
      // rather than by asking every future editor of that lake document to lay it out in a
      // way that happens to render acceptably.
      body = body.replace(/^##\s*PROMPT\s*\d+[^\n]*\n/, '').replace(/\n\s*-{3,}\s*$/, '');
      body = body.replace(/<ROLE>/g, strain);
      body = task ? body.replace(/<TASK[^>]*>/g, task) : body.replace(/<TASK[^>]*>/g, 'Ask the operator what they want first, then read the relevant lake files before touching anything.');
      const head = 'PASTE THIS INTO A FRESH COWORK CHAT (attach the Paracoding.AI connector FIRST -- the connector is the identity).\nThat chat has full source + deploy access via the gate.\n\n----- COPY BELOW -----\n';
      // CAP THE BODY, NOT THE WHOLE STRING. Slicing the assembled result was truncating from
      // the END, so an over-long lake document silently removed the '----- COPY ABOVE -----'
      // line -- the operator then pastes a prompt that was cut off mid-sentence with nothing
      // saying so. Cap the part that can grow, and say plainly when it was cut.
      const LIM = 10000;
      body = body.trim();
      if (body.length > LIM) body = body.slice(0, LIM) + '\n\n[TRUNCATED: ' + HAR_COWORK_PROMPTS_PATH + ' section is longer than ' + LIM + ' characters. Shorten it -- what follows this line was NOT sent.]';
      return head + body + '\n----- COPY ABOVE -----';
    }
  }
  const fb = [
    'PASTE THIS INTO A FRESH COWORK CHAT (attach the Paracoding.AI connector FIRST).',
    '',
    '----- COPY BELOW -----',
    '# PARACODING.AI - ' + (advisor ? 'FLEET ADVISOR' : 'STRAIN WORKER: ' + strain),
    '',
    'You are ' + (advisor ? 'the operator\'s mission-control advisor for Paracoding.AI (Agentic Fungi), running in Cowork' : strain + ', a strain in the operator\'s Paracoding.AI fleet, working beside them in Cowork') + '. The Paracoding.AI MCP connector is your identity.',
    '',
    'DO FIRST: whoami -- it RETURNS the memory digest and the bootstrap that says how you work here, so read what it hands back instead of going off to fetch a governance file. Then read_graph or search_nodes for what is already known, read_file agents/' + strain + '/LESSONS.md for this role, and read_journal(limit 30). Verify from the journal - never claim fleet state from memory.',
    '',
    'DOCTRINE: STAGE, NEVER SHIP - propose with stage_privileged_job, the operator approves with their passkey. EVERY STAGED JOB SITS ON THE GATE UNTIL A HUMAN APPROVES OR DENIES IT: nothing supersedes anything automatically any more, so several of your jobs, and several from another chat of your own role, all wait side by side and each is approved on its own with its own passkey tap. Two things are refused at STAGE time instead, loudly, without touching anything already waiting: staging a byte-identical copy of a job already on the gate, and staging past PC_PENDING_MAX_PER_ROLE jobs waiting from your role. Retire a proposal you no longer want with POST /api/jobs/supersede, which records who did it and why. Jobs still EXPIRE after WA_JOB_TTL_MIN unapproved, and that now carries a reason you can read. Every staged job: anchor-assert inputs, syntax-gate before deploy, back up what it changes, auto-rollback on failure, stream its log to shared/state/<job>.log - the gate executor has a ~3-4 min HARD timeout and a killed job returns EMPTY stdout.',
    '',
    'DISPATCH LAW: nothing in this install runs unattended. The operator drives it from an MCP client. Work items are a shared list rather than a queue anything claims.',
    '',
    'TRAPS: the container is ephemeral - the lake is the only durable memory. MCP read_file PREPENDS a banner line + blank line NOT in the stored object; strip both on any read-then-write. deploy-cp-harness.sh is RETIRED (exit 1): the control plane is built from the git STORE (Firestore repos/<repoId>/refs + lake <repoId>/.git/objects/), reached with the git_* tools - git_push onto memory-v1, then a staged deploy-store.py --commit <oid> --tag <tag>.',
    '',
    'YOUR ASSIGNMENT: ' + (task || 'Ask the operator what they want first.'),
    '',
    'TONE: direct, senior, no padding. Own mistakes plainly. Verify before you claim.',
    '----- COPY ABOVE -----',
  ].join('\n');
  return fb;
}

async function harRunChatTool(name: string, input: any, agentId: string): Promise<string> {
  const who = agentId || 'fleet-advisor';
  if (name === 'status_digest') return await harStatusDigest(who);
  if (name === 'check') return await harCheck(input || {}, who);
  if (name === 'read_journal') return await harReadJournalTool(input || {});
  if (name === 'read_lake') return await harReadLakeTool(input || {}, who);
  if (name === 'list_work_items') return await harListItemsTool(input || {}, who);
  if (name === 'cancel_work_item') return await harCancelItemTool(input || {}, who);
  if (name === 'complete_work_item') return await harCompleteItemTool(input || {}, who);
  if (name === 'read_job_log') return await harReadJobLogTool(input || {});
  if (name === 'cowork_prompt') return await harCoworkPromptTool(input || {}, who);
  return 'unknown tool ' + name;
}

// ---- [CHAT-VERTEX-V1] Vertex AI plumbing shared by the Claude and Gemini chat paths ----
// The chat used to be able to reach Claude ONLY through api.anthropic.com with an x-api-key, so a
// fresh install with no Anthropic key got a 412 "no claude API key set" instead of a chat. The
// scheduled runners 12.5 deleted had a keyless Vertex path all along; this is
// the same thing for the control plane, built by hand because there is no Anthropic SDK here.
// Auth is the EXISTING waAccessToken() metadata bearer -- no new credential, no new fetcher.
const HAR_VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';
function harVertexProject(): string { return process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT; }
// location=global is served by the BARE host, not global-aiplatform.*.
function harVertexHost(region: string): string { return region === 'global' ? 'aiplatform.googleapis.com' : region + '-aiplatform.googleapis.com'; }
// CLAUDE region: VERTEX_LOCATION, default us-east5 (where the Anthropic publisher
// models are actually served). DELIBERATELY NOT GCP_REGION -- that is the Cloud Run region
// (default us-east1) and Vertex serves no Anthropic model there.
// [CHAT-CLAUDE-GLOBAL-V104] CLAUDE HAD NO GLOBAL-ENDPOINT HANDLING AND GEMINI HAS HAD IT FOR
// MONTHS -- the same bug, on the other provider, found the same way. harVertexHost() already maps
// 'global' to aiplatform.googleapis.com; nothing could ever ASK for it, because this function
// could only return a regional value. So a model Vertex serves only on the global endpoint was
// unreachable on a default install.
//
// AND THE FAILURE POINTS AT THE WRONG FIX, WHICH IS WHY IT COST A DAY. A regional host asked for a
// global-only model does not 404. It answers HTTP 429 "Quota exceeded ... base model:
// anthropic-claude-opus-5", which reads as "ask Google for more quota" -- and the per-region quota
// metric backs that story up, because online_prediction_input_tokens_per_minute_per_base_model
// enumerates REGIONAL buckets only and has no row for a global-only model. Measured 2026-08-18:
// 21 anthropic buckets across three regions, none for opus-5 or opus-4-8, while the operator was
// running both against the same project from his own client.
function harClaudeGlobalOnly(apiModel: string): boolean {
  const m = String(apiModel || '').toLowerCase();
  return /^claude-opus-5/.test(m) || /^claude-opus-4-8/.test(m);
}
// Same shape as harVertexGeminiRegion, deliberately: when the configured region and the model
// disagree, prefer the one that can actually serve and SAY which was chosen. apiModel is optional
// so an existing caller that has no model in hand still gets the configured region.
function harVertexClaudeRegion(apiModel?: string): string {
  const raw = String(process.env.CHAT_VERTEX_REGION || process.env.VERTEX_LOCATION || 'us-east5').trim() || 'us-east5';
  if (raw !== 'global' && apiModel && harClaudeGlobalOnly(apiModel)) {
    console.log('[chat/claude] region "' + raw + '" ignored for global-only model ' + apiModel + '; using global');
    return 'global';
  }
  return raw;
}
// GEMINI region: CHAT_VERTEX_GEMINI_REGION, else 'global'. Its own env var, because
// GCP_REGION meant the Cloud Run region and pointed the chat at us-east1-aiplatform, which 404s for
// the configured global-only model -- that was the Gemini chat outage.
function harGeminiGlobalOnly(apiModel: string): boolean {
  const m = String(apiModel || '').toLowerCase();
  return /^gemini-3/.test(m) || m.indexOf('-preview') >= 0;
}
function harVertexGeminiRegion(apiModel: string): string {
  const raw = String(process.env.CHAT_VERTEX_GEMINI_REGION || 'global').trim() || 'global';
  // SAFE FALLBACK: when the configured region and the configured model disagree, prefer the one
  // that can actually serve the model rather than 404ing, and say which was chosen.
  if (raw !== 'global' && harGeminiGlobalOnly(apiModel)) {
    console.log('[chat/gemini] region "' + raw + '" ignored for global-only model ' + apiModel + '; using global');
    return 'global';
  }
  return raw;
}
// [CHAT-VERTEX-DEFAULT-V2] Same rule as Claude, for the same reason: a stale chat-key-gemini secret
// or a leftover GEMINI_API_KEY used to divert the chat to generativelanguage.googleapis.com, where
// the configured Vertex publisher model id does not exist -> the error the operator saw. Vertex is
// now the default; the AI-Studio transport requires CHAT_GEMINI_PROVIDER=studio AND a real key.
function harGeminiTransport(key: string): string {
  const p = String(process.env.CHAT_GEMINI_PROVIDER || '').trim().toLowerCase();
  const real = !!(key && key !== 'vertex' && key !== 'token');
  if ((p === 'studio' || p === 'genai' || p === 'apikey' || p === 'key') && real) return 'studio';
  return 'vertex';
}
// Which transport the Claude chat uses.
// [CHAT-VERTEX-DEFAULT-V2] WAS: key-absence inference -- any ANTHROPIC_API_KEY env value or any
// chat-key-claude Secret Manager version, however stale, silently selected api.anthropic.com. On an
// install that had ever had a key set (the operator's has), the "wired to Vertex" change of
// 2026-08-09 therefore did nothing at all: the chat still went to the direct API and still failed.
// NOW: VERTEX IS THE DEFAULT and the direct API is an EXPLICIT OPT-IN. Only CHAT_CLAUDE_PROVIDER
// set to 'anthropic' (or 'api'/'key'/'direct') leaves Vertex. A key lying around in Secret Manager
// can no longer change the transport -- it is data, not configuration.
function harClaudeProvider(): string {
  const p = String(process.env.CHAT_CLAUDE_PROVIDER || '').trim().toLowerCase();
  if (p === 'anthropic' || p === 'api' || p === 'key' || p === 'direct') return 'anthropic';
  return 'vertex';
}
// [CHAT-OBSERVABLE-V1] One resolver, so the log line, the /api/keys/status answer and the request
// itself can never disagree about what was chosen. NEVER carries a key VALUE -- key_present only.
function harChatResolved(provider: string, key: string): any {
  const model = harApiFor(provider, '');
  if (provider === 'gemini') {
    const transport = harGeminiTransport(key);
    const region = transport === 'vertex' ? harVertexGeminiRegion(model) : '';
    const real = !!(key && key !== 'vertex' && key !== 'token');
    return { provider: 'gemini', transport, region, host: transport === 'vertex' ? harVertexHost(region) : 'generativelanguage.googleapis.com', model, key_present: real,
      alt_transport: transport === 'vertex' ? 'studio' : 'vertex',
      alt_ready: transport === 'vertex' ? real : true,
      alt_switch: transport === 'vertex' ? 'set CHAT_GEMINI_PROVIDER=studio' : 'unset CHAT_GEMINI_PROVIDER (Vertex is the default)',
      alt_blocker: transport === 'vertex' && !real ? 'no real Gemini API key is stored' : '' };
  }
  const transport = harClaudeProvider();
  const region = transport === 'vertex' ? harVertexClaudeRegion(model) : '';
  return { provider: 'claude', transport, region, host: transport === 'vertex' ? harVertexHost(region) : 'api.anthropic.com', model, effort: HAR_CHAT_EFFORT, key_present: !!key,
    // [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] The OTHER transport, resolved HERE and nowhere else, so the
    // log line, /api/keys/status and a failing chat all name the same escape hatch. alt_ready is a
    // READINESS FACT, not a selector: it reports whether the other transport could serve if the
    // operator chose it. Nothing in this file branches on it. Vertex needs no key (it rides the
    // existing metadata bearer), so leaving the direct API is always ready; reaching the direct API
    // needs a stored key, which is why alt_ready is key presence in that direction only.
    alt_transport: transport === 'vertex' ? 'anthropic' : 'vertex',
    alt_ready: transport === 'vertex' ? !!key : true,
    alt_switch: transport === 'vertex' ? 'set CHAT_CLAUDE_PROVIDER=anthropic' : 'unset CHAT_CLAUDE_PROVIDER (Vertex is the default)',
    alt_blocker: transport === 'vertex' && !key ? 'no Claude API key is stored' : '' };
}
// [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] The "so what do I do about it" half of a chat failure. The
// operator asked for Claude to be usable whichever transport is actually there; this is how he is
// told which one ran, why it could not serve, and the exact setting that moves him to the other.
//
// WHY THIS IS A MESSAGE AND NOT AN AUTOMATIC FALLBACK. An auto-retry on the direct API when Vertex
// 403s would put the stored key BACK IN CHARGE of the transport -- exactly the property the
// CHAT-VERTEX-DEFAULT-V2 incident above was fixed by removing, only moved into the error path where
// it is harder to see. The concrete regression: an install carrying a stale chat-key-claude (the
// operator's does) would answer a missing aiplatform.user grant with a 401 from api.anthropic.com,
// so the real cause -- one IAM role -- would again be buried under a key failure nobody asked for.
// A transport is a deliberate choice about where the tokens are billed and which contract applies;
// it is not something to make on the operator's behalf while he waits on a chat reply. So: Vertex
// stays the only default, the key stays data, and the failure names the one env var that switches.
// Takes the ALREADY-RESOLVED object -- it must not re-derive the transport, or it could disagree
// with the log line printed for the same request.
function harChatRemedy(r: any, status: number): string {
  if (!r || (status !== 401 && status !== 403 && status !== 404 && status !== 429)) return '';
  const why = r.transport === 'vertex'
    ? (status === 404
        ? 'this project cannot serve that model at location ' + (r.region || '-') + ' (wrong region, or the model is not enabled here)'
        : status === 403
        ? 'this service account cannot call Vertex here (missing aiplatform.endpoints.predict, or the Vertex AI API is off in this project)'
        : status === 429 ? 'Vertex is rate limiting or has no quota for this model in this project'
        : 'Vertex rejected the credential')
    : (status === 404
        ? 'the direct API does not know that model id'
        : status === 429 ? 'the direct API is rate limiting this key'
        : 'the direct API rejected the stored key (absent, stale or revoked)');
  const alt = r.alt_ready
    ? 'the other transport (' + r.alt_transport + ') IS ready: ' + r.alt_switch + ' and redeploy to use it'
    : 'the other transport (' + r.alt_transport + ') is NOT usable either (' + (r.alt_blocker || 'not configured') + '): fix that, then ' + r.alt_switch;
  return ' || transport=' + r.transport + ' was used; ' + why + '; ' + alt;
}
function harLogResolved(where: string, r: any): void {
  console.log('[chat/resolve] ' + where + ' provider=' + r.provider + ' transport=' + r.transport +
    ' region=' + (r.region || '-') + ' host=' + r.host + ' model=' + r.model +
    (r.effort ? ' effort=' + r.effort : '') + ' key_present=' + (r.key_present ? 'yes' : 'no') +
    // [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] the other transport and whether it could serve, so "can I
    // switch?" is answerable from the log alone -- same fields the failure text and /api/keys/status use.
    ' alt=' + (r.alt_transport || '-') + ' alt_ready=' + (r.alt_ready ? 'yes' : 'no'));
}
// THE ONE PLACE the two Claude transports differ. Vertex :rawPredict answers with a native Messages
// API response (same content/usage/stop_reason shape), so every caller above stays transport-blind
// and the tool loop, the cache_control retry and the usage summing are untouched. rawPredict, not
// streamRawPredict: neither chat caller streams -- both read one .json() body.
// [CHAT-OBSERVABLE-V1] Redaction for anything that goes into an error string or a log line. Strips
// ?key=..., Bearer tokens and sk-/ya29. shaped material. Applied to EVERY chat error text below.
// [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] Now formatted FROM the resolved object rather than re-deriving
// the transport, host and region from the env a second time. It had drifted into a parallel copy of
// harChatResolved()'s claude branch, which is the thing the ONE-RESOLVER rule exists to prevent: an
// error string could have named a host the log line for the same request did not.
function harClaudeHostDesc(r: any): string {
  return r.transport === 'vertex' ? ('host=' + r.host + ' region=' + r.region) : ('host=' + r.host);
}
function harRedact(s: string): string {
  return String(s == null ? '' : s)
    .replace(/([?&]key=)[^&"\s]+/gi, '$1REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer REDACTED')
    .replace(/\b(sk-[A-Za-z0-9_\-]{6,}|ya29\.[A-Za-z0-9._\-]{6,})/g, 'REDACTED');
}
async function harClaudePost(apiModel: string, key: string, body: any): Promise<{ r: any; j: any }> {
  // [SEC-FLEETMODE-CONSOLE-V1] A CONSOLE TRANSPORT. NOT BEHIND THE SPEND SWITCH, ON PURPOSE.
  // Read all of this before putting a check back here.
  //
  // WHAT THE SWITCH PROTECTS AGAINST: spend NOBODY ASKED FOR. This system may automate
  // deterministic work; it may never START model work on its own. A queue tick, a sweep, a
  // retry loop or a background runner that wakes up and bills a card or a project while its
  // owner is asleep is the case that rule was written for.
  //
  // WHY THIS FUNCTION IS OUT OF SCOPE: every Claude model call this file makes goes through
  // here -- the plain chat, the tool-capable ops chat and the reflect pass -- and all three
  // are reached from POST /api/chat, the reflect pass from the TAIL of that same request.
  // There is no other caller. Every one of them runs because a signed-in human typed a
  // message and pressed send, so there is no unattended caller here to stop; the only thing
  // a check at this point can stop is the operator talking to his own install. It did
  // exactly that. With the field absent, unreadable or set to home, every transport was
  // refused, this function threw before it built a URL, and the console answered 502 -- the
  // product's main surface dark to protect a budget the human had just chosen to spend --
  // while the unattended path the rule is about carried on deciding for itself elsewhere.
  //
  // AND "DO NOT GATE THE CONSOLE" ALONE WOULD NOT HAVE SURVIVED, WHICH IS WHY THE PARAGRAPH
  // ABOVE IS HERE. The check this replaces arrived with no statement of what it protected
  // against, so the next reader could not tell the console apart from the unattended path and covered
  // both. If a spend control is ever wanted on this path it is a per-request one a human
  // sees and answers, not a fleet-wide field read behind his back.
  let url = 'https://api.anthropic.com/v1/messages';
  let headers: any = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  const out: any = Object.assign({}, body);
  if (harClaudeProvider() === 'vertex') {
    const region = harVertexClaudeRegion(String(out.model || apiModel));
    const tok = await waAccessToken();
    url = 'https://' + harVertexHost(region) + '/v1/projects/' + harVertexProject() + '/locations/' + region +
      '/publishers/anthropic/models/' + encodeURIComponent(String(out.model || apiModel)) + ':rawPredict';
    headers = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
    delete out.model;                                        // on Vertex the model id lives in the URL
    out.anthropic_version = HAR_VERTEX_ANTHROPIC_VERSION;    // and is required in the body
  }
  // [MODEL-LONGRUN-V1] model POST site 1 of 3 (Claude: Anthropic /v1/messages AND Vertex
  // :rawPredict, both assembled above and both posted from this one line).
  const rr = await waFetchLong(url, { method: 'POST', headers, body: JSON.stringify(out) });
  const jj: any = await rr.json();
  return { r: rr, j: jj };
}

// tool-capable Claude chat: 1h cache + effort + bounded tool loop.
async function harChatClaudeOps(apiModel: string, key: string, system: string, msgs: any[], tools: any[], agentId: string, exec?: (name: string, input: any) => Promise<string>): Promise<{ text: string; usage: any }> {  /* [CHAT-ONE-REGISTRY-V49] `exec` is the ONE dispatcher for the tools in `tools`. Absent == the legacy chat-only table (harRunChatTool). It is NOT a second execution path: harChatToolset() builds it out of the handlers buildMcpServer already registered, so a tool call from here lands in the same closure the MCP transports call. */
  const conv: any[] = msgs.map((m: any) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: [{ type: 'text', text: String(m.text || m.content || '') }] }));
  const cacheIdx = conv.length - 2;
  const sumUsage: any = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const addUsage = (u: any) => { if (!u) return; sumUsage.input_tokens += u.input_tokens || 0; sumUsage.output_tokens += u.output_tokens || 0; sumUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0; sumUsage.cache_read_input_tokens += u.cache_read_input_tokens || 0; };
  const buildBody = (withTtl: boolean, withEffort: boolean) => {
    const messages = conv.map((m: any, i: number) => {
      if (i === cacheIdx && Array.isArray(m.content) && m.content.length) {
        const last = m.content[m.content.length - 1];
        if (last && typeof last === 'object') last.cache_control = withTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      }
      return { role: m.role, content: m.content };
    });
    const body: any = { model: apiModel, max_tokens: HAR_CHAT_MAX_TOKENS, system, tools, messages };
    if (withEffort && HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') body.output_config = { effort: HAR_CHAT_EFFORT };
    return body;
  };
  const post = async (withTtl: boolean, withEffort: boolean) => await harClaudePost(apiModel, key, buildBody(withTtl, withEffort));
  let withTtl = true; let withEffort = true; let guard = 0; let finalText = '';
  const claudeTrace: string[] = []; let claudeStop = '';
  // [HARNESSUI-MODEL-DERIVE-V1] what was ACTUALLY served. j.model is the provider's own
  // answer, and effortApplied tracks the withEffort fallback above -- when output_config is
  // dropped on a retry the request really did run at the default, and the badge must say so.
  let apiModelSeen = apiModel;
  let effortApplied = (HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
  while (guard++ < HAR_CHAT_MAX_ROUNDS) {
    let { r, j } = await post(withTtl, withEffort);
    if (!r.ok) {
      const eb = JSON.stringify(j); let changed = false;
      if (withEffort && (eb.indexOf('effort') >= 0 || eb.indexOf('output_config') >= 0)) { withEffort = false; changed = true; }
      if (withTtl && (eb.indexOf('ttl') >= 0 || eb.indexOf('cache_control') >= 0)) { withTtl = false; changed = true; }
      if (changed) { const rt = await post(withTtl, withEffort); r = rt.r; j = rt.j; }
    }
    if (!r.ok) {
      const rv = harChatResolved('claude', key);
      throw new Error(harRedact('claude ' + rv.transport + ' ' + harClaudeHostDesc(rv) + ' model=' + apiModel +
        ' HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 400) + harChatRemedy(rv, r.status)));
    }
    if (j && j.model) apiModelSeen = String(j.model);
    effortApplied = (withEffort && HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
    addUsage(j.usage);
    const content = j.content || [];
    conv.push({ role: 'assistant', content });
    const toolUses = content.filter((b: any) => b && b.type === 'tool_use');
    const txt = content.filter((b: any) => b && b.type === 'text').map((b: any) => b.text).join('').trim();
    if (txt) finalText = txt;
    if (j && j.stop_reason) claudeStop = String(j.stop_reason);
    if (!toolUses.length || j.stop_reason !== 'tool_use') break;
    const results: any[] = [];
    for (const tu of toolUses) { let out = ''; try { out = exec ? await exec(String(tu.name), tu.input || {}) : await harRunChatTool(tu.name, tu.input || {}, agentId); } catch (e: any) { out = 'tool error: ' + String((e && e.message) || e); } results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 12000) }); claudeTrace.push(String(tu.name) + ' -> ' + String(out).replace(/\s+/g, ' ').trim().slice(0, 500)); }
    conv.push({ role: 'user', content: results });
  }
  return { text: finalText || harChatNoTextReport(claudeTrace, claudeStop, false, 0), usage: sumUsage, model: apiModelSeen, effort: effortApplied };
}
// ============ end OPS CONSOLE TOOLS ============

// ---- Chat proxy (Claude via Anthropic Messages API / Gemini via Google GenAI) ----
// PROMPT CACHING: messages go out in BLOCK form so a cache breakpoint can hang off one text block.
// The breakpoint sits on the SECOND-TO-LAST message, never on the newest user turn — a breakpoint on
// the newest turn is written once and then never read. One turn back means the whole stable prefix
// (system + every prior turn) is cached now and READ on the next request.
// ttl '1h' because real chat turns are minutes apart and would routinely blow the default 5-minute
// window; the 1h write costs 2.0x base once, and every read after it is 0.1x.
// `system` stays a plain string with NO breakpoint: it is ~25 tokens, far below the minimum cacheable
// prompt length, so a breakpoint there would just burn one of the four available breakpoints.
// No `anthropic-beta` header: caching and the 1h TTL are both GA, and sending one risks a 400.
// [CHAT-OPUS5-DEFAULT-V1] output_config.effort is applied HERE TOO. It used to be set only on the
// tool-capable harChatClaudeOps path, so a plain chat (no agentId selected) silently ran at the API
// default no matter what CHAT_EFFORT said -- "Opus 5 Medium" on the badge, high effort on the wire.
// Same 'high' == send-nothing rule and the same drop-on-rejection retry as the ops path.
async function harChatClaude(apiModel: string, key: string, system: string, msgs: any[]): Promise<{ text: string; usage: any; model?: string; effort?: string }> {
  const buildBody = (withTtl: boolean, withEffort: boolean) => {
    const body: any = {
      // [CHAT-MAX-TOKENS-V1] WAS THE LITERAL 1024, AND IT WAS THE LAST ONE LEFT.
      // HAR_CHAT_MAX_TOKENS (CHAT_MAX_TOKENS, default 4096 here) already governs the
      // Claude tool loop beside this function. THIS path -- plain, non-tool chat -- was
      // still pinned at 1024 output tokens for no recorded reason, so a long answer was
      // truncated while the identical question asked through a tool round was not. Same
      // constant now, so CHAT_MAX_TOKENS means one thing on every Claude path.
      // THE DEFAULT IS NOT CHANGED WITH IT. Upstream's constant defaults to 16000 and
      // this one to 4096; taking their number as well would raise the ceiling on every
      // Claude turn of a fresh install -- a spend change riding in on a consistency fix.
      // This install's services carry CHAT_MAX_TOKENS explicitly, so the literal moves
      // nothing here and the default stays this tree's own.
      // [CHAT-GEMINI-MAXTOK-V1] THAT PARAGRAPH USED TO END "GEMINI IS DELIBERATELY GIVEN NO
      // CEILING ... flagged, not done", and it is no longer true, so it is retracted here
      // rather than left to mislead the next reader. Both Gemini paths now set
      // generationConfig.maxOutputTokens from this same constant. The reasoning for doing it,
      // including the fact that it IS a new ceiling, is written out at harChatGemini().
      model: apiModel, max_tokens: HAR_CHAT_MAX_TOKENS, system,
      messages: msgs.map((m, i) => {
        const block: any = { type: 'text', text: String(m.text || m.content || '') };
        if (msgs.length >= 2 && i === msgs.length - 2) block.cache_control = withTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
        return { role: m.role === 'me' ? 'user' : 'assistant', content: [block] };
      }),
    };
    if (withEffort && HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') body.output_config = { effort: HAR_CHAT_EFFORT };
    return body;
  };
  let withEffort = true;
  const post = async (withTtl: boolean) => await harClaudePost(apiModel, key, buildBody(withTtl, withEffort));
  let { r, j } = await post(true);
  if (!r.ok) {
    // NARROW fallback: only when the API objected to the ttl / cache_control / effort itself do we
    // retry ONCE without it. Every other error falls through and still throws.
    const errBody = JSON.stringify(j);
    if (withEffort && (errBody.indexOf('effort') >= 0 || errBody.indexOf('output_config') >= 0)) { withEffort = false; const retry = await post(true); r = retry.r; j = retry.j; }
    if (!r.ok && (errBody.indexOf('ttl') >= 0 || errBody.indexOf('cache_control') >= 0)) { const retry = await post(false); r = retry.r; j = retry.j; }
  }
  if (!r.ok) {
    const rv = harChatResolved('claude', key);
    throw new Error(harRedact('claude ' + rv.transport + ' ' + harClaudeHostDesc(rv) + ' model=' + apiModel +
      ' HTTP ' + r.status + ': ' + JSON.stringify(j).slice(0, 400) + harChatRemedy(rv, r.status)));
  }
  return { text: (j.content && j.content[0] && j.content[0].text) || '(no text)', usage: (j && j.usage) || null,
    model: (j && j.model) ? String(j.model) : apiModel,
    effort: (withEffort && HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high' };
}
async function harChatGemini(apiModel: string, key: string, system: string, msgs: any[]): Promise<{ text: string; usage: any }> {
  // [SEC-FLEETMODE-CONSOLE-V1] A CONSOLE TRANSPORT. NOT BEHIND THE SPEND SWITCH, ON PURPOSE.
  // Both Gemini destinations are decided below by harGeminiTransport(): Vertex on the
  // service account, or AI Studio with a key.
  //
  // WHAT THE SWITCH PROTECTS AGAINST: spend NOBODY ASKED FOR -- a tick, a sweep, a retry
  // loop or a background runner starting model work by itself while its owner is asleep.
  //
  // WHY THIS FUNCTION IS OUT OF SCOPE: its only callers are POST /api/chat and the reflect
  // pass on the tail of that same request. Both run because a signed-in human typed and
  // pressed send, so nothing unattended reaches this line and a check here could only ever
  // refuse the operator his own console. The unattended path the rule was about -- scheduled
  // runners starting model work on a timer -- is deleted as of 12.5. The long form
  // of the argument, including why stating it rather than just asserting it is part of the
  // fix, is at harClaudePost() above.
  const contents = msgs.map((m) => ({ role: m.role === 'me' ? 'user' : 'model', parts: [{ text: String(m.text || m.content || '') }] }));
  // [CHAT-GEMINI-MAXTOK-V1] VERIFIED ABSENT BEFORE IT WAS ADDED: `grep -n maxOutputTokens` on
  // this file returned NOTHING -- neither Gemini path, toolless or tool-capable, sent a
  // generationConfig of any kind, while every Claude path has sent max_tokens:
  // HAR_CHAT_MAX_TOKENS since [CHAT-MAX-TOKENS-V1]. So CHAT_MAX_TOKENS meant one thing on one
  // substrate and nothing at all on the other, which is the two-registries shape this file keeps
  // paying for -- and it matters more now that [CHAT-GEMINI-DEFAULT-V1] makes Gemini the
  // substrate a provider-less request lands on.
  // SAY PLAINLY WHAT THIS IS: it is a NEW CEILING ON GEMINI, not the removal of an old one. The
  // previous note in harChatClaude() flagged exactly that and declined to do it; this release
  // does it, for parity, and the honest cost is that a Gemini answer longer than
  // HAR_CHAT_MAX_TOKENS is now truncated where before it was not. The mitigation is that it is
  // the SAME env-tunable constant (CHAT_MAX_TOKENS, default 4096 in this tree): raising it raises
  // both substrates together, with a config revision and no rebuild, which was the whole point of
  // naming it once.
  // NOTHING ELSE GOES IN generationConfig. No temperature, no topP, no candidateCount -- this
  // block exists to make ONE setting mean the same thing on both substrates, and every other
  // field would be a sampling change riding in on a consistency fix.
  const payload = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: HAR_CHAT_MAX_TOKENS } };
  let url = 'https://generativelanguage.googleapis.com/v1beta/models/' + apiModel + ':generateContent?key=' + encodeURIComponent(key);
  let headers: any = { 'Content-Type': 'application/json' };
  let hostDesc = 'host=generativelanguage.googleapis.com transport=studio';
  // [CHAT-VERTEX-DEFAULT-V2] WAS `if (!key || key === 'vertex' || key === 'token')` -- i.e. a stale
  // chat-key-gemini secret or a leftover GEMINI_API_KEY silently took the chat OFF Vertex and onto
  // AI Studio, where the configured Vertex publisher model id does not exist. That is the operator's
  // "Gemini said it was wired but I couldn't chat with it". Vertex is now the default transport and
  // AI Studio is an explicit opt-in (CHAT_GEMINI_PROVIDER=studio + a real key).
  if (harGeminiTransport(key) === 'vertex') {
    const tok = await waAccessToken();
    // Region MUST be one Vertex actually serves the model in: the configured region, else 'global'.
    // gemini-3.1-pro-preview is a GLOBAL publisher model; us-central1 404s.
    // WAS `process.env.GCP_REGION || 'global'` -- GCP_REGION is the CLOUD RUN region (default
    // us-east1) and is set on this service, so the chat asked us-east1-aiplatform for a global-only
    // model and got a 404. Now a dedicated setting with a model-aware safe fallback.
    const region = harVertexGeminiRegion(apiModel);
    const project = harVertexProject();
    // location=global is served by the BARE host, not global-aiplatform.* (same rule as run_deepseek()).
    const vhost = harVertexHost(region);
    url = `https://${vhost}/v1/projects/${project}/locations/${region}/publishers/google/models/${apiModel}:generateContent`;
    headers['Authorization'] = 'Bearer ' + tok;
    hostDesc = 'host=' + vhost + ' transport=vertex region=' + region + ' project=' + project;
  }
  
  // [MODEL-LONGRUN-V1] model POST site 2 of 3 (Gemini, toolless path -- AI Studio or Vertex).
  const r = await waFetchLong(url, {
    method: 'POST', headers,
    body: JSON.stringify(payload),
  });
  let j: any = null;
  try { j = await r.json(); } catch (e: any) { j = { parse_error: String((e && e.message) || e) }; }
  // [CHAT-OBSERVABLE-V1] REPORT THE REAL REASON. This used to be `'gemini ' + r.status + ...` and
  // then /api/chat turned it into a bare 500 with only an err_id, so a 404 for the wrong host, a 403
  // for a missing aiplatform role and an expired AI-Studio key were all the same opaque failure.
  // The upstream message is carried through verbatim; harRedact() strips ?key= and bearer material,
  // so no key value can ride out on it.
  if (!r.ok) {
    const um = (j && j.error && (j.error.message || j.error.status)) || (j && j.parse_error) || JSON.stringify(j).slice(0, 400);
    throw new Error(harRedact('gemini ' + hostDesc + ' model=' + apiModel + ' HTTP ' + r.status + ': ' + um +
      harChatRemedy(harChatResolved('gemini', key), r.status)));
  }
  const c = j.candidates && j.candidates[0];
  const text = (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || '(no text)';
  // Gemini REST (BOTH generativelanguage v1beta and the Vertex v1 path above) returns camelCase
  // `usageMetadata`. Map it onto the SAME four canonical field names the token_usage journal rows use.
  const um: any = (j && j.usageMetadata) || null;
  const usage = um ? {
    input_tokens: Number(um.promptTokenCount || 0) || 0,
    output_tokens: Number(um.candidatesTokenCount || 0) || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Number(um.cachedContentTokenCount || 0) || 0,
  } : null;
  return { text: text, usage: usage };
}

// ---- pages (gated: must have a console session; otherwise the locked document, in place) ----
app.get('/chat', (req: express.Request, res: express.Response) => { if (pcCanonicalHostRedirect(req, res)) return; /* [PC-CANONICAL-HOST-V48] */ if (!waSessionOk(req)) { waSendLocked(res); return; } res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store, max-age=0'); res.send(HAR_HARNESS_HTML); });

// ---- [PQC-TLS-TOGGLE-V1] post-quantum TLS ingress toggle ----
// The knob is compute.sslPolicies field `postQuantumKeyExchange` (API v1, values
// DEFAULT / DEFERRED / ENABLED). When it is ENABLED the load balancer negotiates
// the hybrid group X25519MLKEM768 with clients that offer it. The policy only has
// any effect where a target HTTPS proxy attaches it via its `sslPolicy` field; a
// proxy with NO policy attached behaves as DEFAULT, silently and with no error.
// That is why the GET below reports proxy coverage and not just the stored value.
//
// READ  -> runs now, as the control-plane service account (a blessed GET).
// WRITE -> never runs here. It is staged to the human gate and executed as the
//          approving human's own OAuth token, like every other infra mutation.
//          harGcpDanger() classifies PATCH as destroy-class, so approval also
//          requires the second Face ID. That is intended: this changes GCP infra.
const PQC_POLICY_NAME: string = process.env.PQC_POLICY_NAME || 'pqc-pqc-policy';
const PQC_POLICY_URL: string = 'https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/global/sslPolicies/' + PQC_POLICY_NAME;
const PQC_PROXIES_URL: string = 'https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/aggregated/targetHttpsProxies?returnPartialSuccess=true&fields=items/*/targetHttpsProxies/name,items/*/targetHttpsProxies/sslPolicy';

// Allowed settings values. DEFAULT is deliberately ABSENT and is rejected below:
// per the discovery document it means "disabled until October 2026, enabled
// afterward", so writing it as the OFF position produces a switch that silently
// turns itself back on. OFF is DEFERRED ("disabled until October 2027").
const PQC_VALUES: string[] = ['ENABLED', 'DEFERRED'];

async function pqcReadState(): Promise<any> {
  const tok = await waAccessToken();
  const h = { Authorization: 'Bearer ' + tok };
  let value: string | null = null;
  let exists = false;
  let minTls: string | null = null;
  const rp = await waFetch(PQC_POLICY_URL, { headers: h });
  if (rp && rp.ok) {
    const jp: any = await rp.json();
    exists = true;
    value = String(jp.postQuantumKeyExchange || '');
    minTls = String(jp.minTlsVersion || '');
  }
  // Coverage: which target proxies actually attach this policy. A stored value of
  // ENABLED with zero attached proxies changes nothing on the wire.
  const attached: string[] = [];
  let coverageKnown = false;
  const rx = await waFetch(PQC_PROXIES_URL, { headers: h });
  if (rx && rx.ok) {
    coverageKnown = true;
    const jx: any = await rx.json();
    const items = (jx && jx.items) || {};
    for (const scope of Object.keys(items)) {
      const arr = (items[scope] && items[scope].targetHttpsProxies) || [];
      for (const p of arr) {
        const sp = String((p && p.sslPolicy) || '');
        if (sp && sp.indexOf('/sslPolicies/' + PQC_POLICY_NAME) >= 0) attached.push(String(p.name || ''));
      }
    }
  }
  let effective = 'absent';
  if (exists) effective = (value === 'ENABLED' && attached.length > 0) ? 'on' : 'off';
  let warning: string | null = null;
  if (exists && value === 'ENABLED' && coverageKnown && attached.length === 0) {
    warning = 'the policy says ENABLED but no target HTTPS proxy attaches it, so nothing negotiates X25519MLKEM768 yet';
  }
  if (exists && value === 'DEFAULT') {
    warning = 'this policy is set to DEFAULT, which silently becomes ENABLED in October 2026. Set it explicitly.';
  }
  return { exists: exists, value: value, min_tls: minTls, effective: effective, attached_proxies: attached, coverage_known: coverageKnown, warning: warning };
}

// In-flight: these operations are asynchronous and take minutes (staging, the
// human's approval tap, then the GCP operation). The UI needs to know which of
// those three it is sitting in, so the pending job is reported explicitly.
async function pqcPending(): Promise<any> {
  try {
    const snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(25).get();
    for (const doc of snap.docs) {
      const d: any = doc.data() || {};
      const cmd = String((d.arguments && (d.arguments.command || d.arguments.cmd)) || '');
      if (cmd.indexOf('/sslPolicies/' + PQC_POLICY_NAME) >= 0 || String(d.command_type || '').indexOf('sslPolicies') >= 0) {
        let want = '';
        const m = /"postQuantumKeyExchange"\s*:\s*"([A-Z]+)"/.exec(cmd);
        if (m) want = m[1];
        return { job_id: String(d.job_id || doc.id), want: want, staged_by: String(d.staged_by || ''), state: 'awaiting_approval' };
      }
    }
  } catch (e) {}
  return null;
}

app.get('/api/security/pqc-tls', waGate(async (req, res) => {
  const st = await pqcReadState();
  const pending = await pqcPending();
  res.json({
    ok: true,
    policy: PQC_POLICY_NAME,
    exists: st.exists,
    value: st.value,
    min_tls: st.min_tls,
    effective: st.effective,
    group: 'X25519MLKEM768',
    attached_proxies: st.attached_proxies,
    coverage_known: st.coverage_known,
    warning: st.warning,
    allowed: PQC_VALUES,
    pending: pending,
    in_flight: !!pending,
    gated: true,
    note: 'Changing this stages a job to the gate; it applies only after you approve it with your passkey.',
  });
}));

app.post('/api/security/pqc-tls', waGate(async (req, res) => {
  const want = String((req.body && req.body.value) || '').trim().toUpperCase();
  if (want === 'DEFAULT') {
    res.status(400).json({
      error: 'DEFAULT is not offered',
      detail: 'DEFAULT means "disabled until October 2026, enabled afterward". Using it as the OFF position produces a toggle that turns itself back on in October 2026 without telling anyone. Use DEFERRED for off.',
      allowed: PQC_VALUES,
    });
    return;
  }
  if (PQC_VALUES.indexOf(want) < 0) {
    res.status(400).json({ error: 'invalid value', allowed: PQC_VALUES });
    return;
  }
  const st = await pqcReadState();
  if (!st.exists) {
    res.status(409).json({
      error: 'no SSL policy to change',
      detail: 'The policy ' + PQC_POLICY_NAME + ' does not exist. This toggle only flips an existing policy. Provisioning the load balancer is a separate, explicitly-labelled operation (provision-pqc-ingress.sh) that creates billable infrastructure.',
    });
    return;
  }
  if (st.value === want) {
    res.json({ mode: 'noop', value: want, note: 'already set to ' + want + '; nothing staged' });
    return;
  }
  const already = await pqcPending();
  if (already) {
    res.status(409).json({ error: 'a change is already awaiting approval', pending: already });
    return;
  }
  const caller = String((req as any).waUser || (req as any).userEmail || 'harness');
  const staged = await harGcpStage(
    caller, 'PATCH', PQC_POLICY_URL,
    { postQuantumKeyExchange: want },
    'post-quantum TLS toggle: set postQuantumKeyExchange=' + want + ' on ' + PQC_POLICY_NAME,
    harGcpDanger('PATCH', PQC_POLICY_URL)
  );
  res.json({
    mode: 'staged',
    job_id: (staged && staged.job_id) || null,
    want: want,
    from: st.value,
    gated: true,
    note: 'Approve this at the gate with your passkey. It runs as YOUR OAuth token, not the fleet\'s. Allow a few minutes: staging, your approval, then the GCP operation.',
  });
}));
// ---- end [PQC-TLS-TOGGLE-V1] ----
  // stopping the box revokes the ops window

// ---- Ops session endpoints ----
// harness pushes a fresh Google access token; first push starts the 12h window, later pushes extend the token only.
app.post('/api/ops/token', waGate(async (req, res) => {
  const token = String((req.body && req.body.access_token) || '');
  const expiresIn = Number((req.body && req.body.expires_in) || 3600);
  if (!token) { res.status(400).json({ error: 'no token' }); return; }
  const now = Date.now();
  let s = await opsGet();
  if (!s || !s.window_expiry || now > s.window_expiry) { s = { window_start: now, window_expiry: now + OPS_WINDOW_MS }; }  // new window
  s.token = token; s.token_expiry = now + Math.max(60, expiresIn - 90) * 1000;
  await opsSet(s);
  res.json({ ok: true, window_expiry: s.window_expiry, remaining_ms: s.window_expiry - now });
}));
app.get('/api/ops/session', waGate(async (req, res) => {
  const now = Date.now(); const s = await opsGet();
  if (!s || !s.window_expiry || now > s.window_expiry) { res.json({ active: false, window_hours: OPS_WINDOW_MS / 3600000 }); return; }
  res.json({ active: true, window_expiry: s.window_expiry, remaining_ms: s.window_expiry - now, token_fresh: !!(s.token_expiry && now < s.token_expiry), window_hours: OPS_WINDOW_MS / 3600000 });
}));
app.post('/api/ops/end', waGate(async (req, res) => { await opsClear('manual'); const s = await opsGet(); res.json({ ok: !!(s && s.revoked_at), revoked_seq: (s && s.revoked_seq) || 0 }); }));  // manual "lock ops now" (F14: reports the truth)

// ---- models ----
// [CHAT-GEMINI-DEFAULT-V1] default_provider IS PUBLISHED, because the client cannot otherwise
// honour a server default it has no way to read. Without it the page must guess, and a page that
// guesses 'claude' while this process defaults to 'gemini' shows one substrate on the badge and
// bills the other -- the exact divergence this tag exists to close. The field says what the
// SERVER would do with a provider-less request; a browser that holds an explicit remembered pick
// still sends it, and that still wins at /api/chat.
app.get('/api/models', waGate(async (req, res) => { res.json(Object.assign({}, harModels(), { effort: HAR_CHAT_EFFORT, default_provider: HAR_CHAT_DEFAULT_PROVIDER })); }));
// ---- token usage + cost readout (READ-ONLY). This is a FIRESTORE read only: it never calls a
// model and can never cost model credit. Deliberately NO orderBy, so it needs only the single-field
// index on `ts` and cannot fail on a missing composite index. Everything is wrapped in try/catch and
// returns HTTP 200 with {error} rather than throwing, so a telemetry failure can never break a page.
// COST IS COMPUTED AT READ TIME from the stored token counts; no cost is ever written anywhere.
// Prices live in Firestore config/models field `prices`, shape
//   { "<model id>": { "in": n, "out": n, "cache_write": n, "cache_read": n } }
// in DOLLARS PER MILLION TOKENS. A missing doc / field / model key / rate yields
// prices_configured:false and cost_usd:null. A missing price is NEVER 0 and is NEVER guessed.
app.get('/api/usage', waGate(async (req, res) => {
  try {
    const nowD = new Date();
    const startOfTodayUTC = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate(), 0, 0, 0, 0));
    const snap = await db.collection('token_usage').where('ts', '>=', startOfTodayUTC).get();
    const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const total: any = zero();
    const bySource: any = {};
    const byModel: any = {};
    snap.forEach((doc: any) => {
      const d = (doc && doc.data && doc.data()) || {};
      const src = String(d.source || 'unknown');
      const mdl = String(d.model || 'unknown');
      if (!bySource[src]) bySource[src] = zero();
      if (!byModel[mdl]) byModel[mdl] = zero();
      for (let i = 0; i < FIELDS.length; i++) {
        const f = FIELDS[i];
        const v = Number(d[f] || 0) || 0;
        total[f] += v; bySource[src][f] += v; byModel[mdl][f] += v;
      }
    });
    const sumOf = (t: any) => (Number(t.input_tokens || 0) + Number(t.output_tokens || 0) + Number(t.cache_creation_input_tokens || 0) + Number(t.cache_read_input_tokens || 0));
    // price table: absent doc / absent field => prices stays null => every cost is null.
    let prices: any = null;
    try {
      const pdoc = await db.collection('config').doc('models').get();
      const pdata = (pdoc && pdoc.exists && pdoc.data()) ? pdoc.data() : null;
      const pv = pdata ? pdata.prices : null;
      if (pv && typeof pv === 'object') prices = pv;
    } catch (e) { prices = null; }
    const rateFor = (mdl: string, k: string): any => {
      if (!prices) return null;
      const p = prices[mdl];
      if (!p || typeof p !== 'object') return null;
      const v = p[k];
      return (typeof v === 'number' && isFinite(v)) ? v : null;
    };
    const PAIRS = [['in', 'input_tokens'], ['out', 'output_tokens'], ['cache_write', 'cache_creation_input_tokens'], ['cache_read', 'cache_read_input_tokens']];
    const costFor = (mdl: string, t: any): any => {
      let c = 0;
      for (let i = 0; i < PAIRS.length; i++) {
        const toks = Number(t[PAIRS[i][1]] || 0) || 0;
        if (!toks) continue;                       // no tokens of this kind => contributes nothing
        const r = rateFor(mdl, PAIRS[i][0]);
        if (r === null) return null;               // a NEEDED price is missing => null, never 0
        c += (toks / 1000000) * r;
      }
      return c;
    };
    const models: any = {};
    const sources: any = {};
    let sum = 0;
    let missingPrice = false;
    const mkeys = Object.keys(byModel);
    for (let i = 0; i < mkeys.length; i++) {
      const k = mkeys[i];
      const c = costFor(k, byModel[k]);
      models[k] = { tokens: byModel[k], total_tokens: sumOf(byModel[k]), cost_usd: c, prices_configured: c !== null };
      if (c === null) { missingPrice = true; } else { sum += c; }
    }
    const skeys = Object.keys(bySource);
    for (let i = 0; i < skeys.length; i++) {
      const k = skeys[i];
      sources[k] = { tokens: bySource[k], total_tokens: sumOf(bySource[k]) };
    }
    const pricesOk = (prices !== null) && !missingPrice;
    res.json({
      ok: true,
      day_start_utc: startOfTodayUTC.toISOString(),
      docs: (snap && typeof snap.size === 'number') ? snap.size : 0,
      total: total,
      total_tokens: sumOf(total),
      by_source: sources,
      by_model: models,
      prices_configured: pricesOk,
      cost_usd: pricesOk ? (Math.round(sum * 1000000) / 1000000) : null,
    });
  } catch (e: any) {
    // never throw: a telemetry failure must not break the page
    res.json({ ok: false, error: String((e && e.message) || e), prices_configured: false, cost_usd: null });
  }
}));

// ---- keys (presence only for status; values go to Secret Manager) ----
app.get('/api/keys/status', waGate(async (req, res) => {
  const claudeAge = await harKeyAge('claude');
  const geminiAge = await harKeyAge('gemini');
  // [CHAT-OBSERVABLE-V1] `chat` reports the RESOLVED transport/region/host/model/effort for both
  // providers, so "is it on Vertex?" is answerable from this endpoint. Presence booleans only --
  // no key value, no token, ever appears here.
  const ck = await harKey('claude'); const gk = await harKey('gemini');
  res.json({ 
    claude: !!ck, 
    gemini: (gk !== 'vertex'),
    claude_set_at: claudeAge,
    gemini_set_at: geminiAge,
    chat: { claude: harChatResolved('claude', ck), gemini: harChatResolved('gemini', gk) }
  });
}));
app.post('/api/keys', waGate(async (req, res) => {
  // [CHAT-GEMINI-DEFAULT-V1] LEFT EXACTLY AS IT WAS, ON PURPOSE, AND SIGNPOSTED BECAUSE IT IS
  // BYTE-IDENTICAL TO THE LINE IN POST /api/chat that this release changed. Grepping the
  // expression `=== 'gemini' ? 'gemini' : 'claude'` finds TWO hits in this file (measured), and
  // the next person to grep it must not "finish the job" here.
  // THEY ARE DIFFERENT QUESTIONS. There it means "which substrate should this turn run on",
  // which has a cost, a quota story and a server default worth publishing. HERE it means "which
  // key is the human saving in the box he just typed into" -- there is no default to move, no
  // spend attached, and no such thing as a key with no provider: the console always names one,
  // and a body that names neither is a malformed save, for which 'claude' is as good an answer
  // as any and has been the answer since this route was written.
  // Routing this through HAR_CHAT_DEFAULT_PROVIDER would make CHAT_DEFAULT_PROVIDER=gemini
  // silently file a pasted Anthropic key under the Gemini secret. Not done.
  const provider = (req.body && req.body.provider) === 'gemini' ? 'gemini' : 'claude';
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) { res.status(400).json({ error: 'no key' }); return; }
  
  if (provider === 'claude') {
    // [SEC-FLEETMODE-CONSOLE-V1] A CONSOLE SURFACE. NOT BEHIND THE SPEND SWITCH, ON PURPOSE.
    // The verification probe below IS a model call -- a real Messages request carrying the
    // submitted key -- and it is still the fourth model transport in this file. What it is
    // not is unattended.
    //
    // WHAT THE SWITCH PROTECTS AGAINST: spend NOBODY ASKED FOR -- a tick, a sweep, a retry
    // loop or a background runner starting model work by itself. Nothing on this route can
    // run unattended: it is a POST behind the session gate, reached when a human pastes a
    // key into the console and clicks save. The one token this probe spends is spent
    // BECAUSE HE ASKED, on the key he just supplied, to tell him whether it works.
    //
    // WHAT THE CHECK HERE ACTUALLY DID: it answered 409 unless the mode was dual, and no
    // code in this product ever writes dual -- the installer writes work, and no route in
    // this file writes the field at all. So a home user could not add a Claude key, at all,
    // by any route the product offers, and the reason was a mode reachable only by a manual
    // privileged write. Refusing a human the ability to supply his own credential is not a
    // spend control; the credential is his and so is the bill.
    // verify with a tiny test call
    const testR = await waFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
    });
    if (!testR.ok) { res.status(400).json({ error: 'Invalid Claude key (verify failed)' }); return; }
    
    // auto-disable old key
    const oldKey = await harSecretGet(harKeyName('claude'));
    if (oldKey && oldKey !== key) {
      await disableOldClaudeKey(oldKey);
    }
  }
  
  const ok = await harSecretSet(harKeyName(provider), key);
  if (ok) {
    await setHarKeyAge(provider);
  }
  res.json({ ok });
}));

// ---- fleet agents (for the chat sidebar) — reuses journal/work_items like /api/dash/summary ----
app.get('/api/fleet/agents', waGate(async (req, res) => {
  const now = Date.now(); const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { id: a, name: a.replace(/^fleet-/, 'Fleet ').replace(/\b\w/g, (c: string) => c.toUpperCase()), role: a, last_ts: 0, backlog: 0 }; return agents[a]; };
  // The roster is the floor: every active, non-hidden strain appears whether or not it
  // has journaled lately. Before this, the list was derived ONLY from the last 300 journal
  // rows, so it showed recent talkers (gate-exec, security, publisher) and
  // hid every quiet strain. Activity below only decorates these rows.
  // [ROSTER-ONLY-V1] The roster is both the FLOOR and the CEILING. Seeding alone was
  // not enough: gate-exec journals constantly and is a service identity, not a strain,
  // so it kept appearing from the journal pass below. Ids outside the roster are now
  // dropped. If the roster read fails or is empty (fresh install, Firestore hiccup) the
  // filter is skipped rather than blanking the panel -- degrade to the old behaviour,
  // never to an empty list.
  const roster = new Set<string>();
  try { for (const s of await strainList(true)) { if (s && s.role && s.hidden !== true) { roster.add(String(s.role)); ensure(String(s.role)); } } } catch (e) {}
  try {
    const jsnap = await db.collection('journal').orderBy('timestamp', 'desc').limit(300).get();
    jsnap.docs.forEach((d: any) => { const e = d.data(); const a = ensure(e.agent_id); if (!a) return; const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds * 1000 : 0; if (ts > a.last_ts) a.last_ts = ts; });
  } catch (e) {}
  try { const w = await db.collection('work_items').where('status', '==', 'pending').limit(300).get(); w.docs.forEach((d: any) => { const a = ensure(d.data().assigned_role); if (a) a.backlog++; }); } catch (e) {}
  const list = Object.keys(agents).filter((k) => k !== 'human_operator' && (roster.size === 0 || roster.has(k))).map((k) => { const a = agents[k]; const age = a.last_ts ? (now - a.last_ts) / 60000 : 999999; a.status = age < 5 ? 'working' : (a.backlog > 0 ? 'waiting' : 'idle'); return a; }).sort((x: any, y: any) => y.last_ts - x.last_ts);
  res.json({ agents: list });
}));
// ---- strain delete (session + Face-ID/elevation gated; backs up to the Mycelium then removes) ----
// ---------------------------------------------------------------------------
// [GH-TOOLS-V1] THE GITHUB PANEL. Modelled on /api/keys directly above, including the part
// that matters most: THE CREDENTIAL IS VERIFIED BEFORE IT IS STORED. A token that is expired,
// revoked, or scoped to the wrong account is rejected at the moment it is pasted, with the
// account name it actually authenticates as -- rather than being written to Secret Manager and
// discovered to be wrong later by an agent, in a different context, with no way to tell whether
// the tool or the token is at fault.
//
// NO ROUTE HERE EVER RETURNS A TOKEN. /status answers presence and the resolved login only.
// ---------------------------------------------------------------------------
app.get('/api/github/status', waGate(async (req, res) => {
  const c = await ghConfig();
  const slugs: string[] = Array.isArray(c.identities) && c.identities.length ? c.identities : ['default'];
  const out: any[] = [];
  for (const s of slugs) {
    const t = await harSecretGet(pcGhSecretName(s));
    if (!t) { out.push({ identity: s, stored: false }); continue; }
    let login = null, err = null, type = null;
    try {
      const r = await waFetch('https://api.github.com/user', {
        headers: { Authorization: 'Bearer ' + t.trim(), Accept: 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'paracoding' } });
      if (r && r.ok) { const j: any = await r.json(); login = j && j.login; type = j && j.type; }
      else { err = 'HTTP ' + (r ? r.status : '?') + ' -- the stored token is expired, revoked or invalid'; }
    } catch (e: any) { err = String(e && e.message ? e.message : e); }
    out.push({ identity: s, stored: true, login, account_type: type, error: err });
  }
  res.json({ identities: out, default_identity: c.default_identity || 'default',
             owners: c.owners || {}, repos: c.repos || [], api_base: c.api_base || 'https://api.github.com' });
}));

app.post('/api/github/token', waGate(async (req, res) => {
  const slug = String((req.body && req.body.identity) || 'default').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    res.status(400).json({ error: 'identity must be lowercase letters, digits and hyphens, 1-32 characters' }); return;
  }
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) { res.status(400).json({ error: 'no token' }); return; }

  let login: string | null = null;
  try {
    const r = await waFetch('https://api.github.com/user', {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'paracoding' } });
    if (!r || !r.ok) {
      res.status(400).json({ error: 'GitHub rejected that token (HTTP ' + (r ? r.status : '?') + '). '
        + 'Nothing was stored. A fine-grained token must not be expired and must have at least '
        + 'read access to the repositories you want to use.' });
      return;
    }
    const j: any = await r.json(); login = j && j.login;
  } catch (e: any) {
    res.status(400).json({ error: 'could not reach GitHub to verify the token: ' + String(e && e.message ? e.message : e) + '. Nothing was stored.' });
    return;
  }

  const w = await harSecretSetX(pcGhSecretName(slug), token);
  if (!w.ok) {
    res.status(500).json({ error: 'GitHub accepted the token but it could not be stored: '
      + (w.detail || 'unknown Secret Manager error')
      + (String(w.detail || '').indexOf('PERMISSION_DENIED') >= 0
         ? '  --  this install has never created a secret by this name, so the control plane needs '
           + 'create-and-add on it. Create ' + pcGhSecretName(slug) + ' and grant this service '
           + 'roles/secretmanager.secretAccessor and roles/secretmanager.secretVersionAdder on '
           + 'THAT SECRET ONLY.'
         : '') });
    return;
  }
  try {
    const c = await ghConfig();
    const ids = Array.isArray(c.identities) ? c.identities.slice() : [];
    if (ids.indexOf(slug) < 0) ids.push(slug);
    await db.collection('config').doc('github').set(Object.assign({}, c, {
      identities: ids, default_identity: c.default_identity || slug,
    }), { merge: true });
  } catch (_e) { /* the token is stored; the index is a convenience */ }
  res.json({ ok: true, identity: slug, login });
}));

app.post('/api/github/config', waGate(async (req, res) => {
  const b: any = req.body || {};
  const patch: any = {};
  if (b.default_identity != null) patch.default_identity = String(b.default_identity).trim().toLowerCase();
  if (b.api_base != null) patch.api_base = String(b.api_base).trim().replace(/\/+$/, '');
  if (Array.isArray(b.repos)) patch.repos = b.repos.map((x: any) => String(x).trim().toLowerCase()).filter(Boolean);
  if (b.owners && typeof b.owners === 'object') {
    const o: any = {};
    for (const k of Object.keys(b.owners)) o[String(k).trim().toLowerCase()] = String(b.owners[k]).trim().toLowerCase();
    patch.owners = o;
  }
  if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing to change' }); return; }
  await db.collection('config').doc('github').set(patch, { merge: true });
  res.json({ ok: true, config: await ghConfig() });
}));

app.post('/api/strain/delete', waGate(async (req, res) => {
  const agentId = String((req.body && req.body.agentId) || '');
  if (agentId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    harJournalAs('harness', 'security_quarantine', 'Refused agentId: bad charset (possible path traversal): ' + String(agentId).slice(0, 64));
    res.status(403).json({ error: 'forbidden: invalid agentId format' });
    return;
  }
  if (!agentId || agentId === 'human_operator') { res.status(400).json({ error: 'bad agentId' }); return; }
  try {
    const nowMs = Date.now();
    const ch = await db.collection('chat_history').where('agent_id', '==', agentId).get();
    const jn = await db.collection('journal').where('agent_id', '==', agentId).get();
    let wi: any = { docs: [], size: 0 };
    try { wi = await db.collection('work_items').where('assigned_role', '==', agentId).get(); } catch (e) {}
    const backup: any = { agent_id: agentId, deleted_at_ms: nowMs, chat_history: ch.docs.map((d: any) => d.data()), journal: jn.docs.map((d: any) => d.data()), work_items: (wi.docs || []).map((d: any) => d.data()) };
    // [STRAINLIFE-DELETE-DOC-V1] the registry document was never removed, so a "deleted" strain kept its
    // roster row, its A2A card, its pasteable flag and (worse) any live session key bound to it,
    // while its history was gone. Captured into the SAME backup object before it is serialised.
    let sdata: any = null;
    try { const ssnap = await db.collection('strains').doc(agentId).get(); if (ssnap.exists) sdata = ssnap.data() || null; } catch (e) {}
    backup.strains_doc = sdata;
    const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
    const key = 'shared/backups/strains/' + agentId + '-' + ts + '.json';
    await harWriteLake(key, JSON.stringify(backup), 'application/json');
    for (const d of ch.docs) { try { await d.ref.delete(); } catch (e) {} }
    for (const d of jn.docs) { try { await d.ref.delete(); } catch (e) {} }
    for (const d of (wi.docs || [])) { try { await d.ref.delete(); } catch (e) {} }
    // [STRAINLIFE-DELETE-DOC-V1] removal happens AFTER the backup object is written to the lake above.
    let strainDocDeleted = false;
    try { if (sdata) { await db.collection('strains').doc(agentId).delete(); strainDocDeleted = true; } } catch (e) {}
    let keysRevoked = 0;
    try { const sk = await db.collection('session_keys').where('role', '==', agentId).get(); for (const d of sk.docs) { try { await d.ref.set({ revoked: true, revoked_by: 'strain_delete', revoked_at_ms: nowMs }, { merge: true }); keysRevoked++; } catch (e) {} } } catch (e) {}
    res.json({ ok: true, backup: key, deleted: { chat_history: ch.size, journal: jn.size, work_items: (wi.size || 0), strains_doc: strainDocDeleted, session_keys_revoked: keysRevoked } });
  } catch (e: any) { harFail(res, e, 'harness'); }
}));

// ---- strain subculture (clone/fork: the new strain inherits the parent's full history) ----
app.post('/api/strain/subculture', waGate(async (req, res) => {
  const parentId = String((req.body && req.body.parentId) || '');
  let name = String((req.body && req.body.name) || '').trim();
  if (!parentId || parentId === 'human_operator') { res.status(400).json({ error: 'bad parent strain' }); return; }
  if (!name) { res.status(400).json({ error: 'no name for the subculture' }); return; }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 40);
  if (!slug) { res.status(400).json({ error: 'name has no usable letters' }); return; }
  const childId = slug.indexOf('fleet-') === 0 ? slug : ('fleet-' + slug);
  if (childId === parentId) { res.status(400).json({ error: 'pick a different name' }); return; }
  try {
    const exch = await db.collection('chat_history').where('agent_id', '==', childId).limit(1).get();
    const exjn = await db.collection('journal').where('agent_id', '==', childId).limit(1).get();
    if (!exch.empty || !exjn.empty) { res.status(409).json({ error: 'a strain "' + childId + '" already exists' }); return; }
    const ch = await db.collection('chat_history').where('agent_id', '==', parentId).limit(5000).get();
    const rows = ch.docs.map((d: any) => d.data());
    rows.sort((a: any, b: any) => (((a.timestamp && a.timestamp._seconds) || 0) - ((b.timestamp && b.timestamp._seconds) || 0)));
    let copied = 0;
    for (const r of rows) {
      try { await db.collection('chat_history').add({ agent_id: childId, role: r.role, text: String(r.text || ''), tags: ['subculture', 'inherited'], timestamp: (r.timestamp || FieldValue.serverTimestamp()) }); copied++; } catch (e) {}
    }
    try { await db.collection('chat_history').add({ agent_id: childId, role: 'assistant', text: 'Subcultured from ' + parentId + ' — inherited ' + copied + ' prior turns of history.', tags: ['subculture', 'system'], timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    try { await db.collection('journal').add({ agent_id: childId, action: 'subculture', message: 'Forked from ' + parentId + ' (inherited ' + copied + ' turns).', parent: parentId, timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    // [STRAIN-SUBCULTURE-REGISTER-V1] A fork copied history and journals but never registered
    // the child in the strain registry, so the new strain was invisible: not in /api/strains,
    // not pasteable, no session key, unusable. Provision it here or the clone is a ghost.
    await db.collection('strains').doc(childId).set({ role: childId, display_name: String(name), status: 'active', pasteable: true, created_by: 'system:subculture', parent: parentId, created_at: FieldValue.serverTimestamp() });
    res.json({ ok: true, childId, parent: parentId, inherited: copied });
  } catch (e: any) { harFail(res, e, 'harness'); }
}));

// ---- chat history (per-agent, harness scrollback) ----
app.get('/api/chat/history', waGate(async (req, res) => {
  const agentId = String((req.query && (req.query as any).agentId) || '');
  if (!agentId) { res.json({ history: [] }); return; }
  try {
    // orderBy timestamp desc + limit => the NEWEST 2000 turns, deterministically. Without the orderBy
    // Firestore returns the first 2000 docs by __name__ (auto-id ~ random), so past 2000 docs the set
    // of turns returned changed arbitrarily between requests. Reversed back to oldest-first below.
    const snap = await db.collection('chat_history').where('agent_id', '==', agentId).orderBy('timestamp', 'desc').limit(2000).get();
    const r = snap.docs.map((d: any) => d.data()).reverse();
    r.sort((a: any, b: any) => (((a.timestamp && a.timestamp._seconds) || 0) - ((b.timestamp && b.timestamp._seconds) || 0)));
    const full = String((req.query && (req.query as any).full) || '') === '1';
    const out = r.slice(full ? -1200 : -80).map((h: any) => ({ role: h.role === 'assistant' ? 'ag' : 'me', text: String(h.text || '') }));
    res.json({ history: out });
  } catch (e) { res.json({ history: [] }); }
}));
// ---- server-authoritative memory: load a strain's recent verbatim history, budgeted by tokens ----
// Works for BOTH substrates (Claude + Gemini) and any client — memory is keyed by strain, not brain.
const HAR_MEM_BUDGET_TOK = Number(process.env.CHAT_MEM_BUDGET_TOK || 12000);
async function harRecentHistory(agentId: string, budgetTok: number): Promise<any[]> {
  if (!agentId) return [];
  try {
    // (1) DETERMINISM: orderBy timestamp desc + limit(600) => always the newest 600 turns. Without the
    // orderBy Firestore returned the first 600 docs by __name__ (auto-id, effectively random), so past
    // 600 docs the SET of turns changed arbitrarily between requests — the strain silently forgot real
    // turns and recalled random old ones, and the prompt prefix was never stable enough to cache.
    const snap = await db.collection('chat_history').where('agent_id', '==', agentId).orderBy('timestamp', 'desc').limit(600).get();
    const r = snap.docs.map((d: any) => d.data()).reverse();   // newest-first -> oldest-first (downstream expects oldest-first)
    // defensive re-sort: tolerant of a missing/undefined timestamp (falls back to 0, never throws)
    r.sort((a: any, b: any) => (((a.timestamp && a.timestamp._seconds) || 0) - ((b.timestamp && b.timestamp._seconds) || 0)));
    const all: any[] = [];
    for (let i = 0; i < r.length; i++) {
      const t = String(r[i].text || ''); if (!t) continue;
      all.push({ role: r[i].role === 'assistant' ? 'ag' : 'me', text: t, tok: Math.max(1, Math.ceil(t.length / 4)) });
    }
    let tok = 0; for (const m of all) tok += m.tok;
    // (2) HYSTERETIC TRIM: trimming to exactly the budget on every call shifted the prefix by a few
    // tokens every single turn, which invalidated the prompt cache every single turn. Instead: only
    // re-trim once we blow 1.25x budget, then cut back to 0.75x, always dropping WHOLE turns (never
    // splitting a message). The prefix therefore stays byte-identical across many consecutive turns
    // and only shifts occasionally.
    const hiWater = budgetTok * 1.25; const loWater = budgetTok * 0.75;
    let start = 0;
    if (tok > hiWater) { while (start < all.length - 1 && tok > loWater) { tok -= all[start].tok; start++; } }
    return all.slice(start).map((m: any) => ({ role: m.role, text: m.text }));
  } catch (e) { return []; }
}

// ---- Phase-2 learning: automatic server-side reflection (distill lessons.md every N grower turns) ----
const HAR_REFLECT_EVERY = Number(process.env.CHAT_REFLECT_EVERY || 10);
// VERIFY-GREP: PCV1-CP-ENCRYPTION-WIRED
// ---- Paracoding Vault: transparent PCV1 at-rest envelope encryption (control-plane side) ----
// Byte-compatible with shared/vault/envelope.py + shared/runner/vault_runtime.py. Master key loaded
// ONCE via Cloud KMS ML-KEM decapsulate over shared/vault/master.kem, HKDF-SHA256 -> 32B, held in RAM
// only, NEVER logged. Reuses existing primitives: waAccessToken(), waFetch(), getStorage().
const vCrypto = require('crypto');
// [SEC-VAULT-REGION-V1] THE VAULT KEYRING LIVES IN THE INSTALL REGION, NOT ALWAYS us-east1.
// These two lines hardcoded us-east1 while install.sh takes the region as $2, so a keyring
// created in, say, europe-west1 was named here in us-east1 and every decapsulate 404'd. A
// non-us-east1 adopter could not have a working vault at all, and because harWriteLake calls
// vaultMaster() before file.save() that presented as every lake write throwing. GCP_REGION is
// set on the service by install.sh at 6/10; the fallback keeps an existing us-east1 deployment
// byte-identical if it is ever absent, which is also why epoch 1 needs no separate pin.
const VAULT_KMS_LOCATION = (process.env.GCP_REGION || 'us-east1');
// [SEC-VAULT-LANE-V1] THE VAULT KEYRING AND KEY ARE LANE-NAMESPACED BY THE INSTALLER AND
// WERE NAMED HERE BY BARE LITERALS -- the one combination that cannot work. PC_LANE puts two
// lanes in ONE project, so both lanes carry the same GCP_PROJECT and the same GCP_REGION;
// install.sh creates keyring paracoding-${PC_LP}vault and key ${PC_LP}vault-kem-xwing and
// grants THAT key roles/cloudkms.decapsulator to the lane's own control plane, key-scoped.
// With the names hardcoded, a dev-lane control plane resolved PROD's keyring instead, held
// no decapsulator on it, and every vaultMaster() call 403'd -- which presents as every lake
// write throwing, and takes the git object store down with it. Granting the dev lane
// decapsulator on the prod key would be strictly WORSE: it would let the dev lane derive
// PROD'S MASTER KEY. KMS keyrings and keys CAN NEVER BE DELETED, so this has to be right
// before a lane is minted, not repaired afterwards.
//
// RESOLVED FROM THE ENVIRONMENT, DEFAULTING TO THE LITERALS THAT WERE ALREADY HERE. With all
// three variables unset, every string built below is byte-identical to what this file
// produced before this change -- which is exactly the state of the running prod services,
// so an existing install cannot change behaviour by picking this up. Same shape as
// VAULT_KMS_LOCATION directly above and as APPROVAL_SIG_KEY_VERSION, which has been
// env-resolved all along; the vault was simply the one that got missed.
const VAULT_KMS_KEYRING = (process.env.VAULT_KMS_KEYRING || 'paracoding-vault');
const VAULT_KMS_KEY_E1_NAME = (process.env.VAULT_KMS_KEY_EPOCH1 || 'vault-kem');
const VAULT_KMS_KEY_E2_NAME = (process.env.VAULT_KMS_KEY || 'vault-kem-xwing');
const VAULT_KMS_KEY_VERSION_E1 = ('projects/' + PC_PROJECT + '/locations/' + VAULT_KMS_LOCATION + '/keyRings/' + VAULT_KMS_KEYRING + '/cryptoKeys/' + VAULT_KMS_KEY_E1_NAME + '/cryptoKeyVersions/1');
const VAULT_KMS_KEY_VERSION_E2 = ('projects/' + PC_PROJECT + '/locations/' + VAULT_KMS_LOCATION + '/keyRings/' + VAULT_KMS_KEYRING + '/cryptoKeys/' + VAULT_KMS_KEY_E2_NAME + '/cryptoKeyVersions/1');
const VAULT_KMS_KEY_VERSION = VAULT_KMS_KEY_VERSION_E2;
const VAULT_MASTER_KEM_PATH = 'shared/vault/master.kem';
const VAULT_MASTER_INFO = Buffer.from('paracoding-vault master v1', 'utf8');
const VAULT_HKDF_SALT = Buffer.from('paracoding-vault-hkdf-salt-v1', 'utf8');
const VAULT_MAGIC = Buffer.from('PCV1', 'ascii');
const VAULT_EPOCH = 2;  // [PCV1-XWING-EPOCH2-PIVOT] was 1 (ML-KEM-1024 era); 2 == KEM_XWING
// Prefixes that stay CLEARTEXT at rest — MUST match shared/runner/vault_runtime.py CLEARTEXT_PREFIXES exactly.
const VAULT_CLEARTEXT_PREFIXES = ['shared/deploy/', 'shared/harness/', 'shared/passkey/', 'shared/mcp-oauth/', 'shared/vault/'];
function vaultIsCleartext(path: string): boolean { const p = String(path || '').replace(/^\/+/, ''); return VAULT_CLEARTEXT_PREFIXES.some((px) => p.indexOf(px) === 0); }
const _vaultMasterByEpoch: { [k: string]: Buffer } = {};
const _vaultMasterPromiseByEpoch: { [k: string]: Promise<Buffer> } = {};
async function vaultDecapsulate(ciphertext: Buffer, keyVersion: string): Promise<Buffer> {
  const tok = await waAccessToken();
  const r = await waFetch('https://cloudkms.googleapis.com/v1/' + keyVersion + ':decapsulate', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext: ciphertext.toString('base64') }),
  });
  if (!r || !r.ok) { let t = ''; try { t = r ? await r.text() : ''; } catch (e) {} throw new Error('KMS decapsulate failed: ' + (r && r.status) + ' ' + String(t).slice(0, 200)); }
  const j: any = await r.json();
  const ssB64 = j.sharedSecret || j.shared_secret;
  if (!ssB64) throw new Error('KMS decapsulate: no sharedSecret in response');
  return Buffer.from(ssB64, 'base64');
}
const VAULT_KEM_CT_LEN = 1120;  // KEM_XWING ciphertext length (ML-KEM-768 1088 + X25519 32), fixed by the algorithm
// Epoch -> KEM parameters. An epoch pins BOTH the algorithm and the KMS key version, because the
// master key is HKDF(shared_secret) and a different key version yields a different shared secret.
// Epoch 1 objects (if any ever existed) stay readable via master-e1.kem; epoch 2 is what we write.
const VAULT_KEM_SPEC: { [k: string]: { alg: string; ctLen: number; keyVersion: string; path: string } } = {
  '1': { alg: 'ML-KEM-1024', ctLen: 1568, keyVersion: VAULT_KMS_KEY_VERSION_E1, path: 'shared/vault/master-e1.kem' },
  '2': { alg: 'KEM_XWING', ctLen: 1120, keyVersion: VAULT_KMS_KEY_VERSION_E2, path: 'shared/vault/master.kem' },
};
// [VAULT-ENVELOPE-V1] shared/vault/master.kem is a JSON ENVELOPE written by
// shared/vault/envelope.py: {v,epoch,kem_alg,kdf,kdf_info,kem_ct_b64,kem_version,created}.
// It is NOT a bare ciphertext. This reader handed all 2259 bytes of that JSON to Cloud KMS,
// which answered 400 'Request field ciphertext must have length of 1568. Provided value had
// length 2259.' on every call since the vault was created on 2026-07-24. The lake's
// encryption has therefore NEVER worked: harWriteLake threw on every non-cleartext write and
// harReadLake swallowed the same failure and returned '', so it read as an empty file rather
// than an error. The two call sites are the strain-delete backup and the reflected lessons.md.
// The epoch and kdf_info checks are not decoration: deriving the master with a different info
// string produces a key that encrypts happily and decrypts nothing. Fail closed instead.
function vaultKemCiphertext(raw: Buffer, wantEpoch: number): Buffer {
  const spec = VAULT_KEM_SPEC[String(wantEpoch)];
  if (!spec) throw new Error('vault: no KEM spec for epoch ' + wantEpoch);
  if (raw && raw.length === spec.ctLen) return raw;  // a bare ciphertext stays valid
  let j: any = null;
  try { j = JSON.parse(raw.toString('utf8')); } catch (e) { j = null; }
  if (!j || !j.kem_ct_b64) throw new Error('vault ' + spec.path + ' is neither a ' + spec.ctLen + '-byte ciphertext nor a JSON envelope carrying kem_ct_b64 (' + (raw ? raw.length : 0) + ' bytes)');
  if (Number(j.epoch) !== wantEpoch) throw new Error('vault ' + spec.path + ' epoch ' + j.epoch + ' does not match the requested epoch (' + wantEpoch + ')');
  if (String(j.kdf_info) !== VAULT_MASTER_INFO.toString('utf8')) throw new Error('vault ' + spec.path + ' kdf_info does not match this build; deriving would produce a different master key');
  const ct = Buffer.from(String(j.kem_ct_b64), 'base64');
  if (ct.length !== spec.ctLen) throw new Error('vault ' + spec.path + ' kem_ct_b64 decodes to ' + ct.length + ' bytes, want ' + spec.ctLen + ' for ' + spec.alg);
  return ct;
}
async function vaultMasterForEpoch(epoch: number): Promise<Buffer> {
  const k = String(epoch);
  const spec = VAULT_KEM_SPEC[k];
  if (!spec) throw new Error('vault: object claims epoch ' + epoch + ' which this build cannot read');
  if (_vaultMasterByEpoch[k]) return _vaultMasterByEpoch[k];
  if (_vaultMasterPromiseByEpoch[k]) return _vaultMasterPromiseByEpoch[k];
  _vaultMasterPromiseByEpoch[k] = (async () => {
    const f = getStorage().bucket(pcLakeBucket()).file(spec.path);
    const dl = await f.download();
    const ss = await vaultDecapsulate(vaultKemCiphertext(dl[0], epoch), spec.keyVersion);
    // salt=Buffer.alloc(32,0) == python cryptography HKDF salt=None (HashLen zero bytes) — proven equal.
    // X-Wing's shared secret is 32 bytes, same as ML-KEM-1024, so this KDF is unchanged across the pivot.
    const master = Buffer.from(vCrypto.hkdfSync('sha256', ss, Buffer.alloc(32, 0), VAULT_MASTER_INFO, 32));
    _vaultMasterByEpoch[k] = master;
    return master;
  })();
  try { return await _vaultMasterPromiseByEpoch[k]; } catch (e) { delete _vaultMasterPromiseByEpoch[k]; throw e; }
}
async function vaultMaster(): Promise<Buffer> { return vaultMasterForEpoch(VAULT_EPOCH); }

// [PCV1-GIT-VAULT-WIRE-V2] BRIDGE BEGIN
// Bridges the lake epoch->master registry to the git-object epoch->master registry.
//
// There are two independent registries. The lake one is _vaultMasterByEpoch, local to this
// file, filled lazily via Cloud KMS decapsulate + HKDF. The git one is a Map inside the
// 05-adapter object-encryption module, read by every object writer. Nothing connected them,
// so encryptForStore() had no key and fail-closed on every object write -- including the
// __spill/ overflow store, doctor repack/gc, and push's durability fence.
//
// MODULE IDENTITY: this file is TRANSPILED, not bundled. The standalone transpiled copy of
// the object-encryption module has its own Map that no writer reads. The bundle carries the
// copy the writers use. So the setter is reached through require('./gittools.js') and NEVER
// through a direct require of the standalone copy. The read-back below turns a mistake here
// from a silent no-op into a named error.
//
// THIS IS NOT A SECOND ENFORCEMENT POINT. The writers already fail closed: if this arming
// never succeeds, every git object write throws at the write site with a message naming the
// fault. Nothing here gates the HTTP listener, and nothing here removes a tool -- both were
// tried and both traded a git-scoped failure for a whole-control-plane outage on every cold
// start. What this adds is early, loud detection plus a retry.
//
// var, not let, ON PURPOSE: the belt call site is ~180 KB above this declaration. A function
// declaration hoists but a let does not, so a let would re-create the temporal-dead-zone class
// that killed revision 00245-jur if buildMcpServer were ever called during module evaluation.
// var is hoisted and initialised to undefined, which removes the hazard by construction rather
// than by an invariant nobody can see from the call site.
var _gitVaultPromise: Promise<number[]> | null = null;
var _gitVaultE1Settled = false;
const GIT_VAULT_TIMEOUT_MS = Number(process.env.GIT_VAULT_TIMEOUT_MS || 20000);

// waFetch is a bare global fetch with no AbortSignal, and the storage client retries on its
// own deadline, so a stalled KMS or GCS connection resolves neither way for minutes. An inner
// try/catch handles throws; it does not handle hangs. This does. The underlying request is not
// cancelled -- it is abandoned -- which is acceptable because nothing downstream waits on it.
function gitVaultDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t: any = setTimeout(() => reject(new Error('[gittools] ' + what + ' did not settle within ' + GIT_VAULT_TIMEOUT_MS + 'ms')), GIT_VAULT_TIMEOUT_MS);
    if (t && typeof t.unref === 'function') t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Epoch 1 (ML-KEM-1024) is a BEST-EFFORT dual-read window. Its blob may not exist and its
// decapsulate grant is unproven -- only vault-kem-xwing has been observed working -- so it
// never blocks and never fails anything. It is RETRIED until it settles, because the git-object
// registry has no lazy per-read fallback the way the lake does: one transient blip at arm time
// would otherwise cost that instance epoch-1 reads for its whole life. A missing blob counts as
// settled; that is the documented normal state, not a failure worth retrying forever.
async function armGitVaultEpoch1(): Promise<void> {
  if (_gitVaultE1Settled) return;
  try {
    const spec = VAULT_KEM_SPEC['1'];
    if (!spec) { _gitVaultE1Settled = true; return; }
    const gt = require('./gittools.js');
    const ex = await gitVaultDeadline(getStorage().bucket(pcLakeBucket()).file(spec.path).exists(), 'epoch 1 blob probe');
    if (!(ex && ex[0])) { _gitVaultE1Settled = true; return; }
    gt.setVaultMasterForEpoch(1, await gitVaultDeadline(vaultMasterForEpoch(1), 'epoch 1 KEM decapsulate'));
    _gitVaultE1Settled = true;
    console.log('[gittools] git-object vault dual-read now covers epoch(s): ' + gt.loadedVaultEpochs().join(','));
  } catch (e: any) {
    console.warn('[gittools] epoch 1 dual-read not armed, will retry: ' + String(e && e.message ? e.message : e));
  }
}

function ensureGitVaultMaster(): Promise<number[]> {
  if (!_gitVaultPromise) {
    // Epoch 2 (KEM_XWING) is REQUIRED and is deliberately NOT wrapped in a catch here. The
    // rejection propagates to every caller and to the boot arm, which logs it by name.
    const p = (async () => {
      const gt = require('./gittools.js');
      if (!gt || typeof gt.setVaultMasterForEpoch !== 'function') {
        throw new Error('[gittools] gittools.js does not export setVaultMasterForEpoch; the git object registry cannot be armed');
      }
      gt.setVaultMasterForEpoch(VAULT_EPOCH, await gitVaultDeadline(vaultMasterForEpoch(VAULT_EPOCH), 'epoch ' + VAULT_EPOCH + ' KEM decapsulate'));
      // Read the epoch list back THROUGH THE SAME BUNDLE EXPORT. If the setter had landed in a
      // different module instance this list would come back without epoch 2.
      const eps: number[] = (typeof gt.loadedVaultEpochs === 'function') ? gt.loadedVaultEpochs() : [];
      if (!eps || eps.indexOf(VAULT_EPOCH) < 0) {
        throw new Error('[gittools] registry did not retain epoch ' + VAULT_EPOCH + '; module identity mismatch, the writers read a different registry');
      }
      // Epoch NUMBERS only. The [gittools] prefix is not decoration: deploy-store.py step 6
      // filters Cloud Logging on textPayload:"[gittools]", so this line is fetched and printed
      // by the deploy that lands it. It is NOT one of the two literals step 6 branches on, and
      // this comment does not claim otherwise.
      console.log('[gittools] git-object vault registry armed for epoch(s): ' + eps.join(','));
      return eps;
    })();
    _gitVaultPromise = p;
    // Un-memoise a failure so a later caller retries, mirroring vaultMasterForEpoch. The
    // rejection is still delivered to every caller; this handler only clears the cache.
    p.catch(() => { if (_gitVaultPromise === p) { _gitVaultPromise = null; } });
  }
  const cur = _gitVaultPromise;
  return cur.then((eps) => { void armGitVaultEpoch1(); return eps; });
}
// [PCV1-GIT-VAULT-WIRE-V2] BRIDGE END

// [PCV1-GIT-VAULT-WIRE-V2] BOOT-ARM BEGIN
// DEFERRED to setImmediate on purpose: it runs after module evaluation completes, so it cannot
// interact with declaration order anywhere in this file and it cannot make a load failure of the
// gittools bundle fatal. Today that bundle is required only inside a catch-and-log; promoting it
// to an unguarded boot require would turn a defect scoped to seven git tools into a container
// that never listens. NON-FATAL AND LOUD: the process keeps serving, and the reason is named
// once at boot instead of only at the first write.
setImmediate(() => {
  void ensureGitVaultMaster().catch((e: any) => {
    console.error('[gittools] git-object vault registry NOT armed at boot: ' + String(e && e.message ? e.message : e) + ' -- git object writes will FAIL CLOSED at the write site until an MCP connection re-arms it');
  });
});
// [PCV1-GIT-VAULT-WIRE-V2] BOOT-ARM END

function vaultObjKey(master: Buffer, path: string, epoch: number): Buffer {
  const info = Buffer.concat([Buffer.from('pcv1:', 'ascii'), Buffer.from(path, 'utf8'), Buffer.from(':e', 'ascii'), Buffer.from([epoch])]);
  return Buffer.from(vCrypto.hkdfSync('sha256', master, VAULT_HKDF_SALT, info, 32));
}
function vaultEncryptSync(master: Buffer, path: string, plaintext: Buffer | string): Buffer {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const nonce = vCrypto.randomBytes(12);
  const header = Buffer.concat([VAULT_MAGIC, Buffer.from([VAULT_EPOCH]), Buffer.from([0x00]), nonce]);
  const aad = Buffer.concat([VAULT_MAGIC, Buffer.from([VAULT_EPOCH]), Buffer.from([0x00]), Buffer.from(path, 'utf8')]);
  const key = vaultObjKey(master, path, VAULT_EPOCH);
  const cipher = vCrypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, ct, tag]);  // magic|epoch|flags|nonce|ct|tag  (== envelope.py)
}
function vaultDecryptSync(master: Buffer, path: string, blob: Buffer): string {
  if (!(blob && blob.length >= 4 && blob.slice(0, 4).equals(VAULT_MAGIC))) return blob.toString('utf8');  // legacy plaintext dual-read
  const epoch = blob[4];
  const nonce = blob.slice(6, 18);
  const rest = blob.slice(18);
  const tag = rest.slice(rest.length - 16);
  const ct = rest.slice(0, rest.length - 16);
  const aad = Buffer.concat([blob.slice(0, 4), Buffer.from([epoch]), Buffer.from([0x00]), Buffer.from(path, 'utf8')]);
  const key = vaultObjKey(master, path, epoch);
  const d = vCrypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
// Transparent lake WRITE: encrypt unless the path is cleartext-allowlisted. FAIL-CLOSED — if the master
// cannot load, a non-cleartext write THROWS (never silently writes plaintext).
async function harWriteLake(path: string, body: Buffer | string, contentType?: string, meta?: { [k: string]: string }): Promise<void> {
  const file = getStorage().bucket(pcLakeBucket()).file(path);
  const ct = contentType || 'application/octet-stream';
  // [PCV1-LAKE-TOOLS-V1] `meta` is OPTIONAL custom object metadata (owner, tags) so the MCP lake tools can
  // route through here without losing what they used to set on their own storage write. Omitting it
  // reproduces the previous behaviour byte-for-byte for the three original callers.
  if (vaultIsCleartext(path)) {
    await file.save(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'), meta ? { contentType: ct, metadata: { metadata: meta } } : { contentType: ct });
    return;
  }
  const master = await vaultMaster();
  const enc = vaultEncryptSync(master, path, body);
  // The stored bytes ARE binary, so the object contentType is octet-stream. The caller's intended
  // type is preserved in custom metadata (pcv1_ct) so it survives the round trip.
  await file.save(enc, { contentType: 'application/octet-stream', metadata: { metadata: Object.assign({}, meta || {}, { pcv1: '1', pcv1_ct: ct }) } });
}

// [PCV1-LAKE-TOOLS-V1] Dual-read decode for ONE lake object, shared by harReadLake and the read_file MCP
// tool so there is exactly ONE implementation of the rule.
// NO PCV1 MAGIC => RETURN THE BYTES AS-IS. Every object in the lake today predates encryption and
// is plaintext; a read path that assumed ciphertext would brick every existing read in the fleet
// the moment it landed. A PCV1 object is decrypted with the master for the epoch byte IT carries
// at blob[4] -- never the current write epoch -- so epoch-1 objects still resolve after the
// KEM_XWING pivot. This THROWS on a decrypt failure, deliberately.
async function harDecryptLakeBuf(path: string, blob: Buffer): Promise<string> {
  if (!(blob && blob.length >= 4 && blob.slice(0, 4).equals(VAULT_MAGIC))) return blob ? blob.toString('utf8') : '';
  return vaultDecryptSync(await vaultMasterForEpoch(blob[4]), path, blob);
}
// [PCV1-LAKE-TOOLS-V1] THE BLANKET `catch { return '' }` IS GONE. It made a wrong master, a KMS outage and a
// corrupt object indistinguishable from an empty file, and that is what hid the encryption
// breakage for thirteen days. ABSENCE STAYS SOFT and still returns '': the exists() check below,
// and a 404 losing the race with download(), both yield '' exactly as before, which every caller
// already reads as "not there". Everything else -- a decrypt failure above all -- now propagates.
// Every call site was checked first: each either wraps this in its own try/catch or sits inside
// waGate/harFail or a .catch() chain, so a throw surfaces as a real message, never an empty file.
async function harReadLake(path: string): Promise<string> {
  const f = getStorage().bucket(pcLakeBucket()).file(path);
  let blob: Buffer = Buffer.alloc(0);
  try {
    const ex = await f.exists();
    if (!ex[0]) return '';
    const b = await f.download();
    blob = b[0];
  } catch (e: any) {
    const code = Number((e && (e.code !== undefined ? e.code : e.status)) || 0);
    if (code === 404) return '';
    throw e;
  }
  return await harDecryptLakeBuf(path, blob);
}
// [CHAT-REFLECT-USAGE-V1] THE REFLECTION CALL WAS A MODEL CALL THAT COST NOTHING ON PAPER.
// harReflect() below runs a full LESSONS distillation -- up to 16000 tokens of conversation
// plus the current LESSONS file plus the shared preferences -- through harChatClaude() or
// harChatGemini(), and BOTH of those return { text, usage }. It kept `.text` and dropped
// `.usage` on the floor. Nothing else recorded it either: the token_usage write in /api/chat
// covers the turn the human typed and runs BEFORE this is called, in the same handler, so the
// largest single model call this console makes was the one call with no row behind it.
// /api/dash/usage and /api/usage both read the token_usage collection and nothing else, so
// that spend was invisible to every cost surface the fleet has.
//
// A ZERO IS NOT AN ACCEPTABLE STAND-IN FOR AN ABSENT MEASUREMENT, and that rule is already in
// this file: /api/usage refuses to guess a missing price and answers cost_usd:null with
// prices_configured:false rather than 0. The same reasoning applies one level down. A
// token_usage row carrying four zeros is indistinguishable from a call that genuinely used no
// tokens, and BOTH readers above SUM every document they see -- so such a row does not merely
// fail to inform, it makes the table wrong in the direction that looks safe.
//
// SO THERE ARE TWO OUTCOMES AND THEY GO TO DIFFERENT PLACES.
//   MEASURED   -- the provider returned a usage object with at least one usable numeric field.
//                 A normal token_usage row is written, field for field the same shape the
//                 /api/chat handler writes, so the existing readers pick it up unchanged.
//   UNMEASURED -- no usage object at all, or one this cannot read. That state is REAL and not
//                 defensive padding: harChatClaude returns `usage: (j && j.usage) || null` and
//                 harChatGemini returns null whenever the response carries no usageMetadata,
//                 which is exactly what a Vertex rawPredict answer missing the field yields.
//                 NO token_usage row is written. A row goes to token_usage_gaps instead,
//                 carrying agent, model, source and what was seen, and carrying NO token
//                 counts at all -- there is nothing honest to put in them.
//
// WHY A SEPARATE COLLECTION RATHER THAN A FLAG ON THE ROW. Both readers of token_usage sum
// every document they see and neither knows about a flag. Writing `measured:false` onto a row
// IN token_usage would land a four-zero row in the cost table today and rely on a later edit to
// two other handlers to stop it being summed -- the zero that lies, with an extra step. A gap
// belongs somewhere nothing can add it up. token_usage_gaps is write-only from here, needs no
// index because nothing queries it, and is countable the moment anyone wants to count it.
//
// A MISSING FIELD INSIDE A PRESENT USAGE OBJECT IS NOT A GAP. The Messages API omits
// cache_read_input_tokens when nothing was read from cache; that is a MEASURED zero and is
// written as one, exactly as /api/chat already does. A missing OBJECT is the gap. harUsageOk()
// is where that line sits, and it is the only place it sits.
function harUsageOk(u: any): boolean {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  const F = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  let seen = 0;
  for (let i = 0; i < F.length; i++) {
    const v = u[F[i]];
    if (v === undefined || v === null) continue;   // absent field: the provider reported none of this kind
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return false;   // present but unusable: the whole object is
    seen++;
  }
  return seen > 0;
}
// NEVER THROWS. Same contract as the token_usage write in /api/chat and as harJournalAs(): a
// telemetry failure must not break the caller. Note that harReflect's own body is inside one
// big try/catch, so a throw here would be swallowed silently and the gap would be lost twice.
async function harRecordUsage(agentId: string, model: string, source: string, usage: any): Promise<void> {
  try {
    if (harUsageOk(usage)) {
      await db.collection('token_usage').add({
        agent: agentId, model: model, source: source,
        input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        ts: FieldValue.serverTimestamp(),
      });
      return;
    }
    await db.collection('token_usage_gaps').add({
      agent: agentId, model: model, source: source,
      reason: 'UNMEASURED: the provider response carried no usable usage object. This call HAPPENED and its cost is unknown. It is deliberately NOT written to token_usage, because a row of zeros there would be summed as a real zero by /api/dash/usage and /api/usage.',
      saw: (usage === null || usage === undefined) ? 'absent' : (Array.isArray(usage) ? 'array' : typeof usage),
      ts: FieldValue.serverTimestamp(),
    });
  } catch (e) {}
}
async function harReflect(agentId: string, provider: string, apiModel: string, key: string): Promise<void> {
  try {
    const hist = await harRecentHistory(agentId, 16000);
    if (hist.length < 6) return;
    // [STRAINLIFE-LESSONS-CASE-V1] CANONICAL NAME IS UPPERCASE. The bootstrap paste tells every strain to
    // read agents/<strain>/LESSONS.md and /api/strain/create writes that name; harReflect used to
    // read and write the lowercase spelling, so on a case-sensitive object store the distilled
    // memory was invisible to the next chat. Fix is a READ-FALLBACK, not a rename sweep: the lake
    // has no delete, so a sweep would copy and leave the old object behind and keep the ambiguity
    // alive forever. Reading new-then-old and always writing uppercase converges each strain on
    // its first reflection, with no privileged job over other roles' private folders.
    let curLessons = await harReadLake('agents/' + agentId + '/LESSONS.md');
    if (!curLessons) curLessons = await harReadLake('agents/' + agentId + '/lessons.md');
    const growerPrefs = (await harReadLake('shared/bootstrap/grower-preferences.md')).slice(0, 2500);
    const convo = hist.map((h: any) => (h.role === 'ag' ? 'ASSISTANT' : 'GROWER') + ': ' + String(h.text || '').slice(0, 1200)).join('\n');
    const sys = 'You maintain the long-term LESSONS file for the strain "' + agentId + '". Distill from the conversation what is CRITICAL so the strain improves with less grower effort: durable facts, the grower stated preferences and laws, corrections the grower made, decisions taken, ways of working that worked, and open threads. SCORE by importance (grower-emphasised > corrections > repeated > decisions) and PRUNE to the essentials, aim under ~1500 words. Output ONLY the new lessons.md content in markdown, no preamble.';
    const usr = 'GROWER PREFERENCES (already known globally - do NOT duplicate; capture only strain-specific lessons):\n' + growerPrefs + '\n\nCURRENT lessons.md:\n' + (curLessons || '(none yet)') + '\n\nRECENT CONVERSATION:\n' + convo + '\n\nReturn the updated lessons.md now.';
    let out = '';
    // [CHAT-REFLECT-USAGE-V1] the result object is HELD now, not dereferenced to .text and
    // thrown away. Recorded BEFORE the lake write below, deliberately: that write can throw,
    // the outer catch swallows it, and losing the record of a call that already cost money
    // because the file it produced could not be stored is the wrong order of operations.
    // `apiModel` is the model attribute, matching the /api/chat write exactly so by_model in
    // /api/usage does not gain a second key for the same model.
    if (provider === 'gemini') {
      const gr = await harChatGemini(apiModel, key, sys, [{ role: 'me', text: usr }]);
      out = gr.text;
      await harRecordUsage(agentId, apiModel, 'web-chat-reflect', gr.usage);
    } else {
      const cr = await harChatClaude(apiModel, key, sys, [{ role: 'me', text: usr }]);
      out = cr.text;
      await harRecordUsage(agentId, apiModel, 'web-chat-reflect', cr.usage);
    }
    if (out && out.trim() && out.indexOf('(no text)') < 0) {
      await harWriteLake('agents/' + agentId + '/LESSONS.md', out.slice(0, 8000), 'text/markdown; charset=utf-8');
    }
  } catch (e) {}
}
// ==================== [CHAT-ONE-REGISTRY-V49] ONE TOOL REGISTRY ====================
// ONE DEFINITION, ONE FILTER, TWO MODELS. Read this before adding a tool to either surface.
//
// WHAT WAS HERE BEFORE, MEASURED. harToolDefs() far above is a HAND-WRITTEN list of TEN tool
// schemas, and it was the entire tool surface of this console. buildMcpServer() registers
// FORTY-FIVE. The chat therefore saw about a fifth of the fleet's own toolset, and the fifth
// it saw was read-only: no run_command, no gcp_api, none of the seven git tools, no vm_*.
// Two registries for one product, one of them maintained by hand, is drift BY CONSTRUCTION --
// every tool added to the MCP surface after that list was written was invisible here and
// nothing anywhere said so. A second hand-maintained copy of a tool table is exactly what
// this block replaces; do not write a third.
//
// WHAT IT IS NOW. The chat's definitions are DERIVED from the same registration table the MCP
// wire is built from: buildMcpServerAdmitted() -> the registerTool shadow -> server.__pcTools,
// which is the ONE place where "the tools this role actually has" is a FACT rather than a
// re-derivation. It is the same call, with the same arguments, that mcpServeModern()'s tools()
// callback makes for the 2026-07-28 wire, and it uses the same zod->JSON Schema converter
// (mcp2026SchemaOf). There is no second list to maintain and no second filter to keep in step.
//
// AUTHORITY IS NOT WIDENED BY THIS. That is the whole safety claim, and each clause of it is a
// thing that happens ABOVE this code, not a thing re-implemented in it:
//   - ADMISSION runs first and unchanged. buildMcpServerAdmitted() asks mcpStrainAdmit(); an
//     unprovisioned or inactive strain is handed buildDeniedMcpServer(), which never goes
//     through the shadow, so __pcTools is ABSENT and the chat gets ZERO mcp tools -- not a
//     tool that is present and fails on call.
//   - THE STRAIN'S TOOL CLASSES are applied by that same shadow: pcToolClasses(role) read
//     against PC_TOOL_CLASS, under PC_TOOLS_ENFORCE, with the same tool_surface_withheld
//     journal line. A tool the shadow declines to register is absent from __pcTools and is
//     therefore absent HERE, with no code in this block making that decision a second time.
//   - A SESSION KEY'S NARROWING (session_keys.tool_classes -> pcNarrowClasses, which can only
//     ever SUBTRACT from the strain set) rides the SAME `keyClasses` parameter, threaded and
//     never re-derived. This route presents no session key: /api/chat is guarded by waGate,
//     i.e. by the operator's own console session, and the body carries a strain NAME picked in
//     the console, not a credential. So it passes undefined and the strain's own classes
//     decide, exactly as the /mcp/:token connector mount does. If a key is ever accepted on
//     this route, its .tc is passed in HERE and nowhere else.
//   - ENV WITHHOLDING is inherited for free, because it also happens inside buildMcpServer
//     above __pcTools: WS_CDP_PORT (browser_*), PC_BROWSER_EVAL, WS_VM/WS_ZONE (vm_*) and
//     registerGitTools()'s own GIT_REPO_ID refusal.
//   - PC_SURFACE IS NOT A TOOL FILTER and is deliberately not consulted. It decides which
//     ROUTES a copy of this image registers (PC_SURFACE_MAP); no tool registration reads it,
//     and there is no per-surface tool set to honour. /api/chat is on the console surface and
//     /mcp is on the mcp surface, and both build their toolset from this one function, which
//     is the point: a strain's tools do not depend on which half of the split it reaches.
//
// EXECUTION IS THE EXISTING PATH, NOT A SECOND ONE. run() calls the handler recorded in
// __pcTools -- the pcCapWrap-wrapped closure the MCP transports call, closed over who() and the
// already-resolved role. PC_AUTO_APPROVE, PC_GUARDRAILS, pcAdmitStage, the KMS-signed approval
// and every journal write happen INSIDE it, unchanged and unreachable from here. A destructive
// command issued from this console therefore behaves exactly as the same command arriving over
// MCP, including its refusals. Nothing in this block inspects a tool name to decide anything.
//
// THE CHAT-ONLY TOOLS SURVIVE, BY SET DIFFERENCE RATHER THAN BY HAND. harOpsTools() still
// describes ten; five of them (read_journal, list_work_items, cancel_work_item,
// complete_work_item, read_job_log) are ALSO registered on the MCP surface, and there the MCP
// definition wins because one registry is the entire point. The other five (status_digest,
// dispatch, check, read_lake, cowork_prompt) exist nowhere else and are appended. NOTHING HERE
// NAMES THOSE FIVE: the split is computed against the live MCP registry at request time, so a
// chat-only tool later promoted to a real MCP tool stands aside on its own instead of
// shadowing it, and a chat-only tool that is deleted disappears without an edit here.
//
// COST. One extra buildMcpServerAdmitted() per chat turn -- one cached strains read, then the
// same registration work mcpServeModern() does per tools/list. The wire size of the tool block
// is MEASURED and logged per request below rather than guessed at, and nothing is truncated: a
// silently trimmed tool list is a tool the model cannot see and cannot be told about.
type HarChatTool = { name: string; description: string; schema: any; run: (input: any) => Promise<string> };

// An MCP handler answers { content: [{ type:'text', text }], isError? }; a chat tool result is
// one string. Text blocks are joined, anything else is shown as JSON rather than dropped, and
// isError is stated IN WORDS because this string is all the model sees -- a failure that
// arrives looking like a success is how an agent reports work it did not do.
function harMcpResultText(r: any): string {
  if (r === null || typeof r === 'undefined') return '(no result)';
  if (typeof r === 'string') return r;
  const parts: string[] = [];
  const c: any = r.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b) parts.push(JSON.stringify(b));
    }
  }
  let t = parts.join('\n');
  if (!t) t = JSON.stringify(r);
  return r.isError ? ('TOOL ERROR: ' + t) : t;
}

async function harChatToolset(agentId: string, keyClasses?: any): Promise<HarChatTool[]> {
  const who = agentId || 'fleet-advisor';
  const out: HarChatTool[] = [];
  const seen: { [k: string]: boolean } = {};
  let nMcp = 0;
  try {
    const built: any = await buildMcpServerAdmitted(who, keyClasses);
    const rec: any[] = (built && built.__pcTools) || [];
    // Closed like mcpServeModern does: the recorded handlers are plain closures and do not
    // need the server object to stay open.
    try { built.close(); } catch (e) {}
    for (const t of rec) {
      if (!t || !t.name || seen[String(t.name)]) continue;
      const nm = String(t.name);
      seen[nm] = true;
      const h = t.handler;
      out.push({
        name: nm,
        description: String((t.spec && t.spec.description) || ''),
        schema: mcp2026SchemaOf(nm, t.spec && t.spec.inputSchema),
        run: async (input: any) => harMcpResultText(await h(input || {}))
      });
      nMcp++;
    }
    if (!nMcp) console.warn('[chat/tools] ' + who + ' was handed NO mcp tools: admission refused this '
      + 'principal, or every class it holds was withheld. The console tools below are all it gets.');
  } catch (e: any) {
    // LOUD, and the chat still answers. The alternative -- failing the whole turn because the
    // registry could not be built -- takes away the console the operator would use to find out why.
    console.error('[chat/tools] mcp toolset unavailable for ' + who + ': '
      + String((e && e.message) || e) + ' -- serving the console-only tools.');
  }
  for (const d of harOpsTools(who)) {
    if (!d || !d.name || seen[String(d.name)]) continue;
    const nm = String(d.name);
    seen[nm] = true;
    out.push({
      name: nm,
      description: String(d.description || ''),
      schema: d.input_schema || { type: 'object', properties: {} },
      run: async (input: any) => await harRunChatTool(nm, input || {}, who)
    });
  }
  try {
    const bytes = Buffer.byteLength(JSON.stringify(harClaudeToolWire(out)), 'utf8');
    console.log('[chat/tools] agent=' + who + ' tools=' + out.length + ' (mcp=' + nMcp
      + ' console=' + (out.length - nMcp) + ') claude_wire_bytes=' + bytes
      + ' approx_tokens=' + Math.round(bytes / 3.5)
      + ' -- sent on every request of this turn; the 1h cache breakpoint on the second-to-last '
      + 'message sits AFTER the tool block, so a cached turn reads it at 0.1x rather than resending it.');
  } catch (e) {}
  return out;
}

// The ONE dispatcher handed to both model loops. It does not know what a tool is; it looks the
// name up in the set that was advertised and calls that entry's run().
function harChatExec(ts: HarChatTool[]): (name: string, input: any) => Promise<string> {
  return async (name: string, input: any) => {
    for (let i = 0; i < ts.length; i++) if (ts[i].name === name) return await ts[i].run(input || {});
    return 'unknown tool ' + name;
  };
}

// Anthropic wire shape. The schema goes out exactly as the MCP surface publishes it.
function harClaudeToolWire(ts: HarChatTool[]): any[] {
  return ts.map((t: HarChatTool) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

// ---- Gemini functionDeclarations: the ONLY place the shared definitions are reshaped ----
// Gemini's function-calling schema is a SUBSET of JSON Schema (the Vertex `Schema` message), and
// it rejects the request outright on a keyword it does not know -- so an unsanitised pass-through
// costs the whole toolset, not one field. This is a boundary converter and nothing else: it never
// adds, removes or renames a TOOL, only rewrites the shape of one already decided above.
//
// STRIPPED, and why each one is safe to drop:
//   $schema             dialect marker; not a constraint.
//   additionalProperties  zod emits `false` on every object; Gemini has no such field. Dropping
//                       it only stops the model being TOLD that extra keys are refused -- the
//                       handler's own validation is unchanged and still refuses them.
//   propertyNames       emitted by z.record(); no equivalent. The key type is lost.
//   $defs / definitions / $ref  zod 4 inlines every one of our shapes (measured: no $ref in any
//                       of the 45), so this is defensive -- a $ref is resolved against the root
//                       and, if unresolvable, degraded to a plain string rather than sent.
//   anyOf/oneOf         collapsed: [X, null] becomes X with nullable:true, which is how Gemini
//                       spells the same thing. A wider union keeps its FIRST member; nothing
//                       here is a real union today except .nullable().
//   const, exclusiveMinimum/Maximum, allOf, and any other unknown keyword: not copied, because
//                       the keep-list below is an ALLOWLIST. A keyword nobody has checked is
//                       exactly the one that 400s the request.
// REWRITTEN:
//   type                lower-case JSON Schema names -> the canonical proto-JSON enum spelling
//                       (STRING/NUMBER/INTEGER/BOOLEAN/ARRAY/OBJECT).
//   an EMPTY schema     z.any() converts to `{}`, which has no type at all; Gemini needs one, so
//                       it is declared STRING. This is the one place a type is INVENTED, and it
//                       is a widening only in the model's description of an argument the handler
//                       still validates itself (today: the `observations` array members).
//   a free-form OBJECT  z.record() loses its value schema and becomes an OBJECT with no declared
//                       properties (today: post_work_item.payload, git_propose_patch
//                       .expected_blob_sha). Still an object; just undescribed.
//   parameters          OMITTED ENTIRELY when the tool has no properties, rather than sent as an
//                       empty OBJECT, which some Vertex versions refuse.
const HAR_GEM_TYPES: { [k: string]: string } = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
const HAR_GEM_KEEP = ['description', 'enum', 'title', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern'];
const HAR_GEM_FORMATS: { [k: string]: string[] } = { STRING: ['date-time', 'enum'], INTEGER: ['int32', 'int64'], NUMBER: ['float', 'double'] };
function harGeminiSchema(node: any, root: any, depth: number): any {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) return { type: 'STRING' };
  let n: any = node;
  let hops = 0;
  while (n && typeof n.$ref === 'string' && hops++ < 8) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(n.$ref);
    const bag: any = (m && root && root[m[1]]) || null;
    const tgt: any = (bag && m) ? bag[m[2]] : null;
    if (!tgt || typeof tgt !== 'object') return { type: 'STRING' };
    n = tgt;
  }
  const alts: any[] = Array.isArray(n.anyOf) ? n.anyOf : (Array.isArray(n.oneOf) ? n.oneOf : []);
  if (alts.length) {
    const real = alts.filter((a: any) => !(a && a.type === 'null'));
    const nullable = real.length !== alts.length;
    if (!real.length) return { type: 'STRING', nullable: true };
    const first: any = harGeminiSchema(real[0], root, depth + 1);
    if (nullable) first.nullable = true;
    if (typeof n.description === 'string' && !first.description) first.description = n.description;
    return first;
  }
  let ty: any = n.type;
  let nullable = false;
  if (Array.isArray(ty)) { nullable = ty.indexOf('null') >= 0; ty = ty.filter((x: any) => x !== 'null')[0]; }
  let t = HAR_GEM_TYPES[String(ty || '').toLowerCase()] || '';
  if (!t) t = n.properties ? 'OBJECT' : (n.items ? 'ARRAY' : 'STRING');
  const out: any = { type: t };
  if (nullable) out.nullable = true;
  for (let i = 0; i < HAR_GEM_KEEP.length; i++) { const k = HAR_GEM_KEEP[i]; if (typeof n[k] !== 'undefined') out[k] = n[k]; }
  if (typeof n.format === 'string' && (HAR_GEM_FORMATS[t] || []).indexOf(n.format) >= 0) out.format = n.format;
  if (t === 'OBJECT') {
    const props: any = (n.properties && typeof n.properties === 'object') ? n.properties : null;
    if (props) {
      const p: any = {};
      const keys = Object.keys(props);
      for (let i = 0; i < keys.length; i++) p[keys[i]] = harGeminiSchema(props[keys[i]], root, depth + 1);
      if (keys.length) out.properties = p;
    }
    if (Array.isArray(n.required) && out.properties) {
      const req = n.required.filter((x: any) => typeof x === 'string' && typeof out.properties[x] !== 'undefined');
      if (req.length) out.required = req;
    }
  } else if (t === 'ARRAY') {
    out.items = harGeminiSchema(n.items, root, depth + 1);
  }
  return out;
}
function harGeminiToolWire(ts: HarChatTool[]): any[] {
  const decls = ts.map((t: HarChatTool) => {
    const d: any = { name: t.name, description: t.description };
    const p: any = harGeminiSchema(t.schema, t.schema, 0);
    if (p && p.type === 'OBJECT' && p.properties && Object.keys(p.properties).length) d.parameters = p;
    return d;
  });
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

// The Gemini transport for the tool-capable path. Every DECISION about where the request goes --
// transport, region, host, project, credential -- comes from the same four resolvers
// harChatGemini() uses (harGeminiTransport / harVertexGeminiRegion / harVertexProject /
// harVertexHost), so the two cannot disagree about the destination; only the URL assembly is
// written twice. Folding the toolless sibling into this poster is the obvious next cut and is
// deliberately NOT done here: it would rewrite the path that is working, in a change whose
// subject is the tool surface.
// [SEC-FLEETMODE-CONSOLE-V1] A CONSOLE TRANSPORT, not behind the spend switch, for the reason
// written out in full at harClaudePost(): its only caller is POST /api/chat, which runs because
// a signed-in human pressed send. There is no unattended caller here to stop.
async function harGeminiPost(apiModel: string, key: string, payload: any): Promise<{ r: any; j: any; hostDesc: string }> {
  let url = 'https://generativelanguage.googleapis.com/v1beta/models/' + apiModel + ':generateContent?key=' + encodeURIComponent(key);
  let headers: any = { 'Content-Type': 'application/json' };
  let hostDesc = 'host=generativelanguage.googleapis.com transport=studio';
  if (harGeminiTransport(key) === 'vertex') {
    const region = harVertexGeminiRegion(apiModel);
    const project = harVertexProject();
    const vhost = harVertexHost(region);
    const tok = await waAccessToken();
    url = 'https://' + vhost + '/v1/projects/' + project + '/locations/' + region + '/publishers/google/models/' + apiModel + ':generateContent';
    headers['Authorization'] = 'Bearer ' + tok;
    hostDesc = 'host=' + vhost + ' transport=vertex region=' + region + ' project=' + project;
  }
  // [MODEL-LONGRUN-V1] model POST site 3 of 3 (Gemini, tool-capable path). This is the one the
  // 16-round loop hammers, so it is the site the ceiling was most likely to reach first.
  const r = await waFetchLong(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let j: any = null;
  try { j = await r.json(); } catch (e: any) { j = { parse_error: String((e && e.message) || e) }; }
  return { r: r, j: j, hostDesc: hostDesc };
}

// [CHAT-NOTEXT-REPORT-V1] "(no text)" WAS THE CONSOLE THROWING AWAY EVERYTHING IT KNEW.
// MEASURED on a real install: the operator asked a strain to build a calculator, the model made
// five correct tool calls, and the chat rendered "FLEET GCP - GEMINI / (no text)" -- twice. The
// RAN/STAGED word and the stderr, the only strings that diagnose a failure, never reached the
// screen. The tool results existed; they were sitting in the loop's own `contents` array and were
// dropped on the floor at the return statement.
//
// WHY GEMINI HITS THIS AND CLAUDE MOSTLY DOES NOT, so nobody "fixes" it by blaming one model:
// both loops keep the LAST turn that carried text and return it. Claude nearly always emits a
// text block ALONGSIDE its tool_use, so finalText is populated on the way through. Gemini
// frequently returns parts containing ONLY functionCall and no text at all, so finalText is still
// empty when the loop ends -- and then the fallback fired. Same latent hole in both; only the
// odds differ, which is why this is applied to BOTH loops rather than to the Gemini one.
//
// THIS CANNOT REGRESS A WORKING TURN. It runs only where the old code had already decided it had
// nothing, i.e. exactly where "(no text)" would have printed.
function harChatNoTextReport(trace: string[], stopReason: string, exhausted: boolean, rounds: number): string {
  const out: string[] = [];
  if (trace.length) {
    out.push('The model ran ' + trace.length + ' tool call(s) and then ended its turn without writing a reply.');
    out.push('What those calls returned:');
    for (const t of trace) out.push('  - ' + t);
  } else {
    out.push('The model returned no text and called no tools.');
  }
  if (exhausted) {
    out.push('It also hit the ' + rounds + '-round tool limit, so it was cut off part-way through the task rather than finishing. Ask it to continue.');
  }
  if (stopReason && stopReason !== 'STOP' && stopReason !== 'end_turn') {
    out.push('stop reason: ' + stopReason
      + (stopReason === 'MAX_TOKENS' || stopReason === 'max_tokens'
         ? ' -- the reply was truncated by the output token limit, which is why there is no prose.' : ''));
  }
  out.push('(Written by the console because the model produced no final text. This used to print only "(no text)" and discard everything above it.)');
  return out.join(chr10());
}
function chr10(): string { return String.fromCharCode(10); }
// GEMINI'S TOOL LOOP. It did not have one: the chat's only tool-capable path was Claude's, so a
// strain the operator opened on Gemini could describe the fleet and touch none of it. Same
// definitions, same dispatcher, same bound of 8 rounds and same 12,000-character result slice as
// harChatClaudeOps -- the ONLY thing that differs is the wire shape, converted at the boundary
// above. No second executor: `exec` is harChatExec() over the very same array Claude is handed.
async function harChatGeminiOps(apiModel: string, key: string, system: string, msgs: any[], toolset: HarChatTool[], agentId: string, exec: (name: string, input: any) => Promise<string>): Promise<{ text: string; usage: any }> {
  const contents: any[] = msgs.map((m: any) => ({ role: m.role === 'me' ? 'user' : 'model', parts: [{ text: String(m.text || m.content || '') }] }));
  // [CHAT-GEMINI-TRAILING-MODEL-V75] GEMINI REFUSES A REQUEST WHOSE LAST TURN IS THE MODEL'S.
  // MEASURED on prod: 'gemini host=aiplatform.googleapis.com transport=vertex region=global
  // model=gemini-3.7-flash tools=55 HTTP 400: Requests ending with a model turn are not
  // supported.' The history handed to this function is whatever the client holds, and there are
  // ordinary ways for it to end on an assistant turn -- a continue/retry action that re-sends the
  // transcript without adding a user message being the obvious one, which is EXACTLY what
  // harChatNoTextReport tells the operator to do when a turn is cut off at the round limit. So
  // this fleet's own advice could produce a 400.
  // APPEND RATHER THAN TRUNCATE, deliberately: dropping the trailing model turn would throw away
  // the very message the operator is asking the model to continue from, and the model would
  // resume from a transcript that no longer contains its own last words. One minimal user turn
  // satisfies the API and preserves the whole history.
  if (contents.length && contents[contents.length - 1].role === 'model') {
    contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  }
  const tools = harGeminiToolWire(toolset);
  const sum: any = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let measured = false;
  let finalText = '';
  let guard = 0;
  const trace: string[] = [];
  let stopReason = '';
  // [CHAT-ROUNDS-16-V74] 8 WAS TOO FEW FOR THE ONE FLOW THIS CONSOLE EXISTS TO DO. MEASURED on a
  // fresh install: asked to build and deploy a calculator, the model spent its eight rounds on
  // orient, write files, submit, diagnose a 403, re-stage, re-submit -- and was cut off before it
  // ever reached `gcloud run deploy`. The BUILD AND DEPLOY prompt below prescribes write ->
  // submit -> poll -> poll -> deploy -> verify -> clean up, which is already seven rounds with a
  // single poll and no mistakes. A limit that cannot fit the happy path of its own instructions
  // is not a safety bound, it is a bug. 16 fits the prescribed flow twice over and still
  // terminates. The cut-off is reported rather than silent -- see harChatNoTextReport.
  while (guard++ < HAR_CHAT_MAX_ROUNDS) {
    // [CHAT-GEMINI-MAXTOK-V1] Same constant, same reasoning as harChatGemini() above. It is set
    // PER ROUND, which is the same shape harChatClaudeOps has: max_tokens bounds each request in
    // the loop, not the sum across HAR_CHAT_MAX_ROUNDS rounds. A round cut short here still
    // reports itself -- see harChatNoTextReport, which is what the operator reads when a turn
    // ends without text.
    const payload: any = { systemInstruction: { parts: [{ text: system }] }, contents: contents, generationConfig: { maxOutputTokens: HAR_CHAT_MAX_TOKENS } };
    if (tools.length) payload.tools = tools;
    const { r, j, hostDesc } = await harGeminiPost(apiModel, key, payload);
    if (!r.ok) {
      // Same failure text as the toolless path: the upstream message verbatim, redacted, plus the
      // transport remedy -- an opaque 500 here was a real outage nobody could diagnose.
      const um0 = (j && j.error && (j.error.message || j.error.status)) || (j && j.parse_error) || JSON.stringify(j).slice(0, 400);
      throw new Error(harRedact('gemini ' + hostDesc + ' model=' + apiModel + ' tools=' + toolset.length
        + ' HTTP ' + r.status + ': ' + um0 + harChatRemedy(harChatResolved('gemini', key), r.status)));
    }
    const um: any = (j && j.usageMetadata) || null;
    if (um) {
      measured = true;
      sum.input_tokens += Number(um.promptTokenCount || 0) || 0;
      sum.output_tokens += Number(um.candidatesTokenCount || 0) || 0;
      sum.cache_read_input_tokens += Number(um.cachedContentTokenCount || 0) || 0;
    }
    const c: any = (j && j.candidates && j.candidates[0]) || null;
    if (c && c.finishReason) stopReason = String(c.finishReason);
    const parts: any[] = (c && c.content && Array.isArray(c.content.parts)) ? c.content.parts : [];
    const txt = parts.filter((p: any) => p && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
    if (txt) finalText = txt;
    const calls = parts.filter((p: any) => p && p.functionCall && p.functionCall.name);
    if (!calls.length) break;
    contents.push({ role: 'model', parts: parts });
    const answers: any[] = [];
    for (const p of calls) {
      const nm = String(p.functionCall.name);
      let out = '';
      try { out = await exec(nm, p.functionCall.args || {}); }
      catch (e: any) { out = 'tool error: ' + String((e && e.message) || e); }
      answers.push({ functionResponse: { name: nm, response: { result: String(out).slice(0, 12000) } } });
      trace.push(nm + ' -> ' + String(out).replace(/\s+/g, ' ').trim().slice(0, 500));
    }
    contents.push({ role: 'user', parts: answers });
  }
  return { text: finalText || harChatNoTextReport(trace, stopReason, guard > HAR_CHAT_MAX_ROUNDS, HAR_CHAT_MAX_ROUNDS), usage: measured ? sum : null };
}

// The system prompt must not describe a smaller fleet than the model is holding. harOpsSystem()
// lists the old ten by name; this states the ACTUAL set, from the same array that goes on the
// wire, and restates the doctrine that now matters because the console can act rather than only
// look. Appended, never edited into the strain prompts, so the two cannot fall out of step.
function harChatToolSystem(agentId: string, ts: HarChatTool[]): string {
  const base = harOpsSystem(agentId);
  if (!ts.length) return base;
  const names = ts.map((t: HarChatTool) => t.name).slice().sort().join(', ');
  return base + '\n' + [
    'YOUR TOOLSET HERE IS THE SAME ONE YOU HOLD OVER MCP, filtered the same way -- this console and the connector are one product, not two. The tools you actually have right now, and the only ones you have, are: ' + names + '.',
    'That list is the truth. Anything named elsewhere in this prompt that is not in it was withheld from you, and calling it will fail.',
    'IT NOW INCLUDES REAL ACTIONS, NOT ONLY READS. Anything that stages privileged work goes to the human gate exactly as it does over MCP -- and on an install with PC_AUTO_APPROVE set, staging RUNS IT. So: say what you are about to do before you do it, never run a destructive command to find out what it does, and report what actually came back rather than what you expected.',
  ].join('\n');
}
// ================== end [CHAT-ONE-REGISTRY-V49] ==================

// ---- chat ----
app.post('/api/chat', waGate(async (req, res) => {
  // [CHAT-GEMINI-DEFAULT-V1] THIS LINE HARDCODED 'claude' AS THE FALL-THROUGH, so the substrate
  // default was a compile-time constant on the one path in this file that actually spends money.
  // It is now a WHITELIST OF THE TWO KNOWN VALUES falling through to HAR_CHAT_DEFAULT_PROVIDER,
  // which /api/models publishes as default_provider -- server and client now read one source.
  // AN EXPLICIT PROVIDER IN THE BODY STILL WINS, both ways round. That is not incidental: it is
  // the console's toggle, i.e. the operator picking Claude because Gemini is wrong or stuck on
  // this particular question, and it is the entire reason the Gemini default is safe to ship.
  // 'claude' is spelled out rather than left as an else, so an unknown or misspelled provider
  // falls to the configured default instead of silently meaning Claude.
  // VERIFY-GREP: the byte-identical expression ALSO EXISTS in POST /api/keys above and is
  // DELIBERATELY UNCHANGED there -- see the note at that line. Two occurrences, one question
  // each, and they are different questions.
  const provider = (req.body && req.body.provider) === 'gemini' ? 'gemini'
                 : (req.body && req.body.provider) === 'claude' ? 'claude'
                 : HAR_CHAT_DEFAULT_PROVIDER;
  const modelId = String((req.body && req.body.model) || '');
  const message = String((req.body && req.body.message) || '');
  const agentId = String((req.body && req.body.agentId) || '');
  if (agentId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    harJournalAs('harness', 'security_quarantine', 'Refused agentId: bad charset (possible path traversal): ' + String(agentId).slice(0, 64));
    res.status(403).json({ error: 'forbidden: invalid agentId format' });
    return;
  }
  let history = (req.body && req.body.history) || [];
  if (agentId) { const mem = await harRecentHistory(agentId, HAR_MEM_BUDGET_TOK); if (mem.length) history = mem; }
  const key = await harKey(provider);
  // No Anthropic key is NOT an error: harClaudeProvider() now DEFAULTS to Vertex, so a keyless
  // install chats normally. The 412 survives only for an explicit CHAT_CLAUDE_PROVIDER=anthropic
  // with nothing to authenticate with, which is a real misconfiguration and must still be reported.
  // [CHAT-CLAUDE-BOTH-TRANSPORTS-V1] ...and it now says WHICH transport asked for the key and how to
  // get back to the one that needs none, instead of a bare 'no claude API key set' that reads like
  // the install is simply broken. Same resolver as the log line and /api/keys/status.
  if (provider !== 'gemini' && !key && harClaudeProvider() !== 'vertex') {
    const rv = harChatResolved('claude', key);
    res.status(412).json({ error: 'no ' + provider + ' API key set',
      detail: 'CHAT_CLAUDE_PROVIDER selects the direct API (host=' + rv.host + ') and no Claude API key is stored. ' +
        'Vertex needs no key -- it uses this service\'s own credential: ' + rv.alt_switch + ' and redeploy, or store a key in the console.',
      resolved: rv });
    return;
  }
  const apiModel = harApiFor(provider, modelId);
  // [CHAT-OBSERVABLE-V1] ONE line per chat request naming the provider, transport, region, host and
  // model that were actually resolved. Presence-boolean for the key, never the value. The operator
  // can now see what the chat picked without reading this file; /api/keys/status shows the same
  // object. `model` here is the resolved default; `apiModel` is what this request will send.
  try { harLogResolved('POST /api/chat model=' + apiModel + (agentId ? ' agent=' + agentId : ''), harChatResolved(provider, key)); } catch (e) {}
  const system = 'You are ' + (agentId || 'a Paracoding fleet agent') + ', part of the Paracoding.AI fleet. Be concise and useful.';
  const image = (req.body && req.body.image) || null;
  const images = (req.body && Array.isArray(req.body.images)) ? req.body.images : (image ? [image] : []);
  const msgs = [...history, { role: 'me', text: message, image, images }];
  try {
    let reply = ''; let usage: any = null;
    let usedModel = apiModel;
    let usedEffort = (HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
    // [CHAT-ONE-REGISTRY-V49] ONE toolset, built ONCE per turn, handed to whichever model is
    // selected. keyClasses is omitted deliberately and not forgotten: this route's credential is
    // the operator's console session (waGate), not a session key, so there is no per-key
    // narrowing to honour and the strain's own tool_classes decide -- see the block above.
    // No agentId means no strain was picked, so there is no lane to scope tools to and the plain
    // chat runs exactly as it did.
    const toolset: HarChatTool[] = agentId ? await harChatToolset(agentId) : [];
    const toolSystem = agentId ? harChatToolSystem(agentId, toolset) : system;
    const toolExec = harChatExec(toolset);
    if (provider === 'gemini') { if (agentId) { const gr = await harChatGeminiOps(apiModel, key, toolSystem, msgs, toolset, agentId, toolExec); reply = gr.text; usage = gr.usage; } else { const gr = await harChatGemini(apiModel, key, system, msgs); reply = gr.text; usage = gr.usage; } }
    else { if (agentId) { const cr: any = await harChatClaudeOps(apiModel, key, toolSystem, msgs, harClaudeToolWire(toolset), agentId, toolExec); reply = cr.text; usage = cr.usage; if (cr.model) usedModel = cr.model; if (cr.effort) usedEffort = cr.effort; } else { const cr = await harChatClaude(apiModel, key, system, msgs); reply = cr.text; usage = cr.usage; if (cr.model) usedModel = cr.model; if (cr.effort) usedEffort = cr.effort; } }
    // cache hit-rate telemetry: without cache_creation/cache_read counts the caching above is invisible.
    //
    // [CHAT-REFLECT-USAGE-V1] THIS WAS THE SIBLING OF A DEFECT ALREADY FIXED ONE LEVEL DOWN.
    // What stood here was `if (usage) { ... }` around a direct token_usage write, so a provider
    // that returned NO usage object recorded NOTHING AT ALL: no row in token_usage, no row
    // anywhere else, and no trace that a call had happened whose cost is unknown. That is the
    // exact hole harRecordUsage() was written to close for the reflection call, and the reasoning
    // in its header applies here without a word changed -- the two paths differed only in which
    // one had been fixed.
    //
    // ROUTED THROUGH THAT RECORDER RATHER THAN REIMPLEMENTED. harRecordUsage is the ONE place
    // that decides measured-vs-gap (harUsageOk), the ONE place that writes token_usage, and the
    // ONE place that writes token_usage_gaps. A second copy of that decision here is how the two
    // halves drift apart again, and a truthiness guard beside a real recorder is precisely the
    // shape of the bug being removed.
    //
    // NOTHING CHANGES FOR A MEASURED TURN. harRecordUsage writes agent, model, source and the
    // same four token fields with FieldValue.serverTimestamp(), and 'web-chat' is passed as the
    // source exactly as before, so /api/dash/usage and /api/usage read an identical row and
    // by_model does not gain a second key. What changes is only the UNMEASURED turn: it now
    // leaves a token_usage_gaps row saying the call happened and its cost is unknown, instead of
    // leaving nothing. It still never writes a row of zeros into token_usage, because both
    // readers SUM every document they see and a zero there is a lie that reads as safe.
    //
    // NO try/catch HERE: harRecordUsage never throws, by the same contract and for the same
    // reason the block it replaces had one -- a telemetry failure must not break a user's chat.
    await harRecordUsage(agentId, apiModel, 'web-chat', usage);
    if (agentId) { try { await db.collection('chat_history').add({ agent_id: agentId, role: 'user', text: message, tags: ['harness'], timestamp: FieldValue.serverTimestamp() }); await db.collection('chat_history').add({ agent_id: agentId, role: 'assistant', text: reply, tags: ['harness'], timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
    if (agentId && HAR_REFLECT_EVERY > 0) { try { const cc = await db.collection('chat_history').where('agent_id', '==', agentId).count().get(); const n = (cc.data() && cc.data().count) || 0; const turns = Math.floor(n / 2); if (turns > 0 && turns % HAR_REFLECT_EVERY === 0) { await harReflect(agentId, provider, apiModel, key); } } catch (e) {} }
    res.json({ reply, usage, model: usedModel, effort: usedEffort });
  } catch (e: any) {
    // [CHAT-OBSERVABLE-V1] The caller now gets the REAL reason -- transport, host, region, model,
    // upstream HTTP status and the upstream message -- instead of a bare 'request failed'. The
    // message is built by harChatGemini / harChatClaude and has already been through harRedact(),
    // and every value in `resolved` is a name or a boolean, never a key. Stack stays server-side.
    const errId = harErrId();
    console.error('[api/chat] fail err_id=' + errId, (e && e.stack) || String(e));
    const detail = harRedact(String((e && e.message) || e)).slice(0, 400);
    let resolved: any = null; try { resolved = harChatResolved(provider, key); } catch (_e) {}
    res.status(502).json({ error: 'request failed', detail, resolved, err_id: errId });
  }
}));
// ---- /rdp desktop stream: reverse-proxy (HTTP + WebSocket) to the box guac web tier :8080 over the VPC ----
// SEC-RDP-GATE-V1 (fleet-security 2026-07-29): GATED. Both entry points below refuse BEFORE any
// workstation lookup -- the HTTP handler 403s and the WebSocket upgrade destroys the socket
// unless waSessionOk(req) passes. waSessionOk is a hoisted top-level function from the passkey
// fragment (cp-passkey-additions.ts, ROUTES section); deploy-cp-harness.sh splices that
// fragment into the SAME module scope as this one, so it is in scope here. The upgrade handler
// needs its own check: server.on('upgrade') never enters the express middleware stack, so no
// app.use gate can cover the WebSocket path. Before this, /rdp was the only internet route to
// the workstation desktop (no external IP on the VM) and it was reachable by allUsers.
// [WORKSTATION-CRD-V1] Guacamole and the /rdp proxy are GONE, at the operator's
// instruction 2026-08-06. They were an artifact of an abandoned attempt to embed a
// desktop window in the console. Remote access to the workstation is Chrome Remote
// Desktop, set up on the box itself. The proxy targeted guacd on :8080, which the
// workstation startup script never installed, so the route could not have worked in
// any deployment.

// ---- generic GCP REST passthrough: blessed reads run direct (CP_SA); everything else -> human gate ----
function harGcpHostOk(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)googleapis\.com$/.test(u.hostname); } catch (e) { return false; }
}
function harGcpDanger(method: string, url: string): boolean {
  const m = (method || '').trim().toUpperCase();
  if (m === 'DELETE' || m === 'PUT' || m === 'PATCH' || m === 'POST') return true;
  // HFC2-DANGER-V2. Every mutating verb already returned true above, so these URL patterns are the
  // catch for anything that reaches here WITHOUT a mutating method (and they document the
  // destroy-class surface): IAM policy writes, Secret Manager, service accounts AND their KEYS,
  // short-lived-credential minting (a token for a stronger SA is a privilege jump), instance
  // templates, instance deletion, machine-type changes, and bindings for powerful roles. Instance
  // creation and SA key creation are POSTs, so they are danger by the method rule above; naming them
  // here keeps them dangerous if that rule is ever narrowed. Every pattern from the previous version
  // is preserved -- this is additive only.
  return /:setIamPolicy|\/secrets(\/|$|\?)|secretmanager\.googleapis|serviceAccounts(\/|$|\?)|serviceAccounts\/[^\/]+\/keys|:generateAccessToken|:generateIdToken|:signJwt|:signBlob|iamcredentials\.googleapis|:deleteInstance|:setMachineType|\/instanceTemplates(\/|$|\?)|roles(\/|%2F)(owner|editor|[a-z.]*admin|iam\.|resourcemanager\.|compute\.|storage\.|secretmanager\.)/i.test(url || '');
}
function harGcpBlessedDirect(method: string, url: string): boolean {
  if ((method || 'GET').toUpperCase() !== 'GET') return false;  // only READS run silently as CP_SA
  const P = [
    'https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/',
    'https://run.googleapis.com/v2/projects/' + HAR_PROJECT + '/',
    'https://run.googleapis.com/v1/projects/' + HAR_PROJECT + '/',
    // [SEC-LAKE-NOGUESS-V1] THE LAKE PREFIX IS PRESENT ONLY WHEN THE BUCKET IS CONFIGURED, and
    // it deliberately does NOT go through pcLakeBucket(): this is a boolean predicate on a
    // request path, and a throw here would turn an unconfigured lake into a 500 instead of a
    // refusal. Fail-closed here means BLESSING NOTHING, so the prefix is spread away entirely.
    // This site is not cosmetic. With the old derived fallback it authorised silent CP_SA GETs
    // against a bucket name guessed from GCP_PROJECT, which in a shared project is the OTHER
    // lane's lake. harWriteLake() was the loud half of this defect; this was the quiet half.
    ...(PC_LAKE ? ['https://storage.googleapis.com/storage/v1/b/' + PC_LAKE + '/'] : []),
    'https://logging.googleapis.com/v2/projects/' + HAR_PROJECT + '/',
    'https://monitoring.googleapis.com/v3/projects/' + HAR_PROJECT + '/',
  ];
  return P.some((p) => (url || '').indexOf(p) === 0);
}
// ================= [SECRET-DESTROY-PREFLIGHT-V1] STAGING-TIME REFUSAL =================
// A secretKeyRef mount is a HARD BOOT DEPENDENCY resolved BY THE PLATFORM, whether or
// not any line of application code reads the variable. On 2026-08-10 a gated job deleted
// Secret Manager secret ad-free-key in the production project. Every check made first was
// TRUE and every one of them was IRRELEVANT: no code reads AD_FREE_KEY, no deploy script
// sets it, a fresh dev project does not have it. Production went down ~70 minutes later,
// when the first COLD START after the delete aborted:
//
//   Could not fetch secret ".../secrets/ad-free-key/versions/latest" for environment
//   variable "AD_FREE_KEY". Instance startup will now abort.
//
// paracoding-control-plane and paracoding-control-plane-mcp both carried that mount.
// Warm instances kept serving the already-resolved value, which is why the outage
// arrived over an hour after the change and was not attributed to it.
//
// EVERY CHECK THAT BLESSED THAT DELETE ANSWERED "will something RE-CREATE it?".
// NONE ANSWERED "does anything currently REFERENCE it?". pipeline/secret-destroy-preflight.py
// answers that one, and this refuses to STAGE a destroy that has not run it.
//
// WHY STAGING TIME AND NOT EXECUTION TIME. A refusal here costs the operator NOTHING --
// no passkey tap, no approval spent, no gate round trip. gate-exec/exec_server.py's
// SEC-SSHKEY-PREFLIGHT-V1 note already states the principle in the other direction:
// refusing a job a deployment cannot run "belongs in the control plane" rather than in
// the executor. This is that placement.
//
// IT IS NOT THE FIRST-TOKEN ALLOWLIST AND IT CANNOT REPEAT THAT FAILURE. That control
// inspected EVERY line of EVERY job, so `set -uo pipefail` killed every multi-line job
// the fleet stages, and it had to be stood down. This one fires ONLY on a command that
// destroys a Secret Manager secret or version. A job that does not do that is not read
// differently, cannot be refused by it, and there is no self-lockout: REMOVING this
// block is not itself a secret-destroy command. So it ENFORCES by default, deliberately,
// and the difference from the allowlist is the reason.
//
// THE ESCAPE IS TO DO THE WORK, NOT TO SET A FLAG. Run the preflight in the same job:
//
//   python3 secret-destroy-preflight.py <secret> --project <p> --source-root <dir> || exit 1
//   gcloud secrets delete <secret> --quiet
//
// The preflight exits non-zero for REFERENCED (2), UNKNOWN (3) and internal error (4),
// so `|| exit 1` is what makes the destroy conditional. A mention inside a comment does
// not satisfy this check; the invocation must be on a live line.
const PC_SECRET_DESTROY_TOKEN = 'secret-destroy-preflight.py';
const PC_SECRET_DESTROY_PATTERNS: RegExp[] = [
  /\bgcloud\b[^\n]*\bsecrets\b[^\n]*\bdelete\b/i,
  /\bgcloud\b[^\n]*\bsecrets\b[^\n]*\bversions\b[^\n]*\b(destroy|disable)\b/i,
  /-X[ \t]*DELETE[^\n]*secretmanager\.googleapis\.com/i,
  /(^|[\s'"])DELETE[\s'"][^\n]*secretmanager\.googleapis\.com[^\n]*\/secrets\//i,
  /secretmanager\.googleapis\.com[^\n]*\/secrets\/[^\n]*:(destroy|disable)/i,
];
function pcLooksLikeSecretDestroy(text: string): boolean {
  const live = String(text || '').split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).join('\n');
  return PC_SECRET_DESTROY_PATTERNS.some((re) => re.test(live));
}
function pcPreflightInvoked(text: string): boolean {
  return String(text || '').split('\n')
    .some((l) => l.trim() !== '' && !l.trim().startsWith('#') && l.indexOf(PC_SECRET_DESTROY_TOKEN) >= 0);
}
/** Returns a refusal string, or null to allow. Never throws: a guard that can throw is a
 *  guard that can be switched off by malformed input. */
function pcSecretDestroyRefusal(text: string): string | null {
  try {
    if (!pcLooksLikeSecretDestroy(text)) return null;
    if (pcPreflightInvoked(text)) return null;
  } catch (e) { /* fall through to refuse */ }
  return 'REFUSED AT STAGING: this job destroys a Secret Manager secret or version and does '
    + 'not run ' + PC_SECRET_DESTROY_TOKEN + ' first. NOTHING WAS STAGED and no approval was '
    + 'spent. A secretKeyRef mount is a hard BOOT dependency resolved by the platform: '
    + '"no code reads the variable" is NOT "safe to delete" -- that exact reasoning took '
    + 'production down on 2026-08-10, ~70 minutes later, at the first cold start. Run the '
    + 'preflight in the same job and make the destroy conditional on it:\n'
    + '  python3 ' + PC_SECRET_DESTROY_TOKEN + ' <secret> --project <p> --source-root <dir> || exit 1\n'
    + '  <the destroy command>\n'
    + 'It exits 0 only when EVERY consumer kind was enumerated and none references the '
    + 'secret. REFERENCED is 2, UNKNOWN is 3. If it refuses, remove the reference FIRST '
    + '(deploy the services without the env), prove it, and only then delete.';
}

async function harGcpStage(caller: string, method: string, url: string, body: any, reason: string, danger: boolean): Promise<any> {
  const _sdr = pcSecretDestroyRefusal(String(method || '').toUpperCase() + ' ' + String(url || ''));
  if (_sdr) return { error: 'refused', refusal: _sdr };
  const jobId = 'gcp_' + crypto.randomBytes(6).toString('hex');
  const hasBody = !!(body && typeof body === 'object' && Object.keys(body).length > 0);
  const bodyB64 = hasBody ? Buffer.from(JSON.stringify(body)).toString('base64') : '';
  const lines: string[] = [];
  lines.push(danger ? '# DANGER destroy-class GCP call (' + method + ') — journalled; refused only when PC_GUARDRAILS=1' : '# gcp_api ' + method);
  lines.push('# ' + method + ' ' + url);
  if (reason) lines.push('# reason: ' + String(reason).replace(/[\r\n]+/g, ' ').slice(0, 300));
  if (hasBody) lines.push("printf %s '" + bodyB64 + "' | base64 -d > /tmp/gcp_body.json");
  // [SEC-GCPAPI-TOKEN-V90] RESOLVE THE TOKEN, AND REFUSE RATHER THAN SEND "Bearer ". This line
  // expanded $CLOUDSDK_AUTH_ACCESS_TOKEN straight into the header. On the auto-approve and
  // pre-approve paths that variable is unset, so the header went out as a literal "Bearer " --
  // non-empty, so curl still sent it -- and Google answered 401 CREDENTIALS_MISSING. The gate now
  // fills the variable from the metadata server; this is the second brace on that pair, and it
  // turns "no token anywhere" into a real error instead of a silent 401.
  lines.push('PC_TOK="${CLOUDSDK_AUTH_ACCESS_TOKEN:-}"');
  lines.push('[ -n "$PC_TOK" ] || PC_TOK=$(gcloud auth print-access-token 2>/dev/null)');
  lines.push('[ -n "$PC_TOK" ] || { echo "gcp_api: no access token. CLOUDSDK_AUTH_ACCESS_TOKEN is unset and gcloud produced none, so this call would have gone out unauthenticated and returned 401. Not sending it." >&2; exit 1; }');
  // --fail-with-body exits non-zero on 4xx/5xx WHILE STILL PRINTING THE BODY. Without it a 401 is
  // a successful transfer, the job reports exit 0, and the caller gets a green result whose
  // payload is an error. That is precisely how this defect stayed invisible.
  lines.push('curl -sS --fail-with-body -X ' + method.toUpperCase() + " '" + url + "' -H \"Authorization: Bearer $PC_TOK\" -H \"Content-Type: application/json\"" + (hasBody ? ' --data @/tmp/gcp_body.json' : ''));
  const cmd = lines.join('\n');
  const u = (() => { try { return new URL(url); } catch (e) { return null as any; } })();
  const host = u ? u.hostname.replace('.googleapis.com', '') : 'gcp';
  const shortPath = u ? String(u.pathname).split('/').filter(Boolean).slice(-2).join('/') : '';
  const _gtype = 'gcp_api ' + method.toUpperCase() + ' ' + host + (shortPath ? '/' + shortPath : '');
  const _gargs: any = { command: cmd, method: method.toUpperCase(), url, reason: reason || '', danger: !!danger };
  const _adm = await pcAdmitStage(caller || 'fleet-advisor', _gtype, _gargs);
  if (!_adm.ok) return { mode: 'refused', staged: false, duplicate_of: _adm.duplicate_of || null, note: _adm.refusal };
  await db.collection('pending_confirms').doc(jobId).set({
    job_id: jobId,
    command_type: _gtype,
    staged_by: caller || 'fleet-advisor',
    arguments: _gargs,
    status: 'pending', created_at: FieldValue.serverTimestamp(), command_sha256: _adm.sha,
  });
  try { await db.collection('journal').add({ agent_id: caller || 'fleet-advisor', action: 'stage_job', message: 'gcp_api -> gate: ' + method.toUpperCase() + ' ' + url + (reason ? ' (' + reason + ')' : ''), timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
  // [SEC-AUTORUN-SCOPE-V1] harGcpStage is defined BELOW buildMcpServer, so before pcAutoRun
  // was hoisted to module scope this function could not reach it at all. Every gcp_api
  // mutation therefore parked at 'pending' and told the caller to wait for an approval
  // console that had been deleted. The danger verdict is passed through rather than
  // recomputed, so a DELETE stays classified as one in the journal.
  const _auto = await pcAutoRun(db.collection('pending_confirms').doc(jobId), jobId, _gtype, cmd, !!danger, false);
  if (_auto) return { mode: 'ran', job_id: jobId, danger: !!danger, result: _auto };
  return { mode: 'staged', job_id: jobId, danger: !!danger, note: 'NOT run: PC_AUTO_APPROVE is off and there is no approval console. Set PC_AUTO_APPROVE=1, or make the call yourself.' };
}
async function harGcpApi(caller: string, method: string, url: string, body: any, reason: string): Promise<any> {
  method = (method || 'GET').trim().toUpperCase();
  if (typeof url !== 'string' || !url) return { error: 'url required' };
  if (url.indexOf("'") >= 0) return { error: 'blocked: url may not contain a single quote' };
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) return { error: 'blocked: method must be one of GET/POST/PUT/PATCH/DELETE/HEAD (got: ' + method.slice(0, 40) + ')' };
  if (!harGcpHostOk(url)) return { error: 'blocked: only https://*.googleapis.com endpoints are allowed (got: ' + url.slice(0, 80) + ')' };
  if (harGcpBlessedDirect(method, url)) {
    const tok = await waAccessToken();
    const r = await waFetch(url, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: (body && typeof body === 'object') ? JSON.stringify(body) : undefined });
    if (r && (r.status === 401 || r.status === 403)) { return await harGcpStage(caller, method, url, body, (reason || '') + ' [CP_SA not permitted -> escalated to gate]', harGcpDanger(method, url)); }
    const txt = await r.text(); let parsed: any; try { parsed = JSON.parse(txt); } catch (e) { parsed = txt; }
    return { mode: 'direct', http: r && r.status, body: parsed };
  }
  return await harGcpStage(caller, method, url, body, reason, harGcpDanger(method, url));
}
// =============== end Paracoding Agentic Harness ===============
// ---- /flow live visibility (advisor v1): idea -> strain -> fruit (HTML served live from the lake) ----
app.get('/flow', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;   // [PC-CANONICAL-HOST-V48]
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  harReadLake('shared/harness/flow-view.html')
    .then((h: string) => { res.send(h || '<h1>flow-view.html missing from lake</h1>'); })
    .catch((e: any) => { harFail(res, e, 'harness'); });
});
// ---- /wiki internal system wiki (V3 SPEC internal-system-wiki) ---------------------------------
// [WIKI-ROUTE-V1] Mechanism B, exactly as /flow above: the chrome, the nav, the slug allow-list and
// every page are LAKE OBJECTS read at request time and sent no-store. ONE deploy lands this route;
// after it, correcting a page costs a write_file and nothing else. Nothing is read into a
// module-level constant on purpose -- a wiki that needs a deploy to fix a wrong sentence stays wrong.
//
// FRESHNESS FAILS SAFE. No path below yields 'green' without having resolved EVERY artifact the page
// names and found EVERY oid equal. Absent or unparseable front-matter is RED. An empty watch list is
// RED. A lookup that throws, times out or reads empty is RED. A store outage turns every page RED,
// which is correct: during a store outage this wiki genuinely cannot vouch for itself.
//
// WHY THE OID COMES FROM gitList AND NOT git_read: ops.ts gitRead throws FILE_TOO_LARGE above
// cfg.maxBlobBytes, and control-plane/src/index.ts -- the artifact most pages watch -- is over
// 360,000 bytes. A gitRead-based resolver would pin every page that watches this file to a permanent
// RED "FRESHNESS UNKNOWN". gitList returns the tree entry's oid without ever materialising the blob.
//
// NO /api/wiki JSON ENDPOINT, NOT NOW AND NOT LATER. See the [SEC-GATE-STAGES-V1] note above: a
// public shell with a gated data API served anonymous callers a free map of the system. The markdown
// goes behind the redirect, not behind a fetch that happens after the shell paints.
const WIKI_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Same two shapes the release leak gate calls "session key" and "bare bearer". Render-time
// quarantine is internal hygiene, not export hygiene: an agent authors these pages, and a page that
// pastes a credential has created a second permanent copy of it on a human-read surface.
const WIKI_QUARANTINE: Array<[string, RegExp]> = [
  ['session key', /pcs_[A-Za-z0-9_\-]{10,}/],
  ['bare bearer', /authorization\s*:\s*bearer\s+[A-Za-z0-9._\-]{20,}/i],
];
const wikiMemo: Map<string, { at: number; v: any }> = new Map();
let wikiOidFn: any = null;
// Deliberately NOT wrapped in a catch that only logs. If gittools.js did not build or did not export
// the resolver, every git: watch must fail LOUDLY into RED, never quietly into GREEN.
function wikiGitOid(): any {
  if (wikiOidFn === null) {
    const gt = require('./gittools.js');
    wikiOidFn = (gt && gt.gitBlobOid) || false;
  }
  if (typeof wikiOidFn !== 'function') throw new Error('gitBlobOid is not exported by gittools.js -- git: watches cannot be resolved');
  return wikiOidFn;
}
// Minimal front-matter: `key: value` and `key:` followed by two-space `- item` lines. No YAML
// dependency, and anything it cannot parse returns null, which the caller turns into RED.
function wikiParseFront(raw: string): { fm: any; body: string } | null {
  if (raw.slice(0, 4) !== '---\n') return null;
  const end = raw.indexOf('\n---\n', 3);
  if (end < 0) return null;
  const head = raw.slice(4, end + 1);
  const body = raw.slice(end + 5);
  const fm: any = {};
  let key = '';
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === '' || ln.charAt(0) === '#') continue;
    const li = /^\s+-\s+(.*)$/.exec(ln);
    if (li) {
      if (!key) return null;
      if (!Array.isArray(fm[key])) fm[key] = [];
      let v = li[1].trim();
      if (v.length > 1 && ((v.charAt(0) === '"' && v.slice(-1) === '"') || (v.charAt(0) === "'" && v.slice(-1) === "'"))) v = v.slice(1, -1);
      fm[key].push(v);
      continue;
    }
    const kv = /^([a-z_][a-z0-9_]*):\s*(.*)$/.exec(ln);
    if (!kv) return null;
    key = kv[1];
    const v = kv[2].trim();
    fm[key] = v === '' ? [] : v;
  }
  return { fm: fm, body: body };
}
async function wikiWatchVerdict(watch: string[]): Promise<any> {
  const drift: any[] = [];
  const unknown: any[] = [];
  for (let i = 0; i < watch.length; i++) {
    const w = String(watch[i]);
    const g = /^git:([^:]+):(.+)@([0-9a-f]{40})$/.exec(w);
    const l = /^lake:(.+)@([0-9a-f]{64})$/.exec(w);
    if (g) {
      try {
        const cur = String(await wikiGitOid()(g[2], g[1]));
        if (cur !== g[3]) drift.push({ artifact: 'git:' + g[1] + ':' + g[2], was: g[3].slice(0, 8), now: cur.slice(0, 8) });
      } catch (e: any) { unknown.push({ artifact: w, why: String((e && e.message) || e).slice(0, 200) }); }
    } else if (l) {
      try {
        // [PCV1-LAKE-TOOLS-V1] harReadLake no longer swallows: it THROWS on a decrypt or storage failure and
        // returns '' only for genuine absence, so the catch below now carries a real reason.
        // '' is still treated as UNKNOWN and never as a match -- a watched artifact that is
        // missing or empty cannot vouch for its own freshness either.
        const txt = await harReadLake(l[1]);
        if (txt === '') { unknown.push({ artifact: w, why: 'lake object missing, empty or unreadable' }); continue; }
        const cur = crypto.createHash('sha256').update(txt, 'utf8').digest('hex');
        if (cur !== l[2]) drift.push({ artifact: 'lake:' + l[1], was: l[2].slice(0, 8), now: cur.slice(0, 8) });
      } catch (e: any) { unknown.push({ artifact: w, why: String((e && e.message) || e).slice(0, 200) }); }
    } else {
      unknown.push({ artifact: w, why: 'unparseable watch entry' });
    }
  }
  if (unknown.length) return { verdict: 'red', reason: 'FRESHNESS UNKNOWN', drift: drift, unknown: unknown, checked: watch.length };
  if (drift.length) return { verdict: 'amber', reason: 'STALE', drift: drift, unknown: [], checked: watch.length };
  return { verdict: 'green', reason: '', drift: [], unknown: [], checked: watch.length };
}
async function wikiFreshness(slug: string, raw: string): Promise<any> {
  const bodyHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  const memoKey = slug + ':' + bodyHash;
  const hit = wikiMemo.get(memoKey);
  // RED and AMBER are memoised for the same 60s as GREEN. A failure must never be cached as a success.
  if (hit && (Date.now() - hit.at) < 60000) return hit.v;
  let out: any = { verdict: 'red', reason: 'UNVERIFIED', detail: 'freshness was not computed', drift: [], unknown: [], checked: 0 };
  const parsed = wikiParseFront(raw);
  if (!parsed) {
    out = { verdict: 'red', reason: 'UNVERIFIED', detail: 'front-matter is missing or unparseable; this page names no artifacts and cannot prove it is current', drift: [], unknown: [], checked: 0 };
  } else if (String(parsed.fm.page || '') !== slug) {
    out = { verdict: 'red', reason: 'UNVERIFIED', detail: 'front-matter page does not equal the slug; the page claims to be ' + JSON.stringify(String(parsed.fm.page || '')), drift: [], unknown: [], checked: 0 };
  } else if (!Array.isArray(parsed.fm.watch) || parsed.fm.watch.length === 0) {
    out = { verdict: 'red', reason: 'UNVERIFIED', detail: 'the watch list is empty; this page names no artifacts and cannot prove it is current', drift: [], unknown: [], checked: 0 };
  } else {
    try {
      const v = await wikiWatchVerdict(parsed.fm.watch);
      out = { verdict: v.verdict, reason: v.reason, detail: '', drift: v.drift, unknown: v.unknown, checked: v.checked };
    } catch (e: any) {
      out = { verdict: 'red', reason: 'FRESHNESS UNKNOWN', detail: String((e && e.message) || e).slice(0, 300), drift: [], unknown: [], checked: 0 };
    }
  }
  wikiMemo.set(memoKey, { at: Date.now(), v: out });
  if (wikiMemo.size > 500) { const k = wikiMemo.keys().next(); if (!k.done) wikiMemo.delete(k.value); }
  return out;
}
// [WIKI-EMPTY-LAKE-V1] A FRESH INSTALL HAS AN EMPTY LAKE, AND THIS ROUTE READS EVERY BYTE IT
// SERVES OUT OF THE LAKE. Before this block, a brand-new adopter who clicked the Docs button in
// the harness header got `<h1>wiki index unavailable</h1>` (or, once one object existed, a bare
// `<h1>no such page</h1>`) with no statement of what was wrong or what to do. That reads as a
// broken product rather than as an unpopulated one, and it happens to 100% of new installs
// because nothing in the release tree or install.sh ever writes shared/wiki/*.
//
// THE TEXT BELOW IS MODULE-CONSTANT AND NOTHING FROM THE REQUEST IS EVER INTERPOLATED INTO IT.
// The slug in particular is never echoed: the 404 body must stay byte-identical for every
// unpublished slug or it becomes the enumeration oracle the [WIKI-ROUTE-V1] note above refuses
// to build. Store errors are logged, never rendered, for the same reason.
const WIKI_NOTICE_CSS = 'body{margin:0;background:#0f0a1e;color:#e7e0f7;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}'
  + 'main{max-width:44rem;margin:0 auto;padding:3rem 1.5rem}h1{font-size:1.45rem;margin:0 0 1rem}'
  + 'h2{font-size:1.05rem;margin:2rem 0 .5rem;color:#c9b6ff}p{margin:0 0 1rem}'
  + 'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}'
  + 'code{background:#1b1236;border:1px solid #3a2864;border-radius:4px;padding:1px 5px}'
  + 'pre{background:#1b1236;border:1px solid #3a2864;border-radius:6px;padding:.85rem 1rem;overflow:auto}'
  + 'ul{margin:0 0 1rem 1.1rem;padding:0}li{margin:.3rem 0}a{color:#9f8bff}'
  + '.hint{color:#a99ec7;font-size:13px}';
function wikiNotice(res: express.Response, status: number, heading: string, body: string): void {
  res.status(status).send('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + heading + '</title><style>' + WIKI_NOTICE_CSS + '</style></head><body><main>'
    + '<h1>' + heading + '</h1>' + body
    + '<p class="hint">Served by the control plane at <code>/wiki</code>. This page is generated by '
    + 'the route itself, not read from the lake, so it renders even when the lake holds nothing.</p>'
    + '</main></body></html>');
}
// How to populate the wiki. Deliberately generic: it names the object layout and the two tools an
// adopter already has, and no project, bucket, region, ref or role of any particular deployment.
const WIKI_NOTE_HOWTO = '<h2>How to publish the first page</h2>'
  + '<p>Every wiki object lives under <code>shared/wiki/</code> in this installation’s data lake '
  + 'bucket and is read on every request, so publishing is a write and never a deploy. Three objects '
  + 'are needed:</p><ul>'
  + '<li><code>shared/wiki/_index.json</code> — the nav tree and, at the same time, the slug '
  + 'allow-list. A page that is not listed here is not served. Shape: '
  + '<code>{"version":1,"title":"...","sections":[{"id":"start","title":"Start here"}],'
  + '"pages":[{"slug":"index","title":"...","section":"start","status":"live","owner":"..."}]}</code></li>'
  + '<li><code>shared/wiki/_shell.html</code> — the page chrome. It must contain the literal token '
  + '<code>__WIKI_PAYLOAD__</code>; the route substitutes a JSON blob (slug, title, front-matter, '
  + 'markdown, freshness verdict, nav) for every occurrence of it.</li>'
  + '<li><code>shared/wiki/pages/&lt;slug&gt;.md</code> — one markdown object per page, slug matching '
  + '<code>^[a-z0-9][a-z0-9-]{0,63}$</code>, opening with front-matter delimited by <code>---</code> '
  + 'lines and carrying <code>page</code> (equal to the slug), <code>title</code> and a non-empty '
  + '<code>watch</code> list. <code>/wiki</code> itself serves the slug <code>index</code>.</li></ul>'
  + '<p>Write them with the <code>write_file</code> tool, or directly:</p>'
  + '<pre>gcloud storage cp _index.json  gs://$DATA_LAKE_BUCKET/shared/wiki/_index.json\n'
  + 'gcloud storage cp _shell.html  gs://$DATA_LAKE_BUCKET/shared/wiki/_shell.html\n'
  + 'gcloud storage cp index.md     gs://$DATA_LAKE_BUCKET/shared/wiki/pages/index.md</pre>'
  + '<p>The freshness badge fails safe: a page with absent or unparseable front-matter, or an empty '
  + '<code>watch</code> list, renders RED. There is no path that yields GREEN by default.</p>';
const WIKI_NOTE_UNPROVISIONED = '<p><strong>Nothing has been published to this wiki yet.</strong> '
  + 'This is the expected state of a new installation — it is not a fault, and nothing is broken. '
  + 'The wiki ships empty on purpose: its pages are yours to write, and no documentation is shipped '
  + 'into your lake by the installer.</p>' + WIKI_NOTE_HOWTO;
const WIKI_NOTE_404 = '<p>No page is published under that name.</p>'
  + '<p>A slug is served only if it matches the flat-slug shape <em>and</em> is listed in '
  + '<code>shared/wiki/_index.json</code>. Both checks run before any path is joined, so this answer '
  + 'is the same whether the name is malformed, unpublished or simply not a page.</p>'
  + '<p><a href="/wiki">Back to the wiki index</a></p>';
const WIKI_NOTE_ORPHAN = '<p>This page is listed in <code>shared/wiki/_index.json</code> but its object '
  + '<code>shared/wiki/pages/&lt;slug&gt;.md</code> is missing from the lake, so the index and the lake '
  + 'disagree. Either write the missing object or remove the slug from the index — nothing is '
  + 'rendered from a guess.</p><p><a href="/wiki">Back to the wiki index</a></p>';
const WIKI_NOTE_BADINDEX = '<p><code>shared/wiki/_index.json</code> exists but does not parse as JSON '
  + 'with a <code>pages</code> array. Nothing is rendered from a guess. Fix the object; no deploy is '
  + 'needed.</p>' + WIKI_NOTE_HOWTO;
const WIKI_NOTE_NOSHELL = '<p>The page chrome <code>shared/wiki/_shell.html</code> is missing from the '
  + 'lake, so the markdown was read but cannot be framed. This installation is half-provisioned: an '
  + 'index and at least one page exist, the shell does not.</p>' + WIKI_NOTE_HOWTO;
const WIKI_NOTE_STORE = '<p>The wiki could not be read because the object store refused the read. '
  + 'This is a store or key failure, not a missing page, and it is transient by nature — retry, and '
  + 'if it persists check the lake bucket and the vault key. The reason has been written to the '
  + 'service log rather than to this page.</p>';
async function wikiServe(req: express.Request, res: express.Response, slug: string): Promise<void> {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // Check 1 of 2: the slug shape. Flat slugs only -- there is no path segment to traverse out of.
  if (!WIKI_SLUG_RE.test(slug)) { wikiNotice(res, 404, 'No such page', WIKI_NOTE_404); return; }
  // [WIKI-EMPTY-LAKE-V1] ABSENCE AND FAILURE ARE NOW DIFFERENT ANSWERS. harReadLake returns '' for a
  // genuinely absent object and THROWS for a store or decrypt failure; collapsing both into `index =
  // null` reported a transient outage and an unpopulated install with the same sentence. An empty
  // wiki is a 200 explaining how to fill it -- it is the correct rendering of a real state, not an
  // error -- and an outage stays a 503.
  let indexRaw = '';
  try {
    indexRaw = await harReadLake('shared/wiki/_index.json');
  } catch (e: any) {
    console.error('[wiki] index read failed: ' + String((e && e.message) || e).slice(0, 300));
    wikiNotice(res, 503, 'Wiki store unavailable', WIKI_NOTE_STORE);
    return;
  }
  if (indexRaw === '') { wikiNotice(res, 200, 'The wiki is empty', WIKI_NOTE_UNPROVISIONED); return; }
  let index: any = null;
  try { index = JSON.parse(indexRaw); } catch (e) { index = null; }
  if (!index || !Array.isArray(index.pages)) { wikiNotice(res, 503, 'Wiki index unreadable', WIKI_NOTE_BADINDEX); return; }
  if (index.pages.length === 0) { wikiNotice(res, 200, 'The wiki is empty', WIKI_NOTE_UNPROVISIONED); return; }
  // Check 2 of 2: membership. Both checks run BEFORE any concatenation, so one mistake is not a breach.
  const entry = index.pages.filter((p: any) => p && p.slug === slug)[0];
  if (!entry) { wikiNotice(res, 404, 'No such page', WIKI_NOTE_404); return; }
  let raw = '';
  try {
    raw = await harReadLake('shared/wiki/pages/' + slug + '.md');
  } catch (e: any) {
    console.error('[wiki] page read failed slug=' + slug + ': ' + String((e && e.message) || e).slice(0, 300));
    wikiNotice(res, 503, 'Wiki store unavailable', WIKI_NOTE_STORE);
    return;
  }
  if (!raw) { wikiNotice(res, 404, 'Page listed in the index but absent from the lake', WIKI_NOTE_ORPHAN); return; }
  let quarantined = '';
  for (let i = 0; i < WIKI_QUARANTINE.length; i++) {
    const m = WIKI_QUARANTINE[i][1].exec(raw);
    if (m) { quarantined = WIKI_QUARANTINE[i][0] + ' near byte ' + (Math.floor(m.index / 256) * 256); break; }
  }
  if (quarantined) console.error('[wiki] QUARANTINE slug=' + slug + ' match=' + quarantined);
  const fresh = quarantined
    ? { verdict: 'red', reason: 'QUARANTINED', detail: 'this page matched a credential pattern and was withheld', drift: [], unknown: [], checked: 0 }
    : await wikiFreshness(slug, raw);
  const parsed = quarantined ? null : wikiParseFront(raw);
  let shell = '';
  try {
    shell = await harReadLake('shared/wiki/_shell.html');
  } catch (e: any) {
    console.error('[wiki] shell read failed: ' + String((e && e.message) || e).slice(0, 300));
    wikiNotice(res, 503, 'Wiki store unavailable', WIKI_NOTE_STORE);
    return;
  }
  if (!shell) { wikiNotice(res, 503, 'Wiki shell unavailable', WIKI_NOTE_NOSHELL); return; }
  const payload = JSON.stringify({
    slug: slug,
    title: (parsed && parsed.fm && parsed.fm.title) ? String(parsed.fm.title) : slug,
    front: parsed ? parsed.fm : null,
    markdown: quarantined ? '' : (parsed ? parsed.body : raw),
    quarantined: quarantined,
    fresh: fresh,
    nav: index,
    served_at: new Date().toISOString(),
  }).split('<').join('\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
  res.send(shell.split('__WIKI_PAYLOAD__').join(payload));
}
// [SEC-NOGATE-V1] There is no 302 and no `next` here any more. Both routes answer an anonymous
// caller with the locked document AT THE REQUESTED URL, so the anonymous response does not vary
// with caller input at all -- the property the constant '/wiki' target was chosen to preserve,
// now held by construction rather than by remembering not to echo the slug. The unlock reloads
// in place, so the reader also stops losing the page they asked for.
app.get('/wiki', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;   // [PC-CANONICAL-HOST-V48]
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  wikiServe(req, res, 'index').catch((e: any) => { harFail(res, e, 'harness'); });
});
app.get('/wiki/:slug', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;   // [PC-CANONICAL-HOST-V48]
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  wikiServe(req, res, String(req.params.slug || '')).catch((e: any) => { harFail(res, e, 'harness'); });
});

// [WIKI-ASSETS-V77] The wiki's diagrams. Served from the IMAGE, not from the lake, and that
// is the whole design decision: _shell.html's safeHref blocks data: outright, harReadLake
// returns a STRING so a PNG round-tripped through the lake text path is corrupted, and an
// external host is the thing this pass exists to remove. Baking them beside the HTML makes
// them self-contained in an adopter's project with no fetch, no decrypt and no third party.
// The name is an ALLOWLIST, not a sanitiser: path traversal is not filtered out, it is
// simply not reachable, because a name that is not one of these five never touches the disk.
// [SENDFILE-DOTDOT-V81] express's res.sendFile REFUSES ANY PATH CONTAINING '..' -- it fails
// with a bare "Forbidden" and never touches the disk. __dirname + '/../src/...' is therefore
// always a 404, whatever is in the image. MEASURED on a live zero-traffic revision: the route
// registered, logo_uri was live in the metadata, and GET /icon.png answered 404 with 0 bytes;
// reproduced locally against express, where the '..' form errors and the path.join form does
// not. path.join NORMALISES the '..' away, so the resolved string is a plain absolute path.
// THIS ALSO FIXES THE WIKI DIAGRAM ROUTE SHIPPED IN v7.7, which had the identical bug and was
// never exercised: its 404 is behind a session, so nothing surfaced it.
// WHY THE Dockerfile ASSERTION DID NOT CATCH IT: `test -s src/brand/...` proves the bytes are
// in the image, which they were. The defect was in the path the RUNNING code builds, and no
// build-time check can see that. A route that serves a file needs a request, not a test -s.
// The 'src' literal is held in a named constant DELIBERATELY. gen.py's boot-dependency gate
// keys on the expression pcHtml() uses appearing EXACTLY ONCE -- it is how the gate locates the
// directory it then checks every shipped HTML name against. Writing that expression a second
// time here does not merely duplicate a string, it BLINDS THE GATE, and the cut refuses with
// 'the lookup directory can no longer be trusted'. That refusal is correct and this is the way
// round it that keeps the gate working.
const PC_SRC_DIRNAME = 'src';
const PC_ASSET_ROOT = path.join(__dirname, '..', PC_SRC_DIRNAME);
const WIKI_ASSETS = new Set(['01-surface-split.png', '02-auth-path.png', '03-git-store.png',
  '04-job-end-to-end.png', '05-deploy.png']);
app.get('/wiki/assets/:name', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;   // [PC-CANONICAL-HOST-V48]
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  const name = String(req.params.name || '');
  if (!WIKI_ASSETS.has(name)) { res.status(404).json({ error: 'no such wiki asset' }); return; }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(PC_ASSET_ROOT, 'wiki-assets', name), (e: any) => {
    if (e) { try { res.status(404).end(); } catch (e2) {} }
  });
});

// [BRAND-SELFHOST-V80] The logo, served from the image instead of a third-party host.
// harness.html loaded it from an external domain at THREE call sites. That is an OSS
// install fetching its own chrome from a domain the adopter does not control and which
// may lapse, and it is operator identity in shipped text. The bytes now ride in the
// container beside the HTML.
//
// TWO PALETTES, AND THEY ARE NOT INTERCHANGEABLE. /brand/logo.png is the BLUE-GREEN
// source, because harness.html paints the gold with a CSS filter chain and
// `body.nomush ... filter:none` deliberately shows the unfiltered blue-green in regular
// lexicon mode. Baking gold into that file would destroy the second mode. /icon.png and
// /favicon.ico are GOLD BAKED INTO THE PIXELS, because browser chrome and an MCP client's
// icon are painted where no CSS of ours ever runs -- a filter cannot reach them.
//
// /favicon.ico and /icon.png are PUBLIC and on BOTH surfaces, deliberately: a favicon is
// requested by the browser before any session exists, and an MCP client fetches logo_uri
// with no credential at all. They are static image bytes and carry nothing else.
const BRAND_DIR = path.join(PC_ASSET_ROOT, 'brand');
app.get('/brand/logo.png', (req: express.Request, res: express.Response) => {
  if (pcCanonicalHostRedirect(req, res)) return;
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(BRAND_DIR, 'logo-96.png'), (e: any) => { if (e) { try { res.status(404).end(); } catch (e2) {} } });
});
app.get('/favicon.ico', (req: express.Request, res: express.Response) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/x-icon');
  res.sendFile(path.join(BRAND_DIR, 'favicon.ico'), (e: any) => { if (e) { try { res.status(404).end(); } catch (e2) {} } });
});
app.get('/icon.png', (req: express.Request, res: express.Response) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(path.join(BRAND_DIR, 'icon-180.png'), (e: any) => { if (e) { try { res.status(404).end(); } catch (e2) {} } });
});
// ---- end /wiki ---------------------------------------------------------------------------------
// ---- /lakeview  short-TTL credentialed view links for PCV1-sealed lake objects -----------------
// [LAKEVIEW-V1] THE NEED. Every lake object is PCV1-sealed and a signed GCS URL hands the operator
// ciphertext, so there has been NO human read path to his own encrypted data. That gap is what
// repeatedly tempted a strain to paste plaintext file bodies into chat. This decrypts on read,
// behind the SAME passkey session /wiki uses, and issues a link that expires.
//
// SCOPE, STATED PLAINLY, BECAUSE A VIEWER OVER AN ARBITRARY PATH IS A LAKE-WIDE READ PRIMITIVE.
// Scoping is an ALLOW-LIST, never a blocklist: a path matching nothing is refused, so a lake prefix
// invented tomorrow is invisible here until somebody adds it on purpose. FOUR independent checks
// must ALL pass before one byte is read -- the /wiki pattern (shape AND membership) plus two more:
//   1 SHAPE      a strict per-segment regex and a control-byte scan. '..' cannot match the regex,
//                nor can a leading slash or a backslash. There is no traversal left to perform.
//   2 PREFIX     LV_ALLOW must contain a prefix of the path.
//   3 CLEARTEXT  vaultIsCleartext(path) is a REFUSAL, unconditionally, even if check 2 were widened
//                by mistake later. This is what holds shared/vault/master.kem -- the KEM ciphertext
//                the entire lake's confidentiality rests on -- plus shared/passkey/,
//                shared/mcp-oauth/ and shared/deploy/ out of reach. Those are plaintext at rest, so
//                they were never the need this solves.
//   4 SEALED     the fetched bytes MUST carry the PCV1 magic. An unsealed object is REFUSED, not
//                served. The viewer exists to open sealed data; serving anything else would quietly
//                widen it into a general lake cat, which is a different and much larger decision.
//
// WHAT IT CANNOT REACH, BY CONSTRUCTION AND NOT BY RULE: Firestore. oauth_tokens and session_keys
// are Firestore collections, not lake objects, so no live bearer token and no agent session key is
// addressable from here at all. This block opens no collection; db is never named below.
//
// THE LINK IS NOT A BEARER CREDENTIAL, AND THAT IS THE DESIGN. The token is bound to the gate
// session that minted it and is inert without that session's cookie. Forwarded, pasted into a chat,
// or lifted from a proxy log, it opens nothing. The cost is honest and is stated here rather than
// discovered later: this is a link HE clicks in HIS browser, not one he can send to somebody else.
// A bearer-only link would have been a transferable lake read primitive with a five-minute fuse.
const LV_TTL_SEC = Math.max(30, Math.min(900, parseInt(process.env.LAKEVIEW_TTL_SEC || '300', 10) || 300));
const LV_MAX_BYTES = Math.max(1, Math.min(64, parseInt(process.env.LAKEVIEW_MAX_MB || '8', 10) || 8)) * 1024 * 1024;
// The viewable set. Deliberately enumerated, deliberately short, and deliberately NOT 'shared/'.
const LV_ALLOW: string[] = ['shared/state/', 'shared/handoff/', 'shared/wiki/', 'shared/oss-release/', 'shared/fleet/', 'shared/bootstrap/', 'agents/'];
const LV_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
// A charCodeAt scan, NOT a regex range: a control-byte class written with backslash-u escapes does
// not survive both git transport channels intact, and a scope check that arrives mangled is a scope
// check that silently does not run.
function lvHasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 92) return true;
  }
  return false;
}
// Returns '' when the path may be viewed, or the REASON it may not. Never a bare boolean: the
// operator is the only caller, and a refusal he cannot read costs him a round trip to an agent.
function lvPathOk(p: string): string {
  const path = String(p || '');
  if (path === '' || path.length > 512) return 'path is empty or longer than 512 characters';
  if (lvHasControlChar(path)) return 'path carries a backslash or a control character';
  if (path.charAt(0) === '/') return 'path must be relative to the bucket root';
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    if (!LV_SEG_RE.test(segs[i])) return 'segment ' + JSON.stringify(segs[i].slice(0, 40)) + ' is not a plain name';
  }
  if (!LV_ALLOW.some((px) => path.indexOf(px) === 0)) return 'path is outside every viewable prefix (' + LV_ALLOW.join(' ') + ')';
  if (vaultIsCleartext(path)) return 'path is a CLEARTEXT-at-rest prefix and is never viewable here';
  return '';
}
// Binds a token to ONE gate session. Derived from the session cookie's payload, so a re-minted
// session (logout, expiry, passkey re-arm) silently kills every outstanding link. Hashed rather
// than stored, so the token itself never carries session material.
function lvSessionFp(req: express.Request): string {
  const c = waCookie(req, 'gate_session') || '';
  const payload = c.indexOf('.') > 0 ? c.split('.')[0] : '';
  if (!payload) return '';
  return crypto.createHash('sha256').update('lakeview-fp:' + payload, 'utf8').digest('hex').slice(0, 32);
}
// Domain-separated from the session and elevation HMACs by the 'lakeview:' prefix, exactly as
// waMakeElevated separates itself with 'elev:'. Fails CLOSED on a missing or weak secret: an
// empty-key HMAC is forgeable, and a forgeable view link is an unauthenticated lake read.
function lvSign(payload: string): string {
  if (!WA_SESSION_SECRET_OK) throw new Error('WA_SESSION_SECRET missing or too weak - refusing to issue a view link.');
  return crypto.createHmac('sha256', WA_SESSION_SECRET).update('lakeview:' + payload).digest('base64url');
}
function lvMint(path: string, fp: string): { token: string; exp: number } {
  const exp = Date.now() + LV_TTL_SEC * 1000;
  const payload = waB64(Buffer.from(JSON.stringify({ p: path, exp: exp, s: fp })));
  return { token: payload + '.' + lvSign(payload), exp: exp };
}
function lvVerify(tok: string, fp: string): { path: string } | null {
  const t = String(tok || '');
  const i = t.indexOf('.');
  if (i <= 0) return null;
  const payload = t.slice(0, i);
  const sig = t.slice(i + 1);
  if (!WA_SESSION_SECRET_OK) return null;
  let expect = '';
  try { expect = lvSign(payload); } catch (e) { return null; }
  if (!waEq(sig, expect)) return null;
  let j: any = null;
  try { j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!j || typeof j.p !== 'string' || typeof j.s !== 'string') return null;
  if (!(Number(j.exp) > Date.now())) return null;
  if (!fp || !waEq(j.s, fp)) return null;
  return { path: j.p };
}
// Buffer-returning twin of vaultDecryptSync. It exists because vaultDecryptSync ends in
// .toString('utf8'), which substitutes U+FFFD for every byte sequence that is not valid UTF-8 --
// a PNG served through it downloads cleanly and is silently corrupt. Same header layout, same AAD,
// same per-object key derivation; the ONLY difference is that the plaintext is not stringified.
function lvDecryptBuf(master: Buffer, path: string, blob: Buffer): Buffer {
  const epoch = blob[4];
  const nonce = blob.slice(6, 18);
  const rest = blob.slice(18);
  const tag = rest.slice(rest.length - 16);
  const ct = rest.slice(0, rest.length - 16);
  const aad = Buffer.concat([blob.slice(0, 4), Buffer.from([epoch]), Buffer.from([0x00]), Buffer.from(path, 'utf8')]);
  const d = vCrypto.createDecipheriv('aes-256-gcm', vaultObjKey(master, path, epoch), nonce);
  d.setAAD(aad); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
// null == absent. LV_NOT_SEALED / LV_TOO_LARGE are thrown so the two callers can render them as
// distinct refusals; everything else propagates to harFail, never to a silent empty body. The
// epoch comes from blob[4] -- the OBJECT's epoch -- never the current write epoch.
async function lvReadSealed(path: string): Promise<{ buf: Buffer; ct: string } | null> {
  const f = getStorage().bucket(pcLakeBucket()).file(path);
  const ex = await f.exists();
  if (!ex[0]) return null;
  let declared = '';
  try { const md: any = await f.getMetadata(); declared = String(((md[0] || {}).metadata || {}).pcv1_ct || ''); } catch (e) { declared = ''; }
  const dl = await f.download();
  const blob: Buffer = dl[0];
  if (!(blob && blob.length >= 4 && blob.slice(0, 4).equals(VAULT_MAGIC))) throw new Error('LV_NOT_SEALED');
  if (blob.length > LV_MAX_BYTES) throw new Error('LV_TOO_LARGE');
  return { buf: lvDecryptBuf(await vaultMasterForEpoch(blob[4]), path, blob), ct: declared };
}
// A NUL byte, or any sequence that does not survive a utf8 round trip, means BINARY. Checked
// against the decrypted BYTES rather than the declared content type, because the type is metadata a
// writer can get wrong and the bytes are the truth.
function lvIsText(buf: Buffer): boolean {
  if (buf.indexOf(0) >= 0) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}
async function lvServe(req: express.Request, res: express.Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Referrer-Policy', 'no-referrer');
  const v = lvVerify(String((req.query && (req.query as any).t) || ''), lvSessionFp(req));
  // ONE refusal shape for every token failure -- bad signature, expired, wrong session, malformed.
  // A caller who reaches this route already holds a session; telling him WHICH check failed would
  // turn redemption into an oracle over other sessions' links, for no operator gain.
  if (!v) { res.status(403).type('text/plain').send('link is invalid, expired, or was issued to a different session'); return; }
  // RE-VALIDATED AT REDEEM TIME, never trusted from the token. The token is signed, so the path in
  // it is AUTHENTIC -- but authentic is not the same as still-allowed. If LV_ALLOW is tightened, or
  // a prefix later moves under the cleartext list, every outstanding link to it must die at once.
  const why = lvPathOk(v.path);
  if (why) { res.status(403).type('text/plain').send('refused: ' + why); return; }
  let sealed: { buf: Buffer; ct: string } | null = null;
  try { sealed = await lvReadSealed(v.path); }
  catch (e: any) {
    const m = String((e && e.message) || e);
    if (m === 'LV_NOT_SEALED') { res.status(409).type('text/plain').send('refused: object is not PCV1-sealed'); return; }
    if (m === 'LV_TOO_LARGE') { res.status(413).type('text/plain').send('refused: object exceeds the view cap'); return; }
    throw e;
  }
  if (!sealed) { res.status(404).type('text/plain').send('no such lake object'); return; }
  const name = (v.path.split('/').pop() || 'object').split('"').join('_');
  console.error('[lakeview] SERVE path=' + v.path + ' bytes=' + sealed.buf.length + ' binary=' + (!lvIsText(sealed.buf)));
  if (lvIsText(sealed.buf)) {
    // text/plain + nosniff: the browser RENDERS it and will not execute it. Serving a lake object
    // as text/html on THIS origin would let one poisoned page script the gate session, which is the
    // only thing standing between an attacker and the whole lake.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="' + name + '.txt"');
    res.status(200).send(sealed.buf);
    return;
  }
  // BINARY IS NEVER STRINGIFIED. The exact decrypted bytes go back as an attachment under the type
  // the writer declared. The alternative -- a utf8 round trip, which is what harReadLake does --
  // returns a file that downloads cleanly and is quietly corrupt, and that is worse than a refusal.
  res.setHeader('Content-Type', sealed.ct || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.setHeader('X-Lakeview-Binary', '1');
  res.status(200).send(sealed.buf);
}
app.post('/api/lakeview/link', waGate(async (req: express.Request, res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const path = String((req.body && req.body.path) || '');
  const why = lvPathOk(path);
  if (why) { res.status(400).json({ error: 'refused', reason: why }); return; }
  const fp = lvSessionFp(req);
  if (!fp) { res.status(403).json({ error: 'refused', reason: 'no gate session to bind this link to' }); return; }
  let sealed: { buf: Buffer; ct: string } | null = null;
  try { sealed = await lvReadSealed(path); }
  catch (e: any) {
    const m = String((e && e.message) || e);
    if (m === 'LV_NOT_SEALED') { res.status(409).json({ error: 'refused', reason: 'object is not PCV1-sealed; this viewer only opens sealed objects' }); return; }
    if (m === 'LV_TOO_LARGE') { res.status(413).json({ error: 'refused', reason: 'object exceeds the view cap' }); return; }
    throw e;
  }
  if (!sealed) { res.status(404).json({ error: 'refused', reason: 'no such lake object' }); return; }
  const mint = lvMint(path, fp);
  console.error('[lakeview] MINT path=' + path + ' bytes=' + sealed.buf.length + ' ttl_s=' + LV_TTL_SEC);
  res.json({ ok: true, url: '/lakeview?t=' + encodeURIComponent(mint.token), expires_at: new Date(mint.exp).toISOString(), ttl_seconds: LV_TTL_SEC, bytes: sealed.buf.length, binary: !lvIsText(sealed.buf) });
}));
app.get('/lakeview', (req: express.Request, res: express.Response) => {
  // [SEC-NOGATE-V1] No redirect at all now, which is strictly better than the constant target this
  // used to share with /wiki: there is no Location header for the ?t= credential to be copied into.
  // [PC-CANONICAL-HOST-V48] AND THAT IS WHY THIS ROUTE IS THE ONE BROWSER PAGE THAT DOES NOT CALL
  // pcCanonicalHostRedirect. That function preserves the query verbatim, which is correct for every
  // other page and wrong here: this route's query IS a credential, and moving it to the canonical
  // host would write ?t=<token> into a Location header and into the log of anything that follows
  // it. A lakeview link opened on the old hostname is answered by the gate, not relocated.
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  lvServe(req, res).catch((e: any) => { harFail(res, e, 'harness'); });
});
// ---- end /lakeview -----------------------------------------------------------------------------
app.get('/api/flow', waGate(async (req: express.Request, res: express.Response) => {
  const now = Date.now();
  const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { agent: a, last_ts: 0, last_action: '', backlog: 0, in_progress: 0, parked: 0, model: 'unknown' }; return agents[a]; };
  const feed: any[] = [];
  const FEED_ACTIONS = ['work_start', 'work_done', 'work_blocked', 'work_error', 'stage_job', 'godmode_executed', 'human_confirmed', 'subculture', 'decision'];
  // ---- live lane (FLOWLIVE-INFLIGHT-v1) --------------------------------------------------------
  // work_turn / work_cache are deliberately kept OUT of FEED_ACTIONS above. With 8 workers they emit
  // ~2 rows per turn per worker, which consumes the feed's 200-doc window in roughly ninety seconds;
  // folding them in would not enrich the feed, it would erase it. They get their own query below.
  const TURN_ACTIONS = ['work_turn', 'work_cache'];
  const inflight_raw: any[] = [];   // in_progress work_items docs, kept from the query that already runs
  const liveByAgent: any = {};      // agent_id -> { turns, last_tool, out_tokens, last_ts }
  const jsnap = await db.collection('journal').orderBy('timestamp', 'desc').limit(200).get();
  jsnap.docs.forEach((d: any) => {
    const e = d.data();
    const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds * 1000 : (e.timestamp && e.timestamp.toMillis ? e.timestamp.toMillis() : 0);
    const a = ensure(e.agent_id);
    if (a) {
      if (ts > a.last_ts) { a.last_ts = ts; a.last_action = e.message || e.action || ''; }
      if (e.action === 'work_model' && e.message && a.model === 'unknown') { const m = String(e.message).toLowerCase(); if (m.indexOf('gemini') >= 0) a.model = 'gemini'; else if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) a.model = 'claude'; }
    }
    if (feed.length < 45 && FEED_ACTIONS.indexOf(e.action) >= 0) feed.push({ agent: e.agent_id, action: e.action, message: String(e.message || '').slice(0, 240), age_min: ts ? Math.round((now - ts) / 60000) : 99999 });
  });
  feed.forEach((f: any) => { const a = agents[f.agent]; f.model = (a && a.model) || 'unknown'; });
  // ---- live lane read (FLOWLIVE-INFLIGHT-v1) ---------------------------------------------------
  // A second, separate journal query with its own limit. The feed above keeps its full 200-doc /
  // 45-item budget no matter how loud the journal gets, and this lane keeps its own. Neither can
  // starve the other. Whole thing is wrapped: if it fails, in_flight simply loses turns/tool/tokens
  // and still renders the item rows, so /flow degrades instead of 500-ing.
  try {
    let tdocs: any[] = [];
    try {
      // Narrow read. Wants a composite index on journal (action ASC, timestamp DESC).
      const tq1 = await db.collection('journal').where('action', 'in', TURN_ACTIONS).orderBy('timestamp', 'desc').limit(240).get();
      tdocs = tq1.docs;
    } catch (eIdx) {
      // That composite index may not exist yet, and a missing index throws rather than degrading.
      // Fall back to a plain timestamp scan filtered in code: it rides the same single-field index
      // the feed query above already uses, so it cannot fail for a missing index. Costs one read of
      // 400 docs instead of 240 -- the panel degrades in COST, never in correctness, and it works on
      // the very first deploy with no index to provision.
      const tq2 = await db.collection('journal').orderBy('timestamp', 'desc').limit(400).get();
      tdocs = tq2.docs.filter((dd: any) => TURN_ACTIONS.indexOf(dd.data().action) >= 0);
    }
    // Rows arrive NEWEST FIRST, so the first row seen for an agent describes what it is doing right
    // now. Turn numbers climb monotonically inside one work_start..work_done run, which makes
    // "first tN seen" identical to "highest tN since work_start" -- and unlike a max over the whole
    // window it cannot leak a long previous item's turn count onto a freshly started one.
    tdocs.forEach((dd: any) => {
      const ev = dd.data();
      const ag = String(ev.agent_id || '');
      if (!ag) return;
      const ets = (ev.timestamp && ev.timestamp._seconds) ? ev.timestamp._seconds * 1000 : (ev.timestamp && ev.timestamp.toMillis ? ev.timestamp.toMillis() : 0);
      const msg = String(ev.message || '');
      let L = liveByAgent[ag];
      if (!L) { L = { turns: 0, last_tool: '', out_tokens: 0, last_ts: 0 }; liveByAgent[ag] = L; }
      if (ets > L.last_ts) L.last_ts = ets;
      const tm = msg.match(/^t(\d+)\s*:\s*/);                 // "t3: read_file, list_files"
      if (tm && L.turns === 0) L.turns = parseInt(tm[1], 10) || 0;
      const rest = tm ? msg.slice(tm[0].length) : msg;
      if (ev.action === 'work_turn' && !L.last_tool) L.last_tool = rest.trim().slice(0, 80);
      if (ev.action === 'work_cache' && !L.out_tokens) {       // "in=2 cache_write=91342 ... out=3271"
        const om = rest.match(/out=(\d+)/);
        if (om) L.out_tokens = parseInt(om[1], 10) || 0;
      }
    });
  } catch (eLive) {}
  try { const w = await db.collection('work_items').where('status', 'in', ['pending', 'in_progress']).limit(300).get(); w.docs.forEach((d: any) => { const x = d.data(); const a = ensure(x.assigned_role); if (a) { if (x.status === 'pending') a.backlog++; else { a.in_progress++; inflight_raw.push({ id: d.id, doc: x }); } } }); } catch (e) {}
  const parked: any[] = [];
  try { const pk = await db.collection('work_items').where('status', 'in', ['needs_claude', 'needs_cowork', 'needs_supervisor']).limit(100).get(); pk.docs.forEach((d: any) => { const x = d.data(); let ts = 0; if (x.updated_at) ts = x.updated_at._seconds ? x.updated_at._seconds * 1000 : (x.updated_at.toMillis ? x.updated_at.toMillis() : 0); else if (x.created_at) ts = x.created_at._seconds ? x.created_at._seconds * 1000 : (x.created_at.toMillis ? x.created_at.toMillis() : 0); parked.push({ id: d.id, title: String(x.title || ''), assigned_role: String(x.assigned_role || ''), status: String(x.status || ''), sweep_reason: String((x.payload && x.payload.sweep_reason) || x.sweep_reason || ''), age_min: ts ? Math.round((now - ts) / 60000) : 0 }); const a = ensure(x.assigned_role); if (a) a.parked++; }); parked.sort((x, y) => x.age_min - y.age_min); } catch (e) {}
  let pending_confirms = 0;
  try { const p = await db.collection('pending_confirms').where('status', '==', 'pending').limit(100).get(); pending_confirms = p.size; } catch (e) {}
  const list = Object.keys(agents).map((k: string) => { const a = agents[k]; const age = a.last_ts ? (now - a.last_ts) / 60000 : 99999; a.age_min = Math.round(age); a.status = (a.in_progress > 0 && age < 5) ? 'working' : ((a.in_progress > 0 || a.backlog > 0) ? 'waiting' : (age < 5 ? 'working' : 'idle')); return a; }).sort((x: any, y: any) => y.last_ts - x.last_ts);
  // ---- in_flight (FLOWLIVE-INFLIGHT-v1) --------------------------------------------------------
  // One row per work_item currently in_progress, joined to the live lane BY assigned_role.
  //
  // HONEST ABOUT THE JOIN: it is best-effort, not exact. Journal rows carry agent_id, not the
  // work_item id, so the only key available is the role. When one agent holds several in_progress
  // items in sequence, every one of those rows shows the SAME turns / last_tool / out_tokens -- the
  // agent's newest activity, not that specific item's. Read those three fields as "what this agent
  // is doing right now". The item-derived fields (id, title, substrate, started_at, age_min,
  // stalled) are exact per row, and those are the ones the stall warning is built on.
  const in_flight: any[] = inflight_raw.map((r: any) => {
    const x = r.doc || {};
    const tsOf = (v: any) => (v ? (v._seconds ? v._seconds * 1000 : (v.toMillis ? v.toMillis() : 0)) : 0);
    const started = tsOf(x.started_at) || tsOf(x.updated_at) || tsOf(x.created_at);
    const role = String(x.assigned_role || '');
    const L = liveByAgent[role] || null;
    const t = String(x.title || '');
    const age = started ? Math.round((now - started) / 60000) : 0;
    return {
      id: r.id,
      title: t.length > 90 ? (t.slice(0, 89) + '…') : t,
      assigned_role: role,
      substrate: String(x.substrate || (x.payload && x.payload.substrate) || ''),
      started_at: started,
      turns: (L && L.turns) || 0,
      last_tool: (L && L.last_tool) || '',
      out_tokens: (L && L.out_tokens) || 0,
      age_min: age,
      // The sweeper parks at 15 minutes. Surfacing at 12 gives three minutes of warning, which is
      // the whole point: this morning's 0-byte deliverable came from a stall nobody could see.
      stalled: age >= 12,
    };
  }).sort((p: any, q: any) => q.age_min - p.age_min);   // oldest (most at risk) first
  res.json({ generated: now, agents: list, feed, in_flight, pending_confirms, parked });
}));
// =============== end /flow ===============

// [PC-CANONICAL-HOST-V48] ONE HANDLER BODY, TWO ROUTES. GET / and GET /harness serve the same
// document behind the same check, and the way that goes wrong is that somebody edits one copy:
// the gate is then present on one URL of a page and absent on the other, which is indistinguishable
// from a working console until it is exploited. There is one body and both routes call it.
// HERE the canonical-host decision is taken FIRST, before the session is even looked at, because
// on a non-canonical host there can be no valid session to find -- the gate cookie is host-only,
// and see [PC-CANONICAL-HOST-V48] at the foot of this file for why the only hostname a passkey can
// be asserted on is WA_RP_ID. /harness deliberately does the OPPOSITE and gates first; the reason
// it has to is written out above that route and is the installer's anonymous probe, not taste.
function harFlowHood(req: any, res: any): void {
  if (pcCanonicalHostRedirect(req, res)) return;
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HAR_HARNESS_HTML);
}
// Collapse onto the root WITHOUT DROPPING THE QUERY. res.redirect('/') drops it, and two live
// links carry one that matters: the enrolment link this file mints itself, /harness?enroll=<token>
// (:3877), and the installer's first-run link, /harness?setup=<secret>. locked.html reads both out
// of location.search, so a redirect that eats the query turns the only two ways a NEW device gets
// a passkey into a plain locked page with nothing to consume -- which is the lockout, arrived at
// through a redirect nobody would think to check.
function harRootWithQuery(req: any): string {
  const u = String((req && (req.originalUrl || req.url)) || '');
  const q = u.indexOf('?');
  return q < 0 ? '/' : ('/' + u.slice(q));
}
// [PC-CANONICAL-HOST-V48] /harness IS THE REDIRECT NOW -- AND THE GATE RUNS FIRST, AHEAD OF BOTH
// REDIRECTS. That ordering is the whole of this route's safety and it is measured, not preferred.
// install.sh probes THIS EXACT ROUTE anonymously, before it puts IAP in front of the console, and
// anything other than 401 is a `die` that aborts the install; the release self-test then reads the
// locked page's own title out of that same response. It probes it at CP_URL, which is the service's
// own *.run.app URL -- a hostname that is by definition NOT the canonical one -- so a host redirect
// placed ahead of the gate here would answer that probe 301 and break the install and the upgrade
// of every adopter who had turned this feature on. Nothing is lost by the ordering: the gate session
// cookie is host-only, so a session on a non-canonical host cannot exist to be relocated, and an
// anonymous caller has nothing worth carrying to another hostname. It sees exactly what it saw
// before -- 401 with the locked page, at the URL it asked for -- and only a caller already through
// the gate is moved. The bare hostname (GET /, and /flowhood, /dash, /chat, /flow, /wiki) is where
// a mistyped host IS relocated, and that is the case the operator actually types.
// Every existing link into /harness therefore still lands on the hood, one hop later: dash.html's
// two, locked.html's post-unlock location.replace(location.pathname), the wiki's prose links, and
// the URL the installer prints.
//
// 301 CARRYING no-store, WHICH IS NOT A CONTRADICTION. Anything reading the status code gets the
// permanent redirect that was asked for. What it must not be is a redirect a BROWSER remembers: a
// cached 301 for /harness outlives a rollback, and the rolled-back revision serves GET / as a
// redirect TO /harness, so the cache meets it head-on and the front door spins -- / to /harness to
// / -- unreachable, with nothing the server can do about it. deploy/LOCKOUT-CLASS.md keeps ordinary
// code deploys OUT of the lockout class only because the rollback rail covers them; a permanently
// cached front-door redirect would quietly take that rail away for this route.
app.get('/harness', (req: any, res: any) => {
  if (!waSessionOk(req)) { waSendLocked(res); return; }
  if (pcCanonicalHostRedirect(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(301, harRootWithQuery(req));
});


// ================= PARACODING MCP OAUTH (additive; /mcp/:token stays intact) =================
function oaB64url(buf: any): string { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function oaRand(n?: number): string { return oaB64url(oaCrypto.randomBytes(n || 32)); }
function oaPubBase(req: any): string { return String(process.env.MCP_PUBLIC_URL || ('https://' + req.get('host'))).replace(/\/$/, ''); }
const OAUTH_ALLOW = String(process.env.WA_APPROVER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// [SEC-OAUTH-FAILCLOSED-ROLE-V1] THE FAIL-CLOSED DEFAULT MUST BE THE LEAST PRIVILEGED ROLE.
// There were THREE answers to "what role does an unbound connector get" in one shipped tree: this
// comment said one thing, this line defaulted to 'fleet-advisor', and install.sh sets
// OAUTH_DEFAULT_ROLE=fleet-onboarder. 'fleet-advisor' is the PRIVILEGED strain -- the one role
// permitted to stage gated jobs -- so the branch that ran when the env var was ABSENT landed every
// unbound connector on it. Calling that "fail-closed" inverted the term: it failed OPEN, and it is
// privilege-escalation-by-omission, reachable by nothing more than dropping one env var. The
// comment ~90 lines above records that this exact promotion-by-fallback was already found once.
// It now agrees with install.sh and with STRAIN_SEED's own STRAIN-SEED-ONBOARDER-V1 note:
// fleet-onboarder is where unclaimed connectors land. It is in STRAIN_NEVER_PASTEABLE, so no human
// key can be minted for it, and the operator binds the connector to a real strain on the consent
// page. If it is ever renamed, rename it in install.sh and in STRAIN_SEED in the same commit.
const OAUTH_ROLE = process.env.OAUTH_DEFAULT_ROLE || 'fleet-onboarder' /* fail-closed: least privileged, matches install.sh */;  // VERIFY-GREP: OAUTH-ROLE-RESTORED-FAILCLOSED
const OA_GID = process.env.WA_GOOGLE_CLIENT_ID || '';
// [OSS-AUTHMODE-V54] Pluggable connector identity, per shared/backlog/oss-v2-pluggable-auth.md.
// WHY THIS EXISTS AT ALL, because the obvious alternative is dead and someone will propose it
// again: an installer CANNOT obtain a Google OAuth client. Measured 2026-08-15 (job
// zd8Y8c7JRtAEFu7Q21fk) -- the IAP OAuth Admin APIs were permanently shut down on 2026-03-19,
// and even before that the client they minted was owned by Cloud IAP and carried no JavaScript
// origin, which google.accounts.id.initialize() requires. So WA_GOOGLE_CLIENT_ID is, and will
// remain, OPERATOR-SUPPLIED ONLY. Every install that does not have one needs a second way in or
// it has no way in at all, which is exactly the state every adopter has shipped in until now.
//
// PC_CONNECT_SECRET is that second way: a high-entropy value the installer generates into Secret
// Manager and mounts on the MCP surface. It authenticates the HUMAN at /oauth/authorize and then
// mints the SAME authorization code the Google path mints -- it is a different front door onto
// one corridor, not a second corridor. Nothing downstream of the code branch can tell them apart
// except the audit email, which is the point: the token store, PKCE, refresh rotation, retirement
// and the role binding are all unchanged and untouched by this.
const PC_CONNECT_SECRET = process.env.PC_CONNECT_SECRET || '';
// A short secret is worse than no secret, because it looks like protection. 24 chars of the
// installer's base64 alphabet is ~143 bits; the floor below refuses anything a human might have
// typed in by hand and silently disables the path rather than pretending to guard it.
const PC_CONNECT_SECRET_MIN = 24;
const PC_CONNECT_SECRET_OK = PC_CONNECT_SECRET.length >= PC_CONNECT_SECRET_MIN;
// auto (default) = offer whatever is configured. google/selfcontained pin one. both = same as
// auto but states the intent. An unrecognised value is treated as auto rather than as a refusal:
// a typo in an env var must not lock an operator out of his own connector.
const PC_AUTH_MODE = String(process.env.PC_AUTH_MODE || 'auto').trim().toLowerCase();
function oaGoogleOn(): boolean {
  if (!OA_GID) return false;
  return PC_AUTH_MODE !== 'selfcontained';
}
function oaSelfOn(): boolean {
  if (!PC_CONNECT_SECRET_OK) return false;
  return PC_AUTH_MODE !== 'google';
}
// Audit identity for a key sign-in. It is NOT an authorisation input -- nothing downstream
// re-checks it against OAUTH_ALLOW -- so it exists to make 'who authorised this connector'
// answerable in the token store and the journal, and it must never be mistaken for a verified
// address. The 'connector-key:' prefix is deliberately not a valid email for that reason.
function oaSelfPrincipal(): string {
  return 'connector-key:' + (OAUTH_ALLOW.length ? OAUTH_ALLOW[0] : 'install');
}
// [OSS-IAPAUTH-V54] The console service's public URL, set by the installer on the MCP service so
// the metadata document can send a browser to the IAP-protected host for the authorize step only.
const PC_CONSOLE_URL = String(process.env.PC_CONSOLE_URL || '').replace(/\/$/, '');
// TWO CONDITIONS, BOTH REQUIRED, AND THE SECOND IS THE SECURITY ONE. PC_IAP_AUD binds an IAP
// assertion to THIS service: without it pcIapEmail() verifies Google's signature but accepts an
// assertion minted for ANY IAP-protected app, so anyone who can reach any IAP app in any project
// could replay its token here. The Google signature alone is not sufficient. Fail closed.
function oaIapAuthOn(): boolean {
  if (PC_AUTH_MODE === 'google' || PC_AUTH_MODE === 'selfcontained') return false;
  return !!PC_CONSOLE_URL && !!PC_IAP_AUD;
}
// Where a BROWSER should be sent to authorize. Only the authorize step moves; everything else
// stays on the host the connector talks to.
function oaAuthBase(req: any): string {
  return oaIapAuthOn() ? PC_CONSOLE_URL : oaPubBase(req);
}

// [OSS-ALLOWLIST-V54] THE ALLOWED-ACCOUNT LIST MOVES FROM AN ENV VAR TO FIRESTORE, AND THE
// REASON IS THAT AN ENV VAR CANNOT BE EDITED BY THE PERSON LOCKED OUT BY IT. WA_APPROVER_EMAILS
// lives on two Cloud Run services; changing it means a new revision on both, which the operator
// cannot do from inside the product and which restarts the thing he is trying to get into. The
// live list is therefore a Firestore document, SEEDED ONCE from the env var so no existing
// install changes behaviour on upgrade, and editable from Settings thereafter.
//
// THE ENV VAR REMAINS A FLOOR, NOT A CEILING: entries in WA_APPROVER_EMAILS are always allowed
// even if the document is missing, empty or corrupt. That is deliberate. A Firestore read that
// fails must not lock the owner out of his own install, so the failure mode is "fall back to the
// addresses the installer baked in", never "allow nobody" and never "allow anybody".
const OA_ALLOW_DOC = 'config/oauth_allow';
let oaAllowCache: { at: number; list: string[] } | null = null;
const OA_ALLOW_TTL_MS = 15000;
function oaNormEmail(s: any): string { return String(s || '').trim().toLowerCase(); }
async function oaAllowList(): Promise<string[]> {
  const now = Date.now();
  if (oaAllowCache && (now - oaAllowCache.at) < OA_ALLOW_TTL_MS) return oaAllowCache.list;
  let extra: string[] = [];
  try {
    const parts = OA_ALLOW_DOC.split('/');
    const snap = await db.collection(parts[0]).doc(parts[1]).get();
    const d: any = (snap && snap.exists && snap.data()) || null;
    if (d && Array.isArray(d.emails)) extra = d.emails.map(oaNormEmail).filter(Boolean);
  } catch (e) {
    // Read failed. Fall through to the env floor rather than refusing everyone.
    console.error('[oauth-allow] Firestore read failed; using WA_APPROVER_EMAILS only');
  }
  const merged: string[] = [];
  for (const e of OAUTH_ALLOW.concat(extra)) { if (e && merged.indexOf(e) < 0) merged.push(e); }
  oaAllowCache = { at: now, list: merged };
  return merged;
}
async function oaAllowed(email: string): Promise<boolean> {
  const em = oaNormEmail(email);
  if (!em) return false;
  const list = await oaAllowList();
  return list.length > 0 && list.indexOf(em) >= 0;   // empty list allows nobody: fail closed
}
// Writes the EDITABLE half. Env entries are not stored here and cannot be removed from Settings,
// which is what stops an operator deleting the address the installer gave him and locking himself
// out of the only surface that can undo it.
// Settings reads this to draw the list. `locked` entries render without an x because removing
// them here would not remove them -- they come from the env var and would reappear on the next
// read, which is a worse experience than not offering the button.
app.get('/api/oauth/allowed', async (req: any, res: any) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const all = await oaAllowList();
  res.json({ locked: OAUTH_ALLOW.slice(), all, editable: all.filter((e: string) => OAUTH_ALLOW.indexOf(e) < 0) });
});
// The x and the + both land here with the full intended list. Server-side rules, because a UI
// rule is a suggestion: the merged result may never be empty (that would allow nobody and there
// would be no way back in), addresses must look like addresses, and the list is capped so a
// runaway client cannot write an unbounded document.
app.post('/api/oauth/allowed', async (req: any, res: any) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const raw = (req.body && req.body.emails);
  if (!Array.isArray(raw)) { res.status(400).json({ error: 'emails must be an array' }); return; }
  if (raw.length > 64) { res.status(413).json({ error: 'too many addresses (max 64)' }); return; }
  const wanted: string[] = [];
  for (const e of raw.map(oaNormEmail)) {
    if (!e) continue;
    if (e.length > 254 || e.indexOf('@') < 1 || e.indexOf('.', e.indexOf('@')) < 0 || /[\s,<>"']/.test(e)) {
      res.status(400).json({ error: 'not a valid address: ' + e }); return;
    }
    if (wanted.indexOf(e) < 0) wanted.push(e);
  }
  const merged: string[] = [];
  for (const e of OAUTH_ALLOW.concat(wanted)) { if (e && merged.indexOf(e) < 0) merged.push(e); }
  if (!merged.length) { res.status(400).json({ error: 'at least one address must remain, or nobody can sign in' }); return; }
  await oaAllowWrite(wanted.filter((e: string) => OAUTH_ALLOW.indexOf(e) < 0));
  try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'oauth_allow_updated', message: 'allowed accounts now: ' + merged.join(', '), timestamp: FieldValue.serverTimestamp() }); } catch (e) { }
  res.json({ ok: true, all: await oaAllowList() });
});
async function oaAllowWrite(emails: string[]): Promise<void> {
  const parts = OA_ALLOW_DOC.split('/');
  const clean: string[] = [];
  for (const e of emails.map(oaNormEmail)) { if (e && clean.indexOf(e) < 0) clean.push(e); }
  await db.collection(parts[0]).doc(parts[1]).set({ emails: clean, updated_at: FieldValue.serverTimestamp() }, { merge: true });
  oaAllowCache = null;   // the next read must see the write, not a 15-second-old copy
}

async function oaGet(col: string, id: string): Promise<any> { try { const d = await db.collection(col).doc(id).get(); return d.exists ? d.data() : null; } catch (e) { return null; } }
async function oaSet(col: string, id: string, obj: any): Promise<void> { try { await db.collection(col).doc(id).set(obj); } catch (e) {} }
async function oaDel(col: string, id: string): Promise<void> { try { await db.collection(col).doc(id).delete(); } catch (e) {} }

// [SEC-OAUTH-HASH] A Firestore document ID is an index key, not a secret store: it shows up in
// console URLs, export manifests, audit-log resourceName fields, and any listing of the
// collection. Storing a bearer token as its own document ID means anyone who can list
// oauth_tokens holds every live credential. Document IDs are now sha256(token) hex, which is
// not a usable bearer token, and every lookup hashes the presented token before the get.
function oaTokHash(t: string): string { return oaCrypto.createHash('sha256').update(String(t), 'utf8').digest('hex'); }
// [SEC-OAUTH-RT-EXP] Refresh tokens carried no exp field, so there was nothing to enforce and
// they were valid forever. They now expire; this is the duration.
const OA_RT_TTL_MS = 30 * 24 * 3600 * 1000;  // 30 days
// [SEC-OAUTH-DUALREAD-REMOVED] fleet-security 2026-07-30. The legacy cleartext-ID fallback is GONE.
// It ran on EVERY cache miss, and what it called was a plain document read whose DOCUMENT ID was the
// RAW PRESENTED BEARER. Document IDs surface in console URLs, export manifests and
// audit-log resourceName fields -- which is verbatim the reason [SEC-OAUTH-HASH] above stopped using
// them as keys in the first place. The fallback therefore re-opened the exact channel the hashing
// closed, and it fired for every bearer that missed oauth_tokens: every stale token, and every
// attacker-supplied one. The code carried its own sunset instruction. The window has passed.
// STILL OPEN, AND DELIBERATELY NOT DONE HERE: purging residual cleartext-ID documents already
// written into oauth_tokens / oauth_refresh. That is a DATA operation, not a code change, and this
// editor performs no data operations. See the accompanying report.
async function oaTokGet(col: string, tok: string): Promise<any> {
  const t = String(tok || ''); if (!t) return null;
  return await oaGet(col, oaTokHash(t));
}

// parse form-urlencoded bodies for the token endpoint (spec uses application/x-www-form-urlencoded)
app.use(express.urlencoded({ extended: true }));

// ============ STRAIN REGISTRY (source of truth for provisioned agent identities) ============
// Phase 1 of per-agent identity: Firestore `strains` is the authoritative directory of who exists +
// the consent-page picker source. NOTE: who()'s in-memory ROLES set is function-local to
// buildMcpServer (not visible at module scope), so this module deliberately does NOT touch it — the
// baked roster (seeded here) is what who() enforces; live-provisioning into who() is handled at deploy
// re-seed and by the A2A rework. All admin endpoints require an unlocked passkey session (waSessionOk).
const STRAIN_RE = /^fleet-[a-z0-9-]+$/;
// [STRAIN-PASTEABLE-V1] /api/sessions/roles filters on pasteable === true. The seed never
// wrote that field, so every fresh install showed 'no pasteable strains' and the operator
// could not mint a session key for ANY strain. onboarder stays unpasteable:
// onboarder is where unclaimed connectors land and is not a chat.
// [RELEASE-ROSTER-V1] Derived from STRAIN_SEED on purpose. There were three
// rosters and they could drift; now there is one list and the extractor has one
// thing to trim for the public release. Every seeded strain can mint a paste.
// [RELEASE-ROSTER-V1] One list, one exclusion. STRAIN_SEED is the roster; a
// strain is pasteable unless it is a SERVICE IDENTITY. fleet-onboarder is
// where unclaimed connectors land -- handing out a paste for it would mint a human key for machinery. The rule lives here
// rather than in a second hand-maintained roster that can drift out of step.
// [STRAIN-TDZ-V1] ORDER IS LOAD-BEARING. STRAIN_PASTEABLE is derived from
// STRAIN_SEED at module scope, so the seed must be DECLARED FIRST. `const`
// hoists into a temporal dead zone: reading it above its initializer throws
// ReferenceError on require, the process exits 1, and the container never
// listens. That shipped once (revision 00245-jur) and was caught only because
// the deploy went out at --no-traffic. esbuild here is transpile-only and will
// never catch it. Do not reorder or separate these three statements.
const STRAIN_SEED = ['fleet-onboarder', /* [STRAIN-SEED-ONBOARDER-V1] OAUTH_DEFAULT_ROLE names this strain; a wipe-and-reseed without it drops every new connector onto the privileged strain */ 'fleet-advisor', 'fleet-gcp', 'fleet-security'];
const STRAIN_NEVER_PASTEABLE = new Set(['fleet-onboarder']);
const STRAIN_PASTEABLE = new Set(
  STRAIN_SEED.filter((r: string) => !STRAIN_NEVER_PASTEABLE.has(r)));
async function strainList(activeOnly: boolean): Promise<any[]> {
  try { const s = await db.collection('strains').get(); let rows = s.docs.map((d: any) => d.data()); if (activeOnly) rows = rows.filter((r: any) => r && r.status === 'active'); return rows; } catch (e) { return []; }
}
// [STRAIN-HIDDEN-SEED-V77] The seed never wrote `hidden`, so every seeded identity showed
// in the Flowhood roster -- including the two that are not strains anyone assigns work to.
// DERIVED from STRAIN_NEVER_PASTEABLE rather than written as a second list, for the reason
// this file already gives twice: a hand-maintained roster beside another roster drifts. The
// two ideas coincide exactly and for one underlying reason -- a SERVICE IDENTITY is neither
// something a human mints a key for nor something a human assigns work to. fleet-onboarder
// is where unclaimed connectors land.
// THE RUNTIME FLAGS STAY INDEPENDENT, which is what the roleflags comment below is about:
// this only sets the value written AT SEED TIME, and POST /api/strains/:role/flags can still
// flip `pasteable` and `hidden` separately afterwards. Deriving the initial value from one
// set is not the same as conflating the two fields.
async function strainSeedIfEmpty(): Promise<void> {
  try {
    const s = await db.collection('strains').limit(1).get();
    if (!s.empty) return;
    for (const role of STRAIN_SEED) {
      const _seedDoc: any = { role, display_name: role, status: 'active', pasteable: STRAIN_PASTEABLE.has(role), hidden: STRAIN_NEVER_PASTEABLE.has(role), created_by: 'system:seed', created_at: FieldValue.serverTimestamp() };
      // [SEC-AUDIT-V105-ONBOARDER-CLASSES] THIS DOES NOT TOUCH pcToolClasses' GLOBAL RULE.
      // Absent/empty tool_classes still means "every class" for every OTHER seeded strain --
      // every strain document already in a live fleet has no tool_classes field, and inverting
      // that default would strip tools from the entire running roster. Out of scope, on purpose.
      // fleet-onboarder is different: it is where OAUTH_ROLE lands every unbound OAuth connector
      // (fail-closed least-privilege target, see SEC-OAUTH-FAILCLOSED-ROLE-V1), and with no
      // tool_classes of its own it inherited PC_ALL_CLASSES -- stage_privileged_job, run_command,
      // gcp_api, vm_* included -- for an identity nobody has bound to a human yet. All it needs
      // to do is answer whoami (exempt from class checks entirely, see the `name !== 'whoami'`
      // carve-outs in the registerTool override) and let the connector read its own onboarding
      // memory/journal while it waits on the consent page. 'read' is the narrowest non-empty
      // class that covers that --
      // pcToolClasses treats an empty array the same as absent ("every class"), so 'read' alone,
      // not [], is what actually narrows it. write/stage/infra/browser are withheld.
      // UPGRADE NOTE: strainSeedIfEmpty() only runs `if (!s.empty) return` -- i.e. only on a
      // virgin strains collection. An operator upgrading an already-seeded fleet keeps whatever
      // fleet-onboarder document already exists (no tool_classes field, still PC_ALL_CLASSES)
      // until it is migrated by hand; this does not retro-fix a live install.
      if (role === 'fleet-onboarder') _seedDoc.tool_classes = ['read'];
      await db.collection('strains').doc(role).set(_seedDoc);
    }
    await db.collection('journal').add({ agent_id: 'human_operator', action: 'strains_seeded', message: 'strain registry seeded with ' + STRAIN_SEED.length + ' canonical roles', timestamp: FieldValue.serverTimestamp() });
  } catch (e) {}
}
// boot: seed the registry once if empty (runs after module init, next tick).
void (async () => { try { await strainSeedIfEmpty();
  try {
    const _ps = await db.collection('strains').limit(200).get();
    for (const _d of _ps.docs) {
      const _r: any = _d.data() || {};
      if (_r.pasteable === undefined && STRAIN_PASTEABLE.has(_d.id)) {
        await db.collection('strains').doc(_d.id).set({ pasteable: true }, { merge: true });
      }
    }
  } catch (e) {}
  // [SEC-RETIRE-MIGRATION-V1] THIS IS A COMPLETED ONE-TIME MIGRATION, NOT A BOOT INVARIANT.
  // It used to run UNCONDITIONALLY with two role names from THIS fleet's own history baked in,
  // and set(..., {merge:true}) CREATES a document that does not exist -- so every fresh install
  // in a stranger's project had two retired strains named after our history written into its
  // database on first boot. That is the no-operator-identity-in-shipped-text standing order,
  // violated in the one place a downloader cannot even see it: their Firestore.
  // WHY DELETING THE LINE OUTRIGHT WAS REJECTED, and why nothing depends on it re-running:
  // the two documents ALREADY EXIST in this fleet's prod carrying status 'retired', and nothing
  // re-activates them -- strainSeedIfEmpty() only ever writes roles in STRAIN_SEED, and neither
  // name is in it. The loop was re-asserting a state that was already durable. It is retired
  // here rather than deleted so the mechanism survives for the next migration.
  // TWO INDEPENDENT REASONS A FRESH INSTALL NOW CREATES NOTHING:
  //   1. the list is EMPTY by default and comes from the environment, so no name from this
  //      fleet's history is in the shipped text at all; and
  //   2. the loop now RETIRES ONLY A DOCUMENT THAT ALREADY EXISTS. It can no longer conjure a
  //      strain, so even a mistyped PC_RETIRE_STRAINS cannot invent one in anyone's database.
  const _retire = String(process.env.PC_RETIRE_STRAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const _b of _retire) {
    try {
      const _ex = await db.collection('strains').doc(_b).get();
      if (!_ex || !_ex.exists) { console.error('[strains] retire skipped: ' + _b + ' does not exist here; refusing to create it'); continue; }
      await db.collection('strains').doc(_b).set({ role: _b, status: 'retired', retired_by: 'system:failclosed', retired_at: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {}
  }
  const _mig = await db.collection('migrations').doc('failclosed_v1').get().catch(() => null); if (!_mig || !_mig.exists) { for (const _c of ['oauth_tokens', 'oauth_refresh']) { try { const _s = await db.collection(_c).get(); for (const _d of _s.docs) { try { await _d.ref.delete(); } catch (e) {} } } catch (e) {} } try { await db.collection('migrations').doc('failclosed_v1').set({ done_at: FieldValue.serverTimestamp(), note: 'purged oauth tokens' }); } catch (e) {} } console.error('[strains] seeded; banned retired; oauth tokens purged (one-time)'); } catch (e) { console.error('[strains] boot migration failed', e); } })();

app.get('/api/strains', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  res.json({ strains: await strainList(false) });
}));
app.post('/api/strains/provision', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const role = String((req.body && req.body.role) || '').trim();
  const display = String((req.body && req.body.display_name) || role).trim();
  if (!STRAIN_RE.test(role)) { res.status(400).json({ error: 'role must match fleet-<name>' }); return; }
  // [SEC-STRAIN-CLASSES-V1] THE FIELD PC_TOOLS_ENFORCE READS HAD NO WRITER, WHICH IS THE WHOLE
  // REASON THE FLAG ENFORCED NOTHING. pcToolClasses reads strains/<role>.tool_classes. Before
  // this, the only writer of any field named tool_classes in the tree was /api/sessions/mint,
  // and that one writes session_keys.tool_classes -- a DIFFERENT collection, read by a
  // DIFFERENT function (pcNarrowClasses). So every strain took the absent-means-every-class
  // branch at pcToolClasses:821 and PC_TOOLS_ENFORCE=1 withheld nothing from anybody. Turning
  // the flag on was never sufficient; there was no supported way to populate what it reads.
  // Validation below is deliberately IDENTICAL to the mint endpoint's so the two writers of
  // this vocabulary cannot drift into accepting different names for the same class.
  //
  // AN EXPLICIT EMPTY ARRAY IS REFUSED HERE, AND THE ASYMMETRY WITH MINT IS THE POINT.
  // pcNarrowClasses reads [] on a KEY as the read-only floor. pcToolClasses reads [] on a
  // STRAIN through 'Array.isArray(raw) && raw.length', which is FALSE for [], which returns
  // PC_ALL_CLASSES. So an operator writing [] to mean 'nothing' would silently grant
  // EVERYTHING -- the exact inversion this endpoint exists to end. Refuse it and say what to
  // write instead, rather than accepting a value whose meaning is the opposite of its shape.
  const rawtc = (req.body || {}).tool_classes;
  let stcl: string[] | null = null;
  if (typeof rawtc !== 'undefined') {
    if (!Array.isArray(rawtc)) { res.status(400).json({ error: 'tool_classes must be an array of class names; known: ' + PC_ALL_CLASSES.join(',') }); return; }
    if (!rawtc.length) { res.status(400).json({ error: 'an empty tool_classes array on a STRAIN means EVERY class, not none: pcToolClasses treats absent and empty alike. Write ["read"] for sight-only, or omit the field to leave the strain unrestricted.' }); return; }
    const badtc = rawtc.filter((x: any) => typeof x !== 'string' || PC_ALL_CLASSES.indexOf(x) < 0);
    if (badtc.length) { res.status(400).json({ error: 'unknown tool class ' + JSON.stringify(badtc).slice(0, 120) + '; known: ' + PC_ALL_CLASSES.join(',') }); return; }
    stcl = rawtc.map((x: any) => String(x));
  }
  await db.collection('strains').doc(role).set({ role, display_name: display || role, status: 'active', created_by: 'passkey:' + WA_USER, created_at: FieldValue.serverTimestamp(), ...(stcl === null ? {} : { tool_classes: stcl }) }, { merge: true });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'strain_provisioned', message: 'provisioned strain ' + role + ' (' + (display || role) + ') — active on next control-plane deploy' + (stcl === null ? '' : ' — tool_classes RESTRICTED to [' + stcl.join(',') + ']'), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, role, status: 'active', tool_classes: stcl, note: stcl === null ? 'unrestricted: this strain holds every tool class' : 'pcToolClasses caches for up to ' + PC_CLASS_TTL_MS + 'ms, so this takes effect within a minute' });
}));
app.post('/api/strains/retire', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const role = String((req.body && req.body.role) || '').trim();
  if (!role) { res.status(400).json({ error: 'role required' }); return; }
  await db.collection('strains').doc(role).set({ status: 'retired', retired_by: 'passkey:' + WA_USER, retired_at: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'strain_retired', message: 'retired strain ' + role + ' — removed from roster on next control-plane deploy', timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, role, status: 'retired' });
}));
// [SEC-OAUTH-STRAINS-GATE] fleet-security 2026-07-30. This route USED to be public. The comment that
// stood here justified that by saying the consent page needs the roster so a human can bind a
// connector to a strain. THAT JUSTIFICATION IS FALSE IN THE DEPLOYED ARTIFACT, and it was verified
// false against real bytes rather than assumed: the human-only connector change removed the
// consent page's fetch of this route outright, and the consent page in THIS source carries no
// such fetch -- so the shipped page never calls it. What was left behind was an anonymous,
// unauthenticated enumeration of the fleet roster -- every active strain, role and display name -- to
// any caller on a public origin that also serves the passkey gate.
// GATED, NOT DELETED, and out-of-tree callers do exist: MCP admission control and the OAuth
// role-restore path both make unauthenticated pre-flight GETs of this exact URL, so removing the
// route would break them silently. Those callers must now hold a passkey session
// or move to /api/strains. The guard matches the convention of /api/strains directly above.
app.get('/oauth/strains', async (req: express.Request, res: express.Response) => { if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first', gate: 'SEC-OAUTH-STRAINS-GATE' }); return; } res.json({ strains: (await strainList(true)).filter((r: any) => r.hidden !== true).map((r: any) => ({ role: r.role, display_name: r.display_name || r.role })) }); });
// ============ end strain registry ============

// ============ A2A: Agent Cards generated from the strain registry ============
// Per-agent identity, A2A-native: every provisioned strain is a discoverable A2A agent. Cards are
// built live from `strains` + our OAuth 2.1 security scheme. Directory at /.well-known/agents; a
// per-strain card at /agents/:role/.well-known/agent-card.json (A2A v0.2.x well-known path).
// The card's role IS the identity a connector bound to it must act as (enforced in the Phase-3 flip).
function a2aSecurity(b: string): any {
  return {
    securitySchemes: {
      paracoding_oauth: {
        type: 'oauth2', description: 'Paracoding fleet OAuth 2.1 (Google-backed identity, PKCE, no client secret)',
        flows: { authorizationCode: { authorizationUrl: b + '/oauth/authorize', tokenUrl: b + '/oauth/token', refreshUrl: b + '/oauth/token', scopes: { mcp: 'Fleet MCP access' } } },
      },
    },
    security: [{ paracoding_oauth: ['mcp'] }],
  };
}
function a2aCard(role: string, display: string, b: string): any {
  const sec = a2aSecurity(b);
  return {
    protocolVersion: '0.2.5',
    name: display || role,
    description: 'Paracoding fleet strain "' + role + '" - an autonomous agent on the Paracoding control plane.',
    url: b + '/mcp',
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Paracoding.AI', url: b },
    version: '1.0.0',
    documentationUrl: b + '/.well-known/agents',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    securitySchemes: sec.securitySchemes,
    security: sec.security,
    skills: [{ id: role + '.work', name: role + ' tasks', description: 'Role-scoped fleet work performed by the ' + role + ' strain.', tags: ['paracoding', 'fleet', role], inputModes: ['text/plain'], outputModes: ['text/plain'] }],
    'x-paracoding': { role, registry: b + '/api/strains', identityModel: 'per-agent (A2A)', liveTransport: 'mcp-streamable-http' },
  };
}
async function a2aServeCard(req: any, res: any, role: string): Promise<void> {
  const b = oaPubBase(req);
  const rows = await strainList(false);
  const row = rows.find((r: any) => r.role === role);
  // [SEC-AUDIT-V105-HIDDEN-CARD] /.well-known/agents already withholds hidden roles (r.hidden
  // !== true) from the public roster, but this route served the full agent card for one anyway
  // if the caller already knew (or guessed) its name -- hidden was a roster-listing filter, not
  // an access control. A hidden strain must 404 exactly as an absent or inactive one does, with
  // the SAME body, so a prober cannot distinguish "hidden" from "does not exist" by response shape.
  if (!row || row.status !== 'active' || row.hidden === true) { res.status(404).json({ error: 'no active strain "' + role + '"' }); return; }
  res.setHeader('Content-Type', 'application/json');
  res.json(a2aCard(row.role, row.display_name || row.role, b));
}
app.get('/.well-known/agents', async (req: any, res: any) => {
  const b = oaPubBase(req);
  const rows = (await strainList(true)).filter((r: any) => r.hidden !== true);
  res.json({ provider: { organization: 'Paracoding.AI', url: b }, protocolVersion: '0.2.5', count: rows.length,
    agents: rows.map((r: any) => ({ role: r.role, name: r.display_name || r.role, agentCard: b + '/agents/' + r.role + '/.well-known/agent-card.json' })) });
});
app.get('/agents/:role/.well-known/agent-card.json', async (req: any, res: any) => { await a2aServeCard(req, res, String(req.params.role || '')); });
app.get('/agents/:role/.well-known/agent.json', async (req: any, res: any) => { await a2aServeCard(req, res, String(req.params.role || '')); });
app.get('/.well-known/agent.json', async (req: any, res: any) => { await a2aServeCard(req, res, String((req.query && req.query.role) || OAUTH_ROLE)); });
// ============ end A2A Agent Cards ============


// ---- RFC 9728 Protected Resource Metadata (resource = the actual MCP endpoint) ----
// [BRAND-SELFHOST-V80] logo_uri and resource_name are what put the connector's icon and
// name back in an MCP client's UI. MEASURED before this change: this origin answered 404
// on /favicon.ico, /icon.png and /logo.png and this document carried neither field, which
// is why the icon disappeared when the connector moved to the MCP host. Both are plain
// metadata a client may ignore.
function oaPrMeta(req: any): any { const b = oaPubBase(req); return { resource: b + '/mcp', authorization_servers: [b], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: 'Paracoding', logo_uri: b + '/icon.png' }; }
app.get('/.well-known/oauth-protected-resource', (req: any, res: any) => res.json(oaPrMeta(req)));
app.get('/.well-known/oauth-protected-resource/mcp', (req: any, res: any) => res.json(oaPrMeta(req)));

// ---- RFC 8414 Authorization Server Metadata ----
function oaAsMeta(req: any): any {
  const b = oaPubBase(req);
  return {
    // [OSS-IAPAUTH-V54] issuer and token_endpoint stay on the MCP host; only the browser step moves.
    issuer: b, authorization_endpoint: oaAuthBase(req) + '/oauth/authorize', token_endpoint: b + '/oauth/token',
    registration_endpoint: b + '/oauth/register', response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  };
}
app.get('/.well-known/oauth-authorization-server', (req: any, res: any) => res.json(oaAsMeta(req)));
app.get('/.well-known/oauth-authorization-server/mcp', (req: any, res: any) => res.json(oaAsMeta(req)));
app.get('/.well-known/openid-configuration', (req: any, res: any) => res.json(oaAsMeta(req)));

// ---- RFC 7591 Dynamic Client Registration ----
// [SEC-OAUTH-REG-RATELIMIT] POST /oauth/register is reachable by allUsers and, before this change,
// every anonymous request carrying {"redirect_uris":["http://x"]} wrote a permanent document into
// the `oauth_clients` collection. There was no cap of any kind: no per-IP bucket, no fleet-wide
// ceiling, and no 429 anywhere in the shipped bundle. One loop fills the collection, inflates the
// bill, and buries the real clients.
//
// WHY NOT A PROCESS-LOCAL MAP, which is the obvious fix and the one usually proposed: a
// `new Map()` on Cloud Run is wrong three ways and cannot meet the brief.
// (1) The state is per-INSTANCE and dies on cold start, so a "global cap of 100" is really 100 x
// however many instances the attacker's own traffic causes to be spun up -- the global cap is the
// one thing a Map provably cannot provide. (2) It can never FAIL CLOSED: a Map has no read that
// can fail, so there is no failure to close over. (3) Read-modify-write on a Map is not atomic
// across concurrent requests. The counters therefore live in Firestore.
//
// Firestore is already in scope and no dependency is added: `db` is the getFirestore() handle
// created at the top of this file from the existing 'firebase-admin/firestore' import, the same
// handle oaGet/oaSet already use. This code deliberately does NOT go through oaGet/oaSet --
// those swallow every exception and return null / silently drop the write, which is precisely
// the fail-OPEN behaviour that must not exist in a limiter. db.runTransaction() gives us the
// atomic read-modify-write and, critically, THROWS on a failed read or commit, which is what the
// caller converts into a refusal.
const OA_REG_IP_LIMIT = Number(process.env.OAUTH_REG_IP_LIMIT || 5);
const OA_REG_GLOBAL_LIMIT = Number(process.env.OAUTH_REG_GLOBAL_LIMIT || 100);
const OA_REG_WINDOW_MS = 3600000;
const OA_REG_LIMIT_COL = 'oauth_reg_limits';
// The RIGHTMOST X-Forwarded-For entry, not the leftmost. Each proxy appends the address of the
// peer it received the request from, so the last entry is the one Google's front end wrote and
// is the only one a client cannot forge; the leftmost is attacker-controlled and would let one
// host mint an unlimited number of distinct per-IP buckets. When the header is absent we fall
// back to the socket. Even if the address is somehow shared or unknown, the global cap holds.
// [SEC-XFF-ONE-READING-V51] ONE READING OF "WHO IS CALLING", BECAUSE THERE WERE TWO AND THEY
// WERE WRONG IN OPPOSITE DIRECTIONS ON THE SAME ROUTE.
//
// MEASURED 2026-08-15 on a fresh adopter install: POST /oauth/register answered 429
// "too many client registrations from this address" to a container that had NEVER called it,
// from an unrelated address, on its first attempt -- while the operator, on a different
// continent's worth of IP, was locked out of adding the connector at all. Two helpers were
// feeding two limiters on that one route:
//
//   oaClientIp     -> xff[xff.length - 1], which behind Cloud Run is ALWAYS the Google front
//                     end. Every caller on earth hashed to the same string, so the
//                     "per-address" Firestore bucket was ONE GLOBAL BUCKET and any user's
//                     retries locked out every other user. That is what bit the install.
//   oaRegClientIp  -> xff[0], which is CLIENT-SUPPLIED. Google APPENDS the observed peer, so a
//                     caller who sends its own X-Forwarded-For controls index 0 and can mint a
//                     fresh bucket per request, evading the in-process cap entirely.
//
// So one limiter was a denial of service against legitimate users and the other was a bypass
// for an attacker, and fixing either alone leaves the other hole open. That is the concrete
// harm of two readings of one fact, and it is why this is now a single function.
//
// THE CORRECT READING IS POSITIONAL FROM THE RIGHT. The rightmost entry is appended by the hop
// closest to us and is trustworthy; everything to its left may be forged. With exactly one
// trusted proxy in front (Cloud Run's load balancer, the default) the client is the LAST entry
// the proxy appended -- index length-1-hops. A forged prefix shifts only the entries we already
// distrust: ["forged","client","lb"] still resolves to "client". Configurable because an
// install behind an extra CDN or WAF has more trusted hops, and hardcoding 1 would silently
// return the CDN's address and recreate the global-bucket bug one layer up.
const PC_TRUSTED_PROXY_HOPS = (function () {
  const n = Number(process.env.PC_TRUSTED_PROXY_HOPS || '1');
  return (isFinite(n) && n >= 0) ? Math.floor(n) : 1;
})();
function pcTrustedClientIp(req: any): string {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map((s: string) => s.trim()).filter(Boolean);
  if (xff.length) {
    const idx = xff.length - 1 - PC_TRUSTED_PROXY_HOPS;
    return xff[idx >= 0 ? idx : 0];
  }
  return String((req && req.ip) || (req && req.connection && req.connection.remoteAddress)
    || (req && req.socket && req.socket.remoteAddress) || 'unknown');
}
// Both former helpers now delegate. The NAMES are kept so no call site changes in this commit
// -- the defect was two READINGS, not two names, and a rename would enlarge the diff without
// removing anything that can drift.
function oaClientIp(req: any): string {
  return pcTrustedClientIp(req);
}
// Returns { ok: true } and CONSUMES one unit of both budgets, or { ok: false, scope } and consumes
// nothing. THROWS if Firestore is unreachable -- the caller must treat that as a refusal.
async function oaRegRateLimit(ip: string): Promise<{ ok: boolean; scope: string }> {
  const now = Date.now();
  const gRef = db.collection(OA_REG_LIMIT_COL).doc('global');
  const ipRef = db.collection(OA_REG_LIMIT_COL).doc('ip_' + oaTokHash(ip));
  return await db.runTransaction(async (tx: any): Promise<{ ok: boolean; scope: string }> => {
    const gSnap = await tx.get(gRef);
    const ipSnap = await tx.get(ipRef);
    const g: any = (gSnap && gSnap.exists && gSnap.data()) || null;
    const i: any = (ipSnap && ipSnap.exists && ipSnap.data()) || null;
    const gLive = !!(g && Number(g.reset) > now);
    const iLive = !!(i && Number(i.reset) > now);
    const gCount = gLive ? (Number(g.count) || 0) : 0;
    const iCount = iLive ? (Number(i.count) || 0) : 0;
    const gReset = gLive ? Number(g.reset) : now + OA_REG_WINDOW_MS;
    const iReset = iLive ? Number(i.reset) : now + OA_REG_WINDOW_MS;
    if (gCount >= OA_REG_GLOBAL_LIMIT) return { ok: false, scope: 'global' };
    if (iCount >= OA_REG_IP_LIMIT) return { ok: false, scope: 'ip' };
    tx.set(gRef, { count: gCount + 1, reset: gReset, updated_at: FieldValue.serverTimestamp() });
    tx.set(ipRef, { count: iCount + 1, reset: iReset, updated_at: FieldValue.serverTimestamp() });
    return { ok: true, scope: '' };
  });
}

// [OAUTH-REG-CAP-V1] 2026-08-01. POST /oauth/register is RFC 7591 dynamic client
// registration and has to stay public -- it is how an MCP connector registers itself, so
// authenticating it would stop Claude connecting at all. It was, however, completely
// uncapped: an anonymous caller could write unbounded documents into Firestore. Every
// installer of the OSS release inherits that, which is why this is worth doing tonight.
// HONEST LIMIT: this counter lives in ONE Cloud Run instance's memory. Under scale-out an
// attacker gets this limit times the instance count, and a distributed attacker gets it per
// source address. It is a ceiling, not a wall. A true global cap needs a shared counter and
// is a larger change than belongs in a release patch.
const OA_REG_PER_IP_PER_HOUR = parseInt(process.env.OAUTH_REG_PER_IP_PER_HOUR || '20', 10);
const OA_REG_MAX_FIELD = parseInt(process.env.OAUTH_REG_MAX_FIELD || '2048', 10);
const oaRegHits: any = new Map();
function oaRegClientIp(req: any): string {
  return pcTrustedClientIp(req);
}
function oaRegAllow(ip: string): boolean {
  const now = Date.now();
  const win = 3600000;
  const seen = (oaRegHits.get(ip) || []).filter(function (t: number) { return now - t < win; });
  if (seen.length >= OA_REG_PER_IP_PER_HOUR) { oaRegHits.set(ip, seen); return false; }
  seen.push(now);
  oaRegHits.set(ip, seen);
  // unbounded Maps are their own memory-exhaustion bug; drop the table rather than grow it
  if (oaRegHits.size > 20000) oaRegHits.clear();
  return true;
}
function oaRegBodyTooBig(req: any): boolean {
  const b = (req && req.body) || {};
  try {
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (typeof v === 'string' && v.length > OA_REG_MAX_FIELD) return true;
      if (Array.isArray(v) && v.length > 64) return true;
    }
    return JSON.stringify(b).length > OA_REG_MAX_FIELD * 8;
  } catch (e) { return true; }
}

app.post('/oauth/register', async (req: any, res: any) => {
  // [OAUTH-REG-CAP-V1] ceiling before any parse or write. See the helper above.
  {
    const _ip = oaRegClientIp(req);
    if (!oaRegAllow(_ip)) {
      res.setHeader('Retry-After', '3600');
      res.status(429).json({ error: 'oauth_register_rate_limited', error_description: 'Too many client registrations from this address. Try again later.' });
      return;
    }
    if (oaRegBodyTooBig(req)) {
      res.status(413).json({ error: 'invalid_client_metadata', error_description: 'Registration payload exceeds the permitted size.' });
      return;
    }
  }

  const body = req.body || {};
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map((x: any) => String(x)).filter(Boolean) : [];
  if (!redirect_uris.length) { res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' }); return; }
  // [SEC-OAUTH-REG-RATELIMIT] Shape-check first (a malformed body is rejected without touching
  // Firestore at all, so a broken client cannot burn its own quota), then take the budget, then
  // write. The check and the increment are the SAME transaction, so N concurrent registrations
  // cannot all read the pre-increment count and all pass.
  let oaRegGate: { ok: boolean; scope: string };
  try {
    oaRegGate = await oaRegRateLimit(oaClientIp(req));
  } catch (e: any) {
    // FAIL CLOSED. If the limiter's own read or commit fails we do not know how many
    // registrations have already happened, so we refuse rather than write an uncounted document.
    console.error('[oauth] SEC-OAUTH-REG-RATELIMIT: limiter unavailable, REFUSING registration (fail-closed): ' + String((e && e.message) || e));
    res.status(429).json({ error: 'rate_limit_exceeded', error_description: 'registration rate limiter unavailable', code: 'SEC-OAUTH-REG-RATELIMIT' });
    return;
  }
  if (!oaRegGate.ok) {
    res.setHeader('Retry-After', String(Math.ceil(OA_REG_WINDOW_MS / 1000)));
    res.status(429).json({ error: 'rate_limit_exceeded', error_description: oaRegGate.scope === 'global' ? 'global client registration cap reached' : 'too many client registrations from this address', code: 'SEC-OAUTH-REG-RATELIMIT' });
    return;
  }
  const client_id = oaRand(16);
  const rec = { client_id, redirect_uris, client_name: String(body.client_name || 'mcp-client'), token_endpoint_auth_method: 'none', created: Date.now() };
  await oaSet('oauth_clients', client_id, rec);
  res.status(201).json({
    client_id, redirect_uris, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  });
});

// ---- Authorization endpoint (Google-backed consent page) ----
// [SEC-OAUTH-XSS-SCRIPTJSON] REFLECTED XSS ON THE ANONYMOUS CONSENT PAGE.
// JSON.stringify() produces valid JSON. It does NOT produce a string that is safe inside a
// <script> element: the HTML tokenizer finds the script element's end tag BEFORE the JS parser
// ever sees the source, so a value carrying a closing script tag terminates the script early and
// the rest of that value is parsed as MARKUP. oaAuthHtml() splices client_id, redirect_uri,
// code_challenge, state and scope -- every one straight off the query string -- into the page's
// inline script, and /oauth/authorize is reachable by allUsers on the same origin that serves the
// passkey gate. Escape the three characters that can end or reinterpret a script element, plus
// the two Unicode line terminators that are legal inside a JSON string but are line breaks to a
// JS parser. The result is still valid JSON and still parses to the IDENTICAL value, so the
// consent flow is unchanged -- only the bytes on the wire are.
// FUTURE EDITORS: the replacement literals below MUST carry TWO backslashes in this source so the
// emitted JSON carries ONE. Writing them with a single backslash compiles to the bare character
// and turns the whole helper into a silent no-op that still deploys and still looks fixed.
function oaJsonForScript(v: any): string {
  return String(JSON.stringify(v))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
function oaAuthHtml(p: any): string {
  const P = oaJsonForScript(p);
  const CID = oaJsonForScript(oaGoogleOn() ? OA_GID : '');
  // [OSS-AUTHMODE-V54] The page never ships the secret, only whether the field should exist.
  const SELF = oaSelfOn() ? 'true' : 'false';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Authorize Paracoding connector</title><script src="https://accounts.google.com/gsi/client" async></script>'
    + '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#20103f,#3a1e63 52%,#6a2a7e) fixed;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:1rem}'
    + '.card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.26);border-radius:18px;padding:1.6rem;max-width:380px;text-align:center;backdrop-filter:blur(8px);box-shadow:0 20px 60px rgba(0,0,0,.4)}'
    + 'h1{font-size:1.15rem;margin:.2rem 0 .4rem;background:linear-gradient(90deg,#ffe9a8,#e0982e);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'p{color:rgba(255,255,255,.82);font-size:.86rem;line-height:1.45}#g{display:flex;justify-content:center;margin:1.1rem 0}#msg{font-size:.8rem;color:#ffd7d0;min-height:1.2em}'
    + 'select{margin-top:.35rem;padding:.45rem .6rem;border-radius:9px;min-width:200px;font-size:.9rem;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff}label{font-size:.78rem;color:rgba(255,255,255,.72)}'
    + 'input{width:100%;box-sizing:border-box;padding:.5rem .6rem;border-radius:9px;font-size:.9rem;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff}'
    + 'button{margin-top:.5rem;width:100%;padding:.5rem .6rem;border-radius:999px;border:1px solid rgba(255,255,255,.3);background:linear-gradient(90deg,#ffe9a8,#e0982e);color:#2a1740;font-weight:600;font-size:.9rem;cursor:pointer}'
    + '#sep{margin:1rem 0 .4rem;font-size:.72rem;letter-spacing:.14em;color:rgba(255,255,255,.5)}#self{display:none;text-align:left}</style></head>'
    + '<body><div class="card"><h1>Authorize connector</h1><p id="lede">Connect this MCP client to your Paracoding fleet. Only approved accounts can authorize.</p>'
    + ''
    + '<div id="g"></div>'
    + '<div id="sep" style="display:none">OR</div>'
    + '<div id="self"><label for="ck">Connector key</label><input id="ck" type="password" autocomplete="off" spellcheck="false">'
    + '<button id="ckgo" type="button">Authorize</button></div>'
    + '<div id="msg"></div></div><script>'
    + 'var P=' + P + ';var CID=' + CID + ';var SELF=' + SELF + ';'
    + 'function onCred(resp){document.getElementById("msg").style.color="#c6ffe4";document.getElementById("msg").textContent="Authorizing…";'
    + 'var role="";'
    + 'fetch("/oauth/authorize/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({id_token:resp.credential,role:role},P))})'
    + '.then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location=d.redirect;}else{document.getElementById("msg").style.color="#ffd7d0";document.getElementById("msg").textContent=d.error||"authorization failed";}})'
    + '.catch(function(e){document.getElementById("msg").textContent=String(e);});}'
    + 'function onKey(){var k=document.getElementById("ck").value||"";var m=document.getElementById("msg");'
    + 'if(!k){m.style.color="#ffd7d0";m.textContent="enter the connector key";return;}'
    + 'document.getElementById("ckgo").disabled=true;m.style.color="#c6ffe4";m.textContent="Authorizing\\u2026";'
    + 'fetch("/oauth/authorize/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({key:k},P))})'
    + '.then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location=d.redirect;}else{document.getElementById("ckgo").disabled=false;m.style.color="#ffd7d0";m.textContent=d.error||"authorization failed";}})'
    + '.catch(function(e){document.getElementById("ckgo").disabled=false;m.textContent=String(e);});}'
    + 'window.onload=function(){'
    + ''
    // [OSS-AUTHMODE-V54] Three states, and the no-way-in one must SAY so rather than render a
    // dead page. The old text ("server: no Google client configured") was the only thing an
    // adopter ever saw, because no install has ever had a client id.
    + 'var lede=document.getElementById("lede");'
    + 'if(SELF){document.getElementById("self").style.display="block";'
    + 'document.getElementById("ckgo").addEventListener("click",onKey);'
    + 'document.getElementById("ck").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();onKey();}});}'
    + 'if(!CID&&!SELF){document.getElementById("msg").textContent="server: no connector sign-in is configured on this install";return;}'
    + 'if(!CID){if(lede){lede.textContent="Enter your connector key to connect this MCP client to your Paracoding fleet.";}return;}'
    + 'if(SELF){document.getElementById("sep").style.display="block";}'
    + 'google.accounts.id.initialize({client_id:CID,callback:onCred});'
    + 'google.accounts.id.renderButton(document.getElementById("g"),{theme:"filled_blue",size:"large",text:"signin_with",shape:"pill"});'
    + 'google.accounts.id.prompt();};'
    + '</script></body></html>';
}
// [OSS-IAPAUTH-V54] The IAP variant. No Google client id, no GIS script, no password field --
// IAP has already authenticated the human with Google and handed us a signed assertion. The page
// shows WHICH account it is (so a wrong browser profile is visible before anything is granted,
// which is the failure the operator actually hit) and asks for one deliberate click.
function oaIapAuthHtml(p: any, email: string, allowed: boolean): string {
  const P = oaJsonForScript(p);
  const EM = oaJsonForScript(email || '');
  const OK = allowed ? 'true' : 'false';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Authorize Paracoding connector</title>'
    + '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#20103f,#3a1e63 52%,#6a2a7e) fixed;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:1rem}'
    + '.card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.26);border-radius:18px;padding:1.6rem;max-width:380px;text-align:center;backdrop-filter:blur(8px);box-shadow:0 20px 60px rgba(0,0,0,.4)}'
    + 'h1{font-size:1.15rem;margin:.2rem 0 .4rem;background:linear-gradient(90deg,#ffe9a8,#e0982e);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'p{color:rgba(255,255,255,.82);font-size:.86rem;line-height:1.45}#who{font-weight:600;color:#c6ffe4;word-break:break-all}'
    + '#msg{font-size:.8rem;color:#ffd7d0;min-height:1.2em}'
    + 'button{margin-top:.9rem;width:100%;padding:.55rem .6rem;border-radius:999px;border:1px solid rgba(255,255,255,.3);background:linear-gradient(90deg,#ffe9a8,#e0982e);color:#2a1740;font-weight:600;font-size:.95rem;cursor:pointer}'
    + 'button[disabled]{opacity:.45;cursor:not-allowed}</style></head>'
    + '<body><div class="card"><h1>Authorize connector</h1>'
    + '<p>Signed in with Google as<br><span id="who"></span></p>'
    + '<p id="note"></p>'
    + '<button id="go" type="button">Authorize this connector</button><div id="msg"></div></div><script>'
    + 'var P=' + P + ';var EM=' + EM + ';var OK=' + OK + ';'
    + 'document.getElementById("who").textContent=EM||"(no account)";'
    + 'var note=document.getElementById("note");var go=document.getElementById("go");var msg=document.getElementById("msg");'
    + 'if(!OK){go.disabled=true;note.textContent=EM?("This account is not on the allowed list. Add it in Settings, then reload."):("No Google identity reached this page. Check that IAP is enabled on this service.");}'
    + 'go.addEventListener("click",function(){go.disabled=true;msg.style.color="#c6ffe4";msg.textContent="Authorizing\\u2026";'
    + 'fetch("/oauth/authorize/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({via:"iap"},P))})'
    + '.then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location=d.redirect;}else{go.disabled=false;msg.style.color="#ffd7d0";msg.textContent=d.error||"authorization failed";}})'
    + '.catch(function(e){go.disabled=false;msg.textContent=String(e);});});'
    + '</script></body></html>';
}
app.get('/oauth/authorize', async (req: any, res: any) => {
  const q = req.query || {};
  const client = await oaGet('oauth_clients', String(q.client_id || ''));
  if (!client) { res.status(400).send('invalid client_id'); return; }
  const redirect = String(q.redirect_uri || '');
  // redirect_uri MUST be present and exactly match one registered for this client (no open redirect)
  if (!redirect || !Array.isArray(client.redirect_uris) || client.redirect_uris.indexOf(redirect) === -1) { res.status(400).send('invalid redirect_uri'); return; }
  if (String(q.response_type || 'code') !== 'code') { res.status(400).send('unsupported response_type'); return; }
  if (String(q.code_challenge_method || '') !== 'S256') { res.status(400).send('PKCE S256 required'); return; }
  if (!String(q.code_challenge || '')) { res.status(400).send('code_challenge required'); return; }
  const params = { client_id: String(q.client_id), redirect_uri: redirect, code_challenge: String(q.code_challenge), state: String(q.state || ''), scope: String(q.scope || 'mcp') };
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // [OSS-IAPAUTH-V54] On the console surface IAP has ALREADY signed the human in with Google
  // before this handler runs, so there is no button to press and no client id to configure --
  // the identity is in the request. This is the whole point of the split: the copy of this route
  // on the MCP surface still serves the GIS/connector-key page for installs that use those.
  if (PC_SURFACE === 'console' && oaIapAuthOn()) {
    const iapEmail = pcIapEmail(req);
    res.send(oaIapAuthHtml(params, iapEmail, await oaAllowed(iapEmail)));
    return;
  }
  res.send(oaAuthHtml(params));
});
// [OSS-IAPAUTH-V54] ONE mint path for every way a human can prove who they are. The IAP branch,
// the GIS branch and the connector-key branch differ ONLY in how `email` was established; from
// here on the client lookup, the redirect_uri re-validation, the role binding, the code shape and
// the TTL are identical by construction. Written as a shared function rather than copied per
// branch specifically so a later fix to one cannot silently miss the others -- three copies of a
// redirect_uri check is three chances to leave an open redirect behind.
// `via` is recorded for audit only. It is never read as an authorisation input.
async function oaMintAndRedirect(res: any, b: any, email: string, via: string): Promise<void> {
  const client = await oaGet('oauth_clients', String((b && b.client_id) || ''));
  if (!client) { res.status(400).json({ error: 'invalid client' }); return; }
  const redirect = String((b && b.redirect_uri) || '');
  // re-validate against the REGISTERED list: the browser controls the body, so a check done at
  // GET /oauth/authorize does not carry over to this POST. No open redirect.
  if (!redirect || !Array.isArray(client.redirect_uris) || client.redirect_uris.indexOf(redirect) === -1) { res.status(400).json({ error: 'invalid redirect_uri' }); return; }
  // bind this connector to a chosen, provisioned strain (falls back to the unbound guest identity)
  // [FAIL-CLOSED IDENTITY] the app connector ALWAYS acts as the human principal. Strains authenticate
  // via GCP Agent Identity (SPIFFE), never through this OAuth connector. No dropdown trust, no default-to-guest.
  const role = OAUTH_ROLE;
  const code = oaRand(24);
  await oaSet('oauth_codes', code, { client_id: String(b.client_id), redirect_uri: redirect, code_challenge: String((b && b.code_challenge) || ''), email, role, via, exp: Date.now() + 600000 });
  try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'oauth_authorized', message: 'connector authorized via ' + via + ' as ' + email, timestamp: FieldValue.serverTimestamp() }); } catch (e) { }
  const url = redirect + (redirect.indexOf('?') === -1 ? '?' : '&') + 'code=' + encodeURIComponent(code) + (b && b.state ? ('&state=' + encodeURIComponent(String(b.state))) : '');
  res.json({ redirect: url });
}
// [OSS-AUTHMODE-V54] The connector-key branch. This is a PASSWORD endpoint, so unlike
// /oauth/register (which is capped in one instance's memory and says so) the counter must be
// shared: an attacker who can trigger scale-out otherwise gets the limit once per instance. The
// budget lives in Firestore, is consumed on FAILURE only, and a Firestore outage REFUSES rather
// than allowing -- an unreachable limiter on a password endpoint means no limiter at all.
const OA_KEY_LIMIT_COL = 'oauth_key_limits';
const OA_KEY_IP_LIMIT = Number(process.env.OAUTH_KEY_IP_LIMIT || 10);
const OA_KEY_GLOBAL_LIMIT = Number(process.env.OAUTH_KEY_GLOBAL_LIMIT || 60);
const OA_KEY_WINDOW_MS = 3600000;
async function oaKeyRateLimit(ip: string): Promise<{ ok: boolean; scope: string }> {
  const now = Date.now();
  const gRef = db.collection(OA_KEY_LIMIT_COL).doc('global');
  const ipRef = db.collection(OA_KEY_LIMIT_COL).doc('ip_' + oaTokHash(ip));
  return await db.runTransaction(async (tx: any): Promise<{ ok: boolean; scope: string }> => {
    const gSnap = await tx.get(gRef);
    const ipSnap = await tx.get(ipRef);
    const g: any = (gSnap && gSnap.exists && gSnap.data()) || null;
    const i: any = (ipSnap && ipSnap.exists && ipSnap.data()) || null;
    const gLive = !!(g && Number(g.reset) > now);
    const iLive = !!(i && Number(i.reset) > now);
    const gCount = gLive ? (Number(g.count) || 0) : 0;
    const iCount = iLive ? (Number(i.count) || 0) : 0;
    if (gCount >= OA_KEY_GLOBAL_LIMIT) return { ok: false, scope: 'global' };
    if (iCount >= OA_KEY_IP_LIMIT) return { ok: false, scope: 'ip' };
    tx.set(gRef, { count: gCount + 1, reset: gLive ? Number(g.reset) : now + OA_KEY_WINDOW_MS, updated_at: FieldValue.serverTimestamp() });
    tx.set(ipRef, { count: iCount + 1, reset: iLive ? Number(i.reset) : now + OA_KEY_WINDOW_MS, updated_at: FieldValue.serverTimestamp() });
    return { ok: true, scope: '' };
  });
}
app.post('/oauth/authorize/key', async (req: any, res: any) => {
  const b = req.body || {};
  if (!oaSelfOn()) { res.status(400).json({ error: 'connector key sign-in is not enabled on this install' }); return; }
  const ip = pcTrustedClientIp(req);
  // Spend budget BEFORE the compare, so a refused attempt costs the attacker and a Firestore
  // failure lands in the catch below as a refusal rather than as a free guess.
  let gate: { ok: boolean; scope: string };
  try { gate = await oaKeyRateLimit(ip); } catch (e) { res.status(503).json({ error: 'rate limiter unavailable; refusing' }); return; }
  if (!gate.ok) {
    res.setHeader('Retry-After', '3600');
    res.status(429).json({ error: 'too many attempts', scope: gate.scope });
    return;
  }
  const supplied = String(b.key || '');
  // Constant-time. waEq() compares length first and then timingSafeEqual, so it does not leak the
  // secret's length through timing the way a === would leak its prefix.
  if (!supplied || !waEq(waSha(supplied), waSha(PC_CONNECT_SECRET))) {
    try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'oauth_key_refused', message: 'connector key rejected from ' + ip, timestamp: FieldValue.serverTimestamp() }); } catch (e) { }
    res.status(403).json({ error: 'invalid connector key' });
    return;
  }
  await oaMintAndRedirect(res, b, oaSelfPrincipal(), 'key');
});
// verify the Google ID token, check the allowlist, mint our authorization code
app.post('/oauth/authorize/complete', async (req: any, res: any) => {
  const b = req.body || {};
  // [OSS-IAPAUTH-V54] The IAP branch. THREE conditions and every one of them is load-bearing:
  //   PC_SURFACE === 'console'  -- only the IAP-protected copy of this route may trust an
  //                                assertion; the public MCP copy must never accept one.
  //   oaIapAuthOn()             -- requires PC_IAP_AUD, so the assertion is bound to THIS
  //                                service and a token minted for another IAP app cannot be
  //                                replayed here. Google's signature alone does not bind audience.
  //   pcIapEmail(req)           -- verifies signature, issuer, expiry and audience itself, and
  //                                returns '' on any failure. An empty string is a refusal.
  // Dropping any one of the three turns this into an open door, so they are checked together and
  // the request is refused rather than falling through to the Google-token path.
  if (String(b.via || '') === 'iap') {
    if (PC_SURFACE !== 'console' || !oaIapAuthOn()) { res.status(400).json({ error: 'IAP authorization is not enabled on this surface' }); return; }
    const iapEmail = pcIapEmail(req);
    if (!iapEmail) { res.status(401).json({ error: 'no verified IAP identity on this request' }); return; }
    if (!(await oaAllowed(iapEmail))) { res.status(403).json({ error: 'account not authorized: ' + iapEmail }); return; }  // fail closed
    await oaMintAndRedirect(res, b, iapEmail, 'iap');
    return;
  }
  const idt = String(b.id_token || '');
  if (!idt) { res.status(400).json({ error: 'no id_token' }); return; }
  if (!OA_GID) { res.status(500).json({ error: 'server misconfigured (no Google client id)' }); return; }  // fail closed
  // [SEC-TOKENINFO-POST] id_token in the body, not the query string. See waGoogleEmail().
  const r = await waFetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id_token=' + encodeURIComponent(idt) });
  const info: any = (r && r.ok) ? await r.json() : null;
  if (!info || info.aud !== OA_GID) { res.status(401).json({ error: 'invalid Google token' }); return; }
  if (String(info.email_verified) !== 'true') { res.status(403).json({ error: 'email not verified' }); return; }
  const email = String(info.email || '').toLowerCase();
  if (!(await oaAllowed(email))) { res.status(403).json({ error: 'account not authorized: ' + email }); return; }  // fail closed
  await oaMintAndRedirect(res, b, email, 'google');
});

// [OA-REVOKE-V1] Mark every prior credential for this client_id + email revoked, keeping
// the pair we just minted. Scoped by BOTH fields: a client registration can be shared, and
// one principal signing in must not retire another's live session.
//
// Equality-only filters, so Firestore's automatic single-field indexes serve this and no
// composite index has to be created before the code can ship. Batched, and capped, because
// one account already has 79 records and an unbounded loop on the token endpoint is a way to
// turn a sign-in into a timeout.
//
// EVERY failure path here is swallowed and journalled. This runs via `void` after the token
// response is already sent. Tidying up old credentials must never be the reason a human
// cannot sign in.
const OA_RETIRE_MAX = 400;
async function oaRetirePrior(clientId: string, email: string, keepAtH: string, keepRtH: string): Promise<void> {
  if (!clientId || !email) return;
  let n = 0;
  try {
    for (const col of ['oauth_tokens', 'oauth_refresh']) {
      const keep = (col === 'oauth_tokens') ? keepAtH : keepRtH;
      const snap = await db.collection(col)
        .where('client_id', '==', clientId)
        .where('email', '==', email)
        .limit(OA_RETIRE_MAX).get();
      let batch = db.batch(); let inBatch = 0;
      snap.forEach((d: any) => {
        if (d.id === keep) return;
        const row: any = d.data() || {};
        if (row.revoked === true) return;
        batch.update(d.ref, { revoked: true, revoked_at: FieldValue.serverTimestamp(), revoked_by: 'reauthorization' });
        inBatch++; n++;
      });
      if (inBatch) await batch.commit();
    }
    if (n) {
      await db.collection('journal').add({
        agent_id: 'oauth', action: 'oauth_retired_prior',
        message: 'retired ' + n + ' prior credential(s) on re-authorization for client '
          + clientId + ' (' + email + ')',
        timestamp: FieldValue.serverTimestamp()
      });
    }
  } catch (e: any) {
    // Loud, but not fatal. The credential the human just obtained still works.
    try {
      await db.collection('journal').add({
        agent_id: 'oauth', action: 'oauth_retire_prior_failed',
        message: 'could NOT retire prior credentials for client ' + clientId + ': '
          + String(e && e.message ? e.message : e) + '. The new credential was issued anyway.',
        timestamp: FieldValue.serverTimestamp()
      });
    } catch (e2) {}
  }
}
// ---- Token endpoint (authorization_code + PKCE, refresh_token) ----
app.post('/oauth/token', async (req: any, res: any) => {
  const b = req.body || {};
  const gt = String(b.grant_type || '');
  if (gt === 'authorization_code') {
    const code = String(b.code || '');
    const rec = await oaGet('oauth_codes', code);
    await oaDel('oauth_codes', code);  // single-use: consume on retrieval, before validation
    if (!rec || rec.exp < Date.now()) { res.status(400).json({ error: 'invalid_grant' }); return; }
    const ver = String(b.code_verifier || '');
    const chal = oaB64url(oaCrypto.createHash('sha256').update(ver).digest());
    if (!ver || chal !== rec.code_challenge) { res.status(400).json({ error: 'invalid_grant', error_description: 'pkce_mismatch' }); return; }
    if (String(b.redirect_uri || '') !== rec.redirect_uri) { res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_mismatch' }); return; }
    const at = oaRand(32); const rt = oaRand(32);
    // [SEC-OAUTH-HASH] the document ID is sha256(token), never the token. The access-token
    // record also used to carry the RAW refresh token in a field; it now carries refresh_hash.
    const atH = oaTokHash(at); const rtH = oaTokHash(rt);
    await oaSet('oauth_tokens', atH, { role: rec.role, email: rec.email, client_id: rec.client_id, exp: Date.now() + 3600 * 1000, refresh_hash: rtH, revoked: false });
    // [SEC-OAUTH-RT-EXP] issued_at + exp at mint. access_hash lets the refresh branch revoke
    // the access token it previously issued, in the same step that mints the replacement.
    await oaSet('oauth_refresh', rtH, { role: rec.role, email: rec.email, client_id: rec.client_id, issued_at: Date.now(), exp: Date.now() + OA_RT_TTL_MS, access_hash: atH, revoked: false });
    // [OA-REVOKE-V1] Retire what this authorization replaces. Fail-soft on purpose: see header.
    void oaRetirePrior(String(rec.client_id || ''), String(rec.email || ''), atH, rtH);
    res.json({ access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: 'mcp' });
    return;
  }
  if (gt === 'refresh_token') {
    const rtIn = String(b.refresh_token || '');
    const rtInH = oaTokHash(rtIn);
    const rr = await oaTokGet('oauth_refresh', rtIn);
    if (!rr) { res.status(400).json({ error: 'invalid_grant' }); return; }
    // [OA-REVOKE-V1] THE CHECK THAT MATTERS. A revoked flag the refresh path does not read is
    // worse than no flag: it reports a credential dead while it still mints access tokens.
    // Checked BEFORE expiry so a revoked token cannot be distinguished from an expired one by
    // the error body -- both are invalid_grant to the caller.
    if (rr.revoked === true) {
      try {
        await db.collection('journal').add({
          agent_id: 'oauth', action: 'oauth_refresh_refused_revoked',
          message: 'refused a refresh for a REVOKED credential (client ' + String(rr.client_id || '?') + ')',
          timestamp: FieldValue.serverTimestamp()
        });
      } catch (e) {}
      res.status(400).json({ error: 'invalid_grant', error_description: 'revoked' });
      return;
    }
    // [SEC-OAUTH-RT-EXP] enforce expiry on use. A record written before this patch has no exp:
    // stamp one from issued_at if present, else from now, so a grandfathered refresh token is
    // bounded rather than eternal. Then reject and delete it if it has run out.
    let rexp = Number(rr.exp || 0);
    if (!rexp) { rexp = Number(rr.issued_at || Date.now()) + OA_RT_TTL_MS; }
    if (rexp < Date.now()) { await oaDel('oauth_refresh', rtInH); res.status(400).json({ error: 'invalid_grant', error_description: 'refresh_token_expired' }); return; }
    // [SEC-OAUTH-ROTATE] the access token this refresh token last minted dies here, in the same
    // step that mints its replacement, so a leaked older access token stops working at the first
    // refresh instead of surviving until its own exp.
    if (rr.access_hash) { await oaDel('oauth_tokens', String(rr.access_hash)); }
    const at = oaRand(32);
    const atH = oaTokHash(at);
    await oaSet('oauth_tokens', atH, { role: rr.role, email: rr.email, client_id: rr.client_id, exp: Date.now() + 3600 * 1000, refresh_hash: rtInH, revoked: false });
    await oaSet('oauth_refresh', rtInH, { role: rr.role, email: rr.email, client_id: rr.client_id, issued_at: Number(rr.issued_at || Date.now()), exp: rexp, access_hash: atH, revoked: false });
    res.json({ access_token: at, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    return;
  }
  res.status(400).json({ error: 'unsupported_grant_type' });
});

// ---- OAuth-protected MCP mount (clean URL: POST /mcp, Bearer access token) ----
// [STRAIN OIDC] resolve a Google-signed service-account ID token -> an active provisioned strain.
// Google attests the token (tokeninfo verifies signature+expiry); we pin audience + map SA email -> strain.
async function oaStrainFromOidc(token: string, req: any): Promise<string | null> {
  try {
    // FAIL CLOSED: require a pinned public URL so the audience check can't be spoofed via the Host header.
    const wantAud = String(process.env.MCP_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!wantAud) return null;
    // [LEAK-GUARD] Only forward something SHAPED like a Google ID token. This function is
    // reached whenever a bearer is PRESENT but missed oauth_tokens, which includes every
    // stale or opaque connector token -- and it forwards the presented value to a THIRD
    // PARTY, on the public unauthenticated POST /mcp path. A JWT has
    // three non-empty dot-separated segments; anything else never leaves this process.
    // (The value now travels in the POST body rather than the URL -- see [SEC-TOKENINFO-POST]
    // below -- but this shape check is still load-bearing: it stops us relaying an unrelated
    // opaque secret to Google at all, which no transport change can fix.)
    // No regex on purpose: this string is re-emitted through a non-raw Python literal.
    const _seg = String(token).split('.');
    if (_seg.length !== 3 || !_seg[0] || !_seg[1] || !_seg[2]) return null;
    // [SEC-TOKENINFO-POST] id_token in the body, not the query string. See waGoogleEmail().
    const r = await waFetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id_token=' + encodeURIComponent(token) });
    if (!r || !r.ok) return null;
    const j: any = await r.json();
    const email = String((j && j.email) || '').toLowerCase();
    if (!email || email.indexOf('.iam.gserviceaccount.com') < 0) return null;   // GCP service accounts only
    const gotAud = String((j && j.aud) || '').replace(/\/+$/, '');
    if (gotAud !== wantAud && gotAud !== (wantAud + '/mcp')) return null;        // audience replay guard
    const snap = await db.collection('strains').where('sa_email', '==', email).where('status', '==', 'active').limit(1).get();
    if (snap.empty) return null;
    const d: any = snap.docs[0].data();
    return String((d && d.role) || snap.docs[0].id);
  } catch (e) { return null; }
}
// ---------------------------------------------------------------------------
// [PCGIT-ARCHIVE-V1] GET /git/archive -- the repository, to a machine, over IAM.
// ---------------------------------------------------------------------------
// THE PROBLEM THIS CLOSES. The repository is the authority and it is PCV1-sealed in
// the lake, so a build system reading those objects directly gets ciphertext. What
// built instead were two plaintext mirrors that both went stale, and agents read them
// AS the source and reported confident nonsense about code that had not existed for
// weeks. Operator ruling: eliminate the mirrors, work with our git. This is the
// endpoint that makes that possible -- one reader, in the process that already holds
// the vault, handing a tree to a caller GCP has already authenticated.
//
// NO SHARED SECRET, ON PURPOSE. The obvious build puts a bearer key in Secret Manager
// and hands it to the builder. That works, and it is still a key: it can leak, it must
// rotate, and possession alone is authority. Instead the caller presents a GOOGLE-SIGNED
// ID TOKEN for its own service account, Google attests it, and IAM decides. Nothing to
// rotate and nothing to leak. This mirrors oaStrainFromOidc above line for line -- same
// tokeninfo call, same shape guard, same audience pin -- because a second, subtly
// different verifier is how one of the two ends up weaker.
//
// [PCGIT-ARCHIVE-KEY-V49] TWO CREDENTIALS, ONE REACH.
//
// This route was gated ONLY on a Google-signed service-account ID token, so it was reachable
// by a build system and by nothing else. The consequence was backwards: a strain in a fresh
// container could WRITE its own repository in one request over POST /git/blob, but could only
// READ it back one file at a time. The fleet could write more easily than it could read, and
// every agent that needed a tree either inherited a snapshot or did the work in prod.
//
// A SESSION KEY NOW ALSO OPENS IT, AND THAT GRANTS NOTHING NEW. The same key already resolves
// git_read, git_list, git_log and git_diff over this same repository, and gittools.ts applies
// no per-role ref or path restriction to any of them -- so the archive is that IDENTICAL reach
// in one request instead of several hundred. What it buys is round trips and model-retyped
// bytes, not permission.
//
// THE ADMISSION ARITHMETIC IS THE TOOL SURFACE'S OWN, NOT A SECOND COPY OF IT. A key MAY hold
// less than its strain -- session_keys.tool_classes, [WP4B-KEY-CLASSES-V1] -- and git_read is
// class 'read' in PC_TOOL_CLASS. So a key narrowed to ['write'] cannot call git_read, and
// handing it the whole tree here would be a hole that the tool surface closes and this route
// reopens. This calls pcToolClasses and pcNarrowClasses, the SAME two functions buildMcpServer
// uses to decide whether git_read registers at all. If they withhold the tool, this withholds
// the archive -- by construction, not by a rule someone has to remember to keep in step.
//
// FAIL CLOSED ON AN UNSET ALLOWLIST -- UNCHANGED, AND IT MOVED FOR A REASON.
// PC_ARCHIVE_ALLOWED_SA unset still means NO SERVICE ACCOUNT is authorised: an empty allowlist
// read as "everyone" would hand the whole private source tree to any service account in any
// project that found this URL. That check now sits INSIDE the service-account branch, because
// it never governed session keys -- there were none on this route before -- and leaving it at
// the top would have made the new path dead on every install that never set the variable.
// Nothing about the service-account path got weaker; it got scoped to the callers it is about.
//
// THE TWO CREDENTIALS CANNOT SHADOW EACH OTHER. An ID token is a JWT: exactly three non-empty
// dot-separated segments. A session key has none. The SHAPE picks the branch, so a malformed
// ID token is never retried as a session key -- which would quietly turn a tokeninfo failure
// into a second lookup against a different credential store -- and a session key is never sent
// to Google's tokeninfo endpoint.
const PC_ARCHIVE_ALLOWED_SA: string[] = String(process.env.PC_ARCHIVE_ALLOWED_SA || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== '');
async function pcArchiveCaller(req: any): Promise<string | null> {
  try {
    const raw = String((req.get && req.get('authorization')) || '');
    if (raw.slice(0, 7).toLowerCase() !== 'bearer ') return null;
    const token = raw.slice(7).trim();
    if (!token) return null;
    const seg = token.split('.');
    const looksJwt = seg.length === 3 && !!seg[0] && !!seg[1] && !!seg[2];
    if (!looksJwt) {
      const v: any = await pcSessionLookup(token);
      if (!v || !v.role) return null;
      const role = String(v.role);
      // The role is taken off the session record and NEVER off the query string or a header,
      // for the same reason POST /git/blob does it that way: a caller-supplied identity would
      // let anyone read as anyone.
      const eff = pcNarrowClasses(await pcToolClasses(role), v.tc);
      if (eff.indexOf('read') < 0) {
        console.error('[git-archive] REFUSED: the session key for ' + role + " does not hold the "
          + "'read' tool class, so it cannot call git_read and is not handed the tree here.");
        return null;
      }
      return 'session:' + role;
    }
    if (!PC_ARCHIVE_ALLOWED_SA.length) {
      console.error('[git-archive] REFUSED: PC_ARCHIVE_ALLOWED_SA is unset, so no service '
        + 'account is authorised. Set it to the service account email(s) permitted to fetch the '
        + 'tree. A strain can still fetch it with its session key.');
      return null;
    }
    const wantAud = String(process.env.MCP_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!wantAud) return null;
    const r: any = await waFetch('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'id_token=' + encodeURIComponent(token),
    });
    if (!r || !r.ok) return null;
    const j: any = await r.json();
    const email = String((j && j.email) || '').toLowerCase();
    if (!email || email.indexOf('.iam.gserviceaccount.com') < 0) return null;
    const gotAud = String((j && j.aud) || '').replace(/\/+$/, '');
    if (gotAud !== wantAud && gotAud !== (wantAud + '/git/archive')) return null;
    if (PC_ARCHIVE_ALLOWED_SA.indexOf(email) < 0) {
      console.error('[git-archive] REFUSED: ' + email + ' is not in PC_ARCHIVE_ALLOWED_SA.');
      return null;
    }
    return email;
  } catch (e) { return null; }
}
app.get('/git/archive', async (req: any, res: any) => {
  const who = await pcArchiveCaller(req);
  if (!who) {
    // [PCGIT-ARCHIVE-401-V1] A 401 THAT NAMES THE SCHEME, BECAUSE THE COMMONEST CAUSE IS
    // NOT A BAD KEY. Every other fleet tool takes its credential as ?agent= / ?key= /
    // ?session_key= on the query string; this route reads ONLY the Authorization header.
    // A perfectly valid key passed the fleet-editor way therefore failed here with the
    // identical opaque body a revoked key produced, and callers concluded their credential
    // had been revoked and went looking for the wrong fault. The body now separates the two.
    const _hdr = String((req.get && req.get('authorization')) || '');
    const _qKeys = ['agent', 'key', 'session_key', 'token', 'access_token']
      .filter((k) => typeof req.query[k] !== 'undefined' && String(req.query[k] || '') !== '');
    const _body: any = {
      error: 'unauthorized',
      accepted: 'Authorization: Bearer <session key>   (or a Google-signed service-account ID token)',
      rejected: 'the credential as a QUERY PARAMETER. ?agent=, ?key=, ?session_key=, ?token= and '
        + '?access_token= are IGNORED on this route -- every other fleet tool takes the key that way, '
        + 'this one does NOT, and that mismatch is the usual cause of this 401.',
      hint: 'curl -H "Authorization: Bearer $PC_SESSION_KEY" "' + String(process.env.MCP_PUBLIC_URL || '<mcp-base-url>').replace(/\/+$/, '') + '/git/archive?ref=main" -o tree.tar.gz',
    };
    if (_qKeys.length && !_hdr) {
      _body.diagnosis = 'YOUR CREDENTIAL IS PROBABLY FINE. You sent ' + _qKeys.map((k) => '?' + k + '=').join(', ')
        + ' and NO Authorization header, so nothing was ever checked. Resend it as the header above '
        + 'before concluding the key is revoked or expired.';
    } else if (!_hdr) {
      _body.diagnosis = 'No Authorization header was sent at all, so no credential was checked.';
    } else if (_hdr.slice(0, 7).toLowerCase() !== 'bearer ') {
      _body.diagnosis = 'An Authorization header was sent but its scheme is not "Bearer". Only Bearer is accepted.';
    } else {
      _body.diagnosis = 'A Bearer credential WAS presented in the correct place and was not accepted: '
        + 'it is unknown, expired, or (for a session key) does not hold the "read" tool class, or (for a '
        + 'service-account ID token) is not in PC_ARCHIVE_ALLOWED_SA / has the wrong audience. '
        + 'This one really is a credential problem.';
    }
    res.status(401).json(_body);
    return;
  }
  const ref = String(req.query.ref || 'main');
  const sub = String(req.query.path || '');
  try {
    const gt = require('./gittools.js');
    if (typeof gt.gitArchiveTarGz !== 'function') throw new Error('gittools.js does not export gitArchiveTarGz');
    const out: any = await gt.gitArchiveTarGz(ref, sub);
    // THE MANIFEST RIDES IN HEADERS SO A BUILD CAN ASSERT COVERAGE RATHER THAN TRUST A
    // BYTE COUNT. A build step comparing x-pcgit-files against what it extracted turns a
    // silently short archive into a red build instead of a mystery three deploys later.
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-pcgit-commit', out.commit);
    res.setHeader('x-pcgit-files', String(out.files));
    res.setHeader('x-pcgit-bytes', String(out.bytes));
    res.setHeader('Content-Disposition', 'attachment; filename="pcgit-' + String(out.commit).slice(0, 12) + '.tar.gz"');
    console.error('[git-archive] ' + who + ' fetched ref=' + ref + (sub ? (' path=' + sub) : '')
      + ' commit=' + out.commit + ' files=' + out.files + ' bytes=' + out.bytes);
    db.collection('journal').add({
      agent_id: 'git_archive', action: 'archive_served',
      message: who + ' fetched ' + ref + ' (' + out.commit + ') ' + out.files + ' files',
      timestamp: FieldValue.serverTimestamp(),
    }).catch(() => {});
    res.status(200).send(out.tgz);
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    console.error('[git-archive] FAILED ref=' + ref + ': ' + msg);
    res.status(500).json({ error: 'archive failed', detail: msg.slice(0, 300) });
  }
});
// ---------------------------------------------------------------------------
// [PCGIT-UPLOAD-V1] POST /git/blob -- bytes IN, the counterpart to /git/archive.
// ---------------------------------------------------------------------------
// THE PROBLEM THIS CLOSES. Landing a large file in the repository means a language
// model retyping every byte into git_propose's `content`. src/index.ts is over 600KB:
// hundreds of thousands of generated tokens, where one dropped space is a broken file,
// and the single biggest cost in this project. GET /git/archive already moves the tree
// OUT over HTTP with no model in the path. This moves bytes IN the same way -- straight
// into the git object store, where git_propose can then NAME them.
//
// A DIFFERENT CREDENTIAL FROM /git/archive, ON PURPOSE. The archive hands the whole
// private tree to a build system, so it is gated on a Google-signed service-account ID
// token and an allowlist. An upload writes ONE unreferenced object and a record saying
// who wrote it -- it is the write half of what an agent can already do through
// git_propose, so it takes the credential an agent already holds: its session key, the
// SAME key pcSessionLookup resolves for every tool call. No new credential type is
// invented here, because a second kind of key is a second thing to leak and rotate.
//
// THE ROLE THE KEY RESOLVES TO IS THE OWNER OF THE UPLOAD, AND THAT IS THE WHOLE POINT.
// git_propose's `uploaded` resolves only against a record belonging to the SAME agent,
// so this identity is what decides whose bytes a later proposal may claim. It comes off
// the session record and NEVER off the query string or the body -- a caller-supplied
// agent name would let anyone claim anyone's upload, which is exactly the bare-oid hole
// pcgit refuses everywhere else.
//
// THE BEARER KEY AND THE BYTES ARE NEVER LOGGED. The journal line and the console line
// carry the resolved role, the oid, the sha256 and the size -- enough to reconstruct who
// put what, and nothing that is a secret or a file.
const PC_BLOB_MAX_BYTES = 64 * 1024 * 1024;
// RAW BODY, ROUTE-LEVEL ONLY. app.use(express.json()) is mounted globally at the top of
// this file and app.use(express.urlencoded()) further down; neither touches a body whose
// Content-Type is not JSON or form-encoded, so an upload sent as application/octet-stream
// reaches this middleware unparsed and NO OTHER ROUTE's body parsing changes -- this
// express.raw is attached to this one registration, not to the app. A caller who mislabels
// an upload as application/json or as a form gets a 400 from here naming the header,
// rather than a Buffer that is silently an object.
const pcBlobRawBody = express.raw({ type: '*/*', limit: PC_BLOB_MAX_BYTES });
// The size refusal is handled HERE rather than falling through to Express's default error
// handler, which would answer 413 with an HTML page a machine client cannot read.
function pcBlobBody(req: any, res: any, next: any): void {
  pcBlobRawBody(req, res, (err: any) => {
    if (err) {
      const tooBig = !!(err && (err.type === 'entity.too.large' || err.status === 413));
      console.error('[git-blob] body rejected: ' + String((err && err.message) || err));
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'too large' : 'bad body',
        detail: tooBig
          ? 'an upload may be at most ' + PC_BLOB_MAX_BYTES + ' bytes'
          : String((err && err.message) || err).slice(0, 300),
      });
      return;
    }
    next();
  });
}
// The SAME session key every tool call carries, resolved by the SAME lookup, so a revoked
// or expired key loses the upload path in the same breath it loses the tools.
async function pcUploadCaller(req: any): Promise<string | null> {
  try {
    const raw = String((req.headers && req.headers['authorization']) || '');
    const m = raw.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const v: any = await pcSessionLookup(String(m[1]).trim());
    return v && v.role ? String(v.role) : null;
  } catch (e) { return null; }
}
app.post('/git/blob', pcBlobBody, async (req: any, res: any) => {
  const who = await pcUploadCaller(req);
  if (!who) { res.status(401).json({ error: 'unauthorized' }); return; }
  const body: any = req.body;
  if (!Buffer.isBuffer(body)) {
    // MEASURED, not theoretical: with Content-Type application/json or
    // x-www-form-urlencoded the globally mounted parsers consume the stream first and
    // hand this route a parsed OBJECT. Refused by name rather than coerced -- a
    // JSON.stringify of that object would be a plausible file that is not the file sent.
    res.status(400).json({
      error: 'bad body',
      detail: 'the request body was parsed as ' + String(req.headers['content-type'] || '(no '
        + 'Content-Type)') + ' instead of arriving as raw bytes. POST the file with '
        + 'Content-Type: application/octet-stream. Nothing was written.',
    });
    return;
  }
  if (body.length === 0) {
    res.status(400).json({
      error: 'empty body',
      detail: 'POST the raw bytes of exactly one file as the request body, with '
        + 'Content-Type: application/octet-stream. An empty upload would register a '
        + 'zero-byte blob. Nothing was written.',
    });
    return;
  }
  try {
    const gt = require('./gittools.js');
    if (typeof gt.gitUploadBlobForRoute !== 'function') throw new Error('gittools.js does not export gitUploadBlobForRoute');
    const out: any = await gt.gitUploadBlobForRoute(body, who);
    console.error('[git-blob] ' + who + ' uploaded blob=' + out.blobOid + ' sha256=' + out.sha256
      + ' bytes=' + out.size);
    db.collection('journal').add({
      agent_id: 'git_blob', action: 'blob_uploaded',
      message: who + ' uploaded ' + out.size + ' bytes as ' + out.blobOid,
      timestamp: FieldValue.serverTimestamp(),
    }).catch(() => {});
    res.status(200).json({
      ok: true, blobOid: out.blobOid, sha256: out.sha256, size: out.size,
      expires_at_ms: out.expiresAtMs,
    });
  } catch (e: any) {
    const msg = String((e && e.message) || e);
    const code = String((e && e.code) || '');
    console.error('[git-blob] FAILED for ' + who + ' (' + body.length + ' bytes): ' + msg);
    if (code === 'FILE_TOO_LARGE') { res.status(413).json({ error: 'too large', detail: msg.slice(0, 300) }); return; }
    if (code === 'BAD_REQUEST') { res.status(400).json({ error: 'bad request', detail: msg.slice(0, 300) }); return; }
    res.status(500).json({ error: 'upload failed', detail: msg.slice(0, 300) });
  }
});
async function oaBearerRole(req: any): Promise<string | null> {
  const h = String((req.headers && req.headers['authorization']) || '');
  const m = h.match(/^Bearer\s+(.+)$/i); if (!m) return null;
  // [SEC-OAUTH-HASH] hash the presented token before the get; the raw token is never an ID.
  const rec = await oaTokGet('oauth_tokens', m[1]);
  // [SEC-OAUTH-RT-EXP] a record with no exp used to mean never-expires. Fail closed instead.
  // [OA-REVOKE-V1] revoked === true, not !== false: `revoked` is absent on every record
  // written before this shipped, and absent must keep meaning live.
  if (rec && rec.revoked === true) return null;
  if (rec && rec.exp && rec.exp >= Date.now()) return rec.role || OAUTH_ROLE;
  // [STRAIN OIDC] our own token store missed; try the Google-attested service-account path.
  return await oaStrainFromOidc(m[1], req);
}
// [SEC-OAUTH-DEFAULT-ROLE-AUDIT] fleet-security 2026-07-30, after a live outage.
// OAUTH_DEFAULT_ROLE names the strain that every OAuth connector inherits when consent binds no
// explicit role. NOTHING in this control plane ever checked that the named strain EXISTS. It named
// a strain that had been deleted, so MCP admission control
// denied the fleet toolset to every newly-authorized connector on every account. The connectors came
// up serving whoami and nothing else. The only trace was an admission_denied journal line reading
// -- no strain document in the registry -- which nobody read for weeks.
//
// DESIGN: LOUD AND CONTINUE, NEVER FAIL THE BOOT. Four reasons, in order of weight:
//   1. SELF-SEALING DEADLOCK. This same process serves the console, the passkey unlock, the whole
//      webauthn flow and /api/strains/provision. The only cure for a missing strain is served BY
//      the process a hard failure would kill. Refusing to boot removes the recovery path for the
//      exact condition it is detecting.
//   2. IT BUYS NO AUTHORIZATION. Admission control ALREADY fails closed on this condition: an
//      unprovisioned principal gets a whoami-only server. Continuing grants nothing. Failing the
//      boot only converts a partial outage (connectors degraded) into a total one (gate, dashboard,
//      and chat all down).
//   3. IT IS A SNAPSHOT, NOT AN INVARIANT. strains/<role> is mutable at runtime via
//      /api/strains/retire. A running process would not re-fail anyway, so a boot gate would
//      produce a revision that starts today and refuses to start tomorrow from the SAME image on an
//      unrelated Firestore write -- an un-startable revision with no code change to bisect.
//   4. A READ CANNOT DISTINGUISH ITS FAILURE MODES. -- role absent -- and -- Firestore unavailable,
//      IAM changed, quota exhausted -- arrive identically. Coupling startup to that read trades a
//      config-validation win for an availability risk, which is precisely what must not happen.
// So: never throws, never denies, never blocks, adds ZERO latency to any request (fire-and-forget),
// and emits exactly ONE structured journal entry per process naming the offending role.
//
// Module load is synchronous and the Firestore read is async. This resolves that with a lazy
// memoised call from the POST /mcp handler -- no top-level await, and no boot IIFE that would race
// strainSeedIfEmpty() and the one-time retirement migration and report a false alarm.
let oaRoleAuditState = 0;   // 0 = not yet run   1 = in flight or finished
async function oaAuditDefaultRole(): Promise<void> {
  if (oaRoleAuditState !== 0) return;
  oaRoleAuditState = 1;
  const role = String(OAUTH_ROLE || '');
  try {
    const snap = await db.collection('strains').doc(role).get();
    const row: any = snap.exists ? (snap.data() || {}) : null;
    if (row && row.status === 'active') { console.error('[oauth-default-role] OK: [' + role + '] is an active strain.'); return; }
    const why = row ? ('its status is [' + String(row.status || 'unset') + '], not active') : ('there is no strains/' + role + ' document in the registry at all');
    const msg = 'CONNECTOR ONBOARDING IS BROKEN. The default OAuth connector role resolves to [' + role + '] but '
      + why + '. MCP admission control therefore refuses the fleet toolset to every connector that binds this '
      + 'default: those connectors answer whoami and nothing else, silently, with no error an operator can see. '
      + 'FIX: provision or reactivate that strain on the Flow Hood at /harness, or point the default at an active strain, then '
      + 'redeploy the control plane. This check is ADVISORY -- it did not block startup and denied nothing.';
    console.error('[oauth-default-role] ' + msg);
    try {
      await db.collection('journal').add({
        agent_id: 'mcp_gateway', action: 'oauth_default_role_invalid', role: role,
        severity: 'high', message: msg, timestamp: FieldValue.serverTimestamp()
      });
    } catch (e) {}
  } catch (e: any) {
    // A FAILED READ IS NOT A MISCONFIGURATION. Reset the memo so a transient Firestore error is
    // retried on the next request instead of being cached as a verdict for the life of the process.
    oaRoleAuditState = 0;
    console.error('[oauth-default-role] registry read failed for [' + role + '] - NOT treating this as a '
      + 'misconfiguration, will retry on the next request: ' + String(e && e.message ? e.message : e));
  }
}
function oaChallenge(req: any, res: any): void {
  res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + oaPubBase(req) + '/.well-known/oauth-protected-resource"');
  res.status(401).json({ error: 'unauthorized' });
}
// ================= VERIFY-GREP: PC-SESSION-IDENTITY-V1 =================
// PER-CHAT IDENTITY FOR AN ACCOUNT-LEVEL CONNECTOR.
//
// THE PROBLEM. Claude's MCP connectors are account-level. One connector serves every
// Cowork chat, so every chat presents the SAME bearer and resolves to the SAME role.
// staged_by, journal attribution, agents/<role>/ scoping and history all collapse onto
// one identity. Every strain chat was fleet-advisor wearing a name badge.
//
// WHY NOT JUST LET THE CHAT SAY WHO IT IS. That is exactly what the consent-page strain
// picker did, and it was removed for a good reason: the role
// arrived as caller-supplied JSON, so any caller could name any strain including a
// privileged one. A CLAIM IS NOT AN IDENTITY. This does not reintroduce that.
//
// WHAT THIS DOES. The operator mints a session key behind the passkey. It is stored ONLY as
// sha256 -- the plaintext exists once, in his browser. A chat presents the key as the
// 'agent' argument; the server resolves key -> role from Firestore. The role is
// SERVER-ISSUED. Editing your paste to say 'fleet-security' does nothing: the role
// lives in the session_keys row, keyed by a value you cannot guess. A role name is not
// a key.
//
// WHAT IT HONESTLY DOES NOT DEFEND AGAINST -- do not describe this as more than it is.
// Every chat shares one bearer, one client_id, one source IP, and the transport is
// stateless (sessionIdGenerator: undefined), so the server has ZERO signal that
// distinguishes chat A from chat B. Possession of the key IS the identity. Two chats
// given the same paste are the same role. A chat that reads another chat's key from
// context can use it. This is an ATTRIBUTION and BLAST-RADIUS mechanism, not an
// authorization boundary between chats. The MECHANISM that would make it one now exists:
// buildMcpServer filters registration against the role's strains/<role>.tool_classes.
// It ships OBSERVE-ONLY -- PC_TOOLS_ENFORCE defaults off, so it journals what it WOULD
// withhold and still registers everything, and a strain with no tool_classes field holds
// every class regardless. So until that flag is ON *and* strains carry the field, binding
// still changes WHO IT SAYS IT IS, not WHAT IT CAN DO. Do not read the code as the policy.
//
// FAIL-CLOSED, by the operator's ruling 2026-07-29: an unbound chat gets no tools. "IT HAS NO
// IDENTITY WHICH IS THE POINT."
//
// TWO CARVE-OUTS, AND THEY ARE NOT OPTIONAL:
//   1. initialize / tools/list carry no arguments, so they can NEVER present a key. If
//      an unbound chat saw an empty tool list the model would never call anything and
//      the denial could never teach it. The tool LIST is not a capability -- it is
//      identical for every role -- so listing stays open and enforcement lands on
//      tools/call.
//   2. Denial is returned as a TOOL RESULT with isError, not a transport error, so the
//      model reads the instruction and corrects itself instead of retrying blind.
//
// PC_SESSION_ENFORCE is the cutover switch, read at module load.
//   '0'                -> the explicit escape hatch: resolve bound chats, NEVER deny. For a
//                         hand-rolled deploy that has not yet minted/proven keys for every chat.
//   unset / anything else -> ENFORCE. [SEC-AUDIT-V105-ENFORCE-DEFAULT] the installer sets this
//                         to '1' on both surfaces, so this default was already a no-op for
//                         every installed system -- it only mattered for a hand-rolled deploy
//                         that omitted the var, and for that deploy "unset" silently meant
//                         "resolve bound chats, never deny", which is exactly the gap that lets
//                         an OAuth-authenticated-but-unbound connector resolve to the default
//                         role with a live toolset instead of the "no identity, no tools" denial
//                         the rest of this comment block promises. Absent or unrecognised must
//                         read as enforcing; only an explicit '0' opts back out.
const PC_ENFORCE = String(process.env.PC_SESSION_ENFORCE || '1') !== '0';
// [PC-KEY-TTL-V1] Session keys had no expiry: a key pasted into a chat transcript stayed
// valid forever and only an explicit revoke could kill it. That is the same defect the
// OAuth refresh tokens had ([SEC-OAUTH-RT-EXP]) and it gets the same fix -- stamp an exp
// at mint, enforce it at resolve. An env var so the TTL changes with a config revision
// rather than a rebuild, exactly like PC_SESSION_ENFORCE above.
const PC_KEY_TTL_DAYS = Math.max(1, Number(process.env.PC_KEY_TTL_DAYS || 7));
const PC_KEY_TTL_MS = PC_KEY_TTL_DAYS * 86400000;
// [PC-KEY-TTL-V2] CUTTING PC_KEY_TTL_DAYS DOES NOT SHORTEN A KEY THAT ALREADY EXISTS.
// V1 stamps `exp` ABSOLUTE at mint and pcSessionLookup compares that stored number with
// Date.now(); PC_KEY_TTL_MS is read at the two MINT sites and NOWHERE in the lookup path.
// So lowering PC_KEY_TTL_DAYS shortens only keys minted AFTER the change -- confirmed here
// by reading both mint sites and the whole of pcSessionLookup, not inherited from upstream.
//
// THE OBVIOUS FIX IS A LOCKOUT. "Recompute expiry from the current TTL" expires every key
// older than PC_KEY_TTL_DAYS the instant it deploys -- including, on a short TTL, the key
// the operator is holding.
//
// SO: DERIVE, FLOOR, AND DEFAULT TO OFF.
//   derive  effective expiry = min(stored exp, created_at + current TTL)
//   floor   at an ANCHORED grace window, so enabling this can never cut a live session on
//           contact
//   off     unless PC_KEY_TTL_BACKFILL=1, mirroring PC_SESSION_STAMP_ENFORCE's
//           observe-then-enforce shape. In observe mode nothing changes except that the
//           journal counts which keys WOULD be cut, so the blast radius is a measured
//           number before it is a policy.
//
// THE STORED exp IS NEVER REWRITTEN. pcSessionStamp binds an HMAC over kh|role|exp, so
// moving exp would invalidate the stamp on every key at once and hand [SEC-SESSION-STAMP-V1]
// a fleet-wide false positive. The derived value decides EXPIRY ONLY; stamp verification
// keeps reading the stored number.
//
// BOTH MINT SITES ALREADY STORE created_at (FieldValue.serverTimestamp()), checked before
// porting this: without it every key reads as undrifted and the feature would be inert.
const PC_KEY_TTL_GRACE_MS = Math.max(1, Number(process.env.PC_KEY_TTL_GRACE_HOURS || 12)) * 3600000;
// THE GRACE FLOOR IS ANCHORED TO A FIXED INSTANT THE OPERATOR SETS, NOT TO Date.now() AND
// NOT TO PROCESS START. Upstream's adversarial review killed both alternatives:
//   * `now + grace` recomputes on EVERY request, so it never converges -- a drifted key is
//     pushed 12h into the future forever and becomes PERMANENTLY UN-EXPIRABLE, and a key
//     already dead under its stored exp is RESURRECTED by switching this on. A
//     TTL-tightening flag that revives expired credentials is a security regression wearing
//     a safety feature's clothes.
//   * `Date.now()` captured at module load has the same disease more quietly: Cloud Run
//     starts fresh instances whenever it likes, so every cold start re-opens the window.
// An explicit epoch is the only form that converges AND is auditable: written down, identical
// on every instance, and "when did enforcement begin" has an answer.
const PC_KEY_TTL_BACKFILL_SINCE_MS = (function () {
  const raw = String(process.env.PC_KEY_TTL_BACKFILL_SINCE || '').trim();
  if (!raw) return 0;
  // NEITHER Number() NOR Date.parse() MAY BE TRUSTED WITH A LOOSE STRING HERE, and the
  // runtime is why:
  //   Number('2026')   -> 2026        a bare year is finite and positive, so a naive `n > 0`
  //                                   accepts it as an epoch two seconds after 1970
  //   Date.parse('0')  -> 2000-01-01  V8 legacy date parsing, not the spec
  //   Date.parse('-5') -> 2001-05-01  same
  // Each silently produces an anchor in the deep past, which makes the grace window already
  // over, which enables enforcement with ZERO grace -- the exact lockout this design exists
  // to prevent, reachable by one plausible typo in a variable whose own error message
  // invites "an ISO date". Both forms are validated BY SHAPE before parsing.
  if (/^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    // 1e12 ms is 2001-09-09. Smaller is not a millisecond epoch anyone means.
    return (Number.isFinite(n) && n >= 1e12) ? n : 0;
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$/.test(raw)) return 0;
  const p = Date.parse(raw);
  return Number.isFinite(p) && p > 0 ? p : 0;
})();
// FAIL SAFE ON A HALF-CONFIGURED ENABLE. Enforcing with no anchor means no grace at all --
// every drifted key cut the instant this deploys. So enforcement requires BOTH, and asking
// for one without the other stays in observe mode and says so on every boot.
const PC_KEY_TTL_BACKFILL = String(process.env.PC_KEY_TTL_BACKFILL || '') === '1'
  && PC_KEY_TTL_BACKFILL_SINCE_MS > 0;
if (String(process.env.PC_KEY_TTL_BACKFILL || '') === '1' && PC_KEY_TTL_BACKFILL_SINCE_MS <= 0) {
  console.error('[key-ttl] PC_KEY_TTL_BACKFILL=1 but PC_KEY_TTL_BACKFILL_SINCE is unset or '
    + 'unparseable. STAYING IN OBSERVE MODE: enforcing without an anchor gives every drifted '
    + 'key zero grace and would cut live sessions on deploy. Set PC_KEY_TTL_BACKFILL_SINCE to '
    + 'the instant enforcement should begin. ACCEPTED FORMS ONLY: milliseconds since epoch as '
    + 'digits >= 1000000000000, or a full ISO-8601 date such as 2026-08-24 or '
    + '2026-08-24T12:00:00Z. A bare year, a small integer or free text is REFUSED on purpose '
    + '-- each of those parses to an anchor near 1970 and would mean zero grace.');
}
const PC_SESS_TTL_MS = 60000;
const pcSessCache: Map<string, any> = new Map();

// Same shape and cost as mcpStrainAdmit: one doc.get() behind a Map with a 60s TTL,
// last-known-good on error, fail closed when there is nothing cached.
async function pcSessionLookup(key: string): Promise<any> {
  const kh = oaTokHash(key);
  const now = Date.now();
  const hit: any = pcSessCache.get(kh);
  if (hit && (now - hit.at) < PC_SESS_TTL_MS) return hit.v;
  try {
    const d = await db.collection('session_keys').doc(kh).get();
    if (!d.exists) { pcSessCache.set(kh, { at: now, v: null }); return null; }
    const row: any = d.data() || {};
    // [PC-KEY-TTL-V1] Expiry is enforced HERE, server-side, off the stored record -- never
    // from anything the caller presents. A record with NO exp is GRANDFATHERED (valid): keys
    // minted before this patch predate the field, and treating absent-as-expired would cut
    // every live chat the moment this deployed. The deploy backfills them instead.
    const _exp = Number(row.exp || 0);
    // [PC-KEY-TTL-V2] The mint time, which V1 already stored and never read back.
    let _createdMs = 0;
    try {
      const _ca: any = row.created_at;
      if (_ca && typeof _ca.toMillis === 'function') _createdMs = Number(_ca.toMillis()) || 0;
      else if (typeof _ca === 'number') _createdMs = _ca;
    } catch (e) { _createdMs = 0; }
    const _derivedExp = _createdMs > 0 ? (_createdMs + PC_KEY_TTL_MS) : 0;
    // DRIFT = minted under a LONGER TTL than the one configured now. A key minted under a
    // SHORTER one is left alone: raising the TTL must not extend a credential already handed
    // out, which is the same defect pointing the other way.
    const _ttlDrift = _derivedExp > 0 && _exp > 0 && _derivedExp < _exp;
    // CLAMPED AT BOTH ENDS, and both clamps were earned by review:
    //   upper, Math.min(_exp, ...) -- THIS POLICY MAY ONLY SHORTEN, NEVER LENGTHEN. Without
    //     it the grace floor could push an effective expiry PAST the stored one and revive a
    //     key that is already dead. With it, a key dead under the stored exp stays dead in
    //     BOTH modes.
    //   lower, the anchored floor -- nobody is cut inside the grace window beginning at
    //     PC_KEY_TTL_BACKFILL_SINCE. Because the anchor is FIXED this converges: once
    //     since+grace is past, the derived value governs for real.
    const _effExp = _ttlDrift
      ? Math.min(_exp, Math.max(_derivedExp, PC_KEY_TTL_BACKFILL_SINCE_MS + PC_KEY_TTL_GRACE_MS))
      : _exp;
    const _expired = PC_KEY_TTL_BACKFILL
      ? (_effExp > 0 && _effExp < now)
      : (_exp > 0 && _exp < now);
    if (_ttlDrift) {
      // COUNT BEFORE CUTTING. Rate-limited for free by the 60s pcSessCache in front of this
      // read, and fire-and-forget via harJournalAs -- an awaited Firestore write here would
      // put a round trip on EVERY authenticated request, which is not a price an
      // observability line gets to charge. Carries a hash prefix, NEVER the key.
      harJournalAs('control-plane', 'session_ttl_drift',
        '[key-ttl] ' + kh.slice(0, 12) + '... role=' + String(row.role || '') +
        ' minted under a longer TTL: stored exp ' + new Date(_exp).toISOString() +
        ', derived ' + new Date(_derivedExp).toISOString() +
        ', effective ' + new Date(_effExp).toISOString() +
        ' (grace ' + (PC_KEY_TTL_GRACE_MS / 3600000) + 'h from ' +
        (PC_KEY_TTL_BACKFILL_SINCE_MS > 0 ? new Date(PC_KEY_TTL_BACKFILL_SINCE_MS).toISOString() : 'UNANCHORED') +
        '). Mode: ' +
        (PC_KEY_TTL_BACKFILL ? 'ENFORCED -- the effective value decides'
                             : 'OBSERVE -- the stored value still decides, nothing is cut'));
    }
    // [WP4B-KEY-CLASSES-V1] tc is the RAW row field, carried out unvalidated ON PURPOSE: it is
    // interpreted in exactly one place (pcNarrowClasses), which is total over every possible
    // value and cannot widen for any of them. Validating it here as well would create a second
    // reading of the same field, and two readings of one field is how a fail-open gap appears.
    const v = (row.revoked || _expired || !row.role) ? null : { role: String(row.role), label: String(row.label || ''), tc: row.tool_classes };
    pcSessCache.set(kh, { at: now, v: v });
    if (v) { try { await db.collection('session_keys').doc(kh).set({ last_seen: FieldValue.serverTimestamp() }, { merge: true }); } catch (e) {} }
    return v;
  } catch (e) {
    if (hit) return hit.v;
    return null;
  }
}

// Reads the JSON-RPC envelope. Handles a batch (array body): if the batch carries more
// than one distinct key across its tools/call members, that is 'mixed' and is refused
// under enforcement rather than silently resolved to one of them.
function pcExtract(req: any): any {
  const b: any = (req && req.body) || {};
  const msgs: any[] = Array.isArray(b) ? b : [b];
  const keys: any = {}; let n = 0; let sawCall = false; let id: any = null;
  for (let i = 0; i < msgs.length; i++) {
    const mm: any = msgs[i] || {};
    if (String(mm.method || '') !== 'tools/call') continue;
    sawCall = true;
    if (id === null && typeof mm.id !== 'undefined') id = mm.id;
    const p: any = mm.params || {}; const a: any = p.arguments || {};
    const k = String(a.agent || '').trim();
    if (!keys[k]) { keys[k] = 1; n++; }
  }
  const only = (n === 1) ? Object.keys(keys)[0] : '';
  return { call: sawCall, key: only, mixed: (n > 1), id: id };
}

async function pcResolveIdentity(req: any): Promise<any> {
  const bearer = await oaBearerRole(req);
  if (!bearer) return null;                       // unchanged: oaChallenge path
  const x: any = pcExtract(req);
  if (!x.call) return { role: bearer };           // carve-out 1: handshake / enumeration
  // ---- [FAIL-CLOSED-ON-BAD-KEY] ----
  // A PRESENTED-BUT-UNRECOGNISED KEY IS AN ERROR, NOT AN ABSENCE, AND IT NEVER FALLS BACK.
  // The first cut gated these two fallbacks on PC_ENFORCE as well. That meant ONE mistyped
  // character in a pasted key did not degrade a chat to a weaker role -- it SILENTLY
  // PROMOTED it to fleet-advisor, the one role permitted to stage gated jobs and supersede
  // every other chat's pending work. Fail-open, on the identity check itself.
  // fleet-curator found it by mutating one character of its own key, which is the test that
  // should have existed before this shipped.
  // PC_ENFORCE governs the NO-KEY case ONLY -- letting chats that predate the mechanism
  // keep working through the cutover is the entire reason that flag exists. It is not a
  // licence to guess an identity for a caller who asserted one and got it wrong.
  if (x.mixed) return { deny: true, reason: 'mixed', id: x.id };
  if (x.key) {
    const s: any = await pcSessionLookup(x.key);
    if (s && s.role) return { role: s.role, tc: s.tc };
    return { deny: true, reason: 'unknown-or-revoked', id: x.id };
  }
  return PC_ENFORCE ? { deny: true, reason: 'no-identity', id: x.id } : { role: bearer };
}

// [MCP2026-DUAL-ERA-V1] The denial TEXT is extracted verbatim so the 2026-07-28 branch can
// return the same words in a modern-shaped result. A pure extraction: pcSendDenied below
// composes exactly the string it composed before, and no caller of it changed.
function pcDeniedText(reason: string): string {
  const why = (reason === 'unknown-or-revoked')
    ? 'The session key in this chat is not recognised, has EXPIRED, or has been revoked. Session keys last ' + PC_KEY_TTL_DAYS + ' days -- mint a fresh paste at the Autoclave and replace the PC-SESSION-KEY line.'
    : ((reason === 'mixed')
      ? 'This request carried more than one session key.'
      : 'This chat has not established an identity yet.');
  const txt = 'DENIED: ' + why + '\n\n'
    + 'This MCP connector is account-level and serves every Cowork chat, so a chat must prove which strain it is before it can use any tool. '
    + 'Pass your session key as the "agent" argument on EVERY tool call. It is the line beginning PC-SESSION-KEY in this chat bootstrap paste. '
    + 'If there is no such line, ask the operator: they mint one at the Flow Hood (Autoclave, New strain session) and paste it here. '
    + 'Do NOT guess a role name -- the role is resolved from the key on the server, and a role name is not a key.';
  return txt;
}
function pcSendDenied(req: any, res: any, reason: string, id: any): void {
  const txt = pcDeniedText(reason);
  try {
    res.status(200).json({ jsonrpc: '2.0', id: (id === null ? 0 : id), result: { content: [{ type: 'text', text: txt }], isError: true } });
  } catch (e) { if (!res.headersSent) res.status(403).json({ error: 'no_session_identity' }); }
}
// ================= [MCP2026-DUAL-ERA-V1] the modern branch =================
// Reached ONLY from the era router in POST /mcp below. Defined at module scope, above the
// route, deliberately: route-audit.mjs scans the handler body between one registration and
// the next, and this keeps the audit's view of POST /mcp -- and its public/guarded verdict --
// exactly what it was.
//
// zod raw shape -> JSON Schema. Tool specs are written against sdk v1, which takes a MAP of
// zod types; the wire needs a JSON Schema object (R28). zod 4 ships the converter, and
// package.json pins zod exactly, so this is not a floating capability -- the Dockerfile
// asserts z.toJSONSchema exists at BUILD time, which is why there is no boot-time surprise
// to defend against here. The per-shape fallback covers a single unrepresentable property
// and nothing else: an HTTP 500 out of the modern branch is not in a dual-era client's
// fallback trigger set, so losing one type annotation LOUDLY beats a stack trace.
function mcp2026SchemaOf(toolName: string, shape: any): any {
  if (!shape || typeof shape !== 'object') return { type: 'object', properties: {} };
  try {
    const js: any = (z as any).toJSONSchema((z as any).object(shape));
    if (js && typeof js === 'object' && !Array.isArray(js)) { js.type = 'object'; return js; }
  } catch (e: any) {
    console.warn('[mcp2026] tool ' + toolName + ': zod->JSON Schema failed ('
      + String(e && e.message ? e.message : e) + '); publishing an untyped property list.');
  }
  const props: any = {};
  for (const k of Object.keys(shape)) props[k] = {};
  return { type: 'object', properties: props };
}
// Origin validation (R2/R3), modern branch only. A DNS-rebinding attacker controls the
// Origin, never the Host we were reached on, so agreement with our own public base is the
// test. An ABSENT Origin is not an invalid one: server-to-server callers send none.
function mcp2026OriginOk(origin: string, base: string): boolean {
  try {
    const a = new URL(origin);
    const b = new URL(base);
    return a.host === b.host && (a.protocol === b.protocol || a.protocol === 'https:');
  } catch (e) { return false; }
}
async function mcpServeModern(req: any, res: any): Promise<void> {
  const base = oaPubBase(req);
  // [WP4B-KEY-CLASSES-V1] The modern branch's tools() callback is handed a ROLE STRING and
  // nothing else, so a per-KEY restriction has nowhere to travel in that signature. Capture the
  // resolved identity from the identity() call that produced the role -- same request, same
  // pcResolveIdentity, no second source of truth -- and hand its restriction to
  // buildMcpServerAdmitted alongside the role. The role-equality guard below is what makes this
  // safe rather than merely convenient: a captured restriction is used ONLY when it came from
  // the very principal tools() is being asked about.
  let _pcIdent: any = null;
  const out: any = await mcp2026Handle({ headers: req.headers, body: req.body }, {
    serverInfo: { name: PC_REPO_ID, version: '1.0.0' },
    instructions: 'Paracoding fleet control plane. Call whoami first. Pass your session key as the `agent` argument on every tool call: it is a server-minted credential, not a role name.',
    ttlMs: 60000,
    cacheScope: 'private',   // the tool set varies by the caller's grants, so never 'public'
    resourceMetadataUrl: base + '/.well-known/oauth-protected-resource',
    originAllowed: (o: string) => mcp2026OriginOk(o, base),
    // Identity is resolved by the SAME function the legacy branch uses, and it is resolved
    // AFTER the era router, never before it: pcExtract walks array bodies, and an array can
    // only reach the modern branch to be refused as a batch.
    identity: async () => {
      const v: any = await pcResolveIdentity(req);
      if (!v) return { kind: 'challenge' };
      if (v.deny) return { kind: 'deny', text: pcDeniedText(String(v.reason || '')) };
      _pcIdent = v;
      return { kind: 'role', role: v.role };
    },
    tools: async (role: string) => {
      // ORDERING-INDEPENDENT ON PURPOSE. mcp2026.js is a separate module and the order in which
      // it invokes identity() and tools() is not established anywhere in this file; a captured
      // value that merely happened to be unset would read as "no restriction", which is exactly
      // the fail-OPEN shape this is meant to remove. So the capture is an OPTIMISATION, not the
      // source of truth: if it is missing or names a different principal, resolve again from the
      // same request. pcResolveIdentity is a pure function of the request bytes and sits behind
      // pcSessCache's 60s TTL, so the second call is a Map hit, not a second Firestore read.
      let _id: any = (_pcIdent && String(_pcIdent.role) === String(role)) ? _pcIdent : null;
      if (!_id) {
        const _v2: any = await pcResolveIdentity(req);
        _id = (_v2 && !_v2.deny && String(_v2.role) === String(role)) ? _v2 : null;
      }
      const built: any = await buildMcpServerAdmitted(role, _id ? _id.tc : undefined);
      const rec: any[] = (built && built.__pcTools) || [];
      try { built.close(); } catch (e) {}
      return rec.map((t: any) => ({
        name: t.name,
        description: String((t.spec && t.spec.description) || ''),
        inputSchema: mcp2026SchemaOf(t.name, t.spec && t.spec.inputSchema),
        // who() is closed over the ALREADY-RESOLVED role inside buildMcpServer. Calling the
        // recorded handler preserves that exactly: the modern branch cannot name a principal.
        call: async (args: any) => await t.handler(args)
      }));
    }
  });
  if (out.sse) {
    res.writeHead(out.status, out.headers);
    for (const f of out.sse) res.write('data: ' + JSON.stringify(f) + '\n\n');
    res.end();
    return;
  }
  const hk = Object.keys(out.headers || {});
  for (let i = 0; i < hk.length; i++) res.setHeader(hk[i], out.headers[hk[i]]);
  res.status(out.status).end(out.body === undefined ? '' : out.body);
}
app.post('/mcp', async (req: any, res: any) => {
  void oaAuditDefaultRole();
  // ===================== THE ERA ROUTER =====================
  // A request takes the modern path IFF it makes a modern VERSION CLAIM:
  // params._meta["io.modelcontextprotocol/protocolVersion"] present at any value, or -- only
  // when that key is absent -- MCP-Protocol-Version naming a revision DATED 2026-07-28 OR
  // LATER. The era boundary is a DATE, not a list of revisions we implement: [VER] Terminology
  // defines Modern as "revision 2026-07-28 and later", so a revision we have never heard of is
  // still a modern-era request and MUST be answered 400 + -32022 UnsupportedProtocolVersion
  // listing what we support. That answer only exists on the modern branch, so the ROUTING is
  // what makes it reachable. This used to test membership of headerNamesModernRevision's
  // allowlist -- one revision string -- and an unknown FUTURE revision in the header alone
  // therefore routed LEGACY, collected -32000 at HTTP 200, and the client, seeing no recognised
  // modern error, silently downgraded itself to 2025-06-18 and never learned what we support.
  // It is now a SHAPE-GUARDED date threshold (mcp2026IsModernRevision), and both halves are
  // load-bearing in opposite directions: without the YYYY-MM-DD shape guard, `banana` sorts
  // above `2026-07-28` in ASCII and every garbage header value is promoted to modern; without
  // the >= threshold, 2025-06-18 and 2025-11-25 are revision-shaped too and the entire 2025-era
  // client population is routed modern and breaks.
  // Everything else is legacy: initialize, a bare request, a header value that is not
  // revision-shaped at all, and a header naming a LEGACY revision (2025-06-18..2025-11-25
  // clients send that header too, which is why the header alone must never decide). Pure
  // function of one request's bytes: no session, no cache, no clock. Nothing above this line
  // inspects a modern header, because a -32020 handed to today's envelope-less traffic is a
  // RECOGNISED MODERN ERROR -- the client would stop falling back, "correct" a request that is
  // already correct, and deadlock.
  if (mcp2026IsModernRequest(req.headers, req.body)) {
    try { await mcpServeModern(req, res); }
    catch (e: any) { if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
    return;
  }
  // ---------------- legacy (2025-era) from here down, byte-identical ----------------
  const pcv: any = await pcResolveIdentity(req);
  if (pcv && pcv.deny) { pcSendDenied(req, res, String(pcv.reason || ''), pcv.id); return; }
  const role = pcv ? pcv.role : null;
  if (!role) { oaChallenge(req, res); return; }
  try {
    const server = await buildMcpServerAdmitted(role, pcv ? pcv.tc : undefined);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { try { transport.close(); server.close(); } catch (e) {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: any) { if (!res.headersSent) res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});
// GET /mcp: unauth -> discovery challenge; authed -> 405 (stateless transport has no server->client GET stream)
app.get('/mcp', async (req: any, res: any) => {
  const role = await oaBearerRole(req);
  if (!role) { oaChallenge(req, res); return; }
  res.status(405).json({ error: 'method_not_allowed' });
});
// DELETE /mcp: decision-table row 0. 2025-era DELETE terminated a session; this transport
// mints none, so it is Method Not Allowed. It is registered rather than left to Express
// because the alternative answer is a bare 404, and a 404 on the MCP endpoint tells a
// dual-era client that no modern endpoint lives here and sends it off to probe the
// deprecated HTTP+SSE GET transport. Mirrors GET /mcp exactly, challenge included.
app.delete('/mcp', async (req: any, res: any) => {
  const role = await oaBearerRole(req);
  if (!role) { oaChallenge(req, res); return; }
  res.status(405).json({ error: 'method_not_allowed' });
});
// ---- VERIFY-GREP: PC-SESSION-MINT-V1 : passkey-gated session-key admin ----
// These follow the existing convention in this file exactly: waSafe(...) wrapper, then a
// waSessionOk guard as the first statement. Both symbols are already used at module-eval
// time above (GET /api/strains), so they are in scope -- a ReferenceError here would take
// the whole control plane down at boot, including the gate, so this was verified first.
app.post('/api/sessions/mint', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const body: any = (req as any).body || {};
  const role = String(body.role || '').trim();
  const label = String(body.label || '').trim().slice(0, 80);
  // [WP4B-KEY-CLASSES-V1] OPTIONAL, PASSKEY-GATED, AND ONLY EVER SUBTRACTIVE. This is the one
  // writer of session_keys.tool_classes in the tree; before it there was none, which is the
  // whole reason the class mechanism looked absent rather than merely unused.
  // ABSENT -> the field is NOT written and the key is byte-for-byte the key this endpoint
  // minted yesterday. PRESENT -> it must be an array naming only known classes. An unknown name
  // is a 400 HERE rather than a silent drop: pcNarrowClasses would read a typo as the read-only
  // floor, which is safe but SILENT, and the operator minting a restricted key for a subagent
  // must learn at the Autoclave that he mistyped -- not weeks later, from a surprise.
  // An EXPLICIT empty array is legal and means the floor: sight only, no writes, no stages.
  let tcl: string[] | null = null;
  if (typeof body.tool_classes !== 'undefined') {
    if (!Array.isArray(body.tool_classes)) { res.status(400).json({ error: 'tool_classes must be an array of class names; known: ' + PC_ALL_CLASSES.join(',') }); return; }
    const badc = body.tool_classes.filter((x: any) => typeof x !== 'string' || PC_ALL_CLASSES.indexOf(x) < 0);
    if (badc.length) { res.status(400).json({ error: 'unknown tool class ' + JSON.stringify(badc).slice(0, 120) + '; known: ' + PC_ALL_CLASSES.join(',') }); return; }
    tcl = body.tool_classes.map((x: any) => String(x));
  }
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(role)) { res.status(400).json({ error: 'bad role' }); return; }
  const sd = await db.collection('strains').doc(role).get();
  if (!sd.exists) { res.status(400).json({ error: 'no such strain: ' + role }); return; }
  const srow: any = sd.data() || {};
  if (srow.status !== 'active') { res.status(400).json({ error: 'strain is not active: ' + role }); return; }
  // FAIL-CLOSED ALLOW-LIST. pasteable must be EXPLICITLY true.
  // 'active' and 'pasteable' are different questions and conflating them is a real hazard:
  // fleet-onboarder is where unclaimed connectors land and is never a chat identity, and
  // fleet-breakglass exists precisely as a recovery path -- neither may ever be minted into
  // a Cowork chat. A strain provisioned later defaults to NOT pasteable until a human marks
  // it, which is the correct direction for a flag that hands out identity.
  if (srow.pasteable !== true) { res.status(403).json({ error: 'role is not pasteable: ' + role }); return; }
  const key = 'pcs_' + oaRand(24);
  await oaSet('session_keys', oaTokHash(key), {
    role: role, label: label, revoked: false,
    created_by: 'passkey:' + WA_USER, created_at: FieldValue.serverTimestamp(),
    // [PC-KEY-TTL-V1] a plain millisecond epoch, not a server timestamp: pcSessionLookup
    // compares it with Date.now() and a Firestore Timestamp object would not compare.
    exp: Date.now() + PC_KEY_TTL_MS,
    // [WP4B-KEY-CLASSES-V1] Written ONLY when asked for, so an unrestricted mint leaves the
    // document shape it has always had and pcNarrowClasses takes its absent-means-unchanged path.
    ...(tcl === null ? {} : { tool_classes: tcl })
  });
  // The classes are not a credential and belong in the audit trail: a restricted key is only a
  // boundary if there is a durable record of what it was restricted TO.
  try { await db.collection('journal').add({ agent_id: 'passkey:' + WA_USER, action: 'session_key_mint', detail: 'minted a session key for ' + role + (tcl === null ? ' (unrestricted: holds every class its strain holds)' : ' RESTRICTED to tool classes [' + tcl.join(',') + ']'), at: FieldValue.serverTimestamp() }); } catch (e) {}
  // Returned ONCE. Only sha256(key) is stored, so this cannot be recovered later.
  res.json({ ok: true, role: role, key: key, tool_classes: tcl, note: 'shown once' });
}));

// ---- [STRAINLIFE-CREATE-V1] strain lifecycle: create a strain (from scratch, or as a clone) ----
// GATED exactly like /api/strain/delete and /api/strain/subculture: a passkey session (waGate)
// plus Face-ID elevation. Creation writes `strains` and `session_keys` -- that is access control
// wearing a database's clothes, so it does not get a softer gate than deletion does.
// POSITION IS LOAD-BEARING: this block sits BELOW the module-scope declarations of
// STRAIN_NEVER_PASTEABLE and PC_KEY_TTL_MS that it reads. Both are `const`; a read above the
// initializer compiles clean and throws ReferenceError at require time (revision 00245-jur).
// [SEC-FRESH-INSTALL-V1] THIS SEED USED TO TELL EVERY NEW STRAIN TO WAIT FOR A PASSKEY TAP
// THAT THIS INSTALL NEVER ASKS FOR. Its Doctrine line read 'STAGE, NEVER SHIP: propose
// privileged work, the human approves with a passkey.' install.sh ships PC_AUTO_APPROVE=1 and
// PC_REQUIRE_PASSKEY=0, so there is no approval console, nothing waits, and a staged job is
// signed and executed in the same call. An agent reading this on a first run was told to
// expect a step that does not exist -- the same defect class as the v8.5 inverted defaults,
// where shipped prose asserted a posture the product does not ship. Operator report
// 2026-08-18: agents were confused on first start. This is one of the two documents they read
// before anything else, so it says what is actually true here, including that a fresh install
// has no history to be missing.
const SL_SEED_LESSONS = [
  '# LESSONS -- <STRAIN>',
  '',
  'This file is the strain long-term memory. It is read at the start of every chat and rewritten',
  'by server-side reflection. A strain with no lessons file starts worse than an older strain: that',
  'was the old default and it is the reason this seed exists.',
  '',
  'THIS IS A SEED, WHICH MEANS THIS INSTALL IS NEW. Nothing below was learned here -- it is the',
  'starting posture, not experience. If this file still looks like this after real work, nothing',
  'has been written back and that is worth saying out loud.',
  '',
  '## Lane',
  '- I own ONE lane and do not speak for the whole fleet.',
  '',
  '## Doctrine',
  '- PRIVILEGED WORK RUNS IMMEDIATELY. This install ships PC_AUTO_APPROVE=1: a staged job is',
  '  signed, executed and journalled in the same call. There is no approval queue and nobody',
  '  taps anything. So be sure BEFORE the call, not after -- batch a privileged sequence into',
  '  one job and read the job log rather than trusting the status field.',
  '- The container is ephemeral; the lake is the only durable memory.',
  '- Verify from the journal and from real bytes -- never claim fleet state from memory.',
  '',
  '## How work reaches the code here',
  '- The repository is seeded and buildable. git_archive returns the WHOLE ref in one call --',
  '  use it to get a tree to build. git_read/git_list are for reading single files. Never',
  '  rebuild a checkout out of diffs; git_diff is capped and truncates without saying so.',
  '- Change code with git_propose (whole files), verify the treeOid it returns against one you',
  '  built locally, then git_push by compare-and-swap. There is no force push.',
  '- Deploy is three steps: build, deploy at ZERO traffic behind a tag, verify the tagged URL,',
  '  then shift traffic. Read the serving revision out of the service, not out of the deploy.',
  '',
  '## Open threads',
  '- (none yet -- this install has no history)',
].join('\n');
async function slMintSessionKey(role: string, label: string): Promise<string> {
  // Same mechanism as POST /api/sessions/mint: pcs_ + 24 random bytes, only sha256(key) is
  // stored, same TTL field shape (a plain epoch ms, because pcSessionLookup compares Date.now()).
  const key = 'pcs_' + oaRand(24);
  await oaSet('session_keys', oaTokHash(key), {
    role: role, label: String(label || '').slice(0, 80), revoked: false,
    created_by: 'passkey:' + WA_USER, created_at: FieldValue.serverTimestamp(),
    exp: Date.now() + PC_KEY_TTL_MS
  });
  return key;
}
app.post('/api/strain/create', waGate(async (req, res) => {
  const b: any = (req as any).body || {};
  const id = String(b.id || '').trim().toLowerCase();
  const display = String(b.display_name || id).trim().slice(0, 80);
  const mode = (String(b.mode || 'new') === 'clone') ? 'clone' : 'new';
  const parent = String(b.parent || '').trim().toLowerCase();
  // Same charset guard as /api/strain/delete, and for the same reason: this id becomes a lake
  // path segment (agents/<id>/LESSONS.md). A dot or a slash here is path traversal.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    harJournalAs('harness', 'security_quarantine', 'Refused strain id: bad charset (possible path traversal): ' + String(b.id).slice(0, 64));
    res.status(403).json({ error: 'forbidden: invalid id format' });
    return;
  }
  if (id === 'human_operator') { res.status(400).json({ error: 'reserved id' }); return; }
  if (mode === 'clone') {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(parent)) { res.status(400).json({ error: 'clone needs a valid parent id' }); return; }
    if (parent === id) { res.status(400).json({ error: 'a strain cannot be its own parent' }); return; }
  }
  try {
    // 409 on ANY of the three stores. A half-existing id (history but no registry row) is exactly
    // how the subculture bug produced ghosts; refuse rather than merge into someone else's past.
    const sd = await db.collection('strains').doc(id).get();
    if (sd.exists) { res.status(409).json({ error: 'a strain "' + id + '" already exists' }); return; }
    const exch = await db.collection('chat_history').where('agent_id', '==', id).limit(1).get();
    if (!exch.empty) { res.status(409).json({ error: 'chat history already exists for "' + id + '"' }); return; }
    const exjn = await db.collection('journal').where('agent_id', '==', id).limit(1).get();
    if (!exjn.empty) { res.status(409).json({ error: 'journal entries already exist for "' + id + '"' }); return; }
    if (mode === 'clone') {
      const pd = await db.collection('strains').doc(parent).get();
      if (!pd.exists) { res.status(400).json({ error: 'no such parent strain: ' + parent }); return; }
    }
    // LESSONS IS ALWAYS WRITTEN. Precedence: hand-written body > parent copy (clone +
    // import_lessons) > seed template. The uppercase name is canonical; the parent copy reads
    // uppercase first and falls back to the legacy lowercase object.
    let lessons = String(b.lessons || '');
    let lessonsFrom = lessons ? 'body' : 'seed';
    if (!lessons && mode === 'clone' && b.import_lessons === true) {
      lessons = await harReadLake('agents/' + parent + '/LESSONS.md');
      if (!lessons) lessons = await harReadLake('agents/' + parent + '/lessons.md');
      if (lessons) lessonsFrom = 'parent';
    }
    if (!lessons) { lessons = SL_SEED_LESSONS.split('<STRAIN>').join(id); lessonsFrom = 'seed'; }
    await harWriteLake('agents/' + id + '/LESSONS.md', lessons.slice(0, 20000), 'text/markdown; charset=utf-8');
    let copied = 0;
    if (mode === 'clone' && b.import_history === true) {
      const ch = await db.collection('chat_history').where('agent_id', '==', parent).limit(5000).get();
      const rows = ch.docs.map((d: any) => d.data());
      rows.sort((x: any, y: any) => (((x.timestamp && x.timestamp._seconds) || 0) - ((y.timestamp && y.timestamp._seconds) || 0)));
      for (const r of rows) {
        try { await db.collection('chat_history').add({ agent_id: id, role: r.role, text: String(r.text || ''), tags: ['strain-create', 'inherited'], timestamp: (r.timestamp || FieldValue.serverTimestamp()) }); copied++; } catch (e) {}
      }
    }
    // NEVER PASTEABLE applies to CREATION, not just to the seed roster. fleet-onboarder is
    // where unclaimed connectors land; minting a human paste for it hands a person the
    // identity of machinery. Default is FALSE for everything else too.
    const askedPasteable = (b.pasteable === true);
    const banned = STRAIN_NEVER_PASTEABLE.has(id);
    const pasteable = askedPasteable && !banned;
    if (askedPasteable && banned) { harJournalAs('harness', 'security_quarantine', 'Refused pasteable creation of a service identity: ' + id); }
    await db.collection('strains').doc(id).set({ role: id, display_name: display || id, status: 'active', pasteable: pasteable, hidden: false, created_by: 'passkey:' + WA_USER, mode: mode, parent: (mode === 'clone' ? parent : null), created_at: FieldValue.serverTimestamp() });
    // The journal records THAT a key was minted. It never records the key: a key in a log is a
    // live credential in a log, and this journal is readable by every role.
    try { await db.collection('journal').add({ agent_id: id, action: 'strain_created', message: 'created strain ' + id + ' (' + mode + (mode === 'clone' ? ' of ' + parent : '') + '); lessons=' + lessonsFrom + '; inherited=' + copied + '; pasteable=' + pasteable, parent: (mode === 'clone' ? parent : null), timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
    let paste = '';
    let minted = false;
    if (pasteable) {
      const key = await slMintSessionKey(id, 'created:' + id);
      minted = true;
      let body = '';
      if (id.indexOf('fleet-') === 0) { try { body = await harCoworkPromptTool({ strain: id, task: String(b.task || '') }, id); } catch (e) { body = ''; } }
      const line = 'PC-SESSION-KEY: ' + key;
      if (body && body.indexOf('----- COPY BELOW -----') >= 0) { paste = body.replace('----- COPY BELOW -----', '----- COPY BELOW -----\n' + line); }
      else { paste = ['----- COPY BELOW -----', line, '# PARACODING.AI - STRAIN ' + id, '', 'The Paracoding.AI MCP connector is your identity. Pass the key above as the "agent" argument on EVERY tool call.', 'DO FIRST: whoami -- it RETURNS the memory digest and the bootstrap; read what it hands back. read_file agents/' + id + '/LESSONS.md. read_journal(limit 30).', '----- COPY ABOVE -----'].join('\n'); }
    }
    res.json({ ok: true, id: id, mode: mode, parent: (mode === 'clone' ? parent : null), pasteable: pasteable, refused_pasteable: (askedPasteable && banned), lessons_from: lessonsFrom, inherited: copied, minted: minted, paste: paste, note: (minted ? 'this key is shown ONCE; only its sha256 is stored and it is never journalled' : 'not pasteable: no session key minted') });
  } catch (e: any) { harFail(res, e, 'harness'); }
}));
app.get('/api/sessions', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const out: any[] = [];
  try {
    const snap = await db.collection('session_keys').limit(200).get();
    // d.id is sha256(key), not the key. A prefix of a hash is not a credential.
    snap.forEach((d: any) => { const r: any = d.data() || {}; out.push({ id: String(d.id).slice(0, 12), role: r.role || null, label: r.label || '', revoked: !!r.revoked, created_at: r.created_at || null, last_seen: r.last_seen || null }); });
  } catch (e) {}
  res.json({ sessions: out, enforcing: PC_ENFORCE });
}));

// Sets the two governance flags on a strain. Separate from provision/retire on purpose:
//   status   -- may this principal talk to the fleet at all (admission control reads this)
//   pasteable-- may a human be handed a session key that becomes this role in a chat
//   hidden   -- should this role be omitted from human-facing rosters
// A service principal is active + not pasteable. A retired flail artifact is inactive +
// hidden. Keeping these independent is what stops "tidy up the roster" from retiring a service identity.
app.post('/api/sessions/roleflags', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const body: any = (req as any).body || {};
  const role = String(body.role || '').trim();
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(role)) { res.status(400).json({ error: 'bad role' }); return; }
  const sd = await db.collection('strains').doc(role).get();
  if (!sd.exists) { res.status(400).json({ error: 'no such strain: ' + role }); return; }
  const upd: any = {};
  if (typeof body.pasteable === 'boolean') upd.pasteable = body.pasteable;
  if (typeof body.hidden === 'boolean') upd.hidden = body.hidden;
  if (!Object.keys(upd).length) { res.status(400).json({ error: 'nothing to set: pass pasteable and/or hidden as booleans' }); return; }
  upd.flags_set_by = 'passkey:' + WA_USER;
  upd.flags_set_at = FieldValue.serverTimestamp();
  await db.collection('strains').doc(role).set(upd, { merge: true });
  try { await db.collection('journal').add({ agent_id: 'passkey:' + WA_USER, action: 'strain_flags', detail: role + ' ' + JSON.stringify({ pasteable: upd.pasteable, hidden: upd.hidden }), at: FieldValue.serverTimestamp() }); } catch (e) {}
  pcSessCache.clear();
  res.json({ ok: true, role: role, pasteable: upd.pasteable, hidden: upd.hidden });
}));

// Roles the Autoclave may offer as a paste. Deliberately NOT 'every active strain':
// fleet-onboarder is where unclaimed connectors land and must never become a chat identity.
// Fail-closed -- a strain provisioned later is absent here until a human marks it.
app.get('/api/sessions/roles', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const out: any[] = [];
  try {
    const snap = await db.collection('strains').limit(200).get();
    snap.forEach((d: any) => {
      const r: any = d.data() || {};
      if (r.pasteable === true && r.status === 'active') {
        out.push({ role: String(d.id), display_name: String(r.display_name || d.id) });
      }
    });
  } catch (e) {}
  out.sort((a: any, b: any) => (a.role < b.role ? -1 : 1));
  res.json({ roles: out, enforcing: PC_ENFORCE });
}));

// ============ [REVOKE-HONEST-V1] A SECURITY CONTROL THAT COULD ONLY EVER SAY "ok" ============
// WHAT WAS WRONG, and it was wrong in two independent ways that compound:
//
// (1) THE WHOLE LOOP SAT INSIDE ONE `catch (e) {}`. Read the old body: the Firestore query, the
//     prefix scan and EVERY d.ref.set() were in a single try whose catch was empty, and the
//     response was the literal `{ ok: true, revoked: n }`. So a permission error on the very
//     first write, or a query that never returned a document at all, produced HTTP 200 ok:true
//     revoked:0 -- byte-identical to a genuine no-match. This is a REVOCATION endpoint. The one
//     thing an operator does with it is cut a leaked session and then believe the answer, and
//     the answer was unfalsifiable: there was no input for which it reported failure.
//     Worse, a mid-loop throw abandoned the remaining documents, so a partial revocation --
//     some keys cut, some still live -- also reported ok:true, with a count that stopped at
//     wherever the exception landed rather than at what was actually revoked.
//
// (2) THE limit(500) WAS INVISIBLE. session_keys is scanned with a hard cap and the cap was
//     never reported, never even hinted at in the response. An install with more than 500 key
//     documents revokes across a PREFIX OF THE COLLECTION and is told, in the same words as a
//     complete pass, that it succeeded. Firestore's page order is not the operator's mental
//     order, so which keys got missed is arbitrary.
//
// WHAT IS REPORTED NOW: scanned / scan_limit / truncated, matched / revoked / failed, and the
// per-document errors (capped, with the elided count stated so the cap cannot hide anything
// either). ok is `failed === 0`, and the status follows ok, so a caller that checks only the
// HTTP status still learns the truth.
// ZERO MATCHES IS DELIBERATELY ok:true. Revoking a prefix that matches nothing is a successful
// idempotent no-op: zero failures, zero live keys left under that prefix. matched:0 already
// distinguishes it for anyone who cares, and returning ok:false there would train the operator
// to ignore the field.
//
// THE CAP IS RAISED NOWHERE AND PAGINATION IS DELIBERATELY NOT ADDED. Both are real changes to
// how much Firestore this route reads, on a route reached from the unlock page; making the
// existing bound VISIBLE is the fix for being lied to, and it is separable from changing what
// the bound is. truncated/more_remaining are what a follow-up would key off.
// THE JOURNAL ENTRY IS WRITTEN ON FAILURE TOO -- previously the only durable record of a
// revocation attempt was the success path's, so the attempts worth investigating were the ones
// that left no trace.
app.post('/api/sessions/revoke', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const body: any = (req as any).body || {};
  const idp = String(body.id || '').trim();
  if (idp.length < 6) { res.status(400).json({ error: 'id prefix too short' }); return; }
  const REVOKE_SCAN_CAP = 500;          // unchanged from the old limit(500); now reported
  const REVOKE_MAX_ERRORS = 20;         // response bound; the remainder is counted, not dropped
  const jrn = async (action: string, message: string, detail: any) => {
    try {
      await db.collection('journal').add({
        agent_id: 'passkey:' + WA_USER, action: action, message: message,
        detail: JSON.stringify(detail), timestamp: FieldValue.serverTimestamp(), at: FieldValue.serverTimestamp(),
      });
    } catch (e) {}
  };

  // The QUERY gets its own try. It is the one failure that means "nothing was even attempted",
  // and conflating it with a write failure is how the old code lost the distinction.
  let snap: any;
  try {
    snap = await db.collection('session_keys').limit(REVOKE_SCAN_CAP).get();
  } catch (e: any) {
    const msg = String((e && e.message) || e || 'session_keys query failed');
    await jrn('session_key_revoke_failed',
      'REVOCATION NOT ATTEMPTED for prefix ' + idp + ': session_keys query failed: ' + msg,
      { prefix: idp, error: msg });
    res.status(500).json({
      ok: false, prefix: idp, error: msg,
      scanned: 0, scan_limit: REVOKE_SCAN_CAP, truncated: false, more_remaining: false,
      matched: 0, revoked: 0, failed: 0, errors: [], errors_elided: 0,
      note: 'The session_keys query failed, so NOTHING was revoked. Any key matching this prefix is still live.',
    });
    return;
  }

  const scanned = snap.docs.length;
  const truncated = scanned >= REVOKE_SCAN_CAP;
  let matched = 0, revoked = 0, failed = 0, errorsElided = 0;
  const errors: Array<{ id: string; error: string }> = [];

  // Per-document try: one failing write no longer abandons the documents after it. Cutting four
  // of five leaked sessions is strictly better than cutting one and stopping -- as long as the
  // caller is told it was four of five, which is the whole point of this block.
  for (const d of snap.docs) {
    if (String(d.id).indexOf(idp) !== 0) continue;
    matched++;
    try {
      await d.ref.set({ revoked: true, revoked_at: FieldValue.serverTimestamp() }, { merge: true });
      revoked++;
    } catch (e: any) {
      failed++;
      const msg = String((e && e.message) || e || 'update failed');
      // Only a short id prefix is echoed. A session key document id IS the credential material
      // this route exists to destroy; it does not go into a response or a journal entry whole.
      if (errors.length < REVOKE_MAX_ERRORS) errors.push({ id: String(d.id).slice(0, 12), error: msg });
      else errorsElided++;
    }
  }

  pcSessCache.clear();
  const ok = failed === 0;
  const capNote = truncated ? ', CAPPED at ' + REVOKE_SCAN_CAP : '';
  await jrn(
    ok ? 'session_key_revoke' : (revoked > 0 ? 'session_key_revoke_partial' : 'session_key_revoke_failed'),
    (ok ? 'Revoked ' : (revoked > 0 ? 'PARTIAL REVOCATION -- ' : 'REVOCATION FAILED -- ')) +
      revoked + ' of ' + matched + ' matching session key(s) for prefix ' + idp +
      ' (' + failed + ' failed, scanned ' + scanned + capNote + ').',
    { prefix: idp, ok: ok, matched: matched, revoked: revoked, failed: failed, scanned: scanned,
      scan_limit: REVOKE_SCAN_CAP, truncated: truncated, errors: errors.slice(0, 5),
      errors_elided: errorsElided + Math.max(0, errors.length - 5) });

  res.status(ok ? 200 : 500).json({
    ok: ok, prefix: idp,
    scanned: scanned, scan_limit: REVOKE_SCAN_CAP, truncated: truncated, more_remaining: truncated,
    matched: matched, attempted: matched, revoked: revoked, failed: failed,
    errors: errors, errors_elided: errorsElided,
    note: !ok
      ? (revoked + ' of ' + matched + ' matching key(s) revoked; ' + failed + ' still live. Retry -- the writes are idempotent.')
      : (truncated
          ? 'Only the first ' + REVOKE_SCAN_CAP + ' session_keys documents were scanned. More matching keys may exist beyond the cap and would still be live.'
          : undefined),
  });
}));

// =============== end Paracoding MCP OAUTH ===============


// [MCP2-BOOT-V1] Called BEFORE listen and NOT wrapped in try/catch, on purpose: if the v2
// SDK is missing or has no createMcpHandler this throws and the revision never becomes
// ready. The Dockerfile already gates the same require() at BUILD time -- build stage and
// runtime stage are the same image -- so reaching this line failing would be news.
console.log('[mcp2]', assertMcp2Loadable());
const PORT = process.env.PORT || 8080;
// [SEC-IAP-JWKS-COLDCACHE-V1] Open the port with usable IAP keys, not without them. When the
// passkey is off, a verified IAP assertion is the ONLY thing waSessionOk can admit on, and that
// check is synchronous -- it cannot wait for the JWKS itself. So the wait happens here, once.
//
// BOUNDED, AND IT LISTENS EITHER WAY. Cloud Run's startup probe on this service is a TCP check
// with a 240s timeout, so a few hundred milliseconds is free; but a hang here would be a revision
// that never becomes ready, which is worse than the bug being fixed. The race caps the wait at 5s
// and listens regardless. If the fill did not finish, that is said on stderr rather than being
// discovered later from 401s -- the service still fails CLOSED, exactly as before this change.
function pcListen(): void {
  app.listen(PORT, () => {
    console.log(`Paracoding Control Plane & MCP SSE Server online on port ${PORT}`);
  });
}
if (PC_IAP_AUD) {
  let filled = false;
  Promise.race([
    pcIapRefreshKeys().then(() => { filled = true; }),
    new Promise((r) => setTimeout(r, 5000)),
  ]).then(() => {
    if (!filled) console.error('[iap-jwks] first fill did not complete in 5s; listening anyway, early requests may be refused');
    pcListen();
  });
} else {
  pcListen();
}

// =============== FLOW HOOD FRONT DOOR (operator ruling 2026-07-31) ===============
// One auth opens everything for WA_SESSION_MIN. Approving a job still costs a fresh,
// job-bound WebAuthn assertion -- that check is untouched.
//
// [SEC-NOGATE-V1] /jobs AND /pastes ARE DELETED, not moved. Both served the same 142KB gate
// document this commit removes, differing only in which tab it opened, so there was nothing
// left to serve. The pastes minter already lives on the Flow Hood itself ([PCSESSIONPASTE-V1]
// in harness.html, on the same /api/sessions/roles and /api/sessions/mint), and the queue is
// the approvals drawer there. Their PC_SURFACE_MAP entries and their route-baseline.json
// `registered` lines are removed with them, which the route audit requires.
//
// NOTHING HERE IS A CATCH-ALL. The MCP connector's paths (/.well-known/*, /oauth/*, /mcp,
// /agents/*) are not matched by any route below.
// [PC-CANONICAL-HOST-V48] The target moved from /harness to / with the rest of the collapse: this
// is an alias for the hood, and the hood is at the root now. It would still arrive via the 301 on
// /harness, but sending a signed-in operator through two redirects to reach a page one hop away is
// how a redirect chain starts. Status is left at 302, exactly as it was -- nothing asked for this
// alias to become permanent, and an un-cached bounce is the one that can be changed again.
app.get('/flowhood', (req: any, res: any) => { if (pcCanonicalHostRedirect(req, res)) return; if (!waSessionOk(req)) { waSendLocked(res); return; } res.redirect(harRootWithQuery(req)); });
// =============== end flow hood front door ===============

// Type the gate hostname and land on the gate that your passkey actually works
// on. The canonical host is WA_RP_ID -- the WebAuthn RP ID is BY DEFINITION the
// only hostname where an assertion can verify, so there is no second copy of
// this value to go stale.
// ONLY the browser-facing paths that CALL the function below reach this. /mcp, /oauth/*,
// /.well-known/* and /agents/* never do: they are the connector and must answer on any
// host. There is no middleware and no catch-all here for exactly that reason -- an app.use
// is not filtered by PC_SURFACE_MAP, so on the single-service install it would also sit in
// front of /mcp, and on the split install it would run on the mcp surface where there is
// neither IAP nor a session cookie nor any hostname this code has the right to move.
//
// [PC-CANONICAL-HOST-V48] 2026-08-15. PC_CANONICAL_HOST IS AN OPT-IN SWITCH, NOT A SECOND COPY OF
// THE HOSTNAME. The paragraph above is still true and is the whole reason two variables are read
// instead of one: the redirect TARGET below is WA_RP_ID and nothing else, because the RP ID is the
// only hostname on which a passkey assertion can verify. PC_CANONICAL_HOST does not name the
// target -- it ARMS the redirect, and it has to be spelled the same as WA_RP_ID to do so. UNSET IS
// THE DEFAULT AND IS TODAY'S BEHAVIOUR EXACTLY: no host is read, no comparison is made, no redirect
// is ever issued, and an install that has not opted in cannot be moved by any of this.
//
// WHY A DISAGREEMENT DISARMS THE REDIRECT INSTEAD OF FOLLOWING IT. A passkey is bound to the RP ID.
// Send a signed-in operator from the host their credential works on to a host where it does not,
// and the sign-in they need in order to undo the mistake is the thing the mistake broke. That is a
// lockout; deploy/LOCKOUT-CLASS.md item 1 is the same failure reached from the other side (renaming
// the console changes CP_HOST, which changes WA_RP_ID, which invalidates every enrolled
// credential). So a mismatch leaves the install serving precisely what it served before anyone set
// the variable -- the known-good state -- and the boot line below names the two variables so the
// operator can see which half they have not done yet.
//
// AND IT DOES NOT THROW AT BOOT, WHICH WAS THE OTHER OPTION AND IS THE WORSE ONE. This file already
// ruled on that shape for the data lake -- "FAIL CLOSED PER CALL, WITH A NAMED ERROR, AND NOT AT
// BOOT ... a module-level refusal turns a missing variable into a crash-looping revision and takes
// down the gate, the console and every route that never touches the lake". Here it would be worse
// than there, because the process that would refuse to start IS the console, IS the passkey
// enrolment path, and IS the way back in. A hostname typed wrong in an env var must not be able to
// take the front door off its hinges; it may only decline to move it.
// WA_RP_ORIGIN IS CHECKED TOO, AND IT IS NOT A THIRD COPY EITHER -- IT IS THE OTHER HALF OF THE
// SAME ANSWER. verifyAuthenticationResponse is given expectedRPID AND expectedOrigin (:2898,
// :3853, :3888), and a mismatch in EITHER is a rejected assertion. WA_RP_ID agreeing while
// WA_RP_ORIGIN still names only the old hostname is therefore the same lockout with an extra step:
// the operator arrives at a host whose RP ID is right, taps the key, and the verifier refuses it.
// The arming condition asks for the origin the browser will actually send from that host.
const PC_CANONICAL_HOST = String(process.env.PC_CANONICAL_HOST || '').trim().toLowerCase();
// [PC-CANONICAL-HOST-V124] The redirect used to be anchored on WA_RP_ID because a passkey
// assertion verifies on exactly one hostname, so sending a signed-in operator anywhere else was
// a lockout. There are no assertions now: IAP admits the same Google identity on any host this
// service answers on, so a wrong value here is a bad redirect and nothing worse. Unset -- the
// default, and what every install ships -- still means no host is read and no redirect issued.
const PC_CANONICAL_ARMED = PC_CANONICAL_HOST !== '';
if (PC_CANONICAL_ARMED) {
  console.error('[cp] PC-CANONICAL-HOST-V124: host redirect ARMED to ' + PC_CANONICAL_HOST + '.');
}
// TRUE means this function has ANSWERED the request, so every call site is `if (...) return;`.
// It preserves path and query verbatim, which is what lets a bookmarked or mailed
// /harness?enroll=<token> survive the move to the new hostname instead of arriving stripped.
function pcCanonicalHostRedirect(req: any, res: any): boolean {
  if (!PC_CANONICAL_ARMED) return false;
  // A Host header is an AUTHORITY, not a hostname: it may carry a port, and an IPv6 literal keeps
  // its brackets. Compare without the port. An absent or empty Host is left alone rather than
  // guessed at -- there is nothing to compare it against, and a guess would bounce a health check.
  const raw = String((req && req.get ? req.get('host') : '') || '').trim().toLowerCase();
  const host = raw.replace(/:\d+$/, '');
  if (!host || host === PC_CANONICAL_HOST) return false;
  const url = String((req && (req.originalUrl || req.url)) || '/') || '/';
  // no-store for the same reason the 301 on /harness carries it: a permanently cached host
  // redirect survives being turned off, so unsetting PC_CANONICAL_HOST would not actually give
  // the old hostname back to a browser that had already been moved once.
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(301, 'https://' + PC_CANONICAL_HOST + (url.charAt(0) === '/' ? url : '/' + url));
  return true;
}

