import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { codexBinaryCandidates, resolveCodexBinary, withCodexAppServer } from '../src/app-server.mjs';
import { CodexConfigManager, inspectTopLevel, sameTopLevelSelectors } from '../src/codex-config.mjs';
import { activeRouting, StateStore } from '../src/store.mjs';
import { codexHome } from '../src/paths.mjs';
import { ensureCodexUserIdentity } from './ensure-codex-user-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
ensureCodexUserIdentity();
const MARKETPLACE = 'codex-worker-delegation-local';
const SEAL_MARKER = 'CWD_PRODUCTION_SEAL_OK';
const SEAL_HTTP_TIMEOUT_MS = Number(process.env.CWD_SEAL_HTTP_TIMEOUT_MS || 180000);
const SEAL_APP_SERVER_TIMEOUT_MS = Number(process.env.CWD_SEAL_APP_SERVER_TIMEOUT_MS || 180000);
const checks = [];

function phase(name) {
  process.stderr.write(`[seal] ${name}\n`);
}

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

function repositoryTestEnv(env) {
  const isolated = { ...env };
  // The repository tests create their own throwaway state and Codex homes.
  // Never let a production seal token, port, state directory, or credentials
  // change the behavior of those deterministic fixtures.
  for (const key of [
    'CWD_DATA_DIR', 'CWD_STATE_FILE', 'CWD_WEB_TOKEN', 'CWD_PORT', 'CWD_HOST',
    'CWD_REQUIRE_AUTH', 'CWD_SYSTEMD_SCOPE', 'CWD_RELEASE_ROOT', 'CWD_NODE_BIN',
    'CODEX_HOME', 'CODEX_BIN', 'CODEX_CLI_PATH', 'CWD_SEAL_COMPACT',
    'CWD_SEAL_HTTP_TIMEOUT_MS', 'CWD_SEAL_APP_SERVER_TIMEOUT_MS'
  ]) delete isolated[key];
  isolated.PATH = `${path.dirname(process.execPath)}${path.delimiter}${isolated.PATH || ''}`;
  return isolated;
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
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(SEAL_HTTP_TIMEOUT_MS)
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
    phase('official runtime');
    const binaryInfo = command([binary, '--version'], env);
    record('official Codex runtime', binaryInfo.ok, binaryInfo.ok ? binaryInfo.output : `could not execute ${binary}: ${binaryInfo.output}`);
    const desktopPath = codexBinaryCandidates(env).find((candidate) => candidate === '/usr/lib/chatgpt/resources/codex');
    const desktopPresent = desktopPath && await fs.access(desktopPath).then(() => true).catch(() => false);
    record('ChatGPT Linux bundled runtime discovery', desktopPresent, desktopPresent ? desktopPath : `packaged path not found; resolved ${binary}`);

    phase('repository checks');
    const testEnv = repositoryTestEnv(env);
    const checkResult = command([process.execPath, 'scripts/check.mjs'], testEnv);
    record('repository static/check contract', checkResult.ok, checkResult.output);
    if (!checkResult.ok) throw new Error('repository check failed');
    const testFiles = (await fs.readdir(path.join(ROOT, 'test'))).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('test', name));
    phase('repository tests');
    const testResult = command([process.execPath, '--test', ...testFiles], testEnv);
    record('repository test suite', testResult.ok, testResult.output);
    if (!testResult.ok) throw new Error('repository test suite failed');

    phase('official plugin installation');
    const pluginResult = command(['bash', 'scripts/install.sh'], env);
    let pluginInstallOk = pluginResult.ok;
    let pluginInstallDetail = pluginResult.output;
    if (!pluginInstallOk && /marketplace .* already added from a different source/i.test(pluginResult.output)) {
      const existingList = command([binary, 'plugin', 'list', '--json'], env);
      let parsedList = null;
      try { parsedList = JSON.parse(existingList.output); } catch {}
      const existing = parsedList?.installed?.find((item) => item?.pluginId === `codex-worker-delegation@${MARKETPLACE}`);
      const expectedDigest = command([process.execPath, 'scripts/tree-digest.mjs', path.join(ROOT, 'plugins/codex-worker-delegation')], env);
      const installedDigest = existing?.source?.path
        ? command([process.execPath, 'scripts/tree-digest.mjs', existing.source.path], env)
        : { ok: false, output: 'installed plugin source path is unavailable' };
      pluginInstallOk = Boolean(existing?.installed && expectedDigest.ok && installedDigest.ok && expectedDigest.output.trim() === installedDigest.output.trim());
      pluginInstallDetail = pluginInstallOk
        ? `marketplace already points at another source, but the installed official plugin payload is byte-identical (${expectedDigest.output.trim()})`
        : `${pluginResult.output}\nExisting plugin payload verification: ${installedDigest.output}`;
    }
    record('official Codex plugin installation', pluginInstallOk, pluginInstallDetail);
    if (!pluginInstallOk) throw new Error('official Codex plugin installation failed');
    phase('plugin verification');
    const pluginList = command([binary, 'plugin', 'list', '--json'], env);
    const pluginInstalled = pluginList.ok && pluginList.output.includes(`codex-worker-delegation@${MARKETPLACE}`);
    record('plugin is installed and enabled', pluginInstalled, pluginInstalled ? `codex-worker-delegation@${MARKETPLACE}` : pluginList.output);
    if (!pluginInstalled) throw new Error('plugin manager did not report the project plugin as installed');

    const store = new StateStore({ env });
    const beforeState = await store.read();
    const thirdPartyConfigured = Boolean(beforeState.provider?.apiKeyCipher);
    record('encrypted New API provider is configured', thirdPartyConfigured, thirdPartyConfigured ? beforeState.provider.name || 'configured' : 'configure the provider in the Web panel first');
    if (!thirdPartyConfigured) throw new Error('encrypted New API provider is not configured');

    phase('control plane startup');
    app = createApp({ env });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${port}`;
    phase('control plane health');
    const health = await requestJson(base, env, '/api/health');
    record('loopback control plane health', health?.ok === true, `${health?.host}:${health?.port}`);

    phase('namespaced Codex integration');
    const installed = await requestJson(base, env, '/api/codex/install', 'POST', {});
    record('namespaced Codex provider installed without selector switching', installed?.installed === true, installed?.installed ? 'installed' : installed);
    if (installed?.installed !== true) throw new Error('Codex integration install did not complete');

    phase('official and third-party catalog');
    const catalog = await requestJson(base, env, '/api/catalog');
    const officialAccountType = catalog?.official?.account?.type || null;
    record('official ChatGPT account is readable', catalog?.official?.ok === true && officialAccountType === 'chatgpt', { type: officialAccountType, error: catalog?.official?.error || null });
    record('third-party model discovery is live', catalog?.thirdParty?.ok === true && Array.isArray(catalog?.thirdParty?.models) && catalog.thirdParty.models.length > 0, { count: catalog?.thirdParty?.models?.length || 0, error: catalog?.thirdParty?.error || null });
    if (catalog?.official?.ok !== true || officialAccountType !== 'chatgpt') throw new Error('official ChatGPT account proof failed');
    if (catalog?.thirdParty?.ok !== true || !catalog.thirdParty.models?.length) throw new Error('third-party model discovery failed');

    phase('official model picker');
    const nativePickerModels = await withCodexAppServer((client) => client.listModels({ includeHidden: true }), { env, overallTimeoutMs: SEAL_APP_SERVER_TIMEOUT_MS });
    const nativePickerIds = new Set(nativePickerModels.map((model) => model?.model || model?.id).filter(Boolean));
    const discoveredThirdPartyIds = [...new Set(catalog.thirdParty.models.map((model) => model?.id).filter(Boolean))];
    const currentOfficialIds = new Set(catalog.official.models.map((model) => model?.model || model?.id).filter(Boolean));
    const thirdPartyOnlyIds = discoveredThirdPartyIds.filter((model) => !currentOfficialIds.has(model));
    const pickerThirdPartyIds = thirdPartyOnlyIds.filter((model) => nativePickerIds.has(model));
    record('official Codex model picker includes discovered New API-only models', pickerThirdPartyIds.length === thirdPartyOnlyIds.length && thirdPartyOnlyIds.length > 0, {
      officialPickerCount: nativePickerModels.length,
      thirdPartyCatalogCount: discoveredThirdPartyIds.length,
      thirdPartyOnlyCount: thirdPartyOnlyIds.length,
      thirdPartyIdsInOfficialPicker: pickerThirdPartyIds
    });

    phase('third-party model connectivity matrix');
    const connectivity = await requestJson(base, env, '/api/provider/connectivity', 'POST', {});
    const connectivityResults = Array.isArray(connectivity?.results) ? connectivity.results : [];
    const connectivityPassed = connectivityResults.filter((result) => result.ok === true);
    const connectivityComplete = connectivityResults.length === catalog.thirdParty.models.length;
    const allModelsPassed = connectivityComplete && connectivityPassed.length === connectivityResults.length;
    record('third-party model connectivity matrix executed', connectivityComplete, {
      tested: connectivityResults.length,
      catalog: catalog.thirdParty.models.length,
      passed: connectivityPassed.length,
      failed: connectivityResults.filter((result) => !result.ok).map((result) => ({ model: result.model, kind: result.kind, protocol: result.protocol, status: result.status, error: result.error }))
    });
    record('all discovered New API models pass their declared protocol connectivity check', allModelsPassed, {
      tested: connectivityResults.length,
      passed: connectivityPassed.length,
      failed: connectivityResults.length - connectivityPassed.length
    });
    if (!connectivityResults.length) throw new Error('third-party connectivity matrix returned no results');

    phase('route selection');
    const state = await store.read();
    const routeCandidates = [];
    const activeMode = state.mode;
    const activeRoutes = activeRouting(state, activeMode);
    for (const role of ['worker', 'verifier', 'main']) {
      if (activeRoutes[role]?.provider === 'third_party' && activeRoutes[role]?.model) routeCandidates.push({ mode: activeMode, role, model: activeRoutes[role].model });
    }
    const coexistenceModel = routeCandidates[0]?.model || catalog.thirdParty.models[0]?.id;
    phase('real official and third-party coexistence');
    const coexistence = await requestJson(base, env, '/api/verify/coexistence', 'POST', { model: coexistenceModel, cwd: ROOT, timeoutMs: SEAL_APP_SERVER_TIMEOUT_MS });
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
    if (!workerRoute) {
      record('real third-party Worker delegation', false, { activeMode, reason: activeMode === 'MAIN' ? 'MAIN mode intentionally disables Worker delegation' : 'configure a third-party Worker model in the active AUTO or DELEGATE route before sealing' });
    } else {
      phase('real third-party Worker completion');
      try {
        const worker = await requestJson(base, env, '/api/worker/run', 'POST', {
          mode: workerRoute.mode,
          role: 'worker',
          task: `Reply exactly with ${SEAL_MARKER}. Do not use tools.`,
          timeoutMs: Math.min(SEAL_APP_SERVER_TIMEOUT_MS, 120000),
          waitForCompletion: true
        });
        record('real third-party Worker delegation', worker?.provider === 'third_party' && worker?.status === 'completed' && worker?.output?.includes(SEAL_MARKER), {
          mode: workerRoute.mode,
          model: workerRoute.model,
          execution: worker?.execution,
          status: worker?.status,
          markerObserved: worker?.output?.includes(SEAL_MARKER) || false,
          threadId: worker?.threadId
        });
      } catch (error) {
        record('real third-party Worker delegation', false, error?.stack || error?.message || error);
      }
    }

    phase('authentication and selector preservation');
    const afterAuth = await fileSnapshot(authFile);
    const afterSelectors = inspectTopLevel(await configManager.read());
    record('ChatGPT auth.json is byte-for-byte unchanged', beforeAuth.exists === afterAuth.exists && beforeAuth.sha256 === afterAuth.sha256, { existed: beforeAuth.exists, sha256Unchanged: beforeAuth.sha256 === afterAuth.sha256 });
    record('official top-level model selectors are unchanged', sameTopLevelSelectors(beforeSelectors, afterSelectors), { before: Object.keys(beforeSelectors), after: Object.keys(afterSelectors) });
    record('managed provider config is present', (await fs.readFile(configFile, 'utf8')).includes('[model_providers.codex_worker_gateway]'), configFile);
  } finally {
    if (app?.server) {
      await new Promise((resolve) => {
        if (!app.server.listening) return resolve();
        app.server.close(() => resolve());
      }).catch(() => {});
    }
  }
}

try {
  await run();
} catch (error) {
  record('seal execution', false, error?.stack || error?.message || error);
}

const passed = checks.length > 0 && checks.every((check) => check.ok);
const report = {
  project: 'codex-worker-delegation',
  report: 'production-seal',
  checks,
  status: passed ? 'SEALED' : 'NOT_SEALED'
};
if (process.env.CWD_SEAL_COMPACT === '1') {
  console.log(JSON.stringify({
    project: report.project,
    report: report.report,
    status: report.status,
    totalChecks: checks.length,
    passedChecks: checks.filter((check) => check.ok).length,
    failedChecks: checks.filter((check) => !check.ok).map((check) => ({ name: check.name, detail: check.detail }))
  }, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (!passed) process.exitCode = 1;
