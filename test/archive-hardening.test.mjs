import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient, CodexAppServerError, CodexAppServerPool, withCodexAppServer } from '../src/app-server.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { StateStore } from '../src/store.mjs';
import { WebAuth } from '../src/web-auth.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));
  return dir;
}

async function fakeCodex(t, source, prefix = 'cwd-archive-codex-') {
  const dir = await tempDir(t, prefix);
  const script = path.join(dir, 'codex');
  await fs.writeFile(script, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return script;
}

const lineProtocol = `
let buffer='';
function out(value){process.stdout.write(JSON.stringify(value)+'\\n')}
process.stdin.setEncoding('utf8');
process.stdin.on('data',(chunk)=>{
  buffer+=chunk;
  while(true){
    const index=buffer.indexOf('\\n');
    if(index<0)return;
    const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
    if(!line)continue;
    const message=JSON.parse(line);
    handle(message);
  }
});
`;

test('turn/start failure removes the pre-registered completion waiter and stale extension authority', async (t) => {
  const script = await fakeCodex(t, `${lineProtocol}
function handle(m){
  if(m.method==='initialize')out({id:m.id,result:{}});
  else if(m.method==='thread/start')out({id:m.id,result:{thread:{id:'thread-fail'},model:m.params.model,modelProvider:m.params.modelProvider}});
  else if(m.method==='turn/start')out({id:m.id,error:{code:-32001,message:'turn rejected'}});
}
setInterval(()=>{},1<<30);`);
  const client = new CodexAppServerClient({ binary: script, timeoutMs: 1000 });
  await client.start();
  t.after(() => client.close());
  await assert.rejects(
    () => client.runThread({ model: 'third-a', modelProvider: 'codex_worker_gateway', prompt: 'work', timeoutMs: 100 }),
    (error) => error instanceof CodexAppServerError && error.code === -32001
  );
  assert.throws(
    () => client.extendTurnTimeout(1000),
    (error) => error.code === 'CODEX_TURN_EXTENSION_UNAVAILABLE',
    'failed turn/start must leave neither a completion waiter nor extension authority for a future turn'
  );
});

test('an active pooled App Server is never shared and one operation timeout cannot kill another', async (t) => {
  const script = await fakeCodex(t, `${lineProtocol}
function handle(m){
  if(m.method==='initialize')out({id:m.id,result:{}});
  else if(m.method==='account/read')out({id:m.id,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}});
}
setInterval(()=>{},1<<30);`);
  const pool = new CodexAppServerPool({ idleMs: 60000 });
  t.after(() => pool.close());
  let firstClient = null;
  let secondClient = null;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const first = withCodexAppServer(async (client) => {
    firstClient = client;
    entered();
    await new Promise(() => {});
  }, { pool, binary: script, timeoutMs: 1000, overallTimeoutMs: 200 });
  await firstEntered;
  const second = withCodexAppServer(async (client) => {
    secondClient = client;
    await sleep(300);
    return client.getAccount();
  }, { pool, binary: script, timeoutMs: 1000, overallTimeoutMs: 1500 });
  await assert.rejects(first, (error) => error.code === 'CODEX_APP_SERVER_OVERALL_TIMEOUT');
  const account = await second;
  assert.notEqual(firstClient, secondClient, 'simultaneous operations must receive isolated clients');
  assert.equal(account.account.type, 'chatgpt', 'the surviving operation must remain usable after the other client is aborted');
});

test('same-client concurrent turn extension fails closed instead of extending the wrong turn', async (t) => {
  const script = await fakeCodex(t, `${lineProtocol}
let thread=0;
function handle(m){
  if(m.method==='initialize')out({id:m.id,result:{}});
  else if(m.method==='thread/start'){thread+=1;out({id:m.id,result:{thread:{id:'thread-'+thread},model:m.params.model,modelProvider:m.params.modelProvider}})}
  else if(m.method==='turn/start')out({id:m.id,result:{turn:{id:'turn-'+m.params.threadId,status:'inProgress'}}});
}
setInterval(()=>{},1<<30);`);
  const client = new CodexAppServerClient({ binary: script, timeoutMs: 1000 });
  await client.start();
  const one = client.runThread({ model: 'third-a', modelProvider: 'codex_worker_gateway', prompt: 'one', timeoutMs: 5000 });
  const two = client.runThread({ model: 'third-b', modelProvider: 'codex_worker_gateway', prompt: 'two', timeoutMs: 5000 });
  await sleep(100);
  assert.throws(() => client.extendTurnTimeout(1000), (error) => error.code === 'CODEX_TURN_EXTENSION_AMBIGUOUS');
  await client.abort('test complete');
  const settled = await Promise.allSettled([one, two]);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 2);
});

