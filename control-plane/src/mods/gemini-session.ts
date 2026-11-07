// SPDX-License-Identifier: Apache-2.0
// [GEMINI-SESSION-V1] Gemini Enterprise per-seat session store and daily query meter, extracted
// from index.ts (strangler). The geSessions Map is a per-instance cache in front of the durable
// ge_sessions collection; the meter counts seat/pool queries per Pacific day in ge_budget. Moved
// verbatim from index.ts. Module-private: the geSessions cache and PC_GE_SESSION_TTL_MS; the
// cluster-only helper gePacificDay is kept exported (index re-exports it). oaTokHash, GE_SEATS and
// GE_QUERIES_PER_SEAT were promoted to ../shared (pure, also used by code remaining in index);
// geseCol/geBudCol come from ./collections and FieldValue from ./store.
import { FieldValue } from './store.js';
import { geseCol, geBudCol } from './collections.js';
import { oaTokHash, GE_QUERIES_PER_SEAT, GE_SEATS } from '../shared.js';

const geSessions: Map<string, string> = new Map();   // chat thread -> GE session name
// [GE-SESSION-DURABLE-V1] THE MAP IS A CACHE NOW, NOT THE RECORD.
// MEASURED SHAPE OF THE BUG: geSessions was process memory on a service that runs at
// maxInstanceCount 20. One person never notices, because one person's turns usually land on
// one warm instance. Two people do: a turn lands on instance A, the next on instance B with
// no session, GE opens a FRESH conversation, and the seat answers the second turn with no
// memory of the first. It reads as the model being stupid rather than as the session being
// lost, which is the worst kind of bug to hand a new user on their first day. A cold start
// loses every session at once, for everybody.
//
// SAME KEY, SAME SEMANTICS, DURABLE STORE. The key is unchanged -- 'ge:' + seat + '|' + strain,
// built at the call site -- so the per-person scoping [GE-SEAT-MULTIUSER-V1] established is
// carried through exactly as it was. The Map stays in front as a per-instance cache, so a warm
// instance still costs no read and Firestore is consulted only on a miss.
//
// A LOST SESSION IS NOT AN ERROR. Every failure here degrades to 'no session', which is the
// same state a first turn is in: GE opens a new one. So a Firestore hiccup costs a
// conversation's history and never a turn, and nothing downstream needs a new failure path.
//
// THE KEY IS HASHED INTO THE DOCUMENT ID because it carries the seat holder's email, and a
// document id is not a place to put one.
const PC_GE_SESSION_TTL_MS = Math.max(60000, Number(process.env.PC_GE_SESSION_TTL_MS || (7 * 24 * 3600 * 1000)));
export function geSessionDoc(key: string): string { return oaTokHash(key); }
export async function geSessionLoad(key: string): Promise<string> {
  const hit = String(geSessions.get(key) || '');
  if (hit) return hit;
  try {
    const d = await geseCol().doc(geSessionDoc(key)).get();
    const v: any = d.exists ? (d.data() || {}) : null;
    if (v && v.session && Number(v.exp || 0) > Date.now()) {
      const s = String(v.session);
      geSessions.set(key, s);
      return s;
    }
  } catch (e) {}
  return '';
}
export function geSessionSave(key: string, session: string): void {
  if (!session) return;
  geSessions.set(key, session);
  const now = Date.now();
  geseCol().doc(geSessionDoc(key)).set({ session: session,
    at: now, exp: now + PC_GE_SESSION_TTL_MS,
    expireAt: new Date(now + PC_GE_SESSION_TTL_MS + 86400000) }).catch(() => {});
}
export function geSessionDrop(key: string): void {
  geSessions.delete(key);
  geseCol().doc(geSessionDoc(key)).delete().catch(() => {});
}
export function gePacificDay(at?: Date): string {
  const d = at || new Date();
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  } catch (e) { /* fall through to the fixed-offset form below */ }
  // FALLBACK FOR A SMALL-ICU RUNTIME, where the time zone above silently resolves to UTC. A fixed
  // -08:00 is an hour off during daylight time, so the boundary moves by an hour twice a year --
  // it never loses or duplicates a day, and a meter that is an hour early beats one that throws.
  return new Date(d.getTime() - 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function geMeterPct(a: number, b: number): number {
  return b > 0 ? Math.round((a / b) * 100) : 0;
}

export function geMeterLine(day: string, poolUsed: number, mineUsed: number): string {
  const pool = GE_QUERIES_PER_SEAT * GE_SEATS;
  return 'seat queries ' + day + ' Pacific -- you ' + mineUsed + '/' + GE_QUERIES_PER_SEAT
    + ' (' + geMeterPct(mineUsed, GE_QUERIES_PER_SEAT) + '%), pool ' + poolUsed + '/' + pool
    + ' (' + geMeterPct(poolUsed, pool) + '%) across ' + GE_SEATS + ' seat'
    + (GE_SEATS === 1 ? '' : 's');
}
export function geMeterKey(agentId: string): string {
  return (String(agentId || 'anon').replace(/[^A-Za-z0-9_-]/g, '_') || 'anon');
}
export async function geMeterRead(agentId: string): Promise<{ day: string; pool: number; mine: number }> {
  const day = gePacificDay();
  try {
    const snap: any = await geBudCol().doc(day).get();
    const v: any = ((snap && snap.exists) ? snap.data() : {}) || {};
    const by: any = v.by_agent || {};
    return { day, pool: Number(v.queries || 0), mine: Number(by[geMeterKey(agentId)] || 0) };
  } catch (e) { return { day, pool: 0, mine: 0 }; }
}

// ONE WRITE PER TURN, NOT ONE PER ROUND. A 24-round turn would otherwise make 24 Firestore writes
// to the same document and contend with itself; the round count is known when the turn ends.
export async function geMeterAdd(agentId: string, n: number): Promise<void> {
  if (!(n > 0)) return;
  const day = gePacificDay();
  try {
    await geBudCol().doc(day).set({
      day: day,
      queries: FieldValue.increment(n),
      by_agent: { [geMeterKey(agentId)]: FieldValue.increment(n) },
    }, { merge: true });
  } catch (e) { /* the meter must never be able to fail a turn */ }
}
