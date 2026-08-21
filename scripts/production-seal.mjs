import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { codexBinaryCandidates, resolveCodexBinary } from '../src/app-server.mjs';
import { CodexConfigManager, inspectTopLevel, sameTopLevelSelectors } from '../src/codex-config.mjs';
import { activeRouting, StateStore } from '../src/store.mjs';
import { codexHome } from '../src/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE = 'codex-worker-delegation-local';
const SEAL_MARKER = 'CWD_PRODUCTION_SEAL_OK';
const checks = [];

function redact(value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value ?? ''); }
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]')
    .replace(/(apiKey|api_key|token|secret|password)(["'=:\s]+)[^,\s}\]]+/gi, '$1$2[redacted]');
}

function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail: redact(detail) }) });
}

function command(args, env) {
  const result = spawnSync(args[0], args.slice(1), { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
  return {
    ok: result.status === 0,
    status: result.status,
    output: redact([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim())
  };
}

async function fileSnapshot(file) {
  try {
    const bytes = await fs.readFile(file);
    return { exists: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, sha256: null };
    throw error;
  }
}

async function freePort() {
  const server = (await import('node:http')).createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function requestJson(base, env, pathname, method = 'GET', body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (env.CWD_WEB_TOKEN) headers.authorization = `Bearer ${env.CWD_WEB_TOKEN}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text }; }
  if (!response.ok) throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${redact(value?.error || value?.raw || text)}`);
  return value;
}

async function run() {
  const port = await freePort();
  const env = {
    ...process.env,
    CWD_HOST: '127.0.0.1',
    CWD_PORT: String(port),
    CWD_WEB_TOKEN: process.env.CWD_WEB_TOKEN || crypto.randomBytes(32).toString('hex')
  };
  const binary = resolveCodexBinary(env);
  env.CODEX_BIN = binary;
  const runtimePath = path.dirname(process.execPath);
  env.PATH = `${runtimePath}${path.delimiter}${env.PATH || ''}`;
  const home = codexHome(env);
  const configFile = path.join(home, 'config.toml');
  const authFile = path.join(home, 'auth.json');
  const beforeAuth = await fileSnapshot(authFile);
  const configManager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });
  const beforeSelectors = inspectTopLevel(await configManager.read());
  let app;

  try {
    const binaryInfo = command([binary, '--version'], env);
    record('official Codex runtime', binaryInfo.ok, binaryInfo.ok ? binaryInfo.output : `could not execute ${binary}: ${binaryInfo.output}`);
    const desktopPath = codexBinaryCandidates(env).find((candidate) => candidate === '/usr/lib/chatgpt/resources/codex');
    const desktopPresent = desktopPath && await fs.access(desktopPath).then(() => true).catch(() => false);
    record('ChatGPT Linux bundled runtime discovery', desktopPresent, desktopPresent ? desktopPath : `packaged path not found; resolved ${binary}`);

    const checkResult = command([process.execPath, 'scripts/check.mjs'], env);
    record('repository static/check contract', checkResult.ok, checkResult.output);
    if (!checkResult.ok) throw new Error('repository check failed');
    const testFiles = (await fs.readdir(path.join(ROOT, 'test'))).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('test', name));
    const testResult = command([process.execPath, '--test', ...testFiles], env);
    record('repository test suite', testResult.ok, testResult.output);
    if (!testResult.ok) throw new Error('repository test suite failed');

    const pluginResult = command(['bash', 'scripts/install.sh'], env);
    record('official Codex plugin installation', pluginResult.ok, pluginResult.output);
    if (!pluginResult.ok) throw new Error('official Codex plugin installation failed');
    const pluginList = command([binary, 'plugin', 'list', '--json'], env);
    const pluginInstalled = pluginList.ok && pluginList.output.includes(`codex-worker-delegation@${MARKETPLACE}`);
    record('plugin is installed and enabled', pluginInstalled, pluginInstalled ? `codex-worker-delegation@${MARKETPLACE}` : pluginList.output);
    if (!pluginInstalled) throw new Error('plugin manager did not report the project plugin as installed');

    const store = new StateStore({ env });
    const beforeState = await store.read();
    const thirdPartyConfigured = Boolean(beforeState.provider?.apiKeyCipher);
    record('encrypted New API provider is configured', thirdPartyConfigured, thirdPartyConfigured ? beforeState.provider.name || 'configured' : 'configure the provider in the Web panel first');
    if (!thirdPartyConfigured) throw new Error('encrypted New API provider is not configured');

    app = createApp({ env });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${port}`;
    const health = await requestJson(base, env, '/api/health');
    record('loopback control plane health', health?.ok === true, `${health?.host}:${health?.port}`);

    const installed = await requestJson(base, env, '/api/codex/install', 'POST', {});
    record('namespaced Codex provider installed without selector switching', installed?.installed === true, installed?.installed ? 'installed' : installed);
    if (installed?.installed !== true) throw new Error('Codex integration install did not complete');

    const catalog = await requestJson(base, env, '/api/catalog');
    const officialAccountType = catalog?.official?.account?.type || null;
    record('official ChatGPT account is readable', catalog?.official?.ok === true && officialAccountType === 'chatgpt', { type: officialAccountType, error: catalog?.official?.error || null });
    record('third-party model discovery is live', catalog?.thirdParty?.ok === true && Array.isArray(catalog?.thirdParty?.models) && catalog.thirdParty.models.length > 0, { count: catalog?.thirdParty?.models?.length || 0, error: catalog?.thirdParty?.error || null });
    if (catalog?.official?.ok !== true || officialAccountType !== 'chatgpt') throw new Error('official ChatGPT account proof failed');
    if (catalog?.thirdParty?.ok !== true || !catalog.thirdParty.models?.length) throw new Error('third-party model discovery failed');

    const connectivity = await requestJson(base, env, '/api/provider/connectivity', 'POST', {});
    const connectivityResults = Array.isArray(connectivity?.results) ? connectivity.results : [];
    const connectivityPassed = connectivityResults.filter((result) => result.ok === true);
    record('third-party model connectivity matrix executed', connectivityResults.length === catalog.thirdParty.models.length && connectivityPassed.length > 0, {
      tested: connectivityResults.length,
      catalog: catalog.thirdParty.models.length,
      passed: connectivityPassed.length,
      failed: connectivityResults.filter((result) => !result.ok).map((result) => ({ model: result.model, protocol: result.protocol, status: result.status, error: result.error }))
    });
    if (!connectivityPassed.length) throw new Error('no third-party chat model passed connectivity');

    const state = await store.read();
    const routeCandidates = [];
    for (const mode of ['DELEGATE', 'AUTO']) {
      const routes = activeRouting(state, mode);
      for (const role of ['worker', 'verifier', 'main']) {
        if (routes[role]?.provider === 'third_party' && routes[role]?.model) routeCandidates.push({ mode, role, model: routes[role].model });
      }
    }
    const coexistenceModel = routeCandidates[0]?.model || catalog.thirdParty.models[0]?.id;
    const coexistence = await requestJson(base, env, '/api/verify/coexistence', 'POST', { model: coexistenceModel, cwd: ROOT, timeoutMs: 180000 });
    record('real official/New API coexistence proof', coexistence?.ok === true && coexistence?.thirdParty?.markerObserved === true, {
      ok: coexistence?.ok,
      markerObserved: coexistence?.thirdParty?.markerObserved,
      officialBefore: coexistence?.officialChatGPTBefore?.type,
      officialAfter: coexistence?.officialChatGPTAfter?.type,
      selectorUntouched: coexistence?.globalSelectorUntouched,
      threadId: coexistence?.thirdParty?.threadId
    });
    if (coexistence?.ok !== true || coexistence?.thirdParty?.markerObserved !== true) throw new Error('real coexistence proof failed');

    const workerRoute = routeCandidates.find((candidate) => candidate.role === 'worker');
    if (!workerRoute) throw new Error('configure a third-party Worker model in AUTO or DELEGATE mode before sealing');
    const worker = await requestJson(base, env, '/api/worker/run', 'POST', {
      mode: workerRoute.mode,
      role: 'worker',
      task: `Reply exactly with ${SEAL_MARKER}. Do not use tools.`
    });
    record('real third-party Worker delegation', worker?.provider === 'third_party' && worker?.status === 'completed' && worker?.output?.includes(SEAL_MARKER), {
      mode: workerRoute.mode,
      model: workerRoute.model,
      execution: worker?.execution,
      status: worker?.status,
      markerObserved: worker?.output?.includes(SEAL_MARKER) || false,
      threadId: worker?.threadId
    });

    const afterAuth = await fileSnapshot(authFile);
    const afterSelectors = inspectTopLevel(await configManager.read());
    record('ChatGPT auth.json is byte-for-byte unchanged', beforeAuth.exists === afterAuth.exists && beforeAuth.sha256 === afterAuth.sha256, { existed: beforeAuth.exists, sha256Unchanged: beforeAuth.sha256 === afterAuth.sha256 });
    record('official top-level model selectors are unchanged', sameTopLevelSelectors(beforeSelectors, afterSelectors), { before: Object.keys(beforeSelectors), after: Object.keys(afterSelectors) });
    record('managed provider config is present', (await fs.readFile(configFile, 'utf8')).includes('[model_providers.codex_worker_gateway]'), configFile);
  } finally {
    await new Promise((resolve) => app?.server?.close(() => resolve())).catch(() => {});
  }
}

try {
  await run();
} catch (error) {
  record('seal execution', false, error?.stack || error?.message || error);
}

const passed = checks.length > 0 && checks.every((check) => check.ok);
console.log(JSON.stringify({
  project: 'codex-worker-delegation',
  report: 'production-seal',
  checks,
  status: passed ? 'SEALED' : 'NOT_SEALED'
}, null, 2));
if (!passed) process.exitCode = 1;
