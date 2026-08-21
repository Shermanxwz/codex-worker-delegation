const DEFAULT_DESCRIPTION = 'Third-party model exposed through Codex Worker Delegation.';

/**
 * Codex's native custom-provider catalog is not the standard OpenAI /v1/models
 * response. It expects the internal ModelInfo shape under a top-level models
 * field. Keep this adapter deliberately conservative: third-party capabilities
 * are not guessed, so no reasoning levels or shell tools are advertised unless
 * the provider supplies a native catalog of its own.
 */
export function toCodexModelInfo(model, priority = 0) {
  const slug = String(model?.id || model?.model || model?.name || '').trim();
  const displayName = String(model?.name || slug).trim() || slug;
  const description = String(model?.description || DEFAULT_DESCRIPTION).trim();
  return {
    slug,
    display_name: displayName,
    description,
    base_instructions: '',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 100000 },
    supports_image_detail_original: false,
    context_window: null,
    max_context_window: null,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_parallel_tool_calls: false,
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: true,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null
  };
}

export function toCodexModelsResponse(models = []) {
  return { models: models.map((model, index) => toCodexModelInfo(model, index)) };
}
