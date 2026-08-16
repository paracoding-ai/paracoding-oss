#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// =============================== [MCP2026-CONFORMANCE-V1] ===============================
// A RUNNABLE conformance harness for MCP revision 2026-07-28, server side, Streamable
// HTTP binding. One PASS/FAIL/SKIP line per numbered requirement of CONFORMANCE.md.
// Non-zero exit on any FAIL.
//
// NODE BUILTINS ONLY. No dependency, no package.json entry, nothing to install: the build
// image is node:24-slim and npm is restricted by org egress policy. Everything below comes
// from node:http, node:net, node:url, node:process.
//
// RAW http.request, NEVER fetch. Three reasons, all load-bearing:
//   1. Header NAME CASING is chosen by us. R19 (case-insensitive header names) cannot be
//      tested through a client library that normalises names for you.
//   2. Bodies a client library would refuse can be put on the wire: a JSON array body
//      (F13, batching removed), a body with no `id`, a header value carrying a raw
//      non-ASCII octet (R15).
//   3. The response is read as BYTES, so SSE framing and Content-Type are observable.
//
// ----------------------------------------------------------------------------------------
// THE R20a GUARD -- why the prior harness's single FAIL cannot recur here.
//
// The previous run reported 43 PASS / 1 FAIL / 6 SKIP. The one FAIL was not a server
// defect. It was id bookkeeping inside the harness: a probe built its raw JSON body with
// one id, then handed that body to a request helper whose signature was
// `send(method, params, id = nextId())`. The default parameter fired, allocated a SECOND
// id, and the assertion compared the response against an id that had never been on the
// wire. The check failed against a server that was answering correctly.
//
// This harness makes that class of bug unrepresentable:
//   * `nextId()` is the ONLY id source and it is never called from a default parameter.
//   * No request function has an `id` parameter with a default. `rpc()` REQUIRES an
//     explicit `id` and throws `harness bug` if it is undefined.
//   * Every response assertion goes through `expectId(sent, res, id)`, which first
//     re-parses THE BYTES THAT WERE ACTUALLY SENT and throws if `sent.id !== id`. An id
//     that was never on the wire can therefore never be asserted about; the harness
//     accuses itself before it can accuse the server.
//   * `HARNESS BUG` outcomes are counted separately and are always a non-zero exit, in
//     both normal and --selftest mode.
//
// ----------------------------------------------------------------------------------------
// USAGE
//
//   node conformance.mjs --selftest
//       Run EVERY check against the built-in deliberately non-conforming stub server.
//       Every check MUST report FAIL. Exits non-zero if any check PASSes or SKIPs. Run
//       this FIRST, always: a green run whose oracle has not been proven is worthless.
//
//   node conformance.mjs --host ../src/mcp2026.ts
//       Stand the module up on an ephemeral localhost port through the thin host below
//       and run every check against it. Requires TypeScript type-stripping: native on
//       node >= 23.6 (node:24-slim, the build image); on node 22.x add
//       --experimental-strip-types before the script path.
//
//   node conformance.mjs http://127.0.0.1:8931/mcp [--token TOKEN]
//       Run against an already-running endpoint. --token, or MCP_BEARER in the
//       environment, supplies the bearer credential. THIS IS THE SEAT THAT EXERCISES
//       C39, C40 and C48: they cover routing and the metadata document, which live in
//       index.ts, and they SKIP under --host because the module does not own them.
//
//   node conformance.mjs --stub [--port N]
//       Serve the non-conforming stub on its own, for debugging the checks by hand.
//
// Exit codes: 0 all good; 1 a conformance FAIL (or, under --selftest, an unfailing
// check); 2 a harness bug or a usage error; 11 a HOLE -- a check SKIPped without a
// reviewed reason. See REVIEWED_SKIPS: a skip is an assertion that did not happen, and
// one that is merely absent from the failures is indistinguishable from a pass.
// ========================================================================================

import http from 'node:http';
import process from 'node:process';

const SPEC = '2026-07-28';
const META_VER = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_INFO = 'io.modelcontextprotocol/clientInfo';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const META_SUB = 'io.modelcontextprotocol/subscriptionId';

// A host that answers this header declares itself a bare module host: it serves the
// mcp2026.ts request path and NOTHING that lives in index.ts. Checks whose scope is the
// whole HTTP endpoint rather than the module SKIP against such a host, with the owner
// named in the skip reason. The stub does not send it, so those checks always run -- and
// must fail -- under --selftest.
const MODULE_ONLY_HEADER = 'x-mcp-harness-host';
const MODULE_ONLY_VALUE = 'module-only';

// ------------------------------------------------------------------ id bookkeeping (R20a)

let ID_SEQ = 1000;
/** The ONLY source of JSON-RPC ids in this file. Never called from a default parameter. */
function nextId() { return ++ID_SEQ; }

class HarnessBug extends Error {}

/** Re-parse the bytes that went on the wire and prove the asserted id was in them. */
function sentId(sentBodyText) {
  let parsed;
  try { parsed = JSON.parse(sentBodyText); } catch { return undefined; }
  if (Array.isArray(parsed)) return undefined;
  return parsed && Object.prototype.hasOwnProperty.call(parsed, 'id') ? parsed.id : undefined;
}

/**
 * The R20a guard. Asserts, in this order:
 *   1. the id we are about to assert about was actually serialised into the request bytes;
 *   2. the response echoes it.
 * A violation of (1) is a HARNESS BUG, never a server FAIL.
 */
function expectId(sent, res, id) {
  const on = sentId(sent.body);
  if (on !== id) {
    throw new HarnessBug(
      'asserted id ' + JSON.stringify(id) + ' was never on the wire (request carried ' +
      JSON.stringify(on) + '). This is the R20a defect class.');
  }
  if (!res.json || typeof res.json !== 'object') {
    throw new Error('response is not a JSON-RPC object (' + brief(res) + ')');
  }
  if (res.json.id !== id) {
    throw new Error('response id ' + JSON.stringify(res.json.id) + ' != request id ' + JSON.stringify(id));
  }
}

// ------------------------------------------------------------------ HTTP

function brief(res) {
  const t = (res.text || '').replace(/\s+/g, ' ').slice(0, 180);
  return 'HTTP ' + res.status + ' ct=' + JSON.stringify(res.headers['content-type'] || '') + ' body=' + JSON.stringify(t);
}

/**
 * Raw HTTP. `headers` is written with the EXACT key casing given. `body` is a string or
 * undefined; it is sent verbatim, including on methods a client library would refuse to
 * put a body on. Returns { status, headers, text, json, frames, sent }.
 */
function send(ctx, { method = 'POST', path, headers = {}, body }) {
  const target = path === undefined ? ctx.path : path;
  const out = { ...headers };
  if (body !== undefined && out['Content-Length'] === undefined) {
    out['Content-Length'] = String(Buffer.byteLength(body, 'latin1'));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: ctx.host, port: ctx.port, path: target, method, agent: false, headers: out },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try { json = text.length ? JSON.parse(text) : null; } catch { json = null; }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            bytes: buf,
            json,
            frames: parseSse(text),
            sent: { method, path: target, headers: out, body: body === undefined ? '' : body }
          });
        });
      });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    if (body !== undefined) req.write(Buffer.from(body, 'latin1'));
    req.end();
  });
}

/** Every `data:` payload of an SSE body, parsed. Empty when the body is not SSE-framed. */
function parseSse(text) {
  if (!/(^|\n)data:/.test(text)) return [];
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!lines.length) continue;
    const payload = lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    try { out.push(JSON.parse(payload)); } catch { out.push({ __unparsed: payload }); }
  }
  return out;
}

/** The standard per-request envelope. */
function envelope(extra) {
  return {
    [META_VER]: SPEC,
    [META_INFO]: { name: 'mcp2026-conformance', version: '1.0.0' },
    [META_CAPS]: {},
    ...(extra || {})
  };
}

/** Default header set. Values, not names, are what the server compares -- names are ours. */
function headersFor(ctx, method, name, extra) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': SPEC,
    'Mcp-Method': method
  };
  if (ctx.token) h['Authorization'] = 'Bearer ' + ctx.token;
  if (name !== undefined && name !== null) h['Mcp-Name'] = name;
  Object.assign(h, extra || {});
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  return h;
}

