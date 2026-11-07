// SPDX-License-Identifier: Apache-2.0
// [MOD-SECRETS-KEYS-V1] Strangler extraction from index.ts: the Secret Manager REST surface
// (read + allowlisted write) and the chat-provider key helpers. These depend only on shared
// transport (waFetch/waAccessToken) and PC_PROJECT, never on the Firestore `db`/collection
// helpers -- so harKeyAge/setHarKeyAge (which touch setCol/FieldValue) deliberately stay in
// index.ts. This module never reaches back into the monolith (no cycle).
import { waFetch, waAccessToken, PC_PROJECT } from '../shared.js';

const HAR_PROJECT = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PC_PROJECT;
const PC_GH_SECRET_PREFIX = (process.env.PC_GH_SECRET_PREFIX || 'github-token-');

export async function harSecretGet(name: string): Promise<string | null> {
  const tok = await waAccessToken();
  const r = await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets/' + name + '/versions/latest:access', { headers: { Authorization: 'Bearer ' + tok } });
  // [SEC-LOUD-FALLBACK-V140] THIS null USED TO BE INDISTINGUISHABLE FROM 'THE SECRET IS NOT
  // THERE', AND THAT COST A NIGHT. MEASURED 2026-09-07: an operator principal without
  // Secret Manager permission ran a lookup, got 403 PERMISSION_DENIED, saw a bare null, and
  // reported to the human that NO KEY WAS STORED. The key was stored and in use at that
  // moment; the human had to correct it from memory of his own billing. A 403 and a 404 mean
  // opposite things -- 'you may not look' versus 'there is nothing there' -- and collapsing
  // both to null throws away the only bit that distinguishes a permissions bug from a
  // provisioning gap.
  // THE RETURN TYPE DOES NOT CHANGE. Callers branch on null and stay correct; the status goes
  // to the log, where the next person looking at an empty result can see which of the two
  // they are holding. Only the STATUS and the secret NAME are printed -- never the body,
  // never the token: 'never echo, log, or write the key' is not relaxed by this.
  if (!r || !r.ok) {
    const _st = Number((r && r.status) || 0);
    console.error('[harSecretGet] ' + name + ' -> null, http=' + (_st || 'no-response')
      + (_st === 403 ? ' PERMISSION_DENIED: this principal may not read the secret. THE SECRET MAY WELL EXIST -- do not report it as missing.'
        : (_st === 404 ? ' NOT_FOUND: no such secret or no enabled version.'
          : ' unexpected status; treat as unknown, not as absent.')));
    return null;
  }
  const j: any = await r.json();
  try { return Buffer.from(j.payload.data, 'base64').toString('utf8'); } catch (e: any) {
    // A 200 whose payload will not decode is a MALFORMED SECRET, not an absent one, and it is
    // the one case here that should never happen quietly.
    console.error('[harSecretGet] ' + name + ' -> null: HTTP 200 but the payload did not decode.'
      + ' reason=' + String((e && e.message) || e));
    return null;
  }
}

const PC_GH_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function pcGhSecretName(slug: string): string { return PC_GH_SECRET_PREFIX + slug; }
export function pcSecretWriteRefusal(name: string): string | null {
  if (/^chat-key-(claude|gemini|deepseek)$/.test(name)) return null;
  // Anchored on BOTH ends: the prefix must match exactly and what follows must be a whole slug.
  // A startsWith() test alone would admit <prefix>../chat-key-claude, which is the leak the
  // sabotaged-list test in this commit's sibling proved a prefix-only rule lets through.
  if (name.startsWith(PC_GH_SECRET_PREFIX)
      && PC_GH_SLUG_RE.test(name.slice(PC_GH_SECRET_PREFIX.length))) return null;
  return 'REFUSED: this service does not write the secret "' + name + '". Secret writes are '
    + 'restricted to an explicit allowlist -- the chat API keys and ' + PC_GH_SECRET_PREFIX
    + '<identity> -- so that no route, present or future, can overwrite a key this install '
    + 'cannot regenerate. Nothing was sent to Secret Manager.';
}

export async function harSecretSet(name: string, value: string): Promise<boolean> {
  return (await harSecretSetX(name, value)).ok;
}
// [SEC-SECRETWRITE-REASON-V1] The reason travels back. harSecretSet returned a bare boolean and
// threw the Secret Manager response away, so the console could only say "could not write the token
// to Secret Manager" -- which is what it said to the operator, and it cost a diagnostic job to
// learn the real answer was PERMISSION_DENIED on secrets.create. A failure report that names no
// cause is the same defect as a check that cannot fail: it looks like diligence and carries no
// information.
export async function harSecretSetX(name: string, value: string): Promise<{ ok: boolean; detail?: string }> {
  const refusal = pcSecretWriteRefusal(name);
  if (refusal) { console.error('[secret] ' + refusal); return { ok: false, detail: refusal }; }
  const tok = await waAccessToken();
  // ensure secret exists (ignore 409 already-exists)
  // [DEEPSEEK-SECRET-CREATE-V2] Log create failures loudly. The old code discarded the create
  // response entirely. If the SA lacks secretmanager.secrets.create, the create silently 403s,
  // the addVersion 404s, and the caller gets { ok: false } with no clue why. Now logged.
  const createR = await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets?secretId=' + encodeURIComponent(name), {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  if (createR && !createR.ok && createR.status !== 409) {
    let cd = 'create secret ' + name + ': HTTP ' + createR.status;
    try { const j: any = await createR.json(); if (j && j.error && j.error.message) cd += ' -- ' + j.error.message; } catch (_e) {}
    console.error('[secret] ' + cd);
  }
  const r = await waFetch('https://secretmanager.googleapis.com/v1/projects/' + HAR_PROJECT + '/secrets/' + name + ':addVersion', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
  });
  if (r && r.ok) return { ok: true };
  let detail = 'HTTP ' + (r ? r.status : '?');
  try { const j: any = await r.json(); if (j && j.error && j.error.message) detail += ': ' + j.error.message; } catch (_e) { /* keep the status */ }
  console.error('[secret] write of ' + name + ' failed -- ' + detail);
  return { ok: false, detail };
}

export function harKeyName(provider: string): string { return provider === 'gemini' ? 'chat-key-gemini' : provider === 'deepseek' ? 'chat-key-deepseek' : 'chat-key-claude'; }
export async function harKey(provider: string): Promise<string> {
  const env = provider === 'gemini' ? process.env.GEMINI_API_KEY : provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (env) return env;
  const sm = await harSecretGet(harKeyName(provider));
  if (sm) return sm;
  // DeepSeek has no Vertex fallback -- a key is always required.
  return provider === 'gemini' ? 'vertex' : '';
}

export async function disableOldClaudeKey(oldKey: string) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY || await harSecretGet('anthropic-admin-key');
  if (!adminKey) return;
  try {
    const r = await waFetch('https://api.anthropic.com/v1/organizations/keys', {
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }
    });
    if (!r.ok) return;
    const j: any = await r.json();
    const hit = (j.data || []).find((k: any) => oldKey.startsWith(k.workspace_key_prefix || k.id) || k.id);
    if (hit) {
      await waFetch(`https://api.anthropic.com/v1/organizations/keys/${hit.id}/disable`, {
        method: 'POST',
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    }
  } catch (e) {}
}
