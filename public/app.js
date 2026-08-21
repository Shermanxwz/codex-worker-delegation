const $ = (id) => document.getElementById(id);
const MODES = ['AUTO', 'DELEGATE', 'MAIN'];
const VISIBLE_ROLES = { AUTO: ['main'], DELEGATE: ['main', 'worker'], MAIN: ['main'] };
const MODE_LABELS = { AUTO: 'AUTO', DELEGATE: 'WORKER', MAIN: 'MAIN' };
const MODE_HELP = {
  AUTO: '自动协调：只选择一个主模型，Worker 和 Verifier 自动沿用该模型。',
  DELEGATE: 'Worker 模式：Main 负责协调，Worker 负责执行；Verifier 作为内部只读检查自动继承 Worker。',
  MAIN: 'Main 模式：只运行主线程，禁用 Worker delegation。'
};
let state = null;
let catalog = { official: { models: [] }, thirdParty: { models: [] } };
let coexistenceProof = null;
let authState = null;
const modelTestResults = new Map();

async function api(path, opts = {}) {
  const response = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
  if (!response.ok) throw new Error(value?.error?.message || value?.error || response.statusText);
  return value;
}

function providerKey(value) { return value === 'third_party' ? 'thirdParty' : 'official'; }
function modeLabel(mode) { return MODE_LABELS[mode] || mode; }
function modelRows(provider) {
  const rows = catalog?.[providerKey(provider)]?.models || [];
  return rows.map((model) => ({ id: model.model || model.id, name: model.displayName || model.name || model.model || model.id })).filter((model) => model.id);
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function renderAuth() {
  if (!authState) return;
  $('authSetup').hidden = true; $('authLogin').hidden = true; $('authChange').hidden = true;
  if (!authState.configured) {
    $('authBadge').textContent = authState.required ? '必须设置' : '建议设置';
    $('authHint').textContent = authState.required ? `公网访问必须先设置至少 ${authState.minPasswordLength} 位强密码。` : `当前为本机访问，建议现在设置至少 ${authState.minPasswordLength} 位强密码；设置后每次访问都需要登录。`;
    $('authSetup').hidden = false;
  } else if (!authState.authenticated) {
    $('authBadge').textContent = '需要登录';
    $('authHint').textContent = '控制面已启用密码保护，请登录后继续。';
    $('authLogin').hidden = false;
  } else {
    $('authBadge').textContent = '已登录';
    $('authHint').textContent = '控制面已使用 HttpOnly 会话保护；公网部署时请同时使用 HTTPS。';
    $('authChange').hidden = false;
  }
}

async function refreshAuth() {
  authState = await api('/api/auth/status');
  renderAuth();
  return authState;
}

function routeRow(mode, role, route) {
  const id = `${mode}-${role}`;
  const provider = route?.provider || 'official';
  const rows = modelRows(provider);
  const current = route?.model || '';
  const options = [...rows];
  if (current && !options.some((model) => model.id === current)) options.unshift({ id: current, name: `${current} · 当前/手填` });
  return `<div class="route-row" data-route="${id}"><div class="route-role"><b>${role.toUpperCase()}</b><span class="route-kind" id="kind-${id}"></span></div><select class="route-provider" data-mode="${mode}" data-role="${role}"><option value="official" ${provider === 'official' ? 'selected' : ''}>Official ChatGPT</option><option value="third_party" ${provider === 'third_party' ? 'selected' : ''}>New API</option></select><div class="model-field"><select class="route-model" data-mode="${mode}" data-role="${role}">${options.map((model) => `<option value="${esc(model.id)}" ${model.id === current ? 'selected' : ''}>${esc(model.name)} (${esc(model.id)})</option>`).join('')}<option value="__custom__">手动输入…</option></select><input class="route-custom" data-mode="${mode}" data-role="${role}" value="${esc(current && !rows.some((model) => model.id === current) ? current : '')}" placeholder="模型 ID" hidden></div></div>`;
}

function renderRouting() {
  if (!state) return;
  $('routing').innerHTML = MODES.map((mode) => `<div class="mode-routing ${mode === state.mode ? 'current' : ''}"><div class="mode-title"><h3>${modeLabel(mode)}</h3><span>${mode === state.mode ? '当前模式' : ''}</span></div>${VISIBLE_ROLES[mode].map((role) => routeRow(mode, role, state.routing?.[mode]?.[role])).join('')}</div>`).join('');
  document.querySelectorAll('.route-provider').forEach((element) => element.onchange = () => { syncRouteModels(element.dataset.mode, element.dataset.role, element.value); updateKinds(); });
  document.querySelectorAll('.route-model').forEach((element) => element.onchange = () => { const custom = findCustom(element.dataset.mode, element.dataset.role); custom.hidden = element.value !== '__custom__'; if (!custom.hidden) custom.focus(); updateKinds(); });
  updateKinds();
}

function findCustom(mode, role) { return document.querySelector(`.route-custom[data-mode="${mode}"][data-role="${role}"]`); }
function findModel(mode, role) { const select = document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`); const custom = findCustom(mode, role); return select?.value === '__custom__' ? custom.value.trim() : (select?.value || custom?.value || '').trim(); }
function findProvider(mode, role) { return document.querySelector(`.route-provider[data-mode="${mode}"][data-role="${role}"]`)?.value || 'official'; }
function syncRouteModels(mode, role, provider) {
  const select = document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`);
  const custom = findCustom(mode, role); const previous = findModel(mode, role); const rows = modelRows(provider);
  select.innerHTML = rows.map((model) => `<option value="${esc(model.id)}">${esc(model.name)} (${esc(model.id)})</option>`).join('') + '<option value="__custom__">手动输入…</option>';
  if (rows.some((model) => model.id === previous)) select.value = previous; else { select.value = '__custom__'; custom.value = previous; }
  custom.hidden = select.value !== '__custom__';
}
function routeKind(mode, role) { if (role === 'main') return mode === 'AUTO' ? 'Primary model' : 'Root Thread'; return 'Worker Thread'; }
function updateKinds() { for (const mode of MODES) for (const role of VISIBLE_ROLES[mode]) { const node = $(`kind-${mode}-${role}`); if (node) node.textContent = routeKind(mode, role); } }

