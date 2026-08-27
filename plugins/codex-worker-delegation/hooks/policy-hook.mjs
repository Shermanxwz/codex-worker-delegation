#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODES=new Set(['OFFICIAL','AUTO','DELEGATE','MAIN']);
const COORDINATION=new Set(['spawn_agent','send_message','wait_agent','followup_task','interrupt_agent','list_agents','Agent','update_plan']);
const SPAWN=new Set(['spawn_agent','Agent']);
const DELEGATION_TOOLS=new Set(['delegate_worker','delegation_status','worker_status','worker_extend','worker_cancel']);
const VERIFIER_BLOCKED=[/exec/i,/shell/i,/apply_patch/i,/write/i,/edit/i,/delete/i,/move/i,/rename/i,/create/i,/mkdir/i,/chmod/i,/chown/i,/truncate/i,/commit/i];
const LOOPBACK_HOSTS=new Set(['127.0.0.1','localhost','::1','[::1]']);
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN=/^[a-f0-9]{48}$/;
const HEALTH_DOMAIN='cwd-hook-health-v1';
let text='';for await(const chunk of process.stdin)text+=chunk;
let input={};
try{
  input=JSON.parse(text||'{}');
  if(input.hook_event_name!=='PreToolUse')process.exit(0);
  const state=await readState();
  let result;
  if(!state) result={allow:false,reason:'Codex Worker Delegation state is missing; failing closed until the control plane is initialized.'};
  else if(state.mode==='OFFICIAL') {
    // OFFICIAL is a true dormant path. Native Codex must keep working even if
    // the delegation control plane is stopped, upgraded or intentionally absent.
    result={allow:true,reason:'OFFICIAL mode defers tool and multi-agent policy to native Codex.'};
  } else {
    const health=await controlPlaneHealth();
    result=health.ok?evaluate(state,input):{allow:false,reason:`Codex Worker Delegation control plane is unavailable (${health.reason}); failing closed.`};
  }
  await observe(input,state?.mode||'UNKNOWN',result).catch(()=>{});
  emitDecision(result);
}catch(error){
  const result={allow:false,reason:`Codex Worker Delegation policy hook failed closed: ${error?.message||String(error)}`};
  await observe(input,'ERROR',result).catch(()=>{});
  emitDecision(result);
}

function emitDecision(result){if(!result.allow)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:result.reason}}))}
function isDelegationMcp(tool=''){const name=String(tool);for(const allowed of DELEGATION_TOOLS){if(name===allowed||name.endsWith(`__${allowed}`)||name.endsWith(`.${allowed}`)||name.endsWith(`/${allowed}`))return true}return false}
function roleFromSpawnInput(input={}){const type=String(input?.agent_type||input?.agentType||'').toLowerCase();if(type.includes('verifier'))return'verifier';if(type.includes('worker'))return'worker';return null}
function nativeSafe(state,mode,role){const routes=state?.routing?.[mode];return routes?.main?.provider==='official'&&routes?.[role]?.provider==='official'}
function evaluate(state,input){const mode=state.mode,tool=input.tool_name,isSub=Boolean(input.agent_id||input.agent_type),agentType=input.agent_type;
  if(!MODES.has(mode))return{allow:false,reason:`Unknown delegation mode ${String(mode)}; failing closed.`};
  if(mode==='OFFICIAL')return{allow:true,reason:'OFFICIAL mode defers to native Codex.'};
  if(String(agentType||'').toLowerCase().includes('verifier')&&VERIFIER_BLOCKED.some(r=>r.test(String(tool))))return{allow:false,reason:'Verifier role is read-only; mutation and execution tools are blocked.'};
  if(!isSub&&SPAWN.has(tool)){const role=roleFromSpawnInput(input.tool_input);if(mode==='DELEGATE'&&!role)return{allow:false,reason:'DELEGATE mode blocks unmanaged native subagent types. Use cwd-worker/cwd-verifier or delegate_worker so provider routing remains enforceable.'};if(role){if(!state?.routing?.[mode]?.main||!state?.routing?.[mode]?.[role])return{allow:false,reason:`${mode}.${role} routing is unavailable; failing closed.`};if(!nativeSafe(state,mode,role))return{allow:false,reason:`${mode}.${role} involves a third-party provider. Native spawn_agent is blocked because current Codex custom-provider subagent transport can lose task payloads; call delegate_worker instead.`}}}
  if(mode==='AUTO')return{allow:true,reason:'AUTO'};
  if(mode==='DELEGATE'){if(isSub||COORDINATION.has(tool)||isDelegationMcp(tool))return{allow:true,reason:'delegated'};return{allow:false,reason:`DELEGATE mode keeps the root agent coordination-only. Delegate ${tool} to a worker.`}}
  if(mode==='MAIN'){if(isSub)return{allow:false,reason:'MAIN mode freezes subagent tool execution.'};if(SPAWN.has(tool)||(isDelegationMcp(tool)&&/(?:^|__|\.|\/)(?:delegate_worker|worker_extend)$/.test(String(tool))))return{allow:false,reason:'MAIN mode disables worker spawning and lease extension.'};return{allow:true,reason:'main'}}
  return{allow:false,reason:`Unknown delegation mode ${mode}; failing closed.`}}
