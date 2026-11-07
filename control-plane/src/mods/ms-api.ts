// SPDX-License-Identifier: Apache-2.0
// [MS-API-V1] Microsoft Graph + Azure ARM callers for the identity / RBAC PoC tracks. App-only
// (client-credentials) auth: mint an app token for the requested audience, call the host, and
// return {status, headers, body} VERBATIM -- a 403 is a result, not an error. Host-locked
// (graph.microsoft.com / management.azure.com only), tenant/subscription-capped, ONE request per
// call. App creds live in Secret Manager as `entra-app-<app_ref>` = JSON
// {client_id, client_secret, tenant_id, subscriptions?}; they are NEVER echoed or journalled.
import { waFetch } from '../shared.js';
import { harSecretGet } from './secrets-keys.js';

function _entraSecretName(appRef: string): string {
  const r = String(appRef || process.env.ENTRA_DEFAULT_APP || 'default').toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  return 'entra-app-' + (r || 'default');
}
async function _entraApp(appRef: string): Promise<{ client_id: string; client_secret: string; tenant_id: string; subscriptions?: string[] }> {
  const name = _entraSecretName(appRef);
  const raw = await harSecretGet(name);
  if (!raw) throw new Error('ms-api: secret "' + name + '" is not set. Create it in Secret Manager as JSON {"client_id":"..","client_secret":"..","tenant_id":".."[,"subscriptions":["<subId>"]]} for the app registration, then retry.');
  let j: any; try { j = JSON.parse(raw); } catch (e) { throw new Error('ms-api: secret "' + name + '" is not valid JSON (want {client_id,client_secret,tenant_id})'); }
  if (!j || !j.client_id || !j.client_secret || !j.tenant_id) throw new Error('ms-api: secret "' + name + '" must contain client_id, client_secret and tenant_id');
  return j;
}
async function _token(app: any, scope: string): Promise<string> {
  const url = 'https://login.microsoftonline.com/' + encodeURIComponent(app.tenant_id) + '/oauth2/v2.0/token';
  const form = 'client_id=' + encodeURIComponent(app.client_id) + '&client_secret=' + encodeURIComponent(app.client_secret)
    + '&grant_type=client_credentials&scope=' + encodeURIComponent(scope);
  const r: any = await waFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const t: string = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch (e) {}
  if (!r || !r.ok || !j || !j.access_token) throw new Error('ms-api: token request failed (HTTP ' + (r && r.status) + '): ' + String((j && (j.error_description || j.error)) || t).slice(0, 300));
  return j.access_token;
}
function _hdrs(r: any): any { const o: any = {}; try { if (r && r.headers && r.headers.forEach) r.headers.forEach((v: string, k: string) => { o[k] = v; }); } catch (e) {} return o; }
async function _call(method: string, url: string, token: string, body: any): Promise<any> {
  const m = String(method || 'GET').toUpperCase();
  const opts: any = { method: m, headers: { Authorization: 'Bearer ' + token } };
  if (body !== undefined && body !== null && m !== 'GET' && m !== 'DELETE') { opts.headers['Content-Type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r: any = await waFetch(url, opts);
  const txt: string = await r.text();
  let parsed: any = txt; try { parsed = txt ? JSON.parse(txt) : null; } catch (e) { parsed = txt; }
  return { status: Number((r && r.status) || 0), headers: _hdrs(r), body: parsed };
}

// graph.microsoft.com, app token, audience graph/.default. tenant (optional) must equal the app's.
export async function harGraphApi(method: string, path: string, version: string, body: any, tenant: string, appRef: string): Promise<any> {
  const p = String(path || '');
  if (/:\/\//.test(p) || p.indexOf('//') === 0) throw new Error('graph_api: path must be a Graph path (e.g. /applications/{id}/federatedIdentityCredentials), not a full URL');
  const app = await _entraApp(appRef);
  if (tenant && String(tenant) !== String(app.tenant_id)) throw new Error('graph_api: tenant "' + tenant + '" is not the configured tenant for app "' + (appRef || 'default') + '" (hard-capped to ' + app.tenant_id + ')');
  const v = (String(version || 'v1.0').toLowerCase() === 'beta') ? 'beta' : 'v1.0';
  const clean = ('/' + p.replace(/^\/+/, '')).replace(/^\/(v1\.0|beta)(\/|$)/i, '/');
  const url = 'https://graph.microsoft.com/' + v + (clean === '/' ? '' : clean);
  const token = await _token(app, 'https://graph.microsoft.com/.default');
  return await _call(method, url, token, body);
}

// management.azure.com, app token, audience arm/.default. api_version required. Subscription in the
// path is capped to the app's configured subscriptions allowlist (when the secret declares one).
export async function harArmApi(method: string, path: string, apiVersion: string, body: any, appRef: string): Promise<any> {
  const p = String(path || '');
  if (/:\/\//.test(p) || p.indexOf('//') === 0) throw new Error('arm_api: path must be an ARM path (e.g. /subscriptions/<id>/resourceGroups/...), not a full URL');
  if (!apiVersion) throw new Error('arm_api: api_version is required (ARM demands ?api-version=)');
  const app = await _entraApp(appRef);
  const clean = '/' + p.replace(/^\/+/, '');
  const subInPath = (clean.match(/\/subscriptions\/([0-9a-fA-F-]{36})/) || [])[1];
  if (subInPath && Array.isArray(app.subscriptions) && app.subscriptions.length && app.subscriptions.indexOf(subInPath) < 0) {
    throw new Error('arm_api: subscription ' + subInPath + ' is not in the configured subscriptions for app "' + (appRef || 'default') + '" (allowed: ' + app.subscriptions.join(', ') + ')');
  }
  const sep = clean.indexOf('?') >= 0 ? '&' : '?';
  const url = 'https://management.azure.com' + clean + sep + 'api-version=' + encodeURIComponent(apiVersion);
  const token = await _token(app, 'https://management.azure.com/.default');
  return await _call(method, url, token, body);
}
