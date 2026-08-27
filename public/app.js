const $ = (id) => document.getElementById(id);
const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

const MODE_LABELS = { OFFICIAL: '官方默认', AUTO: 'AUTO', DELEGATE: 'WORKER', MAIN: 'MAIN' };
const MODE_HINTS = {
  OFFICIAL: '完全交回已安装的 Codex runtime：本插件不覆盖工具、多 Agent、模型或 reasoning 默认策略。',
  AUTO: '官方 Main 处理简单工作，并按需把适合的工作交给 Worker / Verifier。',
  DELEGATE: 'Main 只负责协调，实际工作必须交给 Worker；Verifier 负责独立复核。',
  MAIN: '只运行 Main；禁止 Worker delegation。没有 ChatGPT OAuth 时，第三方 Main 作为独立 App Server thread 运行。'
};

const app = {
  auth: null,
  state: null,
  catalog: null,
  selectedRoutingMode: 'OFFICIAL',
  routeDraft: null,
  health: null,
  busy: false
};

async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (init.body && typeof init.body !== 'string') {
    init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || response.statusText }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status; error.code = body?.code || null; error.body = body;
    if (response.status === 401 && path !== '/api/auth/login') await refreshAuth().catch(() => {});
    throw error;
  }
  return body;
}

function setMessage(id, message = '', tone = '') {
  const el = $(id); if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
}