function setDot(id, ok) { const node = $(id); if (!node) return; node.classList.toggle('ok', Boolean(ok)); node.classList.toggle('bad', !ok); }
function renderCoexistence() {
  const account = catalog.official?.account; const officialOk = catalog.official?.ok && account?.type === 'chatgpt';
  const thirdConfigured = Boolean(state?.provider?.hasApiKey); const thirdOk = thirdConfigured && catalog.thirdParty?.ok;
  const proofOk = coexistenceProof?.ok === true;
  setDot('officialDot', officialOk); setDot('thirdDot', thirdOk); setDot('coexistDot', coexistenceProof ? proofOk : officialOk && thirdOk);
  $('officialState').textContent = officialOk ? `已登录 ChatGPT · ${account.planType || 'plan unknown'}${account.email ? ` · ${account.email}` : ''}` : (catalog.official?.error || `Codex account: ${account?.type || '未登录 ChatGPT'}`);
  $('thirdState').textContent = thirdOk ? `已配置且 /v1/models 可用 · ${catalog.thirdParty.models.length} models` : thirdConfigured ? `已配置 · ${catalog.thirdParty?.error || '模型目录暂不可用，可手填模型 ID'}` : '未配置 New API';
  $('coexistState').textContent = coexistenceProof ? `${proofOk ? 'PASS' : 'FAIL'}：第三方线程 ${coexistenceProof.thirdParty?.status || '?'}，前后 ChatGPT=${coexistenceProof.officialChatGPTBefore?.type || '?'}→${coexistenceProof.officialChatGPTAfter?.type || '?'}，全局 selector ${coexistenceProof.globalSelectorUntouched ? '未改变' : '发生变化'}` : officialOk && thirdOk ? '两套凭证同时就绪；点击“真实共存验收”执行线程级证明。' : '需要同时满足 ChatGPT 登录 + New API 可用';
  $('coexistProof').textContent = coexistenceProof ? JSON.stringify(coexistenceProof, null, 2) : '';
}

