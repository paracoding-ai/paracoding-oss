<!-- SPDX-License-Identifier: Apache-2.0 -->
# DUAL-ERA.md — how one `POST /mcp` serves two protocol eras, and the ten ways to break it

**Path:** `control-plane/mcp2026/DUAL-ERA.md`. This is the document
`control-plane/src/mcp2026.ts` cites as NORMATIVE for era selection. Its companions are
`control-plane/mcp2026/CONFORMANCE.md` (the requirement checklist) and
`control-plane/mcp2026/conformance.mjs` (the runnable harness).

Rebuilt from the specification, not recovered: the original was written in a prior agent's
container and is gone. Section numbers and identifiers (§1, §5, B1, B4, B7, B10) are
reconstructed to match the citations already in `mcp2026.ts` and `index.ts`.

---

## 0. The licence, and the terminology

`[VER]` Backward Compatibility with Initialization-Based Versions:

> "A server that wishes to support both **legacy** clients (which expect an `initialize`
> handshake) and **modern** clients (which use per-request metadata) **MAY** implement both
> behaviors."
>
> "A dual-era server **MAY** serve both eras concurrently on the same endpoint or process."

and its terminology, quoted because every sentence below depends on it:

> "**Modern**: protocol versions that convey version, identity, and capabilities as
> per-request metadata (revision `2026-07-28` and later). **Legacy**: protocol versions that
> establish a session with an `initialize` handshake (`2025-11-25` and earlier).
> **Dual-era**: an implementation that supports both modern and legacy versions."

We are the third one. `POST /mcp` answers modern `2026-07-28` traffic out of
`control-plane/src/mcp2026.ts` and legacy `2025-06-18`-era traffic out of
`@modelcontextprotocol/sdk` 1.29.0 — the same URL, the same process, chosen per request.

`[VER]` also fixes what the server must key off:

> "A dual-era **server** selects its behavior from how the client opens:
> A request carrying modern per-request `_meta` is served statelessly according to this
> revision. An `initialize` request selects legacy semantics, scoped to the stdio process
> (stdio) or the session (HTTP), as specified by the negotiated legacy protocol version."

---

## 1. The era selection rule, entire

> A request is served **MODERNLY** if and only if it makes a modern **VERSION CLAIM**:
> `params._meta["io.modelcontextprotocol/protocolVersion"]` is present at **any** value, or
> — **only when that key is absent** — the `MCP-Protocol-Version` header names a revision in
> this server's modern set. **Everything else is legacy.**

Three properties of that rule, each of which is load-bearing:

**1a. The body is read first.** `_meta` is the specification's source of truth; `[TRANS]`
Request Metadata says so in as many words: "The body remains the source of truth; bindings
that mirror metadata define how mismatches are rejected." Reading the header first would
demote a *malformed* modern claim to the legacy branch, where it would be answered
`-32000` instead of the `-32602` the modern branch owes it (CONFORMANCE.md R20). A client
that sent a broken envelope would be told the server is legacy. That is B3.

**1b. The header alone decides only when the body is silent, and only for revisions in our
modern set.** Clients on `2025-06-18` through `2025-11-25` send `MCP-Protocol-Version` too.
Routing on the header's mere presence would send every one of them to the modern branch,
where they would collect a `-32020` for an envelope their revision does not define. That is
row 8 of the table below, and getting it wrong is B4.

**1c. `Mcp-Session-Id` is never an input.** It is not read, not minted, not echoed
(CONFORMANCE.md S9). Making it an era input is B5.

### The decision table

Row numbers are stable identifiers; `mcp2026.ts` and `index.ts` cite them by number.

