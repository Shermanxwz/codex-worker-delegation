import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { StateStore, publicState, activeRouting, setRoutingMode, REASONING_EFFORTS } from './store.mjs';
import { SecretVault } from './vault.mjs';
import { ResponsesGateway } from './gateway.mjs';
import { probeProvider, listProviderModels } from './provider.mjs';
import { toCodexModelsResponse } from './codex-models.mjs';
import { CodexConfigManager, CODEX_GATEWAY_PROVIDER_ID, inspectTopLevel, sameTopLevelSelectors } from './codex-config.mjs';
import { withCodexAppServer, resolveCodexBinary } from './app-server.mjs';
import { executionPlan } from './policy.mjs';
import { WebAuth, MIN_PASSWORD_LENGTH } from './web-auth.mjs';
export { executionPlan } from './policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const MODES = new Set(['AUTO', 'DELEGATE', 'MAIN']);
const ROLES = new Set(['main', 'worker', 'verifier']);
const PROVIDERS = new Set(['official', 'third_party']);

export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const webAuth = new WebAuth({ env });
  const gateway = new ResponsesGateway({ store, vault, fetchImpl });
  const port = Number(env.CWD_PORT || 8788);
  const host = env.CWD_HOST || '127.0.0.1';
  const codex = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/v1/responses') return gateway.handle(req, res, await readJson(req));
      if (req.method === 'GET' && url.pathname === '/v1/models') return serveGatewayModels(req, res, { store, vault, fetchImpl, nativeCatalog: url.searchParams.has('client_version') });
      if (req.method === 'POST' && url.pathname === '/internal/worker/run') {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        return sendJson(res, 200, await executeWorker(await readJson(req), { store, env, codex }));
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/status') return sendJson(res, 200, await authStatus({ req, env, host, webAuth }));
      if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
        if (!isLoopback(host) && (!env.CWD_WEB_TOKEN || req.headers.authorization !== `Bearer ${env.CWD_WEB_TOKEN}`)) return sendJson(res, 401, { error: 'bootstrap token required for public password setup' });
        const body = await readJson(req);
        if (body.password !== body.confirmPassword) return sendJson(res, 400, { error: 'password confirmation does not match' });
        await webAuth.setPassword(body.password);
        const session = await webAuth.login(body.password, req.socket.remoteAddress || 'unknown');
        return sendJson(res, 200, { ok: true, configured: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        const session = await webAuth.login(body.password, req.socket.remoteAddress || 'unknown');
        return sendJson(res, 200, { ok: true, authenticated: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        webAuth.clear(req);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': webAuth.clearCookie() });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: '3.0.0', host, port, codexBinary: resolveCodexBinary(env), authRequired: await webAuth.isConfigured() || env.CWD_REQUIRE_AUTH === '1' || !isLoopback(host) });
        if (!await authorizeUi(req, env, host, webAuth)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, publicState(await store.read()));
        if (req.method === 'GET' && url.pathname === '/api/catalog') return sendJson(res, 200, await loadCatalog({ store, vault, env, fetchImpl }));
        if (req.method === 'PUT' && url.pathname === '/api/mode') {
          const { mode } = await readJson(req);
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'mode must be AUTO, DELEGATE, or MAIN' });
          const state = await store.update((s) => { s.mode = mode; return s; });
          const reasoningSync = await syncTopLevelReasoning(state, codex);
          await store.audit('mode.changed', { mode, reasoningSync });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/routing') {
          const body = await readJson(req);
          const mode = body.mode || (await store.read()).mode;
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'invalid mode' });
          validateRouting(body.roles);
          const state = await store.update((s) => setRoutingMode(s, mode, body.roles));
          const reasoningSync = await syncTopLevelReasoning(state, codex);
          await store.audit('routing.changed', { mode, roles: body.roles, reasoningSync });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/provider') {
          const body = await readJson(req); validateProvider(body);
          const current = await store.read();
          const cipher = body.apiKey ? await vault.encrypt(body.apiKey) : current.provider?.apiKeyCipher;
          if (!cipher) return sendJson(res, 400, { error: 'apiKey is required on first configuration' });
          const provider = { name: body.name || 'New API', baseUrl: body.baseUrl, protocol: body.protocol || 'auto', apiKeyCipher: cipher, forwardReasoningEffort: body.forwardReasoningEffort === true, headers: sanitizeHeaders(body.headers) };
          const state = await store.update((s) => { s.provider = provider; s.protocolCache = {}; return s; });
          await store.audit('provider.saved', { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/probe') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const selected = body.model || firstThirdPartyModel(state) || activeRouting(state).worker.model || activeRouting(state).main.model;
          if (!selected) return sendJson(res, 400, { error: 'model is required' });
          const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model: selected, fetchImpl, extraHeaders: state.provider.headers });
          if (result.protocol !== 'unknown') await store.update((s) => { s.protocolCache[selected] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: result.ok }; return s; });
          await store.audit('provider.probed', { model: selected, protocol: result.protocol, ok: result.ok, status: result.status });
          return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/connectivity') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const models = [...new Set((Array.isArray(body.models) ? body.models : (await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers })).map((item) => item.id)).map((model) => String(model || '').trim()).filter(Boolean))];
          if (!models.length) return sendJson(res, 400, { error: 'no models available to test' });
          const results = await testProviderModels({ models, state, apiKey, fetchImpl });
          await store.update((s) => { for (const result of results) if (result.ok && result.protocol !== 'unknown') s.protocolCache[result.model] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: true }; return s; });
          return sendJson(res, 200, { results });
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/install') {
          const snap = await ensureCodexIntegration({ store, codex });
          const next = await store.read();
          await store.audit('codex.installed', { providerId: snap.providerId, agents: snap.agents, topLevelPreserved: snap.topLevelPreserved });
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/change') {
          if (!webAuth.authenticated(req)) return sendJson(res, 401, { error: 'login required' });
          const body = await readJson(req);
          if (!await webAuth.verifyPassword(body.currentPassword)) return sendJson(res, 401, { error: 'current password is invalid' });
          await webAuth.changePassword(body.newPassword);
          webAuth.clear(req);
          const session = await webAuth.login(body.newPassword, req.socket.remoteAddress || 'unknown');
          return sendJson(res, 200, { ok: true, authenticated: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/verify/coexistence') {
          const body = await readJson(req);
          return sendJson(res, 200, await verifyCoexistence({ body, store, codex, env }));
        }
        if (req.method === 'POST' && url.pathname === '/api/worker/run') return sendJson(res, 200, await executeWorker(await readJson(req), { store, env, codex }));
        return sendJson(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (error) {
      console.error(error);
      return sendJson(res, 500, { error: error.message });
    }
  });
  return { server, host, port, store };
}

