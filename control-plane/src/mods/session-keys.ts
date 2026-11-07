// SPDX-License-Identifier: Apache-2.0
// [ROLE-KEYWORD-V1] Session-key role helpers, extracted from index.ts (strangler).
// slNormRole/slResolveRole are the pure+registry-read half of the keyword->role->key path:
// they resolve a human keyword to a real, PASTEABLE strain role. They import ONLY a sibling
// mod (strainList from ./strain.js) and nothing from ../index.js. The minting/caching half
// (slGetOrMintRoleKey, slMintSessionKey) and the revocation-epoch state (pcRevokeEpoch*)
// stay in index.ts: they are coupled to index-only helpers (oaGet/oaSet/oaRand/pcSessionLookup)
// and to shared mutable caches (pcSessCache / pcRevEpoch*), which this module must not import.
import { strainList } from './strain.js';

export function slNormRole(x: string): string {
  // lowercase, drop spaces/dashes/underscores, strip a leading "fleet" so the ugly backend doc id
  // (fleet-advisor) and the human name (advisor) collapse to the same token.
  return String(x || '').toLowerCase().replace(/[\s_-]+/g, '').replace(/^fleet/, '');
}
// The FIXED SET is the live strains registry itself: you add to it by creating a strain, exactly
// as today. Only PASTEABLE+active strains are nameable -- the same gate POST /api/sessions/mint
// enforces, so fleet-onboarder/breakglass can never be named this way.
export async function slResolveRole(keyword: string): Promise<{ role?: string; error?: string }> {
  const nk = slNormRole(keyword);
  if (!nk) return { error: 'empty role keyword' };
  let rows: any[] = [];
  try { rows = await strainList(true); } catch (e) { return { error: 'strain registry unreadable' }; }
  const hits: string[] = [];
  for (const r of rows) {
    if (!r || r.pasteable !== true) continue;
    const role = String(r.role || '');
    if (!role) continue;
    if (slNormRole(role) === nk || slNormRole(String(r.display_name || '')) === nk) hits.push(role);
  }
  const uniq = Array.from(new Set(hits));
  if (uniq.length === 1) return { role: uniq[0] };
  if (uniq.length === 0) return { error: 'no pasteable strain matches "' + String(keyword).slice(0, 40) + '" (create the strain first, or mark it pasteable)' };
  return { error: 'ambiguous keyword "' + String(keyword).slice(0, 40) + '": matches ' + uniq.join(', ') };
}
