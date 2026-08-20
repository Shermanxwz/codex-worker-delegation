import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { StateStore } from '../src/store.mjs';
import { SecretVault } from '../src/vault.mjs';
import { CodexConfigManager } from '../src/codex-config.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-real-codex-'));
const env = { ...process.env, CODEX_HOME: path.join(tmp, '.codex'), CWD_DATA_DIR: path.join(tmp, 'data'), RUST_BACKTRACE: '1' };
let upstream, app;
try {
  upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
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
      res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'REAL_CODEX_E2E_OK' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  const gatewayPort = await freePort();
  env.CWD_PORT = String(gatewayPort);
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const apiKeyCipher = await vault.encrypt('fake-upstream-key');
  await store.write({
    mode: 'AUTO',
    provider: { name: 'Fake Chat-only New API', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'auto', apiKeyCipher, headers: {} },
    protocolCache: {},
    models: { main: 'mock-codex-model', worker: 'mock-codex-model', verifier: 'mock-codex-model' },
    mainSource: 'third_party', installed: false, originalTopLevel: null
  });
  await store.ensureGatewayToken();
  const manager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}/v1` });
  const snap = await manager.install({ workerModel: 'mock-codex-model', verifierModel: 'mock-codex-model' });
  await manager.activateThirdPartyMain('mock-codex-model');
  await store.update((s) => { s.originalTopLevel = snap.originalTopLevel; s.installed = true; return s; });

  app = createApp({ env });
  await new Promise((resolve) => app.server.listen(gatewayPort, '127.0.0.1', resolve));
  const codexBin = process.env.CODEX_BIN || path.resolve('node_modules/.bin/codex');
  const result = await run(codexBin, ['exec', '--skip-git-repo-check', '--model', 'mock-codex-model', 'Reply exactly with the marker you receive from the model.'], env, 45000);
  if (result.timedOut) throw new Error(`codex exec timed out\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  if (result.code !== 0) throw new Error(`codex exec failed (${result.code})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  if (!result.stdout.includes('REAL_CODEX_E2E_OK') && !result.stderr.includes('REAL_CODEX_E2E_OK')) throw new Error(`sentinel missing\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const finalState = await store.read();
  if (finalState.protocolCache['mock-codex-model']?.protocol !== 'chat') throw new Error(`expected chat fallback cache, got ${JSON.stringify(finalState.protocolCache)}`);
  console.log(JSON.stringify({ ok: true, codexOutput: 'REAL_CODEX_E2E_OK', detectedProtocol: 'chat' }));
} finally {
  await new Promise((r) => app?.server?.close(() => r())).catch(() => {});
  await new Promise((r) => upstream?.close(() => r())).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
}

async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }
async function run(cmd, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, cwd: process.cwd() }); let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 2000).unref(); }, timeoutMs);
    p.stdout.on('data', (c) => stdout += c); p.stderr.on('data', (c) => stderr += c); p.on('error', reject); p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}