| Row | Request | Era | Answered by |
| --- | --- | --- | --- |
| **0** | Any method other than POST on `/mcp` (GET, DELETE) | neither | `index.ts` — `405 Method Not Allowed`, after the auth challenge. Never a bare 404. |
| **1** | POST, single body, `method === "initialize"` | **LEGACY** | sdk 1.29.0 handshake |
| **2** | POST, **array** body, no element carries a modern claim | **LEGACY** | sdk 1.29.0 (a legacy batch stays legacy no matter what header rides along) |
| **3** | POST, **array** body, at least one element carries a modern claim | **MODERN** | `mcp2026.ts` — rejected `400` + `-32600`: batching was removed (CONFORMANCE.md F13) |
| **4** | POST, single body, `params._meta["io.modelcontextprotocol/protocolVersion"]` present at **any** value | **MODERN** | `mcp2026.ts` |
| **5** | POST, single body, no body claim, `MCP-Protocol-Version` names a revision in `MCP2026_MODERN_VERSIONS` | **MODERN** | `mcp2026.ts` |
| **6** | POST, single body, no body claim, **no** `MCP-Protocol-Version` header | **LEGACY** | sdk 1.29.0 |
| **7** | POST, single body, no body claim, `MCP-Protocol-Version` present but **not revision-shaped** (garbage, empty, `banana`) | **LEGACY** | sdk 1.29.0 |
| **7b** | POST, single body, no body claim, `MCP-Protocol-Version` is a well-formed `YYYY-MM-DD` revision **≥ `2026-07-28`** that we do not implement (an unknown FUTURE revision) | **MODERN** | `mcp2026.ts` — `400` + `-32022` listing `supportedVersions` (CONFORMANCE.md R11, check C53) |
| **8** | POST, single body, no body claim, `MCP-Protocol-Version` names a **legacy** revision (`2025-06-18` … `2025-11-25`) | **LEGACY** | sdk 1.29.0 |

Row 8 is the load-bearing one. It is the row that keeps the operator's existing connector
working, and it is the row a "tidy-up" refactor is most likely to delete.

**Row 7b was row 7, and it was wrong.** Lumping an unknown *future* revision in with garbage
sent it to the legacy branch, where it collected `-32000` at HTTP 200 — not a recognised
modern error — so a modern client on a later revision fell back to `initialize` and
negotiated itself down to 2025-06-18 instead of being told what we support. `[VER]`
Terminology defines the eras by DATE, not by what we happen to implement: "**Modern**:
protocol versions that convey version, identity, and capabilities as per-request metadata
(revision `2026-07-28` **and later**)". A future revision is a modern-era request by
definition, and `[VER]` Protocol Version Negotiation requires that a version we do not
implement — "whether the version is **unknown** to the server, or is a known version the
server has chosen not to support" — be answered `400` + `UnsupportedProtocolVersionError`.
That answer is unreachable from the legacy branch, so the routing decision *is* the defect.

Rows 7 and 7b are told apart by SHAPE and then by DATE, and both halves are load-bearing.
MCP revisions are ISO `YYYY-MM-DD`, so a lexical comparison is a chronological one — but only
for strings of that shape. Without the shape guard, `banana` sorts **above** `2026-07-28` in
ASCII (letters above digits) and every garbage header value would be promoted to the modern
era. Without the date threshold, row 8 collapses into row 7b and every 2025-era client is
routed modern, which is B4. C53 and C54 pull in opposite directions for exactly this reason:
C53 fails if unknown future revisions are held out of the modern era, C54 fails if known
legacy ones are pulled into it, and no one-sided rule satisfies both.

Rows 2 and 3 say the same thing twice on purpose: **an array body is decided by its elements
alone.** A batch that carries a modern claim must reach the modern branch so it can be
refused with the modern error; a batch that does not must stay legacy so the sdk can answer
it the way it always has. Deciding an array by its headers is B6.

Row 4 says "present at **any** value" — including `null`, including a version we do not
support, including nonsense. A request that has declared itself modern is entitled to a
modern answer, even if that answer is `-32022` or `-32602`. Demoting it to legacy would tell
a dual-era client the server is legacy on the strength of the client's own typo.

---

## 2. Why the legacy `-32000` is load-bearing, and must not be tidied

The legacy branch answers an unroutable request with:

```json
{"jsonrpc":"2.0","id":<id>,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}
```

at HTTP 400. It looks like a code smell. It is the mechanism.

`[SHTTP]` Backward Compatibility tells a dual-era **client** exactly how to decide what it is
talking to:

> "A client that supports both modern (per-request-metadata) MCP versions and a legacy
> version that requires an `initialize` handshake **MAY** detect which era the server
> implements by attempting a modern request first. On `400 Bad Request`, the client
> **SHOULD** inspect the response body before falling back: modern servers also use `400`
> for `UnsupportedProtocolVersionError`, `MissingRequiredClientCapabilityError`, and
> header-validation failures.
>
> * If the body contains a recognized modern JSON-RPC error, the server speaks a modern
>   version of MCP — retry using the advertised `supported` versions or correct the request,
>   rather than falling back.
> * If the body is empty or is not a recognized modern JSON-RPC error, fall back to
>   `initialize` and continue with the legacy version for subsequent requests."

