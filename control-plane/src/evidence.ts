// SPDX-License-Identifier: Apache-2.0
//
// [PC-WITNESS-V1] An evidence record for EVERY tool call, and a policy point where there was none.
//
// WHAT THIS CLOSES. Today authorization on the ~55-tool MCP surface lives INSIDE individual
// handlers: read_job_log checks LOG_READ_ALL inline, the advisors check PC_ADVISOR_ROLES inline,
// run_cmd and gcp_api go to the gate. Nothing decides, in one place, whether a given role may make
// a given call with given ARGUMENTS, and nothing records that a call happened. The gate's permit is
// the right idea and it covers exactly one tool: a staged job is KMS-signed over a digest of its
// arguments, one approval, one run. Every other tool -- git_push, write_file, put_file, gcp_api's
// blessed-read path -- is gated by role scope alone and leaves no record binding the call to any
// authorization at all.
//
// WHERE IT PLUGS IN, AND WHY THAT SPOT. buildMcpServer already shadows registerTool exactly once,
// for the result cap, and the comment there states the reason better than this one could: it is the
// ONE funnel every tool of every file passes through, both eras are downstream of it, and there is
// "no way for a new tool to opt out by forgetting". This adds one more wrap at that same seam. One
// line changes; ~55 tools and every tool added after today are covered.
//
// THREE PROPERTIES, AND THE THIRD IS THE ONE THAT IS USUALLY MISSING.
//
//   1. The record is bound to the ARGUMENTS, not the tool name. request_digest is the RFC 8785
//      JCS digest of the call's arguments. "fleet-recorder called git_push" is not evidence; "fleet-recorder
//      called git_push with arguments that canonicalize to sha256:abcd" is.
//
//   2. Refusals are recorded, not just allows. A log containing only successes cannot distinguish
//      "nothing was refused" from "nothing was checked".
//
//   3. THE LOG REPORTS ITS OWN LOSSES. Every record carries a per-process sequence number and a
//      process id. A write that fails is counted and the count rides on the NEXT record that
//      succeeds, so a dropped record leaves a visible gap instead of nothing at all. This is
//      deliberate and it is the lesson from the forever-archive: that dual-write is fire-and-forget
//      with .catch(function(){}), which is correct for availability and means a dropped row is
//      invisible by construction. A witness that cannot report its own gaps is the same mistake.
//
// WHAT IT DOES NOT DO. It does not chain or sign here. A hash chain needs a serialized head, and
// serializing every tool call through one Firestore document would put a ~1 write/sec ceiling on
// the whole fleet. The chain and the signed RFC 6962 checkpoint are computed OUT OF BAND by the
// anchoring worker, over these records in a deterministic total order. The per-process seq is what
// lets the anchor tell a gap from a quiet period.
//
// FAIL-OPEN BY DEFAULT, AND SAID OUT LOUD. PC_WITNESS_ENFORCE ships OFF: policy decisions are
// recorded and the call proceeds. This mirrors PC_TOOLS_ENFORCE, which shipped observe-only for the
// same reason -- flipping a new boundary on for a fleet that never asked breaks work that was
// legitimate yesterday. Observe first, read the records, then enforce.

import { createHash, randomBytes } from 'crypto';

export interface WitnessDeps {
  /** Firestore-like: db.collection(name).add(doc). Injected so this module is testable with no cloud. */
  db: any;
  /** FieldValue.serverTimestamp, injected for the same reason. */
  serverTimestamp: () => any;
  /** Where records go. Deliberately NOT `journal`: different shape, different volume, own retention. */
  collection?: string;
  /** Overridable for tests. */
  now?: () => number;
}

export interface Decision {
  allowed: boolean;
  /** Plain language. This reaches a person reading a refusal, so "denied" alone is not acceptable. */
  reason: string;
  rule?: string;
  /** Set when a rule matched but PC_WITNESS_ENFORCE is off: recorded, not applied. */
  observed?: boolean;
}

// ---------------------------------------------------------------- RFC 8785 JCS
//
// Ported from ts/jcs.ts on repo/fleet-inspector, which was cross-checked against the Python
// implementation over 2,400 real entries out of this fleet's own journal: 2400/2400 entry hashes
// agreed and both produced RFC 6962 root sha256:f3d3cdedd98d1392. Reusing that exact code is the
// point -- a second canonicalization that is merely "deterministic-looking" would make the digests
// here incomparable with the ones the anchoring worker and the plugin produce.

const ESCAPES: { [k: number]: string } = {
  0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f',
  0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\',
};

export class CanonicalizationError extends Error {}

function serializeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    const esc = ESCAPES[code];
    if (esc !== undefined) out += esc;
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// ECMAScript Number::toString IS the JCS number format, so String(n) is the algorithm rather than
// an approximation of it. No MAX_SAFE_INTEGER guard: anything that is already a `number` is already
// a double, so the guard would refuse ordinary values (1e21, 1e20) that a conforming implementation
// accepts. The JS counterpart of the arbitrary-precision int that guard exists for is `bigint`,
// refused below.
export function serializeNumber(value: number): string {
  if (!isFinite(value)) throw new CanonicalizationError('no JSON representation: ' + String(value));
  if (value === 0) return '0'; // covers -0, which JCS renders as "0"
  return String(value);
}

export function canonicalize(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return serializeString(value);
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'bigint') {
    throw new CanonicalizationError('bigint has no JCS form; send it as a string');
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(canonicalize(item));
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    // JCS sorts object keys by UTF-16 code unit, which is what JavaScript's default string
    // comparison already does.
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const k of keys) parts.push(serializeString(k) + ':' + canonicalize(value[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalizationError('no JSON representation: ' + typeof value);
}

export function digest(value: any): string {
  return 'sha256:' + createHash('sha256').update(Buffer.from(canonicalize(value), 'utf8')).digest('hex');
}

// ---------------------------------------------------------------- argument hygiene

/**
 * Strip the credential before anything is hashed or stored.
 *
 * `agent` carries a SERVER-MINTED SESSION KEY, not a role name. It must never reach a stored
 * record, and it is removed before the digest rather than after so that the digest itself cannot
 * be used as an oracle against a guessed key. Removing it also makes the digest mean the thing we
 * actually want it to mean: two calls with identical INTENT hash identically regardless of which
 * key presented them, and the acting role is recorded in its own field.
 */
export function scrubArgs(args: any): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args === undefined ? null : args;
  const out: any = {};
  for (const k of Object.keys(args)) {
    if (k === 'agent') continue;
    out[k] = args[k];
  }
  return out;
}

// ---------------------------------------------------------------- policy

const TRUNK = ['main', 'master', 'refs/heads/main', 'refs/heads/master'];

/**
 * Roles permitted to move the trunk. Env so the set changes without a redeploy, matching how
 * LOG_READ_ALL and PC_ADVISOR_ROLES already work. '*' disables the rule.
 */
function trunkWriters(): string[] {
  return String(process.env.PC_TRUNK_WRITERS || '*')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Absolute-path invocation in a staged shell command.
 *
 * THIS RULE EXISTS BECAUSE THE FLEET ALREADY MEASURED THE HOLE AND WROTE IT DOWN: the executor
 * restricts PATH to a directory of symlinks to an enumerated set of binaries, and run_command's own
 * description says "KNOWN GAP: an ABSOLUTE PATH still runs, so this is a real control and not a
 * sandbox." A PATH jail cannot see /usr/bin/whatever. This does not close the gap -- only a kernel
 * sandbox does that -- but it makes every attempt to walk around the jail VISIBLE in the record,
 * which is the difference between a control nobody can audit and one somebody can.
 *
 * Deliberately conservative about what counts. It matches an absolute path in command position:
 * the start of the script, or after a newline, `;`, `|`, `&&`, `||`, backtick or `$(`. It does NOT
 * match an absolute path used as an ARGUMENT, because `cat /etc/hosts` is not an attempt to reach
 * an unlisted binary and flagging it would bury the real signal in noise.
 */
export function absolutePathBinaries(command: string): string[] {
  if (!command) return [];
  const hits: string[] = [];
  const re = /(?:^|[\n;|&`]|\$\()\s*(\/(?:usr\/|bin\/|sbin\/|opt\/|snap\/)[^\s;|&)`'"]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    if (hits.indexOf(m[1]) < 0) hits.push(m[1]);
    if (hits.length >= 8) break; // a summary, not a transcript
  }
  return hits;
}

/**
 * Evaluate one call. Pure: no I/O, no clock, no randomness, so it is driven directly by tests.
 *
 * Default is ALLOW. That is the honest default for a control being introduced into a working
 * fleet: the value in v1 is the record, and a default-deny bolted onto ~55 tools nobody has
 * profiled yet would break legitimate work on the first night. The rules below are the ones where
 * a refusal is defensible today.
 */
export function decide(role: string, tool: string, klass: string, args: any): Decision {
  const a = args || {};

  if (tool === 'git_push') {
    const branch = String(a.branch || '');
    const writers = trunkWriters();
    if (TRUNK.indexOf(branch) >= 0 && writers.indexOf('*') < 0 && writers.indexOf(role) < 0) {
      return {
        allowed: false,
        rule: 'trunk-writers',
        reason: 'role `' + role + '` may not move `' + branch + '`. PC_TRUNK_WRITERS lists ['
          + writers.join(', ') + ']. Push to a branch and let a release role move the trunk.',
      };
    }
  }

  if (tool === 'write_file' || tool === 'put_file') {
    const path = String(a.path || '');
    const m = /^agents\/([^/]+)\//.exec(path);
    if (m && m[1] !== role) {
      return {
        allowed: false,
        rule: 'private-lane',
        reason: 'path `' + path + '` is in the private lane of `' + m[1] + '` and the caller is `'
          + role + '`. A lane nobody else can read is not a lane anybody else may write.',
      };
    }
  }

  if (tool === 'run_command') {
    const hits = absolutePathBinaries(String(a.command || ''));
    if (hits.length) {
      return {
        allowed: false,
        rule: 'absolute-path-binary',
        reason: 'the staged script invokes ' + hits.length + ' binary/binaries by ABSOLUTE PATH ('
          + hits.join(', ') + '), which walks around the executor PATH allowlist. run_command\'s '
          + 'own description records this as a known gap. Use a listed binary, or say plainly in '
          + 'the reason why this one needs an absolute path.',
      };
    }
  }

  return { allowed: true, reason: 'no rule refuses this call', rule: undefined };
}

// ---------------------------------------------------------------- the witness

function enforcing(): boolean {
  return String(process.env.PC_WITNESS_ENFORCE || '') === '1';
}

/** Per-process identity and counter. See property 3 in the header. */
let SEQ = 0;
let DROPPED = 0;
const PROC = (process.env.K_REVISION || 'local') + ':' + randomBytes(4).toString('hex');

export function witnessState() {
  return { proc: PROC, seq: SEQ, dropped: DROPPED };
}

/**
 * Wrap one tool handler. Returns a handler with the same signature.
 *
 * Ordering is deliberate and mirrors the gate: the decision is written BEFORE the call goes out and
 * the outcome AFTER it comes back, as two records rather than one. A single record written
 * afterwards loses every call that crashed mid-flight, and a decision with no outcome following it
 * is exactly the shape a reader needs to see when that happens.
 */
export function witnessWrap(deps: WitnessDeps, name: string, klass: string, role: string, handler: any): any {
  const coll = deps.collection || 'tool_witness';
  const now = deps.now || (() => Date.now());

  const write = async (doc: any): Promise<void> => {
    try {
      SEQ += 1;
      await deps.db.collection(coll).add(Object.assign({
        wproc: PROC,
        wseq: SEQ,
        // Rides on the NEXT successful record, so a dropped write leaves a visible number rather
        // than nothing. Reset once reported: the count is "lost since the last record you can see".
        wdropped: DROPPED,
        timestamp: deps.serverTimestamp(),
      }, doc));
      DROPPED = 0;
    } catch (e) {
      // A witness that can fail a tool call is a witness that gets turned off. Count and continue.
      DROPPED += 1;
    }
  };

  return async (a: any) => {
    const scrubbed = scrubArgs(a);
    let reqDigest = 'sha256:uncanonicalizable';
    try {
      reqDigest = digest(scrubbed);
    } catch (e) {
      // An argument shape with no JCS form is itself worth recording rather than throwing.
      reqDigest = 'sha256:uncanonicalizable';
    }

    const d = decide(role, name, klass, scrubbed);
    const applied = !d.allowed && enforcing();

    await write({
      typ: applied ? 'pc.tool.refused.v1' : (d.allowed ? 'pc.tool.allowed.v1' : 'pc.tool.observed.v1'),
      role: role,
      tool: name,
      tool_class: klass,
      request_digest: reqDigest,
      rule: d.rule || null,
      reason: d.reason,
      enforced: applied,
    });

    if (applied) {
      return {
        content: [{ type: 'text', text: 'REFUSED by the evidence gate. ' + d.reason }],
        isError: true,
      };
    }

    const started = now();
    let outcome = 'ok';
    let thrown: any = null;
    let result: any;
    try {
      result = await handler(a);
      // An MCP tool error is a normal outcome, not an exception, and recording it as `ok` would
      // make the record disagree with what the caller saw.
      if (result && result.isError) outcome = 'tool_error';
    } catch (e) {
      outcome = 'threw';
      thrown = e;
    }

    // The digest is RECOMPUTED from the arguments that were actually handed to the handler rather
    // than copied from the decision above. Copying would make the comparison agree with itself by
    // construction, which is the one thing this record must never do.
    let dispatched = 'sha256:uncanonicalizable';
    try { dispatched = digest(scrubArgs(a)); } catch (e) {}

    await write({
      typ: 'pc.tool.closed.v1',
      role: role,
      tool: name,
      tool_class: klass,
      request_digest: reqDigest,
      dispatched_digest: dispatched,
      diverged: dispatched !== reqDigest,
      outcome: outcome,
      ms: now() - started,
    });

    if (thrown) throw thrown;
    return result;
  };
}
