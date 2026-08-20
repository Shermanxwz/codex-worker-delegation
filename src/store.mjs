import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { statePath, auditPath, gatewayTokenPath } from './paths.mjs';

const blankSelection = (source = 'official') => ({ source, model: '' });
const blankProfile = () => ({ main: blankSelection('official'), worker: blankSelection('third_party'), verifier: blankSelection('third_party') });
export const DEFAULT_PROFILES = Object.freeze({ AUTO: blankProfile(), DELEGATE: blankProfile(), MAIN: blankProfile() });

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: 2,
  mode: 'AUTO',
  provider: null,
  protocolCache: {},
  profiles: DEFAULT_PROFILES,
  installed: false,
  integration: { transport: null, pluginId: null, lastInstalledAt: null },
  originalTopLevel: null,
  updatedAt: null
});

async function atomicWrite(file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text, { mode });
  await fs.rename(tmp, file);
  await fs.chmod(file, mode).catch(() => {});
}

function normalizeSelection(value, fallbackSource) {
  if (typeof value === 'string') return { source: fallbackSource, model: value };
  const source = value?.source === 'third_party' ? 'third_party' : 'official';
  return { source, model: typeof value?.model === 'string' ? value.model : '' };
}

function normalizeProfile(value, legacy = {}) {
  return {
    main: normalizeSelection(value?.main, legacy.mainSource === 'third_party' ? 'third_party' : 'official'),
    worker: normalizeSelection(value?.worker, 'third_party'),
    verifier: normalizeSelection(value?.verifier, 'third_party'),
  };
}

export function normalizeState(parsed = {}) {
  const legacy = { mainSource: parsed.mainSource, models: parsed.models || {} };
  const fallbackProfile = {
    main: { source: legacy.mainSource === 'third_party' ? 'third_party' : 'official', model: legacy.models.main || '' },
    worker: { source: 'third_party', model: legacy.models.worker || legacy.models.main || '' },
    verifier: { source: 'third_party', model: legacy.models.verifier || legacy.models.worker || legacy.models.main || '' },
  };
  const profiles = {};
  for (const mode of ['AUTO', 'DELEGATE', 'MAIN']) profiles[mode] = normalizeProfile(parsed.profiles?.[mode] || fallbackProfile, legacy);
  return {
    ...structuredClone(DEFAULT_STATE),
    ...parsed,
    schemaVersion: 2,
    profiles,
    protocolCache: parsed.protocolCache || {},
    integration: { ...DEFAULT_STATE.integration, ...(parsed.integration || {}) },
  };
}

export class StateStore {
  constructor({ env = process.env } = {}) { this.env = env; this.file = statePath(env); }

  async read() {
    try { return normalizeState(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return normalizeState();
      throw new Error(`Cannot read state ${this.file}: ${error.message}`, { cause: error });
    }
  }

  async write(next) {
    const normalized = { ...normalizeState(next), updatedAt: new Date().toISOString() };
    await atomicWrite(this.file, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  async update(mutator) {
    const current = await this.read();
    const next = await mutator(structuredClone(current));
    return this.write(next ?? current);
  }

  async ensureGatewayToken() {
    const file = gatewayTokenPath(this.env);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { return (await fs.readFile(file, 'utf8')).trim(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const token = crypto.randomBytes(32).toString('base64url');
    await atomicWrite(file, `${token}\n`);
    return token;
  }

  async audit(event, details = {}) {
    const file = auditPath(this.env);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const safe = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n';
    await fs.appendFile(file, safe, { mode: 0o600 });
  }
}

export function activeProfile(state) { return state.profiles?.[state.mode] || normalizeState(state).profiles[state.mode]; }

export function completeProfileForMode(profile, mode) {
  const copy = structuredClone(profile || {});
  if (mode === 'MAIN' && copy.main?.model) {
    for (const role of ['worker', 'verifier']) {
      if (!copy[role]?.model) copy[role] = { source: copy.main.source, model: copy.main.model };
    }
  }
  return copy;
}

export function publicState(state) {
  const copy = structuredClone(normalizeState(state));
  if (copy.provider) {
    delete copy.provider.apiKeyCipher;
    copy.provider.hasApiKey = Boolean(state.provider?.apiKeyCipher);
  }
  delete copy.originalTopLevel;
  return copy;
}