function hmac(token,direction,nonce){return crypto.createHmac('sha256',token).update(`${HEALTH_DOMAIN}:${direction}:${nonce}`).digest('base64url')}
function safeEqual(a,b){const left=Buffer.from(String(a||'')),right=Buffer.from(String(b||''));return left.length===right.length&&crypto.timingSafeEqual(left,right)}
async function gatewayToken(){const value=(await fs.readFile(path.join(dataDir(),'gateway.token'),'utf8')).trim();if(!TOKEN_PATTERN.test(value))throw new Error('gateway token is unavailable or malformed');return value}
async function controlPlaneHealth(){
  if(process.env.CWD_HOOK_REQUIRE_CONTROL_PLANE==='0')return{ok:true,reason:'explicit test bypass'};
  const raw=process.env.CWD_HOOK_CONTROL_PLANE_URL||`http://127.0.0.1:${process.env.CWD_PORT||8788}/internal/hook-health`;
  let url;
  try{url=new URL(raw)}catch{return{ok:false,reason:'invalid health URL'}}
  if(url.protocol!=='http:'||!LOOPBACK_HOSTS.has(url.hostname))return{ok:false,reason:'health URL must be loopback HTTP'};
  let token;
  try{token=await gatewayToken()}catch(error){return{ok:false,reason:error.message}}
  const nonce=crypto.randomBytes(24).toString('hex');
  if(!NONCE_PATTERN.test(nonce))return{ok:false,reason:'nonce generation failed'};
  url.searchParams.set('nonce',nonce);
  const requestProof=hmac(token,'request',nonce);
  const timeoutMs=Math.max(100,Math.min(2000,Number(process.env.CWD_HOOK_HEALTH_TIMEOUT_MS||750)||750));
  try{
    const response=await fetch(url,{headers:{accept:'application/json','x-cwd-hook-proof':requestProof},signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)return{ok:false,reason:`health HTTP ${response.status}`};
    const body=await response.json();
    if(body?.ok!==true||body?.version!==1||body?.nonce!==nonce)return{ok:false,reason:'health payload identity mismatch'};
    const expected=hmac(token,'response',nonce);
    if(!safeEqual(body?.proof,expected))return{ok:false,reason:'health HMAC proof mismatch'};
    return{ok:true,reason:'authenticated healthy'};
  }catch(error){return{ok:false,reason:error?.name==='TimeoutError'?'health timeout':(error?.message||'health request failed')}}
}
function dataDir(){if(process.env.CWD_DATA_DIR)return path.resolve(process.env.CWD_DATA_DIR);const home=process.env.HOME||os.homedir();return path.join(home,'.local','share','codex-worker-delegation')}
function stateFile(){return process.env.CWD_STATE_FILE||path.join(dataDir(),'state.json')}
async function readState(){try{const state=JSON.parse(await fs.readFile(stateFile(),'utf8'));if(!MODES.has(state?.mode))throw new Error(`invalid mode ${String(state?.mode)}`);return state}catch(e){if(e.code==='ENOENT')return null;throw e}}
async function observe(input,mode,result){const file=path.join(path.dirname(stateFile()),'hook-observations.jsonl');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.appendFile(file,JSON.stringify({at:new Date().toISOString(),session_id:input.session_id,turn_id:input.turn_id,agent_id:input.agent_id||null,agent_type:input.agent_type||null,tool_name:input.tool_name,mode,allow:result.allow,reason:result.reason})+'\n',{mode:0o600});await fs.chmod(file,0o600).catch(()=>{})}