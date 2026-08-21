import { spawnSync } from 'node:child_process';
import { classifyProductionSeal } from '../src/seal.mjs';

const env = { ...process.env, CWD_SEAL_COMPACT: '0' };
const result = spawnSync(process.execPath, ['scripts/production-seal.mjs'], {
  cwd: process.cwd(),
  env,
  encoding: 'utf8',
  timeout: Number(process.env.CWD_RELEASE_SEAL_TIMEOUT_MS || 900000)
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
    stdoutTail: String(result.stdout || '').slice(-4000)
  }, null, 2));
  process.exit(1);
}
const classification = classifyProductionSeal(production);
const report = {
  project: 'codex-worker-delegation',
  report: 'release-seal',
  status: classification.coreStatus,
  desktopNativeStatus: classification.desktopNativeStatus,
  catalogStatus: classification.catalogStatus,
  productionStatus: production.status,
  passedChecks: classification.passedChecks,
  totalChecks: classification.totalChecks,
  coreFailures: classification.coreFailures,
  upstreamDesktopBlockers: classification.upstreamDesktopBlockers,
  catalogAdvisories: classification.catalogAdvisories,
  archiveReady: classification.coreStatus === 'CORE_SEALED' && classification.desktopNativeStatus === 'DESKTOP_NATIVE_SEALED',
  note: classification.desktopNativeStatus === 'DESKTOP_NATIVE_SEALED'
    ? 'Project-controlled runtime integration and official Desktop-native model visibility are both sealed.'
    : 'Project-controlled runtime integration can be sealed independently, but archiveReady remains false until the official Codex Desktop picker exposes provider-correct third-party bindings.'
};
console.log(JSON.stringify(report, null, 2));
if (classification.coreStatus !== 'CORE_SEALED') process.exitCode = 1;
