// SPDX-License-Identifier: Apache-2.0
// ============================ [MCP2026-DUAL-ERA-V1] ============================
// The MODERN half of a dual-era MCP endpoint: revision 2026-07-28 (per-request
// metadata, stateless) served on the SAME POST /mcp that keeps answering the
// 2025-era `initialize` handshake through @modelcontextprotocol/sdk 1.29.0.
//
// EVERYTHING IN THIS FILE IS THE MODERN BRANCH. Nothing here may be reached by a
// legacy request, and index.ts must never call any of it above the era router.
// That is the review invariant from DUAL-ERA.md §5, restated as a file boundary:
// -32020 / -32021 / -32022 and HTTP 404 / 405 / 406 appear ONLY in this file.
//
// WHY THE LEGACY -32000 IS NOT TOUCHED. Our legacy path answers an unroutable
// request with {"code":-32000,"message":"Bad Request: Server not initialized"}.
// -32000..-32019 is the spec's implementation-defined/legacy sub-range, so a
// dual-era client does NOT recognise it as a modern error and falls back to
// `initialize` -- which is exactly why the operator's connector works today.
// It looks like a code smell and it is load-bearing. DUAL-ERA.md B10.
//
// ROUTING IS A PURE FUNCTION OF ONE REQUEST'S BYTES. No connection state, no
// cache, no clock, no per-instance flag: [VER] tells clients to cache the era
// for the lifetime of the origin, so two identical requests that landed on
// different eras would make a client pin the wrong one for its whole process.
// DUAL-ERA.md B7.
//
// STATE OF THE SDK v2 WIRING, RECORDED HONESTLY. @modelcontextprotocol/server
// 2.0.0 is installed and proven to load (src/mcp2.ts asserts createMcpHandler is
// a function at boot; the build gate prints its resolved .cjs path). It is NOT on
// the request path yet. Its real entry point is
//     createMcpHandler(factory: McpServerFactory, options?: CreateMcpHandlerOptions)
//     CreateMcpHandlerOptions = { legacy?: 'stateless'|'reject', onerror?, responseMode?,
//                                 bus?, maxSubscriptions?, keepAliveMs? }
// and the documented way to keep OUR legacy deployment alive beside it is
// `isLegacyRequest(request)` in front of a `legacy: 'reject'` handler -- i.e. the
// era router below, with this file's dispatch replaced by the SDK's. That swap is
// deliberately NOT made blind: registry.npmjs.org is 403 by org egress policy in
// the authoring container, so the package cannot be installed, executed or even
// read there, and the two reachable descriptions of the signature disagree.
// The Dockerfile now prints the installed arity and the verbatim
// CreateMcpHandlerOptions declaration at BUILD time, so the follow-up commit
// wires it against measured bytes instead of a web page.
// ==============================================================================

export const MCP2026_VERSION = '2026-07-28';
/** Revisions this endpoint serves MODERNLY. Membership here is what makes a bare
 *  MCP-Protocol-Version header select the modern era (decision table row 5). A
 *  legacy revision must NEVER appear in this array: 2025-06-18..2025-11-25 clients
 *  send that header too, and routing them modern turns the spec's
 *  Legacy -> Dual-era row from Works into Fails. DUAL-ERA.md B4. */
export const MCP2026_MODERN_VERSIONS: string[] = [MCP2026_VERSION];

const META_VER = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

// The three MCP-defined codes. -32020..-32099 is reserved for the specification and
// an UNDEFINED code from it is itself a violation ([BASE] Error Codes / F10), so
// this file allocates nothing else in that range.
const E_HEADER_MISMATCH = -32020;
const E_UNSUPPORTED_VERSION = -32022;
// JSON-RPC base codes, all outside both reserved sub-ranges.
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;

const NAMED_METHODS: string[] = ['tools/call', 'resources/read', 'prompts/get'];
const ACCEPTED_NOTIFICATIONS: string[] = ['notifications/progress', 'notifications/cancelled'];

