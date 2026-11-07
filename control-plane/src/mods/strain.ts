// SPDX-License-Identifier: Apache-2.0
// [STRAIN-V1] strainList: read the strains registry (optionally active-only), from native
// Postgres (_SSN) or Firestore. Extracted from index.ts so modules (a2a agent cards, rosters)
// can read the registry without importing index.ts. Moved verbatim — db from ./store.js,
// _SSN/_spg from ./collections.js. (strainSeedIfEmpty stays in index: boot-only, const-coupled.)
import { db } from './store.js';
import { _SSN, _spg } from './collections.js';

export async function strainList(activeOnly: boolean): Promise<any[]> {
  if (_SSN) { try { return await _spg.list(activeOnly); } catch (e) { return []; } }
  try { const s = await db.collection('strains').get(); let rows = s.docs.map((d: any) => d.data()); if (activeOnly) rows = rows.filter((r: any) => r && r.status === 'active'); return rows; } catch (e) { return []; }
}
