import { spawnSync } from 'node:child_process';
import { classifyProductionSeal } from '../src/seal.mjs';

const env = { ...process.env, CWD_SEAL_COMPACT: '0' };
const timeout = Number(process.env.CWD_RELEASE_SEAL_TIMEOUT_MS || 900000);

const deployment = spawnSync('bash', ['scripts/validate-deployment.sh'], {
  cwd: process.cwd(),
  env,
  encoding: 'utf8',
  timeout: Math.min(timeout, 300000)
});
const deploymentText = [deployment.stdout, deployment.stderr, deployment.error?.message].filter(Boolean).join('\n');
if (deployment.stdout) process.stderr.write(deployment.stdout);
if (deployment.stderr) process.stderr.write(deployment.stderr);
const deploymentChecks = [
  {
    name: 'target deployment validation',
    ok: deployment.status === 0 && /CWD_DEPLOYMENT_VALIDATION_OK/.test(deploymentText),
    detail: deployment.status === 0 ? 'target deployment validator passed' : deploymentText.slice(-4000)
  },
  {
    name: 'authenticated hook/control-plane liveness proof',
    ok: /PASS\s+authenticated hook HMAC health proof/.test(deploymentText),
    detail: /PASS\s+authenticated hook HMAC health proof/.test(deploymentText) ? 'challenge-response HMAC proof passed' : 'deployment validator did not prove authenticated hook health'
  },
  {
    name: 'Codex plugin cache payload integrity',
    ok: /PASS\s+official Codex plugin cache matches sealed payload/.test(deploymentText),
    detail: /PASS\s+official Codex plugin cache matches sealed payload/.test(deploymentText) ? 'official Codex plugin cache equals sealed plugin payload' : 'deployment validator did not prove plugin cache payload integrity'
  },
  {
    name: 'active release tree matches install record',
    ok: /PASS\s+active release tree SHA-256 matches install record/.test(deploymentText),
    detail: /PASS\s+active release tree SHA-256 matches install record/.test(deploymentText) ? 'active release tree digest matches immutable install evidence' : 'deployment validator did not prove active release tree integrity'
  }
];

const result = spawnSync(process.execPath, ['scripts/production-seal.mjs'], {
  cwd: process.cwd(),
  env,
  encoding: 'utf8',
  timeout
});
if (result.stderr) process.stderr.write(result.stderr);
let production;
try {
  production = JSON.parse(String(result.stdout || '').trim());
} catch (error) {
  console.error(JSON.stringify({
    project: 'codex-worker-delegation',
    report: 'release-seal',
    status: 'CORE_NOT_SEALED',
    error: `Could not parse production seal output: ${error.message}`,
    productionExitCode: result.status,
    deploymentExitCode: deployment.status,
    stdoutTail: String(result.stdout || '').slice(-4000)
  }, null, 2));
  process.exit(1);
}
production.checks = [...(Array.isArray(production.checks) ? production.checks : []), ...deploymentChecks];
const classification = classifyProductionSeal(production);
const report = {
  project: 'codex-worker-delegation',
  report: 'release-seal',
  status: classification.coreStatus,
  desktopNativeStatus: classification.desktopNativeStatus,
  catalogStatus: classification.catalogStatus,
  productionStatus: production.status,
  productionExitCode: result.status,
  deploymentExitCode: deployment.status,
  passedChecks: classification.passedChecks,
  totalChecks: classification.totalChecks,
  coreFailures: classification.coreFailures,
  upstreamDesktopBlockers: classification.upstreamDesktopBlockers,
  catalogAdvisories: classification.catalogAdvisories,
  archiveReady: classification.coreStatus === 'CORE_SEALED' && classification.desktopNativeStatus === 'DESKTOP_NATIVE_SEALED',
  note: classification.desktopNativeStatus === 'DESKTOP_NATIVE_SEALED'
    ? 'Project-controlled runtime integration and official Desktop-native provider binding are both sealed.'
    : 'Project-controlled runtime integration can be sealed independently, but archiveReady remains false until the official Codex Desktop picker exposes provider-correct third-party bindings.'
};
console.log(JSON.stringify(report, null, 2));
if (classification.coreStatus !== 'CORE_SEALED') process.exitCode = 1;
