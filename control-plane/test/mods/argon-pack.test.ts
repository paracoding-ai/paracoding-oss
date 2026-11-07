// SPDX-License-Identifier: Apache-2.0
// Unit tests for the PURE surface of the Argon context-packer module (src/mods/argon-pack.ts):
// argonPackTools builds the three pin-management tool definitions (pin_context, unpin_context,
// pack_status) synchronously from ARGON_PACK_PROJECT and the pack budget, WITHOUT touching
// Firestore or GitLab (the IO only happens if a tool's .run() is invoked, which these tests do
// not). No cloud, no network, no secrets.
process.env.PC_NO_LISTEN = "1";
import { argonPackTools, ARGON_PACK_PROJECT } from "../../src/mods/argon-pack.js";

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}
function eq(label: string, got: any, want: any) {
  ok(label, got === want, "got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want));
}

(async () => {
  console.log("argonPackTools -- three tool definitions, pure and deterministic");
  {
    const tools = argonPackTools("fleet-advisor");
    ok("returns an array", Array.isArray(tools));
    eq("exactly three tools", tools.length, 3);
    eq("names in order", tools.map((t) => t.name).join(","), "pin_context,unpin_context,pack_status");
    for (const t of tools) {
      ok(t.name + ": has a non-empty description", typeof t.description === "string" && t.description.length > 0);
      ok(t.name + ": schema is an object type", !!t.schema && t.schema.type === "object");
      ok(t.name + ": run is a function", typeof t.run === "function");
    }
  }

  console.log("pin_context -- schema and default-project / budget wording");
  {
    const pin = argonPackTools("agentX").find((t) => t.name === "pin_context")!;
    ok("requires the paths field", Array.isArray(pin.schema.required) && pin.schema.required.indexOf("paths") >= 0);
    const props = pin.schema.properties || {};
    for (const k of ["paths", "ref", "project", "suffix"]) ok("declares property " + k, !!props[k]);
    ok("paths is an array of strings", props.paths && props.paths.type === "array" && props.paths.items && props.paths.items.type === "string");
    ok("description names the default project (ARGON_PACK_PROJECT)", pin.description.indexOf(ARGON_PACK_PROJECT) >= 0);
    ok("description mentions a token budget", pin.description.indexOf("Budget: ") >= 0 && /\d+ tokens/.test(pin.description));
    ok("project property default also names ARGON_PACK_PROJECT", String(props.project.description).indexOf(ARGON_PACK_PROJECT) >= 0);
  }

  console.log("unpin_context -- clear-all and path-list schema");
  {
    const unpin = argonPackTools("agentX").find((t) => t.name === "unpin_context")!;
    const props = unpin.schema.properties || {};
    ok("declares paths", !!props.paths && props.paths.type === "array");
    ok("declares all (boolean)", !!props.all && props.all.type === "boolean");
    ok("does not force any required field", !unpin.schema.required || unpin.schema.required.length === 0);
  }

  console.log("pack_status -- empty-schema status tool");
  {
    const ps = argonPackTools("agentX").find((t) => t.name === "pack_status")!;
    ok("has no required inputs", !ps.schema.required || ps.schema.required.length === 0);
    ok("takes an empty properties object", !!ps.schema.properties && Object.keys(ps.schema.properties).length === 0);
  }

  console.log("determinism -- same agent id yields the same tool names each call");
  {
    const a = argonPackTools("same").map((t) => t.name).join(",");
    const b = argonPackTools("same").map((t) => t.name).join(",");
    eq("stable across calls", a, b);
  }

  console.log("");
  console.log(fail === 0 ? "ALL " + pass + " ASSERTIONS PASS" : pass + " pass, " + fail + " FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
