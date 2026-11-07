// SPDX-License-Identifier: Apache-2.0
// Unit tests for the dependency-free part of pc-status (src/mods/pc-status.ts). pcStRace is pure:
// it races a promise against a setTimeout, swallows rejections, and falls back to the supplied
// onTimeout value. No cloud, no network, no secrets -- the other exports (pcStGcp/pcStGitlab/
// pcStatusVmMeta/pcStatusChecks) hit metadata/GCP/GitLab and are not unit-tested here.
process.env.PC_NO_LISTEN = "1";
process.env.PC_STORE = process.env.PC_STORE || "pg";
process.env.PC_PG_URL = process.env.PC_PG_URL || "";
import { pcStRace } from "../../src/mods/pc-status.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}
const delay = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

(async () => {
  console.log("pcStRace -- promise value when it settles before the timeout, else onTimeout");
  {
    // promise resolves well before the timeout -> its value wins
    eq("fast resolve beats a long timeout", await pcStRace(Promise.resolve(42), 1000, -1), 42);
    eq("fast resolve (delayed) beats timeout", await pcStRace(delay(5, "v"), 1000, "TO"), "v");

    // promise slower than the timeout -> onTimeout wins
    eq("slow promise loses to a short timeout", await pcStRace(delay(200, "late"), 10, "TO"), "TO");

    // a rejecting promise is swallowed and becomes onTimeout (via the inner .catch)
    eq("rejection is swallowed -> onTimeout", await pcStRace(Promise.reject(new Error("boom")), 1000, "FALLBACK"), "FALLBACK");

    // onTimeout can be any shape, including an object/null, and is returned by identity
    const obj = { http: 0, body: null };
    ok("object onTimeout returned by identity on timeout", (await pcStRace(delay(200, { http: 1, body: "x" }), 5, obj)) === obj);
    eq("null onTimeout on timeout", await pcStRace(delay(200, 1), 5, null as any), null);

    // a zero-ms timeout still yields onTimeout rather than hanging
    eq("zero-ms timeout yields onTimeout", await pcStRace(delay(50, "slow"), 0, "ZERO"), "ZERO");

    // falsy resolved values are preserved (0 / "" / false), not treated as a miss
    eq("resolved 0 preserved", await pcStRace(Promise.resolve(0), 1000, -1), 0);
    eq("resolved empty string preserved", await pcStRace(Promise.resolve(""), 1000, "TO"), "");
    eq("resolved false preserved", await pcStRace(Promise.resolve(false), 1000, true), false);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
