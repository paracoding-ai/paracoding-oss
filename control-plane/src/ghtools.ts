// SPDX-License-Identifier: Apache-2.0
//
// [GH-TOOLS-V1] GITHUB REPOSITORIES AS AN AGENT SURFACE, WITH THE CREDENTIAL IN THE CONTROL
// PLANE AND NEVER IN THE AGENT.
//
// This system already solves this problem once, for Google Cloud: gcp_api lets an agent call
// any GCP endpoint while the credential stays here. The shipped wiki sells that property in as
// many words -- "you do not need to give an agent a Google credential ... if an agent asks you
// for one, that is a signal something is wrong, not a setup step." GitHub gets the same
// treatment, for the same reason, and NOT because it is tidier: a token that lives with the
// agent cannot be used by the console chat, cannot be used by the runner lane, and has to be
// re-pasted by every person who ever opens a session.
//
// THE VOCABULARY IS DELIBERATELY THE SAME AS git_*. Agents already learn propose-verify-push
// from the fleet repository in BOOTSTRAP section 3; making GitHub a second idiom would be a
// second thing to learn for no gain. gh_read/gh_list/gh_log/gh_diff read, gh_commit writes,
// and the two rules that govern git_push govern it too: whole files, and no force push.
//
// TWO PROPERTIES HERE ARE NOT CONVENIENCES AND MUST NOT BE SIMPLIFIED AWAY.
//
// 1. MODES ARE SET EXPLICITLY, AND THE DEFAULT IS KEYED ON THE SHEBANG. This is not
//    theoretical tidiness -- it is a defect this project shipped publicly and had to fix by
//    hand. Every file in the published paracoding-oss repository was mode 100644, because the
//    only write path anyone had was GitHub's web upload and that path cannot carry a mode. The
//    consequence: `./install.sh`, the FIRST command in that repository's own README, failed
//    with "permission denied" for every person who cloned it, and the README was eventually
//    edited to say `bash install.sh` to work around a bug nobody had located. A tool that
//    writes files to GitHub without setting modes ships that same defect to every adopter who
//    uses it. So gh_commit builds the tree through the Git Data API with an explicit mode per
//    entry, and the default mirrors gen.py's put(): bytes beginning "#!" are 100755. Keyed on
//    the shebang rather than on a filename list, because a list needs editing every time a
//    script is added and rots silently the first time somebody forgets.
//
// 2. THERE IS NO FORCE PUSH. The branch moves with PATCH /git/refs/heads/<branch> and
//    force:false, which GitHub refuses unless the update is a fast-forward. That is a real
//    compare-and-swap, not a convention, and it is the same rule git_push already follows: a
//    lost race FAILS and the agent re-reads and rebuilds, rather than silently destroying a
//    commit somebody else made. expected_head is checked as well, before anything is written,
//    so a stale caller is refused before it has spent a single blob upload.
//
// WHAT THIS IS NOT. Issues, actions, projects, gists and code search are out of scope and
// should stay out. GitHub publishes its own MCP server covering all of that; if this module
// grows to cover the whole API it becomes a worse copy of something GitHub maintains. This is
// the git-shaped subset -- the part that matters for reading and changing code.
//
// [GH-RELEASE-V1] RELEASES WERE ON THAT LIST UNTIL 12.3 AND ARE NOW THE ONE EXCEPTION, WHICH
// IS RECORDED HERE RATHER THAN LEFT AS A HEADER THAT CONTRADICTS THE CODE BELOW IT.
//
// gh_tag was never a crossing: refs/tags is the Git Data API, the exact sibling of gh_branch's
// refs/heads, and its absence was a hole in the git-shaped subset rather than a boundary.
//
// gh_release IS a crossing and it is deliberate. The boundary exists to stop this becoming a
// general GitHub client; publishing THIS product's own releases is the last step of a publish
// pipeline that already lives here. WHAT IT COST TO NOT HAVE IT, measured 2026-08-30: the
// published repository advertised v10.5 as its Latest release while main carried v12.2 --
// three releases behind, across two version families, for eleven days. gh_commit could publish
// the whole tree and could not name the version it had just published, so the one thing a
// visitor reads first was the one thing this product could not keep true about itself. Every
// tag before this was made by hand in a browser, which is also why the v10.5 tag is authored
// with an operator's personal address while every gh_commit release is authored as the
// project. A tool that cannot state its own version is not tidier for the omission.
//
// THE LINE THAT STAYS: this covers creating and reading THIS repository's releases, and
// nothing else. No issues, no actions, no projects, no discussions, no assets beyond the
// tarball GitHub generates for a tag. If a future change needs a second GitHub product API,
// that is the point to reach for GitHub's own MCP server instead of extending this.

