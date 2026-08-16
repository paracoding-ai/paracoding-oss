<!-- SPDX-License-Identifier: Apache-2.0 -->
# CONFORMANCE.md — MCP revision 2026-07-28, server side

**Path:** `control-plane/mcp2026/CONFORMANCE.md`. This is the document
`control-plane/src/mcp2026.ts` cites as NORMATIVE. Its companions are
`control-plane/mcp2026/DUAL-ERA.md` (era selection and the ways to break fallback) and
`control-plane/mcp2026/conformance.mjs` (the runnable harness).

## What this is, and why it exists at all

Every NORMATIVE server-side requirement of MCP revision **2026-07-28**, as a numbered
checklist, each with the requirement sentence quoted **verbatim**, the section it comes
from, and the check that proves it.

It exists because it was missing. `control-plane/src/mcp2026.ts` has cited `CONFORMANCE.md`
and `DUAL-ERA.md` as normative since it landed, and neither file was ever in the repository:
they were written in a prior agent's container and vanished with it, along with
`conformance.mjs`. A reported result of "43 PASS / 1 FAIL / 6 SKIP" against a checklist
nobody can read, produced by a harness nobody can run, is not evidence. This document and
its harness are rebuilt **from the specification**, not recovered.

### Numbering, and the citations already in the source

`control-plane/src/mcp2026.ts` cites specific identifiers — R2, R3, R4, R5, R9, R10, R11,
R12, R13, R14, R16, R17, R18, R19, R20, R22, R25, R40, R41, F1, F9, F10, F11, F13, S5, S6,
S7, S18, S19, Y2, Y3, Y8, Y9, and Ambiguity 1, 3 and 4. The scheme is recoverable from the
source's own words even though the document was not: **R** = MUST, **F** = MUST NOT,
**S** = SHOULD, **Y** = MAY, **A** = authorization (optional feature), **B** = a way to
break dual-era fallback (those live in DUAL-ERA.md).

This rebuild assigns numbers so that **every identifier cited in `mcp2026.ts` names the
requirement its comment says it names**. Where the source gives no evidence for an
identifier, the assignment here is new. Two independent confirmations that the
reconstruction is right: the source's header-validation comment lists
`R9,R10,R13,R14,R16,R17,R18,R19` and *skips R15* — and R15 is the one requirement in that
run of the spec addressed to intermediaries rather than to origin servers, which this
server is not; and its `hdr()` helper cites "[SHTTP] Case Sensitivity", which is R19.

### Counts

| Group | Count |
| --- | --- |
| **MUST** (R1–R52) | 52 |
| **MUST NOT** (F1–F23) | 23 |
| **SHOULD** (S1–S25) | 25 |
| **MAY** (Y1–Y15) | 15 |
| **Authorization MUST/MUST NOT** (A1–A11) | 11 |

A prior compilation is reported to have found **45 server MUSTs and 16 MUST NOTs**. That
was used here as a sanity check, not as a target, and the difference is accounted for
rather than reconciled away: this compilation additionally counts the JSON-Schema-usage
requirements (R35–R38, F20), the four tool-security MUSTs (R41–R44), the MRTR detail MUSTs
(R46–R50), the logging content prohibition (F21), the caching access-control prohibition
(F22) and the authorization group (A1–A11, kept separate because Authorization is
**OPTIONAL** for MCP implementations). Excluding those groups yields 45 MUSTs and 16
MUST NOTs, which is the earlier figure. Nothing was dropped to make it fit.

### Sources (all quotes are from these pages, revision 2026-07-28)

| Tag | Page |
| --- | --- |
| `[BASE]` | `/specification/2026-07-28/basic/index` |
| `[TRANS]` | `/specification/2026-07-28/basic/transports` |
| `[SHTTP]` | `/specification/2026-07-28/basic/transports/streamable-http` |
| `[VER]` | `/specification/2026-07-28/basic/versioning` |
| `[DISC]` | `/specification/2026-07-28/server/discover` |
| `[TOOLS]` | `/specification/2026-07-28/server/tools` |
| `[CACHE]` | `/specification/2026-07-28/server/utilities/caching` |
| `[MRTR]` | `/specification/2026-07-28/basic/patterns/mrtr` |
| `[SUBS]` | `/specification/2026-07-28/basic/patterns/subscriptions` |
| `[LOG]` | `/specification/2026-07-28/server/utilities/logging` |
| `[AUTH]` | `/specification/2026-07-28/basic/authorization` |
| `[SCHEMA]` | `/specification/2026-07-28/schema` |
| `[CHANGE]` | `/specification/2026-07-28/changelog` |

Every requirement below was cross-checked against `[SCHEMA]`. Where the schema is stricter
or clearer than the prose, that is recorded on the requirement.

### Running the proof

```
node conformance.mjs --selftest                    # oracle first: 54/54 must FAIL
node conformance.mjs --host ../src/mcp2026.ts      # the module, on an ephemeral port
node conformance.mjs http://host:port/mcp --token T
```

`--selftest` runs the whole suite against a deliberately non-conforming stub server built
into the harness and exits non-zero if **any** check passes or is skipped. Run it first,
every time. A conformance suite that goes green against a broken server is worse than no
suite, because it launders an unproven claim into a number.

`P`, `S` and `—` in the *Proof* lines below mean: proved by the named check; proved only
in part (the check establishes the observable half); or not provable from the wire, with
the reason given.

---

## 1. MUST — R1–R52

### Streamable HTTP transport (R1–R19)

**R1** — `[SHTTP]` Overview — proof: **C02**
> "The server **MUST** provide a single HTTP endpoint path (hereafter referred to as the **MCP endpoint**) that supports POST."

C02 POSTs a well-formed modern request and requires a parseable JSON-RPC response carrying
a `result` and the request's own id.

**R2** — `[SHTTP]` Security & Endpoint — proof: **C01**
> "Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks."

**R3** — `[SHTTP]` Security & Endpoint — proof: **C01**
> "If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403 Forbidden. The HTTP response body **MAY** comprise a JSON-RPC *error response* that has no `id`."

C01 sends `Origin: http://rebind.invalid` on an otherwise valid request and requires HTTP
403. Note what R3 does **not** say: an *absent* Origin is not an invalid one, and
server-to-server callers send none. A harness that rejected an absent Origin would be
testing a requirement that does not exist.

**R4** — `[SHTTP]` Sending Messages — proof: **C13**
> "If the server accepts it, the server **MUST** return HTTP status code `202 Accepted` with no body."

C13 POSTs a `notifications/progress` message with **no `id` member at all** and requires
status 202 and a zero-length body. "With no body" is asserted on the bytes, not on the
parsed JSON.

**R5** — `[SHTTP]` Sending Messages — proof: **C14**
> "If the server cannot accept it, it **MUST** return an HTTP error status code (e.g., `400 Bad Request`). The HTTP response body **MAY** comprise a JSON-RPC *error response* that has no `id`."

C14 POSTs a notification naming a method the server cannot possibly accept and requires
status >= 400.

**R6** — `[SHTTP]` Sending Messages — proof: **C15**
> "If the body is a JSON-RPC *request*, the server **MUST** return either `Content-Type: application/json` (a single JSON object) or `Content-Type: text/event-stream` (an SSE response stream). The client **MUST** support both."

C15 inspects the `Content-Type` of a non-streaming response (`server/discover`) and of the
streaming one (`tools/call`), and requires each to match one of the two media types.

**R7** — `[SHTTP]` Cancellation — proof: **—**
> "Closing the SSE response stream **MUST** be treated by the server as cancellation of that request."

Not provable from a black-box HTTP probe: proving the server *stopped working* requires an
observable side effect the protocol does not define. Recorded, not tested. The module under
test writes its single frame and closes, so there is no window in which a cancellation
could be observed.

**R8** — `[SHTTP]` Protocol Version Header — proof: **C03** (server-side half)
> "Every POST request to the MCP endpoint **MUST** include an `MCP-Protocol-Version` header."

