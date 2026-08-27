const MAX_MODEL_ID_LENGTH = 512;
const MAX_EFFORT_LENGTH = 128;

function text(value, max = 4096) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function effortValue(item) {
  if (typeof item === 'string') return text(item, MAX_EFFORT_LENGTH);
  if (!item || typeof item !== 'object') return '';
  return text(item.reasoningEffort ?? item.reasoning_effort ?? item.effort ?? item.value ?? item.id, MAX_EFFORT_LENGTH);
}

function effortDescription(item) {
  if (!item || typeof item !== 'object') return '';
  return text(item.description ?? item.label ?? item.name, 2048);
}

export function normalizeReasoningOptions(advertised) {
  if (!Array.isArray(advertised)) return [];
  const seen = new Set();
  const output = [];
  for (const item of advertised) {
    const value = effortValue(item);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push({ value, description: effortDescription(item) });
  }
  return output;
}

function defaultReasoning(raw, options) {
  const value = effortValue(raw);
  return value && options.some((item) => item.value === value) ? value : null;
}

function officialModel(raw = {}) {
  const id = text(raw.model || raw.id, MAX_MODEL_ID_LENGTH);
  if (!id) return null;
  const reasoningOptions = normalizeReasoningOptions(raw.supportedReasoningEfforts ?? raw.supported_reasoning_efforts ?? raw.supported_reasoning_levels);
  return {
    provider: 'official',
    id,
    catalogId: text(raw.id, MAX_MODEL_ID_LENGTH) || id,
    displayName: text(raw.displayName ?? raw.display_name ?? raw.name, 1024) || id,
    description: text(raw.description, 4096),
    hidden: raw.hidden === true,
    isDefault: raw.isDefault === true || raw.is_default === true,
    multiAgentVersion: raw.multiAgentVersion ?? raw.multi_agent_version ?? null,
    inputModalities: Array.isArray(raw.inputModalities ?? raw.input_modalities) ? [...(raw.inputModalities ?? raw.input_modalities)] : [],
    reasoning: {
      advertised: reasoningOptions.length > 0,
      source: 'codex_model_list',
      options: reasoningOptions,
      default: defaultReasoning(raw.defaultReasoningEffort ?? raw.default_reasoning_effort ?? raw.default_reasoning_level, reasoningOptions)
    },
    raw
  };
}

function thirdPartyModel(raw = {}) {
  const id = text(raw.id || raw.model || raw.name, MAX_MODEL_ID_LENGTH);
  if (!id) return null;
  const reasoningOptions = normalizeReasoningOptions(raw.supportedReasoningEfforts ?? raw.supported_reasoning_efforts ?? raw.supported_reasoning_levels);
  return {
    provider: 'third_party',
    id,
    catalogId: id,
    displayName: text(raw.displayName ?? raw.display_name ?? raw.name, 1024) || id,
    description: text(raw.description, 4096),
    hidden: false,
    isDefault: raw.isDefault === true || raw.is_default === true,
    multiAgentVersion: raw.multiAgentVersion ?? raw.multi_agent_version ?? null,
    inputModalities: Array.isArray(raw.inputModalities ?? raw.input_modalities) ? [...(raw.inputModalities ?? raw.input_modalities)] : ['text'],
    reasoning: {
      advertised: reasoningOptions.length > 0,
      source: reasoningOptions.length ? 'upstream_model_catalog' : 'not_advertised',
      options: reasoningOptions,
      default: defaultReasoning(raw.defaultReasoningEffort ?? raw.default_reasoning_effort ?? raw.default_reasoning_level, reasoningOptions)
    },
    kind: raw.kind || 'chat',
    raw
  };
}

function defaultModel(models) {
  const visible = models.filter((item) => !item.hidden && item.kind !== 'embedding');
  return visible.find((item) => item.isDefault)?.id || visible[0]?.id || models.find((item) => item.isDefault)?.id || models[0]?.id || '';
}

function accountSummary(accountRead) {
  const account = accountRead?.account || null;
  return {
    type: account?.type || null,
    email: account?.email || null,
    planType: account?.planType || null,
    requiresOpenaiAuth: accountRead?.requiresOpenaiAuth ?? null
  };
}

