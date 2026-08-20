const COORDINATION = new Set(['spawn_agent', 'send_message', 'wait_agent', 'followup_task', 'interrupt_agent', 'list_agents', 'Agent', 'update_plan']);
const SPAWN = new Set(['spawn_agent', 'Agent']);

export function evaluateTool({ mode = 'AUTO', toolName, agentId, agentType }) {
  const isSubagent = Boolean(agentId || agentType);
  if (mode === 'AUTO') return { allow: true, reason: 'AUTO mode delegates policy to native Codex orchestration.' };
  if (mode === 'DELEGATE') {
    if (isSubagent) return { allow: true, reason: 'Delegated subagent is allowed to execute.' };
    if (COORDINATION.has(toolName)) return { allow: true, reason: 'Root agent may coordinate native subagents.' };
    return { allow: false, reason: `DELEGATE mode keeps the root agent coordination-only; delegate ${toolName} to a subagent.` };
  }
  if (mode === 'MAIN') {
    if (isSubagent) return { allow: false, reason: 'MAIN mode freezes subagent tool execution.' };
    if (SPAWN.has(toolName)) return { allow: false, reason: 'MAIN mode disables new subagent spawning.' };
    return { allow: true, reason: 'MAIN mode allows root-agent tools.' };
  }
  return { allow: false, reason: `Unknown delegation mode ${mode}; failing closed.` };
}
