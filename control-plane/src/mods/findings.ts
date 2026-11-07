// SPDX-License-Identifier: Apache-2.0
// [FINDINGS-V1] Source-anchored finding gate, extracted from index.ts (strangler). Before a row
// lands in vrp.findings the harness RE-FETCHES the cited file at pinned_sha and requires the
// verbatim source_quote (within +/-10 lines) and every claimed symbol to be literally present.
// Moved verbatim from index.ts; the only change is that db/FieldValue, waFetch/PC_GH_SECRET_PREFIX
// and harSecretGet now come from sibling mods / ../shared instead of index-local definitions.
import { db, FieldValue } from './store.js';
import { waFetch, PC_GH_SECRET_PREFIX } from '../shared.js';
import { harSecretGet } from './secrets-keys.js';

// [ARGON-FINDGATE-V1] SOURCE-ANCHORED FINDING GATE. MEASURED: gemini-4-argon banks findings citing
// code that does not exist at the pinned SHA -- hallucinated struct fields / functions, files
// deleted from main, inverted logic (genkit round: 5 of 8 banked rows were fabricated; the HIGHs
// were the weakest). Root cause: the model writes the finding from a trained-in hypothesis, runs
// tools, then self-labels "verified at source". So before a row lands in vrp.findings the harness
// RE-FETCHES the file at pinned_sha with a fresh server-side read and requires the cited verbatim
// quote (within +/-10 lines) and every claimed symbol to be literally present. Recall stays wide:
// a reject comes back as a resurrectable lead, never a deletion. CHAT_FINDING_GATE: advisory
// (log + still insert, tagged -- the measurement phase) | block (hold failing rows out as
// unverified-source leads) | off.
export const HAR_FINDING_GATE = (function(){ const v=String(process.env.CHAT_FINDING_GATE||'advisory').trim().toLowerCase(); return (v==='block'||v==='off')?v:'advisory'; })();
export function harFindingTable(table: string): boolean { const t=String(table||'').replace(/`/g,'').trim(); return /(^|\.)vrp\.findings$/i.test(t); }
const harGhFetchMemo: Map<string, { at: number; ok: boolean; status: number; text: string }> = new Map();
export async function harGhFetchAtSha(repo: string, path: string, ref: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const _mk = String(repo) + '|' + String(ref) + '|' + String(path);
    const _m = harGhFetchMemo.get(_mk);
    if (_m && Date.now() - _m.at < 120000) return { ok: _m.ok, status: _m.status, text: _m.text };
    const or=String(repo||'').replace(/^https?:\/\/github\.com\//i,'').replace(/\.git$/i,'').split('/').filter(Boolean).slice(0,2).join('/');
    if(!or||or.indexOf('/')<0||!path||!ref) return { ok:false, status:0, text:'' };
    let tok=''; try { tok=(await harSecretGet(PC_GH_SECRET_PREFIX+'default'))||''; } catch(_e){}
    const url='https://api.github.com/repos/'+or+'/contents/'+String(path).replace(/^\/+/,'').split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref);
    const r:any=await waFetch(url,{ headers: Object.assign({ 'Accept':'application/vnd.github.v3+json','User-Agent':'paracoding-fleet-findgate' }, tok?{ 'Authorization':'Bearer '+tok }:{}) });
    if(!r.ok){ const v={ at:Date.now(), ok:false, status:Number(r.status||0), text:'' }; harGhFetchMemo.set(_mk,v); return v; }
    const j:any=await r.json().catch(()=>null);
    if(!j||typeof j.content!=='string'){ const v={ at:Date.now(), ok:false, status:Number(r.status||0), text:'' }; harGhFetchMemo.set(_mk,v); return v; }
    const txt=Buffer.from(String(j.content).replace(/\s+/g,''),'base64').toString('utf8');
    const v={ at:Date.now(), ok:true, status:Number(r.status||200), text:txt }; if(harGhFetchMemo.size>1000){ const f=harGhFetchMemo.keys().next().value; if(f) harGhFetchMemo.delete(f); } harGhFetchMemo.set(_mk,v); return v;
  } catch(e){ return { ok:false, status:0, text:'' }; }
}
export async function harFindingGate(row: any): Promise<{ pass: boolean; reason: string; source_proof: string }> {
  const repo=String((row&&row.repo)||'').trim(), file=String((row&&row.file_path)||'').trim(), sha=String((row&&row.pinned_sha)||'').trim();
  const line=Number((row&&row.line)||0)||0;
  const quote=String((row&&row.source_quote)||'').trim();
  const sraw=(row&&row.source_symbols);
  const symbols=Array.isArray(sraw)?sraw.map((x:any)=>String(x).trim()).filter(Boolean):String(sraw||'').split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean);
  if(!repo||!file||!sha) return { pass:false, reason:'missing repo/file_path/pinned_sha', source_proof:'' };
  if(!quote) return { pass:false, reason:'missing source_quote (paste the exact lines at file:line from a gh_read at pinned_sha)', source_proof:'' };
  const g=await harGhFetchAtSha(repo,file,sha);
  if(!g.ok) return { pass:false, reason:'file-absent-at-sha ('+repo+' '+file+'@'+sha.slice(0,12)+' -> HTTP '+g.status+')', source_proof:'' };
  const fnorm=g.text.replace(/\r\n/g,'\n').split('\n').map((l:string)=>l.replace(/\s+/g,' ').trim());
  const qnorm=quote.replace(/\r\n/g,'\n').split('\n').map((l:string)=>l.replace(/\s+/g,' ').trim()).filter((l:string)=>l.length>0);
  if(!qnorm.length) return { pass:false, reason:'source_quote empty after normalization', source_proof:'' };
  const q0=qnorm[0]; let hit=-1;
  for(let i=0;i<fnorm.length;i++){
    if(fnorm[i]===q0 || (q0.length>10 && fnorm[i].indexOf(q0)>=0)){
      let ok=true;
      for(let k=1;k<qnorm.length;k++){ const fl=fnorm[i+k]||''; if(!(fl===qnorm[k] || (qnorm[k].length>10 && fl.indexOf(qnorm[k])>=0))){ ok=false; break; } }
      if(ok){ hit=i; break; }
    }
  }
  if(hit<0) return { pass:false, reason:'quote-not-found (the verbatim quote is not present in '+file+' at '+sha.slice(0,12)+')', source_proof:'' };
  if(line>0 && Math.abs((hit+1)-line)>10) return { pass:false, reason:'quote-not-found (quote is at line '+(hit+1)+', not within +/-10 of the cited line '+line+')', source_proof:'' };
  const miss=symbols.filter((sym:string)=>sym && g.text.indexOf(sym)<0);
  if(miss.length) return { pass:false, reason:'symbol-absent ('+miss.slice(0,6).join(', ')+' not literally present in '+file+' at '+sha.slice(0,12)+')', source_proof:'' };
  return { pass:true, reason:'', source_proof:(file+'@'+sha.slice(0,12)+' L'+(hit+1)+'; quote '+qnorm.length+' line(s) verified'+(symbols.length?('; symbols ok: '+symbols.slice(0,12).join(', ')):'')) };
}
export async function harFindingGateRows(rows: any[]): Promise<{ insert: any[]; rejects: any[]; summary: string }> {
  const insert:any[]=[]; const rejects:any[]=[]; let pass=0, fail=0;
  for(const row0 of (Array.isArray(rows)?rows:[])){
    const row:any=Object.assign({}, row0);
    if(Array.isArray(row.source_symbols)) row.source_symbols=row.source_symbols.join('\n');
    let g:any; try{ g=await harFindingGate(row); }catch(e:any){ g={pass:false,reason:'gate error: '+String((e&&e.message)||e),source_proof:''}; }
    row.gate_status=g.pass?'pass':'reject'; row.gate_reason=g.reason||'';
    if(g.pass){ row.source_proof=g.source_proof; pass++; insert.push(row); }
    else {
      fail++;
      console.log('[findgate] REJECT fid='+String(row.finding_id||'?')+' sev='+String(row.severity||'?')+' reason='+g.reason);
      try{ await db.collection('journal').add({ agent_id:String(row.found_by||row.banked_by||'fleet-argon'), action:'findgate-reject', message:('['+String(row.severity||'?')+'] '+String(row.finding_id||'')+' '+String(row.title||'').slice(0,120)+' -- '+g.reason).slice(0,800), timestamp:FieldValue.serverTimestamp() }); }catch(_e){}
      if(HAR_FINDING_GATE==='block'){ rejects.push({ finding_id:row.finding_id, title:row.title, severity:row.severity, repo:row.repo, file_path:row.file_path, line:row.line, pinned_sha:row.pinned_sha, reason:g.reason, status:'unverified-source' }); }
      else { insert.push(row); }
    }
  }
  const summary='findgate '+HAR_FINDING_GATE+': '+pass+' passed source-check, '+fail+' failed'+(fail?(HAR_FINDING_GATE==='block'?(' ('+fail+' held out as unverified-source leads -- fix file/sha/quote/symbols or move to Theories)'):(' (advisory: inserted anyway, tagged gate_status=reject)')):'');
  return { insert, rejects, summary };
}