export type Mcp2026Tool = {
  name: string;
  description: string;
  inputSchema: any;
  call: (args: any) => Promise<any>;
};
export type Mcp2026Identity =
  | { kind: 'role'; role: string }
  | { kind: 'deny'; text: string }
  | { kind: 'challenge' };
export type Mcp2026Deps = {
  serverInfo: { name: string; version: string };
  instructions?: string;
  ttlMs: number;
  cacheScope: string;
  resourceMetadataUrl: string;
  originAllowed: (origin: string) => boolean;
  identity: () => Promise<Mcp2026Identity>;
  tools: (role: string) => Promise<Mcp2026Tool[]>;
};
export type Mcp2026Input = {
  headers: any;
  body: any;
};
export type Mcp2026Response = {
  status: number;
  headers: { [k: string]: string };
  body?: string;
  /** SSE frames to write, in order, then close. Present INSTEAD of `body`. */
  sse?: any[];
};

// ------------------------------------------------------------------ the era router

function hasModernClaim(msg: any): boolean {
  const meta = msg && msg.params && msg.params._meta;
  return !!meta && typeof meta === 'object' && Object.prototype.hasOwnProperty.call(meta, META_VER);
}
/** [VER] Terminology, quoted: "**Modern**: protocol versions that convey version, identity,
 *  and capabilities as per-request metadata (revision `2026-07-28` AND LATER)"; "**Legacy**:
 *  protocol versions that establish a session with an `initialize` handshake (`2025-11-25`
 *  and earlier)". The era boundary the spec defines is therefore a DATE, not a list of the
 *  revisions we happen to implement.
 *
 *  This distinction is load-bearing in BOTH directions and an allowlist gets one of them
 *  wrong. Treating only MCP2026_MODERN_VERSIONS as modern sent an UNKNOWN FUTURE revision
 *  (say `2027-03-01`) down the LEGACY branch, where it collected -32000 at HTTP 200 -- not a
 *  recognised modern error -- so a modern client fell back to `initialize` and downgraded to
 *  2025-06-18 instead of being told what we support. The spec requires the opposite: "If the
 *  server does not implement the requested version (whether the version is UNKNOWN to the
 *  server, or is a known version the server has chosen not to support), it MUST respond with
 *  400 Bad Request and an UnsupportedProtocolVersionError listing its supported versions."
 *  Routing it modern is what lets the -32022 below ever be reached.
 *
 *  The shape guard is not decoration. MCP revisions are ISO `YYYY-MM-DD`, so a lexical
 *  compare IS a chronological one -- but only for strings of that shape. Without the regex,
 *  `banana` > `2026-07-28` in ASCII (letters sort above digits) and every garbage header
 *  value would be promoted to the modern era. */
const MCP_REVISION_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export function mcp2026IsModernRevision(value: string): boolean {
  const s = String(value).trim();
  if (MCP2026_MODERN_VERSIONS.indexOf(s) !== -1) return true;
  return MCP_REVISION_RE.test(s) && s >= MCP2026_VERSION;
}
function headerNamesModernRevision(headers: any): boolean {
  const h = hdr(headers, 'mcp-protocol-version');
  return h !== null && mcp2026IsModernRevision(h);
}

