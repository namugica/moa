import { STATUS, uid, dayCount, amount, splitExpense, balances, totalCost, plannedCost, newTrip, demoTrip, settlementPlan } from './model.mjs';
import { SESSION_KEY, request, subscribe, CONNECTION_LABEL } from './shared.mjs';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ko-KR').format(n) + '원';
const date = d => d.replaceAll('-', '.');
const KEY = 'moa.prototype.v1';
let state = { trips: [] }, storageBlocked = false, activeSubmit, activeVersion, toastTimer;
let sessions = {}, stopStream, streamingId, inviteInfo, inviteError = '', submitting = false;
const connectionStatus = {};
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
  localStorage.setItem(KEY, JSON.stringify(state));
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
}
function acceptSnapshot(data) {
  const session = sessions[data.trip.id];
  if (!session || data.version < (session.version || 0)) return;
  const changed = data.version !== session.version || JSON.stringify(data.claimedIds) !== JSON.stringify(session.claimedIds) || !state.trips.some(t => t.id === data.trip.id);
  Object.assign(session, { version: data.version, memberId: data.memberId, ownerId: data.ownerId, claimedIds: data.claimedIds });
  const index = state.trips.findIndex(t => t.id === data.trip.id);
  if (index === -1) state.trips.push(data.trip); else state.trips[index] = data.trip;
  try { persist(); } catch { storageBlocked = true; toast('이 브라우저에 참여 정보를 보관하지 못했어요. 저장소 설정을 확인해 주세요.'); }
  if (changed) render();
}
function watchTrip() {
  const t = currentTrip(), session = t && sessions[t.id];
  if (streamingId === (session ? t.id : undefined)) return;
  stopStream?.(); stopStream = undefined; streamingId = session ? t.id : undefined;
  if (session) stopStream = subscribe(t.id, session.token, acceptSnapshot, status => {
    connectionStatus[t.id] = status;
    const label = $('#sync-status');
    if (label && currentTrip()?.id === t.id) { label.textContent = syncLabel(t); $('.profile small').textContent = syncLabel(t); }
  });
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
    try { acceptSnapshot(await request(`/trips/${shared.id}`, { token: session.token, method: 'PATCH', data: { trip: shared, version: $('#editor').open ? activeVersion : session.version } })); return true; }
    catch (error) { if (error.snapshot) { acceptSnapshot(error.snapshot); activeVersion = error.snapshot.version; } throw error; }
  }
  try { localStorage.setItem(KEY, JSON.stringify(next)); state = next; render(); return true; }
  catch { throw new Error('저장하지 못했어요. 브라우저 저장 공간과 권한을 확인해 주세요.'); }
}
const tripById = id => state.trips.find(t => t.id === id);
const currentTrip = () => tripById(location.hash.split('/')[1]);
const btn = (action, label, id = '', klass = 'button') => `<button type="button" class="${klass}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
function stats(trips) { return `<div class="stats"><div class="stat"><span>함께 쌓은 여행</span><strong>${trips.length}<small>개</small></strong></div><div class="stat"><span>기록한 여행 경비</span><strong>${new Intl.NumberFormat('ko-KR').format(trips.reduce((s,t) => s + totalCost(t),0))}<small>원</small></strong></div><div class="stat"><span>모아둔 일정</span><strong>${trips.reduce((s,t) => s + t.items.length,0)}<small>개</small></strong></div></div>`; }
function cards() { return `<div class="cards">${state.trips.map(t => `<article class="trip-card"><div class="card-art"><span class="badge ${t.status}">${STATUS[t.status]}</span></div><div class="card-content"><small>${esc(t.destination)}${t.demo ? ' · 예시 여행' : ''}</small><h3>${esc(t.title)}</h3><p>${date(t.start)} — ${date(t.end)} · ${dayCount(t.start,t.end)}일</p><div class="card-bottom"><span>${t.members.length}명이 함께하는 여행</span><strong>${t.expenses.length ? money(totalCost(t)) : '여행 살펴보기'} ↗</strong></div></div><a class="card-link" href="#trip/${t.id}" aria-label="${esc(t.title)} 열기"></a></article>`).join('')}<button class="new-card" data-action="create-trip"><span class="plus">+</span><strong>새로운 여행을 모아볼까요?</strong><small>설레는 계획의 시작, 여기서부터</small></button></div>`; }
function home(all = false) { return `<div class="heading-row"><div><h1>${all ? '나의 여행' : '다음 여행도, 함께 모아봐요.'}</h1><p>${all ? '떠나기 전 설렘부터 돌아온 뒤의 기록까지.' : '여행의 설렘은 남기고, 정산의 부담은 덜어내세요.'}</p></div>${btn('create-trip','＋ 여행 만들기')}</div>${!all ? `<section class="hero"><div class="hero-copy"><span class="eyebrow">Less hassle, more journey</span><h2>함께 떠나는 여행,<br>마음까지 가볍게.</h2><p>계획부터 지출 기록까지 한곳에.<br>우리의 여행을 MOA로 시작해요.</p>${btn('create-trip','새로운 여행 시작하기 ↗')}</div><img src="assets/travel.svg" alt="초록색 여행 가방과 바다, 야자수 일러스트"></section>${stats(state.trips)}` : ''}<section><div class="section-title"><h2>나의 여행 <span>${state.trips.length.toString().padStart(2,'0')}</span></h2>${!state.trips.length ? btn('demo','예시 여행 살펴보기','','button ghost') : '<span class="muted">계획하고, 기록하고, 모으다</span>'}</div>${cards()}</section><div class="note-strip"><b>✧ MOA의 약속</b><span>누가, 어디서, 얼마를 썼는지. 여행의 모든 지출을 투명하게 기록해요.</span></div>`; }
function itemView(t, item, index, length) {
  const spent = t.expenses.filter(e => e.itemId === item.id).reduce((s,e) => s+e.amount,0);
  return `<article class="timeline-item"><div class="item-top"><div><span class="time">${esc(item.time || '시간 미정')} · ${esc(item.category)}</span><h3>${esc(item.place)}</h3></div><div class="item-controls">${index ? btn('up','↑',item.id,'icon-button') : ''}${index < length-1 ? btn('down','↓',item.id,'icon-button') : ''}${btn('edit-item','수정',item.id,'icon-button')}${btn('delete-item','삭제',item.id,'icon-button')}</div></div>${item.note ? `<p>${esc(item.note)}</p>` : ''}<div class="cost-line"><span>예상 ${money(item.estimate)}</span>${spent ? `<b>실제 ${money(spent)}</b>` : ''}</div>${t.status !== 'planning' ? btn('item-expense','＋ 이 일정 지출 기록',item.id,'button ghost') : ''}</article>`;
}
function mySettlement(t) {
  const me = balances(t).find(m => m.id === (sessions[t.id]?.memberId || t.members[0].id));
  const transfers = settlementPlan(t).filter(p => p.from === me.id || p.to === me.id);
  const name = id => esc(t.members.find(m => m.id === id)?.name);
  return `<section class="panel personal-settlement"><span class="eyebrow">${esc(me.name)}님의 정산</span><h2>나의 정산</h2><div class="personal-amount" data-personal-balance="${me.balance}">${me.balance > 0 ? '받을 돈' : me.balance < 0 ? '보낼 돈' : '정산 균형'} <strong>${money(Math.abs(me.balance))}</strong></div><div class="summary-row"><span>내가 결제한 금액</span><strong>${money(me.paid)}</strong></div><div class="summary-row"><span>내가 부담한 금액</span><strong>${money(me.share)}</strong></div>${transfers.map(p => `<p class="transfer">${p.from === me.id ? `${name(p.to)}님에게 보낼 돈` : `${name(p.from)}님에게 받을 돈`} <strong>${money(p.amount)}</strong></p>`).join('')}<p class="help">공통 지출은 모두 같고, 이 정산은 내 멤버 기준이에요. 실제 송금 완료를 뜻하지 않아요.</p></section>`;
}
function invitationView() {
  if (inviteError) return `<section class="panel"><h1>초대를 확인해 주세요</h1><p role="alert">${esc(inviteError)}</p><a class="button secondary" href="#home">홈으로</a></section>`;
  if (!inviteInfo) return '<section class="panel"><p role="status">초대를 확인하고 있어요…</p></section>';
  return `<section class="panel invite-landing"><span class="eyebrow">함께하는 여행</span><h1>${esc(inviteInfo.title)}</h1><p><strong>${esc(inviteInfo.memberName)}</strong>님으로 초대받았어요.</p><p>같은 일정과 지출을 함께 편집하고, 나의 정산을 확인할 수 있어요.</p>${btn('join-trip','초대 수락하고 참여하기')}<p class="help">본인에게 온 링크인지 확인해 주세요. 한 번만 사용할 수 있으며, 참여 정보는 이 브라우저에 보관돼요.</p></section>`;
}
async function loadInvitation() {
  const value = location.hash.startsWith('#invite/') ? location.hash.slice(8) : null;
  if (!value) return;
  inviteInfo = undefined; inviteError = ''; render();
  try { const info = await request(`/invites/${encodeURIComponent(value)}`); if (location.hash === `#invite/${value}`) inviteInfo = info; }
  catch (error) { if (location.hash === `#invite/${value}`) inviteError = error.message; }
  if (location.hash === `#invite/${value}`) render();
}
function inviteForm(t) {
  if (storageBlocked) return toast('브라우저 저장소를 먼저 사용할 수 있어야 초대할 수 있어요.');
  const session = sessions[t.id];
  const candidates = t.members.filter(m => m.id !== (session?.memberId || t.members[0].id) && !session?.claimedIds?.includes(m.id));
  open('친구를 여행에 초대하기', `${!session && t.members[0].name === '나' ? input('친구들에게 표시할 내 이름','myName','','text','required maxlength="80"') : ''}<label for="f-inviteMember">초대할 친구</label><select id="f-inviteMember" name="memberId">${candidates.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}<option value="">새 친구 추가</option></select>${input('새 친구 이름 (새 친구 추가를 선택한 경우)','friendName','','text','maxlength="80"')}<p class="help">친구마다 전용 링크를 보내 주세요. 링크는 7일 동안 한 번 사용할 수 있어요. 다시 만들면 해당 친구의 이전 링크는 만료돼요. 새 멤버는 이전 지출에 자동 추가되지 않아요.</p>${!session ? '<p class="help">초대 링크를 만들면 이 여행의 일정과 지출을 서버에 저장하고 친구와 공유해요.</p>' : ''}`, async data => {
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
function tripView(t) {
  const days = [...new Set(t.items.map(i=>i.date))].sort();
  return `<a class="back" href="#trips">← 나의 여행으로</a><section class="trip-head"><span class="badge ${t.status}">${STATUS[t.status]}${t.demo ? ' · 예시 데이터' : ''}</span><div class="heading-row"><div><h1>${esc(t.title)}</h1><p>${esc(t.destination)} &nbsp; ${date(t.start)} — ${date(t.end)}</p></div><div class="actions">${!sessions[t.id] || sessions[t.id].memberId === sessions[t.id].ownerId ? btn('invite','친구 초대','','button secondary') : ''}${t.status === 'planning' ? btn('start','여행 시작하기 ↗') : t.status === 'traveling' ? btn('finish','여행 종료하기') : '<span class="muted">잘 다녀왔어요. 기록을 정리해 볼까요?</span>'}</div></div><div class="members">${t.members.map(m=>`<span class="member" title="${sessions[t.id]?.claimedIds?.includes(m.id) ? '참여 완료' : '초대 전'}">${esc(m.name)}${m.id === (sessions[t.id]?.memberId || t.members[0].id) ? ' · 나' : ''}</span>`).join('')}<span class="help">${t.members.length}명이 함께해요</span><span id="sync-status" class="sync-status" role="status">${syncLabel(t)}</span></div></section><div class="detail-grid"><div><section class="panel"><div class="section-title"><h2>우리의 여행 타임라인</h2>${btn('create-item','＋ 일정 추가','','button ghost')}</div>${days.length ? days.map(d=> { const list = t.items.filter(i=>i.date===d).sort((a,b)=>a.order-b.order); return `<div class="day-label"><strong>DAY ${dayCount(t.start,d)}</strong>${date(d)}</div>${list.map((i,index)=>itemView(t,i,index,list.length)).join('')}`; }).join('') : '<div class="empty">아직 모아둔 일정이 없어요.<br>첫 번째 가고 싶은 곳을 추가해 보세요.</div>'}</section><section class="panel"><div class="section-title"><h2>함께 쓴 여행 경비</h2>${btn('create-expense','＋ 지출 기록','','button ghost')}</div>${t.expenses.length ? t.expenses.map(e=>`<article class="expense-row"><div class="item-top"><strong>${esc(e.title)}</strong><span>${money(e.amount)} ${btn('edit-expense','수정',e.id,'icon-button')}${btn('delete-expense','삭제',e.id,'icon-button')}</span></div><small>${esc(t.members.find(m=>m.id===e.payerId)?.name)} 결제 · ${e.shares.map(s=>esc(t.members.find(m=>m.id===s.memberId)?.name)).join(', ')} 함께 사용${e.itemId ? ' · '+esc(t.items.find(i=>i.id===e.itemId)?.place) : ''}</small></article>`).join('') : '<p class="empty">갑자기 탄 택시도, 함께 먹은 점심도.<br>작은 지출부터 모아보세요.</p>'}</section></div><aside class="summary-panel">${mySettlement(t)}<section class="panel"><span class="eyebrow">Our travel wallet</span><h2 style="margin-top:12px">지금까지 모은 경비</h2><div class="summary-total">${money(totalCost(t))}</div><div class="summary-row"><span class="muted">예상 일정 비용</span><strong>${money(plannedCost(t))}</strong></div><div class="summary-row"><span class="muted">지출 기록</span><strong>${t.expenses.length}건</strong></div>${btn('create-expense','＋ 지출 기록하기','','button full')}<p class="help">모든 금액은 원화(KRW) 기준입니다.<br>실제 지출이 예상 비용을 자동으로 대체하지 않아요.</p></section><section class="panel"><h3>투명한 나눔</h3><p class="help">지출별 참여자끼리 나눈 예상 정산 내역이에요. 공유 여행에서는 친구와 같은 내역을 봐요. 실제 송금 기능은 포함되지 않습니다.</p>${balances(t).map(m=>`<details class="balance"><summary>${esc(m.name)}<strong>${m.balance>0?'받을 돈':m.balance<0?'보낼 돈':'정산 균형'} ${money(Math.abs(m.balance))}</strong></summary><p>대신 결제 ${money(m.paid)}<br>나의 부담 ${money(m.share)}</p>${t.expenses.filter(e=>e.shares.some(s=>s.memberId===m.id)).map(e=>`<div class="summary-row"><span>${esc(e.title)}</span><span>${money(e.shares.find(s=>s.memberId===m.id).amount)}</span></div>`).join('')}</details>`).join('')}<p class="help">나누어떨어지지 않는 1원은 선택한 멤버 순서대로 배분해요.</p></section></aside></div>`;
}
function guide() { return `<div class="heading-row"><div><h1>가벼운 여행을 위한 MOA 가이드</h1><p>우리가 함께 모으는 것은 경비 그 이상의 순간이에요.</p></div></div><div class="guide-grid">${[['01 · 계획을 모아요','여행을 만들고 함께 갈 사람의 이름을 입력해요. 일정을 추가하고 위아래 화살표로 같은 날짜 안의 순서를 바꿀 수 있어요.'],['02 · 순간을 기록해요','여행 시작 버튼을 누르고 실제 지출을 기록해요. 결제한 사람과 함께 쓴 사람을 각각 선택할 수 있어요.'],['03 · 투명하게 나눠요','각자의 부담액과 대신 결제한 돈을 비교해요. 투명한 나눔에서 이름을 누르면 계산 과정을 확인할 수 있어요.'],['04 · 친구와 함께해요','여행의 친구 초대에서 친구별 링크를 만들어요. 친구가 수락하면 일정과 지출이 실시간으로 연결되고 나의 정산은 각자 다르게 보여요. 공유 전 여행은 브라우저에, 공유 여행은 서버에도 저장돼요.']].map(([h,p])=>`<section class="panel"><h2>${h}</h2><p>${p}</p></section>`).join('')}</div><section class="panel"><h2>내 기록 보관하기</h2><p class="help">브라우저 데이터를 삭제하면 개인 기록과 공유 여행 참여 정보에 접근할 수 없게 돼요. 필요할 때 JSON 파일로 내려받아 보관하세요. 현재 버전은 가져오기를 지원하지 않아요.</p>${btn('export','여행 데이터 내보내기','','button secondary')}</section>`; }
function render() {
  const route = location.hash.slice(1).split('/')[0] || 'home';
  document.querySelectorAll('[data-nav]').forEach(a=>{ const active = a.dataset.nav === (route==='trip'?'trips':route); a.classList.toggle('active',active); if(active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = route==='trip'?'나의 여행 / 타임라인':route==='guide'?'MOA 사용 가이드':'나의 여행 대시보드';
  const t = currentTrip();
  const me = t?.members.find(m => m.id === (sessions[t.id]?.memberId || t.members[0].id));
  $('.profile strong').textContent = me ? `${me.name}님` : '여행자님';
  $('.profile small').textContent = t ? syncLabel(t) : '나의 여행 파트너';
  $('#main').innerHTML = (storageBlocked?'<div class="warning">저장된 데이터를 읽을 수 없어요. 기존 기록 보호를 위해 변경을 중단했습니다. 브라우저 저장소 설정을 확인해 주세요.</div>':'') + (route==='invite' ? invitationView() : route==='trip' ? (t?tripView(t):'<div class="empty">이 여행을 찾을 수 없어요.<br><a href="#home">홈으로 돌아가기</a></div>') : route==='guide'?guide():home(route==='trips'));
}
function open(title, fields, submit) { activeVersion = sessions[currentTrip()?.id]?.version; $('#editor-form [type="submit"]').hidden = false; $('#dialog-title').textContent=title; $('#dialog-fields').innerHTML=fields; $('#form-error').textContent=''; activeSubmit=submit; $('#editor').showModal(); }
function input(label,name,value='',type='text',extra='') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`; }
function tripForm() { open('새로운 여행 시작하기', `${input('내 이름','myName','','text','required maxlength="80" placeholder="친구들에게 표시할 이름"')}${input('여행 이름','title','','text','required maxlength="80" placeholder="예: 우리의 느긋한 제주"')}${input('여행지','destination','','text','required maxlength="80" placeholder="예: 제주, 대한민국"')}<div class="field-row"><div>${input('시작일','start','','date','required')}</div><div>${input('종료일','end','','date','required')}</div></div>${input('함께 가는 사람 (선택)','names','','text','maxlength="400" placeholder="민지, 수현 — 쉼표로 구분해 주세요"')}<p class="help">내 이름은 자동으로 포함돼요. 친구 초대는 여행을 만든 후 보낼 수 있어요.</p>`, async data=>{ const t=newTrip(Object.fromEntries(data)); if(await update(s=>s.trips.push(t))){location.hash=`trip/${t.id}`; return true;} }); }
function itemForm(t,id) {
  const old=t.items.find(i=>i.id===id);
  open(old?'일정 수정하기':'설레는 일정 추가하기',`${input('장소 이름','place',old?.place,'text','required maxlength="100"') }<div class="field-row"><div>${input('방문 날짜','date',old?.date||t.start,'date',`required min="${t.start}" max="${t.end}"`)}</div><div>${input('시간 (선택)','time',old?.time||'','time')}</div></div><label for="f-category">카테고리</label><select id="f-category" name="category">${['관광','맛집','카페','이동','숙소','기타'].map(v=>`<option ${old?.category===v?'selected':''}>${v}</option>`).join('')}</select>${input('예상 비용 (원)','estimate',old?.estimate??0,'number','required min="0" max="1000000000" step="1"')}<label for="f-note">메모</label><textarea id="f-note" name="note" maxlength="1000">${esc(old?.note||'')}</textarea>`,data=>{
    const v=Object.fromEntries(data); if(!v.place.trim()) throw Error('장소 이름을 입력해 주세요.'); if(v.date<t.start||v.date>t.end) throw Error('여행 기간 안의 날짜를 선택해 주세요.');
    const item={...v,place:v.place.trim(),estimate:amount(v.estimate),id:old?.id||uid(),order:old && old.date===v.date?old.order:Math.max(-1,...t.items.map(i=>i.order))+1};
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id); if(old) trip.items[trip.items.findIndex(i=>i.id===id)]=item; else trip.items.push(item);});
  });
}
function expenseForm(t,id,itemId='') {
  const old=t.expenses.find(e=>e.id===id);
  open(old?'지출 수정하기':'함께 쓴 지출 기록하기',`${input('지출 이름','title',old?.title||t.items.find(i=>i.id===itemId)?.place||'','text','required maxlength="100"')}${input('실제 금액 (원)','amount',old?.amount??'','number','required min="0" max="1000000000" step="1"')}<label for="f-itemId">연결할 일정 (선택)</label><select id="f-itemId" name="itemId"><option value="">일정과 관계없는 지출</option>${t.items.map(i=>`<option value="${i.id}" ${(old?.itemId||itemId)===i.id?'selected':''}>${esc(i.place)} · ${date(i.date)}</option>`).join('')}</select><label for="f-payerId">누가 결제했나요?</label><select id="f-payerId" name="payerId">${t.members.map(m=>`<option value="${m.id}" ${(old?.payerId || sessions[t.id]?.memberId || t.members[0].id)===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select><label>누구와 함께 썼나요?</label><div class="check-list">${t.members.map(m=>`<label><input type="checkbox" name="participants" value="${m.id}" ${!old||old.shares.some(s=>s.memberId===m.id)?'checked':''}>${esc(m.name)}</label>`).join('')}</div><p class="help">선택한 멤버끼리 1원 단위까지 균등하게 나눠요.</p>`,data=>{
    const v=Object.fromEntries(data); if(!v.title.trim()) throw Error('지출 이름을 입력해 주세요.'); const expense={id:old?.id||uid(),title:v.title.trim(),amount:amount(v.amount),itemId:v.itemId||null,payerId:v.payerId,shares:splitExpense(v.amount,data.getAll('participants'))};
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id); if(old) trip.expenses[trip.expenses.findIndex(e=>e.id===id)]=expense; else trip.expenses.push(expense);});
  });
}
function confirmAction(title,message,action) { open(title,`<p>${esc(message)}</p>`,()=>update(action)); }
document.addEventListener('click',async e=>{
  try {
  if(e.target.closest('[data-close]')) { if (submitting) return; $('#editor').close(); return; }
  const control=e.target.closest('[data-action]'); if(!control)return;
  const {action,id}=control.dataset; const t=currentTrip();
  if(action==='share-invite') {
    try { await navigator.share({ title: 'MOA 여행 초대', text: '우리의 여행을 함께 기록해요.', url: $('[name="inviteLink"]').value }); }
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
      const joined = await request(`/invites/${encodeURIComponent(value)}/join`, { method: 'POST', data: {} });
      sessions[joined.trip.id] = { token: joined.token }; acceptSnapshot(joined);
      history.replaceState(null, '', `#trip/${joined.trip.id}`); render(); watchTrip();
      toast('여행에 참여했어요. 이제 친구와 함께 기록해요.');
    } catch(error) { control.disabled = false; throw error; }
    return;
  }
  if(action==='create-trip')return tripForm();
  if(action==='demo') { const demo=demoTrip(); if(await update(s=>s.trips.push(demo)))location.hash=`trip/${demo.id}`; return; }
  if(action==='export') { const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='moa-trips.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return; }
  if(!t)return;
  if(action==='invite')return inviteForm(t);
  if(action==='create-item'||action==='edit-item')return itemForm(t,id);
  if(['create-expense','edit-expense','item-expense'].includes(action))return expenseForm(t,action==='edit-expense'?id:null,action==='item-expense'?id:'');
  if(action==='start'||action==='finish')return confirmAction(action==='start'?'여행을 시작할까요?':'여행을 마칠까요?',action==='start'?'즐거운 여행 되세요! 지출을 기록하고 함께 쓴 금액을 확인할 수 있어요.':'여행을 종료해도 일정과 지출은 계속 수정할 수 있어요. 기록을 보며 나눌 금액을 확인해 보세요.',s=>{s.trips.find(x=>x.id===t.id).status=action==='start'?'traveling':'finished';});
  if(action==='delete-item')return confirmAction('이 일정을 삭제할까요?','연결된 지출은 삭제하지 않고 독립된 지출 기록으로 남겨둡니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.items=trip.items.filter(i=>i.id!==id);trip.expenses.forEach(e=>{if(e.itemId===id)e.itemId=null;});});
  if(action==='delete-expense')return confirmAction('이 지출을 삭제할까요?','삭제하면 멤버별 부담 금액도 다시 계산됩니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.expenses=trip.expenses.filter(e=>e.id!==id);});
  if(action==='up'||action==='down')await update(s=>{const trip=s.trips.find(x=>x.id===t.id);const item=trip.items.find(i=>i.id===id);const list=trip.items.filter(i=>i.date===item.date).sort((a,b)=>a.order-b.order);const index=list.findIndex(i=>i.id===id);const other=list[index+(action==='up'?-1:1)];if(other)[item.order,other.order]=[other.order,item.order];});
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
