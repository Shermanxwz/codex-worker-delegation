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

test('install adds namespaced provider/roles and restore returns original official selection', async (t) => {
  const env=await tempEnv(t); await fs.mkdir(env.CODEX_HOME,{recursive:true});
  const original = 'model_provider = "openai"\nmodel = "gpt-official"\n\n[features]\nweb_search = true\n\n[model_providers.keep_me]\nbase_url = "https://keep"\n';
  await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),original);
  const m=new CodexConfigManager({env,gatewayBaseUrl:'http://127.0.0.1:8788/v1'});
  const snap=await m.install({workerModel:'worker-x',verifierModel:'verify-x'});
  let text=await m.read();
  assert.match(text,/\[model_providers\.codex_worker_gateway\]/);
  assert.match(text,/\[agents\.cwd-worker\]/);
  assert.match(text,/\[model_providers\.keep_me\]/);
  assert.match(text,/model_provider = "openai"/);
  await m.activateThirdPartyMain('main-x'); text=await m.read();
  assert.match(text,/^model_provider = "codex_worker_gateway"/m);
  assert.match(text,/^model = "main-x"/m);
  await m.restoreOfficial(snap.originalTopLevel); text=await m.read();
  assert.match(text,/^model_provider = "openai"/m); assert.match(text,/^model = "gpt-official"/m);
  assert.match(text,/\[model_providers\.keep_me\]/);
});

test('restore removes top-level selector when user had none', async (t) => {
  const env=await tempEnv(t); await fs.mkdir(env.CODEX_HOME,{recursive:true}); await fs.writeFile(path.join(env.CODEX_HOME,'config.toml'),'[features]\nfoo = true\n');
  const m=new CodexConfigManager({env}); const snap=await m.install({workerModel:'x'}); await m.activateThirdPartyMain('x'); await m.restoreOfficial(snap.originalTopLevel);
  const text=await m.read(); assert.doesNotMatch(text,/^model_provider\s*=/m); assert.doesNotMatch(text,/^model\s*=/m); assert.match(text,/\[features\]/);
});