/**
 * Send one JSON-RPC request. `id` is REQUIRED and has no default -- that absence is the
 * structural half of the R20a guard. Pass `id: null` deliberately for a notification.
 */
function rpc(ctx, opts) {
  if (!Object.prototype.hasOwnProperty.call(opts, 'id')) {
    throw new HarnessBug('rpc() called without an explicit id (R20a guard)');
  }
  const { id, method, params, headerName, headers, omit } = opts;
  const body = { jsonrpc: '2.0', method };
  if (id !== null) body.id = id;
  body.params = params === undefined ? { _meta: envelope() } : params;
  const h = headersFor(ctx, method, headerName === undefined ? undefined : headerName, headers);
  for (const k of (omit || [])) {
    for (const key of Object.keys(h)) if (key.toLowerCase() === k.toLowerCase()) delete h[key];
  }
  return send(ctx, { headers: h, body: JSON.stringify(body) });
}

// ------------------------------------------------------------------ assertions

function fail(msg) { throw new Error(msg); }
function want(cond, msg) { if (!cond) fail(msg); }

function wantStatus(res, expected) {
  want(res.status === expected, 'expected HTTP ' + expected + ', got ' + brief(res));
}
function jsonRpcErrorOf(res) {
  const m = res.json && !Array.isArray(res.json) ? res.json : null;
  return m && m.error && typeof m.error === 'object' ? m.error : null;
}
function wantError(res, code) {
  const e = jsonRpcErrorOf(res);
  want(e !== null, 'expected a JSON-RPC error response, got ' + brief(res));
  want(e.code === code, 'expected error code ' + code + ', got ' + JSON.stringify(e.code) + ' (' + brief(res) + ')');
  return e;
}
function resultOf(res) {
  const m = res.json && !Array.isArray(res.json) ? res.json : null;
  if (m && m.result && typeof m.result === 'object') return m.result;
  const last = res.frames.length ? res.frames[res.frames.length - 1] : null;
  if (last && last.result && typeof last.result === 'object') return last.result;
  fail('expected a JSON-RPC result, got ' + brief(res));
}
function wantComplete(res) {
  const r = resultOf(res);
  want(r.resultType === 'complete',
    'expected resultType "complete", got ' + JSON.stringify(r.resultType) + ' (' + brief(res) + ')');
  return r;
}

// Every response the run observes is recorded so the corpus-wide checks (never emit
// -32002; never emit an undefined code from the reserved sub-range) have something to
// look at that is not their own single probe.
const CORPUS = [];
function record(res) { CORPUS.push(res); return res; }
async function probe(ctx, opts) { return record(await rpc(ctx, opts)); }
async function raw(ctx, opts) { return record(await send(ctx, opts)); }

function everyErrorCode() {
  const codes = [];
  for (const res of CORPUS) {
    const msgs = [];
    if (res.json) msgs.push(res.json);
    for (const f of res.frames) msgs.push(f);
    for (const m of msgs) {
      if (m && !Array.isArray(m) && m.error && typeof m.error.code === 'number') codes.push(m.error.code);
      if (Array.isArray(m)) for (const x of m) if (x && x.error && typeof x.error.code === 'number') codes.push(x.error.code);
    }
  }
  return codes;
}

// ------------------------------------------------------------------ discovering the tools

/** tools/list once, cached, so the tool-dependent checks share one view. */
async function toolList(ctx) {
  if (ctx._tools) return ctx._tools;
  const id = nextId();
  const res = await probe(ctx, { id, method: 'tools/list' });
  let tools = [];
  try {
    const r = resultOf(res);
    if (Array.isArray(r.tools)) tools = r.tools;
  } catch { tools = []; }
  ctx._tools = tools;
  return tools;
}
/** The first tool carrying an x-mcp-header annotation, with that annotation's details. */
async function headerTool(ctx) {
  for (const t of await toolList(ctx)) {
    const props = t && t.inputSchema && t.inputSchema.properties;
    if (!props || typeof props !== 'object') continue;
    for (const p of Object.keys(props)) {
      const decl = props[p];
      if (decl && typeof decl['x-mcp-header'] === 'string' && decl['x-mcp-header']) {
        return { tool: t.name, param: p, header: 'Mcp-Param-' + decl['x-mcp-header'] };
      }
    }
  }
  return null;
}
/** A tool with no x-mcp-header annotations at all, safe to call without extra headers. */
async function plainTool(ctx) {
  for (const t of await toolList(ctx)) {
    const props = (t && t.inputSchema && t.inputSchema.properties) || {};
    let annotated = false;
    for (const p of Object.keys(props)) if (props[p] && props[p]['x-mcp-header']) annotated = true;
    if (!annotated) return t.name;
  }
  const all = await toolList(ctx);
  return all.length ? all[0].name : null;
}

class Skip extends Error {}
function skip(reason) { throw new Skip(reason); }
async function moduleOnly(ctx) {
  if (ctx._moduleOnly !== undefined) return ctx._moduleOnly;
  const id = nextId();
  const res = await rpc(ctx, { id, method: 'server/discover' });
  ctx._moduleOnly = String(res.headers[MODULE_ONLY_HEADER] || '') === MODULE_ONLY_VALUE;
  return ctx._moduleOnly;
}

// ========================================================================================
// THE CHECKS. `ref` names the requirement in CONFORMANCE.md that the check proves.
// ========================================================================================

const CHECKS = [];
function check(id, ref, title, fn) { CHECKS.push({ id, ref, title, fn }); }

check('C01', 'R2,R3', 'Origin present and invalid is answered HTTP 403', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', headers: { Origin: 'http://rebind.invalid' } });
  wantStatus(res, 403);
});

check('C02', 'R1', 'POST on the MCP endpoint answers a JSON-RPC response', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover' });
  wantStatus(res, 200);
  expectId(res.sent, res, id);
  want(res.json.result !== undefined, 'expected a result member, got ' + brief(res));
});

check('C03', 'R10,R16', 'A POST with no MCP-Protocol-Version header is rejected 400 + -32020', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', omit: ['MCP-Protocol-Version'] });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C04', 'R9,R16', 'MCP-Protocol-Version disagreeing with _meta is rejected 400 + -32020', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'server/discover',
    params: { _meta: envelope({ [META_VER]: '2025-11-25' }) }
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C05', 'R13,R16', 'A missing Mcp-Method header is rejected 400 + -32020', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', omit: ['Mcp-Method'] });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C06', 'R14,R16', 'Mcp-Method disagreeing with the body method is rejected 400 + -32020', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', headers: { 'Mcp-Method': 'tools/list' } });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C07', 'R13,R16', 'A missing Mcp-Name on tools/call is rejected 400 + -32020', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so tools/call cannot be exercised');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() },
    omit: ['Mcp-Name']
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C08', 'R14,R16', 'Mcp-Name disagreeing with params.name is rejected 400 + -32020', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so tools/call cannot be exercised');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() },
    headerName: name + '_WRONG'
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C09', 'R17', 'A Base64-sentinel Mcp-Name is DECODED before it is compared', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so tools/call cannot be exercised');
  const id = nextId();
  const encoded = '=?base64?' + Buffer.from(name, 'utf8').toString('base64') + '?=';
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() },
    headerName: encoded
  });
  wantStatus(res, 200);
  wantComplete(res);
});

check('C10', 'R19', 'Header NAMES are matched case-insensitively', async (ctx) => {
  const id = nextId();
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: envelope() } });
  const h = {
    'content-TYPE': 'application/json',
    'ACCEPT': 'application/json, text/event-stream',
    'mCp-PrOtOcOl-VeRsIoN': SPEC,
    'MCP-METHOD': 'server/discover'
  };
  if (ctx.token) h['AUTHORIZATION'] = 'Bearer ' + ctx.token;
  const res = await raw(ctx, { headers: h, body });
  wantStatus(res, 200);
  expectId(res.sent, res, id);
  wantComplete(res);
});

check('C11', 'R11,R26', 'An unsupported protocol version is 400 + -32022 listing supported versions', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'server/discover',
    params: { _meta: envelope({ [META_VER]: '1900-01-01' }) },
    headers: { 'MCP-Protocol-Version': '1900-01-01' }
  });
  wantStatus(res, 400);
  const e = wantError(res, -32022);
  want(e.data && Array.isArray(e.data.supported) && e.data.supported.length > 0,
    'expected data.supported to be a non-empty array, got ' + JSON.stringify(e.data));
  want(e.data.requested === '1900-01-01',
    'expected data.requested to echo the requested version, got ' + JSON.stringify(e.data.requested));
});

