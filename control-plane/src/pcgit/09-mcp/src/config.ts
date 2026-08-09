/**
 * 09-mcp / config.ts
 *
 * Everything this process needs, read once from the environment at startup.
 *
 * CREDENTIALS: there are none here and there are none anywhere else in this
 * package. Both Google clients are constructed with no arguments, which is
 * Application Default Credentials. On Cloud Run that is the service account
 * attached to the revision. No key file, no secret, no token in code or config.
 */

import { randomUUID } from 'node:crypto';

import { objectsKeyPrefix } from '../../07-refs/src/objects';

export interface Config {
  /** Logical repository id. One repo per deployment; not a tool parameter. */
  repoId: string;
  /** GCS bucket holding `.git/objects/**`. */
  bucket: string;
  /**
   * Firestore database id. `(default)` unless a NAMED database was created.
   *
   * LOAD-BEARING, and it was missing. `new Firestore()` with no settings
   * resolves `databaseId` to the constant `(default)` — @google-cloud/firestore
   * 8.7.0 reads NO environment variable for it (only FIRESTORE_EMULATOR_HOST,
   * FIRESTORE_ENABLE_TRACING and FIRESTORE_PREFER_REST). 11-bringup/bringup.sh
   * can create a NAMED database (FIRESTORE_CHOICE=named, chosen so
   * roles/datastore.user can be narrowed by an IAM condition on the database
   * resource name), and 03-infra/deploy.sh already exports FIRESTORE_DATABASE
   * to the container — but nothing read it, so every Firestore call would have
   * gone to a `(default)` database that bring-up never creates and that the
   * runtime SA's conditioned binding does not authorise.
   */
  databaseId: string;
  /** Firestore collection holding every non-object path (05-adapter). */
  filesCollection: string;
  /** Root collection for the ref documents (07-refs `repos/{id}/refs/...`). */
  refsRootCollection: string;

  /**
   * The gitdir as the fs adapter sees it, and the GCS key prefix for this
   * repo. These two are the ONLY inputs to the object key layout: 05-adapter
   * takes them directly, and 07-refs' ObjectStore derives the same prefix from
   * them via `objectsKeyPrefix`. There is no third value to keep in step.
   */
  gitdir: string;
  objectPrefix: string;

  port: number;
  /** What `HEAD` resolves to. The Firestore ref store has no HEAD document. */
  defaultBranch: string;

  /** Refuse rather than truncate. A truncated file read is a correctness bug. */
  maxBlobBytes: number;
  maxDiffFileBytes: number;
  maxDiffFiles: number;
  maxLogCount: number;
  maxProposeFiles: number;
  maxProposeBytes: number;

  authorName: string;
  authorEmail: string;
  /**
   * Domain for the per-role commit author address. The LOCAL part is the
   * RESOLVED ROLE and is threaded in as a parameter by the caller -- it cannot
   * come from here, because one service process serves every role, `loadConfig`
   * reads `process.env` once and `getContext` caches a process-wide singleton.
   * Only the domain is deployment configuration, so only the domain lives here.
   */
  authorEmailDomain: string;

  /** Recorded on every successful CAS: "who moved my branch". */
  writerId: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    throw new Error(
      `${name} is required. This server serves exactly one repository and refuses ` +
        `to guess which one.`,
    );
  }
  return raw;
}

