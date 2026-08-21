import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore, publicState, activeRouting } from '../src/store.mjs';

test('v1 state migrates to compact per-mode provider/model routing',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={CWD_DATA_DIR:dir};await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({schemaVersion:1,mode:'AUTO',models:{main:'m-main',worker:'m-worker',verifier:'m-ver'},mainSource:'official',provider:{name:'x',apiKeyCipher:'cipher'},protocolCache:{}}));const s=await new StateStore({env}).read();assert.equal(s.schemaVersion,4);assert.equal(s.routing.AUTO.main.provider,'official');assert.equal(s.routing.AUTO.worker.provider,'official');assert.equal(s.routing.AUTO.worker.model,'m-main');assert.equal(s.routing.AUTO.main.effort,'auto');assert.equal(activeRouting(s).verifier.model,'m-main');assert.equal(s.routing.DELEGATE.worker.provider,'third_party');assert.equal(s.routing.DELEGATE.worker.model,'m-worker');assert.equal(s.routing.DELEGATE.worker.effort,'auto')});

test('publicState redacts ciphertext without mutating source and reports hasApiKey',()=>{const s={schemaVersion:2,mode:'AUTO',provider:{name:'x',apiKeyCipher:'secret'},models:{},routing:{AUTO:{main:{provider:'official',model:''},worker:{provider:'third_party',model:''},verifier:{provider:'third_party',model:''}},DELEGATE:{main:{provider:'official',model:''},worker:{provider:'third_party',model:''},verifier:{provider:'third_party',model:''}},MAIN:{main:{provider:'official',model:''},worker:{provider:'official',model:''},verifier:{provider:'official',model:''}}},protocolCache:{}};const p=publicState(s);assert.equal(p.provider.hasApiKey,true);assert.equal('apiKeyCipher'in p.provider,false);assert.equal(s.provider.apiKeyCipher,'secret')});

test('gateway token creation is stable under concurrent first access',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-token-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new StateStore({env:{CWD_DATA_DIR:dir}});const tokens=await Promise.all(Array.from({length:20},()=>store.ensureGatewayToken()));assert.equal(new Set(tokens).size,1);assert.equal((await fs.readFile(path.join(dir,'gateway.token'),'utf8')).trim(),tokens[0]);
});

test('concurrent state mutations are serialized so independent updates cannot overwrite each other',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-state-concurrency-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new StateStore({env:{CWD_DATA_DIR:dir}});
  await Promise.all([
    store.update(async(state)=>{await new Promise((resolve)=>setTimeout(resolve,40));state.protocolCache.alpha={protocol:'responses'};return state;}),
    store.update(async(state)=>{state.installed=true;return state;})
  ]);
  const final=await store.read();
  assert.equal(final.installed,true);
  assert.deepEqual(final.protocolCache.alpha,{protocol:'responses'});
});
