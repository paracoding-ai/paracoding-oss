// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-WIKI-V1] Extracted VERBATIM from control-plane/src/index.ts (strangler refactor).
// The gittools-backed freshness resolver (wikiGitOid) plus the completion-evidence gate and the
// complete_work_item tool handler (pcCompletionEvidence / harCompleteItemTool). The require path
// for the bundled-beside-index file is written as '../gittools.js' (not a beside-index path) because a
// module lives at dist/mods/*.js, one level below dist/gittools.js -- the standard mod adjustment.
// Imports shared primitives ONLY from '../shared.js' and sibling mods -- NEVER from '../index.js'.
// NOTE: wikiWatchVerdict / wikiFreshness / wikiServe stay in index.ts -- they read the lake through
// the vault-coupled, index-only harReadLake, which cannot be imported here.
import { db, FieldValue } from './store.js';
import { pcCol, wiCol, _MN, _mpg } from './collections.js';
import { harJournalAs } from './journal.js';
import { harOwns } from './work-tools.js';
import { pcLakeBucket } from '../shared.js';
import { getStorage } from 'firebase-admin/storage';
import { lakeBucket } from './lake-local.js';

let wikiOidFn: any = null;
// Deliberately NOT wrapped in a catch that only logs. If gittools.js did not build or did not export
// the resolver, every git: watch must fail LOUDLY into RED, never quietly into GREEN.
export function wikiGitOid(): any {
  if (wikiOidFn === null) {
    const gt = require('../gittools.js');
    wikiOidFn = (gt && gt.gitBlobOid) || false;
  }
  if (typeof wikiOidFn !== 'function') throw new Error('gitBlobOid is not exported by gittools.js -- git: watches cannot be resolved');
  return wikiOidFn;
}

