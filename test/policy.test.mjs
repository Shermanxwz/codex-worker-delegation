import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTool } from '../src/policy.mjs';

test('DELEGATE makes root coordination-only but allows subagent body work',()=>{
  assert.equal(evaluateTool({mode:'DELEGATE',toolName:'exec_command'}).allow,false);
  assert.equal(evaluateTool({mode:'DELEGATE',toolName:'spawn_agent'}).allow,true);
  assert.equal(evaluateTool({mode:'DELEGATE',toolName:'exec_command',agentId:'child'}).allow,true);
});
test('MAIN blocks spawning and freezes existing subagents',()=>{
  assert.equal(evaluateTool({mode:'MAIN',toolName:'exec_command'}).allow,true);
  assert.equal(evaluateTool({mode:'MAIN',toolName:'spawn_agent'}).allow,false);
  assert.equal(evaluateTool({mode:'MAIN',toolName:'exec_command',agentType:'worker'}).allow,false);
});
test('unknown mode fails closed',()=>assert.equal(evaluateTool({mode:'???',toolName:'read'}).allow,false));