type GhDeps = {
  secretGet: (name: string) => Promise<string | null>;
  secretPrefix?: string;
  pcgitRead?: (path: string, ref: string) => Promise<any>;
  configGet?: () => Promise<any>;
  journal?: (action: string, message: string) => Promise<void> | void;
  fetchImpl?: any;
};

// [GH-UA-V1] GitHub requires a User-Agent and rejects a request without one. It must NOT be a
// service name: the release gate refuses a lane-namespaced resource named by bare literal in
// emitted TypeScript, and it is right to -- compiled code cannot see ${PC_LP}, so a service
// name baked in here would be this fleet's name shipped to every adopter. A product name
// identifies the caller to GitHub just as well and names no resource.
const GH_UA = 'paracoding';
const GH_API_VERSION = '2022-11-28';

// [GH-SLUG-V1] An identity is a SLUG, not a token, and the slug is what travels through tool
// arguments, journal lines and error text. The token itself is only ever a Secret Manager
// name resolved here. Restricting the character set is what makes that safe: the slug is
// interpolated into a secret name, so anything outside [a-z0-9-] could reach for a different
// secret entirely. Refused rather than sanitised -- silently rewriting an identity to a
// different one that happens to exist is worse than saying no.
function ghSlug(s: any): string {
  const v = String(s == null ? 'default' : s).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(v)) {
    throw new Error('REFUSED: identity "' + v + '" is not a valid slug. Use lowercase letters, '
      + 'digits and hyphens, 1-32 characters. The identity names which stored GitHub token to '
      + 'use; it is not a token and not a username.');
  }
  return v;
}
// [GH-SECRET-LANE-PREFIX-V1] Same prefix, same env var, same default as index.ts -- and it is
// passed IN rather than read here, so there is exactly one place that decides. Two modules each
// reading process.env would agree today and drift the first time one of them gains a fallback.
function ghSecretName(prefix: string, slug: string): string { return prefix + slug; }