check('C12', 'R12', 'An unimplemented RPC method is HTTP 404 with JSON-RPC -32601', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'nonexistent/method' });
  wantStatus(res, 404);
  wantError(res, -32601);
  expectId(res.sent, res, id);
});

check('C13', 'R4', 'An accepted notification is 202 Accepted with NO body', async (ctx) => {
  const res = await probe(ctx, {
    id: null, method: 'notifications/progress',
    params: { progressToken: 'tok-1', progress: 1, _meta: envelope() }
  });
  wantStatus(res, 202);
  want(res.text === '', 'expected an empty body on 202, got ' + JSON.stringify(res.text.slice(0, 120)));
});

check('C14', 'R5', 'A notification the server cannot accept gets an HTTP error status', async (ctx) => {
  const res = await probe(ctx, { id: null, method: 'notifications/not_a_real_notification' });
  want(res.status >= 400, 'expected an HTTP error status, got ' + brief(res));
});

check('C15', 'R6', 'Responses to requests are application/json or text/event-stream', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover' });
  const ct = String(res.headers['content-type'] || '');
  want(/^application\/json\b/.test(ct) || /^text\/event-stream\b/.test(ct),
    'expected application/json or text/event-stream, got ' + JSON.stringify(ct));
  const name = await plainTool(ctx);
  if (name) {
    const id2 = nextId();
    const res2 = await probe(ctx, {
      id: id2, method: 'tools/call',
      params: { name, arguments: {}, _meta: envelope() }, headerName: name
    });
    const ct2 = String(res2.headers['content-type'] || '');
    want(/^application\/json\b/.test(ct2) || /^text\/event-stream\b/.test(ct2),
      'tools/call answered Content-Type ' + JSON.stringify(ct2));
  }
});

check('C16', 'F13', 'A JSON array (batch) body is rejected: JSONRPCMessage admits no array', async (ctx) => {
  const idA = nextId();
  const idB = nextId();
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: idA, method: 'server/discover', params: { _meta: envelope() } },
    { jsonrpc: '2.0', id: idB, method: 'tools/list', params: { _meta: envelope() } }
  ]);
  const res = await raw(ctx, { headers: headersFor(ctx, 'server/discover'), body });
  want(res.status >= 400, 'expected an HTTP error status for a batch body, got ' + brief(res));
  const arr = Array.isArray(res.json) ? res.json : null;
  want(arr === null, 'server answered a batch with an ARRAY response: batching was removed');
  want(jsonRpcErrorOf(res) !== null, 'expected a JSON-RPC error body, got ' + brief(res));
});

check('C17', 'R20', 'params._meta absent is 400 + -32602', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', params: {} });
  wantStatus(res, 400);
  wantError(res, -32602);
});

check('C18', 'R20', 'params._meta without the protocolVersion field is 400 + -32602', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'server/discover',
    params: { _meta: { [META_CAPS]: {}, [META_INFO]: { name: 'x', version: '1' } } }
  });
  wantStatus(res, 400);
  wantError(res, -32602);
});

check('C19', 'R20', 'params._meta without clientCapabilities is 400 + -32602', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'server/discover',
    params: { _meta: { [META_VER]: SPEC, [META_INFO]: { name: 'x', version: '1' } } }
  });
  wantStatus(res, 400);
  wantError(res, -32602);
});

check('C20', 'R22', 'EVERY result carries resultType', async (ctx) => {
  const seen = [];
  for (const method of ['server/discover', 'tools/list']) {
    const id = nextId();
    const res = await probe(ctx, { id, method });
    const r = resultOf(res);
    seen.push(method + '=' + JSON.stringify(r.resultType));
    want(typeof r.resultType === 'string' && r.resultType.length > 0,
      method + ' returned a result with no resultType (' + brief(res) + ')');
  }
  const name = await plainTool(ctx);
  if (name) {
    const id = nextId();
    const res = await probe(ctx, {
      id, method: 'tools/call',
      params: { name, arguments: {}, _meta: envelope() }, headerName: name
    });
    const r = resultOf(res);
    seen.push('tools/call=' + JSON.stringify(r.resultType));
    want(typeof r.resultType === 'string' && r.resultType.length > 0,
      'tools/call returned a result with no resultType (' + brief(res) + ')');
  }
  return seen.join(' ');
});

check('C21', 'R23', 'Responses echo the request id exactly: integer, string and 2^53-1', async (ctx) => {
  const intId = nextId();
  const r1 = await probe(ctx, { id: intId, method: 'server/discover' });
  expectId(r1.sent, r1, intId);

  const strId = 'conf-' + nextId();
  const r2 = await probe(ctx, { id: strId, method: 'server/discover' });
  expectId(r2.sent, r2, strId);

  const bigId = 9007199254740991;
  const r3 = await probe(ctx, { id: bigId, method: 'server/discover' });
  expectId(r3.sent, r3, bigId);
  return 'int, string and 2^53-1 all echoed';
});

check('C22', 'R24', 'Error objects carry an INTEGER code and a message string', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'nonexistent/method' });
  const e = jsonRpcErrorOf(res);
  want(e !== null, 'expected a JSON-RPC error response, got ' + brief(res));
  want(typeof e.code === 'number' && Number.isInteger(e.code),
    'error code is not an integer: ' + JSON.stringify(e.code));
  want(typeof e.message === 'string' && e.message.length > 0,
    'error has no message string: ' + JSON.stringify(e.message));
});

check('C23', 'R25', 'server/discover is implemented and lists supportedVersions', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover' });
  wantStatus(res, 200);
  const r = wantComplete(res);
  want(Array.isArray(r.supportedVersions) && r.supportedVersions.length > 0,
    'supportedVersions is not a non-empty array: ' + JSON.stringify(r.supportedVersions));
  for (const v of r.supportedVersions) want(typeof v === 'string', 'supportedVersions holds a non-string');
  want(r.capabilities && typeof r.capabilities === 'object', 'capabilities is missing or not an object');
  return 'supportedVersions=' + JSON.stringify(r.supportedVersions);
});

check('C24', 'S6', 'Results identify the server in _meta["…/serverInfo"]', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover' });
  const r = resultOf(res);
  const info = r._meta && r._meta[META_SERVER];
  want(info && typeof info === 'object', 'result._meta lacks ' + META_SERVER + ' (' + brief(res) + ')');
  want(typeof info.name === 'string' && typeof info.version === 'string',
    'serverInfo lacks name/version: ' + JSON.stringify(info));
  want(r.serverInfo === undefined, 'serverInfo must live in _meta, not at the top level of DiscoverResult');
});

check('C25', 'R28,R29', 'server/discover carries caching hints: ttlMs >= 0 and a valid cacheScope', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover' });
  const r = wantComplete(res);
  want(Number.isInteger(r.ttlMs) && r.ttlMs >= 0, 'ttlMs is not an integer >= 0: ' + JSON.stringify(r.ttlMs));
  want(r.cacheScope === 'public' || r.cacheScope === 'private',
    'cacheScope is not "public" or "private": ' + JSON.stringify(r.cacheScope));
});

check('C26', 'R28,R29', 'tools/list carries caching hints: ttlMs >= 0 and a valid cacheScope', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'tools/list' });
  const r = wantComplete(res);
  want(Number.isInteger(r.ttlMs) && r.ttlMs >= 0, 'ttlMs is not an integer >= 0: ' + JSON.stringify(r.ttlMs));
  want(r.cacheScope === 'public' || r.cacheScope === 'private',
    'cacheScope is not "public" or "private": ' + JSON.stringify(r.cacheScope));
});

check('C27', 'R45,R51', 'tools/list returns Tool objects whose inputSchema is an object, never null', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'tools/list' });
  const r = wantComplete(res);
  want(Array.isArray(r.tools), 'result.tools is not an array: ' + JSON.stringify(r.tools));
  for (const t of r.tools) {
    want(t && typeof t.name === 'string' && t.name.length > 0, 'a tool has no string name: ' + JSON.stringify(t));
    want(t.inputSchema !== null && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema),
      'tool ' + JSON.stringify(t.name) + ' has a non-object inputSchema: ' + JSON.stringify(t.inputSchema));
  }
  return r.tools.length + ' tool(s)';
});