function setPill(el, text, tone = 'neutral') {
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill ${tone}`;
}

function showLogin(show) {
  $('loginView').hidden = !show;
  $('appShell').hidden = show;
  if (show) setTimeout(() => $('loginPassword')?.focus(), 20);
}

async function refreshHealth() {
  try {
    app.health = await api('/api/health');
    setPill($('healthPill'), `在线 · ${app.health.version}`, 'good');
  } catch {
    setPill($('healthPill'), '离线', 'bad');
  }
}

async function refreshAuth() {
  app.auth = await api('/api/auth/status');
  const needsLogin = app.auth.configured && !app.auth.authenticated;
  showLogin(needsLogin);
  if (app.auth.configured && app.auth.authenticated) setPill($('authPill'), '已登录', 'good');
  else if (!app.auth.configured) setPill($('authPill'), '未设置密码', 'warn');
  else setPill($('authPill'), '需登录', 'warn');
  renderSecurity();
  return !needsLogin;
}

async function refreshData() {
  const [state, catalog] = await Promise.all([api('/api/state'), api('/api/catalog')]);
  app.state = state;
  app.catalog = catalog;
  if (!app.selectedRoutingMode || !['OFFICIAL','AUTO','DELEGATE','MAIN'].includes(app.selectedRoutingMode)) app.selectedRoutingMode = state.mode;
  renderAll();
}

async function refreshAll() {
  await refreshHealth();
  const allowed = await refreshAuth();
  if (allowed) await refreshData();
}

function currentPage() {
  const page = String(location.hash || '#dashboard').slice(1);
  return ['dashboard','provider','routing','connectivity','security'].includes(page) ? page : 'dashboard';
}

function renderNavigation() {
  const page = currentPage();
  qsa('[data-page]').forEach((section) => { section.hidden = section.dataset.page !== page; });
  qsa('[data-page-link]').forEach((link) => link.classList.toggle('active', link.dataset.pageLink === page));
  if (page === 'routing') renderRouting();
  if (page === 'security') renderSecurity();
}

function renderAll() {
  renderNavigation();
  renderDashboard();
  renderProvider();
  renderConnectivity();
  renderIntegration();
  renderSecurity();
}

function runtime() { return app.catalog?.runtime || {}; }
function registry() { return app.catalog?.registry || { providers: {}, authentication: {}, mainPolicy: {} }; }

function renderDashboard() {
  if (!app.state || !app.catalog) return;
  const rt = runtime();
  $('currentMode').textContent = MODE_LABELS[rt.mode] || rt.mode || '—';
  const badge = $('effectiveBadge');
  badge.textContent = rt.effective ? '已生效' : '未生效';
  badge.className = `effective-badge ${rt.effective ? 'good' : 'bad'}`;
  $('modeDescription').textContent = MODE_HINTS[rt.mode] || '—';

  if (rt.mainProviderLocked) {
    $('mainBoundary').textContent = 'Official ChatGPT 🔒';
    $('mainBoundaryHint').textContent = '检测到 ChatGPT OAuth。所有工作模式的 Main 固定官方 provider。';
  } else {
    $('mainBoundary').textContent = 'Provider 可选';
    $('mainBoundaryHint').textContent = '未检测到 ChatGPT OAuth；第三方 Main 将以 Standalone App Server thread 运行。';
  }

  qsa('[data-set-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.setMode === app.state.mode));
  const official = app.catalog.official;
  const account = registry().authentication?.officialAccount;
  $('officialMetric').textContent = registry().authentication?.officialOAuth ? 'OAuth 已连接' : official?.ok ? 'Codex 可用' : '不可用';
  $('officialDetail').textContent = account?.planType ? `${account.planType}${account.email ? ` · ${account.email}` : ''}` : official?.error || '未检测到 ChatGPT OAuth';

  $('thirdMetric').textContent = app.catalog.thirdParty?.ok ? `${app.catalog.thirdParty.models.length} 个模型` : app.catalog.thirdParty?.configured ? '连接异常' : '未配置';
  $('thirdDetail').textContent = app.catalog.thirdParty?.error || '模型来自上游 /v1/models';

  const allModels = [...(registry().providers?.official?.models || []), ...(registry().providers?.third_party?.models || [])];
  const advertised = allModels.filter((model) => model.reasoning?.advertised).length;
  $('capabilityMetric').textContent = `${allModels.length} 个模型`;
  $('capabilityDetail').textContent = `${advertised} 个明确声明 reasoning 档位；其余只使用 Auto`;

  $('integrationMetric').textContent = app.state.installed ? '已安装' : '待安装';
  $('integrationDetail').textContent = rt.officialProviderCapabilities ? '官方 capability API 已接入' : (app.catalog.official?.providerCapabilitiesError || '右上角 ⚙ 查看低频设置');
}

function renderProvider() {
  if (!app.state) return;
  const provider = app.state.provider || {};
  if (document.activeElement !== $('baseUrl')) $('baseUrl').value = provider.baseUrl || '';
  $('protocol').value = provider.protocol || 'auto';
}

function roleNamesForMode(mode) { return mode === 'AUTO' || mode === 'DELEGATE' ? ['main','worker','verifier'] : mode === 'MAIN' ? ['main'] : []; }
function roleTitle(role) { return role === 'main' ? 'Main' : role === 'worker' ? 'Worker' : 'Verifier'; }
function providerModels(provider) { return registry().providers?.[provider]?.models || []; }
function providerAvailable(provider) { return Boolean(registry().providers?.[provider]?.available); }
function capability(provider, model) { return providerModels(provider).find((item) => item.id === model || item.catalogId === model) || null; }

function savedRoute(mode, role) {
  const rt = app.catalog?.runtime?.effectiveRouting;
  if (mode === app.state?.mode && rt?.[role]) return structuredClone(rt[role]);
  return structuredClone(app.state?.routing?.[mode]?.[role] || { provider:'official', model:'', effort:'auto' });
}

function initializeDraft(mode) {
  app.routeDraft = {};
  for (const role of roleNamesForMode(mode)) {
    const route = savedRoute(mode, role);
    if (role === 'main' && registry().mainPolicy?.providerLocked) route.provider = 'official';
    const models = providerModels(route.provider);
    if (!models.some((model) => model.id === route.model || model.catalogId === route.model)) route.model = registry().providers?.[route.provider]?.defaultModel || models[0]?.id || '';
    route.effort = normalizeEffortForModel(route.provider, route.model, route.effort);
    app.routeDraft[role] = route;
  }
}

function normalizeEffortForModel(provider, model, effort) {
  if (!effort || effort === 'auto') return 'auto';
  const cap = capability(provider, model);
  return (cap?.reasoning?.options || []).some((item) => item.value === effort) ? effort : 'auto';
}

function reasoningValues(provider, model) {
  const cap = capability(provider, model);
  return [{ value:'auto', description:'使用该模型 / provider 的上游默认值' }, ...(cap?.reasoning?.options || [])];
}

function renderRouting() {
  if (!app.state || !app.catalog) return;
  const mode = app.selectedRoutingMode || app.state.mode;
  qsa('[data-routing-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.routingMode === mode));
  $('routingModeHint').textContent = MODE_HINTS[mode] || '';
  $('saveRouting').hidden = mode === 'OFFICIAL';
  const root = $('routingEditor'); root.innerHTML = '';

  if (mode === 'OFFICIAL') {
    root.innerHTML = `<section class="official-mode-panel"><div class="official-orbit">◎</div><div><p class="eyebrow">CODEX NATIVE</p><h2>没有自定义路由需要维护</h2><p>本模式不会保存 Main / Worker / Verifier 覆盖值。已安装 Codex 的模型目录、reasoning 默认值、multi-agent 策略与工具能力直接生效。</p><div class="capability-tags"><span>model/list</span><span>supportedReasoningEfforts</span><span>modelProvider/capabilities/read</span><span>native multi-agent</span></div></div></section>`;
    return;
  }

  if (!app.routeDraft || app.routeDraft.__mode !== mode) {
    initializeDraft(mode); app.routeDraft.__mode = mode;
  }
  for (const role of roleNamesForMode(mode)) root.appendChild(buildRoleCard(mode, role, app.routeDraft[role]));
}

function buildRoleCard(mode, role, route) {
  const card = document.createElement('section'); card.className = 'role-card'; card.dataset.role = role;
  const mainLocked = role === 'main' && registry().mainPolicy?.providerLocked;
  const standalone = role === 'main' && !registry().mainPolicy?.providerLocked && route.provider === 'third_party';
  const header = document.createElement('div'); header.className = 'role-head';
  header.innerHTML = `<div><span class="role-kicker">${role.toUpperCase()}</span><h2>${roleTitle(role)}${standalone ? ' · Standalone' : ''}</h2></div><span class="route-badge">${mainLocked ? 'Official 🔒' : route.provider === 'third_party' ? 'New API' : 'Official'}</span>`;
  card.appendChild(header);

  const grid = document.createElement('div'); grid.className = 'route-grid';
  const providerField = document.createElement('label'); providerField.className = 'field'; providerField.innerHTML = '<span>Provider</span>';
  if (mainLocked) {
    const locked = document.createElement('div'); locked.className='locked-field'; locked.textContent='Official ChatGPT'; providerField.appendChild(locked);
  } else {
    const select = document.createElement('select'); select.dataset.routeProvider = role;
    for (const provider of ['official','third_party']) {
      const option = document.createElement('option'); option.value=provider; option.textContent=provider==='official'?'Official':'New API'; option.disabled=!providerAvailable(provider); select.appendChild(option);
    }
    select.value = route.provider; select.addEventListener('change', () => routeProviderChanged(role, select.value)); providerField.appendChild(select);
  }
  grid.appendChild(providerField);

  const modelField = document.createElement('label'); modelField.className='field'; modelField.innerHTML='<span>Model</span>';
  const modelSelect = document.createElement('select'); modelSelect.dataset.routeModel=role;
  const models = providerModels(route.provider);
  if (!models.length) { const option=document.createElement('option'); option.value=''; option.textContent='没有可用模型'; modelSelect.appendChild(option); modelSelect.disabled=true; }
  else for (const model of models) { const option=document.createElement('option'); option.value=model.id; option.textContent=model.displayName || model.id; modelSelect.appendChild(option); }
  modelSelect.value = route.model; modelSelect.addEventListener('change', () => routeModelChanged(role, modelSelect.value)); modelField.appendChild(modelSelect); grid.appendChild(modelField);
  card.appendChild(grid);

  card.appendChild(buildReasoningSlider(role, route));
  if (mainLocked) {
    const note=document.createElement('p'); note.className='route-note'; note.textContent='ChatGPT OAuth 活跃：Main provider 由服务端强制锁定为 Official；第三方模型不会伪装成官方 Main。'; card.appendChild(note);
  } else if (standalone) {
    const note=document.createElement('p'); note.className='route-note warning'; note.textContent='Standalone Main：由控制平面创建独立 provider-isolated App Server thread，不代表 ChatGPT 官方界面的根线程切换 provider。'; card.appendChild(note);
  }
  return card;
}

function buildReasoningSlider(role, route) {
  const wrap=document.createElement('div'); wrap.className='reasoning-control';
  const values=reasoningValues(route.provider,route.model); route.effort=normalizeEffortForModel(route.provider,route.model,route.effort);
  let index=Math.max(0,values.findIndex((item)=>item.value===route.effort));
  const top=document.createElement('div'); top.className='reasoning-head'; top.innerHTML=`<div><span>Reasoning</span><small>${values.length===1?'上游未声明档位，仅使用 Auto':'精确跟随所选模型声明'}</small></div><strong>${values[index]?.value || 'auto'}</strong>`; wrap.appendChild(top);
  const input=document.createElement('input'); input.type='range'; input.min='0'; input.max=String(Math.max(0,values.length-1)); input.step='1'; input.value=String(index); input.disabled=values.length===1; input.dataset.reasoningRole=role;
  const ticks=document.createElement('div'); ticks.className='reasoning-ticks'; ticks.style.setProperty('--count',String(values.length)); values.forEach((item)=>{const tick=document.createElement('span');tick.textContent=item.value;tick.title=item.description||item.value;ticks.appendChild(tick);});
  input.addEventListener('input',()=>{const selected=values[Number(input.value)]||values[0];app.routeDraft[role].effort=selected.value;top.querySelector('strong').textContent=selected.value;});
  wrap.appendChild(input); wrap.appendChild(ticks);
  const description=document.createElement('p'); description.className='reasoning-description'; description.textContent=values[index]?.description || ''; wrap.appendChild(description);
  input.addEventListener('input',()=>{description.textContent=(values[Number(input.value)]||values[0])?.description||'';});
  return wrap;
}

function routeProviderChanged(role, provider) {
  const route=app.routeDraft[role]; route.provider=provider;
  const models=providerModels(provider); route.model=registry().providers?.[provider]?.defaultModel || models[0]?.id || ''; route.effort='auto';
  renderRouting();
}
function routeModelChanged(role, model) { const route=app.routeDraft[role]; route.model=model; route.effort='auto'; renderRouting(); }

async function saveRouting() {
  const mode=app.selectedRoutingMode;
  if (mode==='OFFICIAL') return;
  const roles={}; for (const role of roleNamesForMode(mode)) roles[role]={...app.routeDraft[role]};
  try {
    await api('/api/routing',{method:'PUT',body:{mode,roles}});
    setMessage('routingResult','已按当前 Model Capability Registry 保存并校验。','good');
    await refreshData(); initializeDraft(mode); app.routeDraft.__mode=mode; renderRouting();
  } catch(error) { setMessage('routingResult',`${error.message}${error.code?` · ${error.code}`:''}`,'bad'); }
}

async function setMode(mode) {
  if (app.busy || app.state?.mode===mode) return;
  app.busy=true;
  try { await api('/api/mode',{method:'PUT',body:{mode}}); await refreshData(); app.selectedRoutingMode=mode; app.routeDraft=null; renderAll(); }
  catch(error){ alert(error.message); }
  finally{ app.busy=false; }
}

function renderConnectivity() {
  if (!app.catalog) return;
  const models=app.catalog.thirdParty?.models || [];
  $('connectivitySummary').textContent = app.catalog.thirdParty?.ok ? `${models.length} 个 New API 模型可测试` : (app.catalog.thirdParty?.error || '未配置 New API');
  const root=$('modelTests'); root.innerHTML='';
  if (!models.length) { root.innerHTML='<p class="muted">没有可测试的第三方模型。</p>'; return; }
  for (const model of models) {
    const row=document.createElement('div'); row.className='model-test-row';
    const advertised=Array.isArray(model.supportedReasoningEfforts)&&model.supportedReasoningEfforts.length;
    row.innerHTML=`<div><strong>${escapeHtml(model.name||model.id)}</strong><small>${escapeHtml(model.id)} · ${advertised?`${model.supportedReasoningEfforts.length} reasoning levels`:'reasoning: Auto only'}</small></div><span class="test-state">未测试</span>`;
    const button=document.createElement('button');button.className='secondary small';button.textContent='测试';button.addEventListener('click',()=>testModels([model.id],row));row.appendChild(button);root.appendChild(row);
  }
}

async function testModels(models, row=null) {
  try {
    if(row) row.querySelector('.test-state').textContent='测试中…';
    const result=await api('/api/provider/connectivity',{method:'POST',body:{models}});
    if(row){const item=result.results?.[0];row.querySelector('.test-state').textContent=item?.ok?`通过 · ${item.protocol} · ${item.latencyMs}ms`:`失败 · ${item?.error||'unknown'}`;row.classList.toggle('failed',!item?.ok);}
    else { const ok=(result.results||[]).filter((item)=>item.ok).length;setMessage('modelTestResult',`完成：${ok}/${result.results?.length||0} 个模型通过真实请求。`,ok===result.results?.length?'good':'warn'); }
  } catch(error){ if(row)row.querySelector('.test-state').textContent=`失败 · ${error.message}`; else setMessage('modelTestResult',error.message,'bad'); }
}

async function saveProvider() {
  try {
    await api('/api/provider',{method:'PUT',body:{baseUrl:$('baseUrl').value.trim(),apiKey:$('apiKey').value,protocol:$('protocol').value}});
    $('apiKey').value=''; setMessage('providerResult','已保存。正在刷新实时模型能力…','good'); await refreshData();
  } catch(error){setMessage('providerResult',error.message,'bad');}
}
async function probeProvider() {
  try { const result=await api('/api/provider/probe',{method:'POST',body:{}});setMessage('providerResult',result.ok?`探测通过：${result.protocol} · HTTP ${result.status}`:`探测失败：${result.error||result.status}`,result.ok?'good':'bad'); }
  catch(error){setMessage('providerResult',error.message,'bad');}
}

function renderSecurity() {
  if (!app.auth) return;
  $('setupPanel').hidden=Boolean(app.auth.configured);
  $('changePanel').hidden=!app.auth.configured || !app.auth.authenticated;
  if (!app.auth.configured) setPill($('securityStatus'),'未设置','warn');
  else if (app.auth.authenticated) setPill($('securityStatus'),'已保护','good');
  else setPill($('securityStatus'),'需登录','warn');
}

async function login() {
  setMessage('loginResult','');
  try { await api('/api/auth/login',{method:'POST',body:{password:$('loginPassword').value}});$('loginPassword').value='';await refreshAuth();await refreshData(); }
  catch(error){setMessage('loginResult',error.message,'bad');}
}
async function setupPassword() {
  const password=$('setupPassword').value, confirmPassword=$('setupConfirm').value;
  if(password!==confirmPassword){setMessage('securityResult','两次密码不一致。','bad');return;}
  try {await api('/api/auth/setup',{method:'POST',body:{password,confirmPassword}});$('setupPassword').value='';$('setupConfirm').value='';setMessage('securityResult','密码已设置。','good');await refreshAuth();}
  catch(error){setMessage('securityResult',error.message,'bad');}
}
async function changePassword() {
  const currentPassword=$('currentPassword').value,newPassword=$('newPassword').value,confirmPassword=$('newPasswordConfirm').value;
  if(newPassword!==confirmPassword){setMessage('securityResult','两次新密码不一致。','bad');return;}
  try {await api('/api/auth/change',{method:'POST',body:{currentPassword,newPassword,confirmPassword}});qsa('#changePanel input').forEach((input)=>input.value='');setMessage('securityResult','密码已更换。','good');await refreshAuth();}
  catch(error){setMessage('securityResult',error.message,'bad');}
}
async function logout() { try{await api('/api/auth/logout',{method:'POST',body:{}});}finally{await refreshAuth();} }

function openDrawer() { $('integrationDrawer').classList.add('open');$('integrationDrawer').setAttribute('aria-hidden','false');$('drawerBackdrop').hidden=false;renderIntegration(); }
function closeDrawer() { $('integrationDrawer').classList.remove('open');$('integrationDrawer').setAttribute('aria-hidden','true');$('drawerBackdrop').hidden=true; }
function renderIntegration() {
  if (!app.catalog || !app.state) return;
  const auth=registry().authentication;
  $('drawerAccount').textContent=auth?.officialOAuth?'ChatGPT OAuth 已连接':app.catalog.official?.ok?'Codex 可用 · 无 ChatGPT OAuth':'不可用';
  $('drawerAccountDetail').textContent=auth?.officialAccount?.email || app.catalog.official?.error || '不会修改 auth.json';
  const caps=app.catalog.official?.providerCapabilities;
  $('drawerCapabilities').textContent=caps?'已接入':'兼容模式';
  $('drawerCapabilitiesDetail').textContent=caps?Object.keys(caps).join(' · '):(app.catalog.official?.providerCapabilitiesError||'当前 Codex 未提供该方法，核心 model/list 仍可工作');
  $('drawerInstallState').textContent=app.state.installed?'已安装':'待安装';
}
async function installIntegration() { try{const result=await api('/api/codex/install',{method:'POST',body:{}});$('integrationResult').textContent=JSON.stringify(result,null,2);await refreshData();}catch(error){$('integrationResult').textContent=error.message;} }
async function verifyCoexistence() { try{const result=await api('/api/verify/coexistence',{method:'POST',body:{}});$('integrationResult').textContent=JSON.stringify(result,null,2);await refreshData();}catch(error){$('integrationResult').textContent=error.message;} }

function escapeHtml(value='') { return String(value).replace(/[&<>'"]/g,(char)=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char])); }

function bind() {
  window.addEventListener('hashchange',renderNavigation);
  $('refreshButton').addEventListener('click',()=>refreshAll().catch((error)=>alert(error.message)));
  $('loginButton').addEventListener('click',login); $('loginPassword').addEventListener('keydown',(event)=>{if(event.key==='Enter')login();});
  $('saveProvider').addEventListener('click',saveProvider); $('probeProvider').addEventListener('click',probeProvider);
  $('saveRouting').addEventListener('click',saveRouting);
  $('testAllModels').addEventListener('click',()=>testModels((app.catalog?.thirdParty?.models||[]).map((model)=>model.id)));
  $('setupButton').addEventListener('click',setupPassword); $('changePasswordButton').addEventListener('click',changePassword); $('logoutButton').addEventListener('click',logout);
  $('integrationButton').addEventListener('click',openDrawer); $('closeDrawer').addEventListener('click',closeDrawer); $('drawerBackdrop').addEventListener('click',closeDrawer);
  $('installIntegration').addEventListener('click',installIntegration); $('verifyCoexistence').addEventListener('click',verifyCoexistence);
  qsa('[data-set-mode]').forEach((button)=>button.addEventListener('click',()=>setMode(button.dataset.setMode)));
  qsa('[data-routing-mode]').forEach((button)=>button.addEventListener('click',()=>{app.selectedRoutingMode=button.dataset.routingMode;app.routeDraft=null;renderRouting();}));
  qsa('[data-page-link]').forEach((link)=>link.addEventListener('click',()=>setTimeout(renderNavigation,0)));
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeDrawer();});
}

bind();
refreshAll().catch((error)=>{console.error(error);setPill($('healthPill'),'初始化失败','bad');});