export function buildModelCapabilityRegistry({
  officialModels = [],
  thirdPartyModels = [],
  accountRead = null,
  officialProviderCapabilities = null,
  thirdPartyConfigured = false
} = {}) {
  const official = officialModels.map(officialModel).filter(Boolean);
  const thirdParty = thirdPartyModels.map(thirdPartyModel).filter(Boolean).filter((item) => item.kind !== 'embedding');
  const officialOAuth = accountRead?.account?.type === 'chatgpt';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    authentication: {
      officialOAuth,
      officialAccount: accountSummary(accountRead)
    },
    mainPolicy: officialOAuth
      ? {
          providerLocked: true,
          lockedProvider: 'official',
          reason: 'ChatGPT OAuth is active; Main is the official Codex root and cannot be represented as a third-party provider.'
        }
      : {
          providerLocked: false,
          lockedProvider: null,
          reason: 'No active ChatGPT OAuth session was observed; a standalone Main provider may be selected.'
        },
    providers: {
      official: {
        available: official.length > 0,
        configured: true,
        source: 'codex_app_server',
        capabilities: officialProviderCapabilities || null,
        defaultModel: defaultModel(official),
        models: official
      },
      third_party: {
        available: thirdParty.length > 0,
        configured: Boolean(thirdPartyConfigured),
        source: 'upstream_model_catalog',
        capabilities: null,
        defaultModel: defaultModel(thirdParty),
        models: thirdParty
      }
    }
  };
}

export function capabilityFor(registry, provider, model) {
  const key = provider === 'third_party' ? 'third_party' : 'official';
  return registry?.providers?.[key]?.models?.find((item) => item.id === model || item.catalogId === model) || null;
}

export function reasoningScale(registry, provider, model) {
  const capability = capabilityFor(registry, provider, model);
  const options = capability?.reasoning?.options || [];
  return {
    advertised: Boolean(capability?.reasoning?.advertised),
    source: capability?.reasoning?.source || 'unknown',
    default: capability?.reasoning?.default || null,
    values: [
      { value: 'auto', description: 'Use the selected model/provider upstream default.' },
      ...options.map((item) => ({ value: item.value, description: item.description || '' }))
    ]
  };
}

function safeProvider(value, fallback = 'official') {
  return value === 'third_party' || value === 'official' ? value : fallback;
}

function safeEffort(value) {
  const normalized = text(value || 'auto', MAX_EFFORT_LENGTH);
  return normalized || 'auto';
}

export function reconcileRoleRoute(route = {}, { role = 'worker', registry } = {}) {
  let provider = safeProvider(route.provider);
  if (role === 'main' && registry?.mainPolicy?.providerLocked) provider = 'official';
  const providerEntry = registry?.providers?.[provider];
  let model = text(route.model, MAX_MODEL_ID_LENGTH);
  let capability = capabilityFor(registry, provider, model);
  if (!capability) {
    model = providerEntry?.defaultModel || '';
    capability = capabilityFor(registry, provider, model);
  }
  let effort = safeEffort(route.effort);
  if (effort !== 'auto') {
    const supported = new Set((capability?.reasoning?.options || []).map((item) => item.value));
    if (!supported.has(effort)) effort = 'auto';
  }
  return {
    provider,
    model,
    effort,
    changed: provider !== route.provider || model !== String(route.model || '') || effort !== String(route.effort || 'auto')
  };
}

export function validateRoleRoute(route = {}, { role = 'worker', registry, requireModel = true } = {}) {
  const provider = safeProvider(route.provider, '');
  if (!provider) throw new Error(`${role}.provider must be official or third_party`);
  if (role === 'main' && registry?.mainPolicy?.providerLocked && provider !== 'official') {
    const error = new Error('Main provider is locked to Official ChatGPT while ChatGPT OAuth is active');
    error.code = 'MAIN_PROVIDER_LOCKED_BY_CHATGPT_AUTH';
    error.statusCode = 409;
    throw error;
  }
  const model = text(route.model, MAX_MODEL_ID_LENGTH);
  if (requireModel && !model) throw new Error(`${role}.model is required`);
  const capability = model ? capabilityFor(registry, provider, model) : null;
  if (model && !capability) {
    const error = new Error(`${role}.model is not present in the current ${provider} capability registry`);
    error.code = 'MODEL_NOT_IN_CAPABILITY_REGISTRY';
    error.statusCode = 409;
    throw error;
  }
  const effort = safeEffort(route.effort);
  if (effort !== 'auto') {
    const supported = new Set((capability?.reasoning?.options || []).map((item) => item.value));
    if (!supported.has(effort)) {
      const error = new Error(`${role}.effort ${effort} is not advertised by the selected model`);
      error.code = 'REASONING_EFFORT_NOT_ADVERTISED';
      error.statusCode = 409;
      throw error;
    }
  }
  return { provider, model, effort, capability };
}

export function reconcileRoutingWithRegistry(routing = {}, registry) {
  const output = structuredClone(routing || {});
  const changes = [];
  for (const [mode, roles] of Object.entries(output)) {
    for (const [role, route] of Object.entries(roles || {})) {
      const next = reconcileRoleRoute(route, { role, registry });
      if (next.changed) changes.push({ mode, role, before: route, after: { provider: next.provider, model: next.model, effort: next.effort } });
      roles[role] = { provider: next.provider, model: next.model, effort: next.effort };
    }
  }
  return { routing: output, changes };
}
