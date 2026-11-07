// SPDX-License-Identifier: Apache-2.0
// [STORE-V1] The store singleton, extracted from index.ts so modules can import the SAME `db`
// handle and `FieldValue` WITHOUT importing index.ts (which would be a dependency cycle). The
// handle is a Firestore-compatible store backed by on-box Postgres (pg-fs) or Firestore,
// selected by PC_STORE. Creating it is import-safe — this is the original top-level
// `const db = pcMakeDb()`, which the PC_NO_LISTEN import-smoke already exercised, moved verbatim;
// nothing here connects eagerly. NOTE: dist layout is dist/mods/store.js, so pg-fs (dist/pg-fs.js)
// is required as '../pg-fs', not './pg-fs'.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue as _FBFieldValue } from 'firebase-admin/firestore';

// [PC-STORE-V1] data-store selector: firestore (default, prod-unchanged) | pg (on-box Postgres shim) | dual.
export const PC_STORE = String(process.env.PC_STORE || 'firestore').toLowerCase();
export const FieldValue: any = PC_STORE === 'firestore' ? _FBFieldValue : require('../pg-fs').FieldValue;

// The Firebase app must exist before getFirestore()/getStorage(); unchanged from index.ts.
if (getApps().length === 0) {
  initializeApp();
}

export function pcMakeDb(): any {
  const fsdb = getFirestore(process.env.PC_FIRESTORE_DB || '(default)');
  if (PC_STORE === 'firestore') return fsdb;
  const { DB } = require('../pg-fs');
  if (PC_STORE === 'pg') { console.log('[pc-store] active store = pg (on-box Postgres)'); return new DB(process.env.PC_PG_URL || ''); }
  if (PC_STORE === 'dual') throw new Error('[pc-store] dual mode not implemented yet (migration #160)');
  console.warn('[pc-store] unknown PC_STORE=' + PC_STORE + '; falling back to firestore'); return fsdb;
}
export const db: any = pcMakeDb();