check('C28', 'S7', 'tools/list ordering is deterministic across identical requests', async (ctx) => {
  const names = [];
  for (let i = 0; i < 3; i++) {
    const id = nextId();
    const res = await probe(ctx, { id, method: 'tools/list' });
    const r = resultOf(res);
    want(Array.isArray(r.tools), 'result.tools is not an array');
    names.push(r.tools.map((t) => String(t && t.name)).join('|'));
  }
  want(names[0] === names[1] && names[1] === names[2],
    'tools/list order varied across identical requests: ' + JSON.stringify(names));
  return names[0] || '(empty list)';
});

check('C29', 'R18', 'Mcp-Param-{Name} omitted while the value IS in the body is rejected -32020', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R18 is unexercisable');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: { [ht.param]: 'us-west1' }, _meta: envelope() },
    headerName: ht.tool
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C30', 'R18', 'Mcp-Param-{Name} disagreeing with the body value is rejected -32020', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R18 is unexercisable');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: { [ht.param]: 'us-west1' }, _meta: envelope() },
    headerName: ht.tool,
    headers: { [ht.header]: 'eu-central1' }
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C31', 'R15', 'Mcp-Param-{Name} carrying a raw non-ASCII octet is rejected -32020', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R15 is unexercisable');
  const id = nextId();
  // 0xE9 is a legal HTTP field-value octet but is outside printable US-ASCII, so it had
  // to arrive Base64-sentinel-encoded. Un-encoded, it is invalid on its face.
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: { [ht.param]: 'é' }, _meta: envelope() },
    headerName: ht.tool,
    headers: { [ht.header]: 'é' }
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C32', 'R18', 'Mcp-Param-{Name} sent while the parameter is ABSENT from the body is rejected', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R18 is unexercisable');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: {}, _meta: envelope() },
    headerName: ht.tool,
    headers: { [ht.header]: 'us-west1' }
  });
  wantStatus(res, 400);
  wantError(res, -32020);
});

check('C33', 'R45', 'tools/call on an advertised tool completes with content', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so tools/call cannot be exercised');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() }, headerName: name
  });
  wantStatus(res, 200);
  const r = wantComplete(res);
  want(Array.isArray(r.content), 'tool result has no content array: ' + JSON.stringify(Object.keys(r)));
});

check('C34', 'F11', 'An unknown tool is -32602, never the retired -32002', async (ctx) => {
  const id = nextId();
  const bogus = 'no_such_tool_' + id;
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: bogus, arguments: {}, _meta: envelope() }, headerName: bogus
  });
  const e = jsonRpcErrorOf(res);
  want(e !== null, 'expected a JSON-RPC error for an unknown tool, got ' + brief(res));
  want(e.code !== -32002, '-32002 is retired on this revision and MUST NOT be emitted');
  want(e.code === -32602, 'expected -32602 for an unknown tool, got ' + JSON.stringify(e.code));
});

check('C35', 'F11', 'No response anywhere in the run carries -32002 or -32042', async (ctx) => {
  const id = nextId();
  await probe(ctx, { id, method: 'resources/read', params: { uri: 'file:///nope', _meta: envelope() }, headerName: 'file:///nope' });
  const bad = everyErrorCode().filter((c) => c === -32002 || c === -32042);
  want(bad.length === 0, 'retired code(s) observed: ' + JSON.stringify(bad));
  return everyErrorCode().length + ' error code(s) observed, none retired';
});

check('C36', 'F10', 'No undefined code from the reserved sub-range -32020..-32099 is emitted', async (ctx) => {
  const defined = [-32020, -32021, -32022];
  const bad = everyErrorCode().filter((c) => c <= -32020 && c >= -32099 && defined.indexOf(c) === -1);
  want(bad.length === 0, 'undefined reserved code(s) observed: ' + JSON.stringify([...new Set(bad)]));
  return 'codes seen: ' + JSON.stringify([...new Set(everyErrorCode())].sort((a, b) => a - b));
});

check('C37', 'S9', 'No response mints or echoes Mcp-Session-Id', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', headers: { 'Mcp-Session-Id': 'client-supplied-session' } });
  for (const r of CORPUS) {
    want(r.headers['mcp-session-id'] === undefined,
      'a response carried Mcp-Session-Id: ' + JSON.stringify(r.headers['mcp-session-id']));
  }
  wantStatus(res, 200);
  wantComplete(res);
});

check('C38', 'S10', 'Last-Event-ID is ignored: streams are not resumable', async (ctx) => {
  const idA = nextId();
  const plain = await probe(ctx, { id: idA, method: 'server/discover' });
  const idB = nextId();
  const withLei = await probe(ctx, { id: idB, method: 'server/discover', headers: { 'Last-Event-ID': '42' } });
  want(plain.status === withLei.status,
    'Last-Event-ID changed the HTTP status (' + plain.status + ' -> ' + withLei.status + ')');
  const a = JSON.stringify(resultOf(plain));
  const b = JSON.stringify(resultOf(withLei));
  want(a === b, 'Last-Event-ID changed the result body, so the server implements resumption');
});

check('C39', 'S8', 'GET on the MCP endpoint is 405 Method Not Allowed', async (ctx) => {
  if (await moduleOnly(ctx)) {
    skip('endpoint-scope: the module under test has no HTTP method routing; GET/DELETE are ' +
      'answered by control-plane/src/index.ts (app.get("/mcp") -> 405)');
  }
  const h = ctx.token ? { Authorization: 'Bearer ' + ctx.token } : {};
  const res = await raw(ctx, { method: 'GET', headers: h });
  wantStatus(res, 405);
});

check('C40', 'S8', 'DELETE on the MCP endpoint is 405 Method Not Allowed', async (ctx) => {
  if (await moduleOnly(ctx)) {
    skip('endpoint-scope: the module under test has no HTTP method routing; GET/DELETE are ' +
      'answered by control-plane/src/index.ts (app.delete("/mcp") -> 405)');
  }
  const h = ctx.token ? { Authorization: 'Bearer ' + ctx.token } : {};
  const res = await raw(ctx, { method: 'DELETE', headers: h });
  wantStatus(res, 405);
});

check('C41', 'F1,S5', 'No independent JSON-RPC REQUEST is written on a response stream', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so no response stream can be opened');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() }, headerName: name
  });
  if (!res.frames.length) return 'answered as a single JSON object; no stream to inspect';
  for (const f of res.frames) {
    const isRequest = f && typeof f.method === 'string' && f.id !== undefined;
    want(!isRequest, 'the stream carried a server-initiated JSON-RPC request: ' + JSON.stringify(f).slice(0, 160));
  }
  const last = res.frames[res.frames.length - 1];
  want(last && (last.result !== undefined || last.error !== undefined),
    'the final SSE frame is not the JSON-RPC response (S5): ' + JSON.stringify(last).slice(0, 160));
  return res.frames.length + ' frame(s), response last';
});

check('C42', 'R21,F6', 'A request declaring empty clientCapabilities either completes or returns a well-formed -32021', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'server/discover',
    params: { _meta: { [META_VER]: SPEC, [META_CAPS]: {} } }
  });
  const e = jsonRpcErrorOf(res);
  if (e) {
    want(e.code === -32021, 'expected either a result or -32021, got code ' + JSON.stringify(e.code));
    wantStatus(res, 400);
    want(e.data && e.data.requiredCapabilities && typeof e.data.requiredCapabilities === 'object',
      '-32021 must carry data.requiredCapabilities, got ' + JSON.stringify(e.data));
    return 'declined with a well-formed -32021';
  }
  wantComplete(res);
  return 'completed without requiring an undeclared capability';
});

check('C43', 'F16', 'resultType "input_required" never appears on a method that does not support MRTR', async (ctx) => {
  for (const method of ['server/discover', 'tools/list']) {
    const id = nextId();
    const res = await probe(ctx, { id, method });
    const r = resultOf(res);
    want(r.resultType !== 'input_required',
      method + ' returned an InputRequiredResult; MRTR is limited to prompts/get, resources/read and tools/call');
  }
});

