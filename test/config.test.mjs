import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexConfigManager } from '../src/codex-config.mjs';

async function tempEnv(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'cwd-config-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return { CODEX_HOME:path.join(dir,'.codex'), CWD_DATA_DIR:path.join(dir,'data') };
}

test('install adds only namespaced provider and current auto-discovered agent files without changing official selector', async (t) => {
  const env=await tempEnv(t); await fs.mkdir(env.CODEX_HOME,{recursive:true});
  const original = 'model_provider = "openai"\nmodel = "gpt-official"\n\n[features]\nweb_search = true\n\n[model_providers.keep_me]\nbase_url = "https://keep"\n';
  await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),original);
  const m=new CodexConfigManager({env,gatewayBaseUrl:'http://127.0.0.1:8788/v1'});
  await m.install();
  const text=await m.read();
  assert.match(text,/\[model_providers\.codex_worker_gateway\]/);
  assert.match(text,/wire_api = "responses"/);
  assert.match(text,/requires_openai_auth = false/);
  assert.match(text,/\[model_providers\.keep_me\]/);
  assert.match(text,/^model_provider = "openai"/m);
  assert.match(text,/^model = "gpt-official"/m);
  assert.doesNotMatch(text,/\[agents\.cwd-worker\]/);
  const worker=await fs.readFile(path.join(env.CODEX_HOME,'agents','cwd-worker.toml'),'utf8');
  const verifier=await fs.readFile(path.join(env.CODEX_HOME,'agents','cwd-verifier.toml'),'utf8');
  assert.match(worker,/name = "cwd-worker"/); assert.match(worker,/developer_instructions/);
  assert.match(verifier,/name = "cwd-verifier"/); assert.match(verifier,/independent verifier/i);
  assert.doesNotMatch(worker,/model_provider/); assert.doesNotMatch(verifier,/model_provider/);
});

test('restore official returns the original top-level selector after an explicit legacy switch', async (t) => {
  const env=await tempEnv(t); await fs.mkdir(env.CODEX_HOME,{recursive:true});
  await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'model_provider = "openai"\nmodel = "gpt-official"\n');
  const m=new CodexConfigManager({env}); const snap=await m.install();
  await m.activateThirdPartyMain('third-x'); let text=await m.read();
  assert.match(text,/^model_provider = "codex_worker_gateway"/m);
  await m.restoreOfficial(snap.originalTopLevel); text=await m.read();
  assert.match(text,/^model_provider = "openai"/m); assert.match(text,/^model = "gpt-official"/m);
});
