import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const { input, ...spawnOptions } = options;
    const child = spawn(command, args, { cwd: ROOT, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

const PRIVILEGED_ENV_KEYS = [
  'CWD_INSTALL_ROOT',
  'CWD_DATA_DIR',
  'CWD_MANAGED_HOOKS_DIR',
  'CWD_MANAGED_NODE_BIN',
  'CWD_MANAGED_HOOKS_ADOPT',
  'CWD_PORT',
];

function runAsRoot(command, args, options = {}) {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    return run(command, args, options);
  }

  const env = options.env ?? process.env;
  const forwardedEnv = PRIVILEGED_ENV_KEYS.flatMap((key) => (
    env[key] === undefined ? [] : [`${key}=${env[key]}`]
  ));
  return run('sudo', ['-n', '/usr/bin/env', ...forwardedEnv, command, ...args], {
    ...options,
    env: process.env,
  });
}

async function removeTempDir(dir) {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }
  const result = await run('sudo', ['-n', 'rm', '-rf', '--', dir]);
  if (result.status !== 0) throw new Error(result.stderr || `failed to remove ${dir}`);
}

function envFor(values) {
  return { ...process.env, ...values };
}

test('managed hook renderer produces host-specific files without unresolved markers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-managed-hooks-render-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const templateDir = path.join(ROOT, 'deploy', 'managed-hooks');
  const outputDir = path.join(dir, 'managed');
  const installRoot = path.join(dir, 'release-root');
  const dataDir = path.join(dir, 'worker-data');
  const managedDir = path.join(dir, 'etc-codex');
  const result = await run(process.execPath, [
    'scripts/render-managed-hooks.mjs', templateDir, installRoot, dataDir, managedDir, '8788', outputDir,
  ], { env: envFor({ CWD_MANAGED_NODE_BIN: process.execPath }) });
  assert.equal(result.status, 0, result.stderr);
  const requirements = await fs.readFile(path.join(outputDir, 'requirements.toml'), 'utf8');
  const wrapper = await fs.readFile(path.join(outputDir, 'worker-delegation-policy.sh'), 'utf8');
  const bridge = await fs.readFile(path.join(outputDir, 'worker-delegation-policy.mjs'), 'utf8');
  assert.doesNotMatch(`${requirements}\n${wrapper}\n${bridge}`, /@@/);
  assert.match(requirements, /allow_managed_hooks_only = true/);
  assert.match(requirements, new RegExp(`managed_dir = ${JSON.stringify(managedDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(wrapper, /CWD_HOOK_REQUIRE_CONTROL_PLANE=1/);
  assert.match(wrapper, /CWD_HOOK_CONTROL_PLANE_URL/);
  assert.match(bridge, /findActiveWorkerIdentity/);
  assert.equal((await fs.stat(path.join(outputDir, 'worker-delegation-policy.sh'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(outputDir, 'requirements.toml'))).mode & 0o777, 0o644);
  assert.equal((await run('bash', ['-n', path.join(outputDir, 'worker-delegation-policy.sh')])).status, 0);
  assert.equal((await run(process.execPath, ['--check', path.join(outputDir, 'worker-delegation-policy.mjs')])).status, 0);
});

test('managed hook install, validation, idempotent reinstall, and marker-safe uninstall work in a temporary root', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-managed-hooks-install-'));
  t.after(() => removeTempDir(dir));
  const installRoot = path.join(dir, 'release-root');
  const dataDir = path.join(dir, 'worker-data');
  const managedDir = path.join(dir, 'etc-codex');
  const runner = path.join(installRoot, 'current', 'plugins', 'codex-worker-delegation', 'hooks', 'run-policy.sh');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, '#!/usr/bin/env bash\ncat >/dev/null\n', { mode: 0o755 });
  await fs.mkdir(dataDir, { recursive: true });
  const env = envFor({
    CWD_INSTALL_ROOT: installRoot,
    CWD_DATA_DIR: dataDir,
    CWD_MANAGED_HOOKS_DIR: managedDir,
    CWD_MANAGED_NODE_BIN: process.execPath,
  });
  let result = await runAsRoot('bash', ['scripts/install-managed-hooks.sh'], { env });
  assert.equal(result.status, 0, result.stderr);
  result = await runAsRoot('bash', ['scripts/validate-managed-hooks.sh'], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CWD_MANAGED_HOOKS_VALID/);
  result = await runAsRoot('bash', ['scripts/install-managed-hooks.sh'], { env });
  assert.equal(result.status, 0, result.stderr);
  result = await runAsRoot('bash', ['scripts/uninstall-managed-hooks.sh'], { env });
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['requirements.toml', 'worker-delegation-policy.sh', 'worker-delegation-policy.mjs', '.codex-worker-delegation-managed']) {
    await assert.rejects(fs.stat(path.join(managedDir, file)), { code: 'ENOENT' });
  }
});

test('managed hook installer refuses to overwrite an unmarked requirements file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-managed-hooks-adopt-'));
  t.after(() => removeTempDir(dir));
  const installRoot = path.join(dir, 'release-root');
  const dataDir = path.join(dir, 'worker-data');
  const managedDir = path.join(dir, 'etc-codex');
  const runner = path.join(installRoot, 'current', 'plugins', 'codex-worker-delegation', 'hooks', 'run-policy.sh');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, '#!/usr/bin/env bash\ncat >/dev/null\n', { mode: 0o755 });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(managedDir, { recursive: true });
  await fs.writeFile(path.join(managedDir, 'requirements.toml'), 'external-managed-policy\n');
  let result = await runAsRoot('bash', ['scripts/install-managed-hooks.sh'], {
    env: envFor({
      CWD_INSTALL_ROOT: installRoot,
      CWD_DATA_DIR: dataDir,
      CWD_MANAGED_HOOKS_DIR: managedDir,
      CWD_MANAGED_NODE_BIN: process.execPath,
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CWD_MANAGED_HOOKS_ADOPT=1/);
  assert.equal(await fs.readFile(path.join(managedDir, 'requirements.toml'), 'utf8'), 'external-managed-policy\n');
  result = await runAsRoot('bash', ['scripts/install-managed-hooks.sh'], {
    env: envFor({
      CWD_INSTALL_ROOT: installRoot,
      CWD_DATA_DIR: dataDir,
      CWD_MANAGED_HOOKS_DIR: managedDir,
      CWD_MANAGED_NODE_BIN: process.execPath,
      CWD_MANAGED_HOOKS_ADOPT: '1',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(managedDir, '.codex-worker-delegation-backup', 'requirements.toml'), 'utf8'), 'external-managed-policy\n');
  result = await runAsRoot('bash', ['scripts/uninstall-managed-hooks.sh'], {
    env: envFor({ CWD_MANAGED_HOOKS_DIR: managedDir }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(managedDir, 'requirements.toml'), 'utf8'), 'external-managed-policy\n');
  await assert.rejects(fs.stat(path.join(managedDir, 'worker-delegation-policy.sh')), { code: 'ENOENT' });
});

test('managed bridge annotates only a matching provider-isolated Worker thread', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-managed-hooks-identity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const managedDir = path.join(dir, 'etc-codex');
  const dataDir = path.join(dir, 'worker-data');
  const tasksDir = path.join(dataDir, 'worker-tasks');
  const runner = path.join(dir, 'run-policy.sh');
  const capture = path.join(dir, 'captured.json');
  const outputDir = path.join(dir, 'rendered');
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(runner, '#!/usr/bin/env bash\ncat > "$CWD_CAPTURE_FILE"\n', { mode: 0o755 });
  await fs.writeFile(path.join(tasksDir, 'wrk_identity.json'), JSON.stringify({
    taskId: 'wrk_identity', mode: 'DELEGATE', provider: 'third_party', execution: 'provider_isolated_thread', role: 'worker', status: 'running', threadId: 'session-1', turnId: 'turn-1',
  }));
  const result = await run(process.execPath, ['scripts/render-managed-hooks.mjs', path.join(ROOT, 'deploy', 'managed-hooks'), dir, dataDir, managedDir, '8788', outputDir], {
    env: envFor({ CWD_MANAGED_NODE_BIN: process.execPath }),
  });
  assert.equal(result.status, 0, result.stderr);
  const bridge = path.join(outputDir, 'worker-delegation-policy.mjs');
  const hookInput = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'session-1', turn_id: 'turn-1', tool_name: 'Bash' });
  const forwarded = await run(process.execPath, [bridge], {
    env: envFor({
      CWD_MANAGED_DATA_DIR: dataDir,
      CWD_MANAGED_TASKS_DIR: tasksDir,
      CWD_MANAGED_POLICY_RUNNER: runner,
      CWD_MANAGED_NODE_BIN: process.execPath,
      CWD_CAPTURE_FILE: capture,
    }),
    input: hookInput,
  });
  assert.equal(forwarded.status, 0, forwarded.stderr);
  const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(captured.agent_id, 'managed-worker:wrk_identity');
  assert.equal(captured.agent_type, 'cwd-worker');

  const unmatched = await run(process.execPath, [bridge], {
    env: envFor({
      CWD_MANAGED_DATA_DIR: dataDir,
      CWD_MANAGED_TASKS_DIR: tasksDir,
      CWD_MANAGED_POLICY_RUNNER: runner,
      CWD_MANAGED_NODE_BIN: process.execPath,
      CWD_CAPTURE_FILE: capture,
    }),
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'other-session', turn_id: 'other-turn', tool_name: 'Bash' }),
  });
  assert.equal(unmatched.status, 0, unmatched.stderr);
  const untouched = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(untouched.agent_id, undefined);
  assert.equal(untouched.agent_type, undefined);
});
