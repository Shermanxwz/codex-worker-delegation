import { createApp } from './server.mjs';
import { StateStore, activeProfile, completeProfileForMode } from './store.mjs';
import { CodexConfigManager } from './codex-config.mjs';
import { CodexAppServerService, resolveCodexBinary } from './codex-app-server.mjs';
import { statePath, codexHome, gatewayTokenPath } from './paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'doctor';
const env = process.env; const store = new StateStore({ env });
if (cmd === 'doctor') {
  const state = await store.read();
  let codexBinary = null; try { codexBinary = await resolveCodexBinary({ env, cwd: root }); } catch {}
  const report = { node: process.version, stateFile: statePath(env), codexHome: codexHome(env), configuredProvider: Boolean(state.provider), mode: state.mode, profile: activeProfile(state), integrationInstalled: state.installed, integration: state.integration, gatewayTokenExists: await exists(gatewayTokenPath(env)), codexBinary };
  console.log(JSON.stringify(report, null, 2));
} else if (cmd === 'install') {
  const state = await store.read(); const profile = completeProfileForMode(activeProfile(state), state.mode);
  await new CodexAppServerService({ env, cwd: root }).installLocalPlugin(root, 'codex-worker-delegation');
  await store.ensureGatewayToken();
  const manager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${env.CWD_PORT || 8788}/v1` }); const snap = await manager.install({ profile });
  await store.update((s)=>{ if(!s.originalTopLevel) s.originalTopLevel=snap.originalTopLevel; s.installed=true; s.integration={transport:'app-server',pluginId:'codex-worker-delegation',lastInstalledAt:new Date().toISOString()}; return s; });
  console.log('Codex integration installed through app-server without touching auth.json or the built-in openai provider.');
} else if (cmd === 'official') {
  const state = await store.read(); await new CodexConfigManager({ env }).restoreOfficial(state.originalTopLevel || {}); console.log('Restored the exact pre-install top-level main selection.');
} else if (cmd === 'serve') {
  const app=createApp({env}); app.server.listen(app.port,app.host);
} else throw new Error(`Unknown command: ${cmd}`);

async function exists(p){try{await fs.access(p);return true}catch{return false}}