check('C44', 'F9', 'No notifications/message is emitted for a request that carried no logLevel', async (ctx) => {
  const name = await plainTool(ctx);
  if (!name) skip('the server advertises no tools, so no response stream can be opened');
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name, arguments: {}, _meta: envelope() }, headerName: name
  });
  for (const f of res.frames) {
    want(!(f && f.method === 'notifications/message'),
      'notifications/message was emitted for a request with no io.modelcontextprotocol/logLevel');
  }
  return res.frames.length + ' frame(s), none a log message';
});

check('C45', 'R32,F15', 'subscriptions/listen is either acknowledged first or declined -32601', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, {
    id, method: 'subscriptions/listen',
    params: { notifications: { toolsListChanged: true }, _meta: envelope() }
  });
  const e = jsonRpcErrorOf(res);
  if (e) {
    want(e.code === -32601, 'expected -32601 when subscriptions are not implemented, got ' + JSON.stringify(e.code));
    wantStatus(res, 404);
    return 'declined -32601 (permitted: no listChanged and no resources.subscribe is declared)';
  }
  want(res.frames.length > 0, 'subscriptions/listen must answer an SSE stream, got ' + brief(res));
  const first = res.frames[0];
  want(first && first.method === 'notifications/subscriptions/acknowledged',
    'the first message on the stream is not the acknowledgement: ' + JSON.stringify(first).slice(0, 160));
  want(first.params && first.params._meta && first.params._meta[META_SUB] !== undefined,
    'the acknowledgement does not carry ' + META_SUB);
  return 'acknowledged first';
});

check('C46', 'R39', 'A non-ASCII argument round-trips as UTF-8', async (ctx) => {
  const tools = await toolList(ctx);
  let target = null;
  for (const t of tools) {
    const props = (t && t.inputSchema && t.inputSchema.properties) || {};
    for (const p of Object.keys(props)) {
      const d = props[p];
      if (d && d.type === 'string' && !d['x-mcp-header']) { target = { name: t.name, param: p }; break; }
    }
    if (target) break;
  }
  if (!target) skip('no advertised tool takes a plain string parameter, so a UTF-8 round trip is unexercisable');
  const probeText = 'Hello, 世界 éè';
  const id = nextId();
  const bodyText = JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: target.name, arguments: { [target.param]: probeText }, _meta: envelope() }
  });
  const buf = Buffer.from(bodyText, 'utf8');
  const h = headersFor(ctx, 'tools/call', target.name, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length)
  });
  const res = await raw(ctx, { headers: h, body: buf.toString('latin1') });
  wantStatus(res, 200);
  wantComplete(res);
  const asUtf8 = res.bytes.toString('utf8');
  want(asUtf8.indexOf(probeText) !== -1,
    'the non-ASCII argument did not survive the round trip: ' + JSON.stringify(asUtf8.slice(0, 200)));
});

check('C47', 'A1', 'An unauthenticated request is 401 with a WWW-Authenticate resource_metadata challenge', async (ctx) => {
  const id = nextId();
  const h = headersFor({ ...ctx, token: null }, 'server/discover');
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: envelope() } });
  const res = await raw(ctx, { headers: h, body });
  wantStatus(res, 401);
  const wa = String(res.headers['www-authenticate'] || '');
  want(/^Bearer\b/.test(wa), 'expected a Bearer challenge, got WWW-Authenticate: ' + JSON.stringify(wa));
  want(/resource_metadata="[^"]+"/.test(wa),
    'the challenge does not carry resource_metadata, so RFC 9728 discovery cannot start: ' + JSON.stringify(wa));
  return wa.slice(0, 90);
});

check('C48', 'A2', 'The protected resource metadata document is served and names its resource', async (ctx) => {
  if (await moduleOnly(ctx)) {
    skip('endpoint-scope: the .well-known/oauth-protected-resource document is served by ' +
      'control-plane/src/index.ts, not by the module under test');
  }
  const res = await raw(ctx, { method: 'GET', path: '/.well-known/oauth-protected-resource' });
  wantStatus(res, 200);
  want(res.json && typeof res.json === 'object', 'the metadata document is not JSON: ' + brief(res));
  want(typeof res.json.resource === 'string' && res.json.resource.length > 0,
    'the metadata document has no "resource" member: ' + JSON.stringify(Object.keys(res.json || {})));
});

check('C49', 'R23,F4', 'An error the server cannot attribute to a request omits id rather than sending id:null', async (ctx) => {
  const id = nextId();
  const res = await probe(ctx, { id, method: 'server/discover', headers: { Origin: 'http://rebind.invalid' } });
  const m = res.json && !Array.isArray(res.json) ? res.json : null;
  want(m !== null && m.error !== undefined,
    'expected a JSON-RPC error response body on the rejected request, got ' + brief(res));
  const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
  want(!hasId || typeof m.id === 'string' || typeof m.id === 'number',
    'the error response carries "id": ' + JSON.stringify(m.id) + '. RequestId is string|number and the ' +
    'transport says such a body "has no id"; null is neither a RequestId nor an absent member.');
});

check('C50', 'R18', 'An annotated parameter sent as null with NO header completes: null is not "provided"', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R18 is unexercisable');
  const id = nextId();
  // [SHTTP] scenario table row 2: "Parameter value is `null` | Client MUST omit the header |
  // Server MUST NOT expect the header". The header is deliberately ABSENT and the request
  // MUST still complete. This is the direction a rejection-only suite cannot see: a server
  // that treats null as "provided" answers a spurious -32020 to a client that obeyed the
  // spec exactly, and every green rejection check stays green while it does so.
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: { [ht.param]: null }, _meta: envelope() },
    headerName: ht.tool
  });
  wantStatus(res, 200);
  wantComplete(res);
  return ht.header + ' correctly not expected for a null-valued ' + ht.param;
});

check('C51', 'R18', 'An annotated parameter ABSENT from arguments with no header completes', async (ctx) => {
  const ht = await headerTool(ctx);
  if (!ht) skip('no advertised tool carries an x-mcp-header annotation, so R18 is unexercisable');
  const id = nextId();
  // [SHTTP] scenario table row 3: "Parameter not in arguments | Client MUST omit the header |
  // Server MUST NOT expect the header". This row was previously credited to C33, which calls
  // a tool carrying NO annotation at all -- so the annotation loop never executed and the
  // check could not have failed for this reason. A check that cannot fail is not a check.
  const res = await probe(ctx, {
    id, method: 'tools/call',
    params: { name: ht.tool, arguments: {}, _meta: envelope() },
    headerName: ht.tool
  });
  wantStatus(res, 200);
  wantComplete(res);
  return ht.header + ' correctly not expected when ' + ht.param + ' is absent';
});

check('C52', 'F8', 'The modern path emits NO code from the legacy sub-range -32000..-32019', async (ctx) => {
  // THE FALLBACK TRAP, ASSERTED RATHER THAN MERELY PRINTED. [BASE] Error Codes: new
  // implementations "SHOULD NOT use codes from this sub-range at all", and receivers "MUST
  // NOT assume any specific meaning for these codes". [SHTTP] Backward Compatibility turns
  // that into a live failure for a DUAL-ERA deployment: a client falls back to `initialize`
  // unless the body is "a recognized modern JSON-RPC error". So a -32000 leaking out of the
  // MODERN branch would silently demote every dual-era client to the 2025 era and the server
  // would look perfectly healthy while doing it.
  //
  // Every response in CORPUS was produced by a request carrying a modern claim. The two era
  // checks below deliberately drive LEGACY requests and deliberately do NOT record, because
  // the legacy branch's grandfathered -32000 is correct there and would poison this corpus.
  const bad = everyErrorCode().filter((c) => c <= -32000 && c >= -32019);
  want(bad.length === 0, 'legacy sub-range code(s) emitted on the modern path: ' +
    JSON.stringify([...new Set(bad)]));
  return everyErrorCode().length + ' modern-path error code(s), none in -32000..-32019';
});

