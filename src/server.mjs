import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { StateStore, publicState, activeProfile, completeProfileForMode } from './store.mjs';
import { SecretVault } from './vault.mjs';
import { ResponsesGateway } from './gateway.mjs';
import { probeProvider, listProviderModels } from './provider.mjs';
import { CodexConfigManager } from './codex-config.mjs';
import { CodexAppServerService } from './codex-app-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const MODES = new Set(['AUTO', 'DELEGATE', 'MAIN']);
const SOURCES = new Set(['official', 'third_party']);

export function createApp({ env = process.env, fetchImpl = fetch, codexAppServer } = {}) {
  const store = new StateStore({ env }); const vault = new SecretVault({ env });
  const gateway = new ResponsesGateway({ store, vault, fetchImpl });
  const port = Number(env.CWD_PORT || 8788); const host = env.CWD_HOST || '127.0.0.1';
  const codex = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });
  const codexService = codexAppServer || new CodexAppServerService({ env, cwd: root });
  let modelCache = { at: 0, data: null };
  let serialTail = Promise.resolve();
  const serial = (fn) => {
    const run = serialTail.then(fn, fn);
    serialTail = run.catch(() => {});
    return run;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/v1/responses') return gateway.handle(req, res, await readJson(req));
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const token = await store.ensureGatewayToken();
        if ((req.headers.authorization || '') !== `Bearer ${token}`) return sendJson(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
        const state = await store.read();
        const names = [...new Set(Object.values(state.profiles || {}).flatMap((profile) => Object.values(profile || {})).filter((x) => x?.source === 'third_party' && x.model).map((x) => x.model))];
        return sendJson(res, 200, { object: 'list', data: names.map((id) => ({ id, object: 'model', owned_by: state.provider?.name || 'third-party' })) });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorizeUi(req, env, host)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, publicState(await store.read()));
        if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: '1.1.0', host, port });
        if (req.method === 'GET' && url.pathname === '/api/models') {
          const refresh = url.searchParams.get('refresh') === '1';
          if (!refresh && modelCache.data && Date.now() - modelCache.at < 30_000) return sendJson(res, 200, modelCache.data);
          const data = await readModelCatalogs({ store, vault, codexService, fetchImpl });
          modelCache = { at: Date.now(), data };
          return sendJson(res, 200, data);
        }
        if (req.method === 'PUT' && url.pathname === '/api/mode') {
          const { mode } = await readJson(req); if (!MODES.has(mode)) return sendJson(res, 400, { error: 'mode must be AUTO, DELEGATE, or MAIN' });
          const next = await serial(async () => {
            const state = await store.update((s) => { s.mode = mode; return s; });
            if (state.installed) await applyActiveProfile({ state, codex });
            await store.audit('mode.changed', { mode });
            return state;
          });
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'PUT' && url.pathname === '/api/profile') {
          const body = await readJson(req); const mode = body.mode || (await store.read()).mode;
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'invalid mode' });
          const profile = validateProfile(body.profile, mode);
          const next = await serial(async () => {
            const state = await store.update((s) => { s.profiles[mode] = profile; return s; });
            validateThirdPartyRequirements(state, profile);
            if (state.installed && state.mode === mode) await codex.applyProfile(profile);
            await store.audit('profile.changed', { mode, profile: redactProfile(profile) });
            return state;
          });
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'PUT' && url.pathname === '/api/provider') {
          const body = await readJson(req); validateProvider(body);
          const current = await store.read();
          const cipher = body.apiKey ? await vault.encrypt(body.apiKey) : current.provider?.apiKeyCipher;
          if (!cipher) return sendJson(res, 400, { error: 'apiKey is required on first configuration' });
          const provider = { name: body.name || 'New API', baseUrl: body.baseUrl, protocol: body.protocol || 'auto', apiKeyCipher: cipher, forwardReasoningEffort: body.forwardReasoningEffort === true, headers: sanitizeHeaders(body.headers) };
          const state = await store.update((s) => { s.provider = provider; s.protocolCache = {}; return s; });
          modelCache = { at: 0, data: null };
          await store.audit('provider.saved', { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol }); return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/probe') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const model = body.model; if (!model) return sendJson(res, 400, { error: 'model is required' });
          const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model, fetchImpl, extraHeaders: state.provider.headers });
          if (result.protocol !== 'unknown') await store.update((s) => { s.protocolCache[model] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: result.ok }; return s; });
          await store.audit('provider.probed', { model, protocol: result.protocol, ok: result.ok, status: result.status }); return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/install') {
          const result = await serial(async () => {
            const state = await store.read(); const profile = validateProfile(activeProfile(state), state.mode); validateThirdPartyRequirements(state, profile);
            const plugin = await codexService.installLocalPlugin(root, 'codex-worker-delegation');
            await store.ensureGatewayToken();
            const snap = await codex.install({ profile });
            const next = await store.update((s) => {
              if (!s.originalTopLevel) s.originalTopLevel = snap.originalTopLevel;
              s.installed = true;
              s.integration = { transport: 'app-server', pluginId: plugin.pluginId, lastInstalledAt: new Date().toISOString() };
              return s;
            });
            await store.audit('codex.installed', { transport: 'app-server', pluginId: plugin.pluginId, mode: next.mode });
            return { state: publicState(next), plugin };
          });
          return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/restore-original') {
          const next = await serial(async () => {
            const state = await store.read(); await codex.restoreOfficial(state.originalTopLevel || {});
            await store.audit('codex.main.restored_original'); return state;
          });
          return sendJson(res, 200, publicState(next));
        }
        return sendJson(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (error) { console.error(error); return sendJson(res, 500, { error: error.message }); }
  });
  return { server, host, port, store };
}

