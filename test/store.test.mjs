import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore, publicState, activeRouting } from '../src/store.mjs';

test('v1 state migrates to explicit per-mode provider/model routing',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-state-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={CWD_DATA_DIR:dir};await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({schemaVersion:1,mode:'AUTO',models:{main:'m-main',worker:'m-worker',verifier:'m-ver'},mainSource:'official',provider:{name:'x',apiKeyCipher:'cipher'},protocolCache:{}}));const s=await new StateStore({env}).read();assert.equal(s.schemaVersion,2);assert.equal(s.routing.AUTO.main.provider,'official');assert.equal(s.routing.AUTO.worker.provider,'third_party');assert.equal(s.routing.AUTO.worker.model,'m-worker');assert.equal(activeRouting(s).verifier.model,'m-ver')});

test('publicState redacts ciphertext without mutating source and reports hasApiKey',()=>{const s={schemaVersion:2,mode:'AUTO',provider:{name:'x',apiKeyCipher:'secret'},models:{},routing:{AUTO:{main:{provider:'official',model:''},worker:{provider:'third_party',model:''},verifier:{provider:'third_party',model:''}},DELEGATE:{main:{provider:'official',model:''},worker:{provider:'third_party',model:''},verifier:{provider:'third_party',model:''}},MAIN:{main:{provider:'official',model:''},worker:{provider:'official',model:''},verifier:{provider:'official',model:''}}},protocolCache:{}};const p=publicState(s);assert.equal(p.provider.hasApiKey,true);assert.equal('apiKeyCipher'in p.provider,false);assert.equal(s.provider.apiKeyCipher,'secret')});
