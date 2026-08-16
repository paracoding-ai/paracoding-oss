// SPDX-License-Identifier: Apache-2.0
// [MCP2-BOOT-V1] No protocol code, no route, no handler. This module exists to prove --
// in OUR image and at OUR boot -- that the MCP SDK v2 dependency resolves out of
// node_modules and exposes the 2026-07-28 entry point. Wire-format work lands later,
// in its own commit, on top of a build already known to carry the dependency.
//
// require(), not import: index.ts:21-22 loads the v1 SDK the same way, and the bundle is
// emitted with esbuild --format=cjs. @modelcontextprotocol/server 2.0.0 is dual CJS/ESM --
// its "." export carries a `require` condition resolving to ./dist/index.cjs -- so a
// CommonJS require() is a supported load path, not a trick.
//
// SUBPATH RULE, and it is the likeliest mistake here: v2 declares ONLY ".", "./stdio",
// "./_shims", "./validators/ajv" and "./validators/cf-worker". An `exports` map is a closed
// list with no wildcard, so a v1-style deep import -- the habit index.ts is built on --
// throws ERR_PACKAGE_PATH_NOT_EXPORTED at require() time. Import the root, nothing else.
// (Even '@modelcontextprotocol/server/package.json' is not declared and does not resolve.)
const mcp2 = require('@modelcontextprotocol/server');

// Asserts the v2 SDK is present AND carries createMcpHandler -- the function that, per the
// official migration guide, IS the opt-in to serving 2026-07-28. A module that resolves but
// does not export it is just as broken as one that does not resolve, and would otherwise
// pass silently.
export function assertMcp2Loadable(): string {
  if (typeof mcp2.createMcpHandler !== 'function') {
    // Deliberately NOT caught and NOT logged-and-swallowed anywhere up the stack. A broken
    // dependency must fail the boot. Cloud Run then never routes to the revision and the
    // previous good one keeps serving 100% -- which is strictly better than a green
    // container serving a capability that is not there.
    throw new Error(
      'MCP2 BOOT FAIL: @modelcontextprotocol/server resolved but createMcpHandler is ' +
      typeof mcp2.createMcpHandler + '; exports = ' + Object.keys(mcp2).join(',')
    );
  }
  return 'ok createMcpHandler=function';
}