async function authorizeInternal(req, store) {
  const token = await store.ensureGatewayToken();
  return req.headers.authorization === `Bearer ${token}`;
}

async function serveGatewayModels(req, res, { store, vault, fetchImpl, nativeCatalog = false }) {
  if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
  const state = await store.read();
  if (!state.provider) return sendJson(res, 503, { error: { message: 'No third-party provider configured', type: 'configuration_error' } });
  const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
  const models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
  if (nativeCatalog) return sendJson(res, 200, toCodexModelsResponse(models));
  return sendJson(res, 200, { object: 'list', data: models.map((item) => ({ id: item.id, object: 'model', owned_by: item.ownedBy || state.provider.name || 'third-party' })) });
}

async function executeWorker(body, { store, env, codex }) {
  const state = await store.read();
  const mode = body.mode || state.mode;
  const roleName = body.role || 'worker';
  if (!MODES.has(mode) || !['worker', 'verifier'].includes(roleName)) throw new Error('invalid mode or worker role');
  if (mode === 'MAIN') throw new Error('MAIN mode disables delegation');
  if (!body.task?.trim()) throw new Error('task is required');
  const routes = activeRouting(state, mode);
  const route = routes[roleName];
  const main = routes.main;
  if (!route?.model) throw new Error(`${mode}.${roleName} model is not configured`);
  const plan = executionPlan(main, route, roleName);
  if (plan.execution === 'native_subagent_required') {
    return {
      ...plan, mode, role: roleName, provider: route.provider, model: route.model,
      effort: route.effort || 'auto',
      instruction: `Use Codex native spawn_agent with agent_type=${plan.agentType} and model=${route.model}${route.effort && route.effort !== 'auto' ? ` and reasoning_effort=${route.effort}` : ''}. This route stays on the built-in OpenAI provider.`
    };
  }
  if (route.provider === 'third_party') await ensureCodexIntegration({ store, codex });
  const result = await withCodexAppServer((client) => client.runThread({
    model: route.model,
    modelProvider: route.provider === 'third_party' ? CODEX_GATEWAY_PROVIDER_ID : 'openai',
    prompt: body.task,
    cwd: body.cwd || process.cwd(),
    sandbox: roleName === 'verifier' ? 'read-only' : (body.sandbox || 'workspace-write'),
    effort: route.effort || 'auto',
    developerInstructions: roleName === 'verifier' ? 'Verify independently. Prefer inspection and tests; do not modify implementation files.' : 'Execute the assigned implementation task and report concrete results.'
  }), { env });
  await store.audit('worker.completed', { mode, role: roleName, provider: route.provider, model: route.model, execution: plan.execution, threadId: result.threadId });
  return { ...plan, mode, role: roleName, provider: route.provider, model: route.model, ...result };
}