Addressed to the client. Its server-side consequence is R10/R16, which C03 proves.

**R9** — `[SHTTP]` Protocol Version Header — proof: **C04**
> "The header value **MUST** match the `io.modelcontextprotocol/protocolVersion` field carried in the request body's `_meta`. If the values do not match, the server **MUST** reject the request with `400 Bad Request` and a `HeaderMismatch` JSON-RPC error (see [Server Validation](#server-validation))."

C04 sends header `2026-07-28` with body `_meta` claiming `2025-11-25` and requires
`400` + `-32020`. This is the split-brain rejection: a load balancer routing on the header
while the server executes the body is exactly what it prevents.

**R10** — `[SHTTP]` Protocol Version Header — proof: **C03**
> "A server that supports clients implementing protocol versions earlier than `2025-06-18` (which did not define the `MCP-Protocol-Version` header) **MAY** treat a request that omits the header as protocol version `2025-03-26`. A server that does not support such clients **MUST** reject a request without the header per [Server Validation](#server-validation)."

The MAY half is **Y2**, which this server declines (see DUAL-ERA.md). Having declined it,
the MUST half binds: C03 omits the header entirely and requires `400` + `-32020`.

**R11** — `[SHTTP]` Protocol Version Header; `[VER]` Protocol Version Negotiation — proof: **C11**, **C53**
> "If the server does not implement the requested protocol version (whether the version is unknown to the server, or is a known version the server has chosen not to support), it **MUST** respond with `400 Bad Request` and an [`UnsupportedProtocolVersionError`][unsupported-version] listing its supported versions."

C11 asks for `1900-01-01` in both the header and `_meta` and requires `400`, code `-32022`,
a non-empty `data.supported` array, and `data.requested` echoing what was asked for.

C11 alone does **not** discharge this requirement, and believing it did hid a live defect.
Because C11 puts the version in `_meta` as well, its request carries a modern claim and
reaches the modern branch no matter what the era router thinks of the header. The clause
"whether the version is **unknown** to the server" is only tested when the header carries an
unknown revision **alone** — the shape a client that has moved on to a later revision
actually sends when probing. C53 sends exactly that, and it failed until the era router was
taught the spec's own era boundary (below, and DUAL-ERA.md B4).

**R12** — `[SHTTP]` Protocol Version Header — proof: **C12**
> "If the server does not implement the requested RPC method, it **MUST** respond with `404 Not Found` and a JSON-RPC error with code `-32601` (`Method not found`). The JSON-RPC error body distinguishes this case from a `404` returned by a legacy [HTTP+SSE][http-sse] server that does not host the modern MCP endpoint."

C12 requires **both** halves: HTTP 404 *and* `-32601`. A `200` carrying `-32601` fails, and
so does a bare 404 with no JSON-RPC body — the body is the whole reason the status is
allowed to be 404 at all.

**R13** — `[SHTTP]` Standard Request Headers — proof: **C05**, **C07**
> "These headers are **REQUIRED** for compliance." (of the table: `Mcp-Method` — source field `method` — required for all requests; `Mcp-Name` — source field `params.name` or `params.uri` — required for `tools/call`, `resources/read`, `prompts/get` requests)

C05 omits `Mcp-Method` on a request; C07 omits `Mcp-Name` on a `tools/call`. Both require
`400` + `-32020`.

**R14** — `[SHTTP]` Server Validation — proof: **C06**, **C08**
> "Servers that process the request body **MUST** reject requests where the values specified in the headers do not match the corresponding values in the request body. This prevents potential security vulnerabilities when different components in the network rely on different sources of truth (e.g., a load balancer routing on the header value while the MCP server executes based on the body value)."

C06 sends `Mcp-Method: tools/list` on a `server/discover` body; C08 sends an `Mcp-Name`
that does not match `params.name`.

**R15** — `[SHTTP]` Server Behavior for Custom Headers — proof: **C31**
> "Intermediate servers that do not recognize an `Mcp-Param-{Name}` header **MUST** forward it and otherwise ignore it, as required by the [HTTP Semantics RFC][http-semantics]."
>
> "Servers **MUST** reject requests with a recognized `Mcp-Param-{Name}` header that contains invalid characters (see [Value Encoding](#value-encoding))."

The first sentence binds intermediaries, which this server is not; it is recorded so that
the exclusion is deliberate and visible. The second binds this server, and C31 proves it:
a raw `0xE9` octet is a legal HTTP field-value byte but is outside printable US-ASCII, so
it had to have arrived Base64-sentinel-encoded; un-encoded it is invalid on its face and
must draw `400` + `-32020`.

**R16** — `[SHTTP]` Server Validation — proof: **C03**, **C04**, **C05**, **C06**, **C07**, **C08**, **C29**, **C30**, **C31**, **C32**
> "When rejecting a request due to header validation failure, servers **MUST** return HTTP status `400 Bad Request` and **MUST** include a JSON-RPC error response using the following error code: `-32020` `HeaderMismatch` — The HTTP headers do not match the corresponding values in the request body, or required headers are missing/malformed."
>
> "Validation failure conditions include: A required standard header (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) is missing. A header value does not match the corresponding request body value. […] A header value contains invalid characters."

Every header-validation check in the suite asserts the pair `400` **and** `-32020`, never
one alone.

**R17** — `[SHTTP]` Value Encoding — proof: **C09**
> "The prefix `=?base64?` and suffix `?=` indicate that the value is Base64-encoded. These markers are case-sensitive and **MUST** appear exactly as shown (lowercase). Servers and intermediaries that need to inspect these values **MUST** decode them accordingly. In particular, servers **MUST** decode an encoded `Mcp-Name` or `Mcp-Param-{Name}` value before comparing it to the corresponding request body value during [Server Validation](#server-validation)."

C09 sends a **correct** tool name in sentinel form and requires the request to *succeed*
with `resultType: "complete"`. This is the check that catches the failure mode where a
server compares the raw header and makes every non-ASCII tool name unreachable behind a
spurious `-32020` — a bug that is invisible to a suite that only ever tests rejections.

**R18** — `[SHTTP]` Server Behavior for Custom Headers — proof: **C29**, **C30**, **C32**, **C50**, **C51**
> "Any server that processes the message body **MUST** validate that encoded header values, after decoding if Base64-encoded, match the corresponding values in the request body. Servers **MUST** reject requests with a `400 Bad Request` HTTP status and JSON-RPC error code `-32020` (`HeaderMismatch`) if any validation fails."
>
> (table) "Parameter value provided — Server MUST validate header matches body"; "Parameter value is `null` — Server MUST NOT expect the header"; "Parameter not in arguments — Server MUST NOT expect the header"; "Client omits header but value is in body — Server MUST reject the request"

C29 puts the annotated parameter in the body and omits the header (the row the spec calls
out explicitly, "Non-conforming client"). C30 sends a header that disagrees with the body.
C32 sends the header while the parameter is absent from the arguments. All three require
`400` + `-32020`.

The two `MUST NOT expect the header` rows are covered by **C50** (value is `null`) and
**C51** (parameter absent from `arguments`), and both are new. THE COVERAGE CLAIMED HERE
BEFORE WAS FALSE, and it is worth stating plainly rather than quietly correcting: these rows
were credited to C33, which calls a tool carrying **no `x-mcp-header` annotation at all**.
The server's annotation loop therefore never executed on C33's request, so C33 could not
have failed for this reason under any implementation — it was a check that could not fail,
counted as proof. Behind it sat a real violation: the server treated an explicit `null` as
"provided" and answered `-32020` to a client that had followed the table exactly. Only the
half of R18 that rejects was ever tested, which is why a suite that tests only rejections
can be entirely green over a server that rejects too much.

**R19** — `[SHTTP]` Case Sensitivity — proof: **C10**
> "Header names (called \"field names\" in [RFC 9110][rfc9110-names]) are case-insensitive. Clients and servers **MUST** use case-insensitive comparisons for header names. Header *values* (such as method names) are case-sensitive."

C10 is the reason this harness uses raw `http.request` and not `fetch`: it puts
`mCp-PrOtOcOl-VeRsIoN` and `MCP-METHOD` on the wire with those exact spellings and requires
the request to succeed. A client library that normalises header names cannot test this.

### Base protocol (R20–R24)

**R20** — `[BASE]` General fields / `_meta` / Per-request protocol fields — proof: **C17**, **C18**, **C19**
> "A request missing any required field is malformed; the server **MUST** reject it with JSON-RPC error code `-32602` (Invalid params). On HTTP, the response status **MUST** be `400 Bad Request`."

The required fields are `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities`; `[SCHEMA]` `RequestMetaObject` confirms both
as non-optional and `clientInfo`/`logLevel` as optional. C17 omits `_meta` entirely, C18
omits the version field, C19 omits the capabilities field; each requires `400` + `-32602`.

**R21** — `[BASE]` `_meta` — proof: **C42**
> "If processing a request requires a capability the client did not include in `io.modelcontextprotocol/clientCapabilities`, the server **MUST** return a [`MissingRequiredClientCapabilityError`](…) (`-32021`) whose `data.requiredCapabilities` lists the missing capabilities. On HTTP, the response status **MUST** be `400 Bad Request`."

C42 sends a request declaring **empty** capabilities and requires one of exactly two
outcomes: a `complete` result (the server needed nothing) or a well-formed `-32021` at
status 400 with `data.requiredCapabilities` present. Anything else — including a `-32601`,
a 500, or a `-32602` — fails.

**R22** — `[BASE]` Result Responses — proof: **C20**
> "The `result` **MUST** include a `resultType` field to indicate the type of the result."

`[SCHEMA]` `Result`: "Servers implementing this protocol version MUST include this field."
C20 requires a non-empty string `resultType` on `server/discover`, `tools/list` **and**
`tools/call`. Declining to emit `InputRequiredResult` does not excuse it: `resultType`
belongs to `Result`, not to MRTR.

**R23** — `[BASE]` Result Responses / Error Responses — proof: **C21**, **C49**
> "Result responses **MUST** include the same ID as the request they correspond to."
>
> "Error responses **MUST** include the same ID as the request they correspond to (except in error cases where the ID could not be read due a malformed request)."

C21 exercises an integer id, a string id and `9007199254740991`, and every assertion runs
through the R20a guard (see §7). C49 covers the parenthesis: when the id genuinely could
not be attributed, `[SCHEMA]` types `id?: RequestId` with `RequestId = string | number`, and
`[SHTTP]` describes the permitted body as "a JSON-RPC *error response* that has no `id`" —
so the member must be **absent**, not `null`.

**R24** — `[BASE]` Error Responses / Error Codes — proof: **C22**, **C36**
> "Error responses **MUST** include an `error` field with a `code` and `message`."
>
> "Error codes **MUST** be integers."
>
> "Implementations **MUST NOT** emit any code from this sub-range that is not defined by this specification and **MUST** use defined codes only with their specified meanings."

C22 requires `Number.isInteger(code)` and a non-empty `message` on an error response — a
string `"-32601"` fails. The "defined codes only with their specified meanings" half is
proved negatively by C36 plus the code-specific checks C04/C11/C12/C34.

### Versioning and discovery (R25–R27)

**R25** — `[VER]` Protocol Version Negotiation; `[DISC]` — proof: **C23**
> "Servers **MUST** implement [`server/discover`](/specification/2026-07-28/server/discover)."
>
> "`server/discover` lets a client query a server's supported protocol versions, capabilities, and identity before sending any other requests. Servers **MUST** implement it."

Implementing it is a server MUST; *calling* it is only a client MAY. C23 requires status
200, `resultType: "complete"`, a non-empty `supportedVersions` array of strings, and a
`capabilities` object.

**R26** — `[VER]` Protocol Version Negotiation — proof: **C11**
> "If the server does not implement the requested version (whether the version is unknown to the server, or is a known version the server has chosen not to support), it **MUST** respond with an [`UnsupportedProtocolVersionError`](…) listing the versions it does support."

The `[VER]` restatement of R11. C11 proves both together.

**R27** — `[VER]` Extension Negotiation — proof: **—**
> "If one party supports an extension but the other does not, the supporting party **MUST** either revert to core protocol behavior or reject the request with an appropriate error."
>
> "Extension identifiers **MUST** follow the [`_meta` key naming rules](…), with a mandatory prefix."

This server advertises no extensions, so there is no extension behaviour to observe.
Recorded so that adding one is visibly a conformance event.

### Caching (R28–R31)

**R28** — `[CACHE]` Cacheable Results — proof: **C25**, **C26**
> "Servers MUST include caching hints on results with `resultType: \"complete\"` returned by the following operations: `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`."

C25 and C26 cover the two operations this server implements. The other four are not
implemented and answer `-32601` (R12), so no hint is owed on them.

**R29** — `[CACHE]` Time-to-Live (TTL) Field — proof: **C25**, **C26**
> "Servers **MUST** provide a `ttlMs` value that is `>= 0`."

Both checks require an **integer** `ttlMs >= 0` and a `cacheScope` of exactly `"public"` or
`"private"`.

**R30** — `[CACHE]` Interaction with Pagination — proof: **—**
> "Servers **MUST** apply the same `cacheScope` to all response pages for a given list request. For example, if the first page of a `tools/list` response has `cacheScope: \"private\"`, all subsequent pages for that request **MUST** also be `\"private\"`."

This server does not paginate `tools/list` (it returns no `nextCursor`), so there is no
second page to disagree. Adding pagination re-arms this requirement.

**R31** — `[CACHE]` Security Considerations — proof: **S** (partial, C26)
> "Server implementors: […] MUST apply appropriate per-primitive access controls, and MUST NOT rely on `cacheScope` alone to prevent unauthorized access to primitives."

The observable half: this server's tool set varies by the caller's grants, so its
`cacheScope` is `"private"` and never `"public"`. C26 asserts the value; the access control
itself is enforced upstream of the module, in the `tools(role)` dependency.

### Subscriptions, logging, schemas, framing (R32–R39)

**R32** — `[SUBS]` Acknowledgment — proof: **C45**
> "The server **MUST** send `notifications/subscriptions/acknowledged` as the first message carrying the subscription's ID in `_meta` under `io.modelcontextprotocol/subscriptionId`, and **MUST NOT** send any notification on the subscription before it."

C45 accepts exactly two outcomes: an SSE stream whose **first** frame is the acknowledgement
carrying `io.modelcontextprotocol/subscriptionId`, or `404` + `-32601`. `[SUBS]` never
states implementing `subscriptions/listen` as a MUST and every requirement on it is
conditional, so a server that declares neither `listChanged` nor `resources.subscribe` may
decline it — but it must decline it *properly*, and a 200 with a made-up result fails.

**R33** — `[BASE]` `_meta` — proof: **C45** (conditional)
> "On notifications delivered via a [`subscriptions/listen`][subscriptions-listen] stream, the server **MUST** include `io.modelcontextprotocol/subscriptionId` in `_meta` so the client can correlate the notification with the originating subscription request."

Conditional on implementing subscriptions. C45 asserts it on the acknowledgement frame when
a stream is opened at all.

**R34** — `[LOG]` Capabilities — proof: **C23** (negative)
> "Servers that emit log message notifications **MUST** declare the `logging` capability."

This server emits none (see F9) and declares none. C23 reads the advertised capabilities;
C44 proves no `notifications/message` is emitted. The pair is consistent by construction.

**R35** — `[BASE]` Implementation Requirements — proof: **—**
> "Clients and servers **MUST** support JSON Schema 2020-12 for schemas without an explicit `$schema` field."

**R36** — `[BASE]` Implementation Requirements — proof: **—**
> "Clients and servers **MUST** validate schemas according to their declared or default dialect. They **MUST** handle unsupported dialects gracefully by returning an appropriate error indicating the dialect is not supported."

**R37** — `[BASE]` Schema Validation — proof: **S** (partial, C27)
> "Schemas **MUST** be valid according to their declared or default dialect."

C27 proves the observable necessary condition — every advertised `inputSchema` is a
non-null JSON object — which is `[TOOLS]`' "**MUST** be a valid JSON Schema object (not
`null`)" (R51). Full dialect validation of a published schema is a build-time concern, not
a wire-observable one.

**R38** — `[BASE]` Statelessness — proof: **—**
> "State that needs to span multiple requests (e.g., long-running tasks, application-level handles) **MUST** be referenced by an explicit identifier the client passes on each request."

This server holds no cross-request state. F5 is the testable side of statelessness.

**R39** — `[TRANS]` Messages — proof: **C46**
> "MCP uses JSON-RPC to encode messages. JSON-RPC messages **MUST** be UTF-8 encoded."

C46 sends a UTF-8 body carrying `Hello, 世界 éè` as a tool argument, reads the response as
**bytes**, decodes them as UTF-8, and requires the exact string back. Reading the response
as a pre-decoded string would hide a mis-encoding, so the harness keeps the buffer.

### MRTR and tools (R40–R52)

**R40** — `[MRTR]` note; `[CHANGE]` major change 7 — proof: **C41**
> "Servers **MUST** send server-to-client requests (such as `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported. This is a breaking change."

C41 reads every SSE frame on a `tools/call` response stream and fails if any frame is a
JSON-RPC **request** (a `method` together with an `id`). Declining MRTR entirely, as this
server does, means declining sampling, elicitation and roots — it does **not** license the
old push channel.

**R41** — `[TOOLS]` Security Considerations — proof: **C33**, **C34**
> "Servers **MUST**: Validate all tool inputs"

C34 proves an unknown tool name is a protocol error (`-32602`) rather than a dispatch into
nothing; C33 proves a valid call completes. The module additionally converts a throwing
tool into an `isError` result rather than an unhandled 500, which is what `[TOOLS]` Error
Handling asks for — a 500 out of the modern branch is also a dual-era hazard (DUAL-ERA.md
B8).

**R42** — `[TOOLS]` Security Considerations — proof: **—**
> "Servers **MUST**: […] Implement proper access controls"

Enforced in the injected `tools(role)` and `identity()` dependencies, above the module.

**R43** — `[TOOLS]` Security Considerations — proof: **—**
> "Servers **MUST**: […] Rate limit tool invocations"

**R44** — `[TOOLS]` Security Considerations — proof: **—**
> "Servers **MUST**: […] Sanitize tool outputs"

**R45** — `[TOOLS]` Capabilities — proof: **C27**, **C33**
> "Servers that support tools **MUST** declare the `tools` capability"
>
> "Servers that declare the `tools` capability **MUST** respond to `tools/list` requests with the set of tools currently available to the requesting client."

C23 reads `capabilities.tools` from `server/discover`; C27 requires `tools/list` to answer
an array of well-formed `Tool` objects; C33 requires one of them to be callable.

**R46** — `[MRTR]` Server Requirements (Basic Workflow) 6 — proof: **C43** (negative)
> "Servers **MUST** include at least one of `inputRequests` or `requestState` in every `InputRequiredResult` response."

This server emits no `InputRequiredResult`. C43 proves that: `resultType` is never
`"input_required"` on `server/discover` or `tools/list`. The harness's stub *does* emit a
bare `input_required`, which is how the check's oracle is proved.

**R47** — `[MRTR]` Server Requirements 2 — proof: **—**
> "`inputRequests` keys are server assigned identifiers and **MUST** be unique within the scope of the request."

**R48** — `[MRTR]` Server Requirements 2 — proof: **—**
> "`inputRequests` values are request objects that **MUST** be one of [`ElicitRequest`](…), [`CreateMessageRequest`](…), or [`ListRootsRequest`](…)"

**R49** — `[MRTR]` Server Requirements 4 — proof: **—**
> "If a client request contains a `requestState` field, servers **MUST** treat `requestState` as an attacker-controlled input. If `requestState` influences authorization, resource access, or business logic, servers **MUST** protect its integrity (e.g. HMAC or AEAD) and **MUST** reject state that fails verification."

The module accepts and **ignores** `params.requestState` and `params.inputResponses`
(an unknown parameter must not become a `-32602`, and another hop may legitimately have
produced them). Because it never mints a `requestState`, there is nothing to verify and
nothing an attacker can forge into one. The moment it mints one, R49 binds and the state
must be sealed (Y8).

**R50** — `[MRTR]` Server Requirements 5 (warning) — proof: **—**
> "Servers for which a given `requestState` must be consumed at most once (e.g., one-time redemptions) **MUST** enforce that invariant server-side."

**R51** — `[TOOLS]` Data Types / Tool — proof: **C27**
> "`inputSchema`: JSON Schema defining expected parameters […] **MUST** be a valid JSON Schema object (not `null`)"

**R52** — `[TOOLS]` Output Schema — proof: **—**
> "If an output schema is provided: Servers **MUST** provide structured results that conform to this schema."

No tool here declares an `outputSchema`, so nothing is owed. Declaring one arms this.

---

## 2. MUST NOT — F1–F23

**F1** — `[SHTTP]` Receiving Messages — proof: **C41**
> "The server **MUST NOT** send independent JSON-RPC *requests* on this stream. Server-to-client interactions (sampling, elicitation, list-roots) are embedded as input requests inside an [`InputRequiredResult`][input-required-result] per [MRTR][mrtr] ([SEP-2322][sep-2322]), not delivered as separate requests on this or any other stream. This is a change from Streamable HTTP in protocol versions `2025-03-26` through `2025-11-25`, where servers could send such requests on SSE streams."

**F2** — `[SHTTP]` Cancellation — proof: **—**
> "The server **SHOULD** stop work on the cancelled request as soon as practical and **MUST NOT** send any further messages for it."

Requires observing a stream after the client has closed it; not black-box testable.

**F3** — `[BASE]` Notifications — proof: **C13**
> "[Notifications](…) are sent from the client to the server or vice versa, as a one-way message. The receiver **MUST NOT** send a response."

C13 requires 202 **with a zero-length body**: any JSON-RPC response to a notification fails
it. Note the deliberate seam with R5: an HTTP *error status* for a notification the server
cannot accept is explicitly permitted, and its body "**MAY** comprise a JSON-RPC *error
response* that has no `id`" — an error response is not a response to the notification.

**F4** — `[BASE]` Notifications; Requests — proof: **C49**
> "Notifications **MUST NOT** include an ID."
>
> "Unlike base JSON-RPC, the ID **MUST NOT** be `null`."

**F5** — `[BASE]` Statelessness — proof: **C28**, **C38**
> "Servers **MUST NOT** rely on prior requests over the same connection to establish context (e.g., capabilities, protocol version, client identity). Every request supplies this metadata in its [`_meta`](#_meta) field."

C28 issues three identical `tools/list` requests and requires an identical answer each
time; C38 proves a `Last-Event-ID` header changes nothing. Both are the observable shadow
of "no connection state".

**F6** — `[BASE]` `_meta` — proof: **C42**
> "A server **MUST NOT** rely on capabilities the client has not declared."

**F7** — `[BASE]` `_meta` — proof: **—**
> "Certain key names are reserved by MCP for protocol-level metadata, as specified below; implementations **MUST NOT** make assumptions about values at these keys."

**F8** — `[BASE]` Error Codes — proof: **C36**, **C52**
> "**`-32000` to `-32019` — legacy.** Codes in this sub-range were allocated by implementations before this policy was introduced. New codes **MUST NOT** be allocated in this sub-range, and new implementations **SHOULD NOT** use codes from this sub-range at all."

The modern branch allocates nothing here. The **legacy** branch's existing `-32000` is
grandfathered, is not a new allocation, and is load-bearing for dual-era fallback — see
DUAL-ERA.md B10. C36 records every error code the run observed so the modern branch's
allocations are visible in the output.

"Visible in the output" was the whole of it until C52, and visible is not asserted: nothing
failed if a `-32000` appeared, it merely printed. C52 now asserts it over the same corpus.
The consequence it guards is specific and silent. `[SHTTP]` Backward Compatibility has a
dual-era client fall back to `initialize` unless the body is "a recognized modern JSON-RPC
error"; a code from the legacy sub-range is by definition not one, so a single `-32000`
escaping the **modern** branch would demote every dual-era client to the 2025 era
permanently, while the server continued to answer every other check correctly. The two era
checks (C53, C54) drive deliberately legacy requests and deliberately do **not** record into
the corpus, because the legacy branch's `-32000` is correct there and would poison it.

**F9** — `[LOG]` Per-request log level — proof: **C44**
> "The server **MUST NOT** emit `notifications/message` for a request that does not include this field."

C44 opens the `tools/call` response stream with no `io.modelcontextprotocol/logLevel` in
`_meta` and requires that no frame is a `notifications/message`.

**F10** — `[BASE]` Error Codes — proof: **C36**
> "**`-32020` to `-32099` — reserved for the MCP specification.** Error codes in this sub-range are defined exclusively by the MCP specification and recorded in the [schema](…). Implementations **MUST NOT** emit any code from this sub-range that is not defined by this specification and **MUST** use defined codes only with their specified meanings."

C36 collects **every** error code emitted anywhere in the run — from JSON bodies and from
SSE frames — and fails if any lies in `-32020..-32099` and is not one of `-32020`, `-32021`,
`-32022`. It reports the full observed set either way, so the evidence is in the log.

**F11** — `[BASE]` Error Codes — proof: **C34**, **C35**
> "Codes defined by earlier protocol versions remain reserved and will not be reused. Implementations of this protocol version **MUST NOT** emit these codes: `-32002` — resource not found (2025-11-25 and earlier; replaced by `-32602`). […] `-32042` — URL elicitation required (2025-11-25 only)."

C34 requires an unknown tool to draw `-32602` specifically. C35 sweeps the whole corpus for
`-32002` and `-32042`.

**F12** — `[LOG]` Per-request log level — proof: **C44**, **C45**
> "`notifications/message` is request-scoped: the server **MUST NOT** deliver it on a [`subscriptions/listen`](…) stream or on any stream other than the one carrying the response to the request that set the log level."

**F13** — `[SHTTP]` Sending Messages — proof: **C16**
> "The body of the HTTP POST **MUST** be a single JSON-RPC *request* or *notification*. The client **MUST NOT** send JSON-RPC *responses*."

`[SCHEMA]`: `JSONRPCMessage : JSONRPCRequest | JSONRPCNotification | JSONRPCResponse` — there
is no array member, so a batch body is not a decodable message at all. C16 puts a
two-element JSON array on the wire (which is why the harness cannot use a client library
that validates bodies) and requires an HTTP error status, a **non-array** response, and a
JSON-RPC error body. See Ambiguity 1 for the code this server chooses.

**F14** — `[SUBS]` Opening a Stream — proof: **C45**
> "The server **MUST NOT** send notification types the client has not explicitly requested."

**F15** — `[SUBS]` Acknowledgment — proof: **C45**
> "[the server] **MUST NOT** send any notification on the subscription before it."

**F16** — `[MRTR]` Supported Requests — proof: **C43**
> "Servers **MUST NOT** send `InputRequiredResult` responses on any other client requests."

The supported three are `prompts/get`, `resources/read` and `tools/call`. C43 requires that
`server/discover` and `tools/list` never answer `resultType: "input_required"`.

**F17** — `[MRTR]` Server Requirements 7 — proof: **—**
> "Servers **MUST NOT** send an `inputRequests` that the client has not declared support for in its capabilities. For example, if a client does not declare support for `elicitation`, the server **MUST NOT** include any `elicitation/create` requests in the `inputRequests` field."

**F18** — `[MRTR]` Server Requirements 8 — proof: **—**
> "Servers **MUST NOT** assume that clients will fulfill the `inputRequests` or retry the original request."

**F19** — `[TOOLS]` Capabilities — proof: **C28**
> "This set **MAY** be empty and **MAY** change over time […] but **MUST NOT** vary per-connection or as a side effect of other requests on the connection. The set **MAY** vary by the authorization presented on the request — for example, returning only the tools the caller's granted scopes permit — since credentials are per-request input, not connection state."

C28 issues three identical `tools/list` requests with the same credential and requires an
identical ordered list. Varying by *authorization* is explicitly allowed and is what this
server does; varying by *connection* is not.

**F20** — `[BASE]` `$ref` Resolution — proof: **—**
> "JSON Schema 2020-12 permits `$ref` to point at an absolute URI. Implementations **MUST NOT** automatically dereference `$ref` values that resolve to a network URI."

The module never dereferences a `$ref`; it passes `inputSchema` through unread except for
the `x-mcp-header` walk, which follows `properties` keys only.

**F21** — `[LOG]` Security — proof: **—**
> "Log messages **MUST NOT** contain: Credentials or secrets; Personal identifying information; Internal system details that could aid attacks"

Vacuous here: no log messages are emitted (F9).

**F22** — `[CACHE]` Security Considerations — proof: **C26**
> "MUST apply appropriate per-primitive access controls, and MUST NOT rely on `cacheScope` alone to prevent unauthorized access to primitives."

**F23** — `[AUTH]` Token Handling — proof: **—** (see A9)
> "MCP servers **MUST NOT** accept or transit any other tokens."

---

## 3. SHOULD — S1–S25

**S1** — `[SHTTP]` Security & Endpoint — proof: **—**
> "When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)."

**S2** — `[SHTTP]` Security & Endpoint — proof: **C47**
> "Servers **SHOULD** implement proper authentication for all connections."

**S3** — `[SHTTP]` Receiving Messages — proof: **S** (observed by C15)
> "When initiating an SSE stream, servers **SHOULD** include the `X-Accel-Buffering: no` header in the HTTP response."

The module sets it on the `tools/call` stream, alongside `Cache-Control: no-cache,
no-transform`.

**S4** — `[SHTTP]` Cancellation — proof: **—**
> "The server **SHOULD** stop work on the cancelled request as soon as practical"

**S5** — `[SHTTP]` Receiving Messages — proof: **C41**
> "The final JSON-RPC *response* **SHOULD** terminate the stream."

C41 requires the **last** SSE frame to be the JSON-RPC response (a `result` or an `error`),
not a notification.

**S6** — `[BASE]` Per-response protocol fields — proof: **C24**
> "Servers **SHOULD** include the following `io.modelcontextprotocol/*` field in every result's `_meta`, unless specifically configured not to do so, to identify themselves without relying on any prior connection state: `io.modelcontextprotocol/serverInfo`"

C24 requires `result._meta["io.modelcontextprotocol/serverInfo"]` with a `name` and a
`version`, **and** requires that `serverInfo` is *not* a top-level `DiscoverResult` field —
`[DISC]` places it in `_meta`, and putting it at the top level is the common mistake.

**S7** — `[TOOLS]` Capabilities; `[CHANGE]` minor change 3 — proof: **C28**
> "Servers **SHOULD** return tools in a deterministic order (i.e., the same ordering across requests when the underlying set of tools has not changed). Deterministic ordering enables clients to reliably cache the tool list and improves LLM prompt cache hit rates when tools are included in model context."

The set is rebuilt per request from Firestore, so without an explicit sort the order is
map-iteration order and every client tool-list cache and LLM prompt cache misses. C28
issues three identical requests and compares the name sequence.

