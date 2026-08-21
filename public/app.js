const $=(id)=>document.getElementById(id);
const MODES=['AUTO','DELEGATE','MAIN'];
const ROLES=['main','worker','verifier'];
let state=null,catalog={official:{models:[]},thirdParty:{models:[]}},coexistenceProof=null;

async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});const text=await r.text();let j;try{j=text?JSON.parse(text):{}}catch{j={error:text}}if(!r.ok)throw new Error(j?.error?.message||j?.error||r.statusText);return j}
function providerKey(value){return value==='third_party'?'thirdParty':'official'}
function modelRows(provider){const rows=catalog?.[providerKey(provider)]?.models||[];return rows.map((m)=>({id:m.model||m.id,name:m.displayName||m.name||m.model||m.id})).filter((m)=>m.id)}
function esc(value){return String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

function routeRow(mode,role,route){
  const id=`${mode}-${role}`;const provider=route?.provider||'official';const rows=modelRows(provider);const current=route?.model||'';
  const options=[...rows];if(current&&!options.some((m)=>m.id===current))options.unshift({id:current,name:`${current} · 当前/手填`});
  return `<div class="route-row" data-route="${id}"><div class="route-role"><b>${role.toUpperCase()}</b><span class="route-kind" id="kind-${id}"></span></div><select class="route-provider" data-mode="${mode}" data-role="${role}"><option value="official" ${provider==='official'?'selected':''}>Official ChatGPT</option><option value="third_party" ${provider==='third_party'?'selected':''}>New API</option></select><div class="model-field"><select class="route-model" data-mode="${mode}" data-role="${role}">${options.map((m)=>`<option value="${esc(m.id)}" ${m.id===current?'selected':''}>${esc(m.name)} (${esc(m.id)})</option>`).join('')}<option value="__custom__">手动输入…</option></select><input class="route-custom" data-mode="${mode}" data-role="${role}" value="${esc(current&&!rows.some((m)=>m.id===current)?current:'')}" placeholder="模型 ID" hidden></div></div>`
}
function renderRouting(){
  $('routing').innerHTML=MODES.map((mode)=>`<div class="mode-routing ${mode===state.mode?'current':''}"><div class="mode-title"><h3>${mode}</h3><span>${mode===state.mode?'当前模式':''}</span></div>${ROLES.map((role)=>routeRow(mode,role,state.routing?.[mode]?.[role])).join('')}</div>`).join('');
  document.querySelectorAll('.route-provider').forEach((el)=>el.onchange=()=>{syncRouteModels(el.dataset.mode,el.dataset.role,el.value);updateKinds()});
  document.querySelectorAll('.route-model').forEach((el)=>el.onchange=()=>{const custom=findCustom(el.dataset.mode,el.dataset.role);custom.hidden=el.value!=='__custom__';if(!custom.hidden)custom.focus();updateKinds()});
  updateKinds();
}
function findModel(mode,role){const select=document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`);const custom=findCustom(mode,role);return select?.value==='__custom__'?custom.value.trim():(select?.value||custom?.value||'').trim()}
function findProvider(mode,role){return document.querySelector(`.route-provider[data-mode="${mode}"][data-role="${role}"]`)?.value||'official'}
function findCustom(mode,role){return document.querySelector(`.route-custom[data-mode="${mode}"][data-role="${role}"]`)}
function syncRouteModels(mode,role,provider){const select=document.querySelector(`.route-model[data-mode="${mode}"][data-role="${role}"]`);const custom=findCustom(mode,role);const previous=findModel(mode,role);const rows=modelRows(provider);select.innerHTML=rows.map((m)=>`<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.id)})</option>`).join('')+'<option value="__custom__">手动输入…</option>';if(rows.some((m)=>m.id===previous))select.value=previous;else{select.value='__custom__';custom.value=previous}custom.hidden=select.value!=='__custom__'}
function routeKind(mode,role){if(role==='main')return'Root Thread';const main=findProvider(mode,'main'),p=findProvider(mode,role);if(main==='official'&&p==='official')return'Native Subagent';if(main===p)return'Provider-isolated Thread';return'Cross-provider Thread'}
function updateKinds(){for(const mode of MODES)for(const role of ROLES){const node=$(`kind-${mode}-${role}`);if(node)node.textContent=routeKind(mode,role)}}

function setDot(id,ok){const node=$(id);if(!node)return;node.classList.toggle('ok',Boolean(ok));node.classList.toggle('bad',!ok)}
function renderCoexistence(){
  const account=catalog.official?.account;const officialOk=catalog.official?.ok&&account?.type==='chatgpt';const thirdConfigured=Boolean(state?.provider?.hasApiKey);const thirdOk=thirdConfigured&&catalog.thirdParty?.ok;
  setDot('officialDot',officialOk);setDot('thirdDot',thirdOk);setDot('coexistDot',coexistenceProof?.ok??(officialOk&&thirdOk));
  $('officialState').textContent=officialOk?`已登录 ChatGPT · ${account.planType||'plan unknown'}${account.email?` · ${account.email}`:''}`:(catalog.official?.error||`Codex account: ${account?.type||'未登录 ChatGPT'}`);
  $('thirdState').textContent=thirdOk?`已配置且 /v1/models 可用 · ${catalog.thirdParty.models.length} models`:thirdConfigured?`已配置 · ${catalog.thirdParty?.error||'模型目录暂不可用，可手填模型 ID'}`:'未配置 New API';
  $('coexistState').textContent=coexistenceProof?`${coexistenceProof.ok?'PASS':'FAIL'}：第三方线程 ${coexistenceProof.thirdParty?.status||'?'}，前后 ChatGPT=${coexistenceProof.officialChatGPTBefore?.type||'?'}→${coexistenceProof.officialChatGPTAfter?.type||'?'}，全局 selector ${coexistenceProof.globalSelectorUntouched?'未改变':'发生变化'}`:officialOk&&thirdOk?'两套凭证同时就绪；点击“真实共存验收”执行线程级证明。':'需要同时满足 ChatGPT 登录 + New API 可用';
  if($('coexistProof'))$('coexistProof').textContent=coexistenceProof?JSON.stringify(coexistenceProof,null,2):'';
}

async function refresh({catalogToo=true}={}){state=await api('/api/state');$('health').textContent=`online · ${state.mode}`;$('baseUrl').value=state.provider?.baseUrl||'';$('protocol').value=state.provider?.protocol||'auto';document.querySelectorAll('[data-mode]').forEach((b)=>{if(b.classList.contains('route-provider')||b.classList.contains('route-model')||b.classList.contains('route-custom'))return;b.classList.toggle('active',b.dataset.mode===state.mode)});$('modeHelp').textContent={AUTO:'Codex 自动协调；Web 路由决定每个角色的 provider/model。官方→官方可用 Native Subagent；涉及第三方时默认隔离线程。',DELEGATE:'Root 只协调；官方→官方使用 Native Subagent，任何第三方路径使用显式 App Server Thread，避免当前 custom-provider subagent 丢任务问题。',MAIN:'Root 自己执行；禁止新 worker/subagent。'}[state.mode];if(catalogToo)await refreshCatalog(false);renderRouting();renderCoexistence();renderStatus()}
async function refreshCatalog(render=true){$('health').textContent='loading models…';try{catalog=await api('/api/catalog')}catch(e){catalog={official:{models:[],error:e.message},thirdParty:{models:[],error:e.message}}}finally{$('health').textContent=`online · ${state?.mode||'?'}`}if(render&&state)renderRouting();renderCoexistence();renderStatus()}
function renderStatus(){$('status').textContent=JSON.stringify({installed:state?.installed,activeRouting:state?.activeRouting,officialChatGPT:{account:catalog.official?.account||null,requiresOpenaiAuth:catalog.official?.requiresOpenaiAuth??null},newApi:state?.provider&&{name:state.provider.name,baseUrl:state.provider.baseUrl,protocol:state.provider.protocol,hasApiKey:state.provider.hasApiKey},protocolCache:state?.protocolCache,coexistenceProof,catalog:{official:{ok:catalog.official?.ok,count:catalog.official?.models?.length||0,error:catalog.official?.error||null},thirdParty:{ok:catalog.thirdParty?.ok,count:catalog.thirdParty?.models?.length||0,error:catalog.thirdParty?.error||null}}},null,2)}
function selectedThirdPartyModel(){for(const role of ['worker','verifier','main'])if(findProvider(state.mode,role)==='third_party'){const m=findModel(state.mode,role);if(m)return m}return''}

document.querySelectorAll('.modes [data-mode]').forEach((b)=>b.onclick=async()=>{await api('/api/mode',{method:'PUT',body:JSON.stringify({mode:b.dataset.mode})});coexistenceProof=null;await refresh({catalogToo:false})});
$('saveProvider').onclick=async()=>{await api('/api/provider',{method:'PUT',body:JSON.stringify({name:'New API',baseUrl:$('baseUrl').value.trim(),apiKey:$('apiKey').value,protocol:$('protocol').value})});$('apiKey').value='';coexistenceProof=null;await refresh()};
$('refreshCatalog').onclick=()=>refreshCatalog(true);
$('saveRouting').onclick=async()=>{for(const mode of MODES){const roles={};for(const role of ROLES)roles[role]={provider:findProvider(mode,role),model:findModel(mode,role)};await api('/api/routing',{method:'PUT',body:JSON.stringify({mode,roles})})}coexistenceProof=null;await refresh({catalogToo:false})};
$('probe').onclick=async()=>{try{$('probeResult').textContent='probing…';const model=selectedThirdPartyModel()||findModel(state.mode,'worker')||findModel(state.mode,'main');$('probeResult').textContent=JSON.stringify(await api('/api/provider/probe',{method:'POST',body:JSON.stringify({model})}),null,2);await refresh({catalogToo:false})}catch(e){$('probeResult').textContent=e.message}};
$('install').onclick=async()=>{try{$('status').textContent='installing…';await api('/api/codex/install',{method:'POST'});coexistenceProof=null;await refresh()}catch(e){$('status').textContent=e.stack||e.message}};
$('verifyCoexistence').onclick=async()=>{try{const model=selectedThirdPartyModel();if(!model)throw new Error('当前模式至少选择一个 New API 模型后再验收');$('coexistProof').textContent='running real coexistence proof…';coexistenceProof=await api('/api/verify/coexistence',{method:'POST',body:JSON.stringify({model})});renderCoexistence();renderStatus()}catch(e){coexistenceProof={ok:false,error:e.message};renderCoexistence();renderStatus()}};
$('runWorker').onclick=async()=>{try{$('runResult').textContent='running real Codex route…';$('runResult').textContent=JSON.stringify(await api('/api/worker/run',{method:'POST',body:JSON.stringify({role:$('testRole').value,task:$('testTask').value})}),null,2)}catch(e){$('runResult').textContent=e.stack||e.message}};
refresh().catch((e)=>{$('status').textContent=e.stack||e.message});