/**
 * THE ERA SELECTION RULE, entire. DUAL-ERA.md §1 and the decision table.
 *
 * A request is served MODERNLY if and only if it makes a modern VERSION CLAIM:
 * `params._meta["io.modelcontextprotocol/protocolVersion"]` is present at ANY
 * value (rows 3 and 4), or -- ONLY when that key is absent -- the
 * MCP-Protocol-Version header carries a revision DATED 2026-07-28 OR LATER, which
 * is what mcp2026IsModernRevision decides: a member of MCP2026_MODERN_VERSIONS
 * (row 5), OR a well-formed YYYY-MM-DD revision at or after MCP2026_VERSION that
 * this server does not implement (row 7b). Everything else is legacy: `initialize`
 * (row 1), a bare request with neither signal (row 6), a legacy batch (row 2), a
 * header value that is not revision-shaped AT ALL (row 7), and a header naming a
 * LEGACY revision (row 8, which is the load-bearing one).
 *
 * WHY THE HEADER TEST IS A DATE THRESHOLD AND NOT AN ALLOWLIST. This is the one
 * place the rule has already been wrong, so the reason is recorded rather than the
 * instruction. [VER] Terminology defines the eras by DATE -- "Modern: ... revision
 * 2026-07-28 AND LATER" -- so a revision this server has never heard of is a
 * modern-era request BY DEFINITION. The test used to ask only whether the header
 * value was in MCP2026_MODERN_VERSIONS, an allowlist holding exactly one string,
 * so an unknown FUTURE revision named in the header alone (row 7b) was routed
 * LEGACY. There it collected {"code":-32000} at HTTP 200, which sits in the spec's
 * implementation-defined sub-range and is therefore NOT a recognised modern error,
 * so per [SHTTP] Backward Compatibility the client fell back to `initialize` and
 * negotiated itself down to 2025-06-18 -- silently, with every check green, never
 * learning what we actually support. The spec requires the opposite: 400 plus
 * -32022 UnsupportedProtocolVersion listing supportedVersions. That answer exists
 * ONLY on the modern branch, which is why the defect was in the ROUTING rather than
 * in the error handling, and why widening this test is what fixed it.
 *
 * BOTH HALVES OF mcp2026IsModernRevision FAIL IN OPPOSITE DIRECTIONS. Neither is
 * redundant and neither may be simplified away:
 *   drop the YYYY-MM-DD shape guard -- `banana` sorts ABOVE `2026-07-28` in ASCII
 *     (letters above digits), so every garbage header value is promoted to modern
 *     and row 7 breaks.
 *   drop the >= threshold -- 2025-06-18 and 2025-11-25 are revision-shaped too, so
 *     the entire 2025-era client population is routed modern and row 8 breaks,
 *     which is the connector that works today.
 *
 * The body is read first because the body is the spec's source of truth, and
 * because a MALFORMED modern claim must be answered by the modern path with
 * -32602 rather than silently demoted to legacy.
 *
 * An array body is decided by its elements alone (rows 2 and 3): a legacy batch
 * stays legacy no matter what header rides along, and a batch with any modern
 * claim is modern so that this file can reject it with -32600 (F13).
 *
 * Mcp-Session-Id is NEVER an input here and is never minted or echoed.
 */
