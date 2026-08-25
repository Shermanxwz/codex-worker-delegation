const $ = (id) => document.getElementById(id);
const PAGES = ['dashboard', 'login', 'security', 'provider', 'routing', 'connectivity', 'integration'];
const MODES = ['AUTO', 'DELEGATE', 'MAIN'];
const VISIBLE_ROLES = { AUTO: ['main', 'worker', 'verifier'], DELEGATE: ['main', 'worker', 'verifier'], MAIN: ['main'] };
const MODE_LABELS = { AUTO: 'AUTO', DELEGATE: 'WORKER', MAIN: 'MAIN' };
const MODE_HELP = {
  AUTO: '自动协调：Main、Worker、Verifier 使用各自指定的路由；是否实际委派由任务决定。默认建议 Worker / Verifier 使用低成本模型。',
  DELEGATE: 'Worker 模式：Main 负责协调，Worker 负责执行；Worker / Verifier 路由由用户明确指定，真实任务通过 delegate_worker 或路由测试启动。主控观察点由服务端自动处理：有实质进展就有界续期，失去进展或心跳就主动终止。Verifier 是只读验证角色。',
  MAIN: 'Main 模式：只运行主线程，禁用 Worker delegation。'
};
let state = null;
let catalog = { official: { models: [] }, thirdParty: { models: [] } };
let coexistenceProof = null;
let authState = null;
let currentPage = 'dashboard';
const modelTestResults = new Map();
const WORKER_TERMINAL_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'delegation_required']);
const GENERIC_THIRD_PARTY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = { auto: '模型 / 上游默认', none: 'none · 不额外推理', low: 'low · 快速', medium: 'medium · 平衡', high: 'high · 深度', xhigh: 'xhigh · 更深', max: 'max · 最大', ultra: 'ultra · 自动协作' };

async function api(path, opts = {}) {
  const response = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text }; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/status') {
      authState = { ...(authState || {}), configured: true, authenticated: false, required: true, minPasswordLength: 14 };
      renderAuth();
      navigate('login');
    }
    throw new Error(value?.error?.message || value?.error || response.statusText);
  }
  return value;
}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function providerKey(value) { return value === 'third_party' ? 'thirdParty' : 'official'; }
function modeLabel(mode) { return MODE_LABELS[mode] || mode; }
function modelRows(provider) {
  const rows = catalog?.[providerKey(provider)]?.models || [];
  return rows.map((model) => ({ id: model.model || model.id, name: model.displayName || model.name || model.model || model.id, kind: model.kind || 'chat' })).filter((model) => model.id && !(provider === 'third_party' && model.kind === 'embedding'));
}

function modelInfo(provider, model) {
  return (catalog?.[providerKey(provider)]?.models || []).find((row) => (row.model || row.id) === model) || null;
}

function supportedEfforts(provider, model) {
  const info = modelInfo(provider, model);
  const advertised = info?.supportedReasoningEfforts || info?.supported_reasoning_levels;
  if (Array.isArray(advertised) && advertised.length) {
    return advertised.map((item) => typeof item === 'string' ? item : (item.reasoningEffort || item.effort)).filter(Boolean);
  }
  return provider === 'third_party' ? GENERIC_THIRD_PARTY_EFFORTS : ['low', 'medium', 'high', 'xhigh', 'max'];
}

