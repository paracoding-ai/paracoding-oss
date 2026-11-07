// SPDX-License-Identifier: Apache-2.0
// Unit tests for mods/history-tools.ts. No cloud, no network, no emulator.
//
// shared.ts captures `waFetch = globalThis.fetch` at MODULE LOAD, so any fetch stub MUST be
// installed BEFORE mods/history-tools.ts (and shared.ts) is imported -- hence the dynamic
// import() below, after the stub is in place. We drive the PURE branches directly and the two
// pqc* readers through a stubbed fetch, asserting the parsing/shape, never the wire.
process.env.PC_NO_LISTEN = '1';
process.env.GCP_PROJECT = process.env.GCP_PROJECT || 'test-proj';

// --- canned fetch state (tests mutate before each async call) ---
let policyBody: any = null;    // body served at the sslPolicies GET
let policyOk = true;
let proxiesBody: any = null;   // body served at the aggregated targetHttpsProxies GET
let proxiesOk = true;

function resp(body: any, ok = true): any {
  return {
    ok, status: ok ? 200 : 500,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}
(globalThis as any).fetch = async (u: string, _init?: any): Promise<any> => {
  const url = String(u);
  if (url.indexOf('/instance/service-accounts/default/token') >= 0) return resp({ access_token: 'test-token' });
  if (url.indexOf('/sslPolicies/') >= 0) return resp(policyBody, policyOk);
  if (url.indexOf('/targetHttpsProxies') >= 0) return resp(proxiesBody, proxiesOk);
  return resp({});
};

(async () => {
  const H: any = await import('../../src/mods/history-tools.js');

  let pass = 0, fail = 0;
  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) { pass++; return; }
    fail++;
    console.log('  FAIL ' + label + (detail ? '\n        ' + detail : ''));
  }
  function eq(label: string, got: any, want: any) {
    ok(label, got === want, 'got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
  }

  // ---- pcApproveDrift (pure) ----
  eq('drift: non-object expect -> refuse',
     H.pcApproveDrift({ status: 'pending' }, null).indexOf('sent no record') >= 0, true);
  eq('drift: array expect -> refuse',
     H.pcApproveDrift({ status: 'pending' }, []).indexOf('sent no record') >= 0, true);
  const jobA = { status: 'pending', command_type: 'bash', staged_by: 'advisor', arguments: { cmd: 'ls' } };
  eq('drift: identical job+expect -> no drift (empty)',
     H.pcApproveDrift(jobA, { status: 'pending', command_type: 'bash', staged_by: 'advisor', arguments: { cmd: 'ls' } }), '');
  ok('drift: status changed -> names status',
     H.pcApproveDrift(jobA, { status: 'executed', command_type: 'bash', staged_by: 'advisor', arguments: { cmd: 'ls' } }).indexOf('status has changed') >= 0);
  ok('drift: command_type changed -> names it',
     H.pcApproveDrift(jobA, { status: 'pending', command_type: 'gcp_api', staged_by: 'advisor', arguments: { cmd: 'ls' } }).indexOf('command_type has changed') >= 0);
  ok('drift: staged_by changed -> names it',
     H.pcApproveDrift(jobA, { status: 'pending', command_type: 'bash', staged_by: 'mallory', arguments: { cmd: 'ls' } }).indexOf('staged_by has changed') >= 0);
  ok('drift: arguments changed -> arguments message',
     H.pcApproveDrift(jobA, { status: 'pending', command_type: 'bash', staged_by: 'advisor', arguments: { cmd: 'rm -rf /' } }).indexOf('arguments have changed') >= 0);
  // key order in arguments is normalized by pcStableJson -> still "no drift"
  eq('drift: arguments key-order insensitive',
     H.pcApproveDrift({ status: 's', command_type: 'c', staged_by: 'b', arguments: { a: 1, b: 2 } },
                      { status: 's', command_type: 'c', staged_by: 'b', arguments: { b: 2, a: 1 } }), '');

  // ---- pqcReadState (fetch stubbed) ----
  // policy ENABLED + a proxy that attaches it -> effective 'on', no warning
  policyBody = { postQuantumKeyExchange: 'ENABLED', minTlsVersion: 'TLS_1_2' };
  proxiesBody = { items: { 'global': { targetHttpsProxies: [{ name: 'p1', sslPolicy: 'https://x/sslPolicies/pqc-pqc-policy' }] } } };
  let st = await H.pqcReadState();
  eq('pqc: exists', st.exists, true);
  eq('pqc: value ENABLED', st.value, 'ENABLED');
  eq('pqc: min_tls parsed', st.min_tls, 'TLS_1_2');
  eq('pqc: attached proxy counted', st.attached_proxies.length, 1);
  eq('pqc: effective on', st.effective, 'on');
  eq('pqc: no warning when covered', st.warning, null);

  // ENABLED but NO proxy attaches it -> effective 'off' + coverage warning
  proxiesBody = { items: { 'global': { targetHttpsProxies: [{ name: 'p2', sslPolicy: 'https://x/sslPolicies/other' }] } } };
  st = await H.pqcReadState();
  eq('pqc: zero attached', st.attached_proxies.length, 0);
  eq('pqc: effective off w/o coverage', st.effective, 'off');
  ok('pqc: warns no proxy attaches', !!st.warning && st.warning.indexOf('no target HTTPS proxy') >= 0);

  // policy absent (GET not ok) -> effective 'absent'
  policyOk = false; proxiesOk = true;
  proxiesBody = { items: {} };
  st = await H.pqcReadState();
  eq('pqc: policy absent -> exists false', st.exists, false);
  eq('pqc: policy absent -> effective absent', st.effective, 'absent');
  policyOk = true;

  // DEFAULT value -> explicit DEFAULT warning
  policyBody = { postQuantumKeyExchange: 'DEFAULT', minTlsVersion: '' };
  proxiesBody = { items: {} };
  st = await H.pqcReadState();
  ok('pqc: DEFAULT value warned', !!st.warning && st.warning.indexOf('DEFAULT') >= 0);

  console.log(fail === 0 ? ('history-tools OK (' + pass + ' assertions)') : (fail + ' FAIL / ' + pass + ' pass'));
  process.exit(fail === 0 ? 0 : 1);
})();
