# Control plane image. Law 13: the running code comes from a build of this source.
#
# node:24 deliberately. The buildpack image the working revision runs ships node v24.18.0.
# Everything else has been measured identical between the two revisions: the runtime config
# (every env var, every secret, same service account) and the emitted bundle itself
# (625,306 bytes, sha256 8b1b3fc4f9cfb100f9e6db85ab1a1644ba6972ecbaafd88ec9d5095258170ee4,
# byte-for-byte the same as the lake object the working revision executes). The Node major
# was the only remaining difference, so it is the only thing changed here.
#
# esbuild with the EXACT flags deploy-cp-harness.sh uses: --platform=node --format=cjs
# --target=node20. It TRANSPILES, it does not bundle and it does not typecheck. Production
# has always been built this way. Switching to tsc would be a second change riding along,
# and it failed on three real type errors esbuild was hiding, all fixed on 2026-08-02.
# The single line number this note used to quote was already stale by then. tsc is clean.
#
# Because esbuild does not bundle, every import must resolve from node_modules AT RUNTIME.
FROM node:24-slim
WORKDIR /app
COPY package.json ./
# [SEC-ARGROWTH-V1] THE MTIME NORMALISE IS WHY THIS LAYER STOPS COSTING STORAGE, AND IT
# HAS TO STAY INSIDE THIS RUN. Artifact Registry deduplicates by LAYER DIGEST, and a layer
# digest is the sha256 of a tar that carries a per-entry mtime. MEASURED, not assumed: npm
# stamps every extracted file with the WALL-CLOCK INSTALL TIME rather than the package's
# own mtime, so two installs of an IDENTICAL dependency tree emit two different layer
# digests and the registry stores both. That -- not the absence of a build cache -- is why
# the shared image repository grows by hundreds of MiB an hour and never shrinks.
#
# A COMMITTED LOCKFILE ALONE DOES NOT FIX THIS, and believing it does is the trap. A
# lockfile pins the CONTENT; the tar still carries the clock. The lockfile is worth landing
# for reproducibility and for the promotion digest check, but the line below is the part
# that stops the growth, and it works with or without one.
#
# AS ITS OWN RUN IT WOULD MAKE THINGS WORSE. Rewriting an mtime marks a file CHANGED, so a
# separate layer would carry a SECOND full copy of node_modules rather than deduplicating
# the first. One RUN, or nothing.
#
# 198510260815 is npm's own fixed pack epoch, chosen so the value is recognisable rather
# than arbitrary. -h touches a symlink itself instead of following it, so a dangling
# optional-dependency link cannot fail the build. /app rather than /app/node_modules: an
# unpinned npm install also WRITES a lockfile next to package.json, and that file carries
# the same clock.
RUN npm install --omit=dev --no-audit --no-fund && npm install --no-save --no-audit --no-fund esbuild@0.21.5 && find /app -exec touch -h -t 198510260815 {} +
COPY src ./src
COPY route-audit.mjs route-baseline.json blob-audit.mjs blob-baseline.json ./

# [WIKI-ASSETS-V77] The wiki diagrams ride in on `COPY src ./src` above, which is exactly why
# this line exists: a copy that silently picks up nothing still produces a green build, and
# GET /wiki/assets/:name would then 404 on a deployed image with no other symptom. Same rule
# the esbuild steps below follow -- if the artifact is not there, FAIL THE BUILD, do not ship
# an image whose route is dead. `test -s` on each: present AND non-empty.
RUN test -s src/wiki-assets/01-surface-split.png \
 && test -s src/wiki-assets/02-auth-path.png \
 && test -s src/wiki-assets/03-git-store.png \
 && test -s src/wiki-assets/04-job-end-to-end.png \
 && test -s src/wiki-assets/05-deploy.png

# [BRAND-SELFHOST-V80] Same rule for the logo: if the bytes are not in the image the three
# brand routes 404 on a green build and the console shows a broken image with no other sign.
RUN test -s src/brand/logo-96.png \
 && test -s src/brand/icon-180.png \
 && test -s src/brand/icon-48.png \
 && test -s src/brand/icon-32.png \
 && test -s src/brand/favicon.ico

