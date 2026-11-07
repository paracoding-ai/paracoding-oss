// SPDX-License-Identifier: Apache-2.0
// [STRANGLER-MOD-TOOLING-V1] Extracted from control-plane/src/index.ts.
// Tool-class policy (annotations + refusal stub) and the tool-output cap /
// lake-bound helpers. Every symbol here is pure: no db, no pcCol, no mcp
// registry, no index.ts internals. Definitions are verbatim from index.ts.
import * as crypto from 'crypto';

// ===== tool-class policy =====
export const PC_TOOL_CLASS: any = {
  git_read: 'read',
  git_list: 'read',
  git_log: 'read',
  git_diff: 'read',
  // [TOOL-SURFACE-V1] git_grep WAS ABSENT FROM THIS TABLE, AND THAT ABSENCE WITHHELD IT FROM
  // EVERY ROLE ON EVERY INSTALL. Counted: index.ts + gittools.ts + ghtools.ts register 63
  // distinct tool names; this table classified 62. The one unclassified name was git_grep, so
  // it fell to 'other' -- a class no strain document holds and pcNarrowClasses can never
  // produce -- and with PC_TOOLS_ENFORCE=1 (install.sh sets it on BOTH services) it was
  // unregistered for fleet-advisor, for the operator, for everyone. The only trace was the
  // token 'git_grep:other' buried in a tool_surface_withheld journal line nobody reads.
  // 'read' is the honest class and grants nothing new: git_grep searches the same refs that
  // git_read already serves whole files from, in one request instead of N.
  git_grep: 'read',
  // [PCGIT-ARCHIVE-TOOL-V1] 'read', and it grants nothing git_read does not: the archive is
  // the same reach in one request. GET /git/archive already gates its session-key branch on
  // this exact class, so classifying it any other way would let one path serve what the other
  // withholds. An unclassified tool falls to 'other' and would be withheld from every role.
  git_archive: 'read',
  // [CLAUDE-PLANNER-V135] 'read', AND THE CLASS IS LOAD-BEARING RATHER THAN COSMETIC.
  // pcToolAnnotations() below turns 'read' into readOnlyHint:true, and MEASURED 2026-09-07 on
  // Gemini Enterprise a readOnly tool runs with no Send/Cancel card while a 'write' or 'stage'
  // tool STOPS THE TURN until a human clicks. A planner the executor must ask permission to
  // consult is a planner nobody consults. 'read' is also the honest class: both tools take text
  // and return text, and neither touches the lake, the repository, the queue or the executor.
  claude_planner: 'read',
  claude_review: 'read',
  // [OPUS-COURSE-CORRECT-V148] claude_opus is 'read' for the same reason, with one difference
  // worth stating rather than hiding: unlike the two above it CAN be handed tools, so "returns
  // text" stays true and "takes only text" does not. What it is handed is the CALLER'S OWN
  // admitted surface filtered to this very class, so the annotation is not a claim about the
  // tool's manners -- it is the same claim the class makes everywhere, enforced by this table.
  claude_opus: 'read',
  // [GEMINI-ADVISOR-WAS-CLASS-OTHER-V1] gemini_advisor WAS REGISTERED AND UNREACHABLE BY EVERY
  // ROLE, INCLUDING THE THREE IT WAS ALLOWLISTED FOR, because it was never in this table.
  //
  // MEASURED 2026-09-12 from the operator's own chat, on a strain freshly added to
  // PC_GEMINI_ADVISOR_ROLES: the registration gate passed and the CLASS gate refused, verbatim --
  //     REFUSED: gemini_advisor is tool class other and this connection does not hold that class.
  // An unclassified name falls to 'other', a class no strain document holds and pcNarrowClasses
  // can never produce, so with PC_TOOLS_ENFORCE=1 it is withheld from everyone. Two gates, and
  // only one of them was ever set. This is the SAME defect [TOOL-SURFACE-V1] found on git_grep,
  // which was invisible on every install for the same reason, and it is silent both times: the
  // tool registers, boots, logs nothing, and simply cannot be called.
  //
  // 'read' is the honest class: the advisor runs a model over a read-only slice of the CALLER'S
  // OWN toolset and changes no fleet state. It does not widen reach -- geminiAdvisorTool() still
  // registers it only for PC_GEMINI_ADVISOR_ROLES, so BOTH gates must pass, and this only stops
  // the second one refusing what the first one allowed.
  gemini_advisor: 'read',
  gemini_planner: 'read',
  gemini_reviewer: 'read',
  git_propose: 'write',
  git_propose_patch: 'write',
  // [PCGIT-REPLACE-V1] 'write', and classifying it HERE is not optional: an unrecognised class
  // falls to 'other', which no strain document holds, so with PC_TOOLS_ENFORCE=1 the tool would
  // register on every boot and be withheld from every role -- exactly how git_grep was invisible
  // on every install until [TOOL-SURFACE-V1] found it.
  git_propose_replace: 'write',
  git_push: 'write',
  // [GH-TOOLS-V1] THE SAME TWO CLASSES AS THE git_* TOOLS, NOT A THIRD ONE, AND THE REASON IS
  // that a class no strain holds is a tool nobody can call. pcToolClasses() reads each strain's
  // recorded tool_classes, PC_TOOLS_ENFORCE ships 1 on a real install, and an unrecognised class
  // falls to 'other' and is withheld from every role -- so classifying these as 'github' would
  // have shipped ten tools that register for nobody until every strain document is rewritten.
  // Reading GitHub is a read and writing to it is a write; that is honest, and it works on the
  // install that already exists. A narrower class is a later change that has to move the strain
  // documents in the same commit, and it should not ride along with the feature landing.
  gh_whoami: 'read',
  gh_repos: 'read',
  gh_read: 'read',
  gh_list: 'read',
  gh_log: 'read',
  gh_diff: 'read',
  gh_commit: 'write',
  gh_branch: 'write',
  gh_fork: 'write',
  gh_pr: 'write',
  // [GH-RELEASE-V1] Both are 'write' and neither is 'infra'. They publish, which is a write to
  // a repository this install already holds a credential for -- the same class gh_commit has,
  // and the same blast radius. Leaving either UNCLASSIFIED is the TOOL-SURFACE-GITGREP defect
  // verbatim: PC_TOOLS_ENFORCE=1 withholds an unclassified name from every role including the
  // operator's, and the tool is then registered, invisible, and blamed on the wrong thing.
  gh_tag: 'write',
  gh_release: 'write',
  whoami: 'read',
  create_entities: 'write',
  create_relations: 'write',
  add_observations: 'write',
  delete_entities: 'write',
  delete_observations: 'write',
  delete_relations: 'write',
  read_graph: 'read',
  search_nodes: 'read',
  open_nodes: 'read',
  list_work_items: 'read',
  read_journal: 'read',
  list_pending_confirm: 'read',
  read_file: 'read',
  list_files: 'read',
  read_history: 'read',
  search_history: 'read',
  get_time: 'read',
  read_job_log: 'read',
  run_status: 'read',
  list_my_messages: 'read',
  check_answer: 'read',
  append_journal: 'write',
  post_work_item: 'write',
  complete_work_item: 'write',
  cancel_work_item: 'write',
  supersede_job: 'write',
  log_history: 'write',
  write_file: 'write',
  put_file: 'write',
  answer_message: 'write',
  ask_agent: 'write',
  refresh: 'write',
  stage_privileged_job: 'stage',
  run_command: 'stage',
  gcloud: 'stage',
  vmcp_sudo: 'stage',
  // [GE-DETERMINISTIC-DISPATCH-V1] 'stage', AND THE CLASS IS ABOUT THE ANNOTATION, NOT THE
  // REACH. Reach is already bounded by construction: the dispatcher resolves through
  // server.__pcTools, which holds exactly the tools the caller's role was admitted for, so it
  // can never exceed the caller's own surface. But pcToolAnnotations() derives readOnlyHint
  // from THIS table, and the claude_planner comment above records what that costs -- MEASURED
  // on Gemini Enterprise, a readOnly tool runs with no Send/Cancel card while a 'write' or
  // 'stage' tool STOPS THE TURN until a human clicks. A wrapper that can forward to
  // run_command must not be the thing that suppresses that card, so it takes the STRONGEST
  // class it can reach: holding it implies holding the strongest tool it could invoke.
  // Leaving it out was not neutral -- an unclassified name falls to 'other', which no strain
  // holds, so it registered on every boot and was withheld from everyone (see git_grep).
  deterministic_dispatch: 'stage',
  bq: 'infra',
  pg: 'infra',
  pg_load: 'infra',
  graph_api: 'infra',
  arm_api: 'infra',
  gcp_api: 'infra',
  gitlab_api: 'infra',
  run_roll: 'infra',
};