function effortOptions(provider, model, current = 'auto') {
  const values = ['auto', ...supportedEfforts(provider, model)];
  if (current && !values.includes(current)) values.splice(1, 0, current);
  return [...new Set(values)].map((value) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(EFFORT_LABELS[value] || value)}</option>`).join('');
}

function navigate(page) {
  const next = PAGES.includes(page) ? page : 'dashboard';
  if (authState?.required && !authState.authenticated && next !== 'login' && !(next === 'security' && !authState.configured)) {
    return navigate(authState.configured ? 'login' : 'security');
  }
  currentPage = next;
  const desiredHash = next === 'dashboard' ? '' : `#${next}`;
  if (window.location.hash !== desiredHash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${desiredHash}`);
  document.querySelectorAll('.page').forEach((node) => { node.hidden = node.dataset.page !== next; });
  document.querySelectorAll('.app-nav a[data-page-link]').forEach((node) => node.classList.toggle('active', node.dataset.pageLink === next));
  document.querySelectorAll('[data-page-link]').forEach((node) => node.setAttribute('aria-current', node.dataset.pageLink === next ? 'page' : 'false'));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function syncPage() { navigate((window.location.hash || '#dashboard').slice(1)); }

function renderAuth() {
  if (!authState) return;
  const setup = $('authSetup'); const loginPage = $('loginPageForm'); const change = $('authChange');
  setup.hidden = true; if (loginPage) loginPage.hidden = true; change.hidden = true;
  const configured = Boolean(authState.configured); const authenticated = Boolean(authState.authenticated);
  $('authMini').textContent = configured ? (authenticated ? '已登录' : '需登录') : (authState.required ? '需设置密码' : '未设置密码');
  $('authMini').classList.toggle('ok', configured && authenticated);
  $('authMini').classList.toggle('warn', !configured || !authenticated);
  if (!configured) {
    $('authBadge').textContent = authState.required ? '必须设置' : '建议设置';
    $('authPageStatus').textContent = '还没有设置控制面密码';
    $('authHint').textContent = `请设置至少 ${authState.minPasswordLength || 14} 位强密码，并再次确认。设置后会自动登录。`;
    setup.hidden = false;
  } else if (!authenticated) {
    $('authBadge').textContent = '需要登录';
    $('authPageStatus').textContent = '控制面已锁定';
    $('authHint').textContent = '登录入口已独立到“登录控制面”页面；访问保护页只负责密码策略和已登录后的管理。';
    if (loginPage) loginPage.hidden = false;
  } else {
    $('authBadge').textContent = '已登录';
    $('authPageStatus').textContent = '控制面已保护';
    $('authHint').textContent = '当前使用 HttpOnly、SameSite 会话。公网部署时还必须使用 HTTPS。';
    change.hidden = false;
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
  const effort = route?.effort || 'auto';
  const options = [...rows];
  if (current && !options.some((model) => model.id === current)) options.unshift({ id: current, name: `${current} · 当前/手填`, kind: modelInfo(provider, current)?.kind || 'chat' });
  return `<div class="route-row" data-route="${id}"><div class="route-role"><b>${role.toUpperCase()}</b><span class="route-kind" id="kind-${id}"></span></div><select class="route-provider" data-mode="${mode}" data-role="${role}"><option value="official" ${provider === 'official' ? 'selected' : ''}>Official ChatGPT</option><option value="third_party" ${provider === 'third_party' ? 'selected' : ''}>New API</option></select><div class="model-field"><select class="route-model" data-mode="${mode}" data-role="${role}">${options.map((model) => `<option value="${esc(model.id)}" ${model.id === current ? 'selected' : ''}>${esc(model.name)}${model.kind === 'embedding' ? ' · embedding 仅连通性' : ''} (${esc(model.id)})</option>`).join('')}<option value="__custom__">手动输入…</option></select><input class="route-custom" data-mode="${mode}" data-role="${role}" value="${esc(current && !rows.some((model) => model.id === current) ? current : '')}" placeholder="模型 ID" hidden></div><label class="effort-field">思考强度<select class="route-effort" data-mode="${mode}" data-role="${role}">${effortOptions(provider, current, effort)}</select></label></div>`;
}

function renderRouting() {
  if (!state) return;
  $('routing').innerHTML = MODES.map((mode) => `<div class="mode-routing ${mode === state.mode ? 'current' : ''}"><div class="mode-title"><h3>${modeLabel(mode)}</h3><span>${mode === state.mode ? '当前模式' : ''}</span></div>${VISIBLE_ROLES[mode].map((role) => routeRow(mode, role, state.routing?.[mode]?.[role])).join('')}</div>`).join('');
  document.querySelectorAll('.route-provider').forEach((element) => element.onchange = () => { syncRouteModels(element.dataset.mode, element.dataset.role, element.value); updateKinds(); });
  document.querySelectorAll('.route-model').forEach((element) => element.onchange = () => { const custom = findCustom(element.dataset.mode, element.dataset.role); custom.hidden = element.value !== '__custom__'; if (!custom.hidden) custom.focus(); syncRouteEffort(element.dataset.mode, element.dataset.role); updateKinds(); });
  updateKinds();
}

function findCustom(mode, role) { return document.querySelector(`.route-custom[data-mode="${mode}"][data-role="${role}"]`); }
function findModel(mode, role) { const select = document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`); const custom = findCustom(mode, role); return select?.value === '__custom__' ? custom.value.trim() : (select?.value || custom?.value || '').trim(); }
function findProvider(mode, role) { return document.querySelector(`.route-provider[data-mode="${mode}"][data-role="${role}"]`)?.value || 'official'; }
function findEffort(mode, role) { return document.querySelector(`.route-effort[data-mode="${mode}"][data-role="${role}"]`)?.value || 'auto'; }
function syncRouteModels(mode, role, provider) {
  const select = document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`); const custom = findCustom(mode, role); const previous = findModel(mode, role); const rows = modelRows(provider);
  select.innerHTML = rows.map((model) => `<option value="${esc(model.id)}">${esc(model.name)} (${esc(model.id)})</option>`).join('') + '<option value="__custom__">手动输入…</option>';
  if (rows.some((model) => model.id === previous)) select.value = previous; else { select.value = '__custom__'; custom.value = previous; }
  custom.hidden = select.value !== '__custom__';
  syncRouteEffort(mode, role);
}
function syncRouteEffort(mode, role) {
  const select = document.querySelector(`.route-effort[data-mode="${mode}"][data-role="${role}"]`);
  if (!select) return;
  const previous = select.value || 'auto'; const provider = findProvider(mode, role); const model = findModel(mode, role);
  select.innerHTML = effortOptions(provider, model, previous);
  if (!Array.from(select.options).some((option) => option.value === previous)) select.value = 'auto';
}
function routeKind(mode, role) { if (role === 'main') return mode === 'AUTO' ? 'Primary model' : 'Root Thread'; return role === 'verifier' ? 'Read-only Verifier' : 'Worker Thread'; }
function updateKinds() { for (const mode of MODES) for (const role of VISIBLE_ROLES[mode]) { const node = $(`kind-${mode}-${role}`); if (node) node.textContent = routeKind(mode, role); } }

function setDot(id, ok) { const node = $(id); if (!node) return; node.classList.toggle('ok', Boolean(ok)); node.classList.toggle('bad', !ok); }

function renderDashboard() {
  const account = catalog.official?.account; const officialOk = catalog.official?.ok && account?.type === 'chatgpt';
  const thirdOk = Boolean(state?.provider?.hasApiKey && catalog.thirdParty?.ok);
  $('dashboardMode').textContent = modeLabel(state?.mode || '—');
  $('dashboardHint').textContent = MODE_HELP[state?.mode] || '尚未读取路由。';
  $('dashboardOfficial').textContent = officialOk ? `已登录 · ${account.planType || 'ChatGPT'}` : (catalog.official?.error ? '检测失败' : '未确认');
  $('dashboardThird').textContent = thirdOk ? `${catalog.thirdParty.models.length} 个模型` : state?.provider?.hasApiKey ? '已配置，待检测' : '未配置';
  $('dashboardIntegration').textContent = authState?.configured ? (authState.authenticated ? '已保护' : '需登录') : '建议设置';
}

function renderProvider() {
  $('baseUrl').value = state?.provider?.baseUrl || ''; $('protocol').value = state?.provider?.protocol || 'auto';
}

function renderCoexistence() {
  const account = catalog.official?.account; const officialOk = catalog.official?.ok && account?.type === 'chatgpt';
  const thirdOk = Boolean(state?.provider?.hasApiKey && catalog.thirdParty?.ok);
  $('connectivitySummary').textContent = thirdOk ? `New API 已配置 · ${catalog.thirdParty.models.length} 个模型可发现` : 'New API 尚未完成模型发现';
  setDot('officialDot', officialOk); setDot('thirdDot', thirdOk);
}

function renderModelTests() {
  const models = catalog.thirdParty?.models || [];
  $('connectivitySummary').textContent = models.length ? `${state?.provider?.name || 'New API'} · ${models.length} 个模型 · 测试结果只代表当前上游实时状态` : '暂无 New API 模型目录';
  if (!models.length) { $('modelTests').innerHTML = '<p class="muted">暂无 New API 模型目录。请先到“New API 配置”保存并刷新。</p>'; return; }
  $('modelTests').innerHTML = models.map((model) => {
    const result = modelTestResults.get(model.id); const status = result ? `${result.ok ? 'PASS' : 'FAIL'} · ${result.protocol || 'unknown'}${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}` : '未测试';
    return `<div class="model-test-row" data-model="${esc(model.id)}"><div><b>${esc(model.name || model.id)}</b><span>${esc(model.id)}${model.kind === 'embedding' ? ' · embedding / 向量模型' : ''}</span></div><span class="model-test-status ${result?.ok ? 'ok' : result ? 'bad' : ''}">${esc(status)}</span><button class="test-one secondary" data-model="${esc(model.id)}">测试</button></div>`;
  }).join('');
  document.querySelectorAll('.test-one').forEach((button) => button.onclick = () => runConnectivity([button.dataset.model]));
}

function renderIntegration() {
  const official = catalog.official?.models || []; const third = catalog.thirdParty?.models || [];
  const officialIds = new Set(official.map((model) => model.model || model.id)); const overlap = third.map((model) => model.id).filter((id) => officialIds.has(id));
  const newApiOnly = third.map((model) => model.id).filter((id) => !officialIds.has(id));
  const pickerThirdParty = newApiOnly.filter((id) => officialIds.has(id));
  $('integrationState').textContent = state?.installed ? 'namespaced provider 已安装；官方 top-level provider/model 保持不变。' : '尚未安装 namespaced Codex provider。';
  $('nativeVisibility').textContent = `实测官方 Codex model/list：${official.length} 个；New API /v1/models：${third.length} 个；New API 独有 ID：${newApiOnly.length} 个；官方列表实际包含这些独有 ID：${pickerThirdParty.length} 个；同名模型：${overlap.length} 个。当前第三方线程可以真实运行，但官方 openai 下拉框没有 provider 绑定，不能把第三方 ID 合法地自动合并后再保证选中时走 New API。`;
}

function renderStatus() {
  $('status').textContent = JSON.stringify({ installed: state?.installed, activeRouting: state?.activeRouting, officialModelCount: catalog.official?.models?.length || 0, newApiModelCount: catalog.thirdParty?.models?.length || 0, coexistenceProof }, null, 2);
}

function selectedThirdPartyModel() {
  const candidates = [state?.routing?.AUTO?.worker, state?.routing?.AUTO?.verifier, state?.routing?.DELEGATE?.worker, state?.routing?.DELEGATE?.verifier, state?.routing?.AUTO?.main, state?.routing?.DELEGATE?.main, state?.routing?.MAIN?.main];
  return candidates.find((route) => route?.provider === 'third_party' && route.model)?.model || '';
}

async function refresh({ catalogToo = true } = {}) {
  state = await api('/api/state');
  $('health').textContent = `online · ${modeLabel(state.mode)}`;
  renderProvider();
  document.querySelectorAll('.modes [data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('modeHelp').textContent = MODE_HELP[state.mode] || '';
  if (catalogToo) await refreshCatalog(false);
  renderRouting(); renderModelTests(); renderCoexistence(); renderIntegration(); renderDashboard(); renderStatus();
}

async function refreshCatalog(render = true) {
  $('health').textContent = 'loading models…';
  try { catalog = await api('/api/catalog'); } catch (error) { catalog = { official: { models: [], error: error.message }, thirdParty: { models: [], error: error.message } }; }
  $('health').textContent = `online · ${modeLabel(state?.mode || '?')}`;
  if (render && state) { renderRouting(); renderModelTests(); renderCoexistence(); renderIntegration(); renderDashboard(); renderStatus(); }
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

async function boot() {
  syncPage();
  try { const health = await api('/api/health'); $('health').textContent = `${health.ok ? 'online' : 'offline'} · ${health.version || ''}`; } catch (error) { $('health').textContent = `offline · ${error.message}`; }
  try { await refreshAuth(); } catch (error) { $('authResult').textContent = error.message; return; }
  if (authState.required && !authState.authenticated) { navigate(authState.configured ? 'login' : 'security'); return; }
  try { await refresh(); } catch (error) { $('status').textContent = error.stack || error.message; }
}

window.addEventListener('hashchange', syncPage);
document.querySelectorAll('[data-page-link]').forEach((link) => link.addEventListener('click', () => navigate(link.dataset.pageLink)));
document.querySelectorAll('.modes [data-mode]').forEach((button) => button.onclick = async () => { try { await api('/api/mode', { method: 'PUT', body: JSON.stringify({ mode: button.dataset.mode }) }); coexistenceProof = null; await refresh({ catalogToo: false }); } catch (error) { $('routingResult').textContent = error.message; } });
$('dashboardRefresh').onclick = () => refresh();
$('saveProvider').onclick = async () => { try { await api('/api/provider', { method: 'PUT', body: JSON.stringify({ name: 'New API', baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value, protocol: $('protocol').value }) }); $('apiKey').value = ''; coexistenceProof = null; $('providerResult').textContent = 'New API 已保存，正在刷新模型目录…'; await refresh(); navigate('provider'); } catch (error) { $('providerResult').textContent = error.message; } };
 $('saveRouting').onclick = async () => { try { for (const mode of MODES) { const roles = {}; for (const role of VISIBLE_ROLES[mode]) roles[role] = { provider: findProvider(mode, role), model: findModel(mode, role), effort: findEffort(mode, role) }; await api('/api/routing', { method: 'PUT', body: JSON.stringify({ mode, roles }) }); } coexistenceProof = null; $('routingResult').textContent = '路由与思考强度已保存；AUTO 与 WORKER 的 Worker / Verifier 使用独立配置，未配置时 Verifier 默认跟随 Worker。'; await refresh({ catalogToo: false }); } catch (error) { $('routingResult').textContent = error.stack || error.message; } };
$('probe').onclick = async () => { try { $('providerResult').textContent = '正在探测…'; const model = selectedThirdPartyModel() || catalog.thirdParty?.models?.[0]?.id || ''; $('providerResult').textContent = JSON.stringify(await api('/api/provider/probe', { method: 'POST', body: JSON.stringify({ model }) }), null, 2); await refresh({ catalogToo: false }); } catch (error) { $('providerResult').textContent = error.message; } };
$('testAllModels').onclick = () => runConnectivity();
$('install').onclick = async () => { try { $('integrationState').textContent = '正在安装 / 刷新 namespaced provider…'; await api('/api/codex/install', { method: 'POST' }); coexistenceProof = null; await refresh(); navigate('integration'); } catch (error) { $('integrationState').textContent = error.stack || error.message; } };
 $('verifyCoexistence').onclick = async () => { try { const model = selectedThirdPartyModel() || catalog.thirdParty?.models?.[0]?.id; if (!model) throw new Error('当前没有可用的第三方模型'); $('coexistProof').textContent = '正在运行真实共存证明…'; coexistenceProof = await api('/api/verify/coexistence', { method: 'POST', body: JSON.stringify({ model }) }); $('coexistProof').textContent = JSON.stringify(coexistenceProof, null, 2); renderIntegration(); renderStatus(); } catch (error) { coexistenceProof = { ok: false, error: error.message }; $('coexistProof').textContent = JSON.stringify(coexistenceProof, null, 2); renderStatus(); } };
function workerTaskText(task) {
  const events = (task.events || []).slice(-10).map((event) => {
    const details = event.details ? ` · ${JSON.stringify(event.details)}` : '';
    return `${event.at} · ${event.type} · ${event.message}${details}`;
  }).join('\n');
  return [
    `任务 ID：${task.taskId || '无（当前路由需要主控 native spawn_agent）'}`,
    `状态：${task.status || 'unknown'} · 阶段：${task.phase || '—'} · 进度：${task.progress ?? 0}%`,
    `模型：${task.provider || '—'} / ${task.model || '—'} · 思考强度：${task.effort || 'auto'}`,
    `租约：${task.deadlineAt || '—'} · 自动观察点：${task.reviewAt || '—'}${task.reviewDue ? ' · 正在自动检查' : ''} · 已续期：${task.extensionCount || 0} 次（自动 ${task.autoExtensionCount || 0}）`,
    `最近心跳：${task.lastHeartbeatAt || '—'}`,
    `最近实质进展：${task.lastMeaningfulProgressAt || task.lastProgressAt || '—'} · 判定：${task.progressEvidence?.state || '—'}${task.progressEvidence?.meaningfulProgressAgeMs != null ? ` · 已 ${Math.round(task.progressEvidence.meaningfulProgressAgeMs / 1000)} 秒未有实质进展` : ''}`,
    task.lastReviewDecision ? `最近自动决策：${task.lastReviewDecision} · ${task.lastReviewReason || '—'} · 自动观察 ${task.autoReviewCount || 0} 次` : '',
    task.cancelRequestedAt ? `取消请求：${task.cancelRequestedAt} · ${task.cancelReason || '—'}` : '',
    `消息：${task.message || '—'}`,
    task.error ? `错误：${task.error.code || task.error.name || 'worker_error'} · ${task.error.message}` : '',
    task.output ? `\n输出：\n${task.output}` : '',
    events ? `\n最近事件：\n${events}` : ''
  ].filter(Boolean).join('\n');
}
async function watchWorkerTask(taskId) {
  while (true) {
    const task = await api(`/api/worker/status/${encodeURIComponent(taskId)}`);
    $('runResult').textContent = workerTaskText(task);
    if (WORKER_TERMINAL_STATES.has(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
 $('runWorker').onclick = async () => {
  try {
    $('runWorker').disabled = true;
    $('runResult').textContent = '正在创建 Worker 任务…';
    const started = await api('/api/worker/start', { method: 'POST', body: JSON.stringify({ role: $('testRole').value, task: $('testTask').value, profile: 'quick' }) });
    if (!started.taskId) { $('runResult').textContent = workerTaskText(started); return; }
    sessionStorage.setItem('cwd-last-worker-task', started.taskId);
    $('runResult').textContent = workerTaskText(started);
    await watchWorkerTask(started.taskId);
  } catch (error) { $('runResult').textContent = error.stack || error.message; }
  finally { $('runWorker').disabled = false; }
 };
$('setupPasswordButton').onclick = async () => { try { const password = $('setupPassword').value; const confirmPassword = $('setupPasswordConfirm').value; $('authResult').textContent = '正在设置密码…'; await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password, confirmPassword }) }); $('setupPassword').value = ''; $('setupPasswordConfirm').value = ''; $('authResult').textContent = '密码已设置，已自动登录。'; await boot(); } catch (error) { $('authResult').textContent = error.message; } };
$('loginPageButton').onclick = async () => { try { $('loginPageResult').textContent = '正在登录…'; await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('loginPagePassword').value }) }); $('loginPagePassword').value = ''; $('loginPageResult').textContent = '登录成功。'; await boot(); if (authState?.authenticated) navigate('dashboard'); } catch (error) { $('loginPageResult').textContent = error.message; } };
$('logoutButton').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); authState = null; await refreshAuth(); navigate('login'); } catch (error) { $('authResult').textContent = error.message; } };
$('changePasswordButton').onclick = async () => { try { const newPassword = $('newPassword').value; if (newPassword !== $('newPasswordConfirm').value) throw new Error('password confirmation does not match'); await api('/api/auth/change', { method: 'POST', body: JSON.stringify({ currentPassword: $('currentPassword').value, newPassword }) }); $('currentPassword').value = ''; $('newPassword').value = ''; $('newPasswordConfirm').value = ''; $('authResult').textContent = '密码已更换。'; await boot(); } catch (error) { $('authResult').textContent = error.message; } };

boot();