# SEC 5: a NEW route with no auth guard fails the BUILD -- no image, no deploy.
# Runs before esbuild on purpose: a failed audit means no bundle is ever emitted.
RUN node route-audit.mjs src/index.ts route-baseline.json

# NO BLOBS: an encoded document anywhere under src/ fails the BUILD -- no image, no deploy.
# 57% of this file was base64 on 2026-08-02 and the release leak gate could not see inside it.
RUN node blob-audit.mjs src blob-baseline.json
RUN npx esbuild src/index.ts --platform=node --format=cjs --target=node20 --outfile=dist/index.js \
 && test -s dist/index.js
RUN npx esbuild src/gittools.ts --bundle --platform=node --format=cjs --target=node20 --outfile=dist/gittools.js --external:firebase-admin --external:@google-cloud/storage --external:isomorphic-git \
 && test -s dist/gittools.js
# PCV1-READ-V1: the git-object read path imports src/pcgit/05-adapter/src/vault-objenc.ts.
# APPENDED as its own RUN so the gittools bundle line above stays byte-identical --
# a deploy pre-condition counts it. This is a syntax gate: a file that compiles to
# nothing fails the build here rather than at require() time in production.
RUN npx esbuild src/pcgit/05-adapter/src/vault-objenc.ts --platform=node --format=cjs --target=node20 --outfile=dist/vault-objenc.js \
 && test -s dist/vault-objenc.js
# PCV1-WRITE-V1: the git-object WRITE path imports
# src/pcgit/05-adapter/src/vault-objwrite.ts -- the single module that decides,
# from the object KEY alone, what gets encrypted. BOTH GCS writers import it
# (05-adapter's GcsStore and 07-refs' ObjectStore) so they cannot drift.
# APPENDED as its own RUN for the same reason the read line above is: every
# neighbouring line stays byte-identical, and a deploy pre-condition counts one
# of them. This is a syntax gate: a file that compiles to nothing fails the
# build here rather than at require() time in production.
RUN npx esbuild src/pcgit/05-adapter/src/vault-objwrite.ts --platform=node --format=cjs --target=node20 --outfile=dist/vault-objwrite.js \
 && test -s dist/vault-objwrite.js
# MCP2-BOOT-V1: prove the SDK v2 dependency actually RESOLVES, at BUILD time.
# This gate exists because the esbuild line below CANNOT do this job. esbuild
# TRANSPILES -- it never resolves the specifier -- so `test -s dist/mcp2.js` is
# satisfied whether or not @modelcontextprotocol/server exists in node_modules.
# Only a real require() proves it. Build stage and runtime stage are the same
# image here, so a require() that succeeds on this line is a require() that
# succeeds at boot, and the whole "breaks at boot" class becomes "breaks at
# build". createMcpHandler is asserted BY NAME, not merely loaded: a module that
# resolves but does not export the 2026-07-28 entry point is just as broken.
# require.resolve() rather than require('.../package.json') -- an `exports` map
# is a CLOSED list and v2 does not declare ./package.json, so that throws
# ERR_PACKAGE_PATH_NOT_EXPORTED on a perfectly good dependency. It is also the
# better evidence: a .cjs path in the build log proves the CJS condition won.
RUN node -e "const m=require('@modelcontextprotocol/server'); if (typeof m.createMcpHandler !== 'function') { console.error('MCP2 RESOLVE FAIL'); process.exit(1); } console.log('MCP2 RESOLVE OK: ' + require.resolve('@modelcontextprotocol/server'));"
# MCP2-BOOT-V1: the syntax gate for the new module, matching the vault-obj* pattern.
# APPENDED as its own RUN so every neighbouring line stays byte-identical -- a
# deploy pre-condition counts the gittools assertion above exactly once, and this
# comment deliberately does not repeat that string either.
RUN npx esbuild src/mcp2.ts --platform=node --format=cjs --target=node20 --outfile=dist/mcp2.js \
 && test -s dist/mcp2.js