export const PC_TOOL_DESTRUCTIVE_WRITES = ['delete_entities', 'delete_observations', 'delete_relations', 'cancel_work_item', 'supersede_job'];

export const PC_TOOL_NOCARD_WRITES = ['post_work_item', 'complete_work_item', 'append_journal', 'add_observations'];

export const PC_NOCARD_EXEC = String(process.env.PC_NOCARD_EXEC || '0') === '1';

export const PC_NOCARD_ALL = String(process.env.PC_NOCARD_ALL || '0') === '1';

export function pcToolAnnotations(name: string): any {
  const klass = PC_TOOL_CLASS[name];
  // [GE-NOCARD-ALL-V147] FAIL-CLOSED FIRST, AND THE ORDER HERE IS LOAD-BEARING. An unclassified
  // name used to get `undefined` by falling all the way through every branch below. It now
  // returns EARLY and explicitly, so that the blanket return on the next line can never mark a
  // tool NOBODY CLASSIFIED as read-only. This line must stay ABOVE the flag. Moving it below is
  // how an unclassified tool -- the same 'other' class PC_TOOLS_ENFORCE withholds from every
  // role -- would start advertising itself as safe.
  if (!klass) return undefined;
  if (PC_NOCARD_ALL) return { readOnlyHint: true, destructiveHint: false };
  if (klass === 'read') return { readOnlyHint: true, destructiveHint: false };
  if (klass === 'write') {
    if (PC_TOOL_NOCARD_WRITES.indexOf(name) >= 0) return { readOnlyHint: true, destructiveHint: false };
    return { readOnlyHint: false, destructiveHint: PC_TOOL_DESTRUCTIVE_WRITES.indexOf(name) >= 0 };
  }
  if (klass === 'stage' || klass === 'infra') {
    if (PC_NOCARD_EXEC) return { readOnlyHint: true, destructiveHint: false };
    return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  }
  return undefined;
}