And `[BASE]` Error Codes fixes what "recognized modern JSON-RPC error" can mean:

> "**`-32000` to `-32019` — legacy.** Codes in this sub-range were allocated by
> implementations before this policy was introduced. New codes **MUST NOT** be allocated in
> this sub-range, and new implementations **SHOULD NOT** use codes from this sub-range at
> all. Apart from `-32002` (see below), receivers **MUST NOT** assume any specific meaning
> for these codes."
>
> "**`-32020` to `-32099` — reserved for the MCP specification.** Error codes in this
> sub-range are defined exclusively by the MCP specification […]"

Put the two together:

**`-32000` is implementation-defined. It is therefore NOT a recognized modern error. A
dual-era client that receives `400` + `-32000` falls back to `initialize` — which is exactly
why the operator's connector works today.**

It is not grandfathered by accident, either: F8 forbids *new* allocations in that sub-range,
and this is not a new one. Nothing about the modern branch allocates there.

### The concrete failure

Change `-32000` to something in `-32020..-32099` "for tidiness" — say `-32601`, or
`-32020`, or a bespoke `-32050` — and this happens, in this order:

1. A dual-era client sends a modern request.
2. It has no modern claim in the body (the client is probing), so row 6 or row 8 routes it
   legacy.
3. The legacy branch answers `400` with the tidied code.
4. `-32020`/`-32021`/`-32022` are **recognized modern errors**, so the client concludes the
   server is modern and *does not fall back*. It "corrects" a request that was already
   correct, or retries a version negotiation against a server that has no modern answer for
   it, and deadlocks.
5. A **pure legacy** client — which has no fall-forward mechanism at all, per `[VER]`'s
   compatibility matrix — simply dies.

`-32601` is subtler and just as bad: it is a base JSON-RPC code, not a reserved-range one,
so a client that reads "recognized modern JSON-RPC error" loosely (any JSON-RPC error with a
code the modern schema defines — and `MethodNotFoundError` *is* in the modern schema) will
also stop falling back. The only safe answer is a code the modern schema does not define,
which is what `-32000` is.

**Rule: the legacy branch's error code is protocol surface. It is covered by the same review
gate as any wire format. It does not change without a client-compatibility argument written
down next to it.**

---

## 3. The compatibility matrix, and which rows we are

`[VER]` Compatibility Matrix, quoted for the two rows this design exists to satisfy:

> | Client | Server | Outcome |
> | --- | --- | --- |
> | Dual-era | Legacy | Works. […] HTTP: the modern request returns a `4xx` without a recognized modern error body, and the client falls back to `initialize` (and possibly further to the deprecated HTTP+SSE transport). |
> | Legacy | Dual-era | Works. The server answers `initialize` and serves the client according to the negotiated legacy revision. |

Our endpoint is the **Dual-era server** column. Concretely:

* **Modern client → us.** Rows 4 and 5. Served by `mcp2026.ts`, statelessly.
* **Dual-era client → us.** Its probe carries a modern claim, so row 4 or 5 answers it
  modernly and it stays modern. If its probe carries no claim, rows 6–8 answer it with
  `-32000`, it falls back to `initialize`, and row 1 serves it. **Both outcomes are
  correct.** That is the whole point: the client picks, per its own probe, and we answer
  consistently either way.
* **Legacy client → us.** Rows 1, 6, 7, 8. Never touches `mcp2026.ts`.

And the row that explains why a modern-only deployment is not an option here:

> | Legacy | Modern | Fails. […] HTTP: the request is missing the required headers and is rejected per server validation with `400 Bad Request`. Legacy clients have no fall-forward mechanism. |

Deleting the legacy branch does not degrade legacy clients. It ends them.

---

## 4. The era determination is cached by the client, per origin

`[VER]`:

> "The era determination is a property of the server, not of an individual request. Clients
> **SHOULD** cache the result for the lifetime of the server process (stdio) or origin
> (HTTP), and **MAY** persist it across restarts of the same server configuration,
> re-probing if the cached assumption later fails."

This is why **routing must be a pure function of one request's bytes**: no connection state,
no cache, no clock, no per-instance flag, no sticky load balancing. Two byte-identical
requests that landed on different eras — because they hit different instances, or the same
instance at different times — would make a client pin the wrong era **for its whole
process**. A 1-in-N routing flake becomes a permanently broken connector. That is B7.

It is also why `[VER]`'s modern-only-server advice is recorded but not yet binding on us
(CONFORMANCE.md S11): we answer `initialize`, so we never return an error to it. The day the
legacy branch is removed, that error must name our supported versions, because it will be
the only diagnostic a legacy client can show a human.

---

## 5. The review invariant, as a file boundary

**Everything in `control-plane/src/mcp2026.ts` is the modern branch. Nothing in it may be
reached by a legacy request, and `index.ts` must never call any of it above the era router.**

Stated as something a reviewer can grep for rather than reason about:

> **`-32020`, `-32021`, `-32022`, and HTTP `404` / `405` / `406` appear ONLY in
> `control-plane/src/mcp2026.ts` (and, for `405` on row 0, in the two `index.ts` route
> handlers that own GET and DELETE on `/mcp`).**

Why those six tokens specifically:

* `-32020`, `-32021`, `-32022` are the three codes `[BASE]` defines, and they are precisely
  the set a dual-era client reads as "this server is modern, stop falling back".
