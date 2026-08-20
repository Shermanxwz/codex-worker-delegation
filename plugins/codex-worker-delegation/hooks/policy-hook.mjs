#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const COORDINATION=new Set(['spawn_agent','send_message','wait_agent','followup_task','interrupt_agent','list_agents','Agent','update_plan']);
const SPAWN=new Set(['spawn_agent','Agent']);
let text=''; for await (const chunk of process.stdin) text+=chunk;
try {
  const input=JSON.parse(text||'{}'); if(input.hook_event_name!=='PreToolUse') process.exit(0);
  const state=await readState(); const result=evaluate(state.mode||'AUTO',input.tool_name,Boolean(input.agent_id||input.agent_type));
  await observe(input,state.mode,result).catch(()=>{});
  if(!result.allow) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:result.reason}}));
} catch(error) { process.stderr.write(`codex-worker-delegation hook error: ${error.message}\n`); process.exit(2); }

function evaluate(mode,tool,isSub){
  if(mode==='AUTO')return{allow:true,reason:'AUTO'};
  if(mode==='DELEGATE'){if(isSub||COORDINATION.has(tool))return{allow:true,reason:'delegated'};return{allow:false,reason:`DELEGATE mode keeps the root agent coordination-only. Delegate ${tool} to a native subagent.`}}
  if(mode==='MAIN'){if(isSub)return{allow:false,reason:'MAIN mode freezes subagent tool execution.'};if(SPAWN.has(tool))return{allow:false,reason:'MAIN mode disables new subagent spawning.'};return{allow:true,reason:'main'}}
  return{allow:false,reason:`Unknown delegation mode ${mode}; failing closed.`};
}
function stateFile(){if(process.env.CWD_STATE_FILE)return process.env.CWD_STATE_FILE;const base=process.env.CWD_DATA_DIR||(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'))+'/codex-worker-delegation';return path.join(base,'state.json')}
async function readState(){try{return JSON.parse(await fs.readFile(stateFile(),'utf8'))}catch(e){if(e.code==='ENOENT')return{mode:'AUTO'};throw e}}
async function observe(input,mode,result){const file=path.join(path.dirname(stateFile()),'hook-observations.jsonl');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.appendFile(file,JSON.stringify({at:new Date().toISOString(),session_id:input.session_id,turn_id:input.turn_id,agent_id:input.agent_id||null,agent_type:input.agent_type||null,tool_name:input.tool_name,mode,allow:result.allow})+'\n',{mode:0o600})}
