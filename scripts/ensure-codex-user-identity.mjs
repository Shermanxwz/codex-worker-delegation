import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function loadInstallRecord(env) {
  const root = env.CWD_INSTALL_ROOT;
  if (!root) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'install-record.json'), 'utf8'));
  } catch {
    return null;
  }
}

function existingOwnerUid(target) {
  let current = path.resolve(target);
  while (current !== path.dirname(current)) {
    try { return fs.statSync(current).uid; } catch { current = path.dirname(current); }
  }
  return 0;
}

// System-scope deployment commands may be launched with sudo, but CODEX_HOME
// still belongs to the signed-in desktop user. Never let root atomically
// replace that user's config files: re-exec the seal under serviceUser.
export function ensureCodexUserIdentity() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;

  const env = process.env;
  const home = path.resolve(env.HOME || os.homedir());
  const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));

  // Root's own Codex account is a legitimate root deployment and needs no
  // identity hand-off. A /home/* path owned by a non-root uid is a user
  // account; root-owned CI/test homes under /home remain root-scoped.
  if (!codexHome.startsWith('/home/') || existingOwnerUid(codexHome) === 0) return;

  const record = loadInstallRecord(env);
  const serviceUser = record?.serviceUser;
  const serviceHome = record?.home || path.dirname(codexHome);
  const serviceCodexHome = record?.codexHome || codexHome;
  if (!serviceUser || serviceUser === 'root') {
    throw new Error(`Refusing to run as root with user CODEX_HOME=${codexHome}; install record does not identify a non-root service user`);
  }

  const childEnv = { ...env, HOME: serviceHome, CODEX_HOME: serviceCodexHome, USER: serviceUser, LOGNAME: serviceUser };
  for (const key of ['SUDO_USER', 'SUDO_UID', 'SUDO_GID']) delete childEnv[key];
  const result = spawnSync('runuser', ['-u', serviceUser, '--', process.execPath, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: 'utf8'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