**S8** — `[SHTTP]` Earlier Streamable HTTP Revisions — proof: **C39**, **C40**
> "A server that supports only this revision and receives such traffic from an older client **SHOULD** respond as follows: HTTP GET or DELETE to the MCP endpoint: respond with `405 Method Not Allowed`."

A bare 404 here would be actively harmful: it tells a dual-era client that no modern
endpoint lives at this URL and sends it off to probe the deprecated HTTP+SSE GET transport.

**S9** — `[SHTTP]` Earlier Streamable HTTP Revisions — proof: **C37**
> "An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo session IDs."

C37 sends a client-supplied `Mcp-Session-Id`, requires the request to succeed unchanged, and
then sweeps **every** response captured in the run for an `Mcp-Session-Id` response header.

**S10** — `[SHTTP]` Earlier Streamable HTTP Revisions — proof: **C38**
> "A `Last-Event-ID` header: ignore it; streams are not resumable."

**S11** — `[VER]` Backward Compatibility — proof: **C54** (and DUAL-ERA.md §4)
> "A server that supports only [modern](#terminology) versions **SHOULD** name the protocol versions it supports in any error it returns to an `initialize` request, on any transport: legacy clients have no fall-forward mechanism, and this message may be the only diagnostic they can surface to users."

This deployment is dual-era, so `initialize` is *answered*, not errored. The requirement is
recorded because it binds the day the legacy branch is removed.

What C54 proves is the neighbouring property this deployment depends on today: a legacy
revision named in the header **alone** must not be served modernly. `[VER]` Terminology puts
`2025-11-25` and earlier in the legacy era and the compatibility matrix requires
Legacy client / Dual-era server to **work**; 2025-era clients send `MCP-Protocol-Version`
too, so promoting them would hand ordinary traffic a `-32020` — a *recognised* modern error —
and a dual-era client would stop falling back and deadlock while a pure legacy client simply
died. C54 asserts **both** legs (the legacy leg is not modern-coded and is not `400`; the
modern leg is `400` + `-32602`) rather than merely asserting that the two answers differ,
because "they differ" also passes against a server that answers both of them wrongly in two
different ways. It is the discriminating control for C53: C53 pulls unknown revisions
*toward* the modern era and C54 holds known-legacy ones *out* of it, so no one-sided rule
satisfies both.

**S12** — `[MRTR]` Error Handling — proof: **—**
> "Servers **SHOULD** validate that the data provided by the client is a valid `InputResponses` object and that the information inside can be correctly parsed. Protocol errors (malformed JSON, invalid schema, internal server errors) **SHOULD** return a JSON-RPC error response with an appropriate error code and message."
>
> "If additional, unexpected parameters are provided in the `InputResponses` object, the server **SHOULD** ignore any information it does not recognize or need."

**S13** — `[MRTR]` Error Handling — proof: **—**
> "If the client fails to send all the information requested in a previous `InputRequests`, and the missing information is necessary for the server to process the request, the server **SHOULD** respond with a new `InputRequiredResult` requesting the missing information again, rather than returning an error."

**S14** — `[MRTR]` Server Requirements 5 — proof: **—**
> "To prevent replay, servers **SHOULD** include the following inside the integrity-protected `requestState` payload and verify each on receipt: the authenticated principal, rejecting state presented by a different principal. a short expiry (TTL), rejecting state presented after it lapses; an identifier for the originating request, e.g. the method name and a digest of its salient parameters, rejecting state presented on a request that does not match."

**S15** — `[LOG]` Error Handling — proof: **—**
> "If the `io.modelcontextprotocol/logLevel` value carried in a request's `_meta` is not a recognized [log level](#log-levels), the server **SHOULD** reject that request with a standard JSON-RPC error: Invalid log level: `-32602` (Invalid params)"

**S16** — `[BASE]` Schema Dialect — proof: **—**
> "**Supported dialects**: Implementations MUST support at least 2020-12 and SHOULD document which additional dialects they support"

**S17** — `[BASE]` Composition-Keyword Resource Use — proof: **—**
> "Implementations **SHOULD** apply reasonable bounds, such as a maximum schema depth, a cap on the total number of subschemas, or a per-validation time budget, to prevent a malicious schema from acting as a Denial-of-Service vector against the validator."

**S18** — `[SHTTP]` Server Validation (note) — proof: **C30**
> "When validating integer parameter values, servers **SHOULD** compare the header value and the body value numerically rather than as strings (e.g., `42.0` and `42` are considered equal)."

The module compares numerically when the body value is a number, so `42` and `42.0` agree
and do not produce a spurious `-32020`. C30 exercises the string path directly; the numeric
path is exercised by the module's own `valuesAgree`.

**S19** — `[TOOLS]` List Changed Notification — proof: **C23** (negative)
> "When the list of available tools changes, servers that declared the `listChanged` capability **SHOULD** send a notification to clients that have opened a [`subscriptions/listen`](…) stream with `toolsListChanged: true`"

This server declares `tools: {}` — no `listChanged` — and relies on `ttlMs` alone (Y9). That
combination is explicitly sanctioned by `[CACHE]`. Declaring a change notification you do
not send is the worse of the two failures, and C23 makes the declaration visible in the
output.

**S20** — `[AUTH]` Scope Selection Strategy — proof: **—**
> "MCP servers **SHOULD** include a `scope` parameter in the `WWW-Authenticate` header as defined in [RFC 6750 Section 3](…) to indicate the scopes required for accessing the resource."

**S21** — `[AUTH]` Runtime Insufficient Scope Errors — proof: **—**
> "When a client makes a request with an access token with insufficient scope during runtime operations, the server **SHOULD** respond with: `HTTP 403 Forbidden` status code […] `WWW-Authenticate` header with the `Bearer` scheme and additional parameters: `error=\"insufficient_scope\"` […] `scope=\"required_scope1 required_scope2\"` […] `resource_metadata`"

**S22** — `[BASE]` `$ref` Resolution — proof: **—**
> "Schemas that fail to validate due to an unresolved external `$ref` **SHOULD** be rejected rather than silently treated as permissive."

**S23** — `[TOOLS]` Tool Names — proof: **S** (partial, C27)
> "Tool names **SHOULD** be between 1 and 128 characters in length (inclusive)."
>
> "Tool names **SHOULD** be considered case-sensitive."
>
> "The following **SHOULD** be the only allowed characters: uppercase and lowercase ASCII letters (A-Z, a-z), digits (0-9), underscore (\_), hyphen (-), and dot (.)"
>
> "Tool names **SHOULD** be unique within a server."

**S24** — `[TOOLS]` User Interaction Model — proof: **—**
> "For trust & safety and security, there **SHOULD** always be a human in the loop with the ability to deny tool invocations."

**S25** — `[BASE]` Statelessness — proof: **C28**
> "Servers **SHOULD** be prepared to handle requests associated with multiple tasks, threads, or conversations."
>
> "Servers **SHOULD NOT** require that a client reuse the same connection or process to perform related operations."

The harness opens a fresh socket per probe (`agent: false`), so every check is already a
new connection; nothing in the suite depends on connection reuse.

---

## 4. MAY — Y1–Y15

Recorded because a MAY that has been *declined* is a design decision that a later reader
must be able to find, and because `mcp2026.ts` cites four of them by number.

**Y1** — `[SHTTP]` Security & Endpoint; Sending Messages — **taken**
> "The HTTP response body **MAY** comprise a JSON-RPC *error response* that has no `id`."

Taken on 403 and on the unacceptable-notification path. See C49 for the one place where
this server's rendering of "has no `id`" is disputed.

**Y2** — `[SHTTP]` Protocol Version Header — **declined**
> "A server that supports clients implementing protocol versions earlier than `2025-06-18` (which did not define the `MCP-Protocol-Version` header) **MAY** treat a request that omits the header as protocol version `2025-03-26`."