async function verifyCoexistence({ body, store, codex, env }) {
  const state = await store.read();
  if (!state.provider) throw new Error('configure New API before coexistence verification');
  const model = String(body.model || firstThirdPartyModel(state) || '').trim();
  if (!model) throw new Error('select at least one third-party model before coexistence verification');
  const selectorsBefore = inspectTopLevel(await codex.read());
  const integration = await ensureCodexIntegration({ store, codex });
  const proof = await withCodexAppServer(async (client) => {
    const before = await client.getAccount({ refreshToken: false });
    const thread = await client.runThread({
      model,
      modelProvider: CODEX_GATEWAY_PROVIDER_ID,
      prompt: 'Reply with exactly CWD_COEXISTENCE_OK. Do not use tools.',
      cwd: body.cwd || process.cwd(),
      sandbox: 'read-only',
      effort: routeEffortForModel(state, 'third_party', model),
      developerInstructions: 'This is a read-only provider coexistence probe. Do not use tools or modify files; answer only with the requested marker.',
      timeoutMs: Number(body.timeoutMs || 120000)
    });
    const after = await client.getAccount({ refreshToken: false });
    return { before, thread, after };
  }, { env });
  const selectorsAfter = inspectTopLevel(await codex.read());
  const officialBefore = proof.before?.account?.type === 'chatgpt';
  const officialAfter = proof.after?.account?.type === 'chatgpt';
  const selectorStable = sameTopLevelSelectors(selectorsBefore, selectorsAfter);
  const thirdPartyThreadOk = proof.thread?.status === 'completed' && Boolean(proof.thread?.output?.trim());
  const markerObserved = proof.thread?.output?.includes('CWD_COEXISTENCE_OK') || false;
  const result = {
    ok: officialBefore && officialAfter && selectorStable && thirdPartyThreadOk,
    officialChatGPTBefore: summarizeAccount(proof.before),
    officialChatGPTAfter: summarizeAccount(proof.after),
    thirdParty: { model, modelProvider: CODEX_GATEWAY_PROVIDER_ID, threadId: proof.thread?.threadId || null, status: proof.thread?.status || null, markerObserved },
    integrationInstalled: true,
    integrationProviderId: integration.providerId,
    globalSelectorUntouched: selectorStable,
    selectorsBefore: publicSelectors(selectorsBefore),
    selectorsAfter: publicSelectors(selectorsAfter),
    proof: 'A third-party App Server thread completed between two account/read checks while the top-level official selector stayed byte-equivalent at the parsed selector level.'
  };
  await store.audit('coexistence.verified', { ok: result.ok, model, markerObserved, officialBefore, officialAfter, selectorStable });
  return result;
}

function firstThirdPartyModel(state) {
  for (const mode of ['DELEGATE', 'AUTO', state.mode]) {
    const routes = activeRouting(state, mode);
    for (const roleName of ['worker', 'main', 'verifier']) if (routes[roleName]?.provider === 'third_party' && routes[roleName]?.model) return routes[roleName].model;
  }
  return '';
}
function routeEffortForModel(state, provider, model) {
  for (const routes of Object.values(state.routing || {})) {
    for (const route of Object.values(routes || {})) {
      if (route?.provider === provider && route.model === model && route.effort && route.effort !== 'auto') return route.effort;
    }
  }
  return 'auto';
}
function summarizeAccount(result) { const a = result?.account || null; return a ? { type: a.type || null, planType: a.planType || null, email: a.email || null, requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null } : { type: null, planType: null, email: null, requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null }; }
function publicSelectors(value = {}) { return Object.fromEntries(['model_provider','model'].filter((k)=>value[k]?.raw).map((k)=>[k,value[k].raw])); }

async function loadCatalog({ store, vault, env, fetchImpl }) {
  const state = await store.read();
  const result = { official: { ok: false, models: [], account: null, requiresOpenaiAuth: null, error: null }, thirdParty: { ok: false, models: [], configured: Boolean(state.provider), error: null } };
  try {
    const official = await withCodexAppServer(async (client) => {
      const [models, account] = await Promise.all([client.listModels(), client.getAccount({ refreshToken: false })]);
      return { models, account };
    }, { env });
    result.official.models = official.models;
    result.official.account = official.account?.account || null;
    result.official.requiresOpenaiAuth = Boolean(official.account?.requiresOpenaiAuth);
    result.official.ok = true;
  } catch (error) { result.official.error = error.message; }
  if (!state.provider) result.thirdParty.error = 'New API provider is not configured';
  else {
    try {
      const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
      result.thirdParty.models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
      result.thirdParty.ok = true;
    } catch (error) { result.thirdParty.error = error.message; }
  }
  return result;
}

