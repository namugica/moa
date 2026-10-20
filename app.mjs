import { STATUS, uid, dayCount, amount, splitExpense, balances, totalCost, plannedCost, newTrip, demoTrip } from './model.mjs';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ko-KR').format(n) + '원';
const date = d => d.replaceAll('-', '.');
const KEY = 'moa.prototype.v1';
let state = { trips: [] }, storageBlocked = false, activeSubmit, toastTimer;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.trips) || parsed.trips.some(t => !STATUS[t.status] || !Array.isArray(t.items) || !Array.isArray(t.expenses) || !Array.isArray(t.members))) throw new Error('Invalid data');
    state = parsed;
  }
} catch { storageBlocked = true; }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500); }
function update(fn) {
  if (storageBlocked) { toast('브라우저 저장소를 사용할 수 없어요. 기존 데이터 보존을 위해 저장을 중단했어요.'); return false; }
  const next = structuredClone(state); fn(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); state = next; render(); return true; }
  catch { toast('저장하지 못했어요. 브라우저 저장 공간과 권한을 확인해 주세요.'); return false; }
}
const tripById = id => state.trips.find(t => t.id === id);
const currentTrip = () => tripById(location.hash.split('/')[1]);
const btn = (action, label, id = '', klass = 'button') => `<button class="${klass}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
function stats(trips) { return `<div class="stats"><div class="stat"><span>함께 쌓은 여행</span><strong>${trips.length}<small>개</small></strong></div><div class="stat"><span>기록한 여행 경비</span><strong>${new Intl.NumberFormat('ko-KR').format(trips.reduce((s,t) => s + totalCost(t),0))}<small>원</small></strong></div><div class="stat"><span>모아둔 일정</span><strong>${trips.reduce((s,t) => s + t.items.length,0)}<small>개</small></strong></div></div>`; }
function cards() { return `<div class="cards">${state.trips.map(t => `<article class="trip-card"><div class="card-art"><span class="badge ${t.status}">${STATUS[t.status]}</span></div><div class="card-content"><small>${esc(t.destination)}${t.demo ? ' · 예시 여행' : ''}</small><h3>${esc(t.title)}</h3><p>${date(t.start)} — ${date(t.end)} · ${dayCount(t.start,t.end)}일</p><div class="card-bottom"><span>${t.members.length}명이 함께하는 여행</span><strong>${t.expenses.length ? money(totalCost(t)) : '여행 살펴보기'} ↗</strong></div></div><a class="card-link" href="#trip/${t.id}" aria-label="${esc(t.title)} 열기"></a></article>`).join('')}<button class="new-card" data-action="create-trip"><span class="plus">+</span><strong>새로운 여행을 모아볼까요?</strong><small>설레는 계획의 시작, 여기서부터</small></button></div>`; }
function home(all = false) { return `<div class="heading-row"><div><h1>${all ? '나의 여행' : '다음 여행도, 함께 모아봐요.'}</h1><p>${all ? '떠나기 전 설렘부터 돌아온 뒤의 기록까지.' : '여행의 설렘은 남기고, 정산의 부담은 덜어내세요.'}</p></div>${btn('create-trip','＋ 여행 만들기')}</div>${!all ? `<section class="hero"><div class="hero-copy"><span class="eyebrow">Less hassle, more journey</span><h2>함께 떠나는 여행,<br>마음까지 가볍게.</h2><p>계획부터 지출 기록까지 한곳에.<br>우리의 여행을 MOA로 시작해요.</p>${btn('create-trip','새로운 여행 시작하기 ↗')}</div><img src="assets/travel.svg" alt="초록색 여행 가방과 바다, 야자수 일러스트"></section>${stats(state.trips)}` : ''}<section><div class="section-title"><h2>나의 여행 <span>${state.trips.length.toString().padStart(2,'0')}</span></h2>${!state.trips.length ? btn('demo','예시 여행 살펴보기','','button ghost') : '<span class="muted">계획하고, 기록하고, 모으다</span>'}</div>${cards()}</section><div class="note-strip"><b>✧ MOA의 약속</b><span>누가, 어디서, 얼마를 썼는지. 여행의 모든 지출을 투명하게 기록해요.</span></div>`; }
function itemView(t, item, index, length) {
  const spent = t.expenses.filter(e => e.itemId === item.id).reduce((s,e) => s+e.amount,0);
  return `<article class="timeline-item"><div class="item-top"><div><span class="time">${esc(item.time || '시간 미정')} · ${esc(item.category)}</span><h3>${esc(item.place)}</h3></div><div class="item-controls">${index ? btn('up','↑',item.id,'icon-button') : ''}${index < length-1 ? btn('down','↓',item.id,'icon-button') : ''}${btn('edit-item','수정',item.id,'icon-button')}${btn('delete-item','삭제',item.id,'icon-button')}</div></div>${item.note ? `<p>${esc(item.note)}</p>` : ''}<div class="cost-line"><span>예상 ${money(item.estimate)}</span>${spent ? `<b>실제 ${money(spent)}</b>` : ''}</div>${t.status !== 'planning' ? btn('item-expense','＋ 이 일정 지출 기록',item.id,'button ghost') : ''}</article>`;
}
function tripView(t) {
  const days = [...new Set(t.items.map(i=>i.date))].sort();
  return `<a class="back" href="#trips">← 나의 여행으로</a><section class="trip-head"><span class="badge ${t.status}">${STATUS[t.status]}${t.demo ? ' · 예시 데이터' : ''}</span><div class="heading-row"><div><h1>${esc(t.title)}</h1><p>${esc(t.destination)} &nbsp; ${date(t.start)} — ${date(t.end)}</p></div><div class="actions">${t.status === 'planning' ? btn('start','여행 시작하기 ↗') : t.status === 'traveling' ? btn('finish','여행 종료하기') : '<span class="muted">잘 다녀왔어요. 기록을 정리해 볼까요?</span>'}</div></div><div class="members">${t.members.map(m=>`<span class="member">${esc(m.name)}</span>`).join('')}<span class="help">${t.members.length}명이 함께해요</span></div></section><div class="detail-grid"><div><section class="panel"><div class="section-title"><h2>우리의 여행 타임라인</h2>${btn('create-item','＋ 일정 추가','','button ghost')}</div>${days.length ? days.map(d=> { const list = t.items.filter(i=>i.date===d).sort((a,b)=>a.order-b.order); return `<div class="day-label"><strong>DAY ${dayCount(t.start,d)}</strong>${date(d)}</div>${list.map((i,index)=>itemView(t,i,index,list.length)).join('')}`; }).join('') : '<div class="empty">아직 모아둔 일정이 없어요.<br>첫 번째 가고 싶은 곳을 추가해 보세요.</div>'}</section><section class="panel"><div class="section-title"><h2>함께 쓴 여행 경비</h2>${btn('create-expense','＋ 지출 기록','','button ghost')}</div>${t.expenses.length ? t.expenses.map(e=>`<article class="expense-row"><div class="item-top"><strong>${esc(e.title)}</strong><span>${money(e.amount)} ${btn('edit-expense','수정',e.id,'icon-button')}${btn('delete-expense','삭제',e.id,'icon-button')}</span></div><small>${esc(t.members.find(m=>m.id===e.payerId)?.name)} 결제 · ${e.shares.map(s=>esc(t.members.find(m=>m.id===s.memberId)?.name)).join(', ')} 함께 사용${e.itemId ? ' · '+esc(t.items.find(i=>i.id===e.itemId)?.place) : ''}</small></article>`).join('') : '<p class="empty">갑자기 탄 택시도, 함께 먹은 점심도.<br>작은 지출부터 모아보세요.</p>'}</section></div><aside class="summary-panel"><section class="panel"><span class="eyebrow">Our travel wallet</span><h2 style="margin-top:12px">지금까지 모은 경비</h2><div class="summary-total">${money(totalCost(t))}</div><div class="summary-row"><span class="muted">예상 일정 비용</span><strong>${money(plannedCost(t))}</strong></div><div class="summary-row"><span class="muted">지출 기록</span><strong>${t.expenses.length}건</strong></div>${btn('create-expense','＋ 지출 기록하기','','button full')}<p class="help">모든 금액은 원화(KRW) 기준입니다.<br>실제 지출이 예상 비용을 자동으로 대체하지 않아요.</p></section><section class="panel"><h3>투명한 나눔</h3><p class="help">지출별 참여자끼리 나눈 예상 정산 내역이에요. 실제 송금이나 공동 접속 기능은 포함되지 않습니다.</p>${balances(t).map(m=>`<details class="balance"><summary>${esc(m.name)}<strong>${m.balance>0?'받을 돈':m.balance<0?'보낼 돈':'정산 균형'} ${money(Math.abs(m.balance))}</strong></summary><p>대신 결제 ${money(m.paid)}<br>나의 부담 ${money(m.share)}</p>${t.expenses.filter(e=>e.shares.some(s=>s.memberId===m.id)).map(e=>`<div class="summary-row"><span>${esc(e.title)}</span><span>${money(e.shares.find(s=>s.memberId===m.id).amount)}</span></div>`).join('')}</details>`).join('')}<p class="help">나누어떨어지지 않는 1원은 선택한 멤버 순서대로 배분해요.</p></section></aside></div>`;
}
function guide() { return `<div class="heading-row"><div><h1>가벼운 여행을 위한 MOA 가이드</h1><p>우리가 함께 모으는 것은 경비 그 이상의 순간이에요.</p></div></div><div class="guide-grid">${[['01 · 계획을 모아요','여행을 만들고 함께 갈 사람의 이름을 입력해요. 일정을 추가하고 위아래 화살표로 같은 날짜 안의 순서를 바꿀 수 있어요.'],['02 · 순간을 기록해요','여행 시작 버튼을 누르고 실제 지출을 기록해요. 결제한 사람과 함께 쓴 사람을 각각 선택할 수 있어요.'],['03 · 투명하게 나눠요','각자의 부담액과 대신 결제한 돈을 비교해요. 투명한 나눔에서 이름을 누르면 계산 과정을 확인할 수 있어요.'],['현재는 개인 프로토타입이에요','원화·균등 분할을 지원하며 데이터는 이 브라우저에만 저장돼요. 코스 공개·검색, 초대 및 공동 편집, 푸시 알림, 실제 송금은 후속 개발 범위예요.']].map(([h,p])=>`<section class="panel"><h2>${h}</h2><p>${p}</p></section>`).join('')}</div><section class="panel"><h2>내 기록 보관하기</h2><p class="help">브라우저 데이터를 삭제하면 여행 기록도 사라집니다. 필요할 때 JSON 파일로 내려받아 보관하세요. 현재 버전은 가져오기를 지원하지 않아요.</p>${btn('export','여행 데이터 내보내기','','button secondary')}</section>`; }
function render() {
  const route = location.hash.slice(1).split('/')[0] || 'home';
  document.querySelectorAll('[data-nav]').forEach(a=>{ const active = a.dataset.nav === (route==='trip'?'trips':route); a.classList.toggle('active',active); if(active) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = route==='trip'?'나의 여행 / 타임라인':route==='guide'?'MOA 사용 가이드':'나의 여행 대시보드';
  const t = currentTrip();
  $('#main').innerHTML = (storageBlocked?'<div class="warning">저장된 데이터를 읽을 수 없어요. 기존 기록 보호를 위해 변경을 중단했습니다. 브라우저 저장소 설정을 확인해 주세요.</div>':'') + (route==='trip' ? (t?tripView(t):'<div class="empty">이 여행을 찾을 수 없어요.<br><a href="#home">홈으로 돌아가기</a></div>') : route==='guide'?guide():home(route==='trips'));
}
function open(title, fields, submit) { $('#dialog-title').textContent=title; $('#dialog-fields').innerHTML=fields; $('#form-error').textContent=''; activeSubmit=submit; $('#editor').showModal(); }
function input(label,name,value='',type='text',extra='') { return `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`; }
function tripForm() { open('새로운 여행 시작하기', `${input('여행 이름','title','','text','required maxlength="80" placeholder="예: 우리의 느긋한 제주"')}${input('여행지','destination','','text','required maxlength="80" placeholder="예: 제주, 대한민국"')}<div class="field-row"><div>${input('시작일','start','','date','required')}</div><div>${input('종료일','end','','date','required')}</div></div>${input('함께 가는 사람 (선택)','names','','text','maxlength="400" placeholder="민지, 수현 — 쉼표로 구분해 주세요"')}<p class="help">나는 자동으로 포함됩니다. 이름은 중복 없이 입력해 주세요.</p>`, data=>{ const t=newTrip(Object.fromEntries(data)); if(update(s=>s.trips.push(t))){location.hash=`trip/${t.id}`; return true;} }); }
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
  open(old?'지출 수정하기':'함께 쓴 지출 기록하기',`${input('지출 이름','title',old?.title||t.items.find(i=>i.id===itemId)?.place||'','text','required maxlength="100"')}${input('실제 금액 (원)','amount',old?.amount??'','number','required min="0" max="1000000000" step="1"')}<label for="f-itemId">연결할 일정 (선택)</label><select id="f-itemId" name="itemId"><option value="">일정과 관계없는 지출</option>${t.items.map(i=>`<option value="${i.id}" ${(old?.itemId||itemId)===i.id?'selected':''}>${esc(i.place)} · ${date(i.date)}</option>`).join('')}</select><label for="f-payerId">누가 결제했나요?</label><select id="f-payerId" name="payerId">${t.members.map(m=>`<option value="${m.id}" ${old?.payerId===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select><label>누구와 함께 썼나요?</label><div class="check-list">${t.members.map(m=>`<label><input type="checkbox" name="participants" value="${m.id}" ${!old||old.shares.some(s=>s.memberId===m.id)?'checked':''}>${esc(m.name)}</label>`).join('')}</div><p class="help">선택한 멤버끼리 1원 단위까지 균등하게 나눠요.</p>`,data=>{
    const v=Object.fromEntries(data); if(!v.title.trim()) throw Error('지출 이름을 입력해 주세요.'); const expense={id:old?.id||uid(),title:v.title.trim(),amount:amount(v.amount),itemId:v.itemId||null,payerId:v.payerId,shares:splitExpense(v.amount,data.getAll('participants'))};
    return update(s=>{const trip=s.trips.find(x=>x.id===t.id); if(old) trip.expenses[trip.expenses.findIndex(e=>e.id===id)]=expense; else trip.expenses.push(expense);});
  });
}
function confirmAction(title,message,action) { open(title,`<p>${esc(message)}</p>`,()=>update(action)); }
document.addEventListener('click',e=>{
  if(e.target.closest('[data-close]')) { $('#editor').close(); return; }
  const control=e.target.closest('[data-action]'); if(!control)return;
  const {action,id}=control.dataset; const t=currentTrip();
  if(action==='create-trip')return tripForm();
  if(action==='demo') { const demo=demoTrip(); if(update(s=>s.trips.push(demo)))location.hash=`trip/${demo.id}`; return; }
  if(action==='export') { const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='moa-trips.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return; }
  if(!t)return;
  if(action==='create-item'||action==='edit-item')return itemForm(t,id);
  if(['create-expense','edit-expense','item-expense'].includes(action))return expenseForm(t,action==='edit-expense'?id:null,action==='item-expense'?id:'');
  if(action==='start'||action==='finish')return confirmAction(action==='start'?'여행을 시작할까요?':'여행을 마칠까요?',action==='start'?'즐거운 여행 되세요! 지출을 기록하고 함께 쓴 금액을 확인할 수 있어요.':'여행을 종료해도 일정과 지출은 계속 수정할 수 있어요. 기록을 보며 나눌 금액을 확인해 보세요.',s=>{s.trips.find(x=>x.id===t.id).status=action==='start'?'traveling':'finished';});
  if(action==='delete-item')return confirmAction('이 일정을 삭제할까요?','연결된 지출은 삭제하지 않고 독립된 지출 기록으로 남겨둡니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.items=trip.items.filter(i=>i.id!==id);trip.expenses.forEach(e=>{if(e.itemId===id)e.itemId=null;});});
  if(action==='delete-expense')return confirmAction('이 지출을 삭제할까요?','삭제하면 멤버별 부담 금액도 다시 계산됩니다.',s=>{const trip=s.trips.find(x=>x.id===t.id);trip.expenses=trip.expenses.filter(e=>e.id!==id);});
  if(action==='up'||action==='down')update(s=>{const trip=s.trips.find(x=>x.id===t.id);const item=trip.items.find(i=>i.id===id);const list=trip.items.filter(i=>i.date===item.date).sort((a,b)=>a.order-b.order);const index=list.findIndex(i=>i.id===id);const other=list[index+(action==='up'?-1:1)];if(other)[item.order,other.order]=[other.order,item.order];});
});
$('#editor-form').addEventListener('submit',e=>{e.preventDefault();try{if(activeSubmit(new FormData(e.target))){$('#editor').close();toast('여행에 잘 모아두었어요.');}}catch(error){$('#form-error').textContent=error.message;}});
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
window.addEventListener('storage',e=>{if(e.key===KEY){$('#editor').close();try{const next=JSON.parse(e.newValue);if(!Array.isArray(next?.trips))throw Error();state=next;storageBlocked=false;render();toast('다른 탭의 변경 내용을 반영했어요.');}catch{storageBlocked=true;render();}}});
render();
