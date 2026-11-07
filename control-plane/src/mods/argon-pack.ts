// SPDX-License-Identifier: Apache-2.0
// [ARGON-PACK-MOD-V1] The Argon context-packer + GitLab-read cluster, extracted from index.ts by the
// strangler refactor. Holds the pin store (argonPackLoad/Save), the GitLab read helpers
// (argonGitlabGet/Raw/Tree/Send) with the 60s raw-file memo, the per-turn pack renderer
// (argonPackRender) and the pin/unpin/status tools (argonPackTools). The build lane
// (argonBuildRun/RecoverOnBoot/argonBuildTools) stays in index.ts (chat-engine coupled) and imports
// the GitLab helpers from here. Never imports ../index.js.
import { cpkCol } from './collections.js';
import { waFetch } from '../shared.js';
import { harSecretGet } from './secrets-keys.js';
import { argonPackTok, argonLooksBinary } from './argon.js';

// Duplicated from index.ts (a one-line type creates no runtime coupling): the chat-tool shape.
type HarChatTool = { name: string; description: string; schema: any; run: (input: any) => Promise<string> };

// ========= [ARGON-PACK-V1] THE CONTEXT PACKER: WHOLE FILES, PINNED ONCE, CACHED =========
// WHY. Argon's window is 1,048,576 tokens, but the tool loop is a keyhole: every MCP result is cut
// at 55,555 characters (MCP-RESULT-CAP-V1) and every round re-sends every earlier result, so
// "read the whole codebase through tools" is both lossy and the shape of the 2026-10-16 runaway
// (81 calls, ~20M input tokens). The packer turns that around: the operator (or the model) pins
// whole files once; at the start of every Gemini turn the pack is rendered at the FRONT of the
// system instruction in a stable order, so it is the same prefix on every round and every turn and
// Vertex's implicit cache bills it at 5% after the first read. Pins live in Firestore
// chat_pack/{agentId}; contents are re-read from GitLab per turn (60s memo), so a pin always shows
// the branch as it is, and the cache only breaks when a pinned file actually changed.
const ARGON_PACK_BUDGET_TOK = Math.max(10000, Number(process.env.CHAT_PACK_BUDGET_TOK || 600000) || 600000);
export const ARGON_PACK_PROJECT = String(process.env.CHAT_PACK_PROJECT || 'root/paracoding-fleet');
const ARGON_PACK_MAX_FILES = Math.max(1, Number(process.env.CHAT_PACK_MAX_FILES || 400) || 400);
type ArgonPin = { project: string; path: string; ref: string; chars: number; added_at: string };
const argonPackMemo: Map<string, { at: number; ok: boolean; status: number; text: string }> = new Map();
export async function argonPackLoad(agentId: string): Promise<ArgonPin[]> {
  try {
    const d: any = await cpkCol().doc(agentId).get();
    const x: any = d && d.exists ? d.data() : null;
    return (x && Array.isArray(x.items)) ? x.items : [];
  } catch (e) { return []; }
}
export async function argonPackSave(agentId: string, items: ArgonPin[]): Promise<void> {
  await cpkCol().doc(agentId).set({ items: items, updated_at: new Date().toISOString() });
}
export async function argonGitlabGet(pathx: string): Promise<{ ok: boolean; status: number; text: string }> {
  const pat = await harSecretGet('gitlab-api-token');
  const r: any = await waFetch('http://127.0.0.1/gitlab/api/v4' + pathx, { headers: { 'PRIVATE-TOKEN': pat || '' } });
  const t: string = await r.text();
  return { ok: !!r.ok, status: Number(r.status || 0), text: t };
}
export async function argonGitlabRaw(project: string, path: string, ref: string): Promise<{ ok: boolean; status: number; text: string }> {
  const k = project + '|' + ref + '|' + path;
  const m = argonPackMemo.get(k);
  if (m && Date.now() - m.at < 60000) return m;
  const r = await argonGitlabGet('/projects/' + encodeURIComponent(project) + '/repository/files/' + encodeURIComponent(path) + '/raw?ref=' + encodeURIComponent(ref));
  const v = { at: Date.now(), ok: r.ok, status: r.status, text: r.text };
  argonPackMemo.set(k, v);
  if (argonPackMemo.size > 2000) { const first = argonPackMemo.keys().next().value; if (first) argonPackMemo.delete(first); }
  return v;
}
// A directory pin expands to its blobs (recursive), optionally filtered by suffix.
export async function argonGitlabTree(project: string, dir: string, ref: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await argonGitlabGet('/projects/' + encodeURIComponent(project) + '/repository/tree?recursive=true&per_page=100&page=' + page
      + '&ref=' + encodeURIComponent(ref) + (dir ? '&path=' + encodeURIComponent(dir.replace(/\/+$/, '')) : ''));
    if (!r.ok) break;
    let rows: any[] = []; try { rows = JSON.parse(r.text); } catch (e) { rows = []; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) if (row && row.type === 'blob' && (!suffix || String(row.path).endsWith(suffix))) out.push(String(row.path));
    if (rows.length < 100) break;
  }
  return out;
}
export async function argonPackRender(agentId: string): Promise<{ text: string; files: number; tok: number; missing: string[] }> {
  const items = await argonPackLoad(agentId);
  if (!items.length) return { text: '', files: 0, tok: 0, missing: [] };
  const sorted = items.slice().sort((a, b) => (String(a.added_at) + a.path).localeCompare(String(b.added_at) + b.path));
  const blocks: string[] = []; const missing: string[] = []; let chars = 0;
  const got = await Promise.all(sorted.map((it) => argonGitlabRaw(it.project, it.path, it.ref).catch(() => ({ ok: false, status: 0, text: '' }))));
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i]; const g: any = got[i];
    if (!g.ok) { missing.push(it.path + ' (HTTP ' + g.status + ')'); continue; }
    if (argonPackTok(chars + g.text.length) > ARGON_PACK_BUDGET_TOK) { missing.push(it.path + ' (over the pack budget now that it grew)'); continue; }
    chars += g.text.length;
    blocks.push('=== ' + it.path + ' (' + it.project + '@' + it.ref + ') ===\n' + g.text);
  }
  const tok = argonPackTok(chars);
  const head = '=== PINNED CONTEXT [ARGON-PACK-V1]: ' + blocks.length + ' whole file(s), ~' + tok + ' tokens, pinned for this strain. '
    + 'You already have these files in full: answer from them directly and do NOT re-fetch them with tools. '
    + 'Each file starts at its own === path === line. Use pin_context / unpin_context / pack_status to change the pack. ===';
  const tail = (missing.length ? '\n(Pinned but not loaded this turn: ' + missing.join('; ') + ')' : '') + '\n=== END PINNED CONTEXT ===';
  if (missing.length) console.log('[chat/pack] agent=' + agentId + ' missing=' + missing.join('; '));
  console.log('[chat/pack] agent=' + agentId + ' files=' + blocks.length + ' approx_tokens=' + tok);
  return { text: head + '\n' + blocks.join('\n') + tail, files: blocks.length, tok: tok, missing: missing };
}
export function argonPackTools(agentId: string): HarChatTool[] {
  const status = async (): Promise<string> => {
    const items = await argonPackLoad(agentId);
    const tok = items.reduce((s, it) => s + argonPackTok(it.chars), 0);
    return JSON.stringify({ files: items.length, approx_tokens: tok, budget_tokens: ARGON_PACK_BUDGET_TOK,
      items: items.map((it) => ({ path: it.path, ref: it.ref, project: it.project, approx_tokens: argonPackTok(it.chars) })) }, null, 1);
  };
  return [
    {
      name: 'pin_context',
      description: 'Pin WHOLE files from GitLab into this strain\'s pinned context (Argon only). From the NEXT turn on, pinned files are loaded in full at the top of your context on every turn and billed at the cached rate after the first read -- use this instead of re-reading big files through gitlab_api. paths: file paths, or a directory ending in "/" to pin every file under it (filter with suffix, e.g. ".ts"). ref defaults to main, project to ' + ARGON_PACK_PROJECT + '. Budget: ' + ARGON_PACK_BUDGET_TOK + ' tokens for the whole pack; a pin that would exceed it is refused.',
      schema: { type: 'object', properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files, or directories ending in "/".' },
        ref: { type: 'string', description: 'Branch, tag or sha. Default main.' },
        project: { type: 'string', description: 'GitLab project path. Default ' + ARGON_PACK_PROJECT + '.' },
        suffix: { type: 'string', description: 'Only for directory pins: keep files ending with this, e.g. ".ts".' } }, required: ['paths'] },
      run: async (input: any) => {
        const project = String((input && input.project) || ARGON_PACK_PROJECT);
        const ref = String((input && input.ref) || 'main');
        const suffix = String((input && input.suffix) || '');
        const want: string[] = [];
        for (const p0 of ((input && Array.isArray(input.paths)) ? input.paths : [])) {
          const p = String(p0 || '').replace(/^\/+/, '');
          if (!p) continue;
          if (p.endsWith('/')) { for (const f of await argonGitlabTree(project, p, ref, suffix)) want.push(f); } else want.push(p);
        }
        if (!want.length) return 'Nothing to pin: no paths given, or the directory had no matching files.';
        const items = await argonPackLoad(agentId);
        let tok = items.reduce((s, it) => s + argonPackTok(it.chars), 0);
        const added: string[] = []; const refused: string[] = [];
        for (const path of want) {
          if (items.length >= ARGON_PACK_MAX_FILES) { refused.push(path + ': pack file limit ' + ARGON_PACK_MAX_FILES); continue; }
          const g = await argonGitlabRaw(project, path, ref);
          if (!g.ok) { refused.push(path + ': HTTP ' + g.status); continue; }
          if (argonLooksBinary(path, g.text)) { refused.push(path + ': binary'); continue; }
          const i = items.findIndex((it) => it.project === project && it.path === path && it.ref === ref);
          const prev = i >= 0 ? argonPackTok(items[i].chars) : 0;
          const t = argonPackTok(g.text.length);
          if (tok - prev + t > ARGON_PACK_BUDGET_TOK) { refused.push(path + ': would take the pack to ~' + (tok - prev + t) + ' tokens, over the ' + ARGON_PACK_BUDGET_TOK + ' budget'); continue; }
          const row: ArgonPin = { project: project, path: path, ref: ref, chars: g.text.length, added_at: i >= 0 ? items[i].added_at : new Date().toISOString() };
          if (i >= 0) items[i] = row; else items.push(row);
          tok = tok - prev + t; added.push(path + ' (~' + t + ' tok)');
        }
        if (added.length) await argonPackSave(agentId, items);
        return 'Pinned ' + added.length + ' file(s)' + (added.length ? ': ' + added.slice(0, 40).join(', ') + (added.length > 40 ? ' ...' : '') : '')
          + '. Pack is now ' + items.length + ' file(s), ~' + tok + ' of ' + ARGON_PACK_BUDGET_TOK + ' tokens.'
          + (refused.length ? ' Refused ' + refused.length + ': ' + refused.slice(0, 20).join('; ') + '.' : '')
          + ' They load in full from your NEXT turn; to use one in THIS turn, read it with gitlab_api.';
      },
    },
    {
      name: 'unpin_context',
      description: 'Remove files from this strain\'s pinned context. paths: exact paths or directory prefixes ending in "/"; or all=true to clear the pack.',
      schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } } },
      run: async (input: any) => {
        const items = await argonPackLoad(agentId);
        if (input && input.all) { await argonPackSave(agentId, []); return 'Cleared the pack (' + items.length + ' file(s) removed).'; }
        const ps: string[] = ((input && Array.isArray(input.paths)) ? input.paths : []).map((x: any) => String(x || '').replace(/^\/+/, '')).filter(Boolean);
        const keep = items.filter((it) => !ps.some((p) => p.endsWith('/') ? it.path.startsWith(p) : it.path === p));
        await argonPackSave(agentId, keep);
        return 'Removed ' + (items.length - keep.length) + ' file(s); ' + keep.length + ' remain.';
      },
    },
    { name: 'pack_status', description: 'List this strain\'s pinned context: files, approximate tokens each, total vs budget.', schema: { type: 'object', properties: {} }, run: async () => status() },
  ];
}
export async function argonGitlabSend(method: string, pathx: string, body: any): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const pat = await harSecretGet('gitlab-api-token');
  const init: any = { method: method, headers: { 'PRIVATE-TOKEN': pat || '' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r: any = await waFetch('http://127.0.0.1/gitlab/api/v4' + pathx, init);
  const t: string = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch (e) { j = null; }
  return { ok: !!r.ok, status: Number(r.status || 0), json: j, text: t };
}
