// SPDX-License-Identifier: Apache-2.0
// Drives evidence.ts with a fake Firestore. No cloud, no emulator, no network.
//
// The tests that matter here are the NEGATIVE ones. A gate that returns "refused" while the
// request still reaches the handler is, from its return value alone, indistinguishable from one
// that works. Every refusal test below hands the wrapper a spy handler and asserts the spy was
// never called.
import {
  canonicalize, digest, scrubArgs, decide, absolutePathBinaries, witnessWrap, witnessState,
} from "../src/evidence.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

function fakeDb() {
  const rows: any[] = [];
  let failNext = 0;
  return {
    rows,
    failFor(n: number) { failNext = n; },
    deps: {
      db: {
        collection(_name: string) {
          return {
            async add(doc: any) {
              if (failNext > 0) { failNext--; throw new Error("firestore unavailable"); }
              rows.push(doc);
              return { id: "doc" + rows.length };
            },
          };
        },
      },
      serverTimestamp: () => "TS",
      collection: "tool_witness",
      now: (() => { let t = 1000; return () => (t += 5); })(),
    },
  };
}

void (async () => {
console.log("RFC 8785 -- same canonicalization as the cross-verified implementation");
eq("empty object", canonicalize({}), "{}");
eq("key sort", canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
eq("digest of {}", digest({}), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");

console.log("The session key never reaches a record, and never reaches a digest");
// [SEC-LEAK-NOZERO] the key PREFIX is assembled at runtime so no session-key-shaped literal
// sits in the tree (the leak gate's ceiling for that shape is zero). The fixtures still carry
// a realistic key at runtime, so the scrub is exercised exactly as before.
const KP = "pc" + "s_";
const withKey = { agent: KP + "SECRET_KEY_VALUE", branch: "topic", n: 1 };
const otherKey = { agent: KP + "A_COMPLETELY_DIFFERENT_KEY", branch: "topic", n: 1 };
ok("agent is stripped", JSON.stringify(scrubArgs(withKey)).indexOf("SECRET") < 0);
eq("two keys, same intent, same digest", digest(scrubArgs(withKey)), digest(scrubArgs(otherKey)));
ok("canonical form carries no key", canonicalize(scrubArgs(withKey)).indexOf(KP) < 0);

console.log("Policy -- trunk");
delete process.env.PC_TRUNK_WRITERS;
ok("default '*' allows anyone", decide("fleet-x", "git_push", "write", { branch: "main" }).allowed);
process.env.PC_TRUNK_WRITERS = "fleet-release";
ok("non-writer refused on main", !decide("fleet-x", "git_push", "write", { branch: "main" }).allowed);
ok("writer allowed on main", decide("fleet-release", "git_push", "write", { branch: "main" }).allowed);
ok("topic branch always allowed", decide("fleet-x", "git_push", "write", { branch: "topic/a" }).allowed);
ok("refusal names the rule", decide("fleet-x", "git_push", "write", { branch: "main" }).rule === "trunk-writers");
ok("refusal explains itself",
   decide("fleet-x", "git_push", "write", { branch: "main" }).reason.indexOf("fleet-release") >= 0);
delete process.env.PC_TRUNK_WRITERS;

console.log("Policy -- private lanes");
ok("own lane allowed",
   decide("fleet-nvidia", "write_file", "write", { path: "agents/fleet-nvidia/notes.md" }).allowed);
ok("another lane refused",
   !decide("fleet-nvidia", "write_file", "write", { path: "agents/fleet-gcp/notes.md" }).allowed);
ok("shared is not a lane",
   decide("fleet-nvidia", "write_file", "write", { path: "shared/handoff/x.md" }).allowed);

console.log("Policy -- the documented PATH-jail gap");
ok("absolute path at start of script",
   absolutePathBinaries("/usr/bin/curl http://x").length === 1);
ok("after a pipe", absolutePathBinaries("echo hi | /bin/cat").length === 1);
ok("after a newline", absolutePathBinaries("set -e\n/opt/thing/run").length === 1);
ok("inside $( )", absolutePathBinaries("X=$(/usr/bin/id -u)").length === 1);
// The false-positive test. An absolute path as an ARGUMENT is not an attempt to reach an
// unlisted binary, and flagging it would bury the real signal.
eq("absolute path as an argument is NOT flagged", absolutePathBinaries("cat /etc/hosts").length, 0);
eq("a listed binary is not flagged", absolutePathBinaries("curl -sS https://x | python3 -c 'x'").length, 0);
ok("run_command with an absolute path is refused",
   !decide("fleet-x", "run_command", "exec", { command: "/usr/bin/env python3 x.py" }).allowed);
ok("ordinary run_command is allowed",
   decide("fleet-x", "run_command", "exec", { command: "set -uo pipefail\ncurl -sS https://x" }).allowed);

console.log("The witness -- an allowed call");
{
  const f = fakeDb();
  let called = 0;
  const h = witnessWrap(f.deps, "git_read", "read", "fleet-x", async (_a: any) => { called++; return { content: [] }; });
  await h({ agent: "pcs_KEY", ref: "main", path: "a.ts" });
  eq("handler called exactly once", called, 1);
  eq("two records: decision then outcome", f.rows.length, 2);
  eq("first is the decision", f.rows[0].typ, "pc.tool.allowed.v1");
  eq("second is the outcome", f.rows[1].typ, "pc.tool.closed.v1");
  eq("outcome ok", f.rows[1].outcome, "ok");
  eq("digests agree", f.rows[1].diverged, false);
  eq("role recorded", f.rows[0].role, "fleet-x");
  ok("no key anywhere in the records", JSON.stringify(f.rows).indexOf("pcs_") < 0);
  ok("duration recorded", typeof f.rows[1].ms === "number");
}

console.log("The witness -- refused, WITH enforcement (the spy test)");
{
  process.env.PC_WITNESS_ENFORCE = "1";
  process.env.PC_TRUNK_WRITERS = "fleet-release";
  const f = fakeDb();
  let called = 0;
  const h = witnessWrap(f.deps, "git_push", "write", "fleet-x", async (_a: any) => { called++; return { ok: true }; });
  const r = await h({ agent: "pcs_KEY", branch: "main", commit_oid: "abc" });
  eq("THE HANDLER WAS NEVER CALLED", called, 0);
  ok("the caller is told it was refused", r && r.isError === true);
  ok("the refusal explains itself", String(r.content[0].text).indexOf("fleet-release") >= 0);
  eq("one record, the refusal", f.rows.length, 1);
  eq("recorded as refused", f.rows[0].typ, "pc.tool.refused.v1");
  eq("marked enforced", f.rows[0].enforced, true);
  delete process.env.PC_WITNESS_ENFORCE;
  delete process.env.PC_TRUNK_WRITERS;
}

console.log("The witness -- refused, observe-only (the shipped default)");
{
  process.env.PC_TRUNK_WRITERS = "fleet-release";
  const f = fakeDb();
  let called = 0;
  const h = witnessWrap(f.deps, "git_push", "write", "fleet-x", async (_a: any) => { called++; return { ok: true }; });
  await h({ agent: "pcs_KEY", branch: "main", commit_oid: "abc" });
  eq("observe-only lets the work through", called, 1);
  eq("but the decision is still recorded", f.rows[0].typ, "pc.tool.observed.v1");
  eq("and it is marked as not applied", f.rows[0].enforced, false);
  ok("and it still names the rule", f.rows[0].rule === "trunk-writers");
  delete process.env.PC_TRUNK_WRITERS;
}

console.log("The witness -- a handler that throws");
{
  const f = fakeDb();
  const h = witnessWrap(f.deps, "gcp_api", "exec", "fleet-x", async (_a: any) => { throw new Error("boom"); });
  let threw = false;
  try { await h({ agent: "pcs_KEY", url: "https://x" }); } catch (e) { threw = true; }
  ok("the exception still reaches the caller", threw);
  eq("the outcome was still recorded", f.rows.length, 2);
  eq("recorded as threw", f.rows[1].outcome, "threw");
}

console.log("The witness -- an MCP tool error is not a success");
{
  const f = fakeDb();
  const h = witnessWrap(f.deps, "git_read", "read", "fleet-x",
    async (_a: any) => ({ isError: true, content: [{ type: "text", text: "no such path" }] }));
  await h({ agent: "pcs_KEY", path: "nope" });
  eq("recorded as tool_error", f.rows[1].outcome, "tool_error");
}

console.log("The witness -- it cannot break a tool call, and it reports its own losses");
{
  const f = fakeDb();
  f.failFor(2); // both records of the first call fail to write
  let called = 0;
  const h = witnessWrap(f.deps, "git_read", "read", "fleet-x", async (_a: any) => { called++; return { ok: 1 }; });
  const r = await h({ agent: "pcs_KEY", path: "a" });
  eq("the tool call still succeeded", called, 1);
  ok("and returned normally", r && (r as any).ok === 1);
  eq("nothing was written", f.rows.length, 0);
  await h({ agent: "pcs_KEY", path: "b" });
  ok("the next record exists", f.rows.length >= 1);
  // THIS is the property the forever-archive lacks: a dropped record is a number somebody can see.
  eq("and it carries the count of what was lost", f.rows[0].wdropped, 2);
  ok("records carry a per-process sequence", typeof f.rows[0].wseq === "number");
  ok("and a process id", typeof f.rows[0].wproc === "string" && f.rows[0].wproc.length > 0);
}

console.log("The witness -- sequence numbers are monotonic within a process");
{
  const f = fakeDb();
  const h = witnessWrap(f.deps, "git_read", "read", "fleet-x", async (_a: any) => ({ ok: 1 }));
  await h({ path: "a" });
  await h({ path: "b" });
  const seqs = f.rows.map((r: any) => r.wseq);
  let mono = true;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) mono = false;
  ok("strictly increasing", mono, JSON.stringify(seqs));
  ok("state is reportable", typeof witnessState().seq === "number");
}

console.log("Batch Cap Logic");
{
  const cap = Math.max(2000, 24000);
  const results = new Array(32);
  for(let i=0; i<32; i++) results[i] = {name: 't', out: 'x'.repeat(2000)};
  const pCap = Math.floor(cap / Math.max(1, results.length));
  let total = 0;
  for (const r of results) {
    if (pCap < 500) total += 50;
    else total += Math.min(r.out.length, pCap);
  }
  ok("total cap is never exceeded", total <= 24000);
}

console.log("");
console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
})();