// [GH-REPO-SHAPE-V1] owner/repo is parsed and asserted rather than passed through. A caller
// that sends a URL, a bare name or a path with a ref appended would otherwise produce a
// request to a URL that is merely WRONG rather than refused, and GitHub answers many wrong
// URLs with 404 -- which reads as "no such repository" and sends the reader looking for a
// permissions problem that does not exist.
function ghRepo(s: any): { owner: string; repo: string; full: string } {
  let v = String(s || '').trim();
  v = v.replace(/^https?:\/\/[^/]+\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(v);
  if (!m) {
    throw new Error('REFUSED: "' + String(s) + '" is not owner/repo. Pass it exactly as GitHub '
      + 'writes it, for example "octocat/hello-world". A full URL is accepted and reduced; '
      + 'anything else is refused rather than guessed at.');
  }
  return { owner: m[1], repo: m[2], full: m[1] + '/' + m[2] };
}

export function registerGithubTools(server: any, z: any, AG: any, agentId: string, deps: GhDeps) {
  const registered: string[] = [];
  const _fetch: any = deps.fetchImpl || (globalThis as any).fetch;
  if (typeof _fetch !== 'function') return registered;

  const SECPFX = deps.secretPrefix || 'github-token-';
  const okr = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
  const failr = (e: any) => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 2) }],
    isError: true,
  });

  let _cfgCache: any = null;
  async function cfg(): Promise<any> {
    if (_cfgCache) return _cfgCache;
    try { _cfgCache = (deps.configGet ? await deps.configGet() : null) || {}; }
    catch (_e) { _cfgCache = {}; }
    return _cfgCache;
  }

  async function apiBase(): Promise<string> {
    // [GH-GHES-V1] One field, in from the start rather than retrofitted. Corporate installs are
    // frequently on GitHub Enterprise Server, whose API is the same shape against a different
    // host -- so supporting it costs one config read now and a rewrite of every call site later.
    const c = await cfg();
    const b = String((c && c.api_base) || 'https://api.github.com').replace(/\/+$/, '');
    return b;
  }

  async function tokenFor(slug: string): Promise<string> {
    const t = await deps.secretGet(ghSecretName(SECPFX, slug));
    if (!t || !t.trim()) {
      throw new Error('REFUSED: no GitHub token is stored for identity "' + slug + '". Add one in '
        + 'the console under Settings -> GitHub. Nothing has been sent to GitHub. '
        + '(The token is written to Secret Manager as ' + ghSecretName(SECPFX, slug) + ' and is never '
        + 'returned by any route or tool.)');
    }
    return t.trim();
  }

  // [GH-IDENTITY-ROUTING-V1] WHICH TOKEN A CALL USES, in order: an explicit identity argument,
  // then an owner->identity map from config, then "default". The map is what makes the
  // operator's actual workflow work without thinking about it -- a work account for the private
  // work repositories and a personal one for everything else, chosen by the repository being
  // addressed rather than remembered per call.
  async function resolveIdentity(repoFull: string | null, explicit: any): Promise<string> {
    if (explicit != null && String(explicit).trim() !== '') return ghSlug(explicit);
    const c = await cfg();
    const owners = (c && c.owners) || {};
    if (repoFull) {
      const owner = repoFull.split('/')[0].toLowerCase();
      if (owners[owner]) return ghSlug(owners[owner]);
    }
    return ghSlug((c && c.default_identity) || 'default');
  }

  // [GH-ALLOWLIST-V1] AN OPTIONAL SECOND FENCE, AND ITS DEFAULT IS DELIBERATE. A fine-grained
  // PAT is already scoped by GitHub to the repositories the operator selected, so an empty
  // allowlist here is not "unprotected" -- the scope is enforced, by GitHub, and this module
  // does not pretend otherwise. The allowlist exists for the case the token is BROADER than the
  // agent should be: one token covering an org, but only two repositories an agent may touch.
  // Defaulting to deny would have made a freshly-pasted token do nothing at all, which reads as
  // broken and is the kind of first experience that gets a feature switched off.
  async function assertAllowed(repoFull: string): Promise<void> {
    const c = await cfg();
    const pats: string[] = (c && Array.isArray(c.repos) ? c.repos : []).map((x: any) => String(x).toLowerCase());
    if (!pats.length) return;
    const f = repoFull.toLowerCase();
    const hit = pats.some((p) => p === f || (p.endsWith('/*') && f.startsWith(p.slice(0, -1))));
    if (!hit) {
      throw new Error('REFUSED: ' + repoFull + ' is not in this install\'s GitHub allowlist. '
        + 'Nothing has been read or written. The allowlist is set in the console under '
        + 'Settings -> GitHub; it currently permits: ' + pats.join(', '));
    }
  }

  async function gh(slug: string, method: string, path: string, body?: any): Promise<any> {
    const tok = await tokenFor(slug);
    const url = path.startsWith('http') ? path : (await apiBase()) + path;
    const r = await _fetch(url, {
      method,
      headers: Object.assign(
        {
          Authorization: 'Bearer ' + tok,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GH_API_VERSION,
          'User-Agent': GH_UA,
        },
        body === undefined ? {} : { 'Content-Type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch (_e) { j = null; }
    if (!r.ok) {
      // [GH-ERROR-CARRIES-GITHUB-V1] GitHub's own message travels back verbatim. The failure
      // that costs the most time here is a 403 that means "your token cannot see this repo"
      // being reported as a generic error, because the reader then investigates the tool
      // instead of the token. 404 is called out by name for the same reason: on a private
      // repository an unauthorised token gets 404, not 403, so "not found" and "not permitted"
      // are the same response and a reader who does not know that goes looking for a typo.
      const msg = (j && (j.message || j.error)) ? String(j.message || j.error) : text.slice(0, 300);
      const extra = r.status === 404
        ? ' (NOTE: on a PRIVATE repository GitHub answers 404 rather than 403 when the token '
          + 'cannot see it, so this may be a permissions problem rather than a wrong name. '
          + 'Check that the token\'s repository scope includes it.)'
        : '';
      throw new Error('GitHub ' + method + ' ' + path + ' -> HTTP ' + r.status + ': ' + msg + extra);
    }
    return j;
  }

  const j = (action: string, message: string) => {
    try { if (deps.journal) Promise.resolve(deps.journal(action, message)).catch(() => {}); }
    catch (_e) { /* journalling must never fail a write that already happened */ }
  };

  const wrap = (fn: (a: any) => Promise<any>) => async (a: any) => {
    try { return okr(await fn(a || {})); } catch (e) { return failr(e); }
  };

  // ---------------------------------------------------------------- read

  server.registerTool('gh_whoami',
    { description: 'Which GitHub identities this install has tokens for, and which GitHub account each one actually authenticates as. Call this FIRST -- it answers "can I reach GitHub at all, and as whom" without guessing, and it never returns a token. An identity is a slug naming a stored credential (for example "work"), not a username.',
      inputSchema: { identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const c = await cfg();
      const slugs: string[] = Array.isArray(c.identities) && c.identities.length
        ? c.identities.map((x: any) => ghSlug(x))
        : [ghSlug(a.identity || (c && c.default_identity) || 'default')];
      const out: any[] = [];
      for (const s of slugs) {
        try {
          const u = await gh(s, 'GET', '/user');
          out.push({ identity: s, authenticated_as: u && u.login, account_type: u && u.type, ok: true });
        } catch (e: any) {
          out.push({ identity: s, ok: false, error: String(e && e.message ? e.message : e) });
        }
      }
      return {
        ok: true,
        identities: out,
        default_identity: ghSlug((c && c.default_identity) || 'default'),
        owner_routing: (c && c.owners) || {},
        allowlist: (c && c.repos) || [],
        note: 'Tokens live in Secret Manager and are read by the control plane only. No tool or route returns one.',
      };
    }));

  server.registerTool('gh_repos',
    { description: 'Repositories this identity\'s token can see, newest first. Use it to find the exact owner/repo spelling before any other call.',
      inputSchema: { identity: z.string().optional(), max_count: z.number().int().min(1).max(100).optional(), ...AG } },
    wrap(async (a: any) => {
      const slug = await resolveIdentity(null, a.identity);
      const n = Math.min(100, Math.max(1, Number(a.max_count || 30)));
      const rows = await gh(slug, 'GET', '/user/repos?per_page=' + n + '&sort=updated');
      return {
        ok: true, identity: slug, count: (rows || []).length,
        repos: (rows || []).map((r: any) => ({
          full_name: r.full_name, private: !!r.private, default_branch: r.default_branch,
          permissions: r.permissions, updated_at: r.updated_at,
        })),
      };
    }));

  server.registerTool('gh_read',
    { description: 'Read one file from a GitHub repository at a ref. Returns the decoded contents, the blob sha and the resolved ref. A file too large for the contents API is refused with its size rather than silently truncated.',
      inputSchema: { repo: z.string(), path: z.string(), ref: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const q = a.ref ? '?ref=' + encodeURIComponent(String(a.ref)) : '';
      const r = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/contents/' + String(a.path).split('/').map(encodeURIComponent).join('/') + q);
      if (Array.isArray(r)) throw new Error('REFUSED: ' + a.path + ' is a directory, not a file. Use gh_list.');
      if (r && r.content == null && r.size != null) {
        throw new Error('REFUSED: ' + a.path + ' is ' + r.size + ' bytes, which the contents API '
          + 'will not inline. Nothing was truncated and nothing is being guessed at.');
      }
      const buf = Buffer.from(String(r.content || ''), 'base64');
      return { ok: true, repo: R.full, path: r.path, ref: a.ref || null, sha: r.sha, size: r.size, content: buf.toString('utf8') };
    }));

  server.registerTool('gh_list',
    { description: 'List the entries of a directory in a GitHub repository at a ref. Omit path for the repository root. Each entry carries name, path, type, size and sha.',
      inputSchema: { repo: z.string(), path: z.string().optional(), ref: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const p = String(a.path || '').replace(/^\/+|\/+$/g, '');
      const q = a.ref ? '?ref=' + encodeURIComponent(String(a.ref)) : '';
      const r = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/contents/' + (p ? p.split('/').map(encodeURIComponent).join('/') : '') + q);
      const rows = Array.isArray(r) ? r : [r];
      return { ok: true, repo: R.full, path: p, count: rows.length,
        entries: rows.map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha })) };
    }));

  server.registerTool('gh_log',
    { description: 'Commits on a GitHub repository, newest first. With path, only commits that changed that file or directory.',
      inputSchema: { repo: z.string(), ref: z.string().optional(), max_count: z.number().int().min(1).max(100), path: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const qs = ['per_page=' + Math.min(100, Math.max(1, Number(a.max_count)))];
      if (a.ref) qs.push('sha=' + encodeURIComponent(String(a.ref)));
      if (a.path) qs.push('path=' + encodeURIComponent(String(a.path)));
      const rows = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/commits?' + qs.join('&'));
      return { ok: true, repo: R.full, count: (rows || []).length,
        commits: (rows || []).map((c: any) => ({
          sha: c.sha, message: (c.commit && c.commit.message) || '',
          author: c.commit && c.commit.author && (c.commit.author.name + ' <' + c.commit.author.email + '>'),
          date: c.commit && c.commit.author && c.commit.author.date,
        })) };
    }));

  server.registerTool('gh_diff',
    { description: 'Compare two refs in a GitHub repository. Returns the per-file status and patch, the commit range and the ahead/behind counts.',
      inputSchema: { repo: z.string(), base: z.string(), head: z.string(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const r = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/compare/'
        + encodeURIComponent(String(a.base)) + '...' + encodeURIComponent(String(a.head)));
      return { ok: true, repo: R.full, status: r.status, ahead_by: r.ahead_by, behind_by: r.behind_by,
        total_commits: r.total_commits,
        files: (r.files || []).map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })) };
    }));

  // ---------------------------------------------------------------- write

  // [GH-MODE-SHEBANG-V1] See the header. The default is computed from the BYTES, never from a
  // filename list, and an explicit mode always wins so a caller who knows better is not fought.
  function ghMode(content: string, explicit: any): string {
    const m = explicit == null ? '' : String(explicit);
    if (m === '100644' || m === '100755') return m;
    if (m !== '') {
      throw new Error('REFUSED: mode "' + m + '" is not one this tool will write. Use "100755" '
        + 'for an executable file or "100644" for an ordinary one, or omit it and the mode is '
        + 'taken from the content: bytes beginning "#!" get 100755.');
    }
    return content.slice(0, 2) === '#!' ? '100755' : '100644';
  }

  server.registerTool('gh_commit',
    { description: 'Create a commit on a GitHub branch from WHOLE FILES and move the branch by compare-and-swap. Each entry replaces an entire file with `content`, COPIES IT STRAIGHT OUT OF THE GIT STORE THIS INSTALL OWNS with `copy_from_pcgit:{path,ref}` -- the bytes never travel as a tool argument, which is the only way to publish a large tree -- or removes it with delete:true. FILE MODES ARE SET EXPLICITLY -- a file whose content begins "#!" lands 100755 unless you say otherwise, so a committed script is executable on a fresh clone. THERE IS NO FORCE PUSH: the ref is updated with force:false, so a non-fast-forward update FAILS rather than discarding anyone\'s work, and expected_head is checked before a single byte is uploaded. Pass expected_head from gh_log to make the race explicit.',
      inputSchema: {
        repo: z.string(), branch: z.string(), message: z.string(),
        files: z.array(z.object({
          path: z.string(), content: z.string().optional(),
          copy_from_pcgit: z.object({ path: z.string(), ref: z.string().optional() }).optional(),
          mode: z.string().optional(), delete: z.boolean().optional(),
        })).min(1),
        expected_head: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const branch = String(a.branch).replace(/^refs\/heads\//, '');

      const ref = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/git/ref/heads/' + encodeURIComponent(branch));
      const head = ref && ref.object && ref.object.sha;
      if (!head) throw new Error('REFUSED: could not resolve the head of ' + branch + '.');
      if (a.expected_head && String(a.expected_head) !== head) {
        throw new Error('STALE: ' + R.full + ' ' + branch + ' is at ' + head + ', not the '
          + String(a.expected_head) + ' you expected. NOTHING WAS WRITTEN. Re-read the branch and '
          + 'rebuild your change on the new head -- this is the same rule git_push follows, and '
          + 'it exists so a lost race cannot silently discard the commit that won.');
      }
      const baseCommit = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/git/commits/' + head);
      const baseTree = baseCommit && baseCommit.tree && baseCommit.tree.sha;

      const entries: any[] = [];
      for (const f of a.files) {
        const path = String(f.path).replace(/^\/+/, '');
        if (f.delete) { entries.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
        // [GH-PUBLISH-COPY-V1] copy_from_pcgit names a blob in THIS INSTALL'S OWN GIT STORE and the
        // control plane reads it directly, so the bytes never travel as a tool argument. That is
        // the difference between publishing a release and being unable to: a 790 KB source file
        // is nothing over HTTP inside the service and impossible through an MCP call.
        let raw: string; let b64: string; let modeSrc: string;
        if (f.copy_from_pcgit) {
          if (!deps.pcgitRead) {
            throw new Error('REFUSED: copy_from_pcgit was used but this deployment has no '
              + 'repository reader wired in. Nothing was written.');
          }
          const src = f.copy_from_pcgit;
          const got = await deps.pcgitRead(String(src.path), String(src.ref || 'main'));
          if (got && got.encoding === 'base64') { b64 = String(got.content); raw = ''; modeSrc = ''; }
          else { raw = String((got && got.content) || ''); b64 = Buffer.from(raw, 'utf8').toString('base64'); modeSrc = raw; }
        } else if (typeof f.content === 'string') {
          raw = f.content; b64 = Buffer.from(raw, 'utf8').toString('base64'); modeSrc = raw;
        } else {
          throw new Error('REFUSED: "' + path + '" has no content, no copy_from_pcgit and no '
            + 'delete:true. Each entry must say exactly one of the three; a missing content is '
            + 'not an empty file.');
        }
        const blob = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/blobs',
          { content: b64, encoding: 'base64' });
        // A BINARY blob has no shebang to read, so it takes 100644 unless told otherwise -- the
        // mode heuristic is deliberately not applied to bytes it cannot inspect as text.
        entries.push({ path, mode: ghMode(modeSrc, f.mode), type: 'blob', sha: blob.sha });
      }

      const tree = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/trees',
        { base_tree: baseTree, tree: entries });
      const commit = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/commits',
        { message: String(a.message), tree: tree.sha, parents: [head] });

      // force:false is the compare-and-swap. GitHub refuses the update unless it fast-forwards.
      const moved = await gh(slug, 'PATCH', '/repos/' + R.owner + '/' + R.repo + '/git/refs/heads/' + encodeURIComponent(branch),
        { sha: commit.sha, force: false });

      j('gh_commit', agentId + ' committed ' + commit.sha.slice(0, 8) + ' to ' + R.full + ' ' + branch
        + ' (' + a.files.length + ' file(s), identity ' + slug + ')');
      return {
        ok: true, repo: R.full, branch, commit: commit.sha, tree: tree.sha, previous_head: head,
        ref: moved && moved.ref,
        files: entries.map((e) => ({ path: e.path, mode: e.sha === null ? 'deleted' : e.mode, blob: e.sha })),
        url: 'https://github.com/' + R.full + '/commit/' + commit.sha,
      };
    }));

  server.registerTool('gh_branch',
    { description: 'Create a branch in a GitHub repository from an existing ref. Refuses if the branch already exists rather than moving it -- moving a branch is gh_commit\'s job and doing it here would be a force push wearing a different name.',
      inputSchema: { repo: z.string(), branch: z.string(), from_ref: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const branch = String(a.branch).replace(/^refs\/heads\//, '');
      let from = String(a.from_ref || '').trim();
      if (!from) { const r = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo); from = r.default_branch; }
      const src = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/commits/' + encodeURIComponent(from));
      const made = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/refs',
        { ref: 'refs/heads/' + branch, sha: src.sha });
      j('gh_branch', agentId + ' created ' + R.full + ' ' + branch + ' at ' + String(src.sha).slice(0, 8));
      return { ok: true, repo: R.full, branch, from: from, sha: src.sha, ref: made && made.ref };
    }));

  server.registerTool('gh_fork',
    { description: 'Fork a GitHub repository into this identity\'s account. This is what makes contributing back possible WITHOUT write access to the upstream repository: fork, branch, commit to the fork, then open a pull request upstream. Forking is idempotent -- GitHub returns the existing fork rather than erroring.',
      inputSchema: { repo: z.string(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo);
      const slug = await resolveIdentity(R.full, a.identity);
      const f = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/forks', {});
      j('gh_fork', agentId + ' forked ' + R.full + ' to ' + (f && f.full_name));
      return { ok: true, upstream: R.full, fork: f && f.full_name, default_branch: f && f.default_branch,
        note: 'A fork is created asynchronously by GitHub and can take a few seconds to become '
          + 'usable. If the next call 404s, retry once before concluding anything.' };
    }));

  server.registerTool('gh_pr',
    { description: 'Open a pull request. For a contribution from a fork, head is "your-login:your-branch" and repo is the UPSTREAM repository. Returns the PR number and URL.',
      inputSchema: { repo: z.string(), head: z.string(), base: z.string(), title: z.string(),
        body: z.string().optional(), draft: z.boolean().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo);
      const slug = await resolveIdentity(R.full, a.identity);
      const pr = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/pulls',
        { title: String(a.title), head: String(a.head), base: String(a.base),
          body: String(a.body || ''), draft: !!a.draft });
      j('gh_pr', agentId + ' opened ' + R.full + ' #' + pr.number + ' (' + a.head + ' -> ' + a.base + ')');
      return { ok: true, repo: R.full, number: pr.number, url: pr.html_url, state: pr.state, draft: !!pr.draft };
    }));

  // ---------------------------------------------------------------- tags and releases

  // [GH-TAG-NO-MOVE-V1] A tag REFUSES to move, and the reason is stronger than the one that
  // makes gh_branch refuse. Moving a branch loses a commit; moving a tag changes what an
  // already-published version NAMES, so a person who downloaded v1.2 yesterday and a person who
  // downloads v1.2 tomorrow get different bytes under one name, with nothing anywhere recording
  // that it happened. That is the exact failure RELEASING.md's "a cut that leaves your hands has
  // spent its number" exists to prevent, and a tool that can move a tag hands anyone a way to
  // undo that rule by accident. Cut a new number instead.
  server.registerTool('gh_tag',
    { description: 'Create a tag in a GitHub repository at an existing ref. REFUSES if the tag already exists rather than moving it: moving a tag changes what an already-published version NAMES, so two people downloading the same version get different bytes. Cut a new number instead. Pass message to create an ANNOTATED tag (tagged by the token\'s account, which is what keeps a personal address out of a published tag); omit it for a lightweight tag, which carries no tagger at all. from_ref defaults to the default branch and may be a branch, a tag or a full commit sha.',
      inputSchema: { repo: z.string(), tag: z.string(), from_ref: z.string().optional(),
        message: z.string().optional(), identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const tag = String(a.tag || '').replace(/^refs\/tags\//, '').trim();
      if (!tag) throw new Error('REFUSED: tag is required.');
      // Checked BEFORE anything is written, and reported as its own refusal rather than left to
      // GitHub's 422 "Reference already exists", which reads like a transient conflict.
      let existing: any = null;
      try { existing = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/git/ref/tags/' + encodeURIComponent(tag)); }
      catch (_e) { existing = null; }
      if (existing && existing.object && existing.object.sha) {
        throw new Error('REFUSED: tag ' + tag + ' already exists in ' + R.full + ' at '
          + String(existing.object.sha).slice(0, 8) + '. This tool does not move a tag, because '
          + 'moving one changes what an already-published version names. If the bytes changed, '
          + 'the version number is spent -- cut a new one.');
      }
      let from = String(a.from_ref || '').trim();
      if (!from) { const r = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo); from = r.default_branch; }
      const src = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/commits/' + encodeURIComponent(from));
      const msg = a.message === undefined || a.message === null ? '' : String(a.message);
      let pointsAt = src.sha;
      let annotated = false;
      if (msg) {
        const obj = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/tags',
          { tag, message: msg, object: src.sha, type: 'commit' });
        pointsAt = obj.sha; annotated = true;
      }
      const made = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/git/refs',
        { ref: 'refs/tags/' + tag, sha: pointsAt });
      j('gh_tag', agentId + ' tagged ' + R.full + ' ' + tag + ' at ' + String(src.sha).slice(0, 8)
        + (annotated ? ' (annotated)' : ' (lightweight)'));
      return { ok: true, repo: R.full, tag, annotated, commit: src.sha,
        ref: made && made.ref, object: pointsAt,
        url: 'https://github.com/' + R.full + '/releases/tag/' + encodeURIComponent(tag) };
    }));

  // [GH-RELEASE-NO-IMPLICIT-TAG-V1] The tag must already exist. GitHub's release API accepts a
  // tag_name that does not exist and CREATES it from target_commitish -- which defaults to the
  // default branch, so a release cut while main has moved silently tags a commit nobody chose
  // and the release then points at bytes nobody tested. Refusing costs one extra call; the
  // alternative is a published version whose contents nobody can account for.
  server.registerTool('gh_release',
    { description: 'Publish a GitHub Release for a tag that ALREADY EXISTS. Refuses to create the tag for you -- GitHub would happily invent one at whatever the default branch points at right now, which silently publishes bytes nobody chose; use gh_tag first. Refuses if a release already exists for that tag unless update:true, which edits that release in place. This is what makes the repository advertise the version you actually shipped: the Releases card shows the newest RELEASE, so a bare tag does not displace an older release. latest defaults to true.',
      inputSchema: { repo: z.string(), tag: z.string(), name: z.string().optional(),
        body: z.string().optional(), draft: z.boolean().optional(), prerelease: z.boolean().optional(),
        latest: z.boolean().optional(), update: z.boolean().optional(),
        identity: z.string().optional(), ...AG } },
    wrap(async (a: any) => {
      const R = ghRepo(a.repo); await assertAllowed(R.full);
      const slug = await resolveIdentity(R.full, a.identity);
      const tag = String(a.tag || '').replace(/^refs\/tags\//, '').trim();
      if (!tag) throw new Error('REFUSED: tag is required.');
      let ref: any = null;
      try { ref = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/git/ref/tags/' + encodeURIComponent(tag)); }
      catch (_e) { ref = null; }
      if (!ref || !ref.object || !ref.object.sha) {
        throw new Error('REFUSED: ' + R.full + ' has no tag ' + tag + '. This tool will NOT create '
          + 'it: GitHub creates a missing tag at whatever the default branch points at now, which '
          + 'publishes a commit nobody chose. Create the tag at the commit you mean with gh_tag, '
          + 'then call this again.');
      }
      let prior: any = null;
      try { prior = await gh(slug, 'GET', '/repos/' + R.owner + '/' + R.repo + '/releases/tags/' + encodeURIComponent(tag)); }
      catch (_e) { prior = null; }
      const payload: any = {
        tag_name: tag,
        name: String(a.name || tag),
        body: String(a.body || ''),
        draft: !!a.draft,
        prerelease: !!a.prerelease,
        make_latest: (a.latest === false || !!a.draft || !!a.prerelease) ? 'false' : 'true',
      };
      if (prior && prior.id) {
        if (!a.update) {
          throw new Error('REFUSED: ' + R.full + ' already has a release for ' + tag
            + ' (id ' + prior.id + ', ' + prior.html_url + '). Pass update:true to edit it in place. '
            + 'A release is what a visitor reads as the current version, so replacing one silently '
            + 'is not a thing this does by default.');
        }
        const up = await gh(slug, 'PATCH', '/repos/' + R.owner + '/' + R.repo + '/releases/' + prior.id, payload);
        j('gh_release', agentId + ' updated ' + R.full + ' release ' + tag + ' (id ' + prior.id + ')');
        return { ok: true, repo: R.full, tag, updated: true, id: up.id, url: up.html_url,
          commit: ref.object.sha, latest: payload.make_latest === 'true', draft: !!up.draft };
      }
      const rel = await gh(slug, 'POST', '/repos/' + R.owner + '/' + R.repo + '/releases', payload);
      j('gh_release', agentId + ' published ' + R.full + ' release ' + tag + ' (id ' + rel.id + ')');
      return { ok: true, repo: R.full, tag, updated: false, id: rel.id, url: rel.html_url,
        commit: ref.object.sha, latest: payload.make_latest === 'true', draft: !!rel.draft };
    }));

  for (const n of ['gh_whoami', 'gh_repos', 'gh_read', 'gh_list', 'gh_log', 'gh_diff',
                   'gh_commit', 'gh_branch', 'gh_fork', 'gh_pr',
                   'gh_tag', 'gh_release']) registered.push(n);
  return registered;
}
