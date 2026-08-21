import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { statePath, auditPath, gatewayTokenPath } from './paths.mjs';

export const REASONING_EFFORTS = Object.freeze(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const role = (provider = 'official', model = '', effort = 'auto') => ({ provider, model, effort });
const routingDefaults = () => ({
  AUTO: { main: role('official'), worker: role('official'), verifier: role('official') },
  DELEGATE: { main: role('official'), worker: role('third_party'), verifier: role('third_party') },
  MAIN: { main: role('official'), worker: role('official'), verifier: role('official') }
});

export const ROUTING_ROLES = Object.freeze({
  AUTO: Object.freeze(['main']),
  DELEGATE: Object.freeze(['main', 'worker']),
  MAIN: Object.freeze(['main'])
});

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: 4,
  mode: 'AUTO',
  provider: null,
  protocolCache: {},
  models: { main: '', worker: '', verifier: '' },
  routing: routingDefaults(),
  mainSource: 'official',
  installed: false,
  originalTopLevel: null,
  updatedAt: null
});

const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_OWNER_GRACE_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function atomicWrite(file, text, mode = 0o600) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', mode);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(tmp, file);
    await fs.chmod(file, mode).catch(() => {});
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readLockOwner(lockFile) {
  try {
    const value = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (!value?.ownerId || !Number.isInteger(Number(value?.pid)) || Number(value.pid) <= 0) return null;
    return { ownerId: String(value.ownerId), pid: Number(value.pid), createdAt: value.createdAt || null };
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireFileLock(targetFile) {
  const directory = path.dirname(targetFile);
  const lockFile = `${targetFile}.lock`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const ownerId = crypto.randomBytes(16).toString('hex');
  const owner = `${JSON.stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() })}\n`;
  while (true) {
    const temporary = `${lockFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.candidate`;
    let handle;
    try {
      // Publish a complete owner record atomically. Contenders can never see the
      // empty-file window created by open(O_EXCL) followed by a later write.
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(owner);
      await handle.sync();
      await handle.close(); handle = null;
      try {
        await fs.link(temporary, lockFile);
        await fs.chmod(lockFile, 0o600).catch(() => {});
        await syncDirectory(directory);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          const current = await readLockOwner(lockFile);
          if (current?.ownerId === ownerId) {
            await fs.unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
            await syncDirectory(directory).catch(() => {});
          }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }

    try {
      const stat = await fs.stat(lockFile);
      const ageMs = Date.now() - stat.mtimeMs;
      const current = await readLockOwner(lockFile);
      // Fail closed on PID reuse: an apparently-live owner is never reaped.
      // A crashed/malformed owner can be recovered after the publication grace.
      if (ageMs > STATE_LOCK_OWNER_GRACE_MS && (!current || !pidAlive(current.pid))) {
        const check = await readLockOwner(lockFile);
        if ((!check || check.ownerId === current?.ownerId) && (!check || !pidAlive(check.pid))) {
          await fs.unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          await syncDirectory(directory).catch(() => {});
          continue;
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if ((Date.now() - startedAt) >= STATE_LOCK_TIMEOUT_MS) {
      const timeout = new Error(`Timed out acquiring state lock ${lockFile}`);
      timeout.code = 'STATE_LOCK_TIMEOUT';
      throw timeout;
    }
    await sleep(10 + crypto.randomInt(0, 31));
  }
}

function normalizeRole(value, fallback) {
  const provider = value?.provider === 'third_party' || value?.provider === 'official' ? value.provider : fallback.provider;
  const model = typeof value?.model === 'string' ? value.model.trim() : fallback.model;
  const effort = REASONING_EFFORTS.includes(value?.effort) ? value.effort : (fallback.effort || 'auto');
  return { provider, model, effort };
}

function normalizeRouting(value, legacyModels = {}) {
  const defaults = routingDefaults(); const output = {};
  for (const mode of ['AUTO', 'DELEGATE', 'MAIN']) {
    const raw = value?.[mode] || {};
    const mainFallback = { ...defaults[mode].main, model: legacyModels?.main || defaults[mode].main.model };
    const main = normalizeRole(raw.main, mainFallback);
    if (mode === 'DELEGATE') {
      const workerFallback = { ...defaults[mode].worker, model: legacyModels?.worker || defaults[mode].worker.model };
      const worker = normalizeRole(raw.worker, workerFallback);
      output[mode] = { main, worker, verifier: { ...worker } };
    } else output[mode] = { main, worker: { ...main }, verifier: { ...main } };
  }
  return output;
}

function normalizeState(value = {}) {
  const legacyModels = { ...DEFAULT_STATE.models, ...(value.models || {}) };
  return { ...structuredClone(DEFAULT_STATE), ...value, schemaVersion: DEFAULT_STATE.schemaVersion, models: legacyModels, routing: normalizeRouting(value.routing, legacyModels), protocolCache: value.protocolCache || {} };
}

export function activeRouting(state, mode = state.mode) { const normalized = normalizeState(state); return structuredClone(normalized.routing[mode] || normalized.routing.AUTO); }

export function setRoutingMode(state, mode, roles = {}) {
  const normalized = normalizeState(state); const current = normalized.routing[mode] || normalized.routing.AUTO; const main = normalizeRole(roles.main, current.main);
  if (mode === 'DELEGATE') { const worker = normalizeRole(roles.worker, current.worker); normalized.routing[mode] = { main, worker, verifier: { ...worker } }; }
  else normalized.routing[mode] = { main, worker: { ...main }, verifier: { ...main } };
  normalized.models = { main: normalized.routing[normalized.mode].main.model, worker: normalized.routing[normalized.mode].worker.model, verifier: normalized.routing[normalized.mode].verifier.model };
  return normalized;
}

async function readGatewayToken(file) {
  const value = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('gateway token must be a 32-byte base64url secret');
  await fs.chmod(file, 0o600).catch(() => {}); return value;
}

async function createGatewayToken(file) {
  const directory = path.dirname(file); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await readGatewayToken(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = crypto.randomBytes(32).toString('base64url'); const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.toktmp`; let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(`${token}\n`); await handle.sync(); await handle.close(); handle = null;
    try { await fs.link(temporary, file); await fs.chmod(file, 0o600).catch(() => {}); await syncDirectory(directory); return token; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return await readGatewayToken(file); }
  } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export class StateStore {
  constructor({ env = process.env } = {}) { this.env = env; this.file = statePath(env); this.gatewayTokenPromise = null; this.mutationTail = Promise.resolve(); }
  async read() { try { return normalizeState(JSON.parse(await fs.readFile(this.file, 'utf8'))); } catch (error) { if (error.code === 'ENOENT') return normalizeState(); throw new Error(`Cannot read state ${this.file}: ${error.message}`, { cause: error }); } }
  async write(next) { return this.#enqueueMutation(() => this.#withFileLock(() => this.#writeUnlocked(next))); }
  async update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('StateStore.update requires a mutator function');
    return this.#enqueueMutation(() => this.#withFileLock(async () => { const current = await this.read(); const next = await mutator(structuredClone(current)); return this.#writeUnlocked(next ?? current); }));
  }
  #enqueueMutation(operation) { const run = this.mutationTail.catch(() => {}).then(operation); this.mutationTail = run.then(() => undefined, () => undefined); return run; }
  async #withFileLock(operation) { const release = await acquireFileLock(this.file); try { return await operation(); } finally { await release(); } }
  async #writeUnlocked(next) { const normalized = { ...normalizeState(next), updatedAt: new Date().toISOString() }; await atomicWrite(this.file, `${JSON.stringify(normalized, null, 2)}\n`); return normalized; }
  async ensureGatewayToken() { if (this.gatewayTokenPromise) return this.gatewayTokenPromise; this.gatewayTokenPromise = createGatewayToken(gatewayTokenPath(this.env)); try { return await this.gatewayTokenPromise; } finally { this.gatewayTokenPromise = null; } }
  async audit(event, details = {}) { const file = auditPath(this.env); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, { mode: 0o600 }); await fs.chmod(file, 0o600).catch(() => {}); }
}

export function publicState(state) {
  const copy = structuredClone(normalizeState(state));
  if (copy.provider) { const hasApiKey = Boolean(copy.provider.apiKeyCipher); delete copy.provider.apiKeyCipher; copy.provider.hasApiKey = hasApiKey; }
  delete copy.originalTopLevel; copy.activeRouting = activeRouting(copy); return copy;
}
