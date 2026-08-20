import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { StateStore, publicState, activeRouting } from './store.mjs';
import { SecretVault } from './vault.mjs';
import { ResponsesGateway } from './gateway.mjs';
import { probeProvider, listProviderModels } from './provider.mjs';
import { CodexConfigManager, CODEX_GATEWAY_PROVIDER_ID } from './codex-config.mjs';
import { withCodexAppServer, resolveCodexBinary } from './app-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const MODES = new Set(['AUTO', 'DELEGATE', 'MAIN']);
const ROLES = new Set(['main', 'worker', 'verifier']);
const PROVIDERS = new Set(['official', 'third_party']);

export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const gateway = new ResponsesGateway({ store, vault, fetchImpl });
  const port = Number(env.CWD_PORT || 8788);
  const host = env.CWD_HOST || '127.0.0.1';
  const codex = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/v1/responses') return gateway.handle(req, res, await readJson(req));
      if (req.method === 'GET' && url.pathname === '/v1/models') return serveGatewayModels(req, res, { store, vault, fetchImpl });
      if (req.method === 'POST' && url.pathname === '/internal/worker/run') {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        return sendJson(res, 200, await executeWorker(await readJson(req), { store, env }));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorizeUi(req, env, host)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, publicState(await store.read()));
        if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: '2.0.0', host, port, codexBinary: resolveCodexBinary(env) });
        if (req.method === 'GET' && url.pathname === '/api/catalog') return sendJson(res, 200, await loadCatalog({ store, vault, env, fetchImpl }));
        if (req.method === 'PUT' && url.pathname === '/api/mode') {
          const { mode } = await readJson(req);
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'mode must be AUTO, DELEGATE, or MAIN' });
          const state = await store.update((s) => { s.mode = mode; return s; });
          await store.audit('mode.changed', { mode });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/routing') {
          const body = await readJson(req);
          const mode = body.mode || (await store.read()).mode;
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'invalid mode' });
          validateRouting(body.roles);
          const state = await store.update((s) => {
            s.routing[mode] = {
              ...s.routing[mode],
              ...Object.fromEntries(Object.entries(body.roles).map(([name, value]) => [name, { provider: value.provider, model: String(value.model || '').trim() }]))
            };
            if (mode === s.mode) {
              s.models = { main: s.routing[mode].main.model, worker: s.routing[mode].worker.model, verifier: s.routing[mode].verifier.model };
              s.mainSource = s.routing[mode].main.provider === 'third_party' ? 'third_party' : 'official';
            }
            return s;
          });
          await store.audit('routing.changed', { mode, roles: body.roles });
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
          const body = await readJson(req); const selected = body.model || activeRouting(state).worker.model || activeRouting(state).main.model;
          if (!selected) return sendJson(res, 400, { error: 'model is required' });
          const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model: selected, fetchImpl, extraHeaders: state.provider.headers });
          if (result.protocol !== 'unknown') await store.update((s) => { s.protocolCache[selected] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: result.ok }; return s; });
          await store.audit('provider.probed', { model: selected, protocol: result.protocol, ok: result.ok, status: result.status });
          return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/install') {
          await store.ensureGatewayToken();
          const snap = await codex.install();
          const next = await store.update((s) => { if (!s.originalTopLevel) s.originalTopLevel = snap.originalTopLevel; s.installed = true; return s; });
          await store.audit('codex.installed', { providerId: snap.providerId, agents: snap.agents });
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/official') {
          const state = await store.read(); await codex.restoreOfficial(state.originalTopLevel || {});
          const next = await store.update((s) => { s.mainSource = 'official'; return s; });
          await store.audit('codex.global_selector.restored');
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/worker/run') return sendJson(res, 200, await executeWorker(await readJson(req), { store, env }));
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

