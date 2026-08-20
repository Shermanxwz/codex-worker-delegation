import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const hook=path.resolve('plugins/codex-worker-delegation/hooks/policy-hook.mjs');
async function runHook(state,input,t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-hook-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const stateFile=path.join(dir,'state.json');await fs.writeFile(stateFile,JSON.stringify(state));return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[hook],{env:{...process.env,CWD_STATE_FILE:stateFile}});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>resolve({code,out,err}));p.stdin.end(JSON.stringify({hook_event_name:'PreToolUse',session_id:'s',turn_id:'t',...input}))})}

test('real hook process denies root exec in DELEGATE',async(t)=>{const r=await runHook({mode:'DELEGATE'},{tool_name:'exec_command'},t);assert.equal(r.code,0);const j=JSON.parse(r.out);assert.equal(j.hookSpecificOutput.permissionDecision,'deny')});
test('real hook process allows delegated subagent exec',async(t)=>{const r=await runHook({mode:'DELEGATE'},{tool_name:'exec_command',agent_id:'a',agent_type:'cwd-worker'},t);assert.equal(r.code,0);assert.equal(r.out,'')});
test('real hook freezes subagent in MAIN',async(t)=>{const r=await runHook({mode:'MAIN'},{tool_name:'apply_patch',agent_id:'a'},t);assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision,'deny')});