export function pcRefusalTool(name: string, klass: string, why: string, held: string[]): any {
  return async () => ({
    content: [{ type: 'text', text:
      'REFUSED: `' + name + '` is tool class `' + klass + '` and this connection does not hold that class.\n\n'
      + why + '\n\n'
      + 'Classes this connection holds: ' + (held.length ? held.join(', ') : '(none)') + '.\n'
      + 'THIS CALL DID NOTHING. The tool is LISTED so you can see the fleet has it and ask for the '
      + 'right credential; listing is not permission. Pass a session key that holds `' + klass
      + '` as the `agent` argument ON THE CALL -- it is the line beginning PC-SESSION-KEY in this '
      + 'chat bootstrap paste, and the operator mints one at the Flow Hood (Autoclave, New strain '
      + 'session). A role NAME is not a key and resolves to nothing. Do not retry this call '
      + 'unchanged; do not report the work as done.' }],
    isError: true
  });
}

// ===== tool-output result cap =====
export const PC_RESULT_MAX = 55555;

export const PC_RESULT_CAP_TAG = '[MCP-RESULT-CAP-V1]';

export const PC_RESULT_CAP_EXEMPT = new Set(['whoami', 'read_file', 'git_read']);

export const PC_RESULT_CAP_TAIL = new Set(['read_history']);