async function serveGatewayModels(req, res, { store, vault, fetchImpl }) {
  if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
  const state = await store.read();
  if (!state.provider) return sendJson(res, 503, { error: { message: 'No third-party provider configured', type: 'configuration_error' } });
  const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
  const models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
  return sendJson(res, 200, { object: 'list', data: models.map((item) => ({ id: item.id, object: 'model', owned_by: item.ownedBy || state.provider.name || 'third-party' })) });
}

async function executeWorker(body, { store, env }) {
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
  if (route.provider === main.provider) {
    return {
      execution: 'native_subagent_required', mode, role: roleName, provider: route.provider, model: route.model,
      agentType: roleName === 'verifier' ? 'cwd-verifier' : 'cwd-worker',
      instruction: `Use Codex native spawn_agent with agent_type=${roleName === 'verifier' ? 'cwd-verifier' : 'cwd-worker'} and model=${route.model}; Main and ${roleName} use the same provider.`
    };
  }
  if (route.provider === 'third_party' && !state.installed) throw new Error('install/refresh Codex integration before using third-party threads');
  const result = await withCodexAppServer((client) => client.runThread({
    model: route.model,
    modelProvider: route.provider === 'third_party' ? CODEX_GATEWAY_PROVIDER_ID : 'openai',
    prompt: body.task,
    cwd: body.cwd || process.cwd(),
    sandbox: roleName === 'verifier' ? 'read-only' : (body.sandbox || 'workspace-write'),
    developerInstructions: roleName === 'verifier' ? 'Verify independently. Prefer inspection and tests; do not modify implementation files.' : 'Execute the assigned implementation task and report concrete results.'
  }), { env });
  await store.audit('worker.completed', { mode, role: roleName, provider: route.provider, model: route.model, threadId: result.threadId });
  return { execution: 'cross_provider_thread', mode, role: roleName, provider: route.provider, ...result };
}

async function loadCatalog({ store, vault, env, fetchImpl }) {
  const state = await store.read();
  const result = { official: { ok: false, models: [], error: null }, thirdParty: { ok: false, models: [], error: null } };
  try { result.official.models = await withCodexAppServer((client) => client.listModels(), { env }); result.official.ok = true; }
  catch (error) { result.official.error = error.message; }
  if (!state.provider) result.thirdParty.error = 'New API provider is not configured';
  else {
    try { const apiKey = await vault.decrypt(state.provider.apiKeyCipher); result.thirdParty.models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers }); result.thirdParty.ok = true; }
    catch (error) { result.thirdParty.error = error.message; }
  }
  return result;
}

function authorizeUi(req, env, host) {
  const token = env.CWD_WEB_TOKEN;
  if (!token) return ['127.0.0.1', '::1', 'localhost'].includes(host);
  return req.headers.authorization === `Bearer ${token}`;
}
function validateRouting(roles) {
  if (!roles || typeof roles !== 'object') throw new Error('roles is required');
  for (const [name, value] of Object.entries(roles)) {
    if (!ROLES.has(name)) throw new Error(`unknown role ${name}`);
    if (!PROVIDERS.has(value?.provider)) throw new Error(`${name}.provider must be official or third_party`);
    if (typeof value?.model !== 'string') throw new Error(`${name}.model must be a string`);
  }
}
function validateProvider(body) {
  if (!body?.baseUrl) throw new Error('baseUrl is required');
  const url = new URL(body.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('baseUrl must be an http(s) URL without embedded credentials');
  if (!['auto', 'responses', 'chat'].includes(body.protocol || 'auto')) throw new Error('protocol must be auto, responses, or chat');
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
function sendJson(res, status, body) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); }
async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''); const file = path.resolve(root, 'public', relative); const publicRoot = path.resolve(root, 'public');
  if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) return sendJson(res, 403, { error:'forbidden' });
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' }); res.end(data); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 404, { error:'not found' }); throw e; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { const app = createApp(); app.server.listen(app.port, app.host, () => console.log(`Codex Worker Delegation: http://${app.host}:${app.port}`)); }
