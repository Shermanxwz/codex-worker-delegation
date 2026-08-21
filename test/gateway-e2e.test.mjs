import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';

async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port}
async function tempEnv(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-e2e-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return{CWD_DATA_DIR:path.join(dir,'data'),CODEX_HOME:path.join(dir,'.codex'),CWD_PORT:'8788'}}
async function configuredStore(env,base,protocol='auto'){const store=new StateStore({env});const vault=new SecretVault({env});const cipher=await vault.encrypt('upstream-key');await store.write({mode:'AUTO',provider:{name:'fake',baseUrl:base,protocol,apiKeyCipher:cipher,headers:{}},protocolCache:{},models:{main:'m',worker:'m',verifier:'m'},mainSource:'official',installed:false,originalTopLevel:null});return store}

test('full HTTP flow auto-detects chat-only upstream and emits Responses SSE with tool call',async(t)=>{
  let responsesSeen=0,chatSeen=0,chatRequest;
  const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;if(req.url==='/v1/responses'){responsesSeen++;res.writeHead(404);res.end('not found');return}if(req.url==='/v1/chat/completions'){chatSeen++;chatRequest=JSON.parse(body);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'working '}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call_9',function:{name:'shell',arguments:'{"command":"'}}]}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'pwd"}'}}]}}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');res.end('data: [DONE]\n\n');return}res.writeHead(404).end()});
  const upPort=await listen(upstream);t.after(()=>upstream.close());const env=await tempEnv(t);const store=await configuredStore(env,`http://127.0.0.1:${upPort}/v1`);const app=createApp({env});const port=await listen(app.server);t.after(()=>app.server.close());const token=await store.ensureGatewayToken();
  const r=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,input:[{type:'message',role:'user',content:[{type:'input_text',text:'do it'}]}],tools:[{type:'function',name:'shell',description:'run',parameters:{type:'object'}}]})});
  assert.equal(r.status,200);const text=await r.text();assert.equal(responsesSeen,1);assert.equal(chatSeen,1);assert.equal(chatRequest.messages[0].content,'do it');assert.equal(chatRequest.tools[0].function.name,'shell');assert.match(text,/response\.output_text\.delta/);assert.match(text,/"type":"function_call"/);assert.match(text,/"call_id":"call_9"/);assert.match(text,/response\.completed/);const state=await store.read();assert.equal(state.protocolCache.m.protocol,'chat');
});

test('full HTTP flow preserves native Responses stream and caches native capability',async(t)=>{
  let requestBody;
  const upstream=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requestBody=JSON.parse(body);assert.equal(req.url,'/v1/responses');res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.created","response":{"id":"r"}}\n\ndata: {"type":"response.output_text.delta","delta":"native"}\n\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n')});
  const upPort=await listen(upstream);t.after(()=>upstream.close());const env=await tempEnv(t);const store=await configuredStore(env,`http://127.0.0.1:${upPort}`);const app=createApp({env});const port=await listen(app.server);t.after(()=>app.server.close());const token=await store.ensureGatewayToken();const r=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,input:'hi',reasoning:{effort:'max'}})});const text=await r.text();assert.match(text,/native/);assert.equal(requestBody.reasoning,undefined);assert.equal((await store.read()).protocolCache.m.protocol,'responses')
});

test('gateway preserves a reasoning effort explicitly selected for a third-party route',async(t)=>{
  let requestBody;
  const upstream=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requestBody=JSON.parse(body);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.created","response":{"id":"r"}}\n\ndata: {"type":"response.output_text.delta","delta":"explicit"}\n\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n')});
  const upPort=await listen(upstream);t.after(()=>upstream.close());const env=await tempEnv(t);const store=await configuredStore(env,`http://127.0.0.1:${upPort}`);await store.update((s)=>{s.routing.DELEGATE.worker={provider:'third_party',model:'m',effort:'low'};s.routing.DELEGATE.verifier={...s.routing.DELEGATE.worker};return s});const app=createApp({env});const port=await listen(app.server);t.after(()=>app.server.close());const token=await store.ensureGatewayToken();const r=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,input:'hi',reasoning:{effort:'low',summary:'auto'}})});assert.equal(r.status,200);assert.match(await r.text(),/explicit/);assert.equal(requestBody.reasoning.effort,'low');
});

test('gateway rejects requests without its local bearer token',async(t)=>{const upstream=http.createServer((q,s)=>s.end());const upPort=await listen(upstream);t.after(()=>upstream.close());const env=await tempEnv(t);await configuredStore(env,`http://127.0.0.1:${upPort}`,'responses');const app=createApp({env});const port=await listen(app.server);t.after(()=>app.server.close());const r=await fetch(`http://127.0.0.1:${port}/v1/responses`,{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"m"}'});assert.equal(r.status,401)});