test('independent StateStore instances serialize audit rotation without loss or malformed JSON', async (t) => {
  const dir = await tempDir(t, 'cwd-archive-audit-');
  const env = { CWD_DATA_DIR: dir, CWD_AUDIT_MAX_BYTES: '65536', CWD_AUDIT_MAX_FILES: '3' };
  const a = new StateStore({ env });
  const b = new StateStore({ env });
  const writes = [];
  for (let index = 0; index < 100; index += 1) {
    const store = index % 2 === 0 ? a : b;
    writes.push(store.audit('archive.concurrent', { id: index, payload: 'x'.repeat(1200) }));
  }
  await Promise.all(writes);
  const files = ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'audit.jsonl.3'];
  const rows = [];
  for (const name of files) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  }
  const ids = rows.filter((row) => row.event === 'archive.concurrent').map((row) => row.id).sort((left, right) => left - right);
  assert.deepEqual(ids, Array.from({ length: 100 }, (_, index) => index));
});

test('concurrent Web password rotations use independent durable temporary files', async (t) => {
  const dir = await tempDir(t, 'cwd-archive-auth-');
  const auth = new WebAuth({ env: { CWD_DATA_DIR: dir } });
  await auth.setPassword('InitialPassword-123!');
  await Promise.all([
    auth.changePassword('RotatedPassword-456!'),
    auth.changePassword('AlternatePassword-789!')
  ]);
  const validA = await auth.verifyPassword('RotatedPassword-456!');
  const validB = await auth.verifyPassword('AlternatePassword-789!');
  assert.equal(validA || validB, true);
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.password.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal((await fs.stat(path.join(dir, 'web-auth.json'))).mode & 0o777, 0o600);
});

test('concurrent project config mutations serialize and preserve one namespaced provider', async (t) => {
  const dir = await tempDir(t, 'cwd-archive-config-');
  const env = { CODEX_HOME: path.join(dir, '.codex'), CWD_DATA_DIR: path.join(dir, 'data') };
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), 'model_provider = "openai"\nmodel = "official"\n');
  const first = new CodexConfigManager({ env });
  const second = new CodexConfigManager({ env });
  await Promise.all([first.install(), second.install()]);
  const text = await first.read();
  assert.equal((text.match(/\[model_providers\.codex_worker_gateway\]/g) || []).length, 1);
  assert.match(text, /^model_provider = "openai"/m);
  assert.match(text, /^model = "official"/m);
  await Promise.all([first.setReasoningEffort('high'), second.install()]);
  const after = await first.read();
  assert.match(after, /^model_reasoning_effort = "high"/m);
  assert.equal((after.match(/\[model_providers\.codex_worker_gateway\]/g) || []).length, 1);
});

test('production launch contracts require authentication by default', async () => {
  for (const file of ['deploy/codex-worker-delegation.service', 'deploy/codex-worker-delegation.root.service']) {
    assert.match(await fs.readFile(file, 'utf8'), /^Environment=CWD_REQUIRE_AUTH=1$/m, `${file} must fail closed before Web password setup`);
  }
  assert.match(await fs.readFile('scripts/start-local.sh', 'utf8'), /CWD_REQUIRE_AUTH:-1/);
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.match(pkg.scripts.start, /CWD_REQUIRE_AUTH=\$\{CWD_REQUIRE_AUTH:-1\}/);
});