// [MCP2026-ERA-OBSERVED-V49] RECORD WHICH ERA EACH CLIENT ACTUALLY SPEAKS.
// This file has implemented dual-era selection since 2025-03-26 through 2027-03-01 and
// has never once said which era a real client chose. MEASURED 2026-08-15: a full day of
// paracoding-control-plane-mcp logs searched for protocolVersion, era= and initialize
// returned ZERO hits, and console.error appears zero times in this file. So the question
// the dual-era work exists to answer -- has the newer revision rolled out on the client
// side yet -- was not answerable from this fleet's own records, only guessed at. The
// handshake cannot be run by hand either: POST /mcp rejects a session key as a bearer by
// design, so there is no way to observe negotiation except from inside the server.
//
// ONE LINE PER DISTINCT COMBINATION, NOT PER REQUEST. Modern-era requests are stateless
// and carry their version claim on EVERY call, so logging each one would bury the signal
// in its own volume and bill for it. The key is era + claimed revision + client name and
// version, so a connector that reconnects all day writes one line, and a NEW surface or a
// rolled-out revision appears the first time it is seen -- which is exactly the event
// being waited for. The set is capped so a hostile or buggy client cannot grow it without
// bound; past the cap the decision is unaffected and only the logging stops.
//
// THE TRY/CATCH HERE IS CORRECT AND IS NOT THE ONE THE BUILD RULES FORBID. The rule is
// never to wrap a REGISTRATION or a LOAD in a catch that only logs, because that converts
// a broken deploy into a silent one. This is the opposite case: era selection is the hot
// path and observation is a side channel, so instrumentation must never be able to change
// a routing decision or fail a request. The return value is computed BEFORE this runs and
// is not reachable from it.
const MCP2026_ERA_SEEN: { [k: string]: boolean } = {};
let MCP2026_ERA_SEEN_N = 0;
const MCP2026_ERA_SEEN_CAP = 64;
function mcp2026ObserveEra(headers: any, body: any, modern: boolean): void {
  try {
    const one: any = Array.isArray(body) ? (body.length ? body[0] : {}) : (body || {});
    const params: any = (one && one.params) || {};
    const meta: any = params._meta || {};
    // [MCP-ERA-OFFERED-V60] THE HANDSHAKE WAS THE ONE REQUEST THIS COULD NOT READ, AND IT IS THE
    // ONLY ONE THAT ANSWERS "HAS THE NEW REVISION ROLLED OUT". Both sources below are absent on
    // `initialize` BY SPEC: the MCP-Protocol-Version header is sent on requests AFTER the
    // handshake, and _meta carries the version only in the 2026 shape. A classic initialize puts
    // it in params.protocolVersion, in the BODY, which this never looked at -- so every handshake
    // logged claimed=(none) and looked like a client that said nothing. MEASURED on a live
    // deployment 2026-08-15: 12 observations, every initialize '(none)', every
    // subsequent tools/call '2025-11-25'. The gap matters because a staged rollout shows up FIRST
    // in what a client OFFERS at handshake, which is exactly what was invisible.
    // Order is deliberate: _meta (2026 shape) beats the header beats the body. The body is the
    // fallback because it is the client's OFFER, while the header is what was actually agreed --
    // when both exist the agreed value is the truthful answer to "what era is this session".
    const offered = (one && one.method === 'initialize') ? String(params.protocolVersion || '') : '';
    const claimed = String(meta[META_VER] || hdr(headers, 'mcp-protocol-version') || offered || '(none)');
    const ci: any = params.clientInfo || {};
    const who = String(ci.name || '(no clientInfo)') + ' ' + String(ci.version || '');
    const method = String(one.method || '(none)');
    const era = modern ? 'modern' : 'legacy';
    const key = era + '|' + claimed + '|' + who + '|' + (method === 'initialize' ? 'init' : 'call');
    if (MCP2026_ERA_SEEN[key]) return;
    if (MCP2026_ERA_SEEN_N >= MCP2026_ERA_SEEN_CAP) return;
    MCP2026_ERA_SEEN[key] = true;
    MCP2026_ERA_SEEN_N++;
    console.error('[mcp-era] era=' + era + ' claimed=' + claimed + ' method=' + method
      + ' client=' + who + ' serverImplements=' + MCP2026_VERSION
      + ' (first time this combination has been seen by this instance)');
  } catch (e) { /* observation must never affect routing */ }
}
export function mcp2026IsModernRequest(headers: any, body: any): boolean {
  const modern = Array.isArray(body)
    ? body.some(hasModernClaim)
    : (hasModernClaim(body) || headerNamesModernRevision(headers));
  mcp2026ObserveEra(headers, body, modern);
  return modern;
}

// ------------------------------------------------------------------ small helpers

/** Header NAMES are case-insensitive (RFC 9110 / [SHTTP] Case Sensitivity); header
 *  VALUES such as method names are case-sensitive. Node lower-cases incoming names
 *  already, but this never assumes it. Returns null when absent. */
function hdr(headers: any, lowerName: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lowerName) {
      const v = headers[keys[i]];
      if (v === undefined || v === null) return null;
      return Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return null;
}

/** [SHTTP] Value Encoding. `=?base64?{Base64EncodedValue}?=`, markers lowercase and
 *  case-sensitive. Servers MUST decode before comparing to the body value (R17):
 *  comparing the raw header is the failure that makes every non-ASCII tool name
 *  unreachable behind a spurious -32020. */
