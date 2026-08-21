#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COORDINATION=new Set(['spawn_agent','send_message','wait_agent','followup_task','interrupt_agent','list_agents','Agent','update_plan','delegate_worker','delegation_status']);
const SPAWN=new Set(['spawn_agent','Agent']);
const VERIFIER_BLOCKED=[/exec/i,/shell/i,/apply_patch/i,/write/i,/edit/i,/delete/i,/move/i,/rename/i];
let text='';for await(const chunk of process.stdin)text+=chunk;
try{const input=JSON.parse(text||'{}');if(input.hook_event_name!=='PreToolUse')process.exit(0);const state=await readState();const result=evaluate(state,input);await observe(input,state.mode||'AUTO',result).catch(()=>{});if(!result.allow)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:result.reason}}))}catch(error){process.stderr.write(`codex-worker-delegation hook error: ${error.message}\n`);process.exit(2)}

function isDelegationMcp(tool=''){const name=String(tool);return name.includes('codex-worker-delegation')||name.endsWith('delegate_worker')||name.endsWith('delegation_status')}
function roleFromSpawnInput(input={}){const type=String(input?.agent_type||input?.agentType||'').toLowerCase();if(type.includes('verifier'))return'verifier';if(type.includes('worker'))return'worker';return null}
function nativeSafe(state,mode,role){const routes=state?.routing?.[mode];return routes?.main?.provider==='official'&&routes?.[role]?.provider==='official'}
function evaluate(state,input){const mode=state.mode||'AUTO',tool=input.tool_name,isSub=Boolean(input.agent_id||input.agent_type),agentType=input.agent_type;
  if(String(agentType||'').toLowerCase().includes('verifier')&&VERIFIER_BLOCKED.some(r=>r.test(String(tool))))return{allow:false,reason:'Verifier role is read-only; mutation and execution tools are blocked.'};
  if(!isSub&&SPAWN.has(tool)){const role=roleFromSpawnInput(input.tool_input);if(role&&state?.routing?.[mode]&&!nativeSafe(state,mode,role))return{allow:false,reason:`${mode}.${role} involves a third-party provider. Native spawn_agent is blocked because current Codex custom-provider subagent transport can lose task payloads; call delegate_worker instead.`}}
  if(mode==='AUTO')return{allow:true,reason:'AUTO'};
  if(mode==='DELEGATE'){if(isSub||COORDINATION.has(tool)||isDelegationMcp(tool))return{allow:true,reason:'delegated'};return{allow:false,reason:`DELEGATE mode keeps the root agent coordination-only. Delegate ${tool} to a worker.`}}
  if(mode==='MAIN'){if(isSub)return{allow:false,reason:'MAIN mode freezes subagent tool execution.'};if(SPAWN.has(tool)||String(tool).endsWith('delegate_worker'))return{allow:false,reason:'MAIN mode disables worker spawning and delegation.'};return{allow:true,reason:'main'}}
  return{allow:false,reason:`Unknown delegation mode ${mode}; failing closed.`}}
function stateFile(){if(process.env.CWD_STATE_FILE)return process.env.CWD_STATE_FILE;const base=process.env.CWD_DATA_DIR||(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'))+'/codex-worker-delegation';return path.join(base,'state.json')}
async function readState(){try{return JSON.parse(await fs.readFile(stateFile(),'utf8'))}catch(e){if(e.code==='ENOENT')return{mode:'AUTO'};throw e}}
async function observe(input,mode,result){const file=path.join(path.dirname(stateFile()),'hook-observations.jsonl');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.appendFile(file,JSON.stringify({at:new Date().toISOString(),session_id:input.session_id,turn_id:input.turn_id,agent_id:input.agent_id||null,agent_type:input.agent_type||null,tool_name:input.tool_name,mode,allow:result.allow})+'\n',{mode:0o600})}
