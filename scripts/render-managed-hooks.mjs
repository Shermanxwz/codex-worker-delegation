#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const MARKER = 'codex-worker-delegation-managed-hooks-v1';

function absolute(value, label) {
  if (!value || !path.isAbsolute(value) || /[\0\r\n]/.test(value) || /\s/.test(value)) {
    throw new Error(`${label} must be an absolute path without whitespace or control characters`);
  }
  return path.resolve(value);
}

function port(value) {
  if (!/^[0-9]+$/.test(String(value || ''))) throw new Error('port must be numeric');
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('port must be between 1 and 65535');
  return String(number);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

async function render(templatePath, outputPath, replacements, mode) {
  let text = await fs.readFile(templatePath, 'utf8');
  for (const [marker, replacement] of Object.entries(replacements)) text = text.replaceAll(marker, replacement);
  if (text.includes('@@')) throw new Error(`${templatePath}: unresolved template marker`);
  await fs.writeFile(outputPath, text, { mode });
  await fs.chmod(outputPath, mode);
}

async function main() {
  const [templateDirArg, installRootArg, dataDirArg, managedDirArg, portArg, outputDirArg] = process.argv.slice(2);
  const templateDir = absolute(templateDirArg, 'template directory');
  const installRoot = absolute(installRootArg, 'install root');
  const dataDir = absolute(dataDirArg, 'data directory');
  const managedDir = absolute(managedDirArg, 'managed hook directory');
  const outputDir = absolute(outputDirArg, 'output directory');
  const managedPort = port(portArg);
  const policyRunner = path.join(installRoot, 'current', 'plugins', 'codex-worker-delegation', 'hooks', 'run-policy.sh');
  const managedScript = path.join(managedDir, 'worker-delegation-policy.sh');
  const managedPolicy = path.join(managedDir, 'worker-delegation-policy.mjs');
  const pinnedNode = absolute(process.env.CWD_MANAGED_NODE_BIN || process.env.CWD_NODE_BIN || path.join(installRoot, 'runtime', 'node'), 'Node executable');

  await fs.mkdir(outputDir, { recursive: true });
  await render(
    path.join(templateDir, 'requirements.toml.in'),
    path.join(outputDir, 'requirements.toml'),
    {
      '@@MANAGED_DIR_TOML@@': tomlString(managedDir),
      '@@MANAGED_SCRIPT_TOML@@': tomlString(managedScript),
    },
    0o644,
  );
  await render(
    path.join(templateDir, 'worker-delegation-policy.sh.in'),
    path.join(outputDir, 'worker-delegation-policy.sh'),
    {
      '@@POLICY_RUNNER@@': shellQuote(policyRunner),
      '@@MANAGED_POLICY@@': shellQuote(managedPolicy),
      '@@PINNED_NODE@@': shellQuote(pinnedNode),
      '@@DATA_DIR@@': shellQuote(dataDir),
      '@@PORT@@': shellQuote(managedPort),
    },
    0o755,
  );
  await render(
    path.join(templateDir, 'worker-delegation-policy.mjs.in'),
    path.join(outputDir, 'worker-delegation-policy.mjs'),
    {},
    0o644,
  );
  await fs.writeFile(path.join(outputDir, '.codex-worker-delegation-managed'), `${MARKER}\nversion=1\n`, { mode: 0o600 });
  await fs.chmod(path.join(outputDir, '.codex-worker-delegation-managed'), 0o600);
}

main().catch((error) => {
  console.error(`managed hook render failed: ${error.message}`);
  process.exit(2);
});