export function mcp2026DecodeHeaderValue(v: string): string {
  if (typeof v !== 'string') return v;
  if (v.length < 12 || v.slice(0, 9) !== '=?base64?' || v.slice(-2) !== '?=') return v;
  const b64 = v.slice(9, v.length - 2);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return v;
  try { return Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { return v; }
}

/** S18: compare numerically when both sides are numbers, so 42 and 42.0 agree and
 *  do not produce a spurious -32020. Otherwise an exact, case-SENSITIVE compare. */
function valuesAgree(headerValue: string, bodyValue: any): boolean {
  if (bodyValue === undefined || bodyValue === null) return false;
  if (typeof bodyValue === 'number' || typeof bodyValue === 'boolean') {
    const n = Number(headerValue);
    if (typeof bodyValue === 'number' && headerValue.trim() !== '' && !isNaN(n)) return n === bodyValue;
    return headerValue === String(bodyValue);
  }
  return headerValue === String(bodyValue);
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** R23/F4. `JSONRPCErrorResponse.id?: RequestId` and `RequestId = string | number`;
 *  [BASE] says the ID MUST NOT be `null`, and [TRANS] describes the permitted body as
 *  "a JSON-RPC error response that has no `id`". An error this server cannot attribute
 *  to a request -- an invalid Origin, a rejected batch, an unknown notification --
 *  therefore OMITS the member entirely. `null` is neither a RequestId nor an absent
 *  member, and no placeholder id may be substituted for it: absence is what the spec
 *  asks for, and a fabricated id would be attributed to a request that never sent it. */
function jsonRpcError(id: any, code: number, message: string, data?: any): any {
  const err: any = { code: code, message: message };
  if (data !== undefined) err.data = data;
  const msg: any = { jsonrpc: '2.0' };
  if (id !== undefined && id !== null) msg.id = id;
  msg.error = err;
  return msg;
}
function errResponse(status: number, id: any, code: number, message: string, data?: any): Mcp2026Response {
  return {
    status: status,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(jsonRpcError(id, code, message, data))
  };
}
/** Every RESULT on this revision carries `resultType` ([BASE] Result Responses, R22)
 *  and identifies the server in `_meta` (S6). Declining to emit InputRequiredResult
 *  does NOT excuse either: `resultType` belongs to Result, not to MRTR. */
function completeResult(id: any, payload: any, deps: Mcp2026Deps): any {
  const meta: any = (payload && payload._meta) || {};
  meta[META_SERVER] = { name: deps.serverInfo.name, version: deps.serverInfo.version };
  return { jsonrpc: '2.0', id: id, result: { resultType: 'complete', ...payload, _meta: meta } };
}

// ------------------------------------------------------------------ the handler

/**
 * Serve ONE modern POST. Returns a fully-formed HTTP response description; the
 * caller writes it. Keeping the socket out of here is what lets the conformance
 * harness drive these exact bytes over a local port.
 */
export async function mcp2026Handle(input: Mcp2026Input, deps: Mcp2026Deps): Promise<Mcp2026Response> {
  const headers = input.headers || {};
  const body = input.body;

  // --- R2/R3: DNS-rebinding defence. An Origin that is PRESENT and invalid is 403.
  // An absent Origin is not an invalid one (server-to-server callers send none).
  const origin = hdr(headers, 'origin');
  if (origin !== null && origin !== '' && !deps.originAllowed(origin)) {
    return errResponse(403, null, E_INVALID_REQUEST, 'Forbidden origin');
  }

  // --- Authorization. 401 is not in the dual-era fallback trigger set, which is
  // correct: an unauthenticated caller has not told us anything about its era.
  const who = await deps.identity();
  if (who.kind === 'challenge') {
    return {
      status: 401,
      headers: { ...JSON_HEADERS, 'WWW-Authenticate': 'Bearer resource_metadata="' + deps.resourceMetadataUrl + '"' },
      body: JSON.stringify({ error: 'unauthorized' })
    };
  }

  const reqId = (body && !Array.isArray(body) && body.id !== undefined) ? body.id : null;

  // --- F13: batching was removed. "The body of the HTTP POST MUST be a single
  // JSON-RPC request or notification"; JSONRPCMessage has no array member. The
  // spec fixes no code for the server's rejection, so this is a recorded decision,
  // not a claim: 400 + -32600, id null. CONFORMANCE.md Ambiguity 1.
  if (Array.isArray(body)) {
    return errResponse(400, null, E_INVALID_REQUEST,
      'JSON-RPC batching was removed in 2026-07-28: the body must be a single request or notification');
  }
  if (!body || typeof body !== 'object' || typeof body.method !== 'string') {
    return errResponse(400, reqId, E_INVALID_REQUEST, 'Not a JSON-RPC request');
  }

  const method: string = body.method;
  const params: any = (body.params && typeof body.params === 'object' && !Array.isArray(body.params)) ? body.params : {};
  const isNotification = body.id === undefined;

  // --- Identity denial. A 200 + isError tool result is correct MCP on both eras,
  // but on THIS one it must carry resultType and echo the REAL request id, never 0.
  if (who.kind === 'deny') {
    return {
      status: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(completeResult(reqId, { content: [{ type: 'text', text: who.text }], isError: true }, deps))
    };
  }
  const role = who.role;

  // ---------------- header validation (R9,R10,R13,R14,R16,R17,R18,R19) ----------
  // ALL OF IT LIVES HERE, INSIDE THE MODERN BRANCH. Hoisting any of it in front of
  // the era router is DUAL-ERA.md B1: today's envelope-less traffic would collect a
  // -32020, a dual-era client would read that as a RECOGNISED MODERN ERROR, stop
  // falling back, "correct" the request, and deadlock -- while a pure legacy client,
  // which has no fall-forward mechanism at all, would simply die.
  const hVersion = hdr(headers, 'mcp-protocol-version');
  if (hVersion === null) {
    // Y2 declined: we do not silently treat an absent header as 2025-03-26.
    return errResponse(400, reqId, E_HEADER_MISMATCH,
      'MCP-Protocol-Version is REQUIRED on every POST to the MCP endpoint');
  }
  const hMethod = hdr(headers, 'mcp-method');
  if (hMethod === null) {
    return errResponse(400, reqId, E_HEADER_MISMATCH, 'Mcp-Method is REQUIRED on all requests');
  }
  if (mcp2026DecodeHeaderValue(hMethod) !== method) {
    return errResponse(400, reqId, E_HEADER_MISMATCH,
      'Mcp-Method header does not match the request body method');
  }
  const bodyMeta: any = (params._meta && typeof params._meta === 'object') ? params._meta : null;
  const bodyVersion: any = bodyMeta ? bodyMeta[META_VER] : undefined;
  if (bodyVersion !== undefined && String(hVersion) !== String(bodyVersion)) {
    // R9. A load balancer routing on the header while the server executes the body
    // is exactly the split-brain this rejection exists to prevent.
    return errResponse(400, reqId, E_HEADER_MISMATCH,
      'MCP-Protocol-Version header does not match the protocol version in the request body _meta');
  }
  if (NAMED_METHODS.indexOf(method) !== -1) {
    const hName = hdr(headers, 'mcp-name');
    const bodyName = params.name !== undefined ? params.name : params.uri;
    if (hName === null) {
      return errResponse(400, reqId, E_HEADER_MISMATCH, 'Mcp-Name is REQUIRED for ' + method);
    }
    if (!valuesAgree(mcp2026DecodeHeaderValue(hName), bodyName)) {
      return errResponse(400, reqId, E_HEADER_MISMATCH, 'Mcp-Name header does not match the request body');
    }
  }
  // CONFORMANCE.md Ambiguity 4: a stray Mcp-Name on a method that has no name or uri
  // has nothing to disagree with, so it is ignored rather than rejected.

  // --- R11: the version we were asked for, before anything is dispatched.
  if (MCP2026_MODERN_VERSIONS.indexOf(String(hVersion).trim()) === -1) {
    return errResponse(400, reqId, E_UNSUPPORTED_VERSION,
      'Unsupported protocol version', { supported: MCP2026_MODERN_VERSIONS.slice(), requested: String(hVersion) });
  }

  // ---------------- the per-request envelope (R20) -------------------------------
  // Ambiguity 3, decided: header ABSENT is a header failure (-32020, above);
  // header PRESENT with no _meta to match against is a malformed envelope (-32602).
  if (!bodyMeta) {
    return errResponse(400, reqId, E_INVALID_PARAMS,
      'params._meta is REQUIRED on this protocol revision and carries ' + META_VER + ' and ' + META_CAPS);
  }
  if (bodyMeta[META_VER] === undefined) {
    return errResponse(400, reqId, E_INVALID_PARAMS, 'params._meta is missing the required field ' + META_VER);
  }
  if (bodyMeta[META_CAPS] === undefined || typeof bodyMeta[META_CAPS] !== 'object' || bodyMeta[META_CAPS] === null) {
    return errResponse(400, reqId, E_INVALID_PARAMS, 'params._meta is missing the required field ' + META_CAPS);
  }
  // MRTR ACCEPTANCE WITHOUT MRTR EMISSION. A conforming client may legitimately
  // resend params.inputResponses / params.requestState -- some other hop produced
  // them -- and an unknown param must NOT become a -32602. We ignore both; because
  // this server never MINTS a requestState, there is nothing to verify and nothing
  // an attacker can forge into it. If we ever emit one it is HMAC-sealed (Y8).

  // ---------------- notifications (R4/R5) ----------------------------------------
  if (isNotification) {
    if (ACCEPTED_NOTIFICATIONS.indexOf(method) !== -1) {
      return { status: 202, headers: {} };            // 202 Accepted, NO body.
    }
    return errResponse(404, null, E_METHOD_NOT_FOUND, 'Unknown notification: ' + method);
  }

  // ---------------- dispatch ------------------------------------------------------
  if (method === 'server/discover') {
    // R25. Implementing this is a server MUST; CALLING it is only a client MAY.
    // serverInfo is NOT a top-level DiscoverResult field -- it lives in _meta (S6).
    const payload: any = {
      supportedVersions: MCP2026_MODERN_VERSIONS.slice(),
      capabilities: { tools: {} },
      ttlMs: deps.ttlMs,
      cacheScope: deps.cacheScope
    };
    if (deps.instructions) payload.instructions = deps.instructions;
    // S19/Y9 taken deliberately: TTL without listChanged. Declaring a change
    // notification we do not send is the worse failure of the two.
    return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(completeResult(reqId, payload, deps)) };
  }

  if (method === 'tools/list') {
    const tools = await deps.tools(role);
    // S7: deterministic order. The set is rebuilt per request from Firestore, so
    // without this sort the order is map-iteration order and every client tool-list
    // cache and LLM prompt cache misses.
    const listed = tools.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    return {
      status: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(completeResult(reqId, {
        tools: listed, ttlMs: deps.ttlMs, cacheScope: deps.cacheScope
      }, deps))
    };
  }

  if (method === 'tools/call') {
    const name = String(params.name === undefined ? '' : params.name);
    const args: any = (params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
    const tools = await deps.tools(role);
    let tool: Mcp2026Tool | null = null;
    for (let i = 0; i < tools.length; i++) if (tools[i].name === name) { tool = tools[i]; break; }
    if (!tool) {
      // Resource/tool-not-found is -32602 on this revision. -32002 is RETIRED and
      // MUST NOT be emitted (F11).
      return errResponse(400, reqId, E_INVALID_PARAMS, 'Unknown tool: ' + name);
    }
    // R18: Mcp-Param-{Name} mirroring. Declared by the tool's own inputSchema via
    // the x-mcp-header extension property. Y3 declines to ANNOTATE any parameter,
    // but the server-side validation is still a MUST, because a client may send the
    // header regardless -- including the case the spec calls out explicitly, where
    // the client omits the header but puts the value in the body.
    const headerErr = validateParamHeaders(headers, tool.inputSchema, args);
    if (headerErr) return errResponse(400, reqId, E_HEADER_MISMATCH, headerErr);

    let out: any;
    try {
      out = await tool.call(args);
    } catch (e: any) {
      // R41: a bad argument is a tool error, never an unhandled 500.
      out = { content: [{ type: 'text', text: 'Tool error: ' + String(e && e.message ? e.message : e) }], isError: true };
    }
    const result: any = (out && typeof out === 'object') ? out : { content: [{ type: 'text', text: String(out) }] };
    // Answered as a per-request SSE stream. [SHTTP] lets the server choose per
    // request; a tool call is the one exchange here that can take long enough to
    // want progress frames, and this is the path they will arrive on. The final
    // JSON-RPC response terminates the stream (S5). No notifications/message is
    // ever emitted, because no request carried io.modelcontextprotocol/logLevel (F9),
    // and NO server-initiated JSON-RPC request is ever written to it (F1/R40) --
    // declining MRTR means declining sampling, elicitation and roots entirely, it
    // does not license the old push channel.
    return {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      },
      sse: [completeResult(reqId, result, deps)]
    };
  }

  // R12, and the part everyone gets wrong is the STATUS. An unimplemented method is
  // HTTP 404 plus -32601; the JSON-RPC body is what distinguishes it from the 404 of
  // a legacy HTTP+SSE server that does not host a modern endpoint at all. A
  // 200-carrying--32601 fails this requirement.
  //
  // This is also where subscriptions/listen lands. [SUBS] never states implementing
  // it as a MUST and every requirement on it is conditional, so a server declaring
  // neither listChanged nor resources.subscribe may answer -32601 -- which is what we
  // do, deliberately, and its absence breaks nothing else.
  return errResponse(404, reqId, E_METHOD_NOT_FOUND, 'Method not found: ' + method);
}

/** R18. Walks the tool's own inputSchema for `x-mcp-header` annotations and holds
 *  the client to them in BOTH directions the spec names: a value present in the body
 *  with the header omitted is a non-conforming client the server MUST reject, and a
 *  header that disagrees with the body is the split-brain -32020 exists for. */
function validateParamHeaders(headers: any, inputSchema: any, args: any): string | null {
  const props = inputSchema && inputSchema.properties;
  if (!props || typeof props !== 'object') return null;
  const names = Object.keys(props);
  for (let i = 0; i < names.length; i++) {
    const decl = props[names[i]];
    const headerName = decl && typeof decl['x-mcp-header'] === 'string' ? decl['x-mcp-header'] : '';
    if (!headerName) continue;
    const bodyValue = args ? args[names[i]] : undefined;
    const raw = hdr(headers, ('Mcp-Param-' + headerName).toLowerCase());
    // [SHTTP] Server Behavior for Custom Headers, the scenario table, rows 2 and 3:
    //   "Parameter value is `null`      | Client MUST omit the header | Server MUST NOT expect the header"
    //   "Parameter not in arguments     | Client MUST omit the header | Server MUST NOT expect the header"
    // NULL AND ABSENT ARE THE SAME ROW HERE, and conflating null with "provided" is a
    // spurious -32020 fired at a client that did exactly what the spec told it to do. An
    // explicit null is how a client says "not provided" for a declared optional parameter,
    // so it is normal traffic rather than an edge case.
    if (bodyValue === undefined || bodyValue === null) {
      if (raw !== null) return 'Mcp-Param-' + headerName + ' was sent but ' + names[i] + ' is null or absent in the body';
      continue;
    }
    if (raw === null) return 'Mcp-Param-' + headerName + ' is REQUIRED when ' + names[i] + ' is present in the body';
    const decoded = mcp2026DecodeHeaderValue(raw);
    // "Servers MUST reject requests with a recognized Mcp-Param-{Name} header that
    // contains invalid characters": anything outside printable US-ASCII must have
    // arrived Base64-sentinel-encoded, so an un-encoded one is invalid on its face.
    if (raw === decoded && /[^\x20-\x7e]/.test(raw)) return 'Mcp-Param-' + headerName + ' contains characters that require Base64 encoding';
    if (!valuesAgree(decoded, bodyValue)) return 'Mcp-Param-' + headerName + ' does not match ' + names[i] + ' in the request body';
  }
  return null;
}
