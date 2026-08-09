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
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
// [SEC-DEBLOB-V1] The gate, dash and harness documents are FILES, not base64 constants.
// They are read once at module load. The Dockerfile does `COPY src ./src` and esbuild
// transpiles to dist/index.js, so __dirname is /app/dist and ../src/<f> is /app/src/<f>.
// A missing file throws HERE, at boot: the container never becomes ready and Cloud Run
// keeps the previous revision serving. Fail-closed beats an empty gate page.
import * as fs from 'fs';
import * as path from 'path';
const pcHtml = (f: string): string => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
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
const HUMAN_CONFIRM_SECRET = process.env.HUMAN_CONFIRM_SECRET || '';
const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || '';
// HFC4: /api/confirm/verify is gated by the human-confirm secret. Reject empty OR weak/short secrets
// so a blank/default value can never satisfy the check (fail-closed). Require a strong secret (min 16).
const HUMAN_CONFIRM_SECRET_MIN = 16;
const HUMAN_CONFIRM_SECRET_OK = typeof HUMAN_CONFIRM_SECRET === 'string' && HUMAN_CONFIRM_SECRET.length >= HUMAN_CONFIRM_SECRET_MIN;
if (!HUMAN_CONFIRM_SECRET_OK) {
  console.error('[cp] SECURITY: HUMAN_CONFIRM_SECRET is missing or shorter than ' + HUMAN_CONFIRM_SECRET_MIN + ' chars — /api/confirm/verify is DISABLED (fail-closed). Set a strong HUMAN_CONFIRM_SECRET.');
}
function humanTokenOk(req: express.Request): boolean {
  const provided = (req.headers['x-human-token'] as string) || '';
  // fail closed if the secret is missing/weak, then constant-time compare on equal lengths
  if (!HUMAN_CONFIRM_SECRET_OK || provided.length !== HUMAN_CONFIRM_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(HUMAN_CONFIRM_SECRET));
}
// [PARAM-PROJECT-V1] 2026-08-01. This file hardcoded one operator's project id and lake
// bucket. In a public release that is not a naming problem: a stranger's control plane would
// point at somebody else's bucket and fail with a 403 they cannot explain. Resolved from the
// environment instead, with NO fallback to the old values -- an empty value fails loudly
// where a wrong one fails quietly, and a fallback would keep the release leaking.
const PC_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const PC_LAKE = process.env.LAKE_BUCKET || (PC_PROJECT ? PC_PROJECT + '-datalake' : '');
// [SEC-REPOID-PARAM-V1] The fleet's git repository id. It is an operator-private name and
// must not be baked into a public tree, but it IS load-bearing at three call sites below --
// the MCP server name, twice, and the pinned memory-digest entity -- so it is parameterised
// here instead of being edited out of them. In THIS tree the default is the literal those
// sites carried before; in the PUBLIC tree oss/gen-v3.py rewrites it to a neutral id at
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
// through the gate, so every such route is console. A bearer token, an OAuth access token or the
// human-confirm secret (assertIdentity, oaBearerRole, humanTokenOk) is reachable only from a
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
  'GET /gate': 'console',
  'GET /dash': 'console',
  'GET /harness': 'console',
  'GET /chat': 'console',
  'GET /flow': 'console',
  'GET /flowhood': 'console',
  'GET /jobs': 'console',
  'GET /pastes': 'console',
  'GET /wiki': 'console',
  'GET /wiki/:slug': 'console',
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
  'GET /api/vm/status': 'console',
  'POST /api/vm/start': 'console',
  'POST /api/vm/stop': 'console',
  'GET /api/security/pqc-tls': 'console',
  'POST /api/security/pqc-tls': 'console',
  'POST /api/ops/token': 'console',
  'GET /api/ops/session': 'console',
  'POST /api/ops/end': 'console',
  'POST /api/shell': 'console',
  'GET /api/shell/health': 'console',
  'GET /api/models': 'console',
  'GET /api/usage': 'console',
  'GET /api/keys/status': 'console',
  'POST /api/keys': 'console',
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
  'GET /api/cowork-prompt': 'console',
  // ---- mcp: the connector transports ----
  'POST /mcp': 'mcp',
  'GET /mcp': 'mcp',
  'POST /mcp/:token': 'mcp',
  'GET /api/mcp': 'mcp',
  'POST /api/mcp': 'mcp',
  // ---- mcp: the legacy bearer-token agent API ----
  'POST /api/queue/post': 'mcp',
  'POST /api/queue/claim': 'mcp',
  'POST /api/journal/log': 'mcp',
  'POST /api/confirm/stage': 'mcp',
  'POST /api/confirm/verify': 'mcp',
  'POST /api/jobs/fire': 'mcp',
  'POST /api/jobs/supersede': 'mcp',
  // ---- mcp: OAuth 2.1 and discovery, advertised on the MCP host by oaPubBase ----
  'POST /oauth/register': 'mcp',
  'GET /oauth/authorize': 'mcp',
  'POST /oauth/authorize/complete': 'mcp',
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

const activeConnections = new Map<string, { res: express.Response; clientEmail: string }>();

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