# MCP2026-DUAL-ERA-V1: the syntax gate for the modern branch, matching the pattern above.
# APPENDED as its own RUN so every neighbouring line stays byte-identical.
RUN npx esbuild src/mcp2026.ts --platform=node --format=cjs --target=node20 --outfile=dist/mcp2026.js \
 && test -s dist/mcp2026.js
# MCP2026-DUAL-ERA-V1: tools/list on the modern branch MUST publish a JSON Schema per tool
# (spec: inputSchema "MUST be a valid JSON Schema object (not null)"), and our 40-odd tool
# specs are written as zod raw shapes for the 2025-era SDK. zod 4 is the converter. It is
# pinned exactly in package.json, but there is no lockfile in this image, so assert the
# capability HERE rather than discovering at the first tools/list that every tool publishes
# an untyped schema. Build stage and runtime stage are the same image: this is the boot.
RUN node -e "const z=require('zod');const f=(typeof z.toJSONSchema==='function')?z.toJSONSchema:(z.z&&z.z.toJSONSchema);if(typeof f!=='function'){console.error('ZOD-JSONSCHEMA FAIL: the installed zod exposes no toJSONSchema, so the 2026-07-28 tools/list cannot publish an inputSchema for any tool.');process.exit(1);}console.log('ZOD-JSONSCHEMA OK: '+require.resolve('zod'));"
# MCP2026-DUAL-ERA-V1: SDK v2 SIGNATURE EVIDENCE, printed from the INSTALLED tree.
#
# This is deliberately TWO different things and the comment says which is which, because a
# gate that cannot fail is worse than no gate and a probe that pretends to be one is worse
# still.
#
# The ASSERTION half: createMcpHandler AND isLegacyRequest must both be functions. The
# documented way to keep OUR 2025-era deployment serving beside a modern handler is
# `isLegacyRequest(request)` in front of `createMcpHandler(factory, { legacy: 'reject' })`,
# so if that predicate ever leaves the package the plan of record is invalid and this build
# says so instead of a future request path discovering it.
#
# The EVIDENCE half: arity, the export list, and the VERBATIM CreateMcpHandlerOptions
# declaration read out of the installed dist/*.d.cts. It never fails the build, and that is
# the point -- it exists because registry.npmjs.org is 403 by org egress policy in the
# authoring container, so the package cannot be installed, executed or read there, and the
# two reachable descriptions of the entry point disagree (the published docs and the source
# say createMcpHandler(factory, options?), a reading of the shipped index.d.cts said
# createMcpHandler(options)). Arity alone cannot settle it -- `options = {}` is a default
# parameter, so Function.length is 1 either way; that was measured, not assumed. The next
# commit wires the handler against these printed bytes rather than against a web page.
RUN node -e "const p=require.resolve('@modelcontextprotocol/server'),m=require('@modelcontextprotocol/server'),NL=String.fromCharCode(10);const need=['createMcpHandler','isLegacyRequest'];const bad=need.filter(function(k){return typeof m[k]!=='function';});if(bad.length){console.error('MCP2 SIGNATURE FAIL: not a function: '+bad.join(',')+'; exports = '+Object.keys(m).join(','));process.exit(1);}console.log('MCP2 SIGNATURE OK: '+p);console.log('MCP2 ARITY: createMcpHandler='+m.createMcpHandler.length+' isLegacyRequest='+m.isLegacyRequest.length);console.log('MCP2 EXPORTS: '+Object.keys(m).sort().join(','));const fs=require('fs'),pa=require('path'),d=pa.dirname(p);let hit='';for(const f of fs.readdirSync(d)){if(f.slice(-6)!=='.d.cts')continue;const t=fs.readFileSync(pa.join(d,f),'utf8');const i=t.indexOf('interface CreateMcpHandlerOptions');if(i<0)continue;const j=t.indexOf(NL+'}',i);hit=f+NL+t.slice(i,j<0?i+3000:j+2);break;}console.log('MCP2 CreateMcpHandlerOptions, verbatim from the installed tree:'+NL+(hit||'NOT FOUND in dist/*.d.cts'));"
CMD ["node", "dist/index.js"]
