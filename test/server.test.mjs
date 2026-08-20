import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port}
async function tempApp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-web-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={CWD_DATA_DIR:path.join(dir,'data'),CODEX_HOME:path.join(dir,'.codex'),CWD_PORT:'8788'};const app=createApp({env,fetchImpl:fetch});const port=await listen(app.server);t.after(()=>app.server.close());return{dir,env,app,base:`http://127.0.0.1:${port}`}}
async function json(base,pathName,method='GET',body){const r=await fetch(base+pathName,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const j=await r.json();return{r,j}}

test('Web API saves encrypted provider state and installs isolated Codex integration',async(t)=>{const{env,base}=await tempApp(t);let{r,j:state}=await json(base,'/api/provider','PUT',{baseUrl:'https://new.example/v1',apiKey:'sk-secret',protocol:'auto'});assert.equal(r.status,200);assert.equal(state.provider.hasApiKey,true);assert.equal(JSON.stringify(state).includes('sk-secret'),false);({r,state}=await json(base,'/api/codex/install','POST',{}));assert.equal(r.status,200);const config=await fs.readFile(path.join(env.CODEX_HOME,'config.toml'),'utf8');assert.match(config,/codex_worker_gateway/);assert.match(config,/requires_openai_auth = false/);assert.doesNotMatch(config,/sk-secret/);assert.equal(state.installed,true);await assert.rejects(fs.readFile(path.join(env.CODEX_HOME,'auth.json'),'utf8'),/ENOENT/)});

test('routing API persists every role explicitly and same-provider worker resolves to native subagent',async(t)=>{const{base}=await tempApp(t);const roles={main:{provider:'official',model:'official-main'},worker:{provider:'official',model:'official-worker'},verifier:{provider:'third_party',model:'third-verifier'}};let{r,j}=await json(base,'/api/routing','PUT',{mode:'DELEGATE',roles});assert.equal(r.status,200);assert.deepEqual(j.routing.DELEGATE,roles);({r,j}=await json(base,'/api/mode','PUT',{mode:'DELEGATE'}));assert.equal(r.status,200);assert.equal(j.activeRouting.worker.model,'official-worker');({r,j}=await json(base,'/api/worker/run','POST',{role:'worker',task:'implement it'}));assert.equal(r.status,200);assert.equal(j.execution,'native_subagent_required');assert.equal(j.agentType,'cwd-worker');assert.equal(j.model,'official-worker')});

test('MAIN mode refuses worker delegation before starting any app-server thread',async(t)=>{const{base}=await tempApp(t);await json(base,'/api/mode','PUT',{mode:'MAIN'});const{r,j}=await json(base,'/api/worker/run','POST',{role:'worker',task:'should not run'});assert.equal(r.status,500);assert.match(j.error,/MAIN mode disables delegation/)});