check('C53', 'R11,R26', 'An UNKNOWN FUTURE revision named in the header alone is answered -32022, not legacy', async (ctx) => {
  const id = nextId();
  // [VER] Terminology: "Modern: protocol versions that convey version, identity, and
  // capabilities as per-request metadata (revision 2026-07-28 AND LATER)". A future revision
  // is therefore a MODERN-era request by definition, and [VER] Protocol Version Negotiation
  // requires that a version the server does not implement -- "whether the version is UNKNOWN
  // to the server, or is a known version the server has chosen not to support" -- is answered
  // 400 + UnsupportedProtocolVersionError listing what we do support.
  //
  // The header carries it ALONE, with no _meta claim in the body. That is the case an era
  // router built on an allowlist of implemented revisions gets wrong: it sees a version it
  // does not know, calls the request legacy, and answers an implementation-defined error that
  // sends a modern client all the way back to `initialize`.
  const res = await rpc(ctx, {
    id, method: 'server/discover',
    params: { _meta: { [META_CAPS]: {} } },
    headers: { 'MCP-Protocol-Version': '2099-12-31' }
  });
  wantStatus(res, 400);
  const e = wantError(res, -32022);
  want(e.data && Array.isArray(e.data.supported) && e.data.supported.length > 0,
    'expected data.supported to be a non-empty array, got ' + JSON.stringify(e.data));
  return 'future revision routed modern; supported=' + JSON.stringify(e.data.supported);
});

check('C54', 'S11', 'A LEGACY revision named in the header alone is NOT served modernly', async (ctx) => {
  // THE DISCRIMINATING CONTROL FOR C53, and the reason the fix above is a date THRESHOLD
  // rather than "any revision-shaped header is modern". [VER] Terminology puts 2025-11-25 and
  // earlier in the legacy era, and the compatibility matrix requires Legacy client / Dual-era
  // server to WORK. 2025-06-18 through 2025-11-25 clients send MCP-Protocol-Version too, so a
  // router that promoted them would hand today's traffic a -32020 -- a RECOGNISED modern error
  // -- and a dual-era client would stop falling back, "correct" an already-correct request and
  // deadlock, while a pure legacy client, which has no fall-forward mechanism at all, dies.
  //
  // Both legs are asserted, because the failure this exists to catch is the two eras becoming
  // INDISTINGUISHABLE: asserting only that the answers differ would pass against a server that
  // answered both wrongly in two different ways.
  const legacyRes = await rpc(ctx, {
    id: nextId(), method: 'tools/list',
    params: { _meta: { [META_CAPS]: {} } },
    headers: { 'MCP-Protocol-Version': '2025-06-18' }
  });
  const modernRes = await rpc(ctx, {
    id: nextId(), method: 'tools/list',
    params: { _meta: { [META_CAPS]: {} } },
    headers: { 'MCP-Protocol-Version': SPEC }
  });
  // The modern leg: an envelope with no protocolVersion is malformed, and [BASE] fixes the
  // answer exactly -- "the server MUST reject it with JSON-RPC error code -32602 ... On HTTP,
  // the response status MUST be 400 Bad Request".
  want(modernRes.status === 400,
    'the modern leg must be 400, got ' + brief(modernRes));
  const me = jsonRpcErrorOf(modernRes);
  want(me && me.code === -32602,
    'the modern leg must be -32602, got ' + JSON.stringify(me && me.code) + ' (' + brief(modernRes) + ')');
  // The legacy leg: it must NOT have been served by the modern branch. A code from the MCP
  // reserved sub-range is the signature of that branch, and a 400 carrying one is precisely
  // what makes a dual-era client stop falling back.
  const le = jsonRpcErrorOf(legacyRes);
  const modernCoded = le && typeof le.code === 'number' && le.code <= -32020 && le.code >= -32099;
  want(!modernCoded,
    'a legacy-revision header was answered with the reserved-range code ' +
    JSON.stringify(le && le.code) + ', i.e. served modernly (' + brief(legacyRes) + ')');
  want(legacyRes.status !== 400,
    'a legacy-revision header was answered HTTP 400, which a dual-era client reads as a modern ' +
    'server (' + brief(legacyRes) + ')');
  return 'legacy leg HTTP ' + legacyRes.status + ' code ' + JSON.stringify(le && le.code) +
    ' | modern leg HTTP 400 -32602';
});

// ========================================================================================
// THE HOST. Stands control-plane/src/mcp2026.ts up on a localhost port so the checks drive
// the exact bytes the module emits. It supplies ONLY what the module takes as injected
// dependencies -- serverInfo, ttlMs, cacheScope, the origin policy, identity, the tool set
// -- plus the era router, copied from index.ts. It deliberately implements NOTHING that
// lives in index.ts: no GET/DELETE routing, no protected-resource-metadata document. Those
// surfaces are declared absent with the module-only header so the checks that cover them
// SKIP with the owner named, instead of passing against a harness re-implementation.
// ========================================================================================

const HOST_TOKEN = 'conformance-host-token';

const HOST_TOOLS = [
  {
    name: 'aaa_echo',
    description: 'Echo the text back. Exercises the tools/call happy path and the UTF-8 round trip.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    call: async (a) => ({ content: [{ type: 'text', text: 'echo: ' + String(a && a.text) }] })
  },
  {
    name: 'hdr_tool',
    description: 'Carries an x-mcp-header annotation so R15/R18 header mirroring is exercisable.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } },
    call: async (a) => ({ content: [{ type: 'text', text: 'region=' + String(a && a.region) }] })
  },
  {
    name: 'zzz_last',
    description: 'A third tool, named so that insertion order and sorted order differ.',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ content: [{ type: 'text', text: 'ok' }] })
  }
];

