export const SEAL_CLASSIFICATIONS = Object.freeze({
  UPSTREAM_DESKTOP: new Set(['official Codex model picker includes discovered New API-only models']),
  CATALOG_ADVISORY: new Set(['all discovered New API models are Codex-routeable'])
});

export function classifyProductionSeal(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const failed = checks.filter((check) => check?.ok !== true);
  const upstreamDesktopBlockers = failed.filter((check) => SEAL_CLASSIFICATIONS.UPSTREAM_DESKTOP.has(check.name));
  const catalogAdvisories = failed.filter((check) => SEAL_CLASSIFICATIONS.CATALOG_ADVISORY.has(check.name));
  const nonCoreNames = new Set([...SEAL_CLASSIFICATIONS.UPSTREAM_DESKTOP, ...SEAL_CLASSIFICATIONS.CATALOG_ADVISORY]);
  const coreFailures = failed.filter((check) => !nonCoreNames.has(check.name));
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
