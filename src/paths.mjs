import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

export function dataDir(env = process.env) {
  if (env.CWD_DATA_DIR) return path.resolve(env.CWD_DATA_DIR);
  const xdg = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdg, 'codex-worker-delegation');
}

export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function statePath(env = process.env) { return path.join(dataDir(env), 'state.json'); }
export function vaultKeyPath(env = process.env) { return path.join(dataDir(env), 'master.key'); }
export function gatewayTokenPath(env = process.env) { return path.join(dataDir(env), 'gateway.token'); }
export function auditPath(env = process.env) { return path.join(dataDir(env), 'audit.jsonl'); }