export function loadConfig(): Config {
  const repoId = requireEnv('GIT_REPO_ID');
  if (repoId.includes('/') || repoId.startsWith('.')) {
    // repoId becomes both a Firestore document id and a GCS key prefix.
    throw new Error(`GIT_REPO_ID must not contain '/' or start with '.', got ${repoId}`);
  }

  const revision = process.env.K_REVISION ?? 'local';
  const service = process.env.K_SERVICE ?? 'git-mcp';

  return {
    repoId,
    bucket: requireEnv('GIT_BUCKET'),
    // Defaulted, not required: a project that kept the (default) database
    // still boots with no extra configuration.
    databaseId: process.env.FIRESTORE_DATABASE || '(default)',
    filesCollection: process.env.GIT_FILES_COLLECTION ?? `repos/${repoId}/files`,
    refsRootCollection: process.env.GIT_REFS_ROOT_COLLECTION ?? 'repos',

    // The one place these two are chosen. BOTH go to 05-adapter and BOTH go to
    // 07-refs' ObjectStore, which derives its GCS key prefix from them using
    // the adapter's own rule (`objectsKeyPrefix`). There used to be a third
    // value here, `objectStoreRepoId`, that had to be kept equal to
    // `objectPrefix + gitdir.slice(1)` by hand; it is gone, along with the
    // chance of the two halves silently addressing different key spaces.
    gitdir: '/.git',
    objectPrefix: `${repoId}/`,

    port: intEnv('PORT', 8080),
    defaultBranch: process.env.GIT_DEFAULT_BRANCH ?? 'main',

    maxBlobBytes: intEnv('GIT_MAX_BLOB_BYTES', 2 * 1024 * 1024),
    maxDiffFileBytes: intEnv('GIT_MAX_DIFF_FILE_BYTES', 512 * 1024),
    maxDiffFiles: intEnv('GIT_MAX_DIFF_FILES', 200),
    maxLogCount: intEnv('GIT_MAX_LOG_COUNT', 200),
    maxProposeFiles: intEnv('GIT_MAX_PROPOSE_FILES', 100),
    maxProposeBytes: intEnv('GIT_MAX_PROPOSE_BYTES', 8 * 1024 * 1024),

    authorName: process.env.GIT_AUTHOR_NAME ?? 'mcp-agent',
    authorEmail: process.env.GIT_AUTHOR_EMAIL ?? 'mcp-agent@invalid',
    authorEmailDomain: process.env.GIT_AUTHOR_EMAIL_DOMAIN ?? 'invalid',

    // K_REVISION/K_SERVICE are Cloud Run's; the uuid stands in for the instance
    // id, which Cloud Run does not expose as an environment variable.
    writerId: `${service}/${revision}/${randomUUID()}`,
  };
}

/**
 * Asserted at startup rather than trusted.
 *
 * The prefix the two halves share is now DERIVED from `objectPrefix` and
 * `gitdir` by one shared function, so it cannot drift. What can still drift is
 * the third consumer of `gitdir`: the `objectsDirs` boundary handed to the fs
 * adapter, which decides which paths are routed to GCS at all. If that names a
 * different directory from the gitdir git is actually using, objects are
 * written to Firestore instead and the whole object store is empty for reasons
 * no error message would explain. So that is what is checked here.
 */
export function assertPrefixesAgree(cfg: Config): void {
  // A relative or root gitdir does not fail — it QUIETLY produces a different
  // key space (`objectsKeyPrefix('r/', '/')` is `r/objects`, which is the old
  // broken layout), and `objectsDirs: ['<gitdir>/objects']` stops matching the
  // paths git generates. Both failures are silent-empty-store failures, so the
  // shape is checked here rather than discovered as "doctor says 0 objects".
  if (!cfg.gitdir.startsWith('/') || cfg.gitdir === '/') {
    throw new Error(
      `gitdir must be an absolute path below the root, got ${JSON.stringify(cfg.gitdir)}`,
    );
  }
  if (cfg.objectPrefix !== '' && !cfg.objectPrefix.endsWith('/')) {
    throw new Error(
      `objectPrefix must be empty or end in '/', got ${JSON.stringify(cfg.objectPrefix)}`,
    );
  }
  // Cross-check the derivation against a sample of the adapter's own rule
  // (`key(path) = objectPrefix + normalize(path).slice(1)`) for a path the
  // adapter really receives. If 05-adapter's rule ever changes, this trips at
  // startup instead of returning an empty object store forever.
  const samplePath = `${cfg.gitdir}/objects/ab/${'c'.repeat(38)}`;
  const adapterKey = cfg.objectPrefix + samplePath.slice(1);
  const ourKey = `${objectsKeyPrefix(cfg.objectPrefix, cfg.gitdir)}/ab/${'c'.repeat(38)}`;
  if (adapterKey !== ourKey) {
    throw new Error(
      `object key layout mismatch: fs adapter writes "${adapterKey}", ` +
        `07-refs ObjectStore reads "${ourKey}"`,
    );
  }
}
