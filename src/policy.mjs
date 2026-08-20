const COORDINATION = new Set(['spawn_agent', 'send_message', 'wait_agent', 'followup_task', 'interrupt_agent', 'list_agents', 'Agent', 'update_plan', 'delegate_worker', 'delegation_status']);
const SPAWN = new Set(['spawn_agent', 'Agent']);
const VERIFIER_BLOCKED = [/exec/i, /shell/i, /apply_patch/i, /write/i, /edit/i, /delete/i, /move/i, /rename/i];

function isDelegationMcp(toolName = '') {
  const name = String(toolName);
  return name.includes('codex-worker-delegation') || name.endsWith('delegate_worker') || name.endsWith('delegation_status');
}

export function evaluateTool({ mode = 'AUTO', toolName, agentId, agentType }) {
  const isSubagent = Boolean(agentId || agentType);
  const isVerifier = String(agentType || '').toLowerCase().includes('verifier');
  if (isVerifier && VERIFIER_BLOCKED.some((pattern) => pattern.test(String(toolName)))) {
    return { allow: false, reason: 'Verifier role is read-only; mutation and execution tools are blocked.' };
  }
  if (mode === 'AUTO') return { allow: true, reason: 'AUTO mode delegates policy to native Codex orchestration.' };
  if (mode === 'DELEGATE') {
    if (isSubagent) return { allow: true, reason: 'Delegated subagent is allowed to execute.' };
    if (COORDINATION.has(toolName) || isDelegationMcp(toolName)) return { allow: true, reason: 'Root agent may coordinate native or cross-provider workers.' };
    return { allow: false, reason: `DELEGATE mode keeps the root agent coordination-only; delegate ${toolName} to a worker.` };
  }
  if (mode === 'MAIN') {
    if (isSubagent) return { allow: false, reason: 'MAIN mode freezes subagent tool execution.' };
    if (SPAWN.has(toolName) || String(toolName).endsWith('delegate_worker')) return { allow: false, reason: 'MAIN mode disables worker spawning and delegation.' };
    return { allow: true, reason: 'MAIN mode allows root-agent tools.' };
  }
  return { allow: false, reason: `Unknown delegation mode ${mode}; failing closed.` };
}