// [WORKITEM-EVIDENCE-V164] ONE GATE, BOTH DOORS. complete_work_item is registered twice -- once
// as an MCP tool and once in the harness chat's own table -- and a gate on one of them is not a
// gate, it is a detour sign. Both call this.
//
// MEASURED 2026-09-07: an agent reported six review items complete, with per-item "Actions
// Taken" prose, and none of it had happened: no commit beyond the operator's own, no strain
// document changed, all six still pending. A human found it by reading git_log and the
// work_items collection by hand. Nothing in the system objected, because closing an item took
// nothing but the word for it -- while OPENING one already demanded cited evidence.
//
// WHY AN OID AND NOT A REVIEWER. claude_review takes { plan, evidence } and both are strings the
// agent composes, so an agent that fabricates a completion fabricates the evidence too and the
// reviewer answers OK to a fiction. A reviewer handed self-reported input can catch internal
// inconsistency and never a tool call that never happened. THE SERVER does this lookup, against
// the real object store, so the one thing an agent cannot do is make a commit exist that does not.
//
// 'none' IS A REAL ANSWER, NOT A BYPASS. Measurements, negative results and junk items close
// without a commit and always will. It costs a reason of substance, it is stored on the item as
// completion_evidence.kind='none', and it is named in the journal line -- so the escape is a
// decision somebody can go and read, which a silent default never is.
//
// [WORKITEM-NONE-CATEGORY-V190] "none" WAS A CHARACTER COUNT, AND A CHARACTER COUNT IS NOT A
// CHECK. MEASURED 2026-09-09: KabOeNTAhlOckLjNoneX -- "pcgit cannot clone", the largest open
// engineering item on the fleet -- was closed with the reason "Finished the upload-pack half
// as requested." Forty-three characters, so it passed, and it is false: there is no POST
// /git/git-upload-pack at main, and the closing session made no git tool call before closing.
// The commit door had already been shut properly -- the SERVER resolves the oid, so a
// fabricated hash refuses -- and this was the door standing open beside it, which made it the
// cheapest way on the fleet to close an item nobody did.
//
// THE FIX IS NOT A LIE DETECTOR. A word filter over free prose either misses the lie or refuses
// an honest negative result that happens to contain the word "implemented". Instead the reason
// must NAME WHICH OF THE LEGITIMATE CASES IT IS. Every case 'none' was designed for -- a
// measurement, a negative result, a duplicate, an obsolete item, a decision not to do it --
// describes work that produced NO ARTIFACT, and each has a token below. The claim that "a
// completion has no token it can honestly take" was falsified on 2026-09-13: fleet-ge-chat
// closed work item ppg5zjQXozzczU1obOqn -- an unbuilt seven-workstream programme -- by taking
// MEASURED:, which passed because reading a document is in plain English a measurement. A
// MEASURED: closure must therefore name where the measurement is written down, resolved
// server-side against one of three stores: a graph observation id, a lake file path, or a job id.
// Closing an item you did not do is no longer a matter of typing
// twenty characters: it is a second, explicit, STORED claim about the KIND of closure, written
// onto the item and into the journal line where a sweep can find it and read it back by kind.
// "Finished the upload-pack half as requested." is refused outright, because it names no kind.
const PC_NONE_KINDS = ['MEASURED', 'NEGATIVE', 'DUPLICATE', 'OBSOLETE', 'NOT-DOING'];
export async function pcCompletionEvidence(evidenceOid: any, reason: any, closingRole?: string): Promise<any> {
  const claimed = String(evidenceOid == null ? '' : evidenceOid).trim();
  if (!claimed) {
    return { ok: false, refusal: 'REFUSED: evidence_oid is required and NOTHING was closed. Pass'
      + ' the 40-hex oid of the commit that carries this work -- the server resolves it here, so a'
      + ' commit that does not exist refuses the close. If this item honestly has no commit, pass'
      + ' evidence_oid:"none" and a reason that OPENS with one of ' + PC_NONE_KINDS.join(': ')
      + ': followed by at least 20 more characters saying what was established instead.' };
  }
  if (claimed.toLowerCase() === 'none') {
    const raw = String(reason == null ? '' : reason).trim();
    const m = raw.match(/^([A-Z][A-Z-]{2,15}):([\s\S]*)$/);
    const cat = m ? String(m[1]) : '';
    const body = m ? String(m[2] || '').trim() : '';
    if (!m || PC_NONE_KINDS.indexOf(cat) < 0) {
      return { ok: false, refusal: 'REFUSED and NOTHING was closed: an evidence_oid:"none" reason'
        + ' must OPEN with one of ' + PC_NONE_KINDS.join(': ') + ': followed by what was'
        + ' established. "none" asserts that this work produced NO ARTIFACT, and those are the'
        + ' only ways that is true -- so if the work DID produce something it produced a commit:'
        + ' push it and close with the oid. This is not a formatting rule. The kind is stored on'
        + ' the item and named in the journal line, so every no-commit closure can be read back'
        + ' and audited by kind, and a completion has no kind it can honestly take.'
        + ' Got ' + JSON.stringify(raw.slice(0, 80)) + '.' };
    }
    if (body.length < 20) {
      return { ok: false, refusal: 'REFUSED and NOTHING was closed: "' + cat + ':" needs at least'
        + ' 20 characters after the colon. The reason is what a reader sees INSTEAD of a commit,'
        + ' so it has to say what was actually established.' };
    }
    if (cat === 'DUPLICATE' && !/\b[A-Za-z0-9]{20}\b/.test(body)) {
      return { ok: false, refusal: 'REFUSED and NOTHING was closed: "DUPLICATE:" must name the id'
        + ' of the item this duplicates. A duplicate that names nothing cannot be checked by'
        + ' anyone, which makes it the same unverifiable claim this gate exists to refuse.' };
    }
    if (cat === 'MEASURED') {
      let resolved = false;
      const lakeMatches = body.match(/(?:gs:\/\/[a-zA-Z0-9_.-]+\/)?((?:shared|agents\/[a-zA-Z0-9_.-]+)\/[^\s,;:"'<>]+)/g) || [];
      for (const m of lakeMatches) {
        const cleanPath = m.replace(/^gs:\/\/[^\/]+\//, '').replace(/^\/+/, '');
        try {
          // [SEC-LAKE-NOGUESS-V1] blessed handle form: pcLakeBucket() throws when the lake is
          // unconfigured, caught here, so this fails closed. Written inline (not via a local)
          // so the release gate can see it is one of the two sanctioned lake handles.
          const [ex] = await lakeBucket().file(cleanPath).exists();
          if (ex) { resolved = true; break; }
        } catch (e) {}
      }
      if (!resolved) {
        const jobMatches = body.match(/\b(gcp_[0-9a-f]{12})\b/g)
          || body.match(/(?:job:?\s*|\b)([A-Za-z0-9_-]{15,30})\b/g) || [];
        for (const jm of jobMatches) {
          const jid = jm.replace(/^job:?\s*/i, '').trim();
          try {
            const d = await pcCol().doc(jid).get();
            if (d.exists) { resolved = true; break; }
          } catch (e) {}
        }
      }
      if (!resolved) {
        const obsMatches = body.match(/(?:obs(?:ervation)?:?\s*|\b)([A-Za-z0-9]{20})\b/g) || [];
        if (obsMatches.length > 0) {
          try {
            if (_MN) {
              for (const om of obsMatches) {
                const oid = om.replace(/^obs(?:ervation)?:?\s*/i, '').trim();
                if (await _mpg.obsExistsAnywhere(oid)) { resolved = true; break; }
              }
            } else {
            const snap = await db.collectionGroup('observations').get();
            const validIds = new Set(snap.docs.map((d: any) => d.id));
            for (const om of obsMatches) {
              const oid = om.replace(/^obs(?:ervation)?:?\s*/i, '').trim();
              if (validIds.has(oid)) { resolved = true; break; }
            }
            }
          } catch (e) {}
        }
      }
      if (!resolved) {
        return { ok: false, refusal: 'REFUSED and NOTHING was closed: "MEASURED:" must name where the'
          + ' measurement is written down, and the server must go and look it up. Acceptable records'
          + ' are: (1) a graph observation id from add_observations, (2) a lake file path under shared/'
          + ' or agents/ from write_file, or (3) a job id from stage_privileged_job. None of those'
          + ' records could be resolved in the underlying store from the provided reason. A measurement'
          + ' that is written down nowhere is not a measurement -- it is a reading, and a reading closes nothing.' };
      }
    }
    return { ok: true, evidence: { kind: 'none', category: cat, reason: body },
      line: 'evidence=none/' + cat + ': ' + body.slice(0, 140) };
  }
  if (!/^[0-9a-f]{40}$/.test(claimed)) {
    return { ok: false, refusal: 'REFUSED: evidence_oid must be a 40-character lowercase hex commit'
      + ' oid, or the literal "none" with a reason. Got ' + JSON.stringify(claimed.slice(0, 64))
      + '. NOTHING was closed. A branch name, a tag or an abbreviated oid is not accepted here:'
      + ' the point is to name one immutable commit, not something that can move afterwards.' };
  }
  try {
    const gt = require('../gittools.js');
    if (typeof gt.gitResolveCommitForEvidence !== 'function') throw new Error('gittools.js does not export gitResolveCommitForEvidence');
    const cm: any = await gt.gitResolveCommitForEvidence(claimed);
    const closer = String(closingRole || '').trim().toLowerCase();
    const commitAuthor = String(cm.author || '').trim().toLowerCase();
    if (closer && commitAuthor && closer !== commitAuthor) {
      const why = String(reason == null ? '' : reason).trim();
      if (why.length < 20) {
        return { ok: false, refusal: 'REFUSED: closing role "' + closingRole + '" does not match commit author "' + cm.author + '". You must supply a reason of at least 20 characters explaining why you are completing this item with another person\'s commit.' };
      }
    }
    return { ok: true,
      evidence: { kind: 'commit', oid: cm.oid, tree: cm.tree, subject: cm.subject, author: cm.author, timestamp: cm.timestamp, paths: cm.paths || [] },
      line: 'evidence=' + String(cm.oid).slice(0, 12) + ' "' + String(cm.subject || '').slice(0, 100) + '"' };
  } catch (e: any) {
    return { ok: false, refusal: 'REFUSED: ' + claimed + ' does not resolve to a commit in this'
      + ' repository, so NOTHING was closed. ' + String((e && e.message) || e).slice(0, 200)
      + ' -- push the work first, then close the item with the oid the push returned.' };
  }
}

export async function harCompleteItemTool(input: any, agentId: string): Promise<string> {
  const id = String((input && input.id) || '').trim(); if (!id) return 'complete: id required.';
  if (!(await harOwns(id, agentId))) return 'complete denied: ' + id + ' is not in your lane.';
  const ev: any = await pcCompletionEvidence(input && input.evidence_oid, input && input.reason, agentId);
  if (!ev.ok) return ev.refusal;
  try { await wiCol().doc(id).update({ status: 'completed', completed_by: agentId, finished_at: FieldValue.serverTimestamp(), completion_evidence: ev.evidence, result_note: String((input && input.note) || '') }); harJournalAs(agentId, 'work_completed', 'completed ' + id + ' [' + ev.line + '] ' + String((input && input.note) || '')); return 'completed work item ' + id + ' -- ' + ev.line; } catch (e: any) { return 'complete failed: ' + String((e && e.message) || e); }
}
