// SPDX-License-Identifier: Apache-2.0
// [JOURNAL-V1] The fleet journal writer, extracted from index.ts so modules can journal without
// importing index.ts (cycle). harJournalAs appends one journal row through the db singleton; the
// TTL chokepoint applied to db in index.ts still stamps retention on this write at runtime. Moved
// verbatim — db + FieldValue come from ./store.js.
import { db, FieldValue } from './store.js';

export function harJournalAs(agentId: string, action: string, message: string) { try { db.collection('journal').add({ agent_id: agentId || 'fleet-advisor', action: action, message: String(message).slice(0, 900), timestamp: FieldValue.serverTimestamp() }); } catch (e) {} }
export function harJournal(action: string, message: string) { harJournalAs('fleet-advisor', action, message); }