* `404` and `405` are two of the three statuses `[SHTTP]`'s HTTP+SSE fallback ladder keys
  off ("If it fails with HTTP status code `400 Bad Request`, `404 Not Found`, or
  `405 Method Not Allowed` **and** the response body is not a recognized modern JSON-RPC
  error"). Emitting them from a legacy-classified path sends a client down that ladder.
* `406` is not used at all; it is in the invariant so that adding Accept-header negotiation
  above the router is a visible event rather than a quiet one.

Corollary, and it is the one that gets violated by well-meaning refactors: **all modern
header validation lives inside `mcp2026Handle`, below the router.** Not in middleware, not
in a shared `validateHeaders()` helper called from both branches, not in an Express
`app.use`. Hoisting any of it is B1.

---

## 6. The ten ways to break fallback

Each of these is a change that looks like an improvement, compiles, passes a naive test
suite, and breaks a client that cannot tell you it broke.

### B1 — Hoist modern header validation above the era router

Move the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` checks into middleware "so both
branches get them". Today's envelope-less legacy traffic then collects a `-32020` **before**
anything looks at its era. A dual-era client reads `-32020` as a recognized modern error,
stops falling back, "corrects" a request that is already correct, and deadlocks. A pure
legacy client, with no fall-forward mechanism, dies outright. This is the single most likely
break, because "validate early, validate once" is normally right.

### B2 — Answer a legacy-classified request with 404, 405 or 406

Including by accident: an unmatched route, a stricter `Accept` check, a proxy rule. `[SHTTP]`
tells a client that a `404`/`405` with no modern error body means "no modern MCP endpoint
lives here — go probe the deprecated HTTP+SSE `GET` transport". A legacy client that was
about to succeed at `initialize` gets sent to a transport we do not host. This is why
`index.ts` registers `DELETE /mcp` explicitly (row 0) instead of letting Express answer a
bare 404.

### B3 — Read the header before the body

Then a request with a **malformed** modern claim (`_meta` present, version wrong type,
capabilities missing) and no usable header is demoted to legacy and answered `-32000`. The
client is told the server is legacy on the strength of its own typo, and pins that for the
lifetime of the origin (§4). The body is the source of truth; read it first, and answer a
broken modern envelope with `-32602` (CONFORMANCE.md R20, Ambiguity 3).

### B4 — Put a legacy revision in `MCP2026_MODERN_VERSIONS`, or widen the era test past the date

The array is what makes a bare `MCP-Protocol-Version` header select the modern era (row 5).
Adding `2025-11-25` to it "for completeness" turns row 8 into row 5: every `2025-06-18` …
`2025-11-25` client — all of which send that header — is routed to the modern branch and
rejected for an envelope its revision does not define. The `[VER]` matrix row
`Legacy → Dual-era: Works` becomes `Fails`. **Membership in that array is a promise to serve
the revision modernly, not a list of revisions we have heard of.**

`mcp2026IsModernRevision` now admits a second class — a revision-shaped value at or after
`2026-07-28` (row 7b) — and that is the same hazard with a different handle. The two
conditions in it are not belt-and-braces:

* drop `MCP_REVISION_RE` and any garbage header value outranks the threshold and is served
  modernly;
* drop `>= MCP2026_VERSION` and every 2025-era revision is revision-shaped too, so row 8
  becomes row 7b and the connector that works today stops working.

Neither failure is visible in a `--host` run that only sends well-formed modern traffic.
C53 and C54 are the two controls, and they must both stay green together.

### B5 — Make `Mcp-Session-Id` (or any connection state) an era input

"If it has a session id, it's a 2025-era client" is tempting and wrong twice over: the
modern revision removed sessions entirely, and `[SHTTP]` says to *ignore* the header, never
to mint or echo it. Worse, it makes routing depend on state, which is B7. Any input that is
not in the bytes of the current request is disqualified.

### B6 — Decide an array body by its headers instead of its elements

A legacy batch with a stray modern header would be routed modern and rejected `-32600`; a
modern batch with no header would be routed legacy and half-processed by the sdk. Rows 2 and
3 exist because the elements are the only honest signal — and because a batch that *did*
claim to be modern must reach the modern branch to be told, in modern terms, that batching
was removed.

### B7 — Let anything other than this request's bytes influence the decision

A per-instance "we've seen modern traffic" flag, a cache keyed by client IP, a clock ("after
the cutover date, default modern"), sticky sessions at the load balancer. Because clients
cache the era **per origin, for the lifetime of the process** (§4), a decision that varies
across two byte-identical requests will pin some fraction of clients to the wrong era
permanently. The failure is intermittent at first and total afterwards, which is the worst
possible shape.

### B8 — Let the modern branch return HTTP 500

A `500` is not in the fallback trigger set (`400`, `404`, `405`) and is not a recognized
modern error either, so a dual-era client neither falls back nor retries — it just fails, and
may or may not cache that as "modern". Every path in the modern branch must terminate in a
described response: an unrepresentable tool schema publishes an untyped property list and
logs loudly, a throwing tool becomes an `isError` result (CONFORMANCE.md R41), and the router
wraps the whole modern call in a try/catch of last resort. **Losing one type annotation
loudly beats a stack trace.**

### B9 — Change the legacy branch's HTTP status from 400

`[SHTTP]`'s rule is "On `400 Bad Request`, the client **SHOULD** inspect the response body
before falling back." A `200` carrying a JSON-RPC error is not a fallback trigger at all —
the client never looks at the body, sees a successful HTTP exchange, and hangs waiting for a
result it will not get. A `503` or `502` is read as a transport problem and retried forever.
The status and the body are a pair: `400` + a non-modern error code. Change neither alone.

### B10 — Change the legacy `-32000` for tidiness

The whole of §2. `-32000` is implementation-defined, therefore not a recognized modern
error, therefore the thing that makes a dual-era client fall back to `initialize`. Renumber
it into `-32020..-32099` and every dual-era client stops falling back; renumber it to
`-32601` and clients that treat "any code the modern schema defines" as modern stop too.
It looks like a code smell and it is load-bearing. **If a linter, a schema check, or a
future SDK migration proposes changing it, that is a protocol change and needs this
document quoted in the review.**

---

## 7. What proves any of this

`conformance.mjs` proves the **modern** branch against CONFORMANCE.md, and two of its checks
bear directly on the era contract:

* **C16** (F13) drives an array body and requires the modern-branch rejection, which is
  row 3.
* **C37** (S9) and **C38** (S10) prove no session id is minted or echoed and that
  `Last-Event-ID` changes nothing — B5 and the statelessness half of B7.

The era router itself, `mcp2026IsModernRequest`, is a pure function of `(headers, body)`.
Every row of the decision table can be asserted directly against it without a socket, and a
row-by-row acceptance test belongs beside this file. The invariant in §5 is a grep, and
should be one: a CI rule that fails the build if `-32020`, `-32021`, `-32022`, `404`, `405`
or `406` appears in `index.ts` outside the two row-0 route handlers costs nothing and catches
B1 and B2 on the day they are written, rather than on the day a connector stops working.
