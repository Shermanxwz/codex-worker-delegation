import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { SecretVault } from '../src/vault.mjs';

async function providerFetch(url){
  if(String(url).endsWith('/models')) return new Response(JSON.stringify({data:[{id:'third-a',object:'model',owned_by:'test'}]}),{status:200,headers:{'content-type':'application/json'}});
  throw new Error(`unexpected provider URL ${url}`);
}
async function fixture(t,extraEnv={}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-server-hardening-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={...process.env,CWD_DATA_DIR:dir,CODEX_HOME:path.join(dir,'.codex'),CWD_HOST:'127.0.0.1',CWD_PORT:'0',...extraEnv};const app=createApp({env,fetchImpl:providerFetch});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)});t.after(async()=>{await app.workerJobs.close('test cleanup');await new Promise(r=>app.server.close(r))});return{dir,env,app,base:`http://127.0.0.1:${app.server.address().port}`}}
function mac(token,direction,nonce){return crypto.createHmac('sha256',token).update(`cwd-hook-health-v1:${direction}:${nonce}`).digest('base64url')}
async function workerState(app,env){const vault=new SecretVault({env});const apiKeyCipher=await vault.encrypt('fixture-secret');await app.store.write({mode:'DELEGATE',provider:{name:'Fixture API',baseUrl:'https://fixture.example/v1',protocol:'auto',apiKeyCipher,headers:{}},routing:{DELEGATE:{main:{provider:'official',model:'official-a',effort:'auto'},worker:{provider:'third_party',model:'third-a',effort:'auto'},verifier:{provider:'third_party',model:'third-a',effort:'auto'}}}})}

test('internal hook health requires a secret HMAC request and returns a domain-separated response proof',async(t)=>{const {app,base}=await fixture(t);const token=await app.store.ensureGatewayToken();const nonce='a'.repeat(48);let response=await fetch(`${base}/internal/hook-health?nonce=${nonce}`,{headers:{'x-cwd-hook-proof':'forged'}});assert.equal(response.status,401);response=await fetch(`${base}/internal/hook-health?nonce=${nonce}`,{headers:{'x-cwd-hook-proof':mac(token,'request',nonce)}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.version,1);assert.equal(body.nonce,nonce);assert.equal(body.proof,mac(token,'response',nonce));assert.notEqual(body.proof,token)});

test('Worker HTTP boundary rejects oversized tasks before any App Server or provider work starts',async(t)=>{const {app,env,base}=await fixture(t);await workerState(app,env);const token=await app.store.ensureGatewayToken();const response=await fetch(`${base}/internal/worker/start`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({task:'x'.repeat(512*1024+1),role:'worker'})});assert.equal(response.status,413);const body=await response.json();assert.equal(body.code,'WORKER_TASK_TOO_LARGE')});

test('danger-full-access is denied by default and inaccessible cwd is rejected at the server trust boundary',async(t)=>{const {app,env,base}=await fixture(t);await workerState(app,env);const token=await app.store.ensureGatewayToken();let response=await fetch(`${base}/internal/worker/start`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({task:'safe test',role:'worker',cwd:process.cwd(),sandbox:'danger-full-access'})});assert.equal(response.status,403);let body=await response.json();assert.equal(body.code,'DANGER_SANDBOX_DISABLED');response=await fetch(`${base}/internal/worker/start`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({task:'safe test',role:'worker',cwd:path.join(os.tmpdir(),'definitely-missing-cwd-worker-dir'),sandbox:'workspace-write'})});assert.equal(response.status,400);body=await response.json();assert.match(body.error,/cwd is not accessible/)});