function renderModelTests() {
  const models = catalog.thirdParty?.models || [];
  if (!models.length) { $('modelTests').innerHTML = '<p class="muted">暂无 New API 模型目录。</p>'; return; }
  $('modelTests').innerHTML = models.map((model) => {
    const result = modelTestResults.get(model.id); const status = result ? `${result.ok ? 'PASS' : 'FAIL'} · ${result.protocol || 'unknown'}${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}` : '未测试';
    return `<div class="model-test-row" data-model="${esc(model.id)}"><div><b>${esc(model.name || model.id)}</b><span>${esc(model.id)}</span></div><span class="model-test-status ${result?.ok ? 'ok' : result ? 'bad' : ''}">${esc(status)}</span><button class="test-one secondary" data-model="${esc(model.id)}">测试</button></div>`;
  }).join('');
  document.querySelectorAll('.test-one').forEach((button) => button.onclick = () => runConnectivity([button.dataset.model]));
}

async function runConnectivity(models) {
  try {
    $('modelTestResult').textContent = models?.length === 1 ? `正在测试 ${models[0]}…` : '正在测试全部模型…';
    const result = await api('/api/provider/connectivity', { method: 'POST', body: JSON.stringify(models?.length ? { models } : {}) });
    for (const row of result.results || []) modelTestResults.set(row.model, row);
    renderModelTests();
    $('modelTestResult').textContent = JSON.stringify({ tested: result.results?.length || 0, passed: (result.results || []).filter((row) => row.ok).length, failed: (result.results || []).filter((row) => !row.ok).length }, null, 2);
  } catch (error) { $('modelTestResult').textContent = error.stack || error.message; }
}

