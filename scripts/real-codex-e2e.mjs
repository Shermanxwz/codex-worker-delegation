import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { CodexAppServerService, resolveCodexBinary } from '../src/codex-app-server.mjs';

const repoRoot = path.resolve('.');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-real-codex-'));
let upstream, app;
const trace = { responses: [], chat: [] };
let upstreamMode = 'chat';
try {
  const codexBin = await resolveCodexBinary({ env:process.env, cwd:repoRoot });

  // 1) Real current Codex app-server: initialize -> model/list -> marketplace/add -> plugin/install -> plugin/installed.
  const pluginHome = path.join(tmp, 'plugin-home');
  const pluginEnv = { ...process.env, CODEX_HOME:pluginHome, CWD_DATA_DIR:path.join(tmp,'plugin-data'), CODEX_BIN:codexBin };
  const codexService = new CodexAppServerService({ env:pluginEnv, cwd:repoRoot, codexBin, timeoutMs:20_000 });
  const codexModels = await codexService.listModels({ includeHidden:false });
  if (!Array.isArray(codexModels) || codexModels.length === 0) throw new Error('current codex app-server model/list returned no visible models');
  const plugin = await codexService.installLocalPlugin(repoRoot, 'codex-worker-delegation');
  if (!plugin.installed || !plugin.enabled) throw new Error(`plugin app-server install verification failed: ${JSON.stringify(plugin)}`);

  // 2) Deterministic New API fixture supports models + chat-only/native/auth-error modes.
  upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/v1/models') {
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({ data:[{id:'mock-chat-model'},{id:'mock-native-model'},{id:'mock-auth-model'}] }));
    }
    if (req.url === '/v1/responses') {
      const parsed = JSON.parse(body || '{}'); trace.responses.push({ model:parsed.model, authorization:req.headers.authorization });
      if (upstreamMode === 'auth') { res.writeHead(401, {'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'bad upstream key'}})); }
      if (upstreamMode === 'chat') { res.writeHead(404, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:{ message:'responses route not found' } })); }
      if (upstreamMode === 'responses') {
        if (parsed.model !== 'mock-native-model') { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:`unexpected native model ${parsed.model}`}})); }
        res.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'});
        const id='resp-native';
        res.write(`data: ${JSON.stringify({type:'response.created',response:{id,object:'response',status:'in_progress',model:parsed.model,output:[]}})}\n\n`);
        res.write(`data: ${JSON.stringify({type:'response.output_text.delta',item_id:'msg-native',output_index:0,content_index:0,delta:'REAL_CODEX_NATIVE_OK'})}\n\n`);
        res.write(`data: ${JSON.stringify({type:'response.output_item.done',output_index:0,item:{id:'msg-native',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'REAL_CODEX_NATIVE_OK',annotations:[]}]}})}\n\n`);
        return res.end(`data: ${JSON.stringify({type:'response.completed',response:{id,object:'response',status:'completed',model:parsed.model,output:[],usage:{input_tokens:1,input_tokens_details:{cached_tokens:0},output_tokens:1,output_tokens_details:{reasoning_tokens:0},total_tokens:2}}})}\n\n`);
      }
    }
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}'); trace.chat.push({ model:parsed.model, authorization:req.headers.authorization });
      if (upstreamMode !== 'chat') { res.writeHead(500, {'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'chat endpoint should not have been used'}})); }
      if (parsed.model !== 'mock-chat-model') { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:{message:`unexpected chat model ${parsed.model}`} })); }
      res.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'});
      res.write(`data: ${JSON.stringify({id:'chat-1',choices:[{index:0,delta:{role:'assistant',content:'REAL_CODEX_CHAT_OK'},finish_reason:null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id:'chat-1',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);

  // 3) Real Codex exec -> local gateway -> auto 404 fallback -> Chat SSE -> Responses SSE -> final output.
  const gatewayPort = await freePort();
  const env = { ...process.env, CODEX_HOME:path.join(tmp,'exec-home'), CWD_DATA_DIR:path.join(tmp,'exec-data'), CWD_PORT:String(gatewayPort), CODEX_BIN:codexBin, RUST_BACKTRACE:'1' };
  await fs.mkdir(env.CODEX_HOME,{recursive:true});
  const authSentinel='{"OPENAI_API_KEY":null}\n';
  await fs.writeFile(path.join(env.CODEX_HOME,'auth.json'),authSentinel,{mode:0o600});
  await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'model_provider = "openai"\nmodel = "official-before"\n',{mode:0o600});
  const store = new StateStore({env}); const vault = new SecretVault({env}); const apiKeyCipher=await vault.encrypt('fake-upstream-key');
  const allThird=(model)=>({main:{source:'third_party',model},worker:{source:'third_party',model},verifier:{source:'third_party',model}});
  await store.write({mode:'MAIN',provider:{name:'Fake New API',baseUrl:`http://127.0.0.1:${upstreamPort}/v1`,protocol:'auto',apiKeyCipher,headers:{}},protocolCache:{},profiles:{AUTO:allThird('mock-chat-model'),DELEGATE:allThird('mock-chat-model'),MAIN:allThird('mock-chat-model')},installed:true,originalTopLevel:null});
  await store.ensureGatewayToken();
  const manager = new CodexConfigManager({env,gatewayBaseUrl:`http://127.0.0.1:${gatewayPort}/v1`}); const snap=await manager.install({profile:allThird('mock-chat-model')});
  await store.update((s)=>{s.originalTopLevel=snap.originalTopLevel;return s;});
  app=createApp({env,codexAppServer:{listModels:async()=>codexModels,installLocalPlugin:async()=>plugin}}); await new Promise((resolve)=>app.server.listen(gatewayPort,'127.0.0.1',resolve));

  const chatResult=await run(codexBin,['exec','--skip-git-repo-check','--model','mock-chat-model','Reply exactly with the marker supplied by the model.'],env,30_000);
  assertRun(chatResult,'REAL_CODEX_CHAT_OK','chat fallback');
  let finalState=await store.read(); if(finalState.protocolCache['mock-chat-model']?.protocol!=='chat')throw new Error(`chat protocol cache missing: ${JSON.stringify(finalState.protocolCache)}`);
  if(trace.responses.filter(x=>x.model==='mock-chat-model').length!==1||trace.chat.filter(x=>x.model==='mock-chat-model').length!==1)throw new Error(`expected one Responses probe and one Chat request: ${JSON.stringify(trace)}`);

  // 4) Same real Codex binary -> native Responses upstream, no Chat endpoint involved.
  upstreamMode='responses'; await manager.applyProfile(allThird('mock-native-model')); await store.update((s)=>{s.profiles.MAIN=allThird('mock-native-model');return s;});
  const nativeResult=await run(codexBin,['exec','--skip-git-repo-check','--model','mock-native-model','Reply exactly with the marker supplied by the model.'],env,30_000);
  assertRun(nativeResult,'REAL_CODEX_NATIVE_OK','native responses');
  finalState=await store.read(); if(finalState.protocolCache['mock-native-model']?.protocol!=='responses')throw new Error(`native protocol cache missing: ${JSON.stringify(finalState.protocolCache)}`);
  if(trace.chat.some(x=>x.model==='mock-native-model'))throw new Error('native Responses model incorrectly used Chat Completions');

  // 5) A real 401 must fail as Responses and must never be misclassified/fallback to Chat.
  upstreamMode='auth'; await manager.applyProfile(allThird('mock-auth-model')); await store.update((s)=>{s.profiles.MAIN=allThird('mock-auth-model');return s;});
  const authResult=await run(codexBin,['exec','--skip-git-repo-check','--model','mock-auth-model','This request must fail authentication.'],env,15_000);
  if(authResult.code===0)throw new Error(`auth-error case unexpectedly succeeded\n${authResult.stdout}\n${authResult.stderr}`);
  if(trace.chat.some(x=>x.model==='mock-auth-model'))throw new Error('401 was incorrectly rerouted to Chat Completions');
  finalState=await store.read(); if(finalState.protocolCache['mock-auth-model']?.protocol==='chat')throw new Error('401 was incorrectly cached as chat-only');

  // 6) Restore exact original main selector and prove auth.json was byte-for-byte untouched.
  await manager.restoreOfficial(snap.originalTopLevel);
  const restored=await manager.read(); if(!/^model_provider = "openai"/m.test(restored)||!/^model = "official-before"/m.test(restored))throw new Error(`original main selection not restored:\n${restored}`);
  if(await fs.readFile(path.join(env.CODEX_HOME,'auth.json'),'utf8')!==authSentinel)throw new Error('auth.json changed during integration flow');

  console.log(JSON.stringify({ok:true,codexBinary,visibleCodexModels:codexModels.length,plugin,chatFallback:'ok',nativeResponses:'ok',authNoFallback:'ok',officialAuthIsolation:'ok'}));
} finally {
  await closeServer(app?.server);
  await closeServer(upstream);
  await fs.rm(tmp,{recursive:true,force:true});
}

function assertRun(result,sentinel,label){if(result.timedOut)throw new Error(`${label}: codex exec timed out\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);if(result.code!==0)throw new Error(`${label}: codex exec failed (${result.code})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);if(!result.stdout.includes(sentinel)&&!result.stderr.includes(sentinel))throw new Error(`${label}: sentinel ${sentinel} missing\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`)}
async function listen(server){await new Promise((r)=>server.listen(0,'127.0.0.1',r));return server.address().port}
async function freePort(){const s=http.createServer();const p=await listen(s);await closeServer(s);return p}
async function closeServer(server){if(!server||!server.listening)return;await new Promise((resolve)=>server.close(()=>resolve()))}
async function run(cmd,args,env,timeoutMs){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{env,cwd:repoRoot,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');setTimeout(()=>p.kill('SIGKILL'),1500).unref()},timeoutMs);p.stdout.on('data',(c)=>stdout+=c);p.stderr.on('data',(c)=>stderr+=c);p.on('error',reject);p.on('close',(code)=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut})});p.stdin.end()})}
