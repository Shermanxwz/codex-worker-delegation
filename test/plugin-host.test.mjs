import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pluginRoot = path.resolve('plugins/codex-worker-delegation');
const mcpRunner = path.join(pluginRoot, 'mcp', 'run.sh');
const hookRunner = path.join(pluginRoot, 'hooks', 'run-policy.sh');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-plugin-host-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function hostEnv(extra = {}) {
  return { ...process.env, PATH: '/usr/bin:/bin', CWD_NODE_PATH: process.execPath, ...extra };
}

function waitForLine(processHandle, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('plugin host response timed out')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch (error) { reject(error); return; }
        if (predicate(value)) {
          clearTimeout(timer);
          processHandle.stdout.off('data', onData);
          resolve(value);
          return;
        }
      }
    };
    processHandle.stdout.setEncoding('utf8');
    processHandle.stdout.on('data', onData);
    processHandle.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('plugin MCP runner starts with a minimal PATH', async (t) => {
  const dataDir = await tempDir(t);
  const child = spawn('bash', [mcpRunner], { cwd: pluginRoot, env: hostEnv({ CWD_DATA_DIR: dataDir }) });
  t.after(() => child.kill());
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  const initialized = await waitForLine(child, (value) => value.id === 1);
  assert.equal(initialized.result.serverInfo.name, 'codex-worker-delegation');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const listed = await waitForLine(child, (value) => value.id === 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['delegation_status', 'delegate_worker', 'worker_status', 'worker_extend', 'worker_cancel']);
});

test('plugin policy runner blocks root Bash in DELEGATE with a minimal PATH', async (t) => {
  const dataDir = await tempDir(t);
  const stateFile = path.join(dataDir, 'state.json');
  await fs.writeFile(stateFile, JSON.stringify({ mode: 'DELEGATE' }));
  const child = spawn('bash', [hookRunner], { env: hostEnv({ CWD_STATE_FILE: stateFile }) });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', turn_id: 't' }));
  assert.equal(await exit, 0);
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /coordination-only/);
});
