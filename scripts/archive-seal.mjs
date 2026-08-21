import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: Number(process.env.CWD_ARCHIVE_SEAL_TIMEOUT_MS || 1200000),
    ...options
  });
}

const deployment = run('bash', ['scripts/validate-deployment.sh']);
if (deployment.stdout) process.stderr.write(deployment.stdout);
if (deployment.stderr) process.stderr.write(deployment.stderr);
if (deployment.status !== 0) {
  console.log(JSON.stringify({
    project: 'codex-worker-delegation',
    report: 'archive-seal',
    status: 'NOT_ARCHIVE_READY',
    stage: 'deployment',
    reason: 'Target Linux deployment validation failed.'
  }, null, 2));
  process.exit(1);
}

const release = run(process.execPath, ['scripts/release-seal.mjs']);
if (release.stderr) process.stderr.write(release.stderr);
let parsed;
try {
  parsed = JSON.parse(String(release.stdout || '').trim());
} catch (error) {
  console.log(JSON.stringify({
    project: 'codex-worker-delegation',
    report: 'archive-seal',
    status: 'NOT_ARCHIVE_READY',
    stage: 'release',
    reason: `Release seal did not emit valid JSON: ${error.message}`,
    stdoutTail: String(release.stdout || '').slice(-4000)
  }, null, 2));
  process.exit(1);
}

const archiveReady = release.status === 0
  && parsed?.status === 'CORE_SEALED'
  && parsed?.desktopNativeStatus === 'DESKTOP_NATIVE_SEALED'
  && parsed?.archiveReady === true;

const report = {
  project: 'codex-worker-delegation',
  report: 'archive-seal',
  status: archiveReady ? 'ARCHIVE_READY' : 'NOT_ARCHIVE_READY',
  coreStatus: parsed?.status || null,
  desktopNativeStatus: parsed?.desktopNativeStatus || null,
  catalogStatus: parsed?.catalogStatus || null,
  archiveReady,
  upstreamDesktopBlockers: parsed?.upstreamDesktopBlockers || [],
  catalogAdvisories: parsed?.catalogAdvisories || [],
  coreFailures: parsed?.coreFailures || [],
  rule: 'Repository archival is permitted only after target deployment validation, CORE_SEALED, and DESKTOP_NATIVE_SEALED all pass on the same signed-in Linux installation.'
};
console.log(JSON.stringify(report, null, 2));
if (!archiveReady) process.exitCode = 1;