export function pcCapArgNames(spec: any): string[] {
  const shape: any = spec && spec.inputSchema;
  if (!shape || typeof shape !== 'object') return [];
  return Object.keys(shape).filter((k: string) => k !== 'agent');
}

export function pcCapNote(toolName: string, argNames: string[], shown: number, total: number, keptTail: boolean): string {
  const pct = Math.round((shown / total) * 1000) / 10;
  const hasLimit = argNames.indexOf('limit') >= 0;
  const how = argNames.length
    ? ((hasLimit ? 'pass a SMALLER limit, or narrow with ' : 'narrow the call with ')
       + argNames.join(', ') + ', then call again.')
    : ('this tool takes no narrowing arguments, so the rest is not reachable from here -- '
       + 'tell the operator, who can raise PC_RESULT_MAX in control-plane/src/index.ts.');
  // The marker names WHICH END SURVIVED. 'a prefix' and 'a suffix' are different
  // facts about what is missing, and an agent that reads the wrong one draws the
  // wrong conclusion about whether it has the latest state or the earliest.
  const kept = keptTail ? 'THIS IS THE END OF THE RESULT, NOT THE WHOLE OF IT'
                        : 'THIS IS A PREFIX, NOT THE RESULT';
  const edge = keptTail
    ? 'THE TEXT BELOW STARTS MID-VALUE, and the OLDEST entries were cut. It is NOT valid JSON,\nit is NOT the whole list, and the number of entries visible is NOT the number that exist.'
    : 'THE TEXT ABOVE STOPS MID-VALUE, and the entries after the cut are gone. It is NOT valid\nJSON, it is NOT the whole list, and the number of entries visible is NOT the number that exist.';
  // [PCGIT-DIFF-CAP-V1] TWO EXTRA LINES FOR THE GIT READERS, AND THE SECOND ONE IS THE
  // IMPORTANT ONE. git_diff is not on PC_RESULT_CAP_EXEMPT and must not be: a whole-tree
  // diff is unbounded, and exempting it would let a single call return megabytes, which is
  // the failure this cap exists to prevent. But its own payload carries "truncated": false,
  // and that flag describes gitDiff's CHANGE LIST -- it is set before this cap is applied
  // and knows nothing about it. An agent that reads it after a byte cut concludes it holds
  // a complete diff when it holds a fragment that does not even parse. So the marker
  // contradicts the flag by name, and points at the tool that returns a whole tree in one
  // request instead of leaving the caller to page a diff that has no pager.
  const gitAdvice = (toolName === 'git_diff' || toolName === 'git_log' || toolName === 'git_list')
    ? ('IGNORE ANY "truncated": false IN THE PAYLOAD ABOVE -- that flag describes ' + toolName
       + "'s own\nchange list and is written BEFORE this byte cap is applied. It does not know "
       + 'about this cut.\nFOR A WHOLE TREE, USE git_archive: it returns the entire repository at a ref as one\n'
       + 'tarball over HTTP and is not subject to this cap. Rebuilding a tree out of capped diffs\n'
       + 'is the exact waste git_archive exists to end.\n')
    : '';
  const body = '======== ' + PC_RESULT_CAP_TAG + ' TRUNCATED -- ' + kept + ' ========\n'
    + 'tool: ' + toolName + '\n'
    + 'shown: ' + shown + ' of ' + total + ' characters (' + pct + '%); '
    + (total - shown) + ' characters were CUT from the ' + (keptTail ? 'START' : 'END') + '.\n'
    + edge + '\n'
    + 'Do not parse it, do not count it, and do not report what it contains as complete.\n'
    + 'TO GET THE REST: ' + how + '\n'
    + 'There is no cursor or offset on this surface: fleet tools narrow by FILTER, not by page.\n'
    + gitAdvice
    + '======== END ' + PC_RESULT_CAP_TAG + ' ========';
  return keptTail ? (body + '\n\n') : ('\n\n' + body);
}