async function startHost(modulePath) {
  let mod;
  try {
    mod = await import(modulePath);
  } catch (e) {
    if (String(e && e.message).indexOf('Unknown file extension') !== -1 ||
        String(e && e.code) === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error(
        'this node cannot import a .ts module directly. Re-run as:\n' +
        '  node --experimental-strip-types ' + process.argv[1] + ' --host ' + modulePath + '\n' +
        '(node >= 23.6, including the node:24-slim build image, needs no flag).');
    }
    throw e;
  }
  const { mcp2026Handle, mcp2026IsModernRequest } = mod;
  if (typeof mcp2026Handle !== 'function' || typeof mcp2026IsModernRequest !== 'function') {
    throw new Error('module ' + modulePath + ' does not export mcp2026Handle / mcp2026IsModernRequest');
  }

  // Reproduced from index.ts: the legacy branch's answer to an unroutable request. Its
  // code is -32000, which is implementation-defined and therefore NOT a recognised modern
  // error -- which is precisely why a dual-era client falls back to `initialize`.
  const legacyAnswer = (body) => {
    const one = (m) => {
      if (m && m.method === 'initialize') {
        return {
          jsonrpc: '2.0', id: m.id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'paracoding', version: '1.0.0' } }
        };
      }
      if (m && m.id === undefined) return null;
      return { jsonrpc: '2.0', id: m && m.id !== undefined ? m.id : null,
        error: { code: -32000, message: 'Bad Request: Server not initialized' } };
    };
    if (Array.isArray(body)) {
      const out = body.map(one).filter((x) => x !== null);
      return { status: out.length ? 200 : 202, body: out.length ? JSON.stringify(out) : '' };
    }
    const r = one(body);
    return r === null ? { status: 202, body: '' } : { status: 200, body: JSON.stringify(r) };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const host = String(req.headers['host'] || '127.0.0.1');
      res.setHeader(MODULE_ONLY_HEADER, MODULE_ONLY_VALUE);
      if (req.method !== 'POST') {
        // NOT reproduced here on purpose: index.ts owns GET/DELETE on /mcp.
        res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_hosted_by_module' }));
        return;
      }
      let body;
      const rawText = Buffer.concat(chunks).toString('utf8');
      try { body = rawText.length ? JSON.parse(rawText) : {}; } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      // ===================== THE ERA ROUTER, as in index.ts =====================
      if (!mcp2026IsModernRequest(req.headers, body)) {
        const a = legacyAnswer(body);
        res.writeHead(a.status, a.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {});
        res.end(a.body);
        return;
      }
      let out;
      try {
        out = await mcp2026Handle({ headers: req.headers, body }, {
          serverInfo: { name: 'paracoding', version: '1.0.0' },
          instructions: 'Paracoding fleet control plane.',
          ttlMs: 60000,
          cacheScope: 'private',
          resourceMetadataUrl: 'http://' + host + '/.well-known/oauth-protected-resource',
          originAllowed: (o) => { try { return new URL(o).host === host; } catch { return false; } },
          identity: async () => {
            const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
            if (!m || m[1] !== HOST_TOKEN) return { kind: 'challenge' };
            return { kind: 'role', role: 'fleet-security' };
          },
          tools: async () => HOST_TOOLS
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
        return;
      }
      if (out.sse) {
        res.writeHead(out.status, out.headers);
        for (const f of out.sse) res.write('data: ' + JSON.stringify(f) + '\n\n');
        res.end();
        return;
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body === undefined ? '' : out.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, port, token: HOST_TOKEN };
}

// ========================================================================================
// THE STUB. A DELIBERATELY NON-CONFORMING server, and the oracle for every check above.
//
// Each violation below is numbered and names the requirement it breaks. --selftest runs
// the entire suite against this server and demands that EVERY check report FAIL: a suite
// that goes green against a broken server proves nothing about a real one, and this fleet
// has shipped that defect more than once.
//
//   V1  Answers HTTP 200 to everything, whatever the request said.        breaks R3 R4 R5 R11 R12 R16 R20 A1 S8
//   V2  Sets Mcp-Session-Id on every response.                            breaks S9
//   V3  Answers Content-Type: text/plain always.                          breaks R6
//   V4  Echoes id + 1000 instead of the request id.                       breaks R23
//   V5  Omits resultType, except tools/list which claims input_required.  breaks R22 F16
//   V6  Never emits _meta["…/serverInfo"].                                breaks S6
//   V7  server/discover: supportedVersions is a STRING, no cache hints.   breaks R25 R28 R29
//   V8  tools/list: ttlMs -5, cacheScope "maybe", one inputSchema null,
//       and the order is reshuffled on every call.                        breaks R28 R29 R45 R51 S7
//   V9  tools/call: an SSE-framed body containing a notifications/message
//       frame, an independent server->client JSON-RPC REQUEST frame, and
//       a final input_required result carrying neither inputRequests nor
//       requestState.                                                     breaks F1 F9 R46 R45
//   V10 Validates no header at all: missing or mismatched
//       MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-* all pass. breaks R9 R10 R13 R14 R16 R18 R15
//   V11 Looks header names up CASE-SENSITIVELY and rejects any other
//       spelling with -32020.                                             breaks R19
//   V12 Rejects a Base64-sentinel Mcp-Name instead of decoding it.        breaks R17
//   V13 Unknown methods: 200 with error.code as the STRING "-32601" and
//       no message member.                                                breaks R12 R24
//   V14 Unsupported protocol version: error code -32055, an UNDEFINED
//       code from the range reserved for the specification.               breaks R11 F10
//   V15 Unknown tool: the retired -32002.                                 breaks F11
//   V16 Answers differently when Last-Event-ID is present.                breaks S10
//   V17 subscriptions/listen: neither an acknowledgement nor -32601.      breaks R32 F15
//   V18 Never echoes call arguments, so nothing round-trips as UTF-8.     breaks R39
//   V19 /.well-known/oauth-protected-resource: 200 text/plain, not JSON.  breaks A2
//   V20 Accepts an array (batch) body with a 200 result.                  breaks F13
//   V21 Answers notifications 200 with a body instead of 202 empty.       breaks R4 R5
//   V22 Never challenges: an unauthenticated request gets 200.            breaks A1
//   V23 Answers GET and DELETE with 200.                                  breaks S8
//   V24 Never emits an attributable-id-less error at all, so the C49
//       probe has no error response to inspect.                           breaks R23 F4
// ========================================================================================

let STUB_FLIP = 0;

function stubBody(req, parsed, rawText) {
  const hdr = (n) => {
    for (const k of Object.keys(req.headers)) if (k.toLowerCase() === n) return String(req.headers[k]);
    return null;
  };
  const id = parsed && !Array.isArray(parsed) && parsed.id !== undefined ? parsed.id : null;
  const echo = typeof id === 'number' ? id + 1000 : String(id) + '-stub';   // V4
  const method = parsed && !Array.isArray(parsed) ? parsed.method : null;

  // V11: header names are matched case-SENSITIVELY.
  const rawKeys = req.rawHeaders.filter((_, i) => i % 2 === 0);
  const misspelt = rawKeys.some((k) =>
    (k.toLowerCase() === 'mcp-protocol-version' && k !== 'MCP-Protocol-Version') ||
    (k.toLowerCase() === 'mcp-method' && k !== 'Mcp-Method'));
  if (misspelt) return { jsonrpc: '2.0', id: echo, error: { code: -32020, message: 'unknown header spelling' } };

  // V16: Last-Event-ID resumes.
  if (hdr('last-event-id') !== null) return { jsonrpc: '2.0', id: echo, result: { resumed: true } };

  // V12: a Base64-sentinel Mcp-Name is rejected, never decoded.
  const mcpName = hdr('mcp-name');
  if (mcpName && mcpName.startsWith('=?base64?')) {
    return { jsonrpc: '2.0', id: echo, error: { code: -32020, message: 'encoded names not supported' } };
  }

  // V20: an array body is accepted.
  if (Array.isArray(parsed)) return { jsonrpc: '2.0', id: 0, result: { batched: parsed.length } };

  // V21: a notification gets a body.
  if (id === null) return { jsonrpc: '2.0', id: null, result: { accepted: true } };

  // V14: an unsupported version gets an undefined reserved code.
  const v = hdr('mcp-protocol-version');
  if (v !== null && v !== SPEC) return { jsonrpc: '2.0', id: echo, error: { code: -32055, message: 'bad version' } };

  if (method === 'server/discover') {
    return { jsonrpc: '2.0', id: echo, result: { supportedVersions: SPEC, capabilities: { tools: {} } } };  // V7
  }
  if (method === 'tools/list') {
    STUB_FLIP++;
    const tools = [
      { name: 'stub_broken', description: 'inputSchema is null', inputSchema: null },
      { name: 'hdr_tool', description: 'annotated',
        inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } },
      { name: 'aaa_echo', description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
    ];
    if (STUB_FLIP % 2 === 0) tools.reverse();                                                   // V8
    return { jsonrpc: '2.0', id: echo,
      result: { resultType: 'input_required', tools, ttlMs: -5, cacheScope: 'maybe' } };        // V5 V8
  }
  if (method === 'tools/call') {
    const name = parsed.params && parsed.params.name;
    if (name !== 'aaa_echo' && name !== 'hdr_tool' && name !== 'stub_broken') {
      return { jsonrpc: '2.0', id: echo, error: { code: -32002, message: 'no such tool' } };    // V15
    }
    return '__SSE__';                                                                          // V9
  }
  if (method === 'subscriptions/listen') return { jsonrpc: '2.0', id: echo, result: { listening: true } };  // V17
  return { jsonrpc: '2.0', id: echo, error: { code: '-32601' } };                               // V13
}

function makeStub() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = String(req.url || '/');
      const head = { 'Content-Type': 'text/plain; charset=utf-8', 'Mcp-Session-Id': 'stub-session-1' }; // V2 V3
      if (url.indexOf('/.well-known/oauth-protected-resource') === 0) {
        res.writeHead(200, head);                                                               // V19
        res.end('this is not a metadata document');
        return;
      }
      if (req.method !== 'POST') { res.writeHead(200, head); res.end('ok'); return; }           // V23
      const rawText = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = rawText.length ? JSON.parse(rawText) : null; } catch { parsed = null; }
      const out = stubBody(req, parsed, rawText);                                               // V1 V10 V22
      if (out === '__SSE__') {
        const id = parsed && parsed.id !== undefined ? parsed.id : null;
        const echo = typeof id === 'number' ? id + 1000 : String(id) + '-stub';
        res.writeHead(200, head);
        res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message',
          params: { level: 'info', data: 'unsolicited log line' } }) + '\n\n');
        res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage',
          params: { messages: [] } }) + '\n\n');
        res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: echo,
          result: { resultType: 'input_required' } }) + '\n\n');
        res.end();
        return;
      }
      res.writeHead(200, head);
      res.end(JSON.stringify(out));
    });
  });
  return server;
}

async function startStub(port) {
  const server = makeStub();
  await new Promise((r) => server.listen(port || 0, '127.0.0.1', r));
  return { server, port: server.address().port, token: 'stub-token' };
}

// ========================================================================================
// RUNNER
// ========================================================================================

const PAD = (s, n) => (s + ' '.repeat(n)).slice(0, n);

