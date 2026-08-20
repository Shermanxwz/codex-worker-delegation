import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';
import { withCodexAppServer } from '../src/app-server.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-real-codex-'));
const gatewayPort = await freePort();
const env = {
  ...process.env,
  CODEX_HOME: path.join(tmp, '.codex'),
  CWD_DATA_DIR: path.join(tmp, 'data'),
  CWD_PORT: String(gatewayPort),
  CODEX_BIN: process.env.CODEX_BIN || path.resolve('node_modules/.bin/codex')
};
let upstream, app;
try {
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  const originalConfig = 'model_provider = "openai"\nmodel = "official-preserved"\n';
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), originalConfig);

  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-codex-model', object: 'model', owned_by: 'fake' }] }));
    }
    if (req.url === '/v1/responses') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'responses route not found' } }));
    }
    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      if (parsed.model !== 'mock-codex-model') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `unexpected model ${parsed.model}` } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'REAL_CROSS_PROVIDER_E2E_OK' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const apiKeyCipher = await vault.encrypt('fake-upstream-key');
  await store.write({
    mode: 'DELEGATE',
    provider: { name: 'Fake Chat-only New API', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'auto', apiKeyCipher, headers: {} },
    protocolCache: {},
    routing: {
      AUTO: { main: { provider: 'official', model: 'official-preserved' }, worker: { provider: 'third_party', model: 'mock-codex-model' }, verifier: { provider: 'third_party', model: 'mock-codex-model' } },
      DELEGATE: { main: { provider: 'official', model: 'official-preserved' }, worker: { provider: 'third_party', model: 'mock-codex-model' }, verifier: { provider: 'third_party', model: 'mock-codex-model' } },
      MAIN: { main: { provider: 'official', model: 'official-preserved' }, worker: { provider: 'official', model: 'official-preserved' }, verifier: { provider: 'official', model: 'official-preserved' } }
    },
    installed: false
  });
  await store.ensureGatewayToken();
  const manager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}/v1` });
  await manager.install();
  await store.update((s) => { s.installed = true; return s; });

  const afterInstall = await fs.readFile(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  if (!afterInstall.includes('model_provider = "openai"') || !afterInstall.includes('model = "official-preserved"')) throw new Error(`official selector was modified:\n${afterInstall}`);
  if (afterInstall.includes('fake-upstream-key')) throw new Error('third-party API key leaked into Codex config');
  await fs.access(path.join(env.CODEX_HOME, 'auth.json')).then(() => { throw new Error('test unexpectedly created auth.json'); }).catch((e) => { if (e.message === 'test unexpectedly created auth.json') throw e; });

  app = createApp({ env });
  await new Promise((resolve) => app.server.listen(gatewayPort, '127.0.0.1', resolve));
  const result = await withCodexAppServer((client) => client.runThread({
    model: 'mock-codex-model',
    modelProvider: 'codex_worker_gateway',
    prompt: 'Reply exactly with the marker from the model.',
    cwd: tmp,
    sandbox: 'read-only',
    timeoutMs: 120000
  }), { env, timeoutMs: 15000 });
  if (!result.output.includes('REAL_CROSS_PROVIDER_E2E_OK')) throw new Error(`sentinel missing: ${JSON.stringify(result)}`);
  const finalState = await store.read();
  if (finalState.protocolCache['mock-codex-model']?.protocol !== 'chat') throw new Error(`expected chat fallback cache, got ${JSON.stringify(finalState.protocolCache)}`);
  console.log(JSON.stringify({ ok: true, execution: 'codex app-server explicit modelProvider', output: result.output, detectedProtocol: 'chat', officialSelectorPreserved: true }));
} finally {
  await new Promise((r) => app?.server?.close(() => r())).catch(() => {});
  await new Promise((r) => upstream?.close(() => r())).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
}

async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }
