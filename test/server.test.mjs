import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port}
test('Web API saves encrypted provider state and installs isolated Codex integration',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-web-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const env={CWD_DATA_DIR:path.join(dir,'data'),CODEX_HOME:path.join(dir,'.codex'),CWD_PORT:'8788'};const app=createApp({env,fetchImpl:fetch});const port=await listen(app.server);t.after(()=>app.server.close());const base=`http://127.0.0.1:${port}`;let r=await fetch(base+'/api/provider',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:'https://new.example/v1',apiKey:'sk-secret',protocol:'auto',models:{main:'m-main',worker:'m-worker',verifier:'m-ver'}})});assert.equal(r.status,200);let state=await r.json();assert.equal(state.provider.hasApiKey,true);assert.equal(JSON.stringify(state).includes('sk-secret'),false);r=await fetch(base+'/api/codex/install',{method:'POST'});assert.equal(r.status,200);const config=await fs.readFile(path.join(env.CODEX_HOME,'config.toml'),'utf8');assert.match(config,/codex_worker_gateway/);assert.doesNotMatch(config,/sk-secret/);await assert.rejects(fs.readFile(path.join(env.CODEX_HOME,'auth.json'),'utf8'),/ENOENT/)});