// ========================================================================================
// REVIEWED SEAT-SCOPED SKIPS, and why an unlisted skip is a HOLE that fails the run.
//
// A SKIP is an assertion that did not happen. Counted next to the passes and then forgotten,
// it is indistinguishable from a green -- which is exactly how a check stops being a check.
// Every skip must therefore be either (a) listed here, naming WHO owns the surface, WHICH
// seat can exercise it and the EXACT command that does, or (b) a HOLE.
//
// These three are NOT unexercisable. They are unexercisable FROM THE `--host` SEAT, because
// that seat stands up control-plane/src/mcp2026.ts alone and the module deliberately owns no
// HTTP method routing and serves no metadata document. The harness could trivially answer
// them itself and go green; it refuses to, because that would prove a property of the harness
// rather than of the deployment. Run the endpoint seat and all three execute.
//
// Nothing may be added here to quiet a red. A requirement that no seat can reach must say so
// in its own reason and carry NO command, and the reviewer of that line is on the hook for it.
//
// WHICH DEPLOYMENT IS THE ENDPOINT SEAT, stated concretely so nobody has to rediscover it.
// It is the DEPLOYED MCP SERVICE: one Cloud Run service running the whole control-plane
// image, which is the only place index.ts's routes exist at all. install.sh prints its URL
// as the MCP URL when it finishes -- that URL plus /mcp is the target, and the bearer is an
// MCP token minted for that same deployment. Both routes and the metadata document are
// served by that one service, so a single invocation discharges all three checks.
// Repeating the --host seat cannot ever discharge them, however many times it is run: the
// module it stands up does not contain the routes, so the skip is a property of the seat.
const ENDPOINT_SEAT_CMD = 'node conformance.mjs "$MCP_URL/mcp" --token "$MCP_TOKEN"';

// `proven` is the last recorded run ON THAT SEAT, or null for never. It is printed with
// every skip, because "skipped here but proven elsewhere" and "never asserted by anybody"
// are different states and reading them as the same one is how a requirement quietly stops
// being covered. All three are null: no endpoint-seat run has ever been recorded, so these
// three requirements have never been asserted against any deployment. That is not a reason
// to relax them -- the harness could answer them itself and go green, and it refuses to,
// because that would prove a property of the harness rather than of the deployment.
const REVIEWED_SKIPS = {
  C39: { owner: 'control-plane/src/index.ts  app.get("/mcp") -> 405',
         seat: 'endpoint', cmd: ENDPOINT_SEAT_CMD, proven: null },
  C40: { owner: 'control-plane/src/index.ts  app.delete("/mcp") -> 405',
         seat: 'endpoint', cmd: ENDPOINT_SEAT_CMD, proven: null },
  C48: { owner: 'control-plane/src/index.ts  app.get("/.well-known/oauth-protected-resource")',
         seat: 'endpoint', cmd: ENDPOINT_SEAT_CMD, proven: null }
};

async function runAll(ctx, { selftest }) {
  const rows = [];
  for (const c of CHECKS) {
    let row;
    try {
      const note = await c.fn(ctx);
      row = { ...c, outcome: 'PASS', note: note || '' };
    } catch (e) {
      if (e instanceof HarnessBug) row = { ...c, outcome: 'BUG', note: e.message };
      else if (e instanceof Skip) row = { ...c, outcome: 'SKIP', note: e.message };
      else row = { ...c, outcome: 'FAIL', note: String(e && e.message ? e.message : e) };
    }
    rows.push(row);
    console.log(PAD(row.id, 5) + PAD(row.outcome, 6) + PAD('[' + row.ref + ']', 12) + row.title +
      (row.note ? '\n            -> ' + row.note : ''));
  }

  const n = (o) => rows.filter((r) => r.outcome === o).length;
  const total = rows.length;
  console.log('');
  console.log('total ' + total + '  pass ' + n('PASS') + '  fail ' + n('FAIL') +
    '  skip ' + n('SKIP') + '  harness-bug ' + n('BUG'));

  if (n('BUG') > 0) {
    console.log('\nHARNESS BUG in: ' + rows.filter((r) => r.outcome === 'BUG').map((r) => r.id).join(', '));
    return 2;
  }
  if (selftest) {
    const unfailed = rows.filter((r) => r.outcome !== 'FAIL');
    if (unfailed.length) {
      console.log('\nSELFTEST FAILED. These checks did not FAIL against the deliberately');
      console.log('non-conforming stub, so they prove nothing about a real server:');
      for (const r of unfailed) console.log('  ' + r.id + ' ' + r.outcome + '  ' + r.title);
      return 1;
    }
    console.log('\nSELFTEST OK: all ' + total + ' checks failed against the stub, each for its own reason.');
    return 0;
  }
  if (n('FAIL') > 0) {
    console.log('\nFAILURES: ' + rows.filter((r) => r.outcome === 'FAIL').map((r) => r.id).join(', '));
    return 1;
  }

  // ---- skips are adjudicated, never merely counted. -----------------------------------
  const skips = rows.filter((r) => r.outcome === 'SKIP');
  const holes = skips.filter((r) => !REVIEWED_SKIPS[r.id]);
  if (skips.length) {
    console.log('\nCOVERAGE NOT PROVEN BY THIS SEAT -- ' + skips.length + ' requirement(s) went unasserted.');
    console.log('A skip is an assertion that did not happen. These are named so a green run');
    console.log('cannot be mistaken for a complete one:');
    for (const r of skips) {
      const rv = REVIEWED_SKIPS[r.id];
      console.log('  ' + r.id + '  [' + r.ref + ']  ' + r.title);
      if (rv) {
        console.log('        owner : ' + rv.owner);
        console.log('        seat  : ' + rv.seat + (rv.cmd ? '  ->  ' + rv.cmd : '  ->  NO SEAT CAN EXERCISE THIS'));
        console.log('        proven: ' + (rv.proven ||
          'NEVER -- no run on that seat is on record, so this requirement has not been asserted by anyone'));
      } else {
        console.log('        UNREVIEWED: ' + r.note);
      }
    }
  }
  if (holes.length) {
    console.log('\nHOLE: ' + holes.map((r) => r.id).join(', ') + ' skipped without a reviewed reason.');
    console.log('Add the check to REVIEWED_SKIPS naming the owner and the seat that exercises it,');
    console.log('or make it run. An unexplained skip is a requirement nobody is answering for.');
    return 11;
  }
  return 0;
}

function parseTarget(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), path: u.pathname || '/' };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.indexOf(f) !== -1;
  const valueOf = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

  if (has('--stub')) {
    const s = await startStub(Number(valueOf('--port') || 0));
    console.log('non-conforming stub listening on http://127.0.0.1:' + s.port + '/mcp');
    return -1;
  }

  let ctx = null;
  let stop = null;
  let selftest = false;

  if (has('--selftest')) {
    selftest = true;
    const s = await startStub(0);
    ctx = { ...parseTarget('http://127.0.0.1:' + s.port + '/mcp'), token: s.token };
    stop = () => s.server.close();
    console.log('# --selftest: every check MUST fail against the non-conforming stub (127.0.0.1:' + s.port + ')');
  } else if (has('--host')) {
    const p = valueOf('--host');
    if (!p) { console.error('--host needs a module path'); return 2; }
    const abs = p.startsWith('/') ? p : new URL(p, 'file://' + process.cwd() + '/').pathname;
    const h = await startHost(abs);
    ctx = { ...parseTarget('http://127.0.0.1:' + h.port + '/mcp'), token: h.token };
    stop = () => h.server.close();
    console.log('# --host ' + abs + ' on 127.0.0.1:' + h.port);
  } else {
    const url = argv.find((a) => /^https?:\/\//.test(a));
    if (!url) {
      console.error('usage: conformance.mjs <baseUrl> | --host <mcp2026.ts> | --selftest | --stub');
      return 2;
    }
    ctx = { ...parseTarget(url), token: valueOf('--token') || process.env.MCP_BEARER || null };
    console.log('# target ' + url);
  }

  console.log('# MCP revision ' + SPEC + ' -- server-side conformance, ' + CHECKS.length + ' checks');
  console.log('');
  const code = await runAll(ctx, { selftest });
  if (stop) stop();
  return code;
}

main().then((code) => { if (code >= 0) process.exit(code); }, (e) => {
  console.error('harness error: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
