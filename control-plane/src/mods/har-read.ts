// SPDX-License-Identifier: Apache-2.0
// [HAR-READ-V1] The identity-scoped read_journal and read_job_log harness tools, extracted from
// index.ts (strangler). These two are self-contained: they scope by the RAW agentId and read
// Firestore/pg only. The vault-coupled lake readers (harReadLake / harReadLakeTool) deliberately
// STAY in index.ts -- they are NOT moved here. Moved verbatim from index.ts; the only change is
// that _JN/_jpg/pcCol now come from ./collections.js and db from ./store.js instead of being
// index-local.
import { db } from './store.js';
import { _JN, _jpg, pcCol } from './collections.js';

export async function harReadJournalTool(input: any, agentId: string): Promise<string> {
  // [HARNESS-JOURNAL-WAS-UNPARTITIONED-2026-09-14] This was the ONE tool in
  // harRunChatTool that was never handed the caller's identity: every sibling
  // received `who` and this received only `input`, so it could not filter even in
  // principle and returned the WHOLE fleet's journal -- other strains' entries,
  // with their agent_id printed on every row. The MCP read_journal was partitioned
  // by strain on this branch while this path stayed wide open, which defeated the
  // point of the branch. Same paged scan as the MCP path, and for the same reason
  // it cannot be a where() clause: no composite index on strain + timestamp.
  // fleet-advisor keeps the fleet-wide view, mirroring the boss check already used
  // by harListItemsTool, and the header says which view you are looking at.
  //
  // [NO-FLEET-VIEW-FROM-A-DEFAULTED-IDENTITY-2026-09-14] harRunChatTool opens with
  // `const who = agentId || 'fleet-advisor'`. That default was inert while this tool
  // ignored identity; it stopped being inert the moment boss started deciding between
  // one strain's journal and the whole fleet's, because a blank agentId would resolve
  // to the console role and hand back everything. This tool therefore takes the RAW
  // agentId, not `who`, and REFUSES a blank one by name rather than falling back to
  // any identity at all. A widening fallback is never the safe direction.
  const strain = String(agentId || '').trim();
  if (!strain) return 'read_journal denied: no resolved identity on this session, so there is no strain to scope the journal to. This is deliberate -- a caller whose identity did not resolve must not be handed a fleet-wide journal by default.';
  const boss = agentId === 'fleet-advisor';
  const lim = Math.max(1, Math.min(60, Number((input && input.limit)) || 30));
  const HPAGE = 500;
  const HCEILING = 5000;
  try {
    let hcursor: any = null;
    let hscanned = 0;
    let hexhausted = false;
    const hrows: string[] = [];
    while (hrows.length < lim && hscanned < HCEILING) {
      let hq: any = _JN ? _jpg.pager(HPAGE) : db.collection('journal').orderBy('timestamp', 'desc').limit(HPAGE);
      if (hcursor) hq = hq.startAfter(hcursor);
      const hsnap = await hq.get();
      if (hsnap.empty) { hexhausted = true; break; }
      hscanned += hsnap.docs.length;
      hcursor = hsnap.docs[hsnap.docs.length - 1];
      for (const d of hsnap.docs) {
        if (hrows.length >= lim) break;
        const e = d.data() || {};
        const entryStrain = String(e.strain || e.agent_id || '');
        if (!boss && entryStrain !== agentId) continue;
        const ts = (e.timestamp && e.timestamp._seconds) ? e.timestamp._seconds : 0;
        const hh = ts ? new Date(ts * 1000).toISOString().slice(11, 19) : '--:--:--';
        hrows.push(hh + '  ' + String(e.agent_id || '') + '  [' + String(e.action || '') + ']  ' + String(e.message || '').slice(0, 180));
      }
      if (hsnap.docs.length < HPAGE) { hexhausted = true; break; }
    }
    const head = boss
      ? 'FLEET-WIDE JOURNAL -- EVERY STRAIN (console view, because you are fleet-advisor)'
      : 'YOUR JOURNAL -- ' + agentId + ' ONLY';
    const tail = (!hexhausted && hrows.length < lim)
      ? '\n(scan ceiling of ' + HCEILING + ' entries reached before ' + lim + ' were found -- a short list here does NOT mean there are no older entries)'
      : '';
    if (!hrows.length) return head + ': no entries in the ' + hscanned + ' most recent journal documents.' + tail;
    return head + ' (' + hrows.length + '):\n' + hrows.join('\n') + tail;
  } catch (e: any) { return 'read_journal failed: ' + String((e && e.message) || e); }
}

export async function harReadJobLogTool(input: any, agentId: string): Promise<string> {
  // [HARNESS-JOBLOG-WAS-UNIDENTIFIED-2026-09-14] The MCP twin of this tool already
  // WRITES THE RULE DOWN in its own description -- "You may read jobs YOU staged;
  // operator principals (LOG_READ_ALL) read everything" -- and enforces it at
  // index.ts:4096 under VERIFY-GREP F13-JOBLOG-OWNERSHIP-V1. This copy was handed no
  // identity at all, so it could not apply that rule even in principle and returned
  // any job's output to any caller. The policy is not invented here; it is copied
  // from the sibling that already ships it, so the two surfaces stop disagreeing.
  //
  // WHY THIS COPY STILL MATTERS THOUGH THE MCP ONE USUALLY ANSWERS. harChatToolset
  // registers the MCP registry first and its harOpsTools loop skips any name already
  // seen, so on a healthy build the MCP handler wins and this is unreachable. THE GATE
  // IS PER NAME, NOT PER BUILD: a tool that admission declines to register, or that
  // class-withholding removes, is simply absent from __pcTools and THIS twin attaches
  // in its place. That is an ordinary narrowing, not a failure mode -- so a check
  // missing here lapses exactly when the primary surface has already been reduced.
  //
  // RAW agentId, NOT a defaulted `who`: LOG_READ_ALL DEFAULTS TO 'fleet-advisor', so a
  // blank identity defaulted to that name would be read as the OPERATOR and handed
  // every strain's job output. Identical escalation shape to
  // [NO-FLEET-VIEW-FROM-A-DEFAULTED-IDENTITY-2026-09-14]; refused by name instead.
  const me = String(agentId || '').trim();
  if (!me) return 'read_job_log denied: no resolved identity on this session, and this tool will not default one. Job output is another principal\'s privileged data.';
  const id = String((input && (input.job_id || input.id)) || '').trim(); if (!id) return 'read_job_log: job_id required.';
  try {
    const d = await pcCol().doc(id).get(); if (!d.exists) return '(no job ' + id + ')';
    const x: any = d.data() || {};
    const OPS = String(process.env.LOG_READ_ALL || 'fleet-advisor').split(',').map((s: string) => s.trim()).filter(Boolean);
    const isOperator = OPS.indexOf('*') >= 0 || OPS.indexOf(me) >= 0;
    const stagedBy = String(x.staged_by || '');
    if (!isOperator && stagedBy !== me) {
      console.warn('[cp] F13-harness: ' + me + ' denied read_job_log on ' + id + ' (staged_by ' + (stagedBy || '(unset)') + ')');
      return 'not your job: ' + id + ' was staged by another principal. You can read the jobs you staged; ask the operator (or fleet-advisor) for this one.';
    }
    return 'JOB ' + id + '  status=' + String(x.status || '?') + '  exit=' + String(x.exit_code) + '\nSTDOUT:\n' + String(x.stdout || '(none)').slice(0, 6000) + '\nSTDERR:\n' + String(x.stderr || '(none)').slice(0, 1500);
  } catch (e: any) { return 'read_job_log failed: ' + String((e && e.message) || e); }
}
