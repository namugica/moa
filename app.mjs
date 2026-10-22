import { STATUS, uid, amount, splitExpense, balances, totalCost, newTrip, settlementPlan, settlementProgress } from './model.mjs';
import { auth } from './account.mjs';
import { SESSION_KEY, request, subscribe, CONNECTION_LABEL } from './shared.mjs';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ko-KR').format(n) + '원';
const KEY = 'moa.prototype.v1';
let state = { trips: [] }, storageBlocked = false, activeSubmit, activeVersion, toastTimer;
let sessions = {}, stopStream, streamingId, inviteInfo, inviteError = '', submitting = false;
const connectionStatus = {};
let authUser = null, currentProfile = null, accountEpoch = 0;
const AVATARS = ['🌿','🐻','🐱','🐶','🐰','🦊','🐼','🐧'];
const tripPath = t => `${sessions[t.id]?.account ? '/account' : ''}/trips/${t.id}`;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.trips) || parsed.trips.some(t => !STATUS[t.status] || !Array.isArray(t.items) || !Array.isArray(t.expenses) || !Array.isArray(t.members))) throw new Error('Invalid data');
    state = parsed;
  }
} catch { storageBlocked = true; }
try { sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch { storageBlocked = true; }
function persist() {
  localStorage.setItem(KEY, JSON.stringify({ trips: state.trips.filter(t => !sessions[t.id]?.account) }));
  localStorage.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(Object.entries(sessions).filter(([,s]) => !s.account))));
}
function acceptSnapshot(data) {
  const session = sessions[data.trip.id];
  if (!session || (session.account && session.userId !== authUser?.id) || data.version < (session.version || 0)) return;
  const changed = data.version !== session.version || JSON.stringify(data.claimedIds) !== JSON.stringify(session.claimedIds) || !state.trips.some(t => t.id === data.trip.id);
  Object.assign(session, { version: data.version, memberId: data.memberId, ownerId: data.ownerId, claimedIds: data.claimedIds });
  const index = state.trips.findIndex(t => t.id === data.trip.id);
  if (index === -1) state.trips.push(data.trip); else state.trips[index] = data.trip;
  try { persist(); } catch { storageBlocked = true; toast('이 브라우저에 참여 정보를 보관하지 못했어요. 저장소 설정을 확인해 주세요.'); }
  if (changed) render();
}
function watchTrip() {
  const t = currentTrip(), session = t && sessions[t.id];
  const streamKey = session ? `${t.id}:${session.account ? authUser?.id : 'legacy'}` : undefined;
  if (streamingId === streamKey) return;
  stopStream?.(); stopStream = undefined; streamingId = streamKey;
  if (session) stopStream = subscribe(t.id, session.token, acceptSnapshot, status => {
    connectionStatus[t.id] = status;
    const label = $('#sync-status');
    if (label && currentTrip()?.id === t.id) label.textContent = syncLabel(t);
    const global = $('.global-sync');
    if (global && currentTrip()?.id === t.id) global.textContent = syncLabel(t);
  }, Boolean(session.account));
}
function syncLabel(t) {
  if (!sessions[t.id]) return '이 브라우저에 저장 중';
  return ({ connected: CONNECTION_LABEL, reconnecting: '연결 끊김 · 다시 연결 중', unauthorized: '참여 권한을 확인해 주세요' })[connectionStatus[t.id]] || '실시간 연결 중';
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500); }
async function update(fn) {
  if (storageBlocked) { toast('브라우저 저장소를 사용할 수 없어요. 기존 데이터 보존을 위해 저장을 중단했어요.'); return false; }
  const next = structuredClone(state); fn(next);
  const shared = next.trips.find(t => sessions[t.id] && JSON.stringify(t) !== JSON.stringify(state.trips.find(old => old.id === t.id)));
  if (shared) {
    const session = sessions[shared.id];
    try { acceptSnapshot(await request(tripPath(shared), { token: session.token, method: 'PATCH', data: { trip: shared, version: $('#editor').open ? activeVersion : session.version } })); return true; }
    catch (error) { if (error.snapshot) { acceptSnapshot(error.snapshot); activeVersion = error.snapshot.version; } throw error; }
  }
  try { state = next; persist(); render(); return true; }
  catch { throw new Error('저장하지 못했어요. 브라우저 저장 공간과 권한을 확인해 주세요.'); }
}
const tripById = id => state.trips.find(t => t.id === id);
const currentTrip = () => tripById(location.hash.split('/')[1]);
const btn = (action, label, id = '', klass = 'button') => `<button type="button" class="${klass}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
function cards() { return `<div class="cards">${state.trips.map(t => { const open=settlementProgress(t).filter(p=>!p.completed).reduce((sum,p)=>sum+p.amount,0); return `<a class="group-card" href="#trip/${t.id}"><div class="group-card-top"><span class="group-icon">${esc((t.title||'모').slice(0,1))}</span><span class="arrow">↗</span></div><h2>${esc(t.title)}</h2><p>${t.members.length}명 · 지출 ${t.expenses.length}건</p><div class="group-card-bottom"><span>${open?`남은 정산 ${money(open)}`:'정산 내역 보기'}</span><strong>${money(totalCost(t))}</strong></div></a>`; }).join('')}<button class="new-card" data-action="create-trip"><span class="plus">+</span><strong>새 정산 모임 만들기</strong><small>친구들과 함께 쓴 돈을 정리해요</small></button></div>`; }
function home() { return `<div class="page-heading"><div><span class="eyebrow">MOA · GROUP SETTLEMENT</span><h1>모임 정산</h1><p>함께 쓴 돈을 기록하고, 정산할 금액을 한눈에 확인해요.</p></div>${btn('create-trip','＋ 모임 만들기')}</div><section class="group-section"><div class="section-title"><h2>내 정산 모임 <span>${state.trips.length}</span></h2></div>${state.trips.length?cards():`<div class="empty-state"><span class="empty-icon">₩</span><h2>아직 정산 모임이 없어요</h2><p>모임을 만들고 지출을 기록하면<br>누가 누구에게 얼마를 보내야 하는지 계산해 드려요.</p>${btn('create-trip','첫 모임 만들기')}</div>`}</section>`; }
function mySettlement(t) {
  const me = balances(t).find(m => m.id === (sessions[t.id]?.memberId || t.members[0].id));
  const transfers = settlementProgress(t).filter(p => p.from === me.id || p.to === me.id);
  const completed = transfers.filter(p => p.completed).reduce((sum,p) => sum+p.amount,0);
  const pending = transfers.filter(p => !p.completed).reduce((sum,p) => sum+p.amount,0);
  const sent=transfers.filter(p=>p.from===me.id).reduce((sum,p)=>sum+p.amount,0);
  const received=transfers.filter(p=>p.to===me.id).reduce((sum,p)=>sum+p.amount,0);
  const pendingSent=transfers.filter(p=>p.from===me.id&&!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const pendingReceived=transfers.filter(p=>p.to===me.id&&!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const headline=pendingSent?['아직 보낼 금액',money(pendingSent)]:pendingReceived?['아직 받을 금액',money(pendingReceived)]:['정산 완료',money(0)];
  return `<section class="my-total"><div class="my-total-top"><span>${esc(me.name)}님의 정산 현황</span><span class="avatar-mini">${esc(me.avatar||'')}</span></div><p>${headline[0]}</p><strong class="my-total-amount">${headline[1]}</strong><div class="my-total-breakdown"><div><span>보낼 예정</span><b>${money(sent)}</b></div><div><span>받을 예정</span><b>${money(received)}</b></div></div><div class="progress-line"><span style="width:${sent+received?Math.round(completed/(sent+received)*100):100}%"></span></div><div class="progress-caption"><span>완료 ${money(completed)}</span><span>남은 금액 ${money(pending)}</span></div></section>`;
}
function loginButtons() {
  return `<div class="login-buttons">${btn('login-kakao','카카오로 계속하기','','button kakao')}${btn('login-google','구글로 계속하기','','button google')}</div>`;
}
function loginForm() {
  if (!auth) return toast('로그인은 공유 서비스를 연결한 환경에서 사용할 수 있어요.');
  open('친구와 함께 여행하기', `<p>로그인하면 다른 기기에서도 같은 프로필과 모임 정산을 이어갈 수 있어요.</p>${loginButtons()}<p class="help">초대받은 모임은 로그인 후에도 그대로 이어져요.</p>`, () => false);
  $('#editor-form [type="submit"]').hidden = true;
}
function acceptAccountSnapshot(data, userId = authUser?.id) {
  if (!userId || authUser?.id !== userId) return;
  sessions[data.trip.id] = { ...sessions[data.trip.id], account: true, userId };
  delete sessions[data.trip.id].token;
  acceptSnapshot(data); watchTrip();
}
async function loadAccountData() {
  const epoch = accountEpoch, userId = authUser?.id;
  if (!userId) return;
  const [profile, trips] = await Promise.all([request('/account/profile'), request('/account/trips')]);
  if (epoch !== accountEpoch || authUser?.id !== userId) return;
  currentProfile = profile.profile;
  for (const data of trips.trips) acceptAccountSnapshot(data, userId);
  render(); watchTrip();
  if (!currentProfile && !$('#editor').open) profileForm();
}
function profileForm() {
  if (!authUser) return loginForm();
  const initialName = currentProfile?.name || authUser.user_metadata?.full_name || authUser.user_metadata?.name || '';
  open('내 프로필 설정', `${input('친구들에게 표시할 이름','profileName',initialName,'text','required maxlength="80"')}<label for="f-avatar">프로필 아이콘</label><select id="f-avatar" name="avatar">${AVATARS.map(icon => `<option ${currentProfile?.avatar === icon ? 'selected' : ''}>${icon}</option>`).join('')}</select><p class="help">이 프로필은 로그인한 계정에 저장돼요. 이름을 변경해도 정산 기록은 유지돼요.</p>${btn('logout','로그아웃','','button secondary')}`, async data => {
    const userId = authUser.id;
    const saved = await request('/account/profile', { method:'PUT', data:{ name:data.get('profileName').trim(), avatar:data.get('avatar') } });
    if (authUser?.id !== userId) return false;
    currentProfile = saved.profile; await loadAccountData(); render(); return true;
  });
}
function invitationView() {
  if (inviteError) return `<section class="panel"><h1>초대를 확인해 주세요</h1><p role="alert">${esc(inviteError)}</p><a class="button secondary" href="#home">홈으로</a></section>`;
  if (!inviteInfo) return '<section class="panel"><p role="status">초대를 확인하고 있어요…</p></section>';
  return `<section class="panel invite-landing"><span class="eyebrow">함께하는 여행</span><h1>${esc(inviteInfo.title)}</h1><p>${inviteInfo.common ? '하나의 링크로 친구들과 함께하는 정산 모임이에요.' : `<strong>${esc(inviteInfo.memberName)}</strong>님에게 온 초대예요.`}</p><p>지출을 함께 기록하고, 정산 상태를 확인할 수 있어요.</p>${!auth ? btn('join-trip','초대 수락하고 참여하기') : !authUser ? loginButtons() : !currentProfile ? btn('profile','내 프로필 설정하고 참여하기') : `<p>${esc(currentProfile.avatar)} ${esc(currentProfile.name)}님으로 참여해요.</p>${btn('join-trip','초대 수락하고 참여하기')}`}<p class="help">${inviteInfo.common ? '친구들이 같은 링크로 각자의 계정으로 참여해요.' : '기존 개별 초대를 수락하면 해당 멤버가 내 계정과 연결돼요.'} 다른 기기에서도 같은 계정으로 모임 정산을 이어갈 수 있어요.</p></section>`;
}
async function loadInvitation() {
  const value = location.hash.startsWith('#invite/') ? location.hash.slice(8) : null;
  if (!value) return;
  inviteInfo = undefined; inviteError = ''; render();
  try { const info = await request(`${auth ? '/account' : ''}/invites/${encodeURIComponent(value)}`); if (location.hash === `#invite/${value}`) inviteInfo = info; }
  catch (error) { if (location.hash === `#invite/${value}`) inviteError = error.message; }
  if (location.hash === `#invite/${value}`) render();
}
function legacyInviteForm(t) {
  if (storageBlocked) return toast('브라우저 저장소를 먼저 사용할 수 있어야 초대할 수 있어요.');
  const session = sessions[t.id];
  const candidates = t.members.filter(m => m.id !== (session?.memberId || t.members[0].id) && !session?.claimedIds?.includes(m.id));
  open('친구 초대하기', `${!session && t.members[0].name === '나' ? input('친구들에게 표시할 내 이름','myName','','text','required maxlength="80"') : ''}<label for="f-inviteMember">초대할 친구</label><select id="f-inviteMember" name="memberId">${candidates.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}<option value="">새 친구 추가</option></select>${input('새 친구 이름 (새 친구 추가를 선택한 경우)','friendName','','text','maxlength="80"')}<p class="help">친구마다 전용 링크를 보내 주세요. 링크는 7일 동안 한 번 사용할 수 있어요. 다시 만들면 해당 친구의 이전 링크는 만료돼요. 새 멤버는 이전 지출에 자동 추가되지 않아요.</p>${!session ? '<p class="help">초대 링크를 만들면 이 여행의 일정과 지출을 서버에 저장하고 친구와 공유해요.</p>' : ''}`, async data => {
    let shared = t;
    const target = data.get('memberId'), friendName = data.get('friendName').trim();
    if (!target && !friendName) throw new Error('새 친구 이름을 입력해 주세요.');
    if (!sessions[t.id]) {
      const trip = structuredClone(t);
      if (data.get('myName')) trip.members[0].name = data.get('myName').trim();
      const created = await request('/trips', { method: 'POST', data: { trip } });
      sessions[created.trip.id] = { token: created.token };
      state.trips = state.trips.filter(old => old.id !== t.id);
      acceptSnapshot(created);
      shared = created.trip;
      // Keep the converted trip if a later invitation request needs a retry.
      t = shared;
      location.hash = `trip/${shared.id}`;
    }
    const result = await request(`/trips/${shared.id}/invites`, { token: sessions[shared.id].token, method: 'POST', data: { memberId: target, name: friendName } });
    acceptSnapshot(result);
    const link = new URL(location.href); link.hash = `invite/${result.inviteToken}`;
    $('#dialog-title').textContent = '초대 링크가 준비됐어요';
    $('#dialog-fields').innerHTML = `${input('친구에게 보낼 링크','inviteLink',link.href,'text','readonly')}<div class="actions">${btn('copy-invite','링크 복사')}${navigator.share ? btn('share-invite','친구에게 보내기','','button secondary') : ''}</div><p id="copy-status" role="status"></p><p class="help">${new Date(result.expiresAt).toLocaleString('ko-KR')}까지 한 번 사용할 수 있어요. 초대받을 친구에게만 보내 주세요.</p>`;
    activeSubmit = () => false;
    $('#editor-form [type="submit"]').hidden = true;
    return false;
  });
}
function showInviteLink(result) {
  const link = new URL(location.href); link.search = ''; link.hash = `invite/${result.inviteToken}`;
  $('#dialog-title').textContent = '모두에게 보낼 초대 링크';
  $('#dialog-fields').innerHTML = `${input('친구들에게 보낼 링크','inviteLink',link.href,'text','readonly')}<div class="actions">${btn('copy-invite','링크 복사')}${navigator.share ? btn('share-invite','친구에게 보내기','','button secondary') : ''}</div><p id="copy-status" role="status"></p><p class="help">친구들이 이 링크로 로그인하고 자기 프로필로 참여해요. ${new Date(result.expiresAt).toLocaleString('ko-KR')}까지 사용할 수 있어요.</p>`;
  activeSubmit = () => false; $('#editor-form [type="submit"]').hidden = true;
}
function inviteForm(t) {
  if (!auth) return legacyInviteForm(t);
  if (!authUser) return loginForm();
  if (!currentProfile) return profileForm();
  if (storageBlocked) return toast('브라우저 저장소를 사용할 수 있어야 해요.');
  open('친구 초대하기', '<p>단체 채팅방에 초대 링크 하나를 보내 주세요. 친구들은 카카오 또는 구글로 로그인하고 자신의 프로필로 참여해요.</p><p class="help">링크는 7일 동안 유효해요. 다시 열어도 같은 유효한 링크를 보여드려요. 새 친구는 이전 지출에 자동 추가되지 않아요.</p>', async () => {
    const userId = authUser.id;
    if (!sessions[t.id]) {
      const created = await request('/account/trips', { method:'POST', data:{trip:t} });
      if (authUser?.id !== userId) return false;
      state.trips = state.trips.filter(old => old.id !== t.id);
      acceptAccountSnapshot(created, userId); t = created.trip; location.hash = `trip/${t.id}`;
    } else if (!sessions[t.id].account) {
      const adopted = await request('/account/adopt', { method:'POST', data:{tripId:t.id,token:sessions[t.id].token} });
      acceptAccountSnapshot(adopted, userId);
    }
    const result = await request(`${tripPath(t)}/invites`, { method:'POST', data:{} });
    if (authUser?.id !== userId) return false;
    acceptAccountSnapshot(result, userId); showInviteLink(result); return false;
  });
}
function tripView(t) {
  const meId=sessions[t.id]?.memberId||t.members[0].id;
  const plan=settlementProgress(t), completed=plan.filter(p=>p.completed).reduce((sum,p)=>sum+p.amount,0), pending=plan.filter(p=>!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const person=id=>esc(t.members.find(m=>m.id===id)?.name||'참여자');
  const inviteAllowed=!sessions[t.id]||sessions[t.id].memberId===sessions[t.id].ownerId;
  return `<a class="back" href="#trips">← 모임 정산</a><header class="group-header"><div><span class="eyebrow">공유 정산</span><h1>${esc(t.title)}</h1><div class="members">${t.members.map(m=>`<span class="member-chip">${esc(m.avatar||'')} ${esc(m.name)}${m.id===meId?' · 나':''}</span>`).join('')}<span id="sync-status" class="sync-status" role="status">${syncLabel(t)}</span></div></div>${inviteAllowed?btn('invite','친구 초대','','button secondary'):''}</header><section class="settlement-board">${mySettlement(t)}<div class="board-total"><span>모임 전체 지출</span><strong>${money(totalCost(t))}</strong><small>${t.expenses.length}건의 지출 · ${t.members.length}명 참여</small></div></section><section class="panel plan-panel"><div class="section-title"><div><span class="eyebrow">SETTLEMENT PLAN</span><h2>송금할 내역</h2></div><span class="plan-summary">완료 ${money(completed)} <i>·</i> 남음 ${money(pending)}</span></div>${plan.length?`<div class="transfer-list">${plan.map(p=>`<article class="transfer-row"><div class="transfer-people"><span class="person-avatar">${esc((t.members.find(m=>m.id===p.from)?.name||' ')[0])}</span><div><strong>${person(p.from)} <span class="arrow-inline">→</span> ${person(p.to)}</strong><small>${p.completed?'송금 완료':'송금 전'}</small></div></div><div class="transfer-action"><strong>${money(p.amount)}</strong>${p.from===meId?(p.completed?btn('toggle-settlement','완료 취소',`${p.from}:${p.to}:${p.amount}`,'button secondary compact'):btn('toggle-settlement','보냈어요',`${p.from}:${p.to}:${p.amount}`,'button compact')):`<span class="status-pill ${p.completed?'is-done':''}">${p.completed?'완료':'대기 중'}</span>`}</div></article>`).join('')}</div>`:`<div class="empty-inline"><span>✓</span><strong>${t.expenses.length?'모두 정산됐어요':'지출을 추가하면 정산 내역이 보여요'}</strong></div>`}<p class="section-note">완료 표시는 송금한 사람이 직접 남긴 기록이에요. MOA가 실제 송금 여부를 확인하지는 않습니다.</p></section><section class="panel expense-panel"><div class="section-title"><div><span class="eyebrow">SHARED EXPENSES</span><h2>지출 내역</h2></div>${btn('create-expense','＋ 지출 추가','','button secondary')}</div>${t.expenses.length?`<div class="expense-list">${t.expenses.map(e=>`<article class="expense-row"><div class="expense-main"><span class="expense-icon">₩</span><div><strong>${esc(e.title)}</strong><small>${person(e.payerId)} 결제 · ${e.shares.length}명 참여</small></div></div><div class="expense-amount"><strong>${money(e.amount)}</strong><span>${btn('edit-expense','수정',e.id,'text-button')}${btn('delete-expense','삭제',e.id,'text-button danger-text')}</span></div></article>`).join('')}</div>`:`<div class="empty-inline"><span>₩</span><strong>아직 등록한 지출이 없어요</strong><p>함께 쓴 금액부터 기록해 보세요.</p>${btn('create-expense','첫 지출 추가')}</div>`}</section>`;
}
function render() {
  const route = location.hash.slice(1).split('/')[0] || 'home';
  const t = currentTrip();
  $('#auth-controls').innerHTML = !auth ? '' : authUser ? btn('profile', `${esc(currentProfile?.avatar || '🌿')} ${esc(currentProfile?.name || '내 프로필')}`, '', 'button secondary') : btn('login','로그인','','button secondary');
  const connection=$('.global-sync');
  if(connection) connection.textContent=t?syncLabel(t):'친구와 함께 정산';
  $('#main').innerHTML = (storageBlocked?'<div class="warning">저장된 데이터를 읽을 수 없어요. 기존 기록 보호를 위해 변경을 중단했습니다. 브라우저 저장소 설정을 확인해 주세요.</div>':'') + (route==='invite' ? invitationView() : route==='trip' ? (t?tripView(t):'<div class="empty-state"><h2>정산 모임을 찾을 수 없어요</h2><a href="#home">모임 목록으로</a></div>') : home());
}
function open(title, fields, submit) { activeVersion = sessions[currentTrip()?.id]?.version; $('#editor-form [type="submit"]').hidden = false; $('#dialog-title').textContent=title; $('#dialog-fields').innerHTML=fields; $('#form-error').textContent=''; activeSubmit=submit; $('#editor').showModal(); }
function input(label,name,value='',type='text',extra='') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`; }
function tripForm() { open('정산 모임 만들기',`${input('모임 이름','title','','text','required maxlength="80" placeholder="예: 제주 여행 정산"')}${authUser?'<p class="help">모임을 만든 뒤 초대 링크를 친구에게 공유하세요.</p>':input('내 이름','myName','나','text','required maxlength="80" placeholder="모임에서 사용할 이름"')}<p class="help">지출과 송금 내역은 친구들과 함께 확인할 수 있어요.</p>`,async data=>{const today=new Date();const dateValue=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;const t=newTrip({title:data.get('title'),destination:'모임 정산',start:dateValue,end:dateValue,myName:authUser?(currentProfile?.name||'나'):data.get('myName')});if(authUser){if(!currentProfile)throw new Error('먼저 내 프로필을 설정해 주세요.');const userId=authUser.id;const created=await request('/account/trips',{method:'POST',data:{trip:t}});if(authUser?.id!==userId)return false;acceptAccountSnapshot(created,userId);location.hash=`trip/${created.trip.id}`;return true;}if(await update(s=>s.trips.push(t))){location.hash=`trip/${t.id}`;return true;}}); }
function expenseForm(t,id) {
  const old=t.expenses.find(e=>e.id===id);
  open(old?'지출 수정하기':'지출 추가하기',`${input('무엇을 결제했나요?','title',old?.title||'','text','required maxlength="100" placeholder="예: 저녁 식사"')}${input('금액','amount',old?.amount??'','number','required min="1" max="1000000000" step="1" placeholder="0"')}<label for="f-payerId">누가 결제했나요?</label><select id="f-payerId" name="payerId">${t.members.map(m=>`<option value="${m.id}" ${(old?.payerId || sessions[t.id]?.memberId || t.members[0].id)===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select><label>누구와 나눌까요?</label><div class="check-list">${t.members.map(m=>`<label><input type="checkbox" name="participants" value="${m.id}" ${!old||old.shares.some(s=>s.memberId===m.id)?'checked':''}>${esc(m.name)}</label>`).join('')}</div><p class="help">선택한 멤버끼리 1원 단위까지 똑같이 나눠요.</p>`,data=>{
    const v=Object.fromEntries(data); if(!v.title.trim()) throw Error('지출 이름을 입력해 주세요.'); const expense={id:old?.id||uid(),title:v.title.trim(),amount:amount(v.amount),itemId:old?.itemId||null,payerId:v.payerId,shares:splitExpense(v.amount,data.getAll('participants'))};
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id); if(old) trip.expenses[trip.expenses.findIndex(e=>e.id===id)]=expense; else trip.expenses.push(expense); trip.settlementPlanRevision=uid();});
  });
}
function confirmAction(title,message,action) { open(title,`<p>${esc(message)}</p>`,()=>update(action)); }
document.addEventListener('click',async e=>{
  try {
  if(e.target.closest('[data-close]')) { if (submitting) return; $('#editor').close(); return; }
  const control=e.target.closest('[data-action]'); if(!control)return;
  const {action,id}=control.dataset; const t=currentTrip();
  if(action==='login') return loginForm();
  if(action==='profile') return profileForm();
  if(action==='login-kakao'||action==='login-google') {
    control.disabled=true;
    try { await auth.signIn(action.slice(6)); }
    catch(error) { control.disabled=false; throw error; }
    return;
  }
  if(action==='logout') { $('#editor').close(); location.hash='home'; await auth.signOut(); toast('로그아웃했어요.'); return; }
  if(action==='share-invite') {
    try { await navigator.share({ title: 'MOA 모임 정산 초대', text: '함께 쓴 돈을 정산해요.', url: $('[name="inviteLink"]').value }); }
    catch(error) { if (error.name !== 'AbortError') toast('공유하지 못했어요. 링크 복사를 이용해 주세요.'); }
    return;
  }
  if(action==='copy-invite') {
    const link = $('[name="inviteLink"]');
    try { await navigator.clipboard.writeText(link.value); $('#copy-status').textContent = '복사했어요. 친구에게 보내 주세요.'; }
    catch { link.focus(); link.select(); $('#copy-status').textContent = '링크를 선택했어요. 길게 누르거나 복사 단축키로 복사해 주세요.'; }
    return;
  }
  if(action==='join-trip') {
    if (storageBlocked) throw new Error('참여 정보를 저장할 수 있도록 브라우저 저장소를 허용해 주세요.');
    control.disabled = true;
    try {
      const value = location.hash.slice(8);
      const userId = authUser?.id;
      const joined = await request(`${auth ? '/account' : ''}/invites/${encodeURIComponent(value)}/join`, { method: 'POST', data: {} });
      if(authUser?.id!==userId)return;
      if(auth)acceptAccountSnapshot(joined,userId);else{sessions[joined.trip.id]={token:joined.token};acceptSnapshot(joined);}
      history.replaceState(null, '', `#trip/${joined.trip.id}`); render(); watchTrip();
      toast('모임에 참여했어요. 함께 정산을 시작해요.');
    } catch(error) { control.disabled = false; throw error; }
    return;
  }
  if(action==='create-trip')return tripForm();
  if(!t)return;
  if(action==='invite')return inviteForm(t);
  if(['create-expense','edit-expense'].includes(action))return expenseForm(t,action==='edit-expense'?id:null);
  if(action==='delete-expense')return confirmAction('이 지출을 삭제할까요?','삭제하면 멤버별 부담 금액도 다시 계산됩니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.expenses=trip.expenses.filter(e=>e.id!==id);trip.settlementPlanRevision=uid();});
  if(action==='toggle-settlement') {
    const session=sessions[t.id], memberId=session?.memberId || t.members[0].id;
    const [from,to,amountText]=id.split(':'), value=Number(amountText);
    if(from!==memberId) throw new Error('내가 보낼 정산만 완료 처리할 수 있어요.');
    const transfer=settlementPlan(t).find(p=>p.from===from&&p.to===to&&p.amount===value);
    if(!transfer) throw new Error('정산 계획이 바뀌었어요. 최신 내역을 확인해 주세요.');
    const planKey=t.settlementPlanRevision || uid();
    const existing=(t.settlementRecords||[]).some(r=>r.planKey===planKey&&r.from===from&&r.to===to&&r.amount===value);
    await update(s=>{const trip=s.trips.find(x=>x.id===t.id);trip.settlementPlanRevision=planKey;trip.settlementRecords=trip.settlementRecords||[];trip.settlementRecords=trip.settlementRecords.filter(r=>!(r.planKey===planKey&&r.from===from&&r.to===to&&r.amount===value));if(!existing)trip.settlementRecords.push({planKey,from,to,amount:value,completedBy:memberId,completedAt:new Date().toISOString()});});
    return;
  }
  } catch(error) { toast(error.message); }
});
$('#editor-form').addEventListener('submit', async e => {
  e.preventDefault(); if (submitting) return;
  const submit = e.target.querySelector('[type="submit"]');
  submitting = true; submit.disabled = true;
  try { if (await activeSubmit(new FormData(e.target))) { $('#editor').close(); toast('여행에 잘 모아두었어요.'); } }
  catch(error) { $('#form-error').textContent = error.message; }
  finally { submitting = false; submit.disabled = false; }
});
$('#editor').addEventListener('cancel', e => { if (submitting) e.preventDefault(); });
window.addEventListener('hashchange',()=>{render();watchTrip();loadInvitation();window.scrollTo(0,0);});
window.addEventListener('storage',e=>{if(e.key===SESSION_KEY){try{sessions=JSON.parse(e.newValue || '{}');watchTrip();render();}catch{storageBlocked=true;}return;}if(e.key===KEY){$('#editor').close();try{const next=JSON.parse(e.newValue);if(!Array.isArray(next?.trips))throw Error();state=next;storageBlocked=false;render();toast('다른 탭의 변경 내용을 반영했어요.');}catch{storageBlocked=true;render();}}});
render();

watchTrip();
loadInvitation();
for (const [id, session] of Object.entries(sessions)) request(`/trips/${id}`, { token: session.token }).then(acceptSnapshot).catch(() => {});

if (auth) {
  auth.onChange(user => {
    accountEpoch++; authUser = user; currentProfile = null;
    state.trips = state.trips.filter(t => !sessions[t.id]?.account);
    sessions = Object.fromEntries(Object.entries(sessions).filter(([,s]) => !s.account));
    stopStream?.(); stopStream = undefined; streamingId = undefined;
    render(); watchTrip();
  });
  auth.initialize().then(async () => { await loadAccountData(); await loadInvitation(); }).catch(error => toast(error.message));
  window.addEventListener('storage', event => {
    if (event.key === auth.storageKey) auth.initialize().then(async () => { await loadAccountData(); await loadInvitation(); }).catch(error => toast(error.message));
  });
}