async function readModelCatalogs({ store, vault, codexService, fetchImpl }) {
  const state = await store.read();
  const out = { refreshedAt: new Date().toISOString(), official: { source: 'codex-app-server:model/list', data: [], error: null }, thirdParty: { source: 'new-api:/v1/models', data: [], error: null } };
  try {
    const models = await codexService.listModels({ includeHidden: false });
    out.official.data = models.map((m) => ({
      id: m.model || m.id,
      catalogId: m.id,
      displayName: m.displayName || m.model || m.id,
      description: m.description || '',
      isDefault: Boolean(m.isDefault),
      multiAgentVersion: m.multiAgentVersion ?? null,
      supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map((x) => x.reasoningEffort),
      defaultReasoningEffort: m.defaultReasoningEffort ?? null,
      modelSpecialty: m.modelSpecialty ?? null,
    }));
  } catch (error) { out.official.error = error.message; }
  if (state.provider?.apiKeyCipher) {
    try {
      const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
      const models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
      out.thirdParty.endpoint = models.endpoint;
      out.thirdParty.data = models.data;
    } catch (error) { out.thirdParty.error = error.message; }
  } else out.thirdParty.error = 'New API is not configured yet';
  return out;
}

async function applyActiveProfile({ state, codex }) {
  const profile = validateProfile(activeProfile(state), state.mode); validateThirdPartyRequirements(state, profile); await codex.applyProfile(profile);
}

function validateProfile(profile, mode = 'AUTO') {
  profile = completeProfileForMode(profile, mode);
  const out = {};
  for (const role of ['main', 'worker', 'verifier']) {
    const value = profile?.[role];
    if (!value || !SOURCES.has(value.source)) throw new Error(`${role}.source must be official or third_party`);
    if (!String(value.model || '').trim()) throw new Error(`${role}.model is required`);
    out[role] = { source: value.source, model: String(value.model).trim() };
  }
  return out;
}
function validateThirdPartyRequirements(state, profile) {
  if (Object.values(profile).some((x) => x.source === 'third_party') && !state.provider?.apiKeyCipher) throw new Error('A New API provider/key is required for third-party selections');
}
function redactProfile(profile) { return Object.fromEntries(Object.entries(profile).map(([role, value]) => [role, { source: value.source, model: value.model }])); }
function authorizeUi(req, env, host) {
  const token = env.CWD_WEB_TOKEN;
  if (!token) return ['127.0.0.1', '::1', 'localhost'].includes(host);
  return req.headers.authorization === `Bearer ${token}`;
}
function validateProvider(body) {
  if (!body?.baseUrl) throw new Error('baseUrl is required'); new URL(body.baseUrl);
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
  if (enc === 'zstd') body = zlib.zstdDecompressSync(body);
  else if (enc === 'gzip') body = zlib.gunzipSync(body);
  else if (enc === 'br') body = zlib.brotliDecompressSync(body);
  else if (enc && enc !== 'identity') throw new Error(`unsupported content-encoding: ${enc}`);
  return JSON.parse(body.toString('utf8'));
}
function sendJson(res, status, body) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); }
async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''); const file = path.resolve(root, 'public', relative); const publicRoot = path.resolve(root, 'public');
  if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) return sendJson(res, 403, { error:'forbidden' });
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' }); res.end(data); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 404, { error:'not found' }); throw e; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp(); app.server.listen(app.port, app.host, () => console.log(`Codex Worker Delegation: http://${app.host}:${app.port}`));
}