Declined: the modern branch does not silently treat an absent header as `2025-03-26`.
Declining it is what makes R10 binding, and C03 tests the consequence. Pre-`2025-06-18`
clients are served by the **legacy** branch, which they reach without ever presenting a
modern claim — see DUAL-ERA.md rows 6 and 8.

**Y3** — `[SHTTP]` Custom Headers from Tool Parameters — **declined for our own tools**
> "MCP servers **MAY** designate specific tool parameters to be mirrored into HTTP headers using an `x-mcp-header` extension property in the parameter's schema within the tool's `inputSchema`."

No production tool is annotated. The **server-side validation** is still a MUST (R15, R18),
because a client may send the header regardless — including the case the spec calls out
explicitly, where the client omits the header but puts the value in the body. The harness's
host injects an annotated tool for exactly this reason, so R15/R18 are exercised against
the real module rather than skipped.

**Y4** — `[SHTTP]` Receiving Messages — **declined**
> "The server **MAY** send JSON-RPC *notifications* — for example, [`notifications/progress`][notifications-progress] or [`notifications/message`][notifications-message] — before the final response. These notifications **MUST** relate to the originating client request."

**Y5** — `[VER]` Backward Compatibility — **taken**
> "A server that wishes to support both [legacy](#terminology) clients (which expect an `initialize` handshake) and [modern](#terminology) clients (which use per-request metadata) **MAY** implement both behaviors."
>
> "A dual-era server **MAY** serve both eras concurrently on the same endpoint or process."

This is the licence for the entire dual-era design. DUAL-ERA.md is its specification.

**Y6** — `[MRTR]` Server Requirements 1 — **declined**
> "Servers **MAY** respond to any [supported client request](#supported-requests) with an `InputRequiredResult`."

**Y7** — `[MRTR]` Server Requirements 2 — **declined**
> "The `InputRequiredResult` **MAY** include an `inputRequests` field."

**Y8** — `[MRTR]` Server Requirements 3 — **declined, with a standing condition**
> "The `InputRequiredResult` **MAY** include a `requestState` field. If specified, this field is an opaque string meaningful only to the server. Servers are free to encode the state in any format (e.g. base64-encoded JSON, encrypted JWT, serialized binary)."

Declined today. If it is ever taken, R49 binds immediately: the state must be HMAC- or
AEAD-sealed and verified, because it passes through the client.

**Y9** — `[CACHE]` Interaction with Notifications — **taken**
> "A server **MAY** provide `ttlMs` without advertising `listChanged: true` in its capabilities. In this case, the client relies entirely on TTL-based freshness."

Taken deliberately, together with S19: TTL without `listChanged`.

**Y10** — `[CACHE]` Interaction with Notifications — **declined**
> "A server **MAY** advertise `listChanged: true` **and** provide `ttlMs`."

**Y11** — `[CACHE]` Interaction with Pagination — **not applicable**
> "Servers **MAY** return different `ttlMs` values on different pages (e.g., a longer TTL for early pages of a stable list, a shorter TTL for the final page)."

**Y12** — `[MRTR]` Server Requirements 4 — **not applicable**
> "Integrity protection **MAY** be omitted only when tampering can cause nothing worse than request failure."

**Y13** — `[BASE]` Auth — **declined**
> "Additionally, clients and servers **MAY** negotiate their own custom authentication and authorization strategies."

**Y14** — `[BASE]` `$ref` Resolution — **declined**
> "Implementations **MAY** offer an opt-in mode that fetches non-local `$ref`s but it **MUST** be disabled by default and **SHOULD** enforce an allowlist of hosts or at minimum reject loopback, link-local, and private network addresses, apply timeouts and size limits, and log dereferenced URIs."

**Y15** — `[TOOLS]` Capabilities — **taken**
> "This set **MAY** be empty and **MAY** change over time […] The set **MAY** vary by the authorization presented on the request — for example, returning only the tools the caller's granted scopes permit — since credentials are per-request input, not connection state."

This is why `cacheScope` is `"private"` and never `"public"` (R31).

---

## 5. Authorization — A1–A11

Authorization is **OPTIONAL** for MCP implementations (`[AUTH]` Protocol Requirements), which
is why it is counted separately. This deployment implements it, so these bind.

**A1** — `[AUTH]` Token Handling — proof: **C47**
> "If validation fails, servers **MUST** respond according to [OAuth 2.1 Section 5.3](…) error handling requirements. Invalid or expired tokens **MUST** receive a HTTP 401 response."

C47 sends a request with no `Authorization` header and requires HTTP 401 with a
`WWW-Authenticate: Bearer …` header carrying a `resource_metadata="…"` parameter — without
that parameter a client cannot begin RFC 9728 discovery and the 401 is a dead end.

**A2** — `[AUTH]` Overview 4 — proof: **C48**
> "MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata ([RFC9728](…))."

**A3** — `[AUTH]` Token Handling — proof: **—**
> "MCP servers, acting in their role as an OAuth 2.1 resource server, **MUST** validate access tokens as described in [OAuth 2.1 Section 5.2](…)."

**A4** — `[AUTH]` Token Handling — proof: **—**
> "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to [RFC 8707 Section 2](…)."

**A5** — `[AUTH]` Token Handling — proof: **—**
> "MCP servers **MUST** only accept tokens that are valid for use with their own resources."

**A6** — `[AUTH]` Error Handling — proof: **C47**
> "Servers **MUST** return appropriate HTTP status codes for authorization errors: 401 Unauthorized — Authorization required or token invalid; 403 Forbidden — Invalid scopes or insufficient permissions; 400 Bad Request — Malformed authorization request"

**A7** — `[AUTH]` Step-Up Authorization Flow — proof: **—**
> "Servers **MUST** account for scope hierarchies, where a broader scope implies narrower ones, when deciding whether a token is sufficient for an operation."

**A8** — `[AUTH]` Security Considerations — proof: **—**
> "Implementations of this specification **MUST** follow the normative security requirements in [Security Considerations](…), covering token audience binding and validation, token theft, communication security, authorization code protection, mix-up and confused deputy attacks, open redirection, and Client ID Metadata Document security."

**A9** — `[AUTH]` Token Handling — proof: **—** (= F23)
> "MCP servers **MUST NOT** accept or transit any other tokens."

**A10** — `[AUTH]` Refresh Tokens — proof: **—**
> "**MCP Servers** (Protected Resources) **SHOULD NOT** include `offline_access` in `WWW-Authenticate` scope or Protected Resource Metadata `scopes_supported`, as refresh tokens are not a resource requirement."

**A11** — `[BASE]` Auth — proof: **—**
> "Implementations using an HTTP-based transport **SHOULD** conform to this specification, whereas implementations using STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment."

---

## 6. Recorded ambiguities

Places where the specification does not fix an answer. Each is a **decision**, not a claim
of conformance, and each is cited from `mcp2026.ts` so that a later reader can find the
reasoning instead of re-deriving it.

**Ambiguity 1 — the code for rejecting a batch body.**
`[SHTTP]` says "The body of the HTTP POST **MUST** be a single JSON-RPC *request* or
*notification*", and `[SCHEMA]`'s `JSONRPCMessage` has no array member — but the spec fixes
no error code for the server's rejection, because on this revision an array is not a
message at all. **Decision: HTTP 400 with `-32600` (Invalid Request) and `id: null`.**
`-32600` is a base JSON-RPC code, outside both reserved sub-ranges, so it cannot collide
with a future MCP allocation (F10) and is not a legacy code (F8). C16 asserts only what the
spec fixes: an HTTP error status, a non-array body, and a JSON-RPC error.

**Ambiguity 2 — a body that is not a JSON-RPC message at all.**
A syntactically valid JSON object with no `method` is neither a request nor a notification.
`[BASE]` gives `-32700` for unparseable JSON and `-32600` for an invalid request, but does
not say which applies. **Decision: parse failure is `-32700` (raised by the transport
layer); a parseable non-message is `400` + `-32600`, echoing `body.id` when one is present
so a client can still correlate.**

