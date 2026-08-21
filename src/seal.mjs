const DESKTOP_VISIBILITY_CHECK = 'official Codex model picker includes discovered New API-only models';
const DESKTOP_PROVIDER_BINDING_CHECK = 'official Codex Desktop proves provider binding for discovered New API-only models';

export const REQUIRED_CORE_CHECKS = Object.freeze([
  'official Codex runtime',
  'ChatGPT Linux bundled runtime discovery',
  'repository static/check contract',
  'repository test suite',
  'official Codex plugin installation',
  'plugin is installed and enabled',
  'encrypted New API provider is configured',
  'loopback control plane health',
  'namespaced Codex provider installed without selector switching',
  'official ChatGPT account is readable',
  'third-party model discovery is live',
  'third-party model connectivity matrix executed',
  'real official/New API coexistence proof',
  'real third-party Worker delegation',
  'ChatGPT auth.json is byte-for-byte unchanged',
  'official top-level model selectors are unchanged',
  'managed provider config is present'
]);

export const SEAL_CLASSIFICATIONS = Object.freeze({
  UPSTREAM_DESKTOP: new Set([DESKTOP_VISIBILITY_CHECK, DESKTOP_PROVIDER_BINDING_CHECK]),
  CATALOG_ADVISORY: new Set(['all discovered New API models are Codex-routeable'])
});

function missingCheck(name, category) {
  return { name, ok: false, detail: `required ${category} seal evidence is missing from the production report` };
}

export function classifyProductionSeal(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const byName = new Map(checks.filter((check) => check?.name).map((check) => [check.name, check]));
  const failed = checks.filter((check) => check?.ok !== true);
  const upstreamDesktopBlockers = failed.filter((check) => SEAL_CLASSIFICATIONS.UPSTREAM_DESKTOP.has(check.name));
  for (const name of SEAL_CLASSIFICATIONS.UPSTREAM_DESKTOP) if (!byName.has(name)) upstreamDesktopBlockers.push(missingCheck(name, 'Desktop-native'));
  const catalogAdvisories = failed.filter((check) => SEAL_CLASSIFICATIONS.CATALOG_ADVISORY.has(check.name));
  const nonCoreNames = new Set([...SEAL_CLASSIFICATIONS.UPSTREAM_DESKTOP, ...SEAL_CLASSIFICATIONS.CATALOG_ADVISORY]);
  const coreFailures = failed.filter((check) => !nonCoreNames.has(check.name));
  for (const name of REQUIRED_CORE_CHECKS) if (!byName.has(name)) coreFailures.push(missingCheck(name, 'core'));
  const coreSealed = checks.length > 0 && coreFailures.length === 0;
  const desktopNativeSealed = coreSealed && upstreamDesktopBlockers.length === 0;
  const fullCatalogSealed = coreSealed && catalogAdvisories.length === 0;
  return {
    coreStatus: coreSealed ? 'CORE_SEALED' : 'CORE_NOT_SEALED',
    desktopNativeStatus: desktopNativeSealed ? 'DESKTOP_NATIVE_SEALED' : 'DESKTOP_NATIVE_NOT_SEALED',
    catalogStatus: fullCatalogSealed ? 'FULL_CATALOG_SEALED' : 'CATALOG_ADVISORY',
    coreFailures,
    upstreamDesktopBlockers,
    catalogAdvisories,
    passedChecks: checks.filter((check) => check?.ok === true).length,
    totalChecks: checks.length
  };
}