export function pcCapResult(toolName: string, argNames: string[], out: any): any {
  if (!out || typeof out !== 'object' || !Array.isArray(out.content)) return out;
  const items: any[] = out.content;
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const b: any = items[i];
    if (b && b.type === 'text' && typeof b.text === 'string') total += b.text.length;
  }
  if (total <= PC_RESULT_MAX) return out;
  // TAIL TOOLS TAKE A SEPARATE, SIMPLER PATH. Walking blocks from the end to spend
  // the same budget backwards would be the symmetric version of the loop below, and
  // every tool in this set today returns exactly ONE text block, so the general
  // machinery would be untested generality guarding a case that does not arise.
  // Joining and cutting once is the whole behaviour, and it is right for any block
  // count: the LAST PC_RESULT_MAX characters of the result are the last characters
  // whatever produced them.
  if (PC_RESULT_CAP_TAIL.has(toolName)) {
    const joined = items.map((b: any) =>
      (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('');
    let tail = joined.slice(joined.length - PC_RESULT_MAX);
    // Never START on a lone LOW surrogate (0xDC00-0xDFFF) -- the mirror of the
    // high-surrogate rule below, and the only cut that would change the BYTES of a
    // surviving character. charCodeAt, not a regex, for the reason given there.
    const _tc = tail.charCodeAt(0);
    if (_tc >= 0xDC00 && _tc <= 0xDFFF) tail = tail.slice(1);
    console.warn('[cp] ' + PC_RESULT_CAP_TAG + ' ' + toolName + ' produced ' + total
      + ' characters; served the LAST ' + tail.length + ' and marked the cut in-band.');
    return { ...out, content: [{ type: 'text',
      text: pcCapNote(toolName, argNames, tail.length, total, true) + tail }] };
  }
  const blocks: any[] = [];
  let shown = 0;
  let alreadyCut = false;
  for (let i = 0; i < items.length; i++) {
    const b: any = items[i];
    if (!b || b.type !== 'text' || typeof b.text !== 'string') { blocks.push(b); continue; }
    if (alreadyCut) {
      blocks.push({ ...b, text: PC_RESULT_CAP_TAG + ' content block ' + i
        + ' was dropped WHOLE: the result budget was already spent by the blocks above.' });
      continue;
    }
    const room = PC_RESULT_MAX - shown;
    if (b.text.length <= room) { shown += b.text.length; blocks.push(b); continue; }
    let head = b.text.slice(0, room);
    // Never end on a lone HIGH surrogate (0xD800-0xDBFF). That is the one cut that
    // would change the BYTES of a character that survives, rather than only how many
    // survive. Written as a charCodeAt comparison and not a regex on purpose: a
    // backslash-u escape in this file has to survive being copied through a patch, a
    // code review and a model's own emission to get here, and it does not always. A
    // number cannot be silently decoded into the character it names.
    const _hc = head.charCodeAt(head.length - 1);
    if (_hc >= 0xD800 && _hc <= 0xDBFF) head = head.slice(0, head.length - 1);
    shown += head.length;
    blocks.push({ ...b, text: head + pcCapNote(toolName, argNames, shown, total, false) });
    alreadyCut = true;
  }
  console.warn('[cp] ' + PC_RESULT_CAP_TAG + ' ' + toolName + ' produced ' + total
    + ' characters; served ' + shown + ' and marked the cut in-band.');
  return { ...out, content: blocks };
}

export function pcCapWrap(name: string, spec: any, handler: any): any {
  if (PC_RESULT_CAP_EXEMPT.has(name)) return handler;
  const argNames = pcCapArgNames(spec);
  return async (...a: any[]) => {
    const capped = await pcCapResult(name, argNames, await handler(...a));
    // [MCP-COMPACT-UNIFY-V1] Unify the MCP connector cap on harCompactToolOut (head+tail, env
    // HAR_TOOL_OUT_CAP) instead of the head-only pcCapResult cut, so the error/log tail survives
    // and oversized tool results stop being re-sent whole. Reuses the ONE compaction helper.
    if (capped && typeof capped === 'object' && Array.isArray(capped.content)) {
      return { ...capped, content: capped.content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string') ? { ...b, text: harCompactToolOut(name, b.text) } : b) };
    }
    return capped;
  };
}

// ===== lake read/put bounds =====
export const PC_LAKE_READ_MAX = 175000;

export function pcLakeReadRefusal(path: string, chars: number): string | null {
  if (chars <= PC_LAKE_READ_MAX) return null;
  return 'FILE_TOO_LARGE: ' + path + ' is ' + chars + ' characters, over the '
    + PC_LAKE_READ_MAX + '-character read_file bound. Contents were NOT returned and NOT '
    + 'truncated: a truncated read fed back through the read-whole/edit-whole/write-whole '
    + 'loop would write the prefix over the lake object and destroy it. The file is intact. '
    + 'Split the artifact, or move the bytes with a staged job instead of reading them into '
    + 'a model context.';
}

export const PC_LAKE_PUT_MAX = 40000;

export function pcPutFileDecode(b64: any, sha256: any): { buf?: Buffer; err?: string } {
  const raw = String(b64 == null ? '' : b64).replace(/\s+/g, '');
  const norm = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const buf = Buffer.from(norm, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== norm) {
    return { err: 'BAD_BASE64: base64_data is not valid base64 -- re-encoding the decoded bytes does not '
      + 'reproduce the payload, which means a character was dropped, substituted, or is not in the '
      + 'base64 alphabet. Nothing was written. Re-encode the file and send it again, or move the '
      + 'bytes over HTTP instead (see put_file\'s size refusal for the route).' };
  }
  if (buf.length > PC_LAKE_PUT_MAX) {
    return { err: 'PAYLOAD_TOO_LARGE: base64_data decodes to ' + buf.length + ' bytes, over the '
      + PC_LAKE_PUT_MAX.toLocaleString('en-US') + ' bytes decoded bound on put_file. Nothing was written. A payload this '
      + 'size is retyped by a model and arrives corrupt (measured), so move the bytes without a '
      + 'model in the path: POST /git/blob with your session key as an HTTP Bearer header '
      + '(Authorization: Bearer <session key>) and the raw bytes as the body '
      + '(Content-Type: application/octet-stream), then git_propose with '
      + 'uploaded: { blob_oid, sha256 } from that response -- the bytes never cross a model.' };
  }
  if (sha256 !== undefined && sha256 !== null && sha256 !== '') {
    const want = String(sha256).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) {
      return { err: 'BAD_SHA256: sha256 must be 64 hex characters, got ' + JSON.stringify(String(sha256))
        + '. Nothing was written.' };
    }
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== want) {
      return { err: 'SHA256_MISMATCH: the decoded payload hashes to ' + got + ' but sha256 says ' + want
        + '. The bytes that arrived are not the bytes you meant to send. Nothing was written.' };
    }
  }
  return { buf: buf };
}

// ===== tool-output compaction (chat substrates) =====
export const HAR_TOOL_OUT_CAP = Math.max(1000, Number(process.env.HAR_TOOL_OUT_CAP || 6000) || 6000);

export const HAR_TOOL_OUT_CAP_GEMINI = Math.max(6000, Number(process.env.HAR_TOOL_OUT_CAP_GEMINI || 120000) || 120000);

export function harCompactToolOut(name: string, out: string, exempt?: Set<string>, capOverride?: number): string {
  const s = String(out == null ? '' : out);
  if (exempt && exempt.has(String(name))) return s;
  const capBase = (name === 'git_grep' || name === 'git_read' || name === 'git_diff' || name === 'spawn_subagents') ? 35000 : HAR_TOOL_OUT_CAP;
  const cap = capOverride ? Math.max(capOverride, capBase) : capBase;
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.62);
  const tail = cap - head;
  const elided = s.length - head - tail;
  return s.slice(0, head) + '\n...[' + elided + ' chars elided to save cost -- head+tail kept]...\n' + s.slice(s.length - tail);
}

