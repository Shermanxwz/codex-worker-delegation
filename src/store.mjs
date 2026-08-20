import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { statePath, auditPath, gatewayTokenPath } from './paths.mjs';

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: 1,
  mode: 'AUTO',
  provider: null,
  protocolCache: {},
  models: { main: '', worker: '', verifier: '' },
  mainSource: 'official',
  installed: false,
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

export class StateStore {
  constructor({ env = process.env } = {}) { this.env = env; this.file = statePath(env); }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return { ...structuredClone(DEFAULT_STATE), ...parsed, models: { ...DEFAULT_STATE.models, ...(parsed.models || {}) }, protocolCache: parsed.protocolCache || {} };
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(DEFAULT_STATE);
      throw new Error(`Cannot read state ${this.file}: ${error.message}`, { cause: error });
    }
  }

  async write(next) {
    const normalized = { ...structuredClone(DEFAULT_STATE), ...next, updatedAt: new Date().toISOString() };
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

export function publicState(state) {
  const copy = structuredClone(state);
  if (copy.provider) {
    delete copy.provider.apiKeyCipher;
    copy.provider.hasApiKey = Boolean(state.provider.apiKeyCipher);
  }
  delete copy.originalTopLevel;
  return copy;
}