async function refresh({ catalogToo = true } = {}) {
  state = await api('/api/state');
  $('health').textContent = `online · ${modeLabel(state.mode)}`;
  $('baseUrl').value = state.provider?.baseUrl || ''; $('protocol').value = state.provider?.protocol || 'auto';
  document.querySelectorAll('.modes [data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('modeHelp').textContent = MODE_HELP[state.mode] || '';
  if (catalogToo) await refreshCatalog(false);
  renderRouting(); renderModelTests(); renderCoexistence(); renderStatus();
}

async function refreshCatalog(render = true) {
  $('health').textContent = 'loading models…';
  try { catalog = await api('/api/catalog'); } catch (error) { catalog = { official: { models: [], error: error.message }, thirdParty: { models: [], error: error.message } }; }
  $('health').textContent = `online · ${modeLabel(state?.mode || '?')}`;
  if (render && state) renderRouting(); renderModelTests(); renderCoexistence(); renderStatus();
}

function renderStatus() {
  $('status').textContent = JSON.stringify({ installed: state?.installed, activeRouting: state?.activeRouting, officialChatGPT: { account: catalog.official?.account || null, requiresOpenaiAuth: catalog.official?.requiresOpenaiAuth ?? null }, newApi: state?.provider && { name: state.provider.name, baseUrl: state.provider.baseUrl, protocol: state.provider.protocol, hasApiKey: state.provider.hasApiKey }, protocolCache: state?.protocolCache, coexistenceProof, catalog: { official: { ok: catalog.official?.ok, count: catalog.official?.models?.length || 0, error: catalog.official?.error || null }, thirdParty: { ok: catalog.thirdParty?.ok, count: catalog.thirdParty?.models?.length || 0, error: catalog.thirdParty?.error || null } } }, null, 2);
}

function selectedThirdPartyModel() {
  const candidates = [state?.routing?.DELEGATE?.worker, state?.routing?.AUTO?.main, state?.routing?.DELEGATE?.main, state?.routing?.MAIN?.main];
  return candidates.find((route) => route?.provider === 'third_party' && route.model)?.model || '';
}

async function boot() {
  try { const health = await api('/api/health'); $('health').textContent = `${health.ok ? 'online' : 'offline'} · ${health.version || ''}`; } catch (error) { $('health').textContent = `offline · ${error.message}`; }
  try { await refreshAuth(); } catch (error) { $('authResult').textContent = error.message; return; }
  if (authState.required && !authState.authenticated) return;
  try { await refresh(); } catch (error) { $('status').textContent = error.stack || error.message; }
}

document.querySelectorAll('.modes [data-mode]').forEach((button) => button.onclick = async () => { await api('/api/mode', { method: 'PUT', body: JSON.stringify({ mode: button.dataset.mode }) }); coexistenceProof = null; await refresh({ catalogToo: false }); });
$('saveProvider').onclick = async () => { try { await api('/api/provider', { method: 'PUT', body: JSON.stringify({ name: 'New API', baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value, protocol: $('protocol').value }) }); $('apiKey').value = ''; coexistenceProof = null; await refresh(); } catch (error) { $('probeResult').textContent = error.message; } };
$('refreshCatalog').onclick = () => refreshCatalog(true);
$('saveRouting').onclick = async () => { try { for (const mode of MODES) { const roles = {}; for (const role of VISIBLE_ROLES[mode]) roles[role] = { provider: findProvider(mode, role), model: findModel(mode, role) }; await api('/api/routing', { method: 'PUT', body: JSON.stringify({ mode, roles }) }); } coexistenceProof = null; await refresh({ catalogToo: false }); } catch (error) { $('status').textContent = error.stack || error.message; } };
$('probe').onclick = async () => { try { $('probeResult').textContent = 'probing…'; const model = selectedThirdPartyModel() || catalog.thirdParty?.models?.[0]?.id || ''; $('probeResult').textContent = JSON.stringify(await api('/api/provider/probe', { method: 'POST', body: JSON.stringify({ model }) }), null, 2); await refresh({ catalogToo: false }); } catch (error) { $('probeResult').textContent = error.message; } };
$('testAllModels').onclick = () => runConnectivity();
$('install').onclick = async () => { try { $('status').textContent = 'installing…'; await api('/api/codex/install', { method: 'POST' }); coexistenceProof = null; await refresh(); } catch (error) { $('status').textContent = error.stack || error.message; } };
$('verifyCoexistence').onclick = async () => { try { const model = selectedThirdPartyModel() || catalog.thirdParty?.models?.[0]?.id; if (!model) throw new Error('当前没有可用的第三方模型'); $('coexistProof').textContent = 'running real coexistence proof…'; coexistenceProof = await api('/api/verify/coexistence', { method: 'POST', body: JSON.stringify({ model }) }); renderCoexistence(); renderStatus(); } catch (error) { coexistenceProof = { ok: false, error: error.message }; renderCoexistence(); renderStatus(); } };
$('runWorker').onclick = async () => { try { $('runResult').textContent = 'running real Codex route…'; $('runResult').textContent = JSON.stringify(await api('/api/worker/run', { method: 'POST', body: JSON.stringify({ role: $('testRole').value, task: $('testTask').value }) }), null, 2); } catch (error) { $('runResult').textContent = error.stack || error.message; } };
$('setupPasswordButton').onclick = async () => { try { const password = $('setupPassword').value; $('authResult').textContent = 'setting password…'; await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }); $('setupPassword').value = ''; await boot(); } catch (error) { $('authResult').textContent = error.message; } };
$('loginButton').onclick = async () => { try { $('authResult').textContent = 'logging in…'; await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('loginPassword').value }) }); $('loginPassword').value = ''; await boot(); } catch (error) { $('authResult').textContent = error.message; } };
$('logoutButton').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); authState = null; await boot(); };
$('changePasswordButton').onclick = async () => { try { await api('/api/auth/change', { method: 'POST', body: JSON.stringify({ currentPassword: $('currentPassword').value, newPassword: $('newPassword').value }) }); $('currentPassword').value = ''; $('newPassword').value = ''; $('authResult').textContent = 'password changed'; await boot(); } catch (error) { $('authResult').textContent = error.message; } };

boot();
