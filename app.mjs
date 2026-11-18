import { mountFinance } from './finance.mjs?v=20261118-ocrfast';
import { prepareReceiptOCR, recognizeReceipt, receiptOCRStageName } from './receipt-ocr.mjs?v=20261118-ocrfast';
import { STATUS, uid, amount, splitExpense, balances, totalCost, newTrip, settlementPlan, settlementProgress, FUND_ID, fundBalance } from './model.mjs?v=20261118-ledger';
import { auth } from './account.mjs';
import { SESSION_KEY, request, subscribe, CONNECTION_LABEL } from './shared.mjs';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ko-KR').format(n) + '원';
const KEY = 'moa.prototype.v1';
let state = { trips: [] }, storageBlocked = false, activeSubmit, activeVersion, toastTimer;
let sessions = {}, stopStream, streamingId, inviteInfo, inviteError = '', submitting = false;
const connectionStatus = {};
const today = () => new Date().toLocaleDateString('sv-SE');
const cameraIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h3a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z"/><circle cx="12" cy="12.5" r="4"/></svg>';
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
  if (changed && !$('#finance-root dialog[open]')) render();
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
  return ({ connected: CONNECTION_LABEL, reconnecting: '연결 끊김 · 다시 연결 중', unauthorized: '참여 권한을 확인해 주세요', paused: '백그라운드에서 동기화 일시 중지' })[connectionStatus[t.id]] || '실시간 연결 중';
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
function cards() { return `<div class="cards">${state.trips.map(t => { const open=settlementProgress(t).filter(p=>!p.completed).reduce((sum,p)=>sum+p.amount,0); return `<a class="group-card" href="#trip/${t.id}" aria-label="${esc(t.title)} Space 열기"><div class="group-card-top"><span class="group-icon">${esc((t.title||'모').slice(0,1))}</span><span class="space-card-open" aria-hidden="true">↗</span></div><span class="space-card-kicker">MOA Space</span><h2>${esc(t.title)}</h2><p class="space-card-members">${t.members.length}명 참여 <span aria-hidden="true">·</span> 지출 ${t.expenses.length}건</p><div class="space-card-bottom"><div class="space-card-total"><small>함께 쓴 금액</small><strong>${money(totalCost(t))}</strong></div><span class="space-card-status ${open?'is-pending':'is-settled'}">${open?`정산 대기 ${money(open)}`:'정산 완료'}</span></div></a>`; }).join('')}<button class="new-card" data-action="create-trip"><span class="plus">+</span><strong>새 Space 만들기</strong><small>함께 쓴 돈을 모아보세요</small></button></div>`; }
function home() { return `<div class="page-heading"><div><span class="eyebrow">함께 쓰는 돈의 공간</span><h1>MOA Space</h1><p>영수증부터 정산까지, 한곳에서.</p></div>${btn('create-trip','＋ 새 Space 만들기')}</div><section class="group-section"><div class="section-title"><h2>내 Space <span>${state.trips.length}</span></h2></div>${state.trips.length?cards():`<div class="empty-state"><span class="empty-icon" aria-hidden="true">✦</span><h2>아직 Space가 없어요</h2><p>Space를 만들고 친구를 초대해<br>함께 쓴 돈과 정산 내역을 관리해 보세요.</p>${btn('create-trip','첫 Space 만들기')}</div>`}</section>`; }
function mySettlement(t) {
  const me = balances(t).find(m => m.id === (sessions[t.id]?.memberId || t.members[0].id));
  const transfers = settlementProgress(t).filter(p => p.from === me.id || p.to === me.id);
  const completed = transfers.filter(p => p.completed).reduce((sum,p) => sum+p.amount,0);
  const pending = transfers.filter(p => !p.completed).reduce((sum,p) => sum+p.amount,0);
  const sent=transfers.filter(p=>p.from===me.id).reduce((sum,p)=>sum+p.amount,0);
  const received=transfers.filter(p=>p.to===me.id).reduce((sum,p)=>sum+p.amount,0);
  const pendingSent=transfers.filter(p=>p.from===me.id&&!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const pendingReceived=transfers.filter(p=>p.to===me.id&&!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const headline=pendingSent?['보낼 금액',money(pendingSent)]:pendingReceived?['받을 금액',money(pendingReceived)]:['정산 완료',money(0)];
  const progress=sent+received?Math.round(completed/(sent+received)*100):100;
  return `<section class="my-total ${pendingSent?'is-send':pendingReceived?'is-receive':''}"><div class="my-total-top"><div class="my-total-title"><span class="eyebrow">내 정산</span><strong>${esc(me.name)}님</strong></div><span class="avatar-mini">${esc(me.avatar||'')}</span></div><div class="my-total-main"><p>${headline[0]}</p><strong class="my-total-amount">${headline[1]}</strong></div><div class="my-total-breakdown"><div><span>보내기로 한 금액</span><b>${money(sent)}</b></div><div><span>받기로 한 금액</span><b>${money(received)}</b></div></div><div class="progress-line" role="progressbar" aria-label="내 정산 완료율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div><div class="progress-caption"><span>정산 완료 ${progress}%</span><span>남은 금액 ${money(pending)}</span></div></section>`;
}
function loginButtons() {
  return `<div class="login-buttons">${btn('login-kakao','카카오로 계속하기','','button kakao')}${btn('login-google','구글로 계속하기','','button google')}</div>`;
}
function loginForm() {
  if (!auth) return toast('로그인은 공유 서비스를 연결한 환경에서 사용할 수 있어요.');
  open('MOA Space 함께하기', `<p>로그인하면 다른 기기에서도 같은 프로필과 Space를 이어갈 수 있어요.</p>${loginButtons()}<p class="help">초대받은 Space도 로그인 후 이어서 이용할 수 있어요.</p>`, () => false);
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
  open('내 프로필 설정', `${input('친구들에게 표시할 이름','profileName',initialName,'text','required maxlength="80"')}<label for="f-avatar">프로필 아이콘</label><select id="f-avatar" name="avatar">${AVATARS.map(icon => `<option ${currentProfile?.avatar === icon ? 'selected' : ''}>${icon}</option>`).join('')}</select><p class="help">이 프로필은 로그인한 계정에 저장돼요. 이름을 변경해도 기존 장부 기록은 그대로 남아요.</p>${btn('logout','로그아웃','','button secondary')}`, async data => {
    const userId = authUser.id;
    const saved = await request('/account/profile', { method:'PUT', data:{ name:data.get('profileName').trim(), avatar:data.get('avatar') } });
    if (authUser?.id !== userId) return false;
    currentProfile = saved.profile; await loadAccountData(); render(); return true;
  });
}
function invitationView() {
  if (inviteError) return `<section class="panel"><h1>초대를 확인해 주세요</h1><p role="alert">${esc(inviteError)}</p><a class="button secondary" href="#home">홈으로</a></section>`;
  if (!inviteInfo) return '<section class="panel"><p role="status">초대를 확인하고 있어요…</p></section>';
  return `<section class="panel invite-landing"><span class="eyebrow">MOA Space · 초대</span><h1>${esc(inviteInfo.title)}</h1><p>${inviteInfo.common ? '하나의 링크로 친구들과 함께 쓰는 Space예요.' : `<strong>${esc(inviteInfo.memberName)}</strong>님에게 온 초대예요.`}</p><p>지출을 함께 모으고, 각자 보낼 몫을 확인할 수 있어요.</p>${!auth ? btn('join-trip','초대 수락하고 참여하기') : !authUser ? loginButtons() : !currentProfile ? btn('profile','내 프로필 설정하고 참여하기') : `<p>${esc(currentProfile.avatar)} ${esc(currentProfile.name)}님으로 참여해요.</p>${btn('join-trip','초대 수락하고 참여하기')}`}<p class="help">${inviteInfo.common ? '친구들이 같은 링크로 각자의 계정으로 참여해요.' : '기존 개별 초대를 수락하면 해당 멤버가 내 계정과 연결돼요.'} 다른 기기에서도 같은 계정으로 이 Space를 이어갈 수 있어요.</p></section>`;
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
  const plan=settlementProgress(t), pending=plan.filter(p=>!p.completed).reduce((sum,p)=>sum+p.amount,0);
  const person=id=>id===FUND_ID?'공동 자금':esc(t.members.find(m=>m.id===id)?.name||'참여자');
  const ownerId=sessions[t.id]?.ownerId||t.members[0].id;
  const inviteAllowed=!sessions[t.id]||meId===ownerId;
  const section=location.hash.split('/')[2]||'activity';
  const isSettlement=section==='settlement', isHistory=['finance','history'].includes(section);
  const available=fundBalance(t)+plan.filter(p=>p.completed).reduce((sum,p)=>sum+(p.to===FUND_ID?p.amount:0)-(p.from===FUND_ID?p.amount:0),0);
  const activity=[...t.expenses.map(e=>({...e,type:'expense',date:e.spentOn||t.start})),...(t.fundEntries||[]).map(e=>({...e,type:'fund'}))].sort((a,b)=>b.date.localeCompare(a.date));
  const myBalance=balances(t).find(m=>m.id===meId);
  const transfers=plan.filter(p=>p.from===meId||p.to===meId);
  const myPending=transfers.filter(p=>!p.completed).reduce((sum,p)=>sum+(p.to===meId?p.amount:-p.amount),0);
  const settlement=`<section class="settlement-board">${mySettlement(t)}<div class="board-total"><span>남은 공동 자금</span><strong>${money(available)}</strong><small>보관 · ${person(ownerId)}님</small></div></section><section class="panel plan-panel"><div class="section-title"><h2>주고받을 돈</h2><span class="status-pill ${pending?'':'is-done'}">${pending?'정산 중':'완료'}</span></div>${plan.length?`<div class="transfer-list">${plan.map(p=>`<article class="transfer-row"><div class="transfer-people"><span class="person-avatar ${p.from===FUND_ID?'fund-badge':''}">${p.from===FUND_ID?'₩':person(p.from).slice(0,1)}</span><div><strong>${person(p.from)} <span class="arrow-inline">→</span> ${person(p.to)}</strong><small>${p.completed?'완료':p.from===FUND_ID?'공동 자금에서 돌려주기':p.to===FUND_ID?'공동 자금에 넣기':'개인 간 송금'}</small></div></div><div class="transfer-action"><strong>${money(p.amount)}</strong>${(p.from===FUND_ID?ownerId:p.from)===meId?btn('toggle-settlement',p.completed?'완료 취소':p.from===FUND_ID?'돌려줬어요':'보냈어요',`${p.from}:${p.to}:${p.amount}`,p.completed?'button secondary compact':'button compact'):`<span class="status-pill ${p.completed?'is-done':''}">${p.completed?'완료':'대기'}</span>`}</div></article>`).join('')}</div>`:'<div class="empty-inline"><span>✓</span><strong>주고받을 돈이 없어요</strong></div>'}<details class="calculation"><summary>계산 내역</summary><div class="summary-row"><span>내가 모은 돈</span><strong>${money(myBalance.contributed)}</strong></div><div class="summary-row"><span>내 돈으로 결제</span><strong>${money(myBalance.paid)}</strong></div><div class="summary-row"><span>이미 돌려받은 돈</span><strong>${money(myBalance.refunded)}</strong></div><div class="summary-row"><span>내가 부담할 돈</span><strong>${money(myBalance.share)}</strong></div>${myBalance.settled?`<div class="summary-row"><span>이전 정산 반영</span><strong>${money(myBalance.settled)}</strong></div>`:''}<p class="help">직접 송금한 뒤 완료 표시를 남겨 주세요. 새로 기록한 송금은 지출이 바뀌어도 정산에 반영돼요.</p></details></section>`;
  return `<a class="back" href="#home">← 내 Space</a><header class="group-header"><div><span class="eyebrow">MOA Space</span><h1>${esc(t.title)}</h1><div class="members">${t.members.map(m=>`<span class="member-chip">${esc(m.avatar||'')} ${esc(m.name)}${m.id===meId?' · 나':''}</span>`).join('')}<span id="sync-status" class="sync-status" role="status">${syncLabel(t)}</span></div></div>${inviteAllowed?btn('invite','＋ 초대','','button secondary'):''}</header>
  ${isHistory?`<a class="back" href="#trip/${t.id}">← 현재 장부</a><p class="warning">이전 공동 자금 기록이에요. 현재 장부의 잔액·정산에는 포함되지 않아요.</p><div id="finance-root"></div>`:isSettlement?settlement:`<section class="ledger-summary"><div><span>남은 돈</span><strong class="${available<0?'money-warning':''}">${money(available)}</strong><span class="fund-dot">공동 자금</span></div><div><span>쓴 돈</span><strong>${money(totalCost(t))}</strong><span>${t.expenses.length}건</span></div></section><button type="button" class="capture-hero" data-action="capture-receipt">${cameraIcon}<span>영수증 찍기<small>찍고, 확인하면 기록 끝</small></span><span class="capture-plus">＋</span></button><div class="quick-actions">${btn('create-expense','직접 입력','','text-button')}${btn('fund-entry','＋ 돈 모으기','','text-button')}${btn('refund-entry','돌려준 돈','','text-button')}</div><a href="#trip/${t.id}/settlement" class="my-balance-link ${myPending>0?'is-receive':myPending<0?'is-send':''}"><span>내 정산</span><strong>${myPending>0?`${money(myPending)} 받아요`:myPending<0?`${money(-myPending)} 보내요`:'주고받을 돈이 없어요'}</strong><span aria-hidden="true">↗</span></a><section class="panel activity-panel"><div class="section-title"><h2>내역 <small>${activity.length}</small></h2></div>${activity.length?`<div class="expense-list">${activity.map(e=>`<article class="expense-row ledger-row"><span class="expense-icon ${e.type==='fund'?'fund-badge':''}">${e.type==='fund'?(e.kind==='contribution'?'↓':'↑'):'▧'}</span><div class="ledger-row-body"><strong class="ledger-amount">${e.type==='fund'?(e.kind==='contribution'?'+':'−'):''}${money(e.amount)}</strong><div class="ledger-row-meta"><span class="payment-badge ${e.type==='fund'||e.payment==='fund'?'fund-badge':'personal-badge'}">${e.type==='fund'?(e.kind==='contribution'?'모은 돈':'돌려준 돈'):e.payment==='fund'?'공동 자금':`${person(e.payerId)} 결제`}</span><span>${e.type==='fund'?person(e.memberId):`${e.shares.length}명`}</span><time>${esc(e.date.slice(5).replace('-','.'))}</time></div>${e.type==='expense'&&e.title!=='지출'?`<small class="ledger-note">${esc(e.title)}</small>`:''}</div><div class="row-actions">${e.type==='expense'?btn('edit-expense','수정',e.id,'text-button'):''}${btn(e.type==='expense'?'delete-expense':'delete-fund','삭제',e.id,'text-button danger-text')}</div></article>`).join('')}</div>`:'<div class="empty-inline"><span>▧</span><strong>첫 영수증을 찍어보세요</strong></div>'}</section>${sessions[t.id]?.account?`<a class="legacy-link" href="#trip/${t.id}/history">이전 공동 자금 기록 ↗</a>`:''}`}
  <nav class="ledger-nav" aria-label="Space 메뉴"><a href="#trip/${t.id}" ${!isSettlement&&!isHistory?'aria-current="page"':''}><span aria-hidden="true">☷</span>내역</a><button type="button" data-action="capture-receipt" aria-label="영수증 찍기">${cameraIcon}<span>촬영</span></button><a href="#trip/${t.id}/settlement" ${isSettlement?'aria-current="page"':''}><span aria-hidden="true">⇄</span>정산</a></nav>`;
}
function render() {
  const route = location.hash.slice(1).split('/')[0] || 'home';
  const t = currentTrip();
  $('#auth-controls').innerHTML = !auth ? '' : authUser ? btn('profile', `${esc(currentProfile?.avatar || '🌿')} ${esc(currentProfile?.name || '내 프로필')}`, '', 'button secondary') : btn('login','로그인','','button secondary');
  const connection=$('.global-sync');
  if(connection) connection.textContent=t?syncLabel(t):'친구들과 함께 관리해요';
  $('#main').innerHTML = (storageBlocked?'<div class="warning">저장된 데이터를 읽을 수 없어요. 기존 기록 보호를 위해 변경을 중단했습니다. 브라우저 저장소 설정을 확인해 주세요.</div>':'') + (route==='invite' ? invitationView() : route==='trip' ? (t?tripView(t):'<div class="empty-state"><h2>Space를 찾을 수 없어요</h2><a href="#home">내 Space로 돌아가기</a></div>') : home());
  if(t && route==='trip' && ['finance','history'].includes(location.hash.split('/')[2])) mountFinance($('#finance-root'),t,Boolean(sessions[t.id]?.account),{readOnly:true});
}
function open(title, fields, submit) { $('#editor-form').oninput=null; $('#editor-form [type="submit"]').textContent='저장하기'; activeVersion = sessions[currentTrip()?.id]?.version; $('#editor-form [type="submit"]').hidden = false; $('#dialog-title').textContent=title; $('#dialog-fields').innerHTML=fields; $('#form-error').textContent=''; activeSubmit=submit; $('#editor').showModal(); }
function input(label,name,value='',type='text',extra='') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`; }
function tripForm() {
  open('새 Space',`${input('공간 이름','title','','text','required maxlength="80" placeholder="예: 우리 제주 여행"')}${authUser?'':input('내 이름','myName','나','text','required maxlength="80"')}${input('내가 넣고 시작할 돈','initialFund',0,'number','min="0" max="1000000000" step="1"')}<p class="help">공동 자금이 없으면 0원. 친구가 참여하면 낸 돈을 추가할 수 있어요.</p>`,async data=>{
    const dateValue=today();
    const t=newTrip({title:data.get('title'),destination:'모임 정산',start:dateValue,end:dateValue,myName:authUser?(currentProfile?.name||'나'):data.get('myName')});
    const initial=amount(data.get('initialFund'));
    t.fundEntries=initial?[{id:uid(),kind:'contribution',memberId:t.members[0].id,amount:initial,date:dateValue}]:[];
    if(authUser){if(!currentProfile)throw new Error('먼저 내 프로필을 설정해 주세요.');const userId=authUser.id;const created=await request('/account/trips',{method:'POST',data:{trip:t}});if(authUser?.id!==userId)return false;acceptAccountSnapshot(created,userId);location.hash=`trip/${created.trip.id}`;return true;}
    if(await update(s=>s.trips.push(t))){location.hash=`trip/${t.id}`;return true;}
  });
}
function fundForm(t,kind='contribution') {
  const meId=sessions[t.id]?.memberId||t.members[0].id;
  open(kind==='contribution'?'돈 모으기':'돌려준 돈',`${input('금액 (원)','amount','','number','required min="1" max="1000000000" step="1" placeholder="0"')}<label for="f-memberId">${kind==='contribution'?'누가 냈나요?':'누가 받았나요?'}</label><select id="f-memberId" name="memberId">${t.members.map(m=>`<option value="${esc(m.id)}" ${m.id===meId?'selected':''}>${esc(m.name)}</option>`).join('')}</select>${input('날짜','date',today(),'date','required')}<p class="help">${kind==='contribution'?'공동 자금에 실제로 넣은 돈을 기록해요.':'공동 자금에서 이미 돌려준 돈만 기록해요.'}</p>`,data=>{
    const value=amount(data.get('amount'));if(!value)throw Error('1원 이상 입력해 주세요.');
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id);trip.fundEntries||=[];trip.fundEntries.push({id:uid(),kind,memberId:data.get('memberId'),amount:value,date:data.get('date')});trip.settlementPlanRevision=uid();});
  });
}
function expenseForm(t,id,capture=false) {
  const old=t.expenses.find(e=>e.id===id), meId=sessions[t.id]?.memberId||t.members[0].id;
  const selectedPayment=old?.payment||(fundBalance(t)>0?'fund':'personal');
  const fields=`<label class="receipt-picker receipt-main" for="f-receipt-photo">${cameraIcon}<span><strong>${old?'영수증 다시 읽기':'영수증 찍기'}</strong><small>사진 선택도 가능해요</small></span><input id="f-receipt-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></label><p class="receipt-photo-tip">영수증을 펼쳐 전체가 보이게 하고, 빛 반사 없이 정면에서 찍어 주세요.</p><label class="receipt-gallery" for="f-receipt-gallery">사진에서 가져오기<input id="f-receipt-gallery" type="file" accept="image/jpeg,image/png,image/webp"></label><p class="receipt-status" data-expense-ocr role="status" aria-live="polite"></p><div class="amount-field">${input('금액','amount',old?.amount??'','number','required min="1" max="1000000000" step="1" placeholder="0" inputmode="numeric"')}<span>원</span></div><label>어떤 돈으로 냈나요?</label><div class="payment-options"><label><input type="radio" name="payment" value="fund" ${selectedPayment==='fund'?'checked':''}><span>공동 자금</span></label><label><input type="radio" name="payment" value="personal" ${selectedPayment==='personal'?'checked':''}><span>개인 돈</span></label></div><div data-payer-field><label for="f-payerId">결제한 사람</label><select id="f-payerId" name="payerId">${t.members.map(m=>`<option value="${esc(m.id)}" ${(old?.payerId||meId)===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div><label>함께 부담할 사람</label><div class="check-list">${t.members.map(m=>`<label><input type="checkbox" name="participants" value="${esc(m.id)}" ${!old||old.shares.some(s=>s.memberId===m.id)?'checked':''}>${esc(m.name)}</label>`).join('')}</div><p class="split-preview" data-split-preview></p><p class="duplicate-note" data-duplicate hidden></p><details class="expense-options"><summary>상세 정보</summary><div class="expense-options-body">${input('사용 날짜','spentOn',old?.spentOn||today(),'date','required')}${input('메모 (선택)','title',old?.title==='지출'?'':old?.title||'','text','maxlength="100" placeholder="자동으로 읽은 가게명 또는 메모"')}<p class="help">사진은 인식에만 사용하고 저장하지 않아요.</p></div></details>`;
  let duplicateAccepted=false;
  open(old?'지출 수정':'지출 기록',fields,data=>{
    const value=amount(data.get('amount'));if(!value)throw Error('1원 이상 입력해 주세요.');
    const date=data.get('spentOn');
    const duplicate=t.expenses.find(e=>e.id!==old?.id&&e.amount===value&&e.spentOn===date);
    if(duplicate&&!duplicateAccepted){duplicateAccepted=true;const note=$('[data-duplicate]');note.hidden=false;note.textContent='같은 날짜·금액이 있어요. 새 지출이면 한 번 더 기록해 주세요.';return false;}
    const expense={id:old?.id||uid(),title:String(data.get('title')||'').trim()||'지출',amount:value,itemId:old?.itemId||null,payerId:data.get('payerId'),payment:data.get('payment'),spentOn:date,shares:splitExpense(value,data.getAll('participants'))};
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id);if(old)trip.expenses[trip.expenses.findIndex(e=>e.id===id)]=expense;else trip.expenses.push(expense);trip.settlementPlanRevision=uid();});
  });
  const dialog=$('#editor'),form=$('#editor-form'),photo=$('#f-receipt-photo'),gallery=$('#f-receipt-gallery'),status=$('[data-expense-ocr]'),save=dialog.querySelector('[type="submit"]');
  const thisFields=$('#dialog-fields').firstElementChild,active=()=>dialog.open&&thisFields.isConnected;
  const showProgress=(progress,stage)=>{
    if(!active())return;
    status.className='receipt-status is-reading';
    const label=receiptOCRStageName(stage);
    status.textContent=label+(Number.isFinite(progress)&&progress>0?' '+Math.round(progress*100)+'%':'');
  };
  save.textContent='기록하기';
  const refresh=()=>{
    duplicateAccepted=false;$('[data-duplicate]').hidden=true;
    const count=form.querySelectorAll('[name="participants"]:checked').length,value=Number($('#f-amount').value);
    $('[data-split-preview]').textContent=count&&value>0?`${count}명 · 1인 ${money(Math.floor(value/count))}${value%count?'부터':''}`:'함께 부담할 사람을 선택해 주세요';
    $('[data-payer-field]').hidden=form.querySelector('[name="payment"]:checked').value==='fund';
  };
  form.oninput=refresh;refresh();
  let reading=false;
  const readPhoto=async event=>{
    const file=event.currentTarget.files?.[0];if(!file||reading)return;
    if(file.size>12582912||!['image/jpeg','image/png','image/webp'].includes(file.type)){status.textContent='12MB 이하 JPG·PNG·WebP 사진을 선택해 주세요.';status.className='receipt-status needs-check';return;}
    reading=true;photo.disabled=true;gallery.disabled=true;save.disabled=true;status.className='receipt-status is-reading';status.textContent='사진을 보정하고 있어요…';
    try{
      const found=await recognizeReceipt(file,showProgress);
      if(!active())return;
      if(found.title)$('#f-title').value=found.title;
      $('#f-amount').value=found.amount||'';
      if(found.spent_on)$('#f-spentOn').value=found.spent_on;
      const uncertain=!found.amount||found.amountConfidence==='low';
      status.className=`receipt-status ${uncertain?'needs-check':'is-ready'}`;
      status.textContent=uncertain?'금액을 확인해 주세요':found.spent_on?'✓ 금액을 확인하고 기록하세요':'✓ 금액 확인 · 날짜도 확인해 주세요';
      $('#f-amount').classList.toggle('needs-check',uncertain);
      refresh();$('#f-amount').focus();
    }catch(error){if(active()){status.textContent='다시 찍거나 금액을 입력해 주세요';status.className='receipt-status needs-check';}console.error('Receipt OCR failed',error);}
    finally{reading=false;if(photo.isConnected)photo.disabled=false;if(gallery.isConnected)gallery.disabled=false;if(save.isConnected)save.disabled=false;}
  };
  photo.addEventListener('change',readPhoto);gallery.addEventListener('change',readPhoto);
  prepareReceiptOCR(showProgress).catch(error=>{
    if(active()){status.className='receipt-status needs-check';status.textContent='인식 엔진을 준비하지 못했어요. 금액을 직접 입력할 수 있어요.';}
    console.error('Receipt OCR warmup failed',error);
  });
  if(capture)photo.click();
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
    try { await navigator.share({ title: 'MOA Space 초대', text: '우리 Space에서 지출과 정산을 함께 관리해요.', url: $('[name="inviteLink"]').value }); }
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
      toast('MOA Space를 함께 쓰기 시작했어요.');
    } catch(error) { control.disabled = false; throw error; }
    return;
  }
  if(action==='create-trip')return tripForm();
  if(!t)return;
  if(action==='invite')return inviteForm(t);
  if(action==='capture-receipt')return expenseForm(t,null,true);
  if(action==='fund-entry'||action==='refund-entry')return fundForm(t,action==='fund-entry'?'contribution':'refund');
  if(action==='delete-fund')return confirmAction('이 기록을 삭제할까요?','잔액과 정산 금액이 다시 계산돼요.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.fundEntries=(trip.fundEntries||[]).filter(e=>e.id!==id);trip.settlementPlanRevision=uid();});
  if(['create-expense','edit-expense'].includes(action))return expenseForm(t,action==='edit-expense'?id:null);
  if(action==='delete-expense')return confirmAction('이 지출을 삭제할까요?','삭제하면 멤버별 부담 금액도 다시 계산됩니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.expenses=trip.expenses.filter(e=>e.id!==id);trip.settlementPlanRevision=uid();});
  if(action==='toggle-settlement') {
    const session=sessions[t.id], memberId=session?.memberId || t.members[0].id;
    const [from,to,amountText]=id.split(':'), value=Number(amountText);
    if((from===FUND_ID?(session?.ownerId||t.members[0].id):from)!==memberId) throw new Error('내가 보낼 정산만 완료 처리할 수 있어요.');
    const transfer=settlementPlan(t).find(p=>p.from===from&&p.to===to&&p.amount===value);
    if(!transfer) throw new Error('정산 계획이 바뀌었어요. 최신 내역을 확인해 주세요.');
    const planKey=t.settlementPlanRevision || uid();
    const existing=(t.settlementRecords||[]).some(r=>r.planKey===planKey&&r.from===from&&r.to===to&&r.amount===value);
    await update(s=>{const trip=s.trips.find(x=>x.id===t.id);trip.settlementPlanRevision=planKey;trip.settlementRecords=trip.settlementRecords||[];trip.settlementRecords=trip.settlementRecords.filter(r=>!(r.planKey===planKey&&r.from===from&&r.to===to&&r.amount===value));if(!existing)trip.settlementRecords.push({planKey,from,to,amount:value,completedBy:memberId,ledger:true,completedAt:new Date().toISOString()});});
    return;
  }
  } catch(error) { toast(error.message); }
});
$('#editor-form').addEventListener('submit', async e => {
  e.preventDefault(); if (submitting) return;
  const submit = e.target.querySelector('[type="submit"]');
  submitting = true; submit.disabled = true;
  try { if (await activeSubmit(new FormData(e.target))) { $('#editor').close(); toast('MOA Space에 저장했어요.'); } }
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

