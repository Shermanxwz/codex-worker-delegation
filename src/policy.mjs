const COORDINATION = new Set(['spawn_agent', 'send_message', 'wait_agent', 'followup_task', 'interrupt_agent', 'list_agents', 'Agent', 'update_plan']);
const SPAWN = new Set(['spawn_agent', 'Agent']);
const DELEGATION_TOOLS = new Set(['delegate_worker', 'delegation_status', 'worker_status', 'worker_extend', 'worker_cancel']);
const VERIFIER_BLOCKED = [/exec/i, /shell/i, /apply_patch/i, /write/i, /edit/i, /delete/i, /move/i, /rename/i, /create/i, /mkdir/i, /chmod/i, /chown/i, /truncate/i, /commit/i];

function isDelegationMcp(toolName = '') {
  const name = String(toolName);
  for (const tool of DELEGATION_TOOLS) {
    if (name === tool || name.endsWith(`__${tool}`) || name.endsWith(`.${tool}`) || name.endsWith(`/${tool}`)) return true;
  }
  return false;
}
function roleFromSpawnInput(input = {}) { const type=String(input?.agent_type || input?.agentType || '').toLowerCase(); if(type.includes('verifier')) return 'verifier'; if(type.includes('worker')) return 'worker'; return null; }
function routeFor(state, mode, roleName) { return state?.routing?.[mode]?.[roleName] || null; }

export function executionPlan(main, route, roleName = 'worker') {
  if (route?.provider === 'official' && main?.provider === 'official') return { execution:'native_subagent_required', agentType:roleName==='verifier'?'cwd-verifier':'cwd-worker', reason:'Built-in OpenAI to built-in OpenAI can use current Codex native subagents.' };
  return { execution: route?.provider === main?.provider ? 'provider_isolated_thread' : 'cross_provider_thread', agentType:null, reason: route?.provider === 'third_party' || main?.provider === 'third_party' ? 'Third-party/native subagent transport remains unreliable in current Codex; use an explicit provider-specific App Server thread.' : 'Provider differs from the root thread; use a provider-specific App Server thread.' };
}

export function evaluateTool({ mode='OFFICIAL', toolName, agentId, agentType, toolInput, state }) {
  const isSubagent=Boolean(agentId || agentType);
  const isVerifier=String(agentType||'').toLowerCase().includes('verifier');

  // OFFICIAL is deliberately dormant. It exists so a fresh installation can
  // inherit Codex's native tool, model and multi-agent behavior without this
  // plugin shadowing upstream policy. This check must happen before verifier
  // restrictions because OFFICIAL means the plugin has no policy authority.
  if (mode === 'OFFICIAL') return {allow:true,reason:'OFFICIAL mode defers tool and multi-agent policy to the installed Codex runtime.'};

  if (isVerifier && VERIFIER_BLOCKED.some((pattern)=>pattern.test(String(toolName)))) return {allow:false,reason:'Verifier role is read-only; mutation and execution tools are blocked.'};

  if (!isSubagent && SPAWN.has(toolName)) {
    const roleName=roleFromSpawnInput(toolInput);
    if (mode === 'DELEGATE' && !roleName) return {allow:false,reason:'DELEGATE mode blocks unmanaged native subagent types. Use cwd-worker/cwd-verifier or delegate_worker so provider routing remains enforceable.'};
    if (roleName) {
      const main=routeFor(state,mode,'main'); const route=routeFor(state,mode,roleName);
      if (!main || !route) return {allow:false,reason:`${mode}.${roleName} routing is unavailable; failing closed.`};
      if (executionPlan(main,route,roleName).execution !== 'native_subagent_required') return {allow:false,reason:`${mode}.${roleName} involves a third-party provider. Native spawn_agent is blocked because current Codex custom-provider subagent transport can lose task payloads; call delegate_worker instead.`};
    }
  }

  if (mode==='AUTO') return {allow:true,reason:'AUTO mode delegates policy to Codex orchestration after provider-route safety checks.'};
  if (mode==='DELEGATE') {
    if (isSubagent) return {allow:true,reason:'Delegated subagent is allowed to execute.'};
    if (COORDINATION.has(toolName) || isDelegationMcp(toolName)) return {allow:true,reason:'Root agent may coordinate native or provider-isolated workers.'};
    return {allow:false,reason:`DELEGATE mode keeps the root agent coordination-only; delegate ${toolName} to a worker.`};
  }
  if (mode==='MAIN') {
    if (isSubagent) return {allow:false,reason:'MAIN mode freezes subagent tool execution.'};
    if (SPAWN.has(toolName) || isDelegationMcp(toolName) && String(toolName).match(/(?:^|__|\.|\/)(?:delegate_worker|worker_extend)$/)) return {allow:false,reason:'MAIN mode disables worker spawning and lease extension.'};
    return {allow:true,reason:'MAIN mode allows root-agent tools and existing-worker inspection/cancellation.'};
  }
  return {allow:false,reason:`Unknown delegation mode ${mode}; failing closed.`};
}
