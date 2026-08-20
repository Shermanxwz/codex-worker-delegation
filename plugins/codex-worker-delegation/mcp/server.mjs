#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{buffer+=chunk;drain()});

function drain(){while(true){const i=buffer.indexOf('\n');if(i<0)return;const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)handle(JSON.parse(line)).catch((e)=>reply(null,null,{code:-32603,message:e.message}))}}

async function handle(msg){
  if(msg.method==='initialize')return reply(msg.id,{protocolVersion:msg.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'codex-worker-delegation',version:'2.0.0'}});
  if(msg.method==='notifications/initialized')return;
  if(msg.method==='tools/list')return reply(msg.id,{tools:[
    {name:'delegation_status',description:'Read current Web-controlled delegation mode and redacted model routing.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'delegate_worker',description:'Run the Web-selected worker or verifier. Cross-provider work is executed through Codex app-server; same-provider work returns a native-subagent instruction.',inputSchema:{type:'object',properties:{task:{type:'string'},role:{type:'string',enum:['worker','verifier']},cwd:{type:'string'},mode:{type:'string',enum:['AUTO','DELEGATE','MAIN']}},required:['task'],additionalProperties:false}}
  ]});
  if(msg.method==='tools/call'&&msg.params?.name==='delegation_status'){
    const s=await state();
    return toolReply(msg.id,{mode:s.mode,routing:s.routing||null,provider:s.provider&&{name:s.provider.name,baseUrl:s.provider.baseUrl,protocol:s.provider.protocol},protocolCache:s.protocolCache,installed:Boolean(s.installed)});
  }
  if(msg.method==='tools/call'&&msg.params?.name==='delegate_worker')return toolReply(msg.id,await delegateWorker(msg.params?.arguments||{}));
  if(msg.id!==undefined)return reply(msg.id,null,{code:-32601,message:'method not found'});
}

function toolReply(id,value){return reply(id,{content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]})}
function reply(id,result,error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})})+'\n')}
function baseDir(){return process.env.CWD_DATA_DIR||(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'))+'/codex-worker-delegation'}
async function state(){try{return JSON.parse(await fs.readFile(path.join(baseDir(),'state.json'),'utf8'))}catch{return{mode:'AUTO',routing:null,provider:null,protocolCache:{},installed:false}}}
async function delegateWorker(args){
  if(!args.task?.trim())throw new Error('task is required');
  const token=(await fs.readFile(path.join(baseDir(),'gateway.token'),'utf8')).trim();
  const port=Number(process.env.CWD_PORT||8788);
  const response=await fetch(`http://127.0.0.1:${port}/internal/worker/run`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(190000)});
  const text=await response.text();let body;try{body=JSON.parse(text)}catch{body={error:text}}
  if(!response.ok)throw new Error(body?.error?.message||body?.error||`worker request failed (${response.status})`);
  return body;
}
