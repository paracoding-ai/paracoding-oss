// SPDX-License-Identifier: Apache-2.0
// [COLLECTIONS-V1] The keyed-collection layer, extracted from index.ts so feature modules can
// import the SAME accessors (cpkCol, geseCol, wiCol, ...) and the native-PG KV shim WITHOUT
// importing index.ts (no cycle). Every accessor is the Firestore CollectionReference shape, or
// its native-Postgres equivalent when the matching PC_KV_* / PC_*_STORE flag is on. Moved
// verbatim from index.ts; the only change is `db` now comes from ./store.js and the per-store
// shims are required as ../ (dist layout is dist/mods/collections.js).
import { db } from './store.js';

const _wipg: any = require('../work-items-pg');
const _chpg: any = require('../chat-history-pg');
const _kv: any = require('../kvdoc-pg');
const _tupg: any = require('../token-usage-pg');
const _vrppg: any = require('../vrp-pg');
const _spg: any = require('../strains-pg');
const _jpg: any = require('../journal-pg');
const _mpg: any = require('../memory-pg');

const _fl = (v: any): boolean => ['pg','native','1','true','on'].includes(String(v || '').toLowerCase());
const _WI = _fl(process.env.PC_WORKITEMS_STORE);
const _CH = _fl(process.env.PC_CHATHISTORY_STORE);
const _KVCFG = _fl(process.env.PC_KV_CONFIG);
const _KVMSG = _fl(process.env.PC_KV_MSG);
const _KVSESS = _fl(process.env.PC_KV_SESS);
const _KVCONF = _fl(process.env.PC_KV_CONFIRMS);
const _KVBUD = _fl(process.env.PC_KV_BUDGET);
const _TU = _fl(process.env.PC_TOKENUSAGE);
const _KVCHAT = _fl(process.env.PC_KV_CHAT);
const _KVEXEC = _fl(process.env.PC_KV_EXEC);
const _VRP = _fl(process.env.PC_VRP_STORE);
const _SSN = _fl(process.env.PC_STRAINS_STORE);
const _JN = _fl(process.env.PC_JOURNAL_STORE);
const _MN = _fl(process.env.PC_MEMORY_STORE);

const wiCol = (): any => _WI ? _wipg.col() : db.collection('work_items');
const chCol = (): any => _CH ? _chpg.col() : db.collection('chat_history');
const cfgCol = (): any => _KVCFG ? _kv.col('config') : db.collection('config');
const setCol = (): any => _KVCFG ? _kv.col('settings') : db.collection('settings');
const migCol = (): any => _KVCFG ? _kv.col('migrations') : db.collection('migrations');
const amCol = (): any => _KVMSG ? _kv.col('agent_messages') : db.collection('agent_messages');
const skCol = (): any => _KVSESS ? _kv.col('session_keys') : db.collection('session_keys');
const usCol = (): any => _KVSESS ? _kv.col('user_sessions') : db.collection('user_sessions');
const geseCol = (): any => _KVSESS ? _kv.col('ge_sessions') : db.collection('ge_sessions');
const srCol = (): any => _KVSESS ? _kv.col('session_revocations') : db.collection('session_revocations');
const opsCol = (): any => _KVSESS ? _kv.col('ops_session') : db.collection('ops_session');
const pcCol = (): any => _KVCONF ? _kv.col('pending_confirms') : db.collection('pending_confirms');
const opusCol = (): any => _KVBUD ? _kv.col('opus_budget') : db.collection('opus_budget');
const gemCol = (): any => _KVBUD ? _kv.col('gemini_budget') : db.collection('gemini_budget');
const geBudCol = (): any => _KVBUD ? _kv.col('ge_budget') : db.collection('ge_budget');
const tuCol = (): any => _TU ? _tupg.col('token_usage') : db.collection('token_usage');
const tuGapCol = (): any => _TU ? _tupg.col('token_usage_gaps') : db.collection('token_usage_gaps');
const cbjCol = (): any => _KVCHAT ? _kv.col('chat_build_jobs') : db.collection('chat_build_jobs');
const ctCol = (): any => _KVCHAT ? _kv.col('chat_turns') : db.collection('chat_turns');
const cpkCol = (): any => _KVCHAT ? _kv.col('chat_pack') : db.collection('chat_pack');
const pxCol = (): any => _KVEXEC ? _kv.col('pc_exec_ingest') : db.collection('pc_exec_ingest');

export {
  _WI,
  _wipg,
  _CH,
  _chpg,
  _fl,
  _KVCFG,
  _KVMSG,
  _KVSESS,
  _KVCONF,
  _kv,
  cfgCol,
  setCol,
  migCol,
  amCol,
  skCol,
  usCol,
  geseCol,
  srCol,
  opsCol,
  pcCol,
  _KVBUD,
  _TU,
  _tupg,
  opusCol,
  gemCol,
  geBudCol,
  tuCol,
  tuGapCol,
  _KVCHAT,
  _KVEXEC,
  cbjCol,
  ctCol,
  cpkCol,
  pxCol,
  _VRP,
  _vrppg,
  wiCol,
  chCol,
  _SSN, _spg, _JN, _jpg, _MN, _mpg
};
