import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const serverPath=path.resolve('plugins/codex-worker-delegation/mcp/server.mjs');

async function tempDir(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-mcp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}
function startMcp(t,env){const p=spawn(process.execPath,[serverPath],{env:{...process.env,...env}});t.after(()=>p.kill());const messages=[];let buffer='';p.stdout.setEncoding('utf8');p.stdout.on('data',c=>{buffer+=c;while(true){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)messages.push(JSON.parse(line))}});return{p,messages,send:(x)=>p.stdin.write(JSON.stringify(x)+'\n'),wait:async(id)=>{const end=Date.now()+3000;while(Date.now()<end){const found=messages.find(x=>x.id===id);if(found)return found;await new Promise(r=>setTimeout(r,10))}throw new Error(`MCP response ${id} timed out`)}}}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port}

 test('bundled MCP server initializes, lists both tools and returns only redacted status',async(t)=>{
  const dir=await tempDir(t);
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({mode:'DELEGATE',routing:{DELEGATE:{main:{provider:'official',model:'o'},worker:{provider:'third_party',model:'m'},verifier:{provider:'third_party',model:'v'}}},provider:{name:'New API',baseUrl:'https://x/v1',protocol:'auto',apiKeyCipher:'SECRET'},protocolCache:{m:{protocol:'chat'}},installed:true}));
  const m=startMcp(t,{CWD_DATA_DIR:dir});
  m.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
  m.send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  m.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'delegation_status',arguments:{}}});
  assert.equal((await m.wait(1)).result.serverInfo.name,'codex-worker-delegation');
  const tools=(await m.wait(2)).result.tools.map(x=>x.name);
  assert.deepEqual(tools,['delegation_status','delegate_worker']);
  const text=(await m.wait(3)).result.content[0].text;
  assert.match(text,/DELEGATE/);assert.match(text,/third_party/);assert.doesNotMatch(text,/SECRET/);
});

test('delegate_worker calls the token-authenticated local control plane and returns its worker result',async(t)=>{
  const dir=await tempDir(t);const token='local-secret-token';await fs.writeFile(path.join(dir,'gateway.token'),token+'\n',{mode:0o600});
  let seen=null;
  const control=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;seen={url:req.url,authorization:req.headers.authorization,body:JSON.parse(body)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({execution:'cross_provider_thread',threadId:'thread-x',output:'WORKER_OK'}))});
  const port=await listen(control);t.after(()=>control.close());
  const m=startMcp(t,{CWD_DATA_DIR:dir,CWD_PORT:String(port)});
  m.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});await m.wait(1);
  m.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'delegate_worker',arguments:{task:'implement it',role:'worker',mode:'DELEGATE',cwd:'/tmp/project'}}});
  const result=await m.wait(2);const payload=JSON.parse(result.result.content[0].text);
  assert.equal(payload.execution,'cross_provider_thread');assert.equal(payload.output,'WORKER_OK');
  assert.equal(seen.url,'/internal/worker/run');assert.equal(seen.authorization,`Bearer ${token}`);assert.deepEqual(seen.body,{task:'implement it',role:'worker',mode:'DELEGATE',cwd:'/tmp/project'});
});