**Ambiguity 3 — `MCP-Protocol-Version` present, `params._meta` absent.**
Two requirements overlap: R16 says a *missing required header* is `-32020`, and R20 says a
request *missing a required `_meta` field* is `-32602`. A request with the header but no
`_meta` at all satisfies neither description cleanly. **Decision: the header being ABSENT is
a header failure (`-32020`); the header being PRESENT with no `_meta` to match against is a
malformed envelope (`-32602`).** The rule is: `-32020` is about disagreement between
envelope and body, `-32602` is about the body being incomplete. C03 and C17 pin both halves,
so a future refactor cannot quietly swap them.

**Ambiguity 4 — a stray `Mcp-Name` on a method that has neither `params.name` nor `params.uri`.**
R14 says headers that disagree with the body must be rejected, but a header with nothing in
the body to disagree with is not a disagreement. **Decision: ignored, not rejected.** The
spec's own `Mcp-Param` table takes the same shape ("Parameter not in arguments — Client MUST
omit the header"), and rejecting would break intermediaries that add headers for routing.

**Ambiguity 5 — header requirements on notification POSTs.**
`[SHTTP]` says outright: "header requirements for notification POSTs are not defined by this
revision." **Decision: validate them anyway, identically to requests.** A notification that
disagrees with its own envelope is exactly the split-brain R14 exists to stop, and the cost
of being stricter than undefined is nil for conforming clients.

**Ambiguity 6 — the status for an unknown *notification*.**
R5 requires "an HTTP error status code (e.g., `400 Bad Request`)" but R12 requires 404 for an
unimplemented *method*. **Decision: 404 with `-32601` and no attributable id**, which
satisfies R5 (404 is an error status) and keeps one answer for "this server does not
implement that method" regardless of whether an id was present. C14 asserts only R5's
requirement, `status >= 400`, so the decision is not smuggled into the conformance claim.

---

## 7. The harness, and the defect it was rebuilt to not have

`conformance.mjs` is node-builtins-only (the build image is `node:24-slim` and npm is
restricted) and drives raw `http.request` rather than `fetch`, because three requirements
are untestable through a client library: R19 needs control of header-name casing, F13 needs
an array body on the wire, and R15 needs a raw non-ASCII octet in a header value.

### The R20a guard

The prior run's single FAIL was not a server defect. It was id bookkeeping **inside the
harness**: a probe built its raw JSON body with one id, then handed that body to a request
helper whose signature was `send(method, params, id = nextId())`. The default parameter
fired, allocated a **second** id, and the check asserted against an id that had never been
on the wire. The commit that recorded it named it **R20a**.

The rebuild makes that class of bug unrepresentable rather than merely absent:

1. `nextId()` is the only id source, and it is never called from a default parameter.
2. No request function takes an `id` with a default. `rpc()` throws `HarnessBug` if `id` is
   not explicitly present — passing `id: null` is how a notification is requested, so the
   absent case cannot be silently defaulted into existence.
3. Every id assertion goes through `expectId(sent, res, id)`, which **re-parses the bytes
   that were actually sent** and throws `HarnessBug` if `sent.id !== id`, *before* looking
   at the response. An id that never reached the wire can therefore never be asserted
   about; the harness accuses itself before it can accuse the server.
4. `HarnessBug` is counted separately from FAIL and always forces exit code 2, in both
   normal and `--selftest` mode, so it can never be read as a server result.

### `--selftest` is not optional

`node conformance.mjs --selftest` runs **every** check against a deliberately non-conforming
stub server built into the same file, and exits non-zero if any check PASSes **or SKIPs**.
Each of the stub's 24 numbered violations names the requirement it breaks. A suite that
goes green against a broken server is worse than no suite; run the oracle first and report
its count alongside any green run, or the green run means nothing.

### Check index

| Check | Requirements |
| --- | --- |
| C01 | R2, R3 |
| C02 | R1 |
| C03 | R8, R10, R16, Y2 |
| C04 | R9, R16 |
| C05 | R13, R16 |
| C06 | R14, R16 |
| C07 | R13, R16 |
| C08 | R14, R16 |
| C09 | R17 |
| C10 | R19 |
| C11 | R11, R26 |
| C12 | R12 |
| C13 | R4, F3 |
| C14 | R5 |
| C15 | R6, S3 |
| C16 | F13, Ambiguity 1 |
| C17 | R20, Ambiguity 3 |
| C18 | R20 |
| C19 | R20 |
| C20 | R22 |
| C21 | R23 |
| C22 | R24 |
| C23 | R25, R34, S19 |
| C24 | S6 |
| C25 | R28, R29 |
| C26 | R28, R29, R31, F22 |
| C27 | R37, R45, R51 |
| C28 | S7, F5, F19, S25 |
| C29 | R18, R16 |
| C30 | R18, S18 |
| C31 | R15, R16 |
| C32 | R18, R16 |
| C33 | R41, R45 |
| C34 | R41, F11 |
| C35 | F11 |
| C36 | R24, F8, F10 |
| C37 | S9 |
| C38 | S10, F5 |
| C39 | S8 |
| C40 | S8 |
| C41 | R40, F1, S5 |
| C42 | R21, F6 |
| C43 | F16, R46 |
| C44 | F9, F12 |
| C45 | R32, R33, F14, F15 |
| C46 | R39 |
| C47 | A1, A6, S2 |
| C48 | A2 |
| C49 | R23, F4 |
| C50 | R18 (null value) |
| C51 | R18 (absent value) |
| C52 | F8 |
| C53 | R11, R26 |
| C54 | S11, DUAL-ERA.md B4 |

### What the harness deliberately does not claim

* **Endpoint-scope checks, and how a skip is adjudicated.** C39, C40 and C48 cover surfaces
  that live in `control-plane/src/index.ts` (GET/DELETE routing on `/mcp`, and the
  `.well-known/oauth-protected-resource` document), not in `mcp2026.ts`. The harness's
  `--host` mode sends `X-MCP-Harness-Host: module-only` on every response to declare that
  it hosts the module and nothing else, and those three checks SKIP against such a host.
  They are **not** re-implemented in the host, because a check that passes against the
  harness's own copy of the code under test proves nothing. Under `--selftest` the stub does
  not send that header, so all three run and must fail — the oracle is still proved.

  None of the three is unexercisable. They are unexercisable **from the `--host` seat**, and
  all three execute on the endpoint seat:

  ```
  node conformance.mjs https://<host>/mcp --token <T>
  ```

  Being merely *absent from the failures* is not good enough for any of them, so the runner
  now adjudicates skips instead of counting them. `REVIEWED_SKIPS` in `conformance.mjs` maps
  each permitted skip to the owner of the surface, the seat that can reach it and the exact
  command; every skip is reprinted after the summary under
  **COVERAGE NOT PROVEN BY THIS SEAT** so a green run cannot be read as a complete one; and a
  skip that is **not** on that list is a HOLE that exits **11**. Adding an entry to quiet a
  red is the one abuse this cannot detect, which is why an entry naming no command must say
  `NO SEAT CAN EXERCISE THIS` in the output and be defended on its own terms.
* **Requirements marked `—` above.** Rate limiting, output sanitisation, token audience
  validation, cancellation side effects, MRTR internals for a pattern this server never
  emits: none are observable from a black-box HTTP probe, and the harness says so rather
  than asserting a vacuous pass.
* **The injected tool set.** In `--host` mode the harness supplies three synthetic tools
  (`aaa_echo`, `hdr_tool` with an `x-mcp-header` annotation, `zzz_last`) through the
  module's own `tools(role)` dependency. That is the *dependency*, not the code under test:
  every protocol decision — ordering, header mirroring, error codes, envelopes — is made by
  `mcp2026.ts`. Production's tool set comes from Firestore and is not fixed enough to test
  against. The three names are chosen so that insertion order and sorted order differ,
  which is what makes S7 falsifiable.
