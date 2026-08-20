const $ = (id) => document.getElementById(id);
let state;
let catalogs = { official: { data: [], error: null }, thirdParty: { data: [], error: null } };
const MODE_HELP = {
  AUTO: 'Codex 原生 Multi-Agent 自动决策；Main / Worker / Verifier 都有明确模型来源。',
  DELEGATE: '主 Agent 负责规划与协调；Worker 执行主体工作，Verifier 独立复核。',
  MAIN: '主 Agent 自己执行；Hook 阻止新 subagent spawn，但 Worker/Verifier 配置仍保留供切换模式使用。',
};
const ROLE_LABEL = { main: 'Main / 主控', worker: 'Worker / 执行', verifier: 'Verifier / 复核' };
const VISIBLE_ROLES = { AUTO: ['main','worker','verifier'], DELEGATE: ['main','worker','verifier'], MAIN: ['main'] };

async function api(path, opts = {}) {
  const response = await fetch(path, { ...opts, headers: { 'content-type':'application/json', ...(opts.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body?.error?.message || response.statusText);
  return body;
}

async function refreshState() {
  state = await api('/api/state');
  $('health').textContent = `online · ${state.mode}`;
  $('baseUrl').value = state.provider?.baseUrl || '';
  $('protocol').value = state.provider?.protocol || 'auto';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  $('modeHelp').textContent = MODE_HELP[state.mode];
  renderRoles();
  $('status').textContent = JSON.stringify({
    installed: state.installed,
    integration: state.integration,
    activeMode: state.mode,
    activeProfile: state.profiles?.[state.mode],
    protocolCache: state.protocolCache,
    provider: state.provider && { name: state.provider.name, baseUrl: state.provider.baseUrl, protocol: state.provider.protocol, hasApiKey: state.provider.hasApiKey },
  }, null, 2);
}

async function refreshCatalogs(force = false) {
  $('catalogStatus').textContent = '正在读取 Codex 与 New API 模型目录…';
  catalogs = await api(`/api/models${force ? '?refresh=1' : ''}`);
  fillDatalist('officialModels', catalogs.official.data);
  fillDatalist('thirdModels', catalogs.thirdParty.data);
  const officialText = catalogs.official.error ? `Codex: ${catalogs.official.error}` : `Codex: ${catalogs.official.data.length} 个模型`;
  const thirdText = catalogs.thirdParty.error ? `New API: ${catalogs.thirdParty.error}` : `New API: ${catalogs.thirdParty.data.length} 个模型`;
  $('catalogStatus').innerHTML = `<span class="source-chip">${escapeHtml(officialText)}</span><span class="source-chip">${escapeHtml(thirdText)}</span>`;
  renderRoles();
}

function fillDatalist(id, models) {
  $(id).replaceChildren(...models.map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.label = model.displayName && model.displayName !== model.id ? `${model.displayName} · ${model.id}` : model.id;
    return option;
  }));
}

function renderRoles() {
  if (!state) return;
  const profile = state.profiles?.[state.mode] || {};
  const roles = VISIBLE_ROLES[state.mode];
  $('roles').replaceChildren(...roles.map((role) => roleCard(role, profile[role] || { source:'official', model:'' })));
}

function roleCard(role, selection) {
  const wrap = document.createElement('article'); wrap.className = 'role-card'; wrap.dataset.role = role;
  const title = document.createElement('div'); title.className = 'role-title'; title.innerHTML = `<strong>${ROLE_LABEL[role]}</strong><span class="role-source ${selection.source}">${selection.source === 'official' ? 'ChatGPT / Codex' : 'New API'}</span>`;
  const sourceLabel = document.createElement('label'); sourceLabel.textContent = '模型来源';
  const source = document.createElement('select'); source.dataset.field = 'source';
  source.innerHTML = '<option value="official">ChatGPT / Codex 官方目录</option><option value="third_party">New API 第三方目录</option>'; source.value = selection.source;
  sourceLabel.append(source);
  const modelLabel = document.createElement('label'); modelLabel.textContent = '模型';
  const model = document.createElement('input'); model.dataset.field = 'model'; model.value = selection.model || ''; model.setAttribute('list', selection.source === 'official' ? 'officialModels' : 'thirdModels'); model.placeholder = selection.source === 'official' ? '从 Codex model/list 选择' : '从 /v1/models 选择或手动输入';
  modelLabel.append(model);
  const meta = document.createElement('p'); meta.className = 'model-meta'; meta.textContent = modelMeta(selection);
  source.onchange = () => { model.setAttribute('list', source.value === 'official' ? 'officialModels' : 'thirdModels'); wrap.querySelector('.role-source').textContent = source.value === 'official' ? 'ChatGPT / Codex' : 'New API'; wrap.querySelector('.role-source').className = `role-source ${source.value}`; meta.textContent = modelMeta({ source: source.value, model: model.value }); };
  model.oninput = () => { meta.textContent = modelMeta({ source: source.value, model: model.value }); };
  wrap.append(title, sourceLabel, modelLabel, meta); return wrap;
}

function modelMeta(selection) {
  const source = selection.source === 'official' ? catalogs.official.data : catalogs.thirdParty.data;
  const m = source.find((x) => x.id === selection.model);
  if (!m) return selection.model ? '当前值未出现在最新目录中；仍会按模型 ID 使用。' : '尚未选择模型。';
  if (selection.source === 'third_party') return `${m.displayName || m.id}${m.ownedBy ? ` · ${m.ownedBy}` : ''}`;
  const bits = [m.displayName || m.id]; if (m.isDefault) bits.push('Codex 默认'); if (m.multiAgentVersion) bits.push(`Multi-Agent ${m.multiAgentVersion}`); if (m.supportedReasoningEfforts?.length) bits.push(`Reasoning: ${m.supportedReasoningEfforts.join(' / ')}`); return bits.join(' · ');
}

function collectProfile() {
  const current = structuredClone(state.profiles?.[state.mode] || {});
  document.querySelectorAll('.role-card').forEach((card) => {
    current[card.dataset.role] = { source: card.querySelector('[data-field="source"]').value, model: card.querySelector('[data-field="model"]').value.trim() };
  });
  for (const role of ['main','worker','verifier']) current[role] ||= state.profiles?.[state.mode]?.[role] || { source:'official', model:'' };
  return current;
}

function currentThirdPartyModel() {
  const profile = collectProfile();
  return ['worker','main','verifier'].map((role) => profile[role]).find((x) => x?.source === 'third_party' && x.model)?.model || '';
}

async function withButton(button, fn) {
  const old = button.textContent; button.disabled = true;
  try { await fn(); } catch (error) { alert(error.message); throw error; }
  finally { button.disabled = false; button.textContent = old; }
}

document.querySelectorAll('[data-mode]').forEach((button) => button.onclick = () => withButton(button, async () => { state = await api('/api/mode', { method:'PUT', body:JSON.stringify({ mode:button.dataset.mode }) }); await refreshState(); }));
$('saveProvider').onclick = () => withButton($('saveProvider'), async () => { await api('/api/provider', { method:'PUT', body:JSON.stringify({ name:'New API', baseUrl:$('baseUrl').value.trim(), apiKey:$('apiKey').value, protocol:$('protocol').value }) }); $('apiKey').value = ''; await refreshState(); await refreshCatalogs(true); });
$('saveProfile').onclick = () => withButton($('saveProfile'), async () => { state = await api('/api/profile', { method:'PUT', body:JSON.stringify({ mode:state.mode, profile:collectProfile() }) }); await refreshState(); });
$('refreshModels').onclick = () => withButton($('refreshModels'), () => refreshCatalogs(true));
$('probe').onclick = () => withButton($('probe'), async () => { const model = currentThirdPartyModel(); if (!model) throw new Error('当前模式没有选择第三方模型'); $('probeResult').textContent = 'probing…'; $('probeResult').textContent = JSON.stringify(await api('/api/provider/probe', { method:'POST', body:JSON.stringify({ model }) }), null, 2); await refreshState(); });
$('install').onclick = () => withButton($('install'), async () => { $('status').textContent = '正在通过 codex app-server 安装插件并应用模型拓扑…'; const result = await api('/api/codex/install', { method:'POST' }); state = result.state; await refreshState(); });
$('restoreOriginal').onclick = () => withButton($('restoreOriginal'), async () => { await api('/api/codex/restore-original', { method:'POST' }); await refreshState(); });

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

(async () => {
  try { await refreshState(); await refreshCatalogs(false); }
  catch (error) { $('status').textContent = error.stack || error.message; }
})();
