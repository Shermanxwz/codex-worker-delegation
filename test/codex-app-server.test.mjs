import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerService } from '../src/codex-app-server.mjs';

async function fakeCodex(t, repoRoot) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-appserver-'));
  t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const file = path.join(dir, 'codex');
  const script = `#!/usr/bin/env node
import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){if(!line.trim())continue;const m=JSON.parse(line);if(m.id==null)continue;let result={};
if(m.method==='initialize')result={userAgent:'fake',codexHome:${JSON.stringify(dir)}};
else if(m.method==='model/list'){if(!m.params.cursor)result={data:[{id:'gpt-a',model:'gpt-a',displayName:'GPT A',description:'a',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium',description:''}],defaultReasoningEffort:'medium',isDefault:true,multiAgentVersion:'v2'}],nextCursor:'p2'};else result={data:[{id:'gpt-b',model:'gpt-b',displayName:'GPT B',description:'b',hidden:false,supportedReasoningEfforts:[],defaultReasoningEffort:'low',isDefault:false,multiAgentVersion:null}],nextCursor:null};}
else if(m.method==='marketplace/add')result={marketplaceName:'codex-worker-delegation-local',installedRoot:${JSON.stringify(repoRoot)},alreadyAdded:false};
else if(m.method==='plugin/install')result={authPolicy:'ON_USE',appsNeedingAuth:[]};
else if(m.method==='plugin/installed')result={marketplaces:[{name:'codex-worker-delegation-local',path:${JSON.stringify(path.join(repoRoot,'.agents/plugins/marketplace.json'))},plugins:[{id:'codex-worker-delegation@codex-worker-delegation-local',name:'codex-worker-delegation',installed:true,enabled:true}]}],marketplaceLoadErrors:[]};
else {process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'unknown '+m.method}})+'\\n');continue;}
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}`;
  await fs.writeFile(file, script, { mode:0o755 });
  return file;
}

test('app-server client paginates Codex model/list and installs plugin through native API', async (t) => {
  const repoRoot = path.resolve('.');
  const codexBin = await fakeCodex(t, repoRoot);
  const service = new CodexAppServerService({ codexBin, cwd:repoRoot, env:{...process.env}, timeoutMs:3000 });
  const models = await service.listModels();
  assert.deepEqual(models.map((x)=>x.model), ['gpt-a','gpt-b']);
  assert.equal(models[0].multiAgentVersion, 'v2');
  const installed = await service.installLocalPlugin(repoRoot);
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.pluginId, 'codex-worker-delegation@codex-worker-delegation-local');
});
