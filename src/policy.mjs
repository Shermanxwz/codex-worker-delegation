const COORDINATION = new Set(['spawn_agent', 'send_message', 'wait_agent', 'followup_task', 'interrupt_agent', 'list_agents', 'Agent', 'update_plan', 'delegate_worker', 'delegation_status']);
const SPAWN = new Set(['spawn_agent', 'Agent']);
const VERIFIER_BLOCKED = [/exec/i, /shell/i, /apply_patch/i, /write/i, /edit/i, /delete/i, /move/i, /rename/i];

function isDelegationMcp(toolName = '') { const name=String(toolName); return name.includes('codex-worker-delegation') || name.endsWith('delegate_worker') || name.endsWith('delegation_status'); }
function roleFromSpawnInput(input = {}) { const type=String(input?.agent_type || input?.agentType || '').toLowerCase(); if(type.includes('verifier')) return 'verifier'; if(type.includes('worker')) return 'worker'; return null; }
function routeFor(state, mode, roleName) { return state?.routing?.[mode]?.[roleName] || null; }

export function executionPlan(main, route, roleName = 'worker') {
  if (route?.provider === 'official' && main?.provider === 'official') return { execution:'native_subagent_required', agentType:roleName==='verifier'?'cwd-verifier':'cwd-worker', reason:'Built-in OpenAI to built-in OpenAI can use current Codex native subagents.' };
  return { execution: route?.provider === main?.provider ? 'provider_isolated_thread' : 'cross_provider_thread', agentType:null, reason: route?.provider === 'third_party' || main?.provider === 'third_party' ? 'Third-party/native subagent transport remains unreliable in current Codex; use an explicit provider-specific App Server thread.' : 'Provider differs from the root thread; use a provider-specific App Server thread.' };
}

export function evaluateTool({ mode='AUTO', toolName, agentId, agentType, toolInput, state }) {
  const isSubagent=Boolean(agentId || agentType);
  const isVerifier=String(agentType||'').toLowerCase().includes('verifier');
  if (isVerifier && VERIFIER_BLOCKED.some((pattern)=>pattern.test(String(toolName)))) return {allow:false,reason:'Verifier role is read-only; mutation and execution tools are blocked.'};

  if (!isSubagent && SPAWN.has(toolName)) {
    const roleName=roleFromSpawnInput(toolInput);
    if (roleName) {
      const main=routeFor(state,mode,'main'); const route=routeFor(state,mode,roleName);
      if (main && route && executionPlan(main,route,roleName).execution !== 'native_subagent_required') return {allow:false,reason:`${mode}.${roleName} involves a third-party provider. Native spawn_agent is blocked because current Codex custom-provider subagent transport can lose task payloads; call delegate_worker instead.`};
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
    if (SPAWN.has(toolName) || String(toolName).endsWith('delegate_worker')) return {allow:false,reason:'MAIN mode disables worker spawning and delegation.'};
    return {allow:true,reason:'MAIN mode allows root-agent tools.'};
  }
  return {allow:false,reason:`Unknown delegation mode ${mode}; failing closed.`};
}
