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
RUN npm install --omit=dev --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund esbuild@0.21.5
COPY src ./src
COPY route-audit.mjs route-baseline.json blob-audit.mjs blob-baseline.json ./

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
CMD ["node", "dist/index.js"]
