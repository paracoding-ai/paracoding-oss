// SPDX-License-Identifier: Apache-2.0
// Unit tests for mods/gcp-api.ts. No cloud, no network, no emulator, no server boot.
//
// shared.ts captures waFetch = globalThis.fetch at MODULE LOAD, so the fetch stub MUST be installed
// BEFORE the module (and shared.ts) is imported -- hence the dynamic import() below, after the stub
// is in place. HAR_PROJECT is read from process.env.GCP_PROJECT at module load too, so we pin it
// first. The pure predicates (host/danger/blessed, the secret-destroy preflight, harBqParseTable)
// are driven directly; the BigQuery fns go through the stubbed fetch and we assert the PARSING; the
// pg fns run against a hand-patched pool so nothing ever opens a socket.
process.env.PC_NO_LISTEN = '1';
process.env.GCP_PROJECT = 'test-proj';
process.env.PC_PG_URL = process.env.PC_PG_URL || '';

function resp(body: any, ok = true): any {
  return {
    ok, status: ok ? 200 : 500,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}
let bqRunBody: any = null;
let bqInsertBody: any = null;
(globalThis as any).fetch = async (u: string, _init?: any): Promise<any> => {
  const url = String(u);
  if (url.indexOf('/instance/service-accounts/default/token') >= 0) return resp({ access_token: 'test-token' });
  if (url.indexOf('/insertAll') >= 0) return resp(bqInsertBody);
  if (url.indexOf('/bigquery/v2/') >= 0 && url.indexOf('/queries') >= 0) return resp(bqRunBody);
  return resp({});
};

(async () => {
  const g: any = await import('../../src/mods/gcp-api.js');

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.log('  FAIL ' + label + (detail ? '\n        ' + detail : ''));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, got === want, 'got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
  }

  // ---- harGcpHostOk ----
  ok('hostOk: googleapis https', g.harGcpHostOk('https://compute.googleapis.com/x') === true);
  ok('hostOk: bare googleapis.com https', g.harGcpHostOk('https://googleapis.com/x') === true);
  ok('hostOk: http rejected', g.harGcpHostOk('http://compute.googleapis.com/x') === false);
  ok('hostOk: non-googleapis rejected', g.harGcpHostOk('https://evil.com/x') === false);
  ok('hostOk: suffix-spoof rejected', g.harGcpHostOk('https://googleapis.com.evil.com/x') === false);
  ok('hostOk: garbage rejected', g.harGcpHostOk('not a url') === false);

  // ---- harGcpDanger ----
  ok('danger: DELETE', g.harGcpDanger('DELETE', 'https://compute.googleapis.com/a') === true);
  ok('danger: POST', g.harGcpDanger('POST', 'https://compute.googleapis.com/a') === true);
  ok('danger: PATCH', g.harGcpDanger('PATCH', 'https://compute.googleapis.com/a') === true);
  ok('danger: GET plain read is safe', g.harGcpDanger('GET', 'https://compute.googleapis.com/compute/v1/projects/p/zones') === false);
  ok('danger: GET on /secrets/ is dangerous', g.harGcpDanger('GET', 'https://secretmanager.googleapis.com/v1/projects/p/secrets/x') === true);
  ok('danger: GET :setIamPolicy is dangerous', g.harGcpDanger('GET', 'https://x.googleapis.com/a:setIamPolicy') === true);
  ok('danger: GET :generateAccessToken is dangerous', g.harGcpDanger('GET', 'https://iamcredentials.googleapis.com/v1/x:generateAccessToken') === true);

  // ---- harGcpBlessedDirect (HAR_PROJECT == test-proj) ----
  ok('blessed: GET compute project read', g.harGcpBlessedDirect('GET', 'https://compute.googleapis.com/compute/v1/projects/test-proj/zones') === true);
  ok('blessed: GET run v2 project read', g.harGcpBlessedDirect('GET', 'https://run.googleapis.com/v2/projects/test-proj/services') === true);
  ok('blessed: POST never blessed', g.harGcpBlessedDirect('POST', 'https://compute.googleapis.com/compute/v1/projects/test-proj/zones') === false);
  ok('blessed: other project not blessed', g.harGcpBlessedDirect('GET', 'https://compute.googleapis.com/compute/v1/projects/other-proj/zones') === false);
  ok('blessed: non-listed host not blessed', g.harGcpBlessedDirect('GET', 'https://bigquery.googleapis.com/bigquery/v2/projects/test-proj/x') === false);

  // ---- secret-destroy preflight ----
  const destroyCmd = 'gcloud secrets delete ad-free-key --quiet';
  ok('preflight: looksLike delete', g.pcLooksLikeSecretDestroy(destroyCmd) === true);
  ok('preflight: refuses bare destroy', typeof g.pcSecretDestroyRefusal(destroyCmd) === 'string');
  ok('preflight: refusal names the token', String(g.pcSecretDestroyRefusal(destroyCmd)).indexOf('secret-destroy-preflight.py') >= 0);
  const guarded = 'python3 secret-destroy-preflight.py ad-free-key --project p --source-root . || exit 1\ngcloud secrets delete ad-free-key --quiet';
  ok('preflight: allows guarded destroy', g.pcSecretDestroyRefusal(guarded) === null);
  ok('preflight: invoked detected', g.pcPreflightInvoked(guarded) === true);
  ok('preflight: plain command not refused', g.pcSecretDestroyRefusal('echo hello') === null);
  ok('preflight: commented destroy is ignored', g.pcLooksLikeSecretDestroy('# gcloud secrets delete x') === false);
  ok('preflight: commented preflight does not satisfy', g.pcPreflightInvoked('# secret-destroy-preflight.py x') === false);
  ok('preflight: DELETE verb on secretmanager via curl', g.pcLooksLikeSecretDestroy("curl -X DELETE 'https://secretmanager.googleapis.com/v1/projects/p/secrets/x'") === true);
  ok('preflight: never throws on garbage', (() => { try { g.pcSecretDestroyRefusal(null); g.pcSecretDestroyRefusal(123); return true; } catch (e) { return false; } })());

  // ---- harBqParseTable ----
  eq('bqParse: ds.tbl -> default project', JSON.stringify(g.harBqParseTable('ds.tbl')), JSON.stringify({ project: 'test-proj', dataset: 'ds', table: 'tbl' }));
  eq('bqParse: proj.ds.tbl', JSON.stringify(g.harBqParseTable('proj.ds.tbl')), JSON.stringify({ project: 'proj', dataset: 'ds', table: 'tbl' }));
  eq('bqParse: proj:ds.tbl colon form', JSON.stringify(g.harBqParseTable('proj:ds.tbl')), JSON.stringify({ project: 'proj', dataset: 'ds', table: 'tbl' }));
  ok('bqParse: single token -> null', g.harBqParseTable('tbl') === null);
  ok('bqParse: empty -> null', g.harBqParseTable('') === null);
  ok('bqParse: strips backticks', JSON.stringify(g.harBqParseTable('`ds`.`tbl`')) === JSON.stringify({ project: 'test-proj', dataset: 'ds', table: 'tbl' }));

  // ---- harBqRun (fetch stub) ----
  bqRunBody = { jobComplete: true, jobReference: { jobId: 'job1' }, schema: { fields: [{ name: 'n' }, { name: 'v' }] }, rows: [{ f: [{ v: '1' }, { v: 'a' }] }, { f: [{ v: '2' }, { v: 'b' }] }], totalRows: '2' };
  const run = await g.harBqRun('SELECT 1', 10);
  ok('bqRun: ok', run.ok === true);
  eq('bqRun: schema parsed', JSON.stringify(run.schema), JSON.stringify(['n', 'v']));
  eq('bqRun: rowCount', run.rowCount, 2);
  eq('bqRun: totalRows numeric', run.totalRows, 2);
  eq('bqRun: first row mapped', JSON.stringify(run.rows[0]), JSON.stringify({ n: '1', v: 'a' }));
  bqRunBody = { error: { message: 'boom' } };
  const runErr = await g.harBqRun('SELECT bad', 10);
  ok('bqRun: surfaces error', runErr.ok === false && runErr.error === 'boom');

  // ---- harBqInsert validation + happy path ----
  ok('bqInsert: bad table', (await g.harBqInsert('nope', [{ a: 1 }])).ok === false);
  ok('bqInsert: empty rows', (await g.harBqInsert('ds.tbl', [])).ok === false);
  ok('bqInsert: non-object row', (await g.harBqInsert('ds.tbl', [1 as any])).ok === false);
  const big = []; for (let i = 0; i < 501; i++) big.push({ a: i });
  ok('bqInsert: >500 rows refused', (await g.harBqInsert('ds.tbl', big)).ok === false);
  bqInsertBody = {};
  const ins = await g.harBqInsert('ds.tbl', [{ a: 1 }, { a: 2 }]);
  ok('bqInsert: happy path ok', ins.ok === true && ins.inserted === 2);
  eq('bqInsert: fully-qualified table echoed', ins.table, 'test-proj.ds.tbl');
  bqInsertBody = { insertErrors: [{ index: 0, errors: [{ reason: 'invalid' }] }] };
  const insErr = await g.harBqInsert('ds.tbl', [{ a: 1 }, { a: 2 }]);
  ok('bqInsert: partial-failure reported', insErr.ok === false && insErr.inserted === 1);

  // ---- harPgPool singleton + harPgQuery/harPgInsert (patched pool, no socket) ----
  const pool = g.harPgPool();
  ok('pgPool: returns an object', !!pool && typeof pool === 'object');
  ok('pgPool: is a singleton', g.harPgPool() === pool);
  pool.query = async (_sql: string, _params?: any) => ({ rows: [{ x: 1 }, { x: 2 }, { x: 3 }], rowCount: 3, fields: [{ name: 'x' }] });
  const q = await g.harPgQuery('SELECT x FROM t', 2);
  eq('pgQuery: rowCount passthrough', q.rowCount, 3);
  eq('pgQuery: fields mapped to names', JSON.stringify(q.fields), JSON.stringify(['x']));
  eq('pgQuery: capped to maxRows', q.rows.length, 2);
  ok('pgQuery: truncated flag', q.truncated === true);
  pool.query = async () => ({ rowCount: 2 });
  const pi = await g.harPgInsert('fleet.docs', [{ a: 1 }, { a: 2 }]);
  eq('pgInsert: inserted count', pi.inserted, 2);
  let threw = false; try { await g.harPgInsert('bad-name!', [{ a: 1 }]); } catch (e) { threw = true; }
  ok('pgInsert: rejects bad table name', threw === true);

  console.log(fail === 0 ? 'gcp-api OK (' + pass + ' assertions)' : fail + ' FAIL / ' + pass + ' pass');
  process.exit(fail === 0 ? 0 : 1);
})();