app.post('/api/confirm/stage', async (req, res) => {
  try {
    const callerId = assertIdentity(req);
    const { command_type, arguments: args } = req.body;
    const jobRef = db.collection('pending_confirms').doc();
    await jobRef.set({
      job_id: jobRef.id, staged_by: callerId, command_type,
      arguments: args || {}, status: 'pending',
      created_at: FieldValue.serverTimestamp()
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

app.post('/api/confirm/verify', async (req, res) => {
  try {
    if (!humanTokenOk(req)) {
      res.status(403).json({ error: 'Forbidden: valid human-confirm secret required (x-human-token).' });
      return;
    }
    const { jobId, action } = req.body;
    if (action !== 'confirmed' && action !== 'denied') {
      res.status(400).json({ error: "action must be 'confirmed' or 'denied'" });
      return;
    }
    await db.collection('pending_confirms').doc(jobId).update({
      status: action, confirmed_by: 'human_operator',
      confirmed_at: FieldValue.serverTimestamp()
    });
    await db.collection('journal').add({
      agent_id: 'human_operator', action: `human_${action}`,
      message: `Human operator ${action} job ID ${jobId}.`,
      timestamp: FieldValue.serverTimestamp()
    });

    if (action === 'confirmed') {
      const GATE_EXEC_URL = process.env.GATE_EXEC_URL;
      if (GATE_EXEC_URL) {
        // Fire and forget, execution happens async
        fetch(`${GATE_EXEC_URL}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: jobId })
        }).catch(e => console.error('Failed to trigger GATE_EXEC_URL:', e));
      } else {
        console.warn('GATE_EXEC_URL not set; cannot trigger executor automatically.');
      }
    }

    res.status(200).json({ success: true, message: `Job ${jobId} successfully ${action}.` });
  } catch (err: any) {
    const _em = String((err && err.message) || '');
        console.error('handler error:', _em);
        if (_em.indexOf('401') === 0) { res.status(401).json({ error: 'unauthorized' }); return; }
        res.status(400).json({ error: 'request failed' });
  }
});

app.get('/api/mcp', (req, res) => {
  try {
    const clientEmail = assertIdentity(req);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const connectionId = uuidv4();
    activeConnections.set(connectionId, { res, clientEmail });
    const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const postUrl = `${proto}://${req.get('host')}/api/mcp?connectionId=${connectionId}`;
    res.write(`event: endpoint\ndata: ${postUrl}\n\n`);
    db.collection('journal').add({
      agent_id: 'mcp_gateway', action: 'client_connect',
      message: `MCP Client ${clientEmail} established connection ID ${connectionId} over SSE.`,
      timestamp: FieldValue.serverTimestamp()
    });
    const interval = setInterval(() => { res.write(': keepalive\n\n'); }, 15000);
    req.on('close', () => {
      clearInterval(interval);
      activeConnections.delete(connectionId);
      db.collection('journal').add({
        agent_id: 'mcp_gateway', action: 'client_disconnect',
        message: `MCP Connection ID ${connectionId} closed.`,
        timestamp: FieldValue.serverTimestamp()
      });
    });
  } catch (err: any) {
    res.status(401).send(err.message);
  }
});

app.post('/api/mcp', async (req, res) => {
  const connectionId = req.query.connectionId as string;
  if (!connectionId || !activeConnections.has(connectionId)) {
    res.status(400).json({ error: 'Missing or inactive connection ID' });
    return;
  }
  const conn = activeConnections.get(connectionId)!;
  const { jsonrpc, id, method, params } = req.body;
  if (jsonrpc !== '2.0') {
    res.status(400).json({ error: 'Invalid JSON-RPC protocol' });
    return;
  }
  let jsonRpcResponse: any = { jsonrpc: '2.0', id };
  try {
    if (method === 'tools/list') {
      jsonRpcResponse.result = {
        tools: [
          { name: 'runCommand', description: 'Executes a system shell command. High-privilege, ALWAYS requires staging + human approval.',
            inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to run.' } }, required: ['command'] } },
          { name: 'sshExecutor', description: 'Executes commands on remote fleet nodes via SSH. High-privilege, ALWAYS requires staging + human approval.',
            inputSchema: { type: 'object', properties: { host: { type: 'string', description: 'Target hostname or IP address' }, command: { type: 'string', description: 'The shell command to execute' } }, required: ['host', 'command'] } }
        ]
      };
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolInput = params?.arguments || {};
      const jobRef = db.collection('pending_confirms').doc();
      let cmd_type = 'run_cmd';
      if (toolName === 'sshExecutor') { cmd_type = 'ssh'; }
      await jobRef.set({
        job_id: jobRef.id, staged_by: conn.clientEmail, command_type: cmd_type,
        arguments: toolInput, status: 'pending', created_at: FieldValue.serverTimestamp()
      });
      await db.collection('journal').add({
        agent_id: conn.clientEmail, action: 'stage_job',
        message: `Staged MCP job ${cmd_type} (${jobRef.id}) via the MCP connector awaiting human approval.`,
        timestamp: FieldValue.serverTimestamp()
      });
      jsonRpcResponse.result = {
        content: [ { type: 'text', text: `Action successfully STAGED on the board under Job ID: ${jobRef.id}. Status is currently 'pending'. The command will execute once approved by the human operator.` } ]
      };
    } else {
      jsonRpcResponse.error = { code: -32601, message: 'Method not found' };
    }
    conn.res.write(`event: message\ndata: ${JSON.stringify(jsonRpcResponse)}\n\n`);
    res.status(200).send('OK');
  } catch (err: any) {
    jsonRpcResponse.error = { code: -32603, message: err.message };
    conn.res.write(`event: message\ndata: ${JSON.stringify(jsonRpcResponse)}\n\n`);
    res.status(200).send('OK');
  }
});


// ---- Streamable-HTTP MCP endpoint for the Claude app (token in URL path) ----
// [PC-TOOLS-V1] Which tool CLASSES a role holds. Absent field == every class, so a strain
// that predates this behaves exactly as it did. Cache shaped like mcpStrainAdmit: one
// doc.get() behind a Map with a TTL, last-known-good on error, because this sits on the hot
// path of every MCP request.
const PC_TOOLS_ENFORCE = String(process.env.PC_TOOLS_ENFORCE || '') === '1';
const PC_ALL_CLASSES = ['read', 'write', 'stage', 'infra', 'browser'];
const PC_TOOL_CLASS: any = {
  git_read: 'read',
  git_list: 'read',
  git_log: 'read',
  git_diff: 'read',
  git_propose: 'write',
  git_propose_patch: 'write',
  git_push: 'write',
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
  vm_status: 'read',
  list_my_messages: 'read',
  check_answer: 'read',
  browser_tabs: 'read',
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
  ssh_executor: 'stage',
  gcp_api: 'infra',
  run_roll: 'infra',
  vm_start: 'infra',
  vm_stop: 'infra',
  vm_resize: 'infra',
  browser_open: 'browser',
  browser_navigate: 'browser',
  browser_eval: 'browser',
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

async function buildMcpServer(agentId: string): Promise<any> {
  const server = new McpServer({ name: PC_REPO_ID, version: '1.0.0' });
  // [PC-TOOLS-V1] Shadow registerTool ONCE rather than editing 36 call sites. Every
  // registration below flows through this unchanged.
  const _pcAllowed = new Set(await pcToolClasses(agentId));
  const _pcWithheld: string[] = [];
  const _pcReg = (server as any).registerTool.bind(server);
  (server as any).registerTool = (name: string, spec: any, handler: any) => {
    const klass = PC_TOOL_CLASS[name] || 'other';
    // whoami is the floor: a role that cannot say what it is cannot be debugged, and the
    // denied-server path already treats it that way.
    if (name !== 'whoami' && !_pcAllowed.has(klass)) {
      _pcWithheld.push(name + ':' + klass);
      if (PC_TOOLS_ENFORCE) return undefined;
    }
    return _pcReg(name, spec, handler);
  };
  void (async () => {
    if (!_pcWithheld.length) return;
    try {
      await db.collection('journal').add({
        agent_id: 'mcp_gateway',
        action: PC_TOOLS_ENFORCE ? 'tool_surface_withheld' : 'tool_surface_would_withhold',
        message: (PC_TOOLS_ENFORCE ? 'Withheld ' : 'WOULD have withheld ') + _pcWithheld.length
          + ' tool(s) from ' + agentId + ' (classes held: '
          + Array.from(_pcAllowed).join(',') + '): ' + _pcWithheld.join(' '),
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
  // hypothetical: the first cut of this fell back to fleet-archivist, the one role permitted
  // to stage gated jobs, so a single mistyped character PROMOTED a chat. fleet-drafter found
  // it by mutating one character of its own key.
  // Impersonation is bounded by the key being unguessable and server-minted, NOT by any
  // claim in this file.
  // [RELEASE-ROSTER-V1] v3 ships four strains. The operator's private ones (ads, ghost,
  // seaside, linkedin, avatar, family-budget) are NOT part of an OSS release and must not
  // be baked into anyone else's install. breakglass/handoff are mechanisms, not people.
  const ROLES = new Set(['fleet-archivist','fleet-analyst','fleet-mechanic','fleet-inspector','fleet-drafter','fleet-herald','fleet-librarian','fleet-curator','fleet-breakglass','fleet-engineer','fleet-courier','fleet-handoff']);
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
    { description: 'CALL THIS FIRST, EVERY SESSION, BEFORE ANYTHING ELSE. It delivers the fleet memory digest of what earlier strains already measured, then the bootstrap that says how you work here. Skipping it means re-deriving what the fleet already paid to learn. Return the role you are acting as. Your role is RESOLVED SERVER-SIDE: from the connector bearer, or from a session key you present as the `agent` argument (minted by the operator at the Autoclave, looked up in session_keys). `agent` is a CREDENTIAL, not a role name -- a role name resolves to nothing, and a key that does not resolve is REFUSED, never downgraded to a weaker role or silently upgraded to a stronger one. Once resolved the role is fixed for the request and no tool argument can change it. Privileged execution is still gated by the human secret.', inputSchema: { ...AG } },
    async (a: any) => {
      const role = who(a);
      const c = await ctxBuild();
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
        '================ END ================'
      ].join('\n');
      return { content: [{ type: 'text', text: body }] };
    });

  server.registerTool('list_work_items',
    { description: 'List work items. Optional role/status filters.',
      inputSchema: { role: z.string().optional(), status: z.string().optional(), ...AG } },
    async ({ role, status }: any) => {
      let q: any = db.collection('work_items');
      if (role) q = q.where('assigned_role', '==', role);
      if (status) q = q.where('status', '==', status);
      const snap = await q.limit(50).get();
      return { content: [{ type: 'text', text: JSON.stringify(snap.docs.map((d: any) => d.data()), null, 2) }] };
    });

  server.registerTool('read_journal',
    { description: 'Read recent fleet journal entries.', inputSchema: { limit: z.number().optional(), ...AG } },
    async ({ limit }: any) => {
      const snap = await db.collection('journal').orderBy('timestamp', 'desc').limit(limit || 25).get();
      return { content: [{ type: 'text', text: JSON.stringify(snap.docs.map((d: any) => d.data()), null, 2) }] };
    });

  // ---- MEMORY-V1 -- knowledge-graph memory over Firestore -----------------
  // Spec: shared/state/security-lane/MEMORY-V1-SPEC.md (fleet-mechanic, 2026-08-05)
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
      return 'BOOTSTRAP_EMPTY: ' + CTX_BOOTSTRAP_PATH + ' exists but is empty or truncated. '
        + 'You are operating with NO delivered rules. Tell the operator before you do anything privileged.';
    } catch (e) {
      return 'BOOTSTRAP_MISSING: ' + CTX_BOOTSTRAP_PATH + ' could not be read. '
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
  const CTX_MEM_PINNED = [PC_REPO_ID + '.git', 'pc-git-mcp', 'bootstrap-paste', 'LAWS.md', 'MEMORY-V1'];
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
      if (!ents.length) return '(memory empty)';

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
    { description: 'Create directed edges between entities, in active voice (fleet-mechanic -> staged -> job:QxqG). Idempotent on (from, relationType, to) within a scope.',
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

  // The three delete_* tools RETRACT. No role in this fleet holds a delete tool and
  // versioning is the undo (Law 9.4). Hard deletion is a gated job, never a tool call.
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
    { description: 'Stage a privileged job for human approval. AI proposes; a human commits. It does NOT run until the human confirms with their secret.',
      inputSchema: { command_type: z.string(), command: z.string().optional(), target: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('pending_confirms').doc();
      const jargs: any = {}; if (a.command) jargs.command = a.command; if (a.target) jargs.targetNode = a.target;
      await ref.set({ job_id: ref.id, staged_by: who(a), command_type: a.command_type, arguments: jargs, status: 'pending', created_at: FieldValue.serverTimestamp() });
      await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: `Staged ${a.command_type} (${ref.id}) awaiting human approval.`, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `STAGED job ${ref.id} (${a.command_type}) — awaiting your human confirm; will NOT run until you approve.` }] };
    });

  server.registerTool('list_pending_confirm',
    { description: 'List privileged jobs awaiting human approval.', inputSchema: { ...AG } },
    async () => {
      const snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(50).get();
      return { content: [{ type: 'text', text: JSON.stringify(snap.docs.map((d: any) => d.data()), null, 2) }] };
    });


  server.registerTool('run_command',
    { description: 'Stage a shell command for the executor (GATED). Allowlisted binaries only: echo, gcloud, firebase, npm, node, python3. AI proposes; it does NOT run until the human confirms with their secret.',
      inputSchema: { command: z.string(), ...AG } },
    async (a: any) => {
      const ref = db.collection('pending_confirms').doc();
      await ref.set({ job_id: ref.id, staged_by: who(a), command_type: 'run_cmd', arguments: { command: a.command }, status: 'pending', created_at: FieldValue.serverTimestamp() });
      await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: `Staged run_cmd (${ref.id}): ${a.command}`, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `STAGED run_cmd job ${ref.id} — awaiting your confirm; runs only after you approve.` }] };
    });
  server.registerTool('ssh_executor',
    { description: 'Stage an SSH command on a target node (GATED). AI proposes; it does NOT run until the human confirms with their secret.',
      inputSchema: { target: z.string(), command: z.string(), ...AG } },
    async (a: any) => {
      // [SEC-SSHKEY-NOSTAGE-V1] REFUSE BEFORE STAGING, NOT AFTER THE TAP.
      // gate-exec/exec_server.py's ssh_key_preflight() already refuses an ssh job whose key is
      // unconfigured, and it does so ABOVE claim_job_for_execution(), so the one-shot approval
      // is no longer burned. That fix cannot go far enough on its own and its own comment says
      // so: the executor is only reached POST-APPROVAL, so the refusal still arrives after the
      // operator has spent a Face ID on a job that never had any chance of running. This is the
      // half that belongs here -- the stage itself is the cost, and nothing should stage.
      //
      // SAME VARIABLE NAME AS THE EXECUTOR, DELIBERATELY. EXEC_SSH_KEY_SECRET names the Secret
      // Manager secret holding the private key. It must be set on BOTH services: the executor
      // READS the secret, this service only needs to know WHETHER one is configured. Unset here
      // means refuse, exactly as unset there means refuse -- there is no default and no guess.
      // The name this replaced was a private, operator-specific resource name that reached a
      // public tree, and a name nobody creates is indistinguishable at runtime from a name
      // nobody has permission to read.
      const _sshSecret = String(process.env.EXEC_SSH_KEY_SECRET || '');
      if (_sshSecret === '') {
        return { content: [{ type: 'text', text: 'refused: ssh jobs are not usable on this deployment. '
          + 'EXEC_SSH_KEY_SECRET names no Secret Manager secret, so gate-exec has no private key to '
          + 'run an ssh job with and would refuse this job after you had already approved it. '
          + 'NOTHING WAS STAGED and no approval was requested. To enable ssh: create a secret holding '
          + 'the private key, grant the gate-exec service secretAccessor on THAT SECRET ONLY, and set '
          + 'EXEC_SSH_KEY_SECRET to its name on both the control plane and gate-exec.' }], isError: true };
      }
      const ref = db.collection('pending_confirms').doc();
      await ref.set({ job_id: ref.id, staged_by: who(a), command_type: 'ssh', arguments: { targetNode: a.target, command: a.command }, status: 'pending', created_at: FieldValue.serverTimestamp() });
      await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: `Staged ssh (${ref.id}) on ${a.target}: ${a.command}`, timestamp: FieldValue.serverTimestamp() });
      return { content: [{ type: 'text', text: `STAGED ssh job ${ref.id} on ${a.target} — awaiting your confirm; runs only after you approve.` }] };
    });

  // ---- Chat-history log: per-ROLE, private, searchable (the operator's memory augmentation) ----
  server.registerTool('log_history',
    { description: "Append ONE turn to YOUR ROLE's private searchable history (scoped to your resolved role). role='user' for the operator, role='assistant' for you. This is the operator's memory augmentation; add short topic tags to make it findable. DECISIONS: tag an entry exactly `decision` ONLY when the operator genuinely has to choose something -- it will be put in front of him on every refresh until it is closed. CLOSE one by logging a later entry tagged `resolves:<id>`, id taken from open_decisions in refresh. A topic tag that merely contains the word (gate-exec, open_decisions) does NOT raise a decision.",
      inputSchema: { role: z.string(), text: z.string(), tags: z.array(z.string()).optional(), session: z.string().optional(), ...AG } },
    async (a: any) => {
      const ref = db.collection('chat_history').doc();
      await ref.set({
        id: ref.id, agent_id: who(a), role: a.role, text: a.text,
        tags: a.tags || [], session: a.session || '',
        timestamp: FieldValue.serverTimestamp()
      });
      return { content: [{ type: 'text', text: `logged ${a.role} turn ${ref.id} as ${who(a)}` }] };
    });

  server.registerTool('search_history',
    { description: "Search YOUR ROLE's chat-history (scoped to your resolved role). Case-insensitive substring over text + tags. Empty query = most recent. Use FIRST when the operator references something from before.",
      inputSchema: { query: z.string().optional(), limit: z.number().optional(), role: z.string().optional(), ...AG } },
    async (a: any) => {
      const snap = await db.collection('chat_history').where('agent_id', '==', who(a)).limit(3000).get();
      let rows = snap.docs.map((d: any) => d.data());
      rows.sort((x: any, y: any) => tsMillis(y.timestamp) - tsMillis(x.timestamp));
      if (a.role) rows = rows.filter((r: any) => r.role === a.role);
      if (a.query) {
        const q = String(a.query).toLowerCase();
        rows = rows.filter((r: any) =>
          (r.text || '').toLowerCase().includes(q) ||
          (Array.isArray(r.tags) ? r.tags.join(' ').toLowerCase().includes(q) : false));
      }
      rows = rows.slice(0, a.limit || 20);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    });

  server.registerTool('read_history',
    { description: "Read YOUR ROLE's most recent history in chronological order (scoped to your resolved role) to refresh at session start.",
      inputSchema: { limit: z.number().optional(), ...AG } },
    async (a: any) => {
      const snap = await db.collection('chat_history').where('agent_id', '==', who(a)).limit(3000).get();
      let rows = snap.docs.map((d: any) => d.data());
      rows.sort((x: any, y: any) => tsMillis(x.timestamp) - tsMillis(y.timestamp));
      rows = rows.slice(-(a.limit || 30));
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    });

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
  // and deploy-work-runner.sh cats shared/runner/work_item_runner.py into the bus. So a token-bound
  // role must never be able to WRITE them, or any strain token is RCE as the control plane.
  // READS are deliberately unaffected -- agents review this code, and denying reads would break
  // audit work without closing the hole.
  //
  // FINDING 5.1 -- READ THIS BEFORE YOU EDIT THE LIST. This is ONE boundary with TWO independent
  // implementations: this list, and LAKE_EXEC_PREFIXES in shared/runner/work_item_runner.py.
  // Different languages, different deploy scripts, different schedules; nothing else keeps them in
  // sync. Changing one without the other is a SECURITY REGRESSION (boundary closed on the MCP path,
  // open on the bus path -- exactly the class of bug F1 is). Both files carry the same literal list
  // AND the same canonical digest below, and each refuses to serve if its own list does not hash to
  // it. If you change the list you MUST change both files and recompute the digest in both:
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
      await harWriteLake(r.key!, a.content || '', 'text/plain; charset=utf-8', { owner: me, tags: (a.tags || []).join(',') });
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
      await harWriteLake(r.key!, buf, a.content_type || 'application/octet-stream', { owner: me, tags: (a.tags || []).join(',') });
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

  // ---- Fleet event bus: agent-to-agent messaging + wake triggers (no human relay) ----
  server.registerTool('ask_agent',
    { description: "Ask another fleet role a question with no human relay. Writes to the shared inbox; the target's runner (or its next session) answers. Returns a message id to check_answer.",
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

  // [SEC-CDP-UNCONFIGURED-V1] NO CDP ENDPOINT MEANS NO BROWSER TOOLS.
  // browser_tabs / browser_open / browser_navigate (and browser_eval behind PC_BROWSER_EVAL)
  // all reach the workstation Chrome through harCdp(), which needs a bridge listening on
  // WS_CDP_PORT on a running workstation VM. NOTHING in any installer provisions that bridge
  // and nothing will in v3. Before this guard the tools registered on every install and
  // returned {ok:false,error:'workstation not running'} on first call -- registered, then
  // failed, which is the shape that pulled v3.
  //
  // WS_CDP_PORT IS THE DISCRIMINATOR, and it is the honest one: the port had a default of
  // '8025' that nothing listens on, so the default was a guess dressed as configuration.
  // An explicit WS_CDP_PORT is the only signal a deployer has actually stood a bridge up.
  // This follows the PC_BROWSER_EVAL precedent immediately below: unset == not registered.
  const _cdpPort = String(process.env.WS_CDP_PORT || '');
  if (_cdpPort === '') {
    console.log('[cp] browser tools NOT registered: WS_CDP_PORT unset. browser_tabs, '
      + 'browser_open, browser_navigate' + (String(process.env.PC_BROWSER_EVAL || '') === '1' ? ', browser_eval' : '')
      + ' need a Chrome DevTools Protocol bridge on the workstation VM, which no installer '
      + 'provisions. They are withheld rather than registered to fail on first call. To enable '
      + 'them stand up the bridge, then set WS_CDP_PORT (and CDP_TOKEN) on this service.');
  } else {
  server.registerTool('browser_tabs',
    { description: 'List open tabs in the workstation Chrome (title + url). For browser work PREFER this + browser_eval over screenshot/vision — it is far cheaper and deterministic.', inputSchema: { ...AG } },
    async () => { const j = await harCdp('Target.getTargets', {}); return { content: [{ type: 'text', text: JSON.stringify(j) }] }; });
  server.registerTool('browser_open',
    { description: 'Open a URL in a NEW tab of the workstation Chrome.', inputSchema: { url: z.string(), ...AG } },
    async (a: any) => { const j = await harCdp('Target.createTarget', { params: { url: a.url } }); return { content: [{ type: 'text', text: JSON.stringify(j) }] }; });
  server.registerTool('browser_navigate',
    { description: 'Navigate the active workstation Chrome tab to a URL.', inputSchema: { url: z.string(), ...AG } },
    async (a: any) => { const j = await harCdp('Page.navigate', { params: { url: a.url }, targetId: a.targetId || '' }); return { content: [{ type: 'text', text: JSON.stringify(j) }] }; });
  // PC-CDP-RPC-V1: browser_eval is an ungated mutation primitive against a browser
  // holding the operator's live sessions. It registers ONLY when the deployer opts in.
  // Unset == not registered, which is the OSS default.
  if (String(process.env.PC_BROWSER_EVAL || '') === '1') {
    server.registerTool('browser_eval',
      { description: 'Run JavaScript in the active workstation Chrome tab and return its result. Use for clicking (document.querySelector(sel).click()), reading (el.innerText), filling inputs, and scraping the DOM — prefer this over screenshots/coordinate-clicking.', inputSchema: { js: z.string(), ...AG } },
      async (a: any) => { const j = await harCdp('Runtime.evaluate', { params: { expression: a.js }, targetId: a.targetId || '' }); return { content: [{ type: 'text', text: JSON.stringify(j) }] }; });
  }  // PC-CDP-RPC-V1 end browser_eval guard
  }  // [SEC-CDP-UNCONFIGURED-V1] end WS_CDP_PORT guard
  // [SEC-VM-UNCONFIGURED-V1] NO INSTANCE CONFIGURED MEANS NO VM TOOLS.
  // The VM is a y/n install option that DEFAULTS TO NO, so "unconfigured" is the common case,
  // not the corner. All four tools addressed an instance from DEFAULTS -- WS_VM
  // 'fleet-navigator', WS_ZONE 'us-central1-a' -- that no installer creates:
  //   vm_status   built a Compute REST URL against a project segment that is usually empty
  //               and failed on first call;
  //   vm_start / vm_stop / vm_resize are WORSE. They STAGE a pending_confirms row, so the
  //               operator gets an approval card and spends a Face ID on a gcloud command
  //               naming an instance that does not exist. The cost lands on the human before
  //               anything discovers the instance is absent.
  // BOTH variables are required and neither has a usable default here. A default instance
  // name is a guess, and a guessed name is indistinguishable at runtime from one we cannot
  // see. Unset == withheld, the same contract registerGitTools() uses for GIT_REPO_ID.
  const _wsVm = String(process.env.WS_VM || '');
  const _wsZone = String(process.env.WS_ZONE || '');
  if (_wsVm === '' || _wsZone === '') {
    const _vmAbsent = [_wsVm === '' ? 'WS_VM' : '', _wsZone === '' ? 'WS_ZONE' : '']
      .filter(function (s) { return s !== ''; }).join(' and ');
    console.log('[cp] VM tools NOT registered: ' + _vmAbsent + ' unset. vm_status, vm_start, '
      + 'vm_stop and vm_resize address a Compute instance that this deployment does not '
      + 'declare, and the three staged ones would cost a human approval before failing. They '
      + 'are withheld rather than registered to fail on first call. To enable them create the '
      + 'instance and set WS_VM and WS_ZONE (and GCP_PROJECT) on this service.');
  } else {
  server.registerTool('vm_status',
    { description: 'Status of the workstation browser box (state, machine type, internal IP). Direct Compute REST, no gcloud.', inputSchema: { ...AG } },
    async () => { const s = await harVmStatus(); const mt = await harVmMachine(); const ip = await harBoxInternalIp(); return { content: [{ type: 'text', text: JSON.stringify({ ...s, machineType: mt, internalIp: ip }) }] }; });
  // VERIFY-GREP: VM-GATE-STAGED-V1
  // NEW BUG #1. vm_start / vm_stop / vm_resize used to call the legacy harVmAction/harVmSetType helpers IMMEDIATELY (no call-parens spelled here on purpose -- see ed-vmgate-complete.py: this comment used to trip the vm-ladder forbid checks on the legacy vm helpers):
  // no pending_confirms row, no Face ID, no journal entry. vm_resize even STOPS a running instance as a
  // side effect, so anything holding a connector token could kill the operator's workstation mid-session -- and
  // an advisor started the VM twice against a standing order because the rule existed but the mechanism
  // never did. All three now STAGE to the human gate using the SAME document shape as
  // stage_privileged_job / run_command / run_roll (job_id, staged_by: who(a), command_type,
  // arguments.command, status 'pending', created_at) and return the job id. Nothing touches the VM until
  // The operator approves and gate-exec runs the command AS them. vm_status is a READ and stays direct (above):
  // reads are not gated.
  const HARVM_NAME = process.env.WS_VM || 'fleet-navigator';
  const HARVM_ZONE = process.env.WS_ZONE || 'us-central1-a';
  const HARVM_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
  const HARVM_T = ' ' + HARVM_NAME + ' --zone ' + HARVM_ZONE + ' --project ' + HARVM_PROJECT + ' --quiet';
  const HARVM_DESC = 'gcloud compute instances describe ' + HARVM_NAME + ' --zone ' + HARVM_ZONE + ' --project ' + HARVM_PROJECT + ' --format="value(status,machineType)"';
  // A DISTINCT command_type per action (vm_start / vm_resize / vm_stop), deliberately NOT 'run_cmd':
  // reusing run_cmd drops these into the same supersede bucket as every other staged job, where they
  // silently retire one another. gcloud is on the executor and is allowlisted, and the command is the
  // whole audit record the operator reads on the approval card.
  async function harVmGateStage(a: any, cmdType: string, human: string, cmd: string): Promise<any> {
    const ref = db.collection('pending_confirms').doc();
    await ref.set({ job_id: ref.id, staged_by: who(a), command_type: cmdType, arguments: { command: cmd, vm: HARVM_NAME, zone: HARVM_ZONE, human: human }, status: 'pending', created_at: FieldValue.serverTimestamp() });
    // Journal the ATTEMPT at stage time, so a VM action is visible even when the operator refuses it.
    await db.collection('journal').add({ agent_id: who(a), action: 'stage_job', message: 'Staged ' + cmdType + ' (' + ref.id + ') on ' + HARVM_NAME + ': ' + human + ' -- NOT executed; awaiting the operator approval at the gate.', timestamp: FieldValue.serverTimestamp() });
    return { mode: 'staged', job_id: ref.id, command_type: cmdType, staged_by: who(a), note: 'STAGED: the workstation was NOT touched. The operator approves at the gate, then read the result with read_job_log job_id=' + ref.id };
  }
  server.registerTool('vm_start',
    { description: 'Ask the operator to START the workstation. STAGED to the human gate, never executed here: the standing order is that the advisor never starts the VM -- The operator starts it, and only the operator. Returns { mode: "staged", job_id }; the box is untouched until they approves at the gate, then read the result with read_job_log.', inputSchema: { ...AG } },
    async (a: any) => { const cmd = 'gcloud compute instances start' + HARVM_T + ' || { echo "start failed at the current machine type; retrying at e2-medium"; gcloud compute instances set-machine-type' + HARVM_T + ' --machine-type e2-medium && gcloud compute instances start' + HARVM_T + '; }; ' + HARVM_DESC; const r = await harVmGateStage(a, 'vm_start', 'START ' + HARVM_NAME + ' (falls back to e2-medium if there is no capacity at the current size)', cmd); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('vm_stop',
    { description: 'Ask the operator to STOP the workstation browser box. STAGED to the human gate, never executed here -- stopping the box they may be working in is destructive. Returns { mode: "staged", job_id }; read the result with read_job_log after they approves.', inputSchema: { ...AG } },
    async (a: any) => { const cmd = 'gcloud compute instances stop' + HARVM_T + '; ' + HARVM_DESC; const r = await harVmGateStage(a, 'vm_stop', 'STOP ' + HARVM_NAME, cmd); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('vm_resize',
    { description: 'Ask the operator to set the workstation machine type (e.g. e2-medium, e2-standard-2). STAGED to the human gate, never executed here: a resize STOPS the instance first, so it can kill their session. Returns { mode: "staged", job_id }; read the result with read_job_log after they approves.', inputSchema: { machine_type: z.string(), ...AG } },
    async (a: any) => { const mt = String((a && a.machine_type) || '').trim(); if (mt.length > 40 || !/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(mt)) { return { content: [{ type: 'text', text: JSON.stringify({ error: 'blocked: machine_type must look like e2-medium or e2-standard-2 (lowercase letters, digits and hyphens only) -- got: ' + mt.slice(0, 40) }) }] }; } const cmd = 'gcloud compute instances stop' + HARVM_T + '; gcloud compute instances set-machine-type' + HARVM_T + ' --machine-type ' + mt + '; ' + HARVM_DESC; const r = await harVmGateStage(a, 'vm_resize', 'RESIZE ' + HARVM_NAME + ' to ' + mt + ' (STOPS it first; does NOT start it again)', cmd); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  }  // [SEC-VM-UNCONFIGURED-V1] end WS_VM/WS_ZONE guard
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
    async (a: any) => { try { const me = who(a); const d = await db.collection('pending_confirms').doc(a.job_id).get(); if (!d.exists) { return { content: [{ type: 'text', text: JSON.stringify({ error: 'job not found' }) }] }; } const x: any = d.data(); const OPS = String(process.env.LOG_READ_ALL || 'fleet-archivist').split(',').map((s: string) => s.trim()).filter(Boolean); const isOperator = OPS.indexOf('*') >= 0 || OPS.indexOf(me) >= 0; const stagedBy = String(x.staged_by || ''); if (!isOperator && stagedBy !== me) { console.warn('[cp] F13: ' + me + ' denied read_job_log on ' + a.job_id + ' (staged_by ' + (stagedBy || '(unset)') + ')'); return { content: [{ type: 'text', text: JSON.stringify({ error: 'not your job: ' + a.job_id + ' was staged by another principal. You can read the jobs you staged; ask the operator (or fleet-archivist) for this one.', job_id: a.job_id, staged_by: stagedBy || null, denied: true }) }] }; } const reason = x.fire_refused_reason || x.quarantine_reason || x.exec_failed_reason || x.supersede_note || x.error || null; return { content: [{ type: 'text', text: JSON.stringify({ job_id: a.job_id, status: x.status, ran: x.status === 'executed', exit_code: x.exit_code, ran_as: x.ran_as, staged_by: stagedBy || null, command_type: x.command_type || null, reason: reason, quarantine_reason: x.quarantine_reason || null, quarantined_at: x.quarantined_at || null, fire_refused_reason: x.fire_refused_reason || null, fire_refused_at: x.fire_refused_at || null, supersede_note: x.supersede_note || null, superseded_by_job: x.superseded_by_job || null, superseded_by_role: x.superseded_by_role || null, exec_failed_reason: x.exec_failed_reason || null, exec_http: (typeof x.exec_http === 'number') ? x.exec_http : null, stdout: x.stdout_tail || '', stderr: x.stderr_tail || '' }) }] }; } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ error: String((e && e.message) || e) }) }] }; } });
  server.registerTool('gcp_api',
    { description: 'Call ANY GCP REST endpoint (https://*.googleapis.com) directly — no gcloud, no Cloud Build, no VM. TRUST LADDER: blessed READS (GET on compute/run/storage/logging/monitoring in our project) run instantly as the least-privilege control-plane identity; if it is not permitted it auto-escalates to the gate. EVERYTHING else — any mutation, DELETE, IAM, Secret Manager, a brand-new API — is STAGED to the operator gate and runs AS them on approval (destructive verbs trip a second Face ID). A staged call returns { mode:"staged", job_id }: after the operator approves, read the result with read_job_log. Pass method (GET/POST/PATCH/DELETE...), url (full https), optional body (object), optional reason (why).', inputSchema: { method: z.string(), url: z.string(), body: z.record(z.string(), z.any()).optional(), reason: z.string().optional(), ...AG } },
    async (a: any) => { const r = await harGcpApi(who(a), a.method, a.url, a.body, a.reason || ''); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('run_status',
    { description: 'List Cloud Run services in our project/region (blessed read via control-plane identity; auto-escalates to the gate if not permitted). Optional region (default us-east1, where our services live).', inputSchema: { region: z.string().optional(), ...AG } },
    async (a: any) => { const region = a.region || process.env.GCP_REGION || 'us-east1'; const url = 'https://run.googleapis.com/v2/projects/' + (process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT) + '/locations/' + region + '/services'; const r = await harGcpApi(who(a), 'GET', url, null, 'run_status'); return { content: [{ type: 'text', text: JSON.stringify(r) }] }; });
  server.registerTool('run_roll',
    { description: 'Roll a fresh revision of a Cloud Run service (force a restart / pick up new lake code) by bumping DEPLOY_TS. Deploys are a MUTATION, so this is ALWAYS staged to the operator gate (fast: no Cloud Build) and runs as them on approval. Defaults to THIS control-plane service in us-east1. Optional service, region.', inputSchema: { service: z.string().optional(), region: z.string().optional(), ...AG } },
    async (a: any) => { const service = a.service || process.env.K_SERVICE || 'paracoding-control-plane'; const region = a.region || process.env.GCP_REGION || 'us-east1'; const cmd = 'gcloud run services update ' + service + ' --region ' + region + ' --update-env-vars DEPLOY_TS=$(date +%s) --quiet && echo ROLLED ' + service; const jobId = 'gcp_' + crypto.randomBytes(6).toString('hex'); await db.collection('pending_confirms').doc(jobId).set({ job_id: jobId, command_type: 'run_roll ' + service, staged_by: who(a), arguments: { command: cmd, service, region }, status: 'pending', created_at: FieldValue.serverTimestamp() }); return { content: [{ type: 'text', text: JSON.stringify({ mode: 'staged', job_id: jobId, note: 'Roll of ' + service + ' pending your gate approval.' }) }] }; });
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
  return server;
}

// ============ MCP ADMISSION CONTROL (fleet-mechanic S32 / S34) ============
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
    + 'message another agent. Nothing here reaches the bus. Ask the operator to provision this identity at '
    + 'your gate URL and then reconnect. Do not report work as done from this '
    + 'connection - no tool call you make here has any effect.';
  server.registerTool('whoami',
    { description: 'Return the role you are acting as. This connector is NOT provisioned as a fleet strain and carries no other tools.',
      inputSchema: { agent: z.string().optional() } },
    async () => ({ content: [{ type: 'text', text: msg }] }));
  return server;
}

// The chokepoint. Both MCP mounts call this instead of buildMcpServer directly.
async function buildMcpServerAdmitted(agentId: string): Promise<any> {
  const verdict: any = await mcpStrainAdmit(agentId);
  if (verdict && verdict.ok) return await buildMcpServer(agentId);
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
const WA_GATE_HTML: string = pcHtml('gate.html');
const WA_LOCK_HTML: string = pcHtml('locked.html');
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
  const payload = waB64(Buffer.from(JSON.stringify({ u: WA_USER, pk: (PC_REQUIRE_PASSKEY ? 1 : 0), exp: Date.now() + WA_SESSION_MIN * 60 * 1000 })));
  const sig = crypto.createHmac('sha256', WA_SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
// [SEC-PASSKEY-TOGGLE-V1] IAP identity, consulted ONLY when PC_REQUIRE_PASSKEY=0.
// X-Goog-Authenticated-User-Email is NOT trusted on its own: that header is trivially forged by
// anyone who reaches this service directly if IAP is ever detached from it. The ES256 assertion is
// the real evidence, so it is verified against Google's IAP JWKS. waSessionOk is synchronous, so
// the keys are cached; a cold cache FAILS CLOSED and schedules a refresh rather than admitting an
// unverified caller.
const PC_IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
function pcIapRefreshKeys(): void {
  if (PC_IAP_KEYS && Date.now() - PC_IAP_KEYS_AT < 3600000) return;
  PC_IAP_KEYS_AT = Date.now();
  try {
    (globalThis as any).fetch(PC_IAP_JWKS_URL).then((r: any) => r.json()).then((j: any) => {
      const m: any = {};
      for (const k of (j.keys || [])) m[k.kid] = k;
      PC_IAP_KEYS = m;
    }).catch(() => { });
  } catch (e) { }
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
  // [SEC-PASSKEY-TOGGLE-V1] Passkey off: a verified IAP identity on the approver allow-list is a
  // Google-authenticated human, not an open door. It is still weaker than a passkey and the gate
  // says so on screen.
  if (!PC_REQUIRE_PASSKEY) {
    const em = pcIapEmail(req);
    if (em && WA_APPROVER_EMAILS.length && WA_APPROVER_EMAILS.indexOf(em) >= 0) return true;
  }
  // HFC4 fail-closed: never VERIFY a session when the signing secret is missing/weak (an empty-key
  // HMAC is forgeable). With no strong secret there are no valid sessions — the gate stays locked.
  if (!WA_SESSION_SECRET_OK) return false;
  const c = waCookie(req, 'gate_session'); if (!c || c.indexOf('.') < 0) return false;
  const parts = c.split('.'); const payload = parts[0]; const sig = parts[1];
  const expect = crypto.createHmac('sha256', WA_SESSION_SECRET).update(payload).digest('base64url');
  if (!waEq(sig, expect)) return false;
  // [SEC-PASSKEY-TOGGLE-REVOKE-V1] A session minted while the passkey was OFF must not
  // survive turning it back ON. Without this, disarming for even a few minutes hands out
  // full-length sessions that outlive the policy that permitted them. waElevatedOk below
  // is deliberately NOT changed: elevation is per-job and already needs a fresh assertion.
  try { const sess = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (PC_REQUIRE_PASSKEY && sess.pk !== 1) return false; return sess.exp > Date.now(); } catch (e) { return false; }
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
async function waGoogleEmail(token: string): Promise<string | null> {
  // HFC5 fail-closed: an access token is only evidence of identity TO THE CLIENT IT WAS
  // ISSUED TO. /oauth2/v3/userinfo happily resolves a token minted for any other OAuth
  // client, so trusting it alone lets any relying party the approver has signed into mint
  // a token that passes this gate. Verify the AUDIENCE first, then the address.
  if (!WA_GOOGLE_CLIENT_ID) {
    console.error('[gate] SECURITY: WA_GOOGLE_CLIENT_ID is unset — cannot bind a Google token to this app, god-mode identity DENIED (fail-closed).');
    return null;
  }
  try {
    // [SEC-TOKENINFO-POST] the credential travels in the request BODY, never the URL. A query
    // string is logged by every hop (our egress proxy, Google's front end, any corporate MITM),
    // lands in Referer headers, and survives in shell/process listings. tokeninfo accepts the
    // same parameter form-encoded over POST and returns the identical JSON, so only the
    // transport changed here -- the response handling below is untouched.
    const ti = await waFetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'access_token=' + encodeURIComponent(token) });
    if (!ti || !ti.ok) return null;
    const t: any = await ti.json();
    // aud must be OUR client id. Google returns aud as a string; compare in constant time.
    const aud = String((t && (t.aud || t.audience)) || '');
    if (!aud || !waEq(aud, WA_GOOGLE_CLIENT_ID)) {
      console.error('[gate] SECURITY: god-mode token audience mismatch (aud=' + aud.slice(0, 24) + '...) — DENIED.');
      return null;
    }
    // Google returns email_verified as the string 'true' on this endpoint.
    const verified = String((t && t.email_verified) || '') === 'true' || (t && t.email_verified) === true;
    const email = String((t && t.email) || '').toLowerCase().trim();
    if (!email || !verified) {
      console.error('[gate] SECURITY: god-mode token has no verified email — DENIED.');
      return null;
    }
    return email;
  } catch (e) { return null; }
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
// SPEC AND CROSS-LANGUAGE TEST VECTORS (the verifier must produce byte-identical bytes):
//   shared/state/security-lane/kmssign/CANON-SPEC.md
const PC_APPROVAL_CANON_ID = 'PC-APPROVAL-CANON-V1';
const PC_APPROVAL_SIG_ALG = 'EC_SIGN_P256_SHA256';
// Fixed order. Not sorted at runtime, not derived from Object.keys: a locale-, insertion- or
// engine-dependent order would silently produce different bytes on the two sides.
const PC_APPROVAL_CANON_ORDER: string[] = ['alg', 'jid', 'csha', 'appr', 'kver', 'iat', 'exp'];
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
  const email = gtoken ? await waGoogleEmail(gtoken) : String(iapEmail || '').toLowerCase().trim();
  // HFC3 fail-closed: an EMPTY/unset approver allowlist must DENY god-mode entirely (previously an
  // empty list short-circuited the check and accepted ANY authenticated Google identity). Require a
  // configured allowlist AND a verified identity that is on it.
  if (!WA_APPROVER_EMAILS.length || !email || WA_APPROVER_EMAILS.indexOf(email) < 0) { res.status(403).json({ error: WA_APPROVER_EMAILS.length ? 'Google identity not an authorized approver' : 'god-mode disabled: no approver allowlist configured (set WA_APPROVER_EMAILS)' }); return; }
  const _pcRef = db.collection('pending_confirms').doc(jobId);
  // VERIFY-GREP: GATE-LOG-NOCLOBBER-V1   (fleet-archivist 2026-07-30)
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
  // VERIFY-GREP: GATE-INFLIGHT-NOCLOBBER-V2   (fleet-archivist 2026-07-30)
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
async function waCallExec(scriptB64: string, token: string, jobId: string, assertion: any = null): Promise<any> {
  const idt = await waIdToken(GATE_EXEC_URL);
  const r = await waFetch(GATE_EXEC_URL + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idt },
    // [SEC-ASSERT-FORWARD-V1] gate-exec verifies the operator assertion ITSELF, independently
    // of anything the control plane claims. Forwarding it is what lets PC_REQUIRE_ASSERTION=1.
    body: JSON.stringify({ script_b64: scriptB64, access_token: token, job_id: jobId, assertion: assertion || undefined }),
  });
  const txt = await r.text();
  try { const j = JSON.parse(txt); j.http = r.status; return j; } catch (e) { return { http: r.status, raw: txt }; }
}

// PUBLIC-BY-DESIGN: the human login page itself -- it must render before any session can exist; it serves static HTML and reads no data.
app.get('/gate', (req: express.Request, res: express.Response) => {
  // [SEC-GATE-STAGES-V1] Bare minimum HTML per stage. With no valid session this
  // returns the locked document: unlock, first-time setup, device enrolment. Nothing
  // else. The full gate -- job list, mint panel, approval UI, enrolment-link
  // generator -- is served only past this line, to a caller that holds a session.
  // Anonymous callers used to receive all 111,618 bytes of it. It could not populate,
  // because every data API checks the session, but it was a free map of the system.
  if (!waSessionOk(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(WA_LOCK_HTML);
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // VERIFY-GREP: GATE-NOSTORE-V1   (fleet-archivist 2026-07-30)
  // express res.send() on a string sets ETag and Content-Length and NO Cache-Control, so a
  // browser may reuse a long-lived tab's copy indefinitely. Measured: an operator read
  // 'REFUSED (0): TypeError: Load failed' off a cached document -- a string this source can no
  // longer emit -- and treated a job that HAD RUN as refused. Until this header shipped, every
  // fix made to the gate page was undeliverable to any tab already holding one.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(WA_GATE_HTML.split('__WA_GOOGLE_CLIENT_ID__').join(WA_GOOGLE_CLIENT_ID));
});
// PUBLIC-BY-DESIGN: static HTML shell only, holding no data. Each of its three data calls (/api/dash/summary, /api/dash/usage, /api/dash/gcp) checks waSessionOk and 401s an anonymous caller BEFORE touching Firestore or BigQuery.
app.get('/dash', (req: express.Request, res: express.Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // VERIFY-GREP: GATE-NOSTORE-V1   (same reasoning as /gate above; same failure mode)
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
  res.json({ registered: creds.length > 0, setupEnabled: !!WA_BOOTSTRAP_SECRET, sessionMin: WA_SESSION_MIN, iap: (!!PC_IAP_AUD && !!pcIapEmail(req)) });
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
app.get('/api/dash/gcp', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  let table = '';
  try { table = await waBqBillingTable(); }
  catch (e: any) { res.json({ enabled: true, pending: true, note: 'cannot list billing dataset — check control-plane-sa BigQuery IAM' }); return; }
  if (!table) { res.json({ enabled: true, pending: true, note: 'billing export table not created yet (first data within ~a day)' }); return; }
  const sql = 'SELECT service.description AS svc, ROUND(SUM(cost),2) AS cost FROM `' + GCP_PROJECT + '.' + GCP_BILLING_DATASET + '.' + table + '` WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) GROUP BY svc ORDER BY cost DESC LIMIT 25';
  let q: any;
  try { q = await waBqQuery(sql); } catch (e: any) { res.json({ enabled: true, pending: true, note: 'query error' }); return; }
  if (q.error || (q.errors && q.errors.length)) { res.json((console.error('[gate] BigQuery error withheld from client:', q.error || q.errors), { enabled: true, pending: true, note: 'billing query failed' })); return; }
  const rows = (q.rows || []).map((r: any) => ({ svc: (r.f[0] && r.f[0].v) || '?', cost: parseFloat((r.f[1] && r.f[1].v) || '0') || 0 }));
  const total = rows.reduce((a: number, x: any) => a + x.cost, 0);
  res.json({ enabled: true, pending: false, table, total: Math.round(total * 100) / 100, services: rows });
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
  res.json({ token: tok, url: (WA_RP_ORIGINS[0] || WA_RP_ORIGIN_RAW) + '/gate?enroll=' + tok, ttl_min: ttlMin });
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
app.get('/api/webauthn/pending', waSafe(async (req, res) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const snap = await db.collection('pending_confirms').where('status', '==', 'pending').limit(100).get();
  const nowMs = Date.now(); const ttlMs = WA_JOB_TTL_MIN * 60000; const cand: any[] = [];
  for (const d of snap.docs) { const x: any = d.data();
    const ts = (x.created_at && x.created_at._seconds) ? x.created_at._seconds * 1000 : (x.created_at && x.created_at.toMillis ? x.created_at.toMillis() : 0);
    if (ts && (nowMs - ts) > ttlMs) { try { await d.ref.update({ status: 'expired', expired_at: FieldValue.serverTimestamp() }); try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'job_expired', message: 'EXPIRED AND NEVER RAN: job ' + String(x.job_id || '') + ' [' + String(x.command_type || '') + '] staged by ' + String(x.staged_by || '') + ', past its time-to-live.', timestamp: FieldValue.serverTimestamp() }); } catch (e2) {} } catch (e) {} continue; }
    cand.push({ ref: d.ref, job_id: x.job_id, command_type: x.command_type, staged_by: x.staged_by, arguments: x.arguments, workstream: x.workstream || '', ts: ts, age_min: ts ? Math.round((nowMs - ts) / 60000) : null });
  }
  const newest: any = {};
  for (const j of cand) { if (!j.ts) continue; const k = (j.staged_by || '') + '|' + (j.command_type || ''); if (!newest[k] || j.ts > newest[k].ts) newest[k] = j; }
  const outJobs: any[] = [];
  for (const j of cand) { const k = (j.staged_by || '') + '|' + (j.command_type || ''); if (j.ts && newest[k] && newest[k].job_id !== j.job_id) { try { await j.ref.update({ status: 'superseded', superseded_at: FieldValue.serverTimestamp() }); try { await db.collection('journal').add({ agent_id: 'human_operator', action: 'job_superseded', message: 'SUPERSEDED AND NEVER RAN: job ' + j.job_id + ' [' + String(j.command_type || '') + '] staged by ' + String(j.staged_by || '') + '. A newer job with the same staged_by|command_type key replaced it. If that newer job came from a different chat, this work was discarded without anyone asking.', timestamp: FieldValue.serverTimestamp() }); } catch (e2) {} } catch (e) {} continue; } outJobs.push({ job_id: j.job_id, command_type: j.command_type, staged_by: j.staged_by, arguments: j.arguments, age_min: j.age_min, workstream: waWorkstreamOf(j) }); }
  const _provSnap: any = await db.collection('strains').where('status', '==', 'active').get().catch(() => null);
  const _prov: any = {}; if (_provSnap && _provSnap.docs) _provSnap.docs.forEach((d: any) => { _prov[d.id] = true; });
  if (!_provSnap || !_provSnap.docs || Object.keys(_prov).length === 0) { try { console.error('[gate] SECURITY S24: strains registry read empty or failed - identity filter SKIPPED this request. Nothing quarantined. The approve path refuses a non-provisioned identity independently.'); } catch (e) {} res.json(outJobs); return; }
  const _banned3: any = { 'fleet-editor': 1, 'fleet-builder': 1 };
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
    } catch (e) {}
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
  if (action === 'deny') { await waLegacyApply(jobId, 'deny'); res.json({ ok: true, jobId, action: 'deny' }); return; }
  // [FAIL-CLOSED IDENTITY] refuse approval of any job whose staged_by is not an active provisioned strain.
  {
    const _qd = await db.collection('pending_confirms').doc(jobId).get();
    const _sb = _qd.exists ? String((_qd.data() as any).staged_by || '') : '';
    const _banned: any = { 'fleet-editor': 1, 'fleet-builder': 1, '': 1, 'unknown': 1 };
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
  // [SEC-ASSERT-EVERY-V1] Every approval takes a tap, not just the ones a text classifier
    // calls dangerous. The classifier is a heuristic over command TEXT; a job it does not
    // recognise still runs as the operator. danger is kept for MESSAGING only below.
    if (PC_REQUIRE_PASSKEY && !waElevatedForJob(req, jobId, command)) {
    if (!(req.body && req.body.dangerConfirmed) || !req.body.response) { res.status(428).json({ danger: true, needFaceID: true, command }); return; }
    const expectedChallenge = waCookie(req, 'wa_confirm');
    if (!expectedChallenge) { res.status(428).json({ danger: true, needFaceID: true, command, error: 'need fresh Face ID' }); return; }
    const raw = Buffer.from(expectedChallenge, 'base64url');
    if (raw.length < 32 || !waEq(raw.subarray(raw.length - 32), waSha(jobId + '|' + action))) { res.status(400).json({ error: 'binding mismatch' }); return; }
    const ok = await waVerifyAssertion(req.body.response, expectedChallenge);
    res.clearCookie('wa_confirm', { path: '/' });
    if (!ok) { res.status(400).json({ error: 'Face ID not verified' }); return; }
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
          const _canon = pcApprovalCanonV1({
            alg: PC_APPROVAL_SIG_ALG, jid: String(jobId), csha: _cmdSha, appr: _appr,
            kver: PC_APPROVAL_SIG_KEY, iat: _iat, exp: _exp });
          _stamp.approval_sig = await pcApprovalSign(_canon);
          _stamp.approval_sig_v = 3;
          // Every field that entered the signed bytes is also stored, because the verifier
          // REBUILDS the canonical bytes from these and never parses the signed blob. It must
          // take jid and csha from the job it is about to run, NOT from this document.
          _stamp.approval_sig_canon = PC_APPROVAL_CANON_ID;
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
  // VERIFY-GREP: PREAPPROVE-STATUS-PRECONDITION-V1   (fleet-archivist 2026-07-30)
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
  // VERIFY-GREP: PREAPPROVE-IDENTITY-DANGER-V1   (fleet-mechanic 2026-07-30)
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
    const _iaBanned: any = { 'fleet-editor': 1, 'fleet-builder': 1, '': 1, 'unknown': 1 };
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
  await db.collection('pending_confirms').doc(jobId).update({
    status: 'preapproved', preapproved_by: email, preapproved_at: FieldValue.serverTimestamp(),
    cmd_sha: cmdSha, expiry, single_use: true, run_token: runToken,
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
    // VERIFY-GREP: FIRE-STATUS-REVERT-V1  (AUTH FIRST -- fleet-archivist 2026-07-30)
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
    // VERIFY-GREP: FIRE-STATUS-REVERT-V1  (SCOPED REVERT -- fleet-archivist 2026-07-30)
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
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  await ref.update({ status: 'superseded', superseded_by_job: supersededBy, supersede_note: note, superseded_by_role: role, superseded_at: FieldValue.serverTimestamp() });
  await db.collection('journal').add({ agent_id: role, action: 'superseded', message: 'Superseded staged job ' + jobId + (supersededBy ? (' (superseded_by ' + supersededBy + ')') : '') + (note ? (': ' + note) : ''), timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, job_id: jobId, status: 'superseded', by: role });
}));
// =============== end passkey + god-mode gate + dashboard + cost ===============


// PUBLIC-BY-DESIGN: bare host-based redirect to /gate or /harness. It reads no data, holds no secret and issues no session; each destination does its own gating. Not enumerated in the harness app.use session gate below, so it is genuinely pre-credential.
app.get('/', (req: any, res: any) => {
  // [LAND-ON-GATE-V1] 2026-08-01. This read req.headers.host and sent anything that was not
  // autoclave.* to /harness. That hostname was retired on 2026-08-01, so the gate branch
  // could never be taken and every visitor -- typing the gate hostname -- landed on the Flow
  // Hood, which opens a chat, and then had to navigate to the gate: the one page actually
  // waiting on them. A host check that outlived its hostname, exactly like the front door
  // that caused the outage. The gate is the page that needs a human; everything else is one
  // tap away on its nav. Deleted rather than repaired -- nothing left to distinguish.
  res.redirect('/gate');
});
// ================= PARACODING AGENTIC HARNESS (harness + chat + VM control) — ADDITIVE =================
// SECURITY (H1): every route below is GATED behind an unlocked passkey session (waGate). There is NO
// unauthenticated path: a fresh clone is closed by default and unauthenticated requests get 403.
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const p = req.path;
  const isHarness = p === '/chat' || p.startsWith('/api/shell') || p === '/api/chat' || p.startsWith('/api/keys') || p.startsWith('/api/vm/') || p.startsWith('/api/ops/') || p.startsWith('/api/security/');
  if (isHarness) {
    if (!waSessionOk(req)) {
      if (p === '/chat') { res.redirect('/gate'); return; }
      res.status(403).json({ error: 'forbidden: unlock the gate first (passkey session required)' }); return;
    }
  }
  next();
});

const HAR_HARNESS_HTML: string = pcHtml('harness.html');
// [SEC-DEBLOB-V1] The chat document constant is gone: it decoded byte-identical to the harness document, so both routes now serve one file, harness.html, through one constant.
const WS_VM = process.env.WS_VM || 'fleet-navigator';
const WS_ZONE = process.env.WS_ZONE || 'us-central1-a';
const HAR_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
// ops-exec fast-shell: token that authenticates the control-plane -> on-box ops-exec (:8022).
// Same value lives in the box's `ops-token` instance metadata. Passed as OPS_TOKEN env at deploy.
const OPS_TOKEN = process.env.OPS_TOKEN || '';
// PC-CDP-RPC-V1: the CDP bridge has its OWN secret, separate from the ops token.
// [SEC-CDP-SPLIT-V1] put it in Secret Manager as pc-cdp-token and the bridge reads
// it from /opt/cdp-token and matches it against the X-Cdp-Token header ONLY. An ops
// token presented to :8025 is refused, and this token does NOT buy bash -lc as root
// on the box. Mounted into Cloud Run as CDP_TOKEN=pc-cdp-token:latest by the
// workstation installer. Empty string == the bridge refuses every call, which is
// the correct behaviour for a deploy that never enabled the workstation.
const CDP_TOKEN = process.env.CDP_TOKEN || '';
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
function harModelEntry(api: string): any {
  const a = String(api || '');
  return { id: a, label: harModelLabel(a), sub: '', api: a };
}
function harModelList(apis: string[], floor: string): any[] {
  const seen: any = {}; const out: any[] = [];
  for (const a of apis) { const s = String(a || '').trim(); if (!s || seen[s]) continue; seen[s] = 1; out.push(harModelEntry(s)); }
  return out.length ? out : [harModelEntry(floor)];
}
const HAR_MODELS_DEFAULT = {
  claude: harModelList([process.env.CHAT_API_OPUS || '', process.env.CHAT_API_SONNET || ''], 'claude-sonnet-5'),
  gemini: harModelList([process.env.CHAT_API_GPRO || ''], 'gemini-3.1-pro-preview'),
};
function harModels(): any { try { return process.env.CHAT_MODELS ? JSON.parse(process.env.CHAT_MODELS) : HAR_MODELS_DEFAULT; } catch (e) { return HAR_MODELS_DEFAULT; } }
function harApiFor(provider: string, id: string): string {
  const m = harModels()[provider] || []; const hit = m.find((x: any) => x.id === id); return (hit && hit.api) || (m[0] && m[0].api) || '';
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
async function harSecretSet(name: string, value: string): Promise<boolean> {
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
  return !!(r && r.ok);
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

// ---- Compute Engine REST (start/stop/status of the workstation) ----
async function harVmInstance(): Promise<any> {
  const tok = await waAccessToken();
  const r = await waFetch('https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/zones/' + WS_ZONE + '/instances/' + WS_VM, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r) return { _http: 0 };
  if (!r.ok) return { _http: r.status };
  const j: any = await r.json(); j._http = 200; return j;
}
async function harVmStatus(): Promise<any> {
  const j = await harVmInstance();
  if (j._http === 404) return { provisioned: false, state: 'NOT_FOUND' };
  if (j._http !== 200) return { provisioned: !!j._http, state: 'UNKNOWN', http: j._http };
  return { provisioned: true, state: j.status || 'UNKNOWN' };
}
async function harVmAction(action: string): Promise<any> {
  const tok = await waAccessToken();
  const r = await waFetch('https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/zones/' + WS_ZONE + '/instances/' + WS_VM + '/' + action, {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}',
  });
  const j: any = await r.json().catch(() => ({}));
  return { ok: !!(r && r.ok), http: r && r.status, op: j && j.name };
}
// resolve the box's internal (RFC1918) IP so the control-plane can reach ops-exec over the VPC connector
async function harBoxInternalIp(): Promise<string> {
  const j = await harVmInstance();
  if (j._http !== 200) return '';
  try { return (j.networkInterfaces && j.networkInterfaces[0] && j.networkInterfaces[0].networkIP) || ''; } catch (e) { return ''; }
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

// ============ OPS CONSOLE TOOLS (advisor 2026-07-25): status_digest / dispatch / check ============
// v6 (operator ruling 2026-07-25): EVERY STRAIN gets the console, scoped to its own lane. The advisor keeps the
// fleet-wide view; a strain sees its own desk. NO CLAUDE BUS: dispatch can only create Gemini work
// (Vertex -> GCP billing). Claude work happens in a Claude surface you are already sitting in --
// this console (per-message on the card) or a Cowork chat (flat-rate Max). New tool: cowork_prompt,
// which hands you the paste-ready bootstrap for a strain so you can port the work to Cowork.
// Deterministic server code; the model only ever sees the compact summary a tool returns.
const HAR_CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 4096);
const HAR_CHAT_EFFORT = String(process.env.CHAT_EFFORT || 'xhigh');
const HAR_BUS_SUBSTRATE = String(process.env.BUS_SUBSTRATE || 'gemini');

const HAR_LAW_BUS = [
  'BUS LAW (operator ruling 2026-07-25, firm): the bus is GEMINI ONLY. Gemini runs on Vertex and bills GCP.',
  'There is NO Claude bus. The Claude bus was auto-escalating stalled Gemini work onto Opus 4.8 on the operator\'s',
  'personal card -- that single path was ~96% of his API spend. It is off: the sweeper tick is paused and',
  'config/models.work_provider=gemini. If Gemini cannot do a piece of work, it PARKS (status needs_claude /',
  'needs_cowork / needs_supervisor) and a Claude surface picks it up -- either this console (per message, on',
  'the card, cheap) or a Cowork chat on the Max plan (flat rate). NEVER dispatch Claude work to the bus and',
  'never tell the operator you have; the tool will refuse you.',
].join(' ');

const HAR_LAW_SURFACES = [
  'TWO CLAUDE SURFACES, SAME WORK, DIFFERENT WALLET. (1) THIS console: Opus 4.8 per message against the operator\'s',
  'card, ~25-35c a message -- good for phone, quick checks, aiming the bus. (2) COWORK on Max: flat rate,',
  'disposable containers, full source + deploy access via the gate -- that is where heavy building happens.',
  'Use cowork_prompt to hand the operator a paste-ready bootstrap when work belongs over there.',
].join(' ');

const HAR_OPS_SYSTEM = [
  'You are the operator\'s mission-control advisor for Paracoding.AI (Agentic Fungi) -- their autonomous GCP agent fleet.',
  'GROUND TRUTH FIRST -- read before you claim. Caching is LIVE (journal: cfg cache=on, cache_read hits). Your brain is claude-opus-4.8. read_lake("shared/state/advisor-state.md") is your authoritative memory; read_lake("shared/state/oss-launch-critical-path.md") is the ordered launch list; read_journal shows live runs. Never guess; never call something broken without reading it.',
  'YOUR TOOLS -- read: status_digest, read_journal, read_lake (shared/... + agents/fleet-archivist/...), list_work_items (returns ids), read_job_log, cowork_prompt. Clean: cancel_work_item / complete_work_item (bookkeeping -- do it directly for junk or finished items, it is yours). Dispatch: create Gemini bus work for any strain.',
  HAR_LAW_BUS,
  HAR_LAW_SURFACES,
  'Editing the app itself -- the harness UI, deploys, caching, model/env config -- is NOT yours; those are done by the operator\'s Cowork advisor (their other Claude with source + deploy access) and approved at the gate. If the operator asks for one, say so plainly and offer cowork_prompt; do not pretend you can do it here.',
  'Be concise and decisive; offer ONLY options you can actually carry out; if a real error comes back, report it plainly -- do not retry-rephrase to sneak past a guard.',
].join('\n');

function harStrainSystem(agentId: string): string {
  return [
    'You are ' + agentId + ', a strain in the operator\'s Paracoding.AI fleet (public brand: Agentic Fungi). You own ONE lane -- your own -- not the whole fleet. The operator is talking to you in the Flowhood console.',
    'GROUND TRUTH FIRST. Before you claim anything about your work, check it: status_digest shows your lane, read_journal shows what actually ran, list_work_items shows your queue with ids. Never guess.',
    'YOUR GEMINI TWIN IS YOUR HANDS. dispatch creates a bus work item assigned to YOU. The work-runner then runs it AS ' + agentId + ' -- with your credentials, your private folder (agents/' + agentId + '/), your LESSONS. So: you think and judge here; your twin does the labour on the bus. Use check and list_work_items to see what it produced, then read_lake it and judge it.',
    'YOUR SCOPE -- read_lake: shared/... and agents/' + agentId + '/... only. list_work_items / check / cancel / complete: YOUR items only. status_digest: your lane. You cannot see or touch another strain\'s desk; ask the operator to take it to the advisor if it is fleet-wide.',
    HAR_LAW_BUS,
    HAR_LAW_SURFACES,
    'You cannot edit the app, deploy, or change config from here -- that is the operator\'s Cowork advisor. If a job needs source or deploy access, say so and offer cowork_prompt so the operator can port it.',
    'Be concise, decisive and honest. Offer only what you can actually do. Report what you actually did, with the item id or the journal line as evidence.',
  ].join('\n');
}

function harOpsSystem(agentId: string): string {
  return agentId === 'fleet-archivist' ? HAR_OPS_SYSTEM : harStrainSystem(agentId);
}

function harToolDefs(agentId: string): any[] {
  const boss = agentId === 'fleet-archivist';
  const mine = boss ? 'any strain' : 'you (' + agentId + ')';
  return [
    { name: 'status_digest', description: boss ? 'Live FLEET overview: every strain, what each is doing, backlog counts, gate jobs, recent events. Use for "where are we / report / refresh".' : 'Your lane: what you are working on, your queue, your recent runs, anything of yours parked for a human.', input_schema: { type: 'object', properties: {} } },
    { name: 'dispatch', description: 'Create a GEMINI bus work item for ' + mine + ' to do real work (research, drafting, file edits, bulk changes). Runs on the next ~5-min tick, as that strain, billed to GCP. The bus is Gemini-only -- there is no Claude route.', input_schema: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, strain: { type: 'string', description: boss ? 'target strain, defaults fleet-engineer' : 'ignored -- always you' } }, required: ['title'] } },
    { name: 'check', description: 'Status of recent bus items for ' + mine + ' -- what the twin picked up, finished, blocked or parked.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_journal', description: 'Recent fleet journal entries (work runs, cache numbers, gate events). VERIFY here before claiming anything.', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'read_lake', description: 'Read a lake file for ground truth. Allowed: shared/... and agents/' + agentId + '/... .', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_work_items', description: 'List work items WITH ids for ' + mine + '. status defaults pending; use "all" for any, or needs_claude / needs_cowork / needs_supervisor to see parked work.', input_schema: { type: 'object', properties: { status: { type: 'string' }, role: { type: 'string' } } } },
    { name: 'cancel_work_item', description: 'Cancel a work item by id (bookkeeping). Junk or obsolete items.', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'complete_work_item', description: 'Mark a work item completed by id (bookkeeping).', input_schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'read_job_log', description: 'Read the result (status/exit/stdout/stderr) of a gate job by job_id.', input_schema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] } },
    { name: 'cowork_prompt', description: 'Hand the operator a paste-ready bootstrap prompt to continue this work in a fresh Cowork chat on their Max plan (flat rate, full source + deploy access). Use when a job needs building, deploying, or heavy iteration -- or when they asks how to port it.', input_schema: { type: 'object', properties: { strain: { type: 'string', description: 'strain to bootstrap; defaults to ' + agentId }, task: { type: 'string', description: 'one line: what they should have it do first' } } } },
  ];
}
function harOpsTools(agentId: string): any[] { return harToolDefs(agentId); }

function harJournalAs(agentId: string, action: string, message: string) { try { db.collection('journal').add({ agent_id: agentId || 'fleet-archivist', action: action, message: String(message).slice(0, 900), timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
function harJournal(action: string, message: string) { harJournalAs('fleet-archivist', action, message); }

const HAR_PARKED = ['needs_claude', 'needs_cowork', 'needs_supervisor'];

async function harStatusDigest(agentId: string): Promise<string> {
  const boss = agentId === 'fleet-archivist';
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
    lines.push('BUS: gemini-only (Vertex/GCP billing). Sweeper tick PAUSED -- stalled work parks, it does not escalate to Claude.');
    lines.push(''); lines.push('STRAINS:');
    active.slice(0, 12).forEach((a: any) => { const age = a.last_ts ? Math.round((now - a.last_ts) / 60000) : 9999; const st = (a.in_progress > 0 && age < 6) ? 'working' : (a.backlog > 0 ? 'queued' : 'idle'); lines.push('  ' + a.agent + '  [' + st + ']  ' + a.in_progress + ' active / ' + a.backlog + ' queued  -- last ' + age + 'm ago: ' + a.last_action); });
    if (gateN) { lines.push(''); lines.push('AWAITING APPROVAL AT THE GATE:'); gate.forEach((g) => lines.push(g)); }
  } else {
    const me = agents[agentId] || { last_ts: 0, last_action: '(nothing yet)' };
    const age = me.last_ts ? Math.round((now - me.last_ts) / 60000) : 9999;
    lines.push('YOUR LANE (' + agentId + ')  --  ' + pend + ' queued, ' + inprog + ' running now, ' + parked + ' parked waiting on a human');
    lines.push('BUS: gemini-only. Your twin runs your items as you, on GCP billing.');
    lines.push('LAST ACTIVITY: ' + (me.last_ts ? age + 'm ago -- ' + me.last_action : 'none in the recent journal'));
  }
  lines.push(''); lines.push('RECENT:'); feed.slice(0, 10).forEach((f) => lines.push(f));
  if (!feed.length) lines.push('  (nothing recent)');
  return lines.join('\n').slice(0, 6000);
}

async function harDispatch(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-archivist';
  const title = String((input && input.title) || '').trim();
  if (!title) return 'dispatch failed: a title is required.';
  const detail = String((input && input.detail) || '');
  let strain = agentId;
  if (boss) {
    strain = String((input && input.strain) || 'fleet-engineer').trim().toLowerCase();
    if (strain && strain.indexOf('fleet-') !== 0) strain = 'fleet-' + strain;
    if (!strain) strain = 'fleet-engineer';
  }
  const asked = String((input && input.route) || '').toLowerCase();
  if (asked === 'claude') {
    return 'REFUSED: there is no Claude bus. The operator disabled it on 2026-07-25 -- auto-escalation to Opus 4.8 was ~96% of their API spend. Dispatch it as Gemini, or if it genuinely needs Claude judgement do it HERE in this console, or call cowork_prompt and hand them a bootstrap for a Cowork chat on Max.';
  }
  try {
    const ref = db.collection('work_items').doc();
    await ref.set({ id: ref.id, title, assigned_role: strain, substrate: HAR_BUS_SUBSTRATE, status: 'pending', source: 'ops-chat', dispatched_by: agentId, payload: { detail, source: 'ops-chat' }, created_at: FieldValue.serverTimestamp() });
    harJournalAs(agentId, 'ops_dispatch', 'dispatched "' + title.slice(0, 90) + '" -> ' + strain + ' on ' + HAR_BUS_SUBSTRATE + ' (' + ref.id + ')');
    return 'Dispatched: "' + title + '" -> ' + strain + ' on ' + HAR_BUS_SUBSTRATE + ' (item ' + ref.id + ', pending). Runs on the next ~5-min tick, as ' + strain + ', billed to GCP.';
  } catch (e: any) { return 'dispatch failed: ' + String((e && e.message) || e); }
}

async function harCheck(input: any, agentId: string): Promise<string> {
  const boss = agentId === 'fleet-archivist';
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
    if (!rows.length) return boss ? 'Nothing dispatched from this console yet.' : 'No bus items for ' + agentId + ' yet. Use dispatch to give your twin something.';
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
  const boss = agentId === 'fleet-archivist';
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
  if (agentId === 'fleet-archivist') return true;
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

// Hand the operator a paste-ready Cowork bootstrap. Source of truth = shared/state/cowork-bootstrap-prompts.md.
async function harCoworkPromptTool(input: any, agentId: string): Promise<string> {
  let strain = String((input && input.strain) || agentId || 'fleet-archivist').trim().toLowerCase();
  if (strain && strain.indexOf('fleet-') !== 0) strain = 'fleet-' + strain;
  const task = String((input && input.task) || '').trim();
  const advisor = (strain === 'fleet-archivist');
  let doc = '';
  try { doc = await harReadLake('shared/state/cowork-bootstrap-prompts.md'); } catch (e) { doc = ''; }
  if (doc) {
    const A = doc.indexOf('## PROMPT 1');
    const Bm = doc.indexOf('## PROMPT 2');
    if (A >= 0 && Bm > A) {
      let body = advisor ? doc.slice(A, Bm) : doc.slice(Bm);
      body = body.replace(/<ROLE>/g, strain);
      body = task ? body.replace(/<TASK[^>]*>/g, task) : body.replace(/<TASK[^>]*>/g, 'Ask the operator what they wants first, then read the relevant lake files before touching anything.');
      const head = 'PASTE THIS INTO A FRESH COWORK CHAT (attach the Paracoding.AI connector FIRST -- the connector is the identity).\nThat chat runs on the operator\'s Max plan: flat rate, full source + deploy access via the gate.\n\n----- COPY BELOW -----\n';
      return (head + body.trim() + '\n----- COPY ABOVE -----').slice(0, 11000);
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
    'DO FIRST: whoami. read_file shared/fleet/LAWS.md. read_file shared/state/advisor-state.md.' + (advisor ? ' read_file shared/state/oss-launch-critical-path.md.' : ' read_file agents/' + strain + '/LESSONS.md.') + ' read_journal(limit 30). Verify from the journal - never claim fleet state from memory.',
    '',
    'DOCTRINE: STAGE, NEVER SHIP - propose with stage_privileged_job, the operator approves with their passkey. SUPERSEDE IS AUTOMATIC AND FIRES ON EVERY LOAD OF THE GATE PENDING LIST, not on approval: among pending jobs sharing one staged_by|command_type key only the NEWEST survives and the others are marked superseded and never run. Distinct command_types coexist, but run_command always stages command_type run_cmd, so you get ONE live run_command per role. Every staged job: anchor-assert inputs, syntax-gate before deploy, back up what it changes, auto-rollback on failure, stream its log to shared/state/<job>.log - the gate executor has a ~3-4 min HARD timeout and a killed job returns EMPTY stdout.',
    '',
    'BUS LAW: the bus is GEMINI ONLY (Vertex, GCP-billed). There is no Claude bus. Work Gemini cannot do parks and comes back to a Claude surface.',
    '',
    'TRAPS: the container is ephemeral - the lake is the only durable memory. MCP read_file PREPENDS a banner line + blank line NOT in the stored object; strip both on any read-then-write. fleet-work-runner does NOT hot-load. deploy-cp-harness.sh is RETIRED (exit 1): the control plane is built from the git STORE (Firestore repos/<repoId>/refs + lake <repoId>/.git/objects/), reached with the git_* tools - git_push onto memory-v1, then a staged deploy-store.py --commit <oid> --tag <tag>.',
    '',
    'YOUR ASSIGNMENT: ' + (task || 'Ask the operator what they wants first.'),
    '',
    'TONE: direct, senior, no padding. Own mistakes plainly. Verify before you claim.',
    '----- COPY ABOVE -----',
  ].join('\n');
  return fb;
}

// KEY-FREE PATH (operator ruling 2026-07-25): the Cowork bootstrap is deterministic server code, NOT a model
// call. This route works with NO Anthropic key at all -- which is the OSS free story: install the
// core on your own GCP + Gmail, run the Gemini bus, clone strains, and pull the paste-ready prompt
// here to do the Claude half on whatever plan you already have (free, $20, or Max). The in-Flowhood
// Claude console is the part that needs a key; everything else degrades gracefully without one.
// [SEC-ROUTE-VISIBILITY-V1] NO try/catch AROUND THIS REGISTRATION, AND IT STAYS AT COLUMN ZERO.
// The wrapper that used to sit here said the block "sits early in the bundle, so waGate/app may
// not be initialised". MEASURED FALSE: app is `const app = express()` at line 93, and waGate,
// harFail and harCoworkPromptTool are all hoisted function declarations. The catch could never
// fire for the reason it gave. What it COULD swallow is the PC_SURFACE registrar's deliberate
// throw for a path missing from PC_SURFACE_MAP -- converting a route stranded on BOTH services
// into a silent one, which is the precise failure that throw exists to make impossible.
// The indentation was the worse half: route-audit.mjs anchors at column zero, so this
// registration was invisible to it and this handler was NEVER searched for a guard. The waGate
// below could have been deleted and the audit would have reported nothing.
app.get('/api/cowork-prompt', waGate(async (req: any, res: any) => {
  try {
    const strain = String((req.query && req.query.strain) || 'fleet-archivist');
    const task = String((req.query && req.query.task) || '');
    const txt = await harCoworkPromptTool({ strain: strain, task: task }, strain);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(txt);
  } catch (e: any) { harFail(res, e, 'harness'); }
}));

async function harRunChatTool(name: string, input: any, agentId: string): Promise<string> {
  const who = agentId || 'fleet-archivist';
  if (name === 'status_digest') return await harStatusDigest(who);
  if (name === 'dispatch') return await harDispatch(input || {}, who);
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

// tool-capable Claude chat: 1h cache + effort + bounded tool loop.
async function harChatClaudeOps(apiModel: string, key: string, system: string, msgs: any[], tools: any[], agentId: string): Promise<{ text: string; usage: any }> {
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
    return JSON.stringify(body);
  };
  const post = async (withTtl: boolean, withEffort: boolean) => { const rr = await waFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: buildBody(withTtl, withEffort) }); const jj: any = await rr.json(); return { r: rr, j: jj }; };
  let withTtl = true; let withEffort = true; let guard = 0; let finalText = '';
  // [HARNESSUI-MODEL-DERIVE-V1] what was ACTUALLY served. j.model is the provider's own
  // answer, and effortApplied tracks the withEffort fallback above -- when output_config is
  // dropped on a retry the request really did run at the default, and the badge must say so.
  let apiModelSeen = apiModel;
  let effortApplied = (HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
  while (guard++ < 8) {
    let { r, j } = await post(withTtl, withEffort);
    if (!r.ok) {
      const eb = JSON.stringify(j); let changed = false;
      if (withEffort && (eb.indexOf('effort') >= 0 || eb.indexOf('output_config') >= 0)) { withEffort = false; changed = true; }
      if (withTtl && (eb.indexOf('ttl') >= 0 || eb.indexOf('cache_control') >= 0)) { withTtl = false; changed = true; }
      if (changed) { const rt = await post(withTtl, withEffort); r = rt.r; j = rt.j; }
    }
    if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
    if (j && j.model) apiModelSeen = String(j.model);
    effortApplied = (withEffort && HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
    addUsage(j.usage);
    const content = j.content || [];
    conv.push({ role: 'assistant', content });
    const toolUses = content.filter((b: any) => b && b.type === 'tool_use');
    const txt = content.filter((b: any) => b && b.type === 'text').map((b: any) => b.text).join('').trim();
    if (txt) finalText = txt;
    if (!toolUses.length || j.stop_reason !== 'tool_use') break;
    const results: any[] = [];
    for (const tu of toolUses) { let out = ''; try { out = await harRunChatTool(tu.name, tu.input || {}, agentId); } catch (e: any) { out = 'tool error: ' + String((e && e.message) || e); } results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 12000) }); }
    conv.push({ role: 'user', content: results });
  }
  return { text: finalText || '(no text)', usage: sumUsage, model: apiModelSeen, effort: effortApplied };
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
async function harChatClaude(apiModel: string, key: string, system: string, msgs: any[]): Promise<{ text: string; usage: any }> {
  const buildBody = (withTtl: boolean) => JSON.stringify({
    model: apiModel, max_tokens: 1024, system,
    messages: msgs.map((m, i) => {
      const block: any = { type: 'text', text: String(m.text || m.content || '') };
      if (msgs.length >= 2 && i === msgs.length - 2) block.cache_control = withTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      return { role: m.role === 'me' ? 'user' : 'assistant', content: [block] };
    }),
  });
  const post = async (withTtl: boolean) => {
    const rr = await waFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: buildBody(withTtl),
    });
    const jj: any = await rr.json();
    return { r: rr, j: jj };
  };
  let { r, j } = await post(true);
  if (!r.ok) {
    // NARROW fallback: only when the API objected to the ttl / cache_control itself do we retry ONCE
    // with a plain { type: 'ephemeral' } block. Every other error falls through and still throws.
    const errBody = JSON.stringify(j);
    if (errBody.indexOf('ttl') >= 0 || errBody.indexOf('cache_control') >= 0) { const retry = await post(false); r = retry.r; j = retry.j; }
  }
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
  return { text: (j.content && j.content[0] && j.content[0].text) || '(no text)', usage: (j && j.usage) || null };
}
async function harChatGemini(apiModel: string, key: string, system: string, msgs: any[]): Promise<{ text: string; usage: any }> {
  const contents = msgs.map((m) => ({ role: m.role === 'me' ? 'user' : 'model', parts: [{ text: String(m.text || m.content || '') }] }));
  const payload = { systemInstruction: { parts: [{ text: system }] }, contents };
  let url = 'https://generativelanguage.googleapis.com/v1beta/models/' + apiModel + ':generateContent?key=' + encodeURIComponent(key);
  let headers: any = { 'Content-Type': 'application/json' };
  
  if (!key || key === 'vertex' || key === 'token') {
    const tok = await waAccessToken();
    // Region MUST match the working bus (work_item_runner.run_gemini: location = vertex_region || 'global').
    // gemini-3.1-pro-preview is a GLOBAL publisher model; us-central1 404s.
    const region = process.env.GCP_REGION || 'global';
    const project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
    // location=global is served by the BARE host, not global-aiplatform.* (same rule as run_deepseek()).
    const vhost = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
    url = `https://${vhost}/v1/projects/${project}/locations/${region}/publishers/google/models/${apiModel}:generateContent`;
    headers['Authorization'] = 'Bearer ' + tok;
  }
  
  const r = await waFetch(url, {
    method: 'POST', headers,
    body: JSON.stringify(payload),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error('gemini ' + r.status + ': ' + JSON.stringify(j).slice(0, 300));
  const c = j.candidates && j.candidates[0];
  const text = (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || '(no text)';
  // Gemini REST (BOTH generativelanguage v1beta and the Vertex v1 path above) returns camelCase
  // `usageMetadata`. Map it onto the SAME four canonical field names the token_usage bus uses.
  const um: any = (j && j.usageMetadata) || null;
  const usage = um ? {
    input_tokens: Number(um.promptTokenCount || 0) || 0,
    output_tokens: Number(um.candidatesTokenCount || 0) || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Number(um.cachedContentTokenCount || 0) || 0,
  } : null;
  return { text: text, usage: usage };
}

// ---- pages (gated: must have an unlocked passkey session; otherwise bounce to /gate) ----
app.get('/chat', (req: express.Request, res: express.Response) => { if (!waSessionOk(req)) { res.redirect('/gate'); return; } res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store, max-age=0'); res.send(HAR_HARNESS_HTML); });

// ---- VM control ----
app.get('/api/vm/status', waGate(async (req, res) => { res.json(await harVmStatus()); }));
app.post('/api/vm/start', waGate(async (req, res) => { res.json(await harVmAction('start')); }));
app.post('/api/vm/stop', waGate(async (req, res) => { await opsClear('box-stopped'); res.json(await harVmAction('stop')); }));

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

// ---- ops-box fast shell: the "big Cloud Shell" ----
// POST /api/shell {cmd} -> proxies to on-box ops-exec (:8022) over the serverless VPC connector.
// gcloud runs AS the user via the forwarded gate token (X-User-Token), valid for the 12h ops window —
// no `gcloud auth login` on the box, no service-account, nothing durable. OPS_TOKEN gates the box.
// (H1) This route is gated by waGate: no unlocked passkey session => 403 before any proxy happens.
app.post('/api/shell', waGate(async (req, res) => {
  const cmd = String((req.body && req.body.cmd) || '');
  if (!cmd) { res.status(400).json({ error: 'no cmd' }); return; }
  if (!OPS_TOKEN) { res.status(412).json({ error: 'OPS_TOKEN not configured on control-plane' }); return; }
  const ip = await harBoxInternalIp();
  if (!ip) { await opsClear('box-down'); res.status(503).json({ error: 'ops-box not reachable — is fleet-navigator running?' }); return; }  // idle-out/stopped => drop window
  const ot = await harOpsToken(req);
  if (ot.err) { res.status(401).json({ error: ot.err }); return; }
  const hdrs: any = { 'X-Ops-Token': OPS_TOKEN, 'Content-Type': 'application/json' };
  if (ot.token) hdrs['X-User-Token'] = ot.token;   // gcloud runs as the human for this command
  try {
    const r = await waFetch('http://' + ip + ':8022/run', { method: 'POST', headers: hdrs, body: JSON.stringify({ cmd }) });
    const j: any = await r.json().catch(() => ({}));
    if (j && typeof j === 'object' && !('authed' in j)) j.authed = !!ot.token;
    res.status(r && r.ok ? 200 : 502).json(j);
  } catch (e: any) { res.status(502).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); }
}));
// health/reachability of the ops-box shell (used by the terminal view to show on/off + authed)
app.get('/api/shell/health', waGate(async (req, res) => {
  const ip = await harBoxInternalIp();
  if (!ip) { res.json({ up: false, reason: 'box stopped' }); return; }
  try {
    const r = await waFetch('http://' + ip + ':8022/healthz', { headers: { 'X-Ops-Token': OPS_TOKEN } });
    const j: any = await r.json().catch(() => ({}));
    const s = await opsGet(); const now = Date.now();
    res.json({ up: !!(r && r.ok), ip, health: j, window_active: !!(s && s.window_expiry && now < s.window_expiry), window_remaining_ms: s && s.window_expiry ? Math.max(0, s.window_expiry - now) : 0 });
  } catch (e: any) { res.json({ up: false, ip, reason: String((e && e.message) || e) }); }
}));

// ---- models ----
app.get('/api/models', waGate(async (req, res) => { res.json(Object.assign({}, harModels(), { effort: HAR_CHAT_EFFORT })); }));
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
  res.json({ 
    claude: !!(await harKey('claude')), 
    gemini: ((await harKey('gemini')) !== 'vertex'),
    claude_set_at: claudeAge,
    gemini_set_at: geminiAge
  });
}));
app.post('/api/keys', waGate(async (req, res) => {
  const provider = (req.body && req.body.provider) === 'gemini' ? 'gemini' : 'claude';
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) { res.status(400).json({ error: 'no key' }); return; }
  
  if (provider === 'claude') {
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
  // rows, so it showed recent talkers (gate-exec, security, work-runner, publisher) and
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
app.post('/api/strain/delete', waGate(async (req, res) => {
  if (!waElevatedOk(req)) { res.status(401).json({ error: 'Face ID required' }); return; }
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
  if (!waElevatedOk(req)) { res.status(401).json({ error: 'Face ID required' }); return; }
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
const VAULT_KMS_KEY_VERSION_E1 = ('projects/' + PC_PROJECT + '/locations/' + VAULT_KMS_LOCATION + '/keyRings/paracoding-vault/cryptoKeys/vault-kem/cryptoKeyVersions/1');
const VAULT_KMS_KEY_VERSION_E2 = ('projects/' + PC_PROJECT + '/locations/' + VAULT_KMS_LOCATION + '/keyRings/paracoding-vault/cryptoKeys/vault-kem-xwing/cryptoKeyVersions/1');
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
    const f = getStorage().bucket(process.env.DATA_LAKE_BUCKET || PC_LAKE).file(spec.path);
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
    const ex = await gitVaultDeadline(getStorage().bucket(process.env.DATA_LAKE_BUCKET || PC_LAKE).file(spec.path).exists(), 'epoch 1 blob probe');
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
  const file = getStorage().bucket(process.env.DATA_LAKE_BUCKET || PC_LAKE).file(path);
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
  const f = getStorage().bucket(process.env.DATA_LAKE_BUCKET || PC_LAKE).file(path);
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
    if (provider === 'gemini') { out = (await harChatGemini(apiModel, key, sys, [{ role: 'me', text: usr }])).text; }
    else { out = (await harChatClaude(apiModel, key, sys, [{ role: 'me', text: usr }])).text; }
    if (out && out.trim() && out.indexOf('(no text)') < 0) {
      await harWriteLake('agents/' + agentId + '/LESSONS.md', out.slice(0, 8000), 'text/markdown; charset=utf-8');
    }
  } catch (e) {}
}
// ---- chat ----
app.post('/api/chat', waGate(async (req, res) => {
  const provider = (req.body && req.body.provider) === 'gemini' ? 'gemini' : 'claude';
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
  if (provider !== 'gemini' && !key) { res.status(412).json({ error: 'no ' + provider + ' API key set' }); return; }
  const apiModel = harApiFor(provider, modelId);
  const system = 'You are ' + (agentId || 'a Paracoding fleet agent') + ', part of the Paracoding.AI fleet. Be concise and useful.';
  const image = (req.body && req.body.image) || null;
  const images = (req.body && Array.isArray(req.body.images)) ? req.body.images : (image ? [image] : []);
  const msgs = [...history, { role: 'me', text: message, image, images }];
  try {
    let reply = ''; let usage: any = null;
    let usedModel = apiModel;
    let usedEffort = (HAR_CHAT_EFFORT && HAR_CHAT_EFFORT !== 'high') ? HAR_CHAT_EFFORT : 'high';
    if (provider === 'gemini') { const gr = await harChatGemini(apiModel, key, system, msgs); reply = gr.text; usage = gr.usage; }
    else { if (agentId) { const cr: any = await harChatClaudeOps(apiModel, key, harOpsSystem(agentId), msgs, harOpsTools(agentId), agentId); reply = cr.text; usage = cr.usage; if (cr.model) usedModel = cr.model; if (cr.effort) usedEffort = cr.effort; } else { const cr = await harChatClaude(apiModel, key, system, msgs); reply = cr.text; usage = cr.usage; } }
    // cache hit-rate telemetry: without cache_creation/cache_read counts the caching above is invisible.
    // try/catch so a telemetry failure can NEVER break a user's chat message.
    if (usage) {
      try {
        await db.collection('token_usage').add({
          agent: agentId, model: apiModel, source: 'web-chat',
          input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
          ts: FieldValue.serverTimestamp(),
        });
      } catch (e) {}
    }
    if (agentId) { try { await db.collection('chat_history').add({ agent_id: agentId, role: 'user', text: message, tags: ['harness'], timestamp: FieldValue.serverTimestamp() }); await db.collection('chat_history').add({ agent_id: agentId, role: 'assistant', text: reply, tags: ['harness'], timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
    if (agentId && HAR_REFLECT_EVERY > 0) { try { const cc = await db.collection('chat_history').where('agent_id', '==', agentId).count().get(); const n = (cc.data() && cc.data().count) || 0; const turns = Math.floor(n / 2); if (turns > 0 && turns % HAR_REFLECT_EVERY === 0) { await harReflect(agentId, provider, apiModel, key); } } catch (e) {} }
    res.json({ reply, usage, model: usedModel, effort: usedEffort });
  } catch (e: any) { console.error('[api/chat] fail', (e && e.stack) || String(e)); res.status(502).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); }
}));
// ---- /rdp desktop stream: reverse-proxy (HTTP + WebSocket) to the box guac web tier :8080 over the VPC ----
// SEC-RDP-GATE-V1 (fleet-mechanic 2026-07-29): GATED. Both entry points below refuse BEFORE any
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
// any deployment. vm_start / vm_stop / vm_resize are unaffected: they are lifecycle
// control and never had anything to do with remote desktop.
// ---- CDP bridge: drive the workstation Chrome via DevTools Protocol (cheap, deterministic) ----
const WS_CDP_PORT = process.env.WS_CDP_PORT || '8025';
async function harCdp(path: string, body: any): Promise<any> {
  const ip = await harBoxInternalIp();
  if (!ip) return { ok: false, error: 'workstation not running' };
  try {
    const r = await waFetch('http://' + ip + ':' + WS_CDP_PORT + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cdp-Token': CDP_TOKEN }, body: JSON.stringify({ method: path, params: (body && body.params) || {}, targetId: (body && body.targetId) || '' }) });  // PC-CDP-RPC-V1
    return await r.json();
  } catch (e: any) { return { ok: false, error: 'cdp bridge: ' + String((e && e.message) || e) }; }
}
// ---- our-own GCP: direct Compute REST via CP_SA token (no gcloud, no Cloud Build, no OAuth) ----
async function harVmSetType(t: string): Promise<boolean> {
  const tok = await waAccessToken();
  const r = await waFetch('https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/zones/' + WS_ZONE + '/instances/' + WS_VM + '/setMachineType', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ machineType: 'zones/' + WS_ZONE + '/machineTypes/' + t }) });
  return !!(r && r.ok);
}
async function harVmWaitOp(op: string, ms: number): Promise<any> {
  const tok = await waAccessToken(); const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await waFetch('https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/zones/' + WS_ZONE + '/operations/' + op, { headers: { Authorization: 'Bearer ' + tok } });
    const j: any = await r.json().catch(() => ({}));
    if (j && j.status === 'DONE') {
      if (j.error) { const m = JSON.stringify(j.error); return { ok: false, capacity: /RESOURCE|CAPACITY|EXHAUST|QUOTA|UNAVAIL/i.test(m), error: m }; }
      return { ok: true };
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  return { ok: false, timeout: true };
}
async function harVmMachine(): Promise<string> { const j = await harVmInstance(); try { return String((j && j.machineType) || '').split('/').pop() || ''; } catch (e) { return ''; } }
async function harVmSmartStart(pref: string, safe: string): Promise<any> {
  const st = await harVmStatus();
  if (st && st.state === 'RUNNING') return { ok: true, size: await harVmMachine(), note: 'already running' };
  await harVmSetType(pref);
  const a = await harVmAction('start');
  if (!a || !a.op) return { ok: !!(a && a.ok), size: pref, note: 'start submitted (no op id)' };
  const w = await harVmWaitOp(a.op, 40000);
  if (w.ok) return { ok: true, size: pref };
  if (w.capacity) {
    await harVmSetType(safe);
    const b = await harVmAction('start');
    if (b && b.op) { const w2 = await harVmWaitOp(b.op, 40000); return { ok: !!w2.ok, size: w2.ok ? safe : 'failed', fallback: true, error: w2.error }; }
    return { ok: !!(b && b.ok), size: safe, fallback: true };
  }
  return { ok: false, size: 'failed', error: w.error || 'start op did not finish' };
}

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
    'https://storage.googleapis.com/storage/v1/b/' + (process.env.DATA_LAKE_BUCKET || PC_LAKE) + '/',
    'https://logging.googleapis.com/v2/projects/' + HAR_PROJECT + '/',
    'https://monitoring.googleapis.com/v3/projects/' + HAR_PROJECT + '/',
  ];
  return P.some((p) => (url || '').indexOf(p) === 0);
}
async function harGcpStage(caller: string, method: string, url: string, body: any, reason: string, danger: boolean): Promise<any> {
  const jobId = 'gcp_' + crypto.randomBytes(6).toString('hex');
  const hasBody = !!(body && typeof body === 'object' && Object.keys(body).length > 0);
  const bodyB64 = hasBody ? Buffer.from(JSON.stringify(body)).toString('base64') : '';
  const lines: string[] = [];
  lines.push(danger ? '# DANGER destroy-class GCP call (' + method + ') — Face ID required' : '# gcp_api ' + method);
  lines.push('# ' + method + ' ' + url);
  if (reason) lines.push('# reason: ' + String(reason).replace(/[\r\n]+/g, ' ').slice(0, 300));
  if (hasBody) lines.push("printf %s '" + bodyB64 + "' | base64 -d > /tmp/gcp_body.json");
  lines.push('curl -sS -X ' + method.toUpperCase() + " '" + url + "' -H \"Authorization: Bearer $CLOUDSDK_AUTH_ACCESS_TOKEN\" -H \"Content-Type: application/json\"" + (hasBody ? ' --data @/tmp/gcp_body.json' : ''));
  const cmd = lines.join('\n');
  const u = (() => { try { return new URL(url); } catch (e) { return null as any; } })();
  const host = u ? u.hostname.replace('.googleapis.com', '') : 'gcp';
  const shortPath = u ? String(u.pathname).split('/').filter(Boolean).slice(-2).join('/') : '';
  await db.collection('pending_confirms').doc(jobId).set({
    job_id: jobId,
    command_type: 'gcp_api ' + method.toUpperCase() + ' ' + host + (shortPath ? '/' + shortPath : ''),
    staged_by: caller || 'fleet-archivist',
    arguments: { command: cmd, method: method.toUpperCase(), url, reason: reason || '', danger: !!danger },
    status: 'pending', created_at: FieldValue.serverTimestamp(),
  });
  try { await db.collection('journal').add({ agent_id: caller || 'fleet-archivist', action: 'stage_job', message: 'gcp_api -> gate: ' + method.toUpperCase() + ' ' + url + (reason ? ' (' + reason + ')' : ''), timestamp: FieldValue.serverTimestamp() }); } catch (e) {}
  return { mode: 'staged', job_id: jobId, danger: !!danger, note: 'Pending the operator gate approval. After they approves, read the result with read_job_log job_id=' + jobId };
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
// ---- S32: vm_* mutations ride the SAME trust ladder as every other cloud mutation ----
// VERIFY-GREP: VM-LADDER-WIRED
// harGcpBlessedDirect() is GET-only, so a Compute POST can never run direct as CP_SA.
// harGcpDanger() returns true for POST, so every card below trips the SECOND Face ID.
async function harVmGateCtx(): Promise<any> {
  var state = 'unknown';
  var size = 'unknown';
  try { const st = await harVmStatus(); if (st && st.state) state = String(st.state); } catch (e) {}
  try { const m = await harVmMachine(); if (m) size = String(m); } catch (e) {}
  return { state: state, size: size, ctx: ' [workstation is currently ' + state + ' / ' + size + ']' };
}
async function harVmGate(caller: string, action: string, machineType: string): Promise<any> {
  const me = caller || 'unknown-caller';
  const base = 'https://compute.googleapis.com/compute/v1/projects/' + HAR_PROJECT + '/zones/' + WS_ZONE + '/instances/' + WS_VM;
  const c = await harVmGateCtx();
  if (action === 'start') {
    if (c.state === 'RUNNING') return { ok: true, mode: 'noop', state: c.state, machine_type: c.size, note: 'workstation is already RUNNING; nothing staged' };
    return await harGcpApi(me, 'POST', base + '/start', null, 'vm_start requested by ' + me + c.ctx);
  }
  if (action === 'stop') {
    if (c.state === 'TERMINATED') return { ok: true, mode: 'noop', state: c.state, note: 'workstation is already TERMINATED; nothing staged' };
    return await harGcpApi(me, 'POST', base + '/stop', null, 'vm_stop requested by ' + me + c.ctx);
  }
  if (action === 'setMachineType') {
    const t = String(machineType || '').trim();
    if (!/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(t)) return { error: 'blocked: machine_type must look like e2-medium or e2-standard-2 (got: ' + t.slice(0, 40) + ')' };
    if (c.state !== 'TERMINATED' && c.state !== 'unknown') {
      return { error: 'blocked: Compute setMachineType requires the instance to be TERMINATED, but it is ' + c.state + '. Call vm_stop, have the operator approve that card at your gate URL, then call vm_resize again.', state: c.state, machine_type: c.size };
    }
    return await harGcpApi(me, 'POST', base + '/setMachineType', { machineType: 'zones/' + WS_ZONE + '/machineTypes/' + t }, 'vm_resize to ' + t + ' requested by ' + me + c.ctx);
  }
  return { error: 'unknown vm action: ' + String(action).slice(0, 40) };
}
// =============== end Paracoding Agentic Harness ===============
// ---- /flow live visibility (advisor v1): idea -> strain -> fruit (HTML served live from the lake) ----
app.get('/flow', (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.redirect('/gate'); return; }
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
async function wikiServe(req: express.Request, res: express.Response, slug: string): Promise<void> {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // Check 1 of 2: the slug shape. Flat slugs only -- there is no path segment to traverse out of.
  if (!WIKI_SLUG_RE.test(slug)) { res.status(404).send('<h1>no such page</h1>'); return; }
  let index: any = null;
  try { const t = await harReadLake('shared/wiki/_index.json'); index = t ? JSON.parse(t) : null; } catch (e) { index = null; }
  if (!index || !Array.isArray(index.pages)) { res.status(503).send('<h1>wiki index unavailable</h1><p>shared/wiki/_index.json is missing or unparseable. Nothing is rendered from a guess.</p>'); return; }
  // Check 2 of 2: membership. Both checks run BEFORE any concatenation, so one mistake is not a breach.
  const entry = index.pages.filter((p: any) => p && p.slug === slug)[0];
  if (!entry) { res.status(404).send('<h1>no such page</h1>'); return; }
  const raw = await harReadLake('shared/wiki/pages/' + slug + '.md');
  if (!raw) { res.status(404).send('<h1>page listed in the index but absent from the lake</h1>'); return; }
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
  const shell = await harReadLake('shared/wiki/_shell.html');
  if (!shell) { res.status(503).send('<h1>wiki shell unavailable</h1><p>shared/wiki/_shell.html is missing from the lake.</p>'); return; }
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
// The 302 target is the CONSTANT '/wiki' for every slug, existing or not. Carrying the requested
// slug in `next` would make the anonymous response vary with caller input on a surface whose static
// text IS the sensitive payload; a fixed target costs one extra click after login and leaves no
// enumeration oracle at all.
app.get('/wiki', (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.redirect('/gate?next=%2Fwiki'); return; }
  wikiServe(req, res, 'index').catch((e: any) => { harFail(res, e, 'harness'); });
});
app.get('/wiki/:slug', (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.redirect('/gate?next=%2Fwiki'); return; }
  wikiServe(req, res, String(req.params.slug || '')).catch((e: any) => { harFail(res, e, 'harness'); });
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
  const f = getStorage().bucket(process.env.DATA_LAKE_BUCKET || PC_LAKE).file(path);
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
  // Constant redirect target with no `next`, exactly as /wiki does: echoing the token back into a
  // redirect URL would copy a live credential into another log line for no gain at all.
  if (!waSessionOk(req)) { res.redirect('/gate'); return; }
  lvServe(req, res).catch((e: any) => { harFail(res, e, 'harness'); });
});
// ---- end /lakeview -----------------------------------------------------------------------------
app.get('/api/flow', waGate(async (req: express.Request, res: express.Response) => {
  const now = Date.now();
  const agents: any = {};
  const ensure = (a: string) => { if (!a) return null; if (!agents[a]) agents[a] = { agent: a, last_ts: 0, last_action: '', backlog: 0, in_progress: 0, parked: 0, bus: 'unknown' }; return agents[a]; };
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
      if (e.action === 'work_model' && e.message && a.bus === 'unknown') { const m = String(e.message).toLowerCase(); if (m.indexOf('gemini') >= 0) a.bus = 'gemini'; else if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) a.bus = 'claude'; }
    }
    if (feed.length < 45 && FEED_ACTIONS.indexOf(e.action) >= 0) feed.push({ agent: e.agent_id, action: e.action, message: String(e.message || '').slice(0, 240), age_min: ts ? Math.round((now - ts) / 60000) : 99999 });
  });
  feed.forEach((f: any) => { const a = agents[f.agent]; f.bus = (a && a.bus) || 'unknown'; });
  // ---- live lane read (FLOWLIVE-INFLIGHT-v1) ---------------------------------------------------
  // A second, separate journal query with its own limit. The feed above keeps its full 200-doc /
  // 45-item budget no matter how loud the runners get, and this lane keeps its own. Neither can
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

app.get('/harness',(req:any,res:any)=>{ if(!waSessionOk(req)){res.redirect('/gate');return;} res.setHeader('Content-Type','text/html; charset=utf-8');res.send(HAR_HARNESS_HTML);});


// ================= PARACODING MCP OAUTH (additive; /mcp/:token stays intact) =================
function oaB64url(buf: any): string { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function oaRand(n?: number): string { return oaB64url(oaCrypto.randomBytes(n || 32)); }
function oaPubBase(req: any): string { return String(process.env.MCP_PUBLIC_URL || ('https://' + req.get('host'))).replace(/\/$/, ''); }
const OAUTH_ALLOW = String(process.env.WA_APPROVER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Per-agent identity: an OAuth connector with no bound strain lands on 'fleet-editor' (a real, seeded,
// obviously-unbound identity) — NOT a phantom role. The operator binds it to a real strain on the consent page.
const OAUTH_ROLE = process.env.OAUTH_DEFAULT_ROLE || 'fleet-archivist' /* fail-closed */;  // VERIFY-GREP: OAUTH-ROLE-RESTORED-FAILCLOSED -- patch-identity-failclosed bound the connector to the human principal; patch-gate-ux flipped it to fleet-archivist for a cosmetic goal friendlyRole() already met.
const OA_GID = process.env.WA_GOOGLE_CLIENT_ID || '';

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
// [SEC-OAUTH-DUALREAD-REMOVED] fleet-mechanic 2026-07-30. The legacy cleartext-ID fallback is GONE.
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
const STRAIN_RE = /^(fleet-[a-z0-9-]+|work-runner)$/;
// [STRAIN-PASTEABLE-V1] /api/sessions/roles filters on pasteable === true. The seed never
// wrote that field, so every fresh install showed 'no pasteable strains' and the operator
// could not mint a session key for ANY strain. onboarder and work-runner stay unpasteable:
// onboarder is where unclaimed connectors land, work-runner is machinery, neither is a chat.
// [RELEASE-ROSTER-V1] Derived from STRAIN_SEED on purpose. There were three
// rosters and they could drift; now there is one list and the extractor has one
// thing to trim for the public release. Every seeded strain can mint a paste.
// [RELEASE-ROSTER-V1] One list, one exclusion. STRAIN_SEED is the roster; a
// strain is pasteable unless it is a SERVICE IDENTITY. work-runner executes
// queued work and is active and hidden by design -- handing out a paste for it
// would mint a human key for the thing that runs the queue. The rule lives here
// rather than in a second hand-maintained roster that can drift out of step.
// [STRAIN-TDZ-V1] ORDER IS LOAD-BEARING. STRAIN_PASTEABLE is derived from
// STRAIN_SEED at module scope, so the seed must be DECLARED FIRST. `const`
// hoists into a temporal dead zone: reading it above its initializer throws
// ReferenceError on require, the process exits 1, and the container never
// listens. That shipped once (revision 00245-jur) and was caught only because
// the deploy went out at --no-traffic. esbuild here is transpile-only and will
// never catch it. Do not reorder or separate these three statements.
const STRAIN_SEED = ['fleet-onboarder', /* [STRAIN-SEED-ONBOARDER-V1] OAUTH_DEFAULT_ROLE names this strain; a wipe-and-reseed without it drops every new connector onto the privileged strain */ 'fleet-engineer', 'fleet-archivist', 'fleet-inspector', 'fleet-mechanic', 'fleet-analyst', 'fleet-drafter', 'fleet-librarian', 'fleet-herald', 'fleet-courier', 'work-runner'];
const STRAIN_NEVER_PASTEABLE = new Set(['work-runner', 'fleet-onboarder']);
const STRAIN_PASTEABLE = new Set(
  STRAIN_SEED.filter((r: string) => !STRAIN_NEVER_PASTEABLE.has(r)));
async function strainList(activeOnly: boolean): Promise<any[]> {
  try { const s = await db.collection('strains').get(); let rows = s.docs.map((d: any) => d.data()); if (activeOnly) rows = rows.filter((r: any) => r && r.status === 'active'); return rows; } catch (e) { return []; }
}
async function strainSeedIfEmpty(): Promise<void> {
  try {
    const s = await db.collection('strains').limit(1).get();
    if (!s.empty) return;
    for (const role of STRAIN_SEED) {
      await db.collection('strains').doc(role).set({ role, display_name: role, status: 'active', pasteable: STRAIN_PASTEABLE.has(role), created_by: 'system:seed', created_at: FieldValue.serverTimestamp() });
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
  } catch (e) {} for (const _b of ['fleet-editor', 'fleet-builder']) { try { await db.collection('strains').doc(_b).set({ role: _b, status: 'retired', retired_by: 'system:failclosed', retired_at: FieldValue.serverTimestamp() }, { merge: true }); } catch (e) {} } const _mig = await db.collection('migrations').doc('failclosed_v1').get().catch(() => null); if (!_mig || !_mig.exists) { for (const _c of ['oauth_tokens', 'oauth_refresh']) { try { const _s = await db.collection(_c).get(); for (const _d of _s.docs) { try { await _d.ref.delete(); } catch (e) {} } } catch (e) {} } try { await db.collection('migrations').doc('failclosed_v1').set({ done_at: FieldValue.serverTimestamp(), note: 'purged oauth tokens; retired guest/architect' }); } catch (e) {} } console.error('[strains] seeded; banned retired; oauth tokens purged (one-time)'); } catch (e) { console.error('[strains] boot migration failed', e); } })();

app.get('/api/strains', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  res.json({ strains: await strainList(false) });
}));
app.post('/api/strains/provision', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const role = String((req.body && req.body.role) || '').trim();
  const display = String((req.body && req.body.display_name) || role).trim();
  if (!STRAIN_RE.test(role)) { res.status(400).json({ error: 'role must match fleet-<name> or work-runner' }); return; }
  await db.collection('strains').doc(role).set({ role, display_name: display || role, status: 'active', created_by: 'passkey:' + WA_USER, created_at: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'strain_provisioned', message: 'provisioned strain ' + role + ' (' + (display || role) + ') — active on next control-plane deploy', timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, role, status: 'active' });
}));
app.post('/api/strains/retire', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const role = String((req.body && req.body.role) || '').trim();
  if (!role) { res.status(400).json({ error: 'role required' }); return; }
  await db.collection('strains').doc(role).set({ status: 'retired', retired_by: 'passkey:' + WA_USER, retired_at: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('journal').add({ agent_id: 'human_operator', action: 'strain_retired', message: 'retired strain ' + role + ' — removed from roster on next control-plane deploy', timestamp: FieldValue.serverTimestamp() });
  res.json({ ok: true, role, status: 'retired' });
}));
// [SEC-OAUTH-STRAINS-GATE] fleet-mechanic 2026-07-30. This route USED to be public. The comment that
// stood here justified that by saying the consent page needs the roster so a human can bind a
// connector to a strain. THAT JUSTIFICATION IS FALSE IN THE DEPLOYED ARTIFACT, and it was verified
// false against real bytes rather than assumed: shared/passkey/patch-identity-failclosed.py deletes
// the consent-page fetch of this route outright (its d_div / d_read / d_fetch anchors -- all three
// are present in this source, so the deletion branch is the one that runs) as part of the human-only
// connector change. The shipped consent page never calls this. What was left behind was an anonymous,
// unauthenticated enumeration of the fleet roster -- every active strain, role and display name -- to
// any caller on a public origin that also serves the passkey gate.
// GATED, NOT DELETED. There is no delete tool in this fleet and out-of-tree callers do exist: both
// shared/harness/patch-oauth-role-restore.py and shared/harness/patch-admission-control.py document
// unauthenticated pre-flight GETs of this exact URL. Those callers must now hold a passkey session
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
  if (!row || row.status !== 'active') { res.status(404).json({ error: 'no active strain "' + role + '"' }); return; }
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
function oaPrMeta(req: any): any { const b = oaPubBase(req); return { resource: b + '/mcp', authorization_servers: [b], bearer_methods_supported: ['header'], scopes_supported: ['mcp'] }; }
app.get('/.well-known/oauth-protected-resource', (req: any, res: any) => res.json(oaPrMeta(req)));
app.get('/.well-known/oauth-protected-resource/mcp', (req: any, res: any) => res.json(oaPrMeta(req)));

// ---- RFC 8414 Authorization Server Metadata ----
function oaAsMeta(req: any): any {
  const b = oaPubBase(req);
  return {
    issuer: b, authorization_endpoint: b + '/oauth/authorize', token_endpoint: b + '/oauth/token',
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
// WHY NOT THE MAP IN shared/state/security-fixes/missing-rate-limit.md: that spec proposes a
// process-local `new Map()`. On Cloud Run that is wrong three ways and cannot meet the brief.
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
function oaClientIp(req: any): string {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return String(req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || 'unknown');
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
  const f = String((req.headers && req.headers['x-forwarded-for']) || '');
  return (f.split(',')[0] || String(req.ip || '')).trim() || 'unknown';
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
  const CID = oaJsonForScript(OA_GID);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Authorize Paracoding connector</title><script src="https://accounts.google.com/gsi/client" async></script>'
    + '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#20103f,#3a1e63 52%,#6a2a7e) fixed;color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;padding:1rem}'
    + '.card{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.26);border-radius:18px;padding:1.6rem;max-width:380px;text-align:center;backdrop-filter:blur(8px);box-shadow:0 20px 60px rgba(0,0,0,.4)}'
    + 'h1{font-size:1.15rem;margin:.2rem 0 .4rem;background:linear-gradient(90deg,#ffe9a8,#e0982e);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'p{color:rgba(255,255,255,.82);font-size:.86rem;line-height:1.45}#g{display:flex;justify-content:center;margin:1.1rem 0}#msg{font-size:.8rem;color:#ffd7d0;min-height:1.2em}'
    + 'select{margin-top:.35rem;padding:.45rem .6rem;border-radius:9px;min-width:200px;font-size:.9rem;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff}label{font-size:.78rem;color:rgba(255,255,255,.72)}</style></head>'
    + '<body><div class="card"><h1>Authorize connector</h1><p>Sign in with Google to connect this MCP client to your Paracoding fleet. Only approved accounts can authorize.</p>'
    + ''
    + '<div id="g"></div><div id="msg"></div></div><script>'
    + 'var P=' + P + ';var CID=' + CID + ';'
    + 'function onCred(resp){document.getElementById("msg").style.color="#c6ffe4";document.getElementById("msg").textContent="Authorizing…";'
    + 'var role="";'
    + 'fetch("/oauth/authorize/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({id_token:resp.credential,role:role},P))})'
    + '.then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location=d.redirect;}else{document.getElementById("msg").style.color="#ffd7d0";document.getElementById("msg").textContent=d.error||"authorization failed";}})'
    + '.catch(function(e){document.getElementById("msg").textContent=String(e);});}'
    + 'window.onload=function(){'
    + ''
    + 'if(!CID){document.getElementById("msg").textContent="server: no Google client configured";return;}'
    + 'google.accounts.id.initialize({client_id:CID,callback:onCred});'
    + 'google.accounts.id.renderButton(document.getElementById("g"),{theme:"filled_blue",size:"large",text:"signin_with",shape:"pill"});'
    + 'google.accounts.id.prompt();};'
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
  res.send(oaAuthHtml(params));
});
// verify the Google ID token, check the allowlist, mint our authorization code
app.post('/oauth/authorize/complete', async (req: any, res: any) => {
  const b = req.body || {};
  const idt = String(b.id_token || '');
  if (!idt) { res.status(400).json({ error: 'no id_token' }); return; }
  if (!OA_GID) { res.status(500).json({ error: 'server misconfigured (no Google client id)' }); return; }  // fail closed
  // [SEC-TOKENINFO-POST] id_token in the body, not the query string. See waGoogleEmail().
  const r = await waFetch('https://oauth2.googleapis.com/tokeninfo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'id_token=' + encodeURIComponent(idt) });
  const info: any = (r && r.ok) ? await r.json() : null;
  if (!info || info.aud !== OA_GID) { res.status(401).json({ error: 'invalid Google token' }); return; }
  if (String(info.email_verified) !== 'true') { res.status(403).json({ error: 'email not verified' }); return; }
  const email = String(info.email || '').toLowerCase();
  if (!OAUTH_ALLOW.length || OAUTH_ALLOW.indexOf(email) === -1) { res.status(403).json({ error: 'account not authorized: ' + email }); return; }  // fail closed
  const client = await oaGet('oauth_clients', String(b.client_id || ''));
  if (!client) { res.status(400).json({ error: 'invalid client' }); return; }
  const redirect = String(b.redirect_uri || '');
  if (!redirect || !Array.isArray(client.redirect_uris) || client.redirect_uris.indexOf(redirect) === -1) { res.status(400).json({ error: 'invalid redirect_uri' }); return; }  // re-validate
  // bind this connector to a chosen, provisioned strain (falls back to the unbound guest identity)
  // [FAIL-CLOSED IDENTITY] the app connector ALWAYS acts as the human principal. Strains authenticate
  // via GCP Agent Identity (SPIFFE), never through this OAuth connector. No dropdown trust, no default-to-guest.
  const role = OAUTH_ROLE;
  const code = oaRand(24);
  await oaSet('oauth_codes', code, { client_id: String(b.client_id), redirect_uri: redirect, code_challenge: String(b.code_challenge || ''), email, role, exp: Date.now() + 600000 });
  const url = redirect + (redirect.indexOf('?') === -1 ? '?' : '&') + 'code=' + encodeURIComponent(code) + (b.state ? ('&state=' + encodeURIComponent(String(b.state))) : '');
  res.json({ redirect: url });
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
// [SEC-OAUTH-DEFAULT-ROLE-AUDIT] fleet-mechanic 2026-07-30, after a live outage.
// OAUTH_DEFAULT_ROLE names the strain that every OAuth connector inherits when consent binds no
// explicit role. NOTHING in this control plane ever checked that the named strain EXISTS. It named
// a strain that had been deleted, so MCP admission control (shared/harness/patch-admission-control.py)
// denied the fleet toolset to every newly-authorized connector on every account. The connectors came
// up serving whoami and nothing else. The only trace was an admission_denied journal line reading
// -- no strain document in the registry -- which nobody read for weeks.
//
// DESIGN: LOUD AND CONTINUE, NEVER FAIL THE BOOT. Four reasons, in order of weight:
//   1. SELF-SEALING DEADLOCK. This same process serves /gate, the passkey unlock, the whole
//      webauthn flow and /api/strains/provision. The only cure for a missing strain is served BY
//      the process a hard failure would kill. Refusing to boot removes the recovery path for the
//      exact condition it is detecting.
//   2. IT BUYS NO AUTHORIZATION. Admission control ALREADY fails closed on this condition: an
//      unprovisioned principal gets a whoami-only server. Continuing grants nothing. Failing the
//      boot only converts a partial outage (connectors degraded) into a total one (gate, dashboard,
//      chat and bus all down).
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
      + 'FIX: provision or reactivate that strain at /gate, or point the default at an active strain, then '
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
// one identity. Every strain chat was fleet-archivist wearing a name badge.
//
// WHY NOT JUST LET THE CHAT SAY WHO IT IS. That is exactly what the consent-page strain
// picker did, and patch-identity-failclosed removed it for a good reason: the role
// arrived as caller-supplied JSON, so any caller could name any strain including a
// privileged one. A CLAIM IS NOT AN IDENTITY. This does not reintroduce that.
//
// WHAT THIS DOES. The operator mints a session key behind the passkey. It is stored ONLY as
// sha256 -- the plaintext exists once, in his browser. A chat presents the key as the
// 'agent' argument; the server resolves key -> role from Firestore. The role is
// SERVER-ISSUED. Editing your paste to say 'fleet-mechanic' does nothing: the role
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
//   unset / '0' -> resolve bound chats, NEVER deny. Mint and prove keys while every
//                  existing chat keeps working. This is the safe landing state.
//   '1'         -> enforce. Flipping it is a Cloud Run env update (a config revision),
//                  not a rebuild of this code, so it rolls back in seconds.
const PC_ENFORCE = String(process.env.PC_SESSION_ENFORCE || '') === '1';
// [PC-KEY-TTL-V1] Session keys had no expiry: a key pasted into a chat transcript stayed
// valid forever and only an explicit revoke could kill it. That is the same defect the
// OAuth refresh tokens had ([SEC-OAUTH-RT-EXP]) and it gets the same fix -- stamp an exp
// at mint, enforce it at resolve. An env var so the TTL changes with a config revision
// rather than a rebuild, exactly like PC_SESSION_ENFORCE above.
const PC_KEY_TTL_DAYS = Math.max(1, Number(process.env.PC_KEY_TTL_DAYS || 7));
const PC_KEY_TTL_MS = PC_KEY_TTL_DAYS * 86400000;
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
    const _expired = _exp > 0 && _exp < now;
    const v = (row.revoked || _expired || !row.role) ? null : { role: String(row.role), label: String(row.label || '') };
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
  // PROMOTED it to fleet-archivist, the one role permitted to stage gated jobs and supersede
  // every other chat's pending work. Fail-open, on the identity check itself.
  // fleet-drafter found it by mutating one character of its own key, which is the test that
  // should have existed before this shipped.
  // PC_ENFORCE governs the NO-KEY case ONLY -- letting chats that predate the mechanism
  // keep working through the cutover is the entire reason that flag exists. It is not a
  // licence to guess an identity for a caller who asserted one and got it wrong.
  if (x.mixed) return { deny: true, reason: 'mixed', id: x.id };
  if (x.key) {
    const s: any = await pcSessionLookup(x.key);
    if (s && s.role) return { role: s.role };
    return { deny: true, reason: 'unknown-or-revoked', id: x.id };
  }
  return PC_ENFORCE ? { deny: true, reason: 'no-identity', id: x.id } : { role: bearer };
}

function pcSendDenied(req: any, res: any, reason: string, id: any): void {
  const why = (reason === 'unknown-or-revoked')
    ? 'The session key in this chat is not recognised, has EXPIRED, or has been revoked. Session keys last ' + PC_KEY_TTL_DAYS + ' days -- mint a fresh paste at the Autoclave and replace the PC-SESSION-KEY line.'
    : ((reason === 'mixed')
      ? 'This request carried more than one session key.'
      : 'This chat has not established an identity yet.');
  const txt = 'DENIED: ' + why + '\n\n'
    + 'This MCP connector is account-level and serves every Cowork chat, so a chat must prove which strain it is before it can use any tool. '
    + 'Pass your session key as the "agent" argument on EVERY tool call. It is the line beginning PC-SESSION-KEY in this chat bootstrap paste. '
    + 'If there is no such line, ask the operator: they mints one at the Flow Hood (Autoclave, New strain session) and pastes it here. '
    + 'Do NOT guess a role name -- the role is resolved from the key on the server, and a role name is not a key.';
  try {
    res.status(200).json({ jsonrpc: '2.0', id: (id === null ? 0 : id), result: { content: [{ type: 'text', text: txt }], isError: true } });
  } catch (e) { if (!res.headersSent) res.status(403).json({ error: 'no_session_identity' }); }
}
app.post('/mcp', async (req: any, res: any) => {
  void oaAuditDefaultRole();  const pcv: any = await pcResolveIdentity(req);
  if (pcv && pcv.deny) { pcSendDenied(req, res, String(pcv.reason || ''), pcv.id); return; }
  const role = pcv ? pcv.role : null;
  if (!role) { oaChallenge(req, res); return; }
  try {
    const server = await buildMcpServerAdmitted(role);
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
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(role)) { res.status(400).json({ error: 'bad role' }); return; }
  const sd = await db.collection('strains').doc(role).get();
  if (!sd.exists) { res.status(400).json({ error: 'no such strain: ' + role }); return; }
  const srow: any = sd.data() || {};
  if (srow.status !== 'active') { res.status(400).json({ error: 'strain is not active: ' + role }); return; }
  // FAIL-CLOSED ALLOW-LIST. pasteable must be EXPLICITLY true.
  // 'active' and 'pasteable' are different questions and conflating them is a real hazard:
  // work-runner must stay ACTIVE or the bus dies under admission control, and
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
    exp: Date.now() + PC_KEY_TTL_MS
  });
  try { await db.collection('journal').add({ agent_id: 'passkey:' + WA_USER, action: 'session_key_mint', detail: 'minted a session key for ' + role, at: FieldValue.serverTimestamp() }); } catch (e) {}
  // Returned ONCE. Only sha256(key) is stored, so this cannot be recovered later.
  res.json({ ok: true, role: role, key: key, note: 'shown once' });
}));

// ---- [STRAINLIFE-CREATE-V1] strain lifecycle: create a strain (from scratch, or as a clone) ----
// GATED exactly like /api/strain/delete and /api/strain/subculture: a passkey session (waGate)
// plus Face-ID elevation. Creation writes `strains` and `session_keys` -- that is access control
// wearing a database's clothes, so it does not get a softer gate than deletion does.
// POSITION IS LOAD-BEARING: this block sits BELOW the module-scope declarations of
// STRAIN_NEVER_PASTEABLE and PC_KEY_TTL_MS that it reads. Both are `const`; a read above the
// initializer compiles clean and throws ReferenceError at require time (revision 00245-jur).
const SL_SEED_LESSONS = [
  '# LESSONS -- <STRAIN>',
  '',
  'This file is the strain long-term memory. It is read at the start of every chat and rewritten',
  'by server-side reflection. A strain with no lessons file starts worse than an older strain: that',
  'was the old default and it is the reason this seed exists.',
  '',
  '## Lane',
  '- I own ONE lane and do not speak for the whole fleet.',
  '',
  '## Doctrine',
  '- STAGE, NEVER SHIP: propose privileged work, the human approves with a passkey.',
  '- The container is ephemeral; the lake is the only durable memory.',
  '- Verify from the journal and from real bytes -- never claim fleet state from memory.',
  '',
  '## Open threads',
  '- (none yet)',
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
  if (!waElevatedOk(req)) { res.status(401).json({ error: 'Face ID required' }); return; }
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
    // NEVER PASTEABLE applies to CREATION, not just to the seed roster. work-runner executes the
    // queue and fleet-onboarder is where unclaimed connectors land; minting a human paste for
    // either hands a person the identity of machinery. Default is FALSE for everything else too.
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
      else { paste = ['----- COPY BELOW -----', line, '# PARACODING.AI - STRAIN ' + id, '', 'The Paracoding.AI MCP connector is your identity. Pass the key above as the "agent" argument on EVERY tool call.', 'DO FIRST: whoami. read_file shared/fleet/LAWS.md. read_file agents/' + id + '/LESSONS.md. read_journal(limit 30).', '----- COPY ABOVE -----'].join('\n'); }
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
// hidden. Keeping these independent is what stops "tidy up the roster" from killing the bus.
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
// work-runner is active because the bus needs it and must never become a chat identity.
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

app.post('/api/sessions/revoke', waSafe(async (req: express.Request, res: express.Response) => {
  if (!waSessionOk(req)) { res.status(401).json({ error: 'unlock first' }); return; }
  const body: any = (req as any).body || {};
  const idp = String(body.id || '').trim();
  if (idp.length < 6) { res.status(400).json({ error: 'id prefix too short' }); return; }
  let n = 0;
  try {
    const snap = await db.collection('session_keys').limit(500).get();
    for (const d of snap.docs) { if (String(d.id).indexOf(idp) === 0) { await d.ref.set({ revoked: true, revoked_at: FieldValue.serverTimestamp() }, { merge: true }); n++; } }
  } catch (e) {}
  pcSessCache.clear();
  res.json({ ok: true, revoked: n });
}));

// =============== end Paracoding MCP OAUTH ===============


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Paracoding Control Plane & MCP SSE Server online on port ${PORT}`);
});

// =============== FLOW HOOD FRONT DOOR (operator ruling 2026-07-31) ===============
// One auth opens everything for WA_SESSION_MIN. The queue and the pastes get
// their own URLs instead of being crammed into the unlock page. Approving a job
// still costs a fresh, job-bound WebAuthn assertion -- that check is untouched.
// NOTHING HERE IS A CATCH-ALL. The MCP connector's paths (/.well-known/*,
// /oauth/*, /mcp, /agents/*) are not matched by any route below.
app.get('/flowhood', (req: any, res: any) => { if (!waSessionOk(req)) { res.redirect('/gate?next=/flowhood'); return; } res.redirect('/harness'); });
app.get('/jobs', (req: any, res: any) => { if (!waSessionOk(req)) { res.redirect('/gate?next=/jobs'); return; } res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.send(WA_GATE_HTML.split('__WA_GOOGLE_CLIENT_ID__').join(WA_GOOGLE_CLIENT_ID)); });
app.get('/pastes', (req: any, res: any) => { if (!waSessionOk(req)) { res.redirect('/gate?next=/pastes'); return; } res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.send(WA_GATE_HTML.split('__WA_GOOGLE_CLIENT_ID__').join(WA_GOOGLE_CLIENT_ID)); });
// =============== end flow hood front door ===============

// Type the gate hostname and land on the gate that your passkey actually works
// on. The canonical host is WA_RP_ID -- the WebAuthn RP ID is BY DEFINITION the
// only hostname where an assertion can verify, so there is no second copy of
// this value to go stale.
// ONLY the browser-facing paths below call this. /mcp, /oauth/*, /.well-known/*
// and /agents/* never do: they are the connector and must answer on any host.

