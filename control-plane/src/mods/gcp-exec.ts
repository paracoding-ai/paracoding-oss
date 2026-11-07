// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-GCPEXEC-V1] Extracted VERBATIM from control-plane/src/index.ts (strangler refactor).
// Two self-contained helpers whose dependencies all resolve without importing index.ts:
//   - harOpsToken: resolves the ops-box token to forward, gated on a LIVE ops window. Reads the
//     ops-window doc through opsGet/opsClear, imported from the work-tools sibling mod.
//   - harRootWithQuery: pure URL helper that collapses a request onto '/' without dropping its query.
// The GCP-exec backend proper (harGcpStage/harGcpApi) and the HTML-serving hood (harFlowHood) STAY
// in index.ts: harGcpStage reaches the index-only pcAdmitStage/pcAutoRun staging path, harGcpApi
// calls harGcpStage, and harFlowHood renders through the index-only waSessionOk / waSendLocked /
// harHarnessHtml / pcCanonicalHostRedirect serving helpers -- none importable here.
// Imports ONLY from sibling mods -- NEVER from '../index.js'.
import { opsGet, opsClear } from './work-tools.js';

// The harness silently re-mints a fresh ~1h Google token and pushes it here; we forward it to the box.
// Resolve the token to forward: a LIVE ops window is required first; then explicit header/body,
// else the live session token.
export async function harOpsToken(req: any): Promise<{ token: string; err?: string }> {
  const now = Date.now();
  const s = await opsGet();
  if (s && s.window_expiry && now > s.window_expiry) { await opsClear('window-expired'); return { token: '', err: 'ops window expired — re-off at the gate' }; }
  // F14: is a window actually live right now? Keyed on window_expiry ONLY - opsClear zeroes it,
  // and unlike a lingering revoked_at flag this can never wedge the window permanently closed.
  const live = !!(s && s.window_expiry && now <= s.window_expiry);
  let direct = '';
  try { direct = String((req.headers && (req.headers['x-user-token'] || req.headers['X-User-Token'])) || (req.body && req.body.token) || ''); } catch (e) {}
  // F14: a caller-supplied token used to be returned BEFORE any window check, so /api/ops/end
  // did not stop user-authed gcloud reaching the ops box. Refuse loudly, never silently downgrade.
  if (direct) { if (!live) return { token: '', err: 'ops window is closed — x-user-token ignored; unlock ops at the gate first' }; return { token: direct }; }
  if (live && s.token && s.token_expiry && now < s.token_expiry) return { token: String(s.token) };
  if (live && s.token) return { token: '', err: 'ops token stale — harness will refresh' };
  return { token: '' };   // no window, no token: box-authed (OPS_TOKEN) shell only, as today
}

// Collapse onto the root WITHOUT DROPPING THE QUERY. res.redirect('/') drops it, and a
// bookmarked or mailed console link may carry one; a redirect that eats the query lands the
// caller somewhere other than where the link pointed.
export function harRootWithQuery(req: any): string {
  const u = String((req && (req.originalUrl || req.url)) || '');
  const q = u.indexOf('?');
  return q < 0 ? '/' : ('/' + u.slice(q));
}
