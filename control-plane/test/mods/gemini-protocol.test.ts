// SPDX-License-Identifier: Apache-2.0
// Unit tests for mods/gemini-protocol.ts -- the PURE ge* tool-protocol helpers extracted from
// index.ts. No cloud, no network, no db: every function here depends only on its arguments,
// builtins and PC_TOOL_CLASS (imported from tooling.ts). Driven directly, no stubs needed.
process.env.PC_NO_LISTEN = '1';

type Tool = { name: string; description: string; schema: any; run: (i: any) => Promise<string> };
const T = (name: string, description = '', schema: any = {}): Tool =>
  ({ name, description, schema, run: async () => '' });

(async () => {
  const G: any = await import('../../src/mods/gemini-protocol.js');

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.error('  FAIL ' + label + (detail ? '\n        ' + detail : ''));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, JSON.stringify(got) === JSON.stringify(want),
      'got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
  }

  // ---- geArgList ----
  eq('geArgList empty schema', G.geArgList({}), '');
  eq('geArgList required star + type + agent dropped',
    G.geArgList({ properties: { path: { type: 'string' }, agent: { type: 'string' }, n: { type: 'number' } }, required: ['path'] }),
    'path:string*, n:number');
  eq('geArgList array<string> + enum',
    G.geArgList({ properties: { q: { type: 'array', items: { type: 'string' } }, mode: { enum: ['a', 'b'] } } }),
    'q:array<string>, mode:enum');

  // ---- geFrames ----
  eq('geFrames two objects', G.geFrames('{"tool":"a"} junk {"tool":"b"}').length, 2);
  eq('geFrames brace inside string survives', G.geFrames('{"s":"a}b{c"}')[0].s, 'a}b{c');
  eq('geFrames ignores malformed', G.geFrames('{not json} {"ok":1}').length >= 1, true);
  eq('geFrames none', G.geFrames('no objects here'), []);

  // ---- geFindToolCall: last tool-bearing object wins ----
  eq('geFindToolCall last wins', G.geFindToolCall('{"tool":"first"} {"tool":"second","args":{"x":1}}'),
    { name: 'second', args: { x: 1 } });
  eq('geFindToolCall none -> null', G.geFindToolCall('plain prose'), null);

  // ---- geResolveTool ----
  const ts = [T('whoami'), T('git_read'), T('git_grep')];
  eq('geResolveTool exact', G.geResolveTool('git_read', ts), 'git_read');
  eq('geResolveTool normalised', G.geResolveTool('GIT-READ', ts), 'git_read');
  eq('geResolveTool skill-prefixed suffix', G.geResolveTool('1p-skill-custom-mcp-1378631450286785655-whoami', ts), 'whoami');
  eq('geResolveTool unknown -> null', G.geResolveTool('browse_web', ts), null);

  // ---- geFindToolCalls: resolve + dedupe + batch cap ----
  eq('geFindToolCalls resolved only, deduped',
    G.geFindToolCalls('{"tool":"git_read","args":{"p":"a"}} {"tool":"git_read","args":{"p":"a"}} {"tool":"nope"} {"tool":"whoami"}', ts),
    [{ name: 'git_read', args: { p: 'a' } }, { name: 'whoami', args: {} }]);
  const many = Array.from({ length: 20 }, (_, i) => '{"tool":"git_read","args":{"p":"' + i + '"}}').join(' ');
  ok('geFindToolCalls respects GE_BATCH_MAX', G.geFindToolCalls(many, ts).length <= G.GE_BATCH_MAX);
  eq('GE_BATCH_MAX default', G.GE_BATCH_MAX, 8);

  // ---- geIsReadOnly (reads PC_TOOL_CLASS) ----
  eq('geIsReadOnly git_read', G.geIsReadOnly('git_read'), true);
  eq('geIsReadOnly git_push', G.geIsReadOnly('git_push'), false);
  eq('geIsReadOnly unknown', G.geIsReadOnly('made_up_tool'), false);

  // ---- geKwargs ----
  eq('geKwargs json passthrough', G.geKwargs('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
  eq('geKwargs kwargs form', G.geKwargs('x="hi", y=3, z=true'), { x: 'hi', y: 3, z: true });
  eq('geKwargs empty', G.geKwargs(''), {});

  // ---- geNativeToolCall ----
  eq('geNativeToolCall call: form', G.geNativeToolCall('call:default_api:whoami{}', ts), { name: 'whoami', args: {} });
  eq('geNativeToolCall default_api. form', G.geNativeToolCall('default_api.git_read(path="a")', ts),
    { name: 'git_read', args: { path: 'a' } });
  eq('geNativeToolCall unresolved -> null', G.geNativeToolCall('call:default_api:nope{}', ts), null);
  eq('geNativeToolCall plain prose -> null', G.geNativeToolCall('I might call a function later', ts), null);

  // ---- gePathsAsked (path shape) ----
  eq('gePathsAsked caps tail', G.gePathsAsked('what is in oss/VERSION on main?'), ['oss/VERSION']);
  ok('gePathsAsked dotted deep path', G.gePathsAsked('open control-plane/src/index.ts').indexOf('control-plane/src/index.ts') >= 0);
  eq('gePathsAsked prose pair rejected', G.gePathsAsked('the cluster/fleet split'), []);
  eq('gePathsAsked url rejected', G.gePathsAsked('see https://example.com/a/b'), []);

  // ---- gePathClaims (claim vs intent) ----
  eq('gePathClaims content claim', G.gePathClaims('oss/VERSION contains 14.1'), ['oss/VERSION']);
  eq('gePathClaims question is not a claim', G.gePathClaims('shall I read oss/VERSION?'), []);
  eq('gePathClaims intent is not a claim', G.gePathClaims('I will read oss/VERSION next'), []);

  // ---- geNarratedACall ----
  eq('geNarratedACall narration true', G.geNarratedACall('I will call git_read to check.'), true);
  eq('geNarratedACall result false', G.geNarratedACall('The file holds 14.1.'), false);

  // ---- geDeniedATool ----
  eq('geDeniedATool tool denied', G.geDeniedATool('The `git_grep` tool is not available to me.', ts), 'git_grep');
  eq('geDeniedATool file missing is not a tool denial', G.geDeniedATool('I ran git_read and the file is not available at that ref.', ts), null);
  eq('geDeniedATool unoffered capability', G.geDeniedATool('I cannot browse the web.', ts), null);

  // ---- geClaimedFleetWork ----
  eq('geClaimedFleetWork completed voice', G.geClaimedFleetWork('I ran git_read and found the value.', ts), true);
  eq('geClaimedFleetWork tool-name-returned', G.geClaimedFleetWork('The git_grep tool returned 3 matches.', ts), true);
  eq('geClaimedFleetWork question not a claim', G.geClaimedFleetWork('Shall I run git_read for you?', ts), false);
  eq('geClaimedFleetWork honest admission', G.geClaimedFleetWork('I did not call any tool this turn.', ts), false);

  // ---- geRetryAfterMs ----
  const r = { headers: { get: (k: string) => (k === 'retry-after' ? '5' : null) } };
  eq('geRetryAfterMs header wins', G.geRetryAfterMs(r, '', 0), 5000);
  eq('geRetryAfterMs body retryDelay', G.geRetryAfterMs({}, '{"error":{"details":[{"retryDelay":"3s"}]}}', 0), 3250);
  eq('geRetryAfterMs exponential fallback', G.geRetryAfterMs({}, 'no delay', 2), 8000);
  ok('geRetryAfterMs capped at 90s', G.geRetryAfterMs({ headers: { get: () => '9999' } }, '', 0) === 90000);

  // ---- geDescribe (budget) ----
  const short = G.geDescribe(T('whoami', 'who you are', { properties: { agent: {} } }), 1000);
  ok('geDescribe short keeps full text', short.indexOf('who you are') >= 0 && short.indexOf('[...]') < 0);
  const long = G.geDescribe(T('big', 'x'.repeat(500), {}), 100);
  ok('geDescribe over-budget truncates with marker', long.indexOf('[...]') >= 0 && long.length < 200);

  // ---- geFamilyNotes ----
  ok('geFamilyNotes fires when git_ and gh_ both present',
    G.geFamilyNotes([T('git_read'), T('gh_read')]).join('\n').indexOf('EASY TO CONFUSE') >= 0);
  eq('geFamilyNotes silent without collision', G.geFamilyNotes([T('whoami')]), []);

  // ---- geToolProtocol + geBrief ----
  const proto = G.geToolProtocol([T('whoami', 'who you are'), T('git_read', 'read a file')]);
  ok('geToolProtocol names tool count', proto.indexOf('TOOLS AVAILABLE TO YOU (2)') >= 0);
  ok('geToolProtocol lists tool names', proto.indexOf('whoami') >= 0 && proto.indexOf('git_read') >= 0);
  ok('geBrief opens with its header', G.geBrief('advisor', [T('whoami')]).indexOf('BEFORE THE OPERATOR SPEAKS') >= 0);
  ok('geBrief mentions delegation only when ask_agent present',
    G.geBrief('advisor', [T('ask_agent')]).indexOf('DELEGATE') >= 0 &&
    G.geBrief('advisor', [T('whoami')]).indexOf('DELEGATE') < 0);

  console.error('');
  console.error(fail === 0 ? 'ALL ' + pass + ' ASSERTIONS PASS' : pass + ' pass, ' + fail + ' FAIL');
  process.exit(fail === 0 ? 0 : 1);
})();