async function authorizeUi(req, env, host, webAuth) {
  const token = env.CWD_WEB_TOKEN;
  if (token && req.headers.authorization === `Bearer ${token}`) return true;
  if (await webAuth.isConfigured()) return webAuth.authenticated(req);
  return isLoopback(host) && env.CWD_REQUIRE_AUTH !== '1';
}
function isLoopback(host) { return ['127.0.0.1', '::1', 'localhost'].includes(host); }
function secureCookie(env, host) { return env.CWD_COOKIE_SECURE === '1' || !isLoopback(host); }
async function authStatus({ req, env, host, webAuth }) { const configured = await webAuth.isConfigured(); return { configured, authenticated: configured ? webAuth.authenticated(req) : isLoopback(host) && env.CWD_REQUIRE_AUTH !== '1', required: configured || env.CWD_REQUIRE_AUTH === '1' || !isLoopback(host), minPasswordLength: MIN_PASSWORD_LENGTH, loopback: isLoopback(host) }; }
async function ensureCodexIntegration({ store, codex }) { await store.ensureGatewayToken(); const snap = await codex.install(); await store.update((s) => { s.installed = true; return s; }); return snap; }
async function syncTopLevelReasoning(state, codex) {
  const main = activeRouting(state, state.mode).main;
  if (main?.provider !== 'official' || !main.effort || main.effort === 'auto') return { changed: false, scope: 'app-server-route-only', effort: main?.effort || 'auto' };
  return { ...(await codex.setReasoningEffort(main.effort)), scope: 'official-top-level-default' };
}
function validateRouting(roles) {
  if (!roles || typeof roles !== 'object') throw new Error('roles is required');
  for (const [name, value] of Object.entries(roles)) {
    if (!ROLES.has(name)) throw new Error(`unknown role ${name}`);
    if (!PROVIDERS.has(value?.provider)) throw new Error(`${name}.provider must be official or third_party`);
    if (typeof value?.model !== 'string') throw new Error(`${name}.model must be a string`);
    if (value?.effort !== undefined && !REASONING_EFFORTS.includes(value.effort)) throw new Error(`${name}.effort must be auto, none, low, medium, high, xhigh, max, or ultra`);
  }
}
function validateProvider(body) {
  if (!body?.baseUrl) throw new Error('baseUrl is required');
  const url = new URL(body.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('baseUrl must be an http(s) URL without embedded credentials');
  if (!['auto', 'responses', 'chat'].includes(body.protocol || 'auto')) throw new Error('protocol must be auto, responses, or chat');
}
async function testProviderModels({ models, state, apiKey, fetchImpl }) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < models.length) {
      const index = cursor++;
      const model = models[index]; const startedAt = Date.now();
      try {
        const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model, fetchImpl, extraHeaders: state.provider.headers, timeoutMs: 30000 });
        results[index] = { model, ok: result.ok === true, protocol: result.protocol, status: result.status || null, latencyMs: Date.now() - startedAt, endpointExists: result.endpointExists ?? true, error: result.error || null };
      } catch (error) { results[index] = { model, ok: false, protocol: 'unknown', status: null, latencyMs: Date.now() - startedAt, endpointExists: false, error: error.message }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, models.length) }, worker));
  return results;
}
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const out = {}; for (const [k,v] of Object.entries(headers)) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && k.toLowerCase() !== 'authorization') out[k] = v; return out;
}
async function readJson(req, limit = 8 * 1024 * 1024) {
  let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('request too large'); chunks.push(Buffer.from(chunk)); }
  if (!chunks.length) return {}; let body = Buffer.concat(chunks);
  const enc = String(req.headers['content-encoding'] || '').toLowerCase().trim();
  if (enc === 'zstd') body = zlib.zstdDecompressSync(body); else if (enc === 'gzip') body = zlib.gunzipSync(body); else if (enc === 'br') body = zlib.brotliDecompressSync(body); else if (enc && enc !== 'identity') throw new Error(`unsupported content-encoding: ${enc}`);
  return JSON.parse(body.toString('utf8'));
}
function sendJson(res, status, body, headers = {}) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers }); res.end(JSON.stringify(body)); }
async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''); const file = path.resolve(root, 'public', relative); const publicRoot = path.resolve(root, 'public');
  if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) return sendJson(res, 403, { error:'forbidden' });
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' }); res.end(data); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 404, { error:'not found' }); throw e; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const app = createApp(); app.server.listen(app.port, app.host, () => console.log(`Codex Worker Delegation: http://${app.host}:${app.port}`)); }
