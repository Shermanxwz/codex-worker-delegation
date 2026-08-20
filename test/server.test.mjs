import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.mjs';

async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port}

test('Web API exposes Codex/New API catalogs, saves mode-specific topology, and installs through app-server without touching auth',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-web-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const env={CWD_DATA_DIR:path.join(dir,'data'),CODEX_HOME:path.join(dir,'.codex'),CWD_PORT:'8788'};
  await fs.mkdir(env.CODEX_HOME,{recursive:true}); const authSentinel='{"OPENAI_API_KEY":null}\n'; await fs.writeFile(path.join(env.CODEX_HOME,'auth.json'),authSentinel);
  const upstream=http.createServer((req,res)=>{if(req.url==='/v1/models'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'third-a'},{id:'third-b'}]}))}res.writeHead(404).end()}); const upPort=await listen(upstream);t.after(()=>upstream.close());
  let installCalls=0;
  const codexAppServer={
    listModels:async()=>[{id:'gpt-5.6-sol',model:'gpt-5.6-sol',displayName:'GPT-5.6 Sol',description:'official',isDefault:true,multiAgentVersion:'v2',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],
    installLocalPlugin:async()=>{installCalls++;return{pluginId:'codex-worker-delegation@local',installed:true,enabled:true}}
  };
  const app=createApp({env,codexAppServer});const port=await listen(app.server);t.after(()=>app.server.close());const base=`http://127.0.0.1:${port}`;
  let r=await fetch(base+'/api/provider',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:`http://127.0.0.1:${upPort}/v1`,apiKey:'sk-secret',protocol:'auto'})});assert.equal(r.status,200);let state=await r.json();assert.equal(state.provider.hasApiKey,true);assert.equal(JSON.stringify(state).includes('sk-secret'),false);
  r=await fetch(base+'/api/models?refresh=1');assert.equal(r.status,200);const catalogs=await r.json();assert.equal(catalogs.official.data[0].id,'gpt-5.6-sol');assert.deepEqual(catalogs.thirdParty.data.map(x=>x.id),['third-a','third-b']);assert.equal(catalogs.official.data[0].multiAgentVersion,'v2');
  const profile={main:{source:'official',model:'gpt-5.6-sol'},worker:{source:'third_party',model:'third-a'},verifier:{source:'official',model:'gpt-5.6-sol'}};
  r=await fetch(base+'/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'DELEGATE',profile})});assert.equal(r.status,200);
  await fetch(base+'/api/mode',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'DELEGATE'})});
  r=await fetch(base+'/api/codex/install',{method:'POST'});assert.equal(r.status,200);const installed=await r.json();assert.equal(installed.state.integration.transport,'app-server');assert.equal(installCalls,1);
  const config=await fs.readFile(path.join(env.CODEX_HOME,'config.toml'),'utf8');assert.match(config,/codex_worker_gateway/);assert.match(config,/^model_provider = "openai"/m);assert.doesNotMatch(config,/sk-secret/);
  const worker=await fs.readFile(path.join(env.CODEX_HOME,'cwd-worker.config.toml'),'utf8');assert.match(worker,/model = "third-a"/);assert.match(worker,/codex_worker_gateway/);
  const verifier=await fs.readFile(path.join(env.CODEX_HOME,'cwd-verifier.config.toml'),'utf8');assert.match(verifier,/model_provider = "openai"/);
  assert.equal(await fs.readFile(path.join(env.CODEX_HOME,'auth.json'),'utf8'),authSentinel);
});

test('each mode preserves an independent model topology',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-mode-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={CWD_DATA_DIR:path.join(dir,'data'),CODEX_HOME:path.join(dir,'.codex')};const app=createApp({env,codexAppServer:{listModels:async()=>[],installLocalPlugin:async()=>({pluginId:'x',installed:true,enabled:true})}});const port=await listen(app.server);t.after(()=>app.server.close());const base=`http://127.0.0.1:${port}`;const p=(name)=>({main:{source:'official',model:`${name}-main`},worker:{source:'official',model:`${name}-worker`},verifier:{source:'official',model:`${name}-verifier`}});for(const mode of ['AUTO','DELEGATE','MAIN']){const r=await fetch(base+'/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode,profile:p(mode)})});assert.equal(r.status,200)}const s=await(await fetch(base+'/api/state')).json();assert.equal(s.profiles.AUTO.main.model,'AUTO-main');assert.equal(s.profiles.DELEGATE.worker.model,'DELEGATE-worker');assert.equal(s.profiles.MAIN.main.model,'MAIN-main')});

test('MAIN mode requires only the visible main selector and fills inactive hidden roles without leaking to other modes', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-main-only-'));
  const env = { ...process.env, CODEX_HOME: path.join(tmp, '.codex'), CWD_DATA_DIR: path.join(tmp, 'data'), CWD_PORT: '0' };
  const fakeCodex = {
    async listModels() { return [{ id: 'gpt-main', model: 'gpt-main', displayName: 'GPT Main', supportedReasoningEfforts: [] }]; },
    async installLocalPlugin() { return { pluginId: 'codex-worker-delegation@test', installed: true, enabled: true }; },
  };
  const app = createApp({ env, codexAppServer: fakeCodex });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    let r = await fetch(`${base}/api/mode`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ mode: 'MAIN' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/profile`, { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ mode: 'MAIN', profile: { main: { source: 'official', model: 'gpt-main' }, worker: { source: 'third_party', model: '' }, verifier: { source: 'third_party', model: '' } } }) });
    const responseText = await r.text();
    assert.equal(r.status, 200, responseText);
    const body = JSON.parse(responseText);
    assert.deepEqual(body.profiles.MAIN.worker, { source: 'official', model: 'gpt-main' });
    assert.deepEqual(body.profiles.MAIN.verifier, { source: 'official', model: 'gpt-main' });
    assert.equal(body.profiles.DELEGATE.worker.model, '');
    assert.equal(body.profiles.AUTO.worker.model, '');
  } finally {
    await new Promise((r) => app.server.close(r));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
