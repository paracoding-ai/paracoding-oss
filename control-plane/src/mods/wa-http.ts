// SPDX-License-Identifier: Apache-2.0
// [WA-HTTP-V1] HTTP wrappers (waFetchLong/waPostLong) plus the PURE gate/util helpers
// (waSafe, waCookie, waIsDangerous, waJobCommand, waWorkstreamOf) lifted VERBATIM out of
// index.ts. These import only '../shared.js' and sibling mods (NEVER '../index.js'), so they
// are cycle-free and loadable by the module tests. The privileged-execution path
// (waExecuteApproved/waRunGodmode/waCallExec/waGate/session minting/BigQuery) stays in index.ts.
import express from 'express';
import * as nodeHttp from 'http';
import * as nodeHttps from 'https';
import { waFetch } from '../shared.js';
import { pcCol } from './collections.js';

export function waSafe(fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return async (req: express.Request, res: express.Response) => {
    try { await fn(req, res); }
    catch (e: any) { console.error('[gate] handler error', e); if (!res.headersSent) res.status(500).json((console.error('[gate] error detail withheld from client:', e), { error: 'request failed' })); }
  };
}
export function waCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie; if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export function waIsDangerous(cmd: string): boolean {
  // [SEC-DANGER-GCLOUD-REST-V2] The original alternatives are kept VERBATIM and in order; this
  // change is PURELY ADDITIVE so anything that greps the old text still matches. What the old
  // regex missed, measured against real staged commands: `gcloud storage rm` (only `gsutil rm`
  // was covered, and gsutil is deprecated), `gcloud compute instances stop` (no verb but
  // `delete` was covered), and `curl -X DELETE .../instances/...` (no REST verb at all). All
  // three returned false and were therefore never classified dangerous. Deliberately NOT added:
  // bare `start`, `create`, `describe`, `list`, `cp`, `deploy` -- a classifier that flags every
  // gcloud invocation gets clicked through, which is the same as having no classifier.
  return /(\bgcloud\b[^\n]*\bdelete\b)|(remove-iam-policy-binding)|(add-iam-policy-binding[^\n]*roles\/(owner|editor|resourcemanager|iam))|(\bsecrets\b[^\n]*\baccess\b)|(\brm\s+-rf\b)|(\bgsutil\b[^\n]*\brm\b)|(\bdestroy\b)|(\bmkfs\b)|(--no-backup)|(\bdrop\b\s+(table|database))|(\bgcloud\b[^\n]*\bstorage\b[^\n]*\b(rm|rb)\b)|(\bgcloud\b[^\n]*\b(compute|sql|container|run|functions|redis|spanner|dataproc|composer|notebooks|workstations)\b[^\n]*\b(stop|suspend|reset|terminate|abandon|detach)\b)|(\bgcloud\b[^\n]*\biam\b[^\n]*\b(disable|remove|purge)\b)|(\bservice-accounts\b[^\n]*\b(disable|delete)\b)|(\bset-iam-policy\b)|(\bsetIamPolicy\b)|(-X\s*['"]?(DELETE|PUT)\b)|(--request[\s=]+['"]?(DELETE|PUT)\b)|(\binstances\b[^\n]*\b(stop|delete|reset|terminate)\b)|(\bbuckets\b[^\n]*\bdelete\b)/i.test(cmd || '');
}
export async function waJobCommand(jobId: string): Promise<{ ok: boolean; command?: string; err?: string; danger?: boolean }> {
  const jdoc = await pcCol().doc(jobId).get();
  if (!jdoc.exists) return { ok: false, err: 'job not found' };
  const jx: any = jdoc.data();
  const command = (jx.arguments && (jx.arguments.command || jx.arguments.cmd)) || '';
  // SEC-DANGER-UNION-V1: carry the stager's own structured danger verdict out to the approval path.
  // harGcpStage already writes arguments.danger (from harGcpDanger) on every staged gcp_api job and
  // the gate read NONE of it -- the danger classification hung entirely on a word inside a
  // generated comment. Returned on the no-command path too, deliberately: a job flagged dangerous by its
  // stager stays dangerous even when there is no command text left to classify (fail-dangerous).
  const danger = !!(jx.arguments && jx.arguments.danger === true);
  if (!command) return { ok: false, err: 'job has no command to run as approver', danger };
  return { ok: true, command, danger };
}
// Workstream for a staged job: prefer a native `workstream` field (stamped at stage time — see
// gatev2-notes.md), else parse the `[workstream: X]` token STANDING-RULES rule 9 requires at the
// start of every #DESC. Returns '' when unknown (the UI buckets those as "Ungrouped").
export function waWorkstreamOf(j: any): string {
  try {
    if (j && j.workstream) return String(j.workstream).trim();
    const args = (j && j.arguments) || {};
    if (args.workstream) return String(args.workstream).trim();
    const cmd = String(args.command || args.cmd || '');
    const m = cmd.match(/\[workstream:\s*([a-z0-9._\-\/ ]+)\]/i);
    if (m) return m[1].trim();
    return '';
  } catch (e) { return ''; }
}
export function waPostLong(urlStr: string, headers: { [k: string]: string }, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('waPostLong: bad url')); return; }
    // Scheme chosen from the URL rather than hardcoded https. gate-exec and every model host are
    // https in production; the http branch exists so this function can be driven against a local
    // server that accepts a connection and never answers, which is the ONLY way to exercise the
    // timeout behaviour this whole block is about.
    const mod: any = u.protocol === 'http:' ? nodeHttp : nodeHttps;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
    }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (c: any) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    // OUR deadline, and it NAMES ITSELF and its env var in the error. The failure this replaces
    // surfaced as a bare 'fetch failed' with no number in it, so nobody reading a dead job could
    // tell which of the two 300s ceilings had fired.
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('waPostLong: no response within ' + timeoutMs + 'ms (EXEC_HTTP_TIMEOUT_MS)')); });
    req.on('error', (e: any) => reject(e));
    req.end(body);
  });
}
// ============ [MODEL-LONGRUN-V1] THE SAME CEILING SITS ON THE MODEL CALLS ============
// waPostLong above was written for the executor, where the ceiling was actively killing jobs. It
// is not special to that path. MEASURED by grep on this file: THREE model POST sites --
// harClaudePost (Anthropic /v1/messages and Vertex :rawPredict), harChatGemini (the toolless
// Gemini path) and harGeminiPost (the tool-capable one) -- and all three were plain waFetch, i.e.
// all three carried undici's 300s headersTimeout. A non-streaming completion sends NO response
// headers until the whole answer has been generated, so the ceiling is real, not theoretical.
//
// THIS ONE IS LATENT RATHER THAN LIVE AND IS STILL WORTH FIXING. Ordinary rounds on this install
// finish in seconds; what a 300s cap costs is the LONGEST, most expensive request of a build --
// a 16-round tool loop against a large context -- and it costs it as a bare `fetch failed` at the
// worst possible moment, with the tokens already paid for.
//
// A SHIM, NOT A REWRITE. All three sites are `const r = await waFetch(url, {...}); await r.json()`,
// so this returns the same four members fetch's Response gives those sites (ok, status, json,
// text). json() THROWS on an unparseable body exactly as fetch's does, which is what the
// parse_error catch at two of the three sites is already written against, so no error handling
// changes. NON-POST FALLS THROUGH to the ordinary global fetch: waPostLong is POST-only by
// construction (it always sets Content-Length and always writes a body) and quietly mishandling a
// GET here would be a worse bug than the one being fixed.
//
// DELIBERATELY NOT DONE: streaming. With SSE the headers arrive immediately and no timeout of this
// shape can ever apply, and the tokens become available to the progress bubble as they are made.
// That is the real fix and a much larger change; it is recorded here as the intended direction
// rather than quietly skipped.
const PC_MODEL_HTTP_TIMEOUT_MS = Math.max(60000, Number(process.env.MODEL_HTTP_TIMEOUT_MS || 1800000));
export async function waFetchLong(url: string, init: any): Promise<any> {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'POST') return await waFetch(url, init);
  const r = await waPostLong(String(url), (init && init.headers) || {}, String((init && init.body) || ''), PC_MODEL_HTTP_TIMEOUT_MS);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    async json(): Promise<any> { return JSON.parse(r.text); },
    async text(): Promise<string> { return r.text; },
  };
}
