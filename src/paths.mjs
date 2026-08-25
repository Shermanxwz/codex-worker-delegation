import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

function identityHome(env = process.env) {
  const home = env.HOME || os.homedir();
  if (!home || !path.isAbsolute(home)) throw new Error('HOME must be an absolute path for Codex Worker Delegation');
  return path.resolve(home);
}

function rejectRootUserPath(value, label) {
  if (typeof process.getuid === 'function' && process.getuid() === 0 && path.resolve(value).startsWith('/home/')) {
    throw new Error(`Refusing root access to user-scoped ${label}: ${path.resolve(value)}`);
  }
}

export function dataDir(env = process.env) {
  if (env.CWD_DATA_DIR) {
    const resolved = path.resolve(env.CWD_DATA_DIR);
    rejectRootUserPath(resolved, 'data directory');
    return resolved;
  }
  // Production state is identity-scoped exactly like ChatGPT/Codex auth. Do not
  // let an inherited XDG_DATA_HOME from another uid silently split state, keys,
  // hooks and MCP tools across two data roots.
  const resolved = path.join(identityHome(env), '.local', 'share', 'codex-worker-delegation');
  rejectRootUserPath(resolved, 'data directory');
  return resolved;
}

export function codexHome(env = process.env) {
  const resolved = path.resolve(env.CODEX_HOME || path.join(identityHome(env), '.codex'));
  rejectRootUserPath(resolved, 'CODEX_HOME');
  return resolved;
}

export function statePath(env = process.env) { return path.join(dataDir(env), 'state.json'); }
export function vaultKeyPath(env = process.env) { return path.join(dataDir(env), 'master.key'); }
export function gatewayTokenPath(env = process.env) { return path.join(dataDir(env), 'gateway.token'); }
export function auditPath(env = process.env) { return path.join(dataDir(env), 'audit.jsonl'); }
export function workerTasksDir(env = process.env) { return path.join(dataDir(env), 'worker-tasks'); }
export function workerTaskPath(env = process.env, taskId) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(taskId || ''))) throw new Error('invalid worker task id');
  return path.join(workerTasksDir(env), `${taskId}.json`);
}
