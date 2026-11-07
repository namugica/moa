import { auth } from './account.mjs';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.mjs';
import { financeTotals } from './finance-model.mjs';
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => new Intl.NumberFormat('ko-KR').format(n)+'원';
const labels = {submitted:'검토 대기',approved:'승인',changes:'보완 요청',rejected:'반려'};
const button = (action,text,id='') => `<button type="button" class="button secondary compact" data-finance="${action}" data-id="${esc(id)}">${text}</button>`;
async function api(room,action,payload={}) {
  const token = await auth?.getAccessToken();
  if (!token) throw Error('로그인한 뒤 이용해 주세요.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/moa_finance_api`,{method:'POST',headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({trip_id:room,action,payload})});
  const result = await response.json();
  if(result.code==='PGRST202') throw Error('공동 자금 기능을 준비하려면 Supabase에서 supabase/finance.sql을 적용해 주세요.');
  if(!response.ok || result._status) throw Error(result.error || '요청을 처리하지 못했어요. 연결과 설정을 확인해 주세요.');
  return result;
}
export function mountFinance(root,trip,account) {
  if(!root) return;
  if(!account) {root.innerHTML='<section class="panel"><h2>지출 제출과 공동 자금</h2><p class="help">로그인하고 계정에 연결된 장부에서 영수증 제출·검토·지급을 함께 관리하세요. 기존 개인 간 정산은 그대로 사용할 수 있어요.</p></section>';return;}
  let data, busy=false, timer, loadVersion=0;
  const person = id => trip.members.find(m=>m.id===id)?.name || '참여자';
  const showError = message => {const target=root.querySelector('[data-finance-error]');if(target)target.textContent=message;};
  const initial = '<section class="panel"><h2>지출·공동 자금</h2><p data-finance-error role="alert"></p><p role="status">내역을 불러오고 있어요…</p>'+button('refresh','다시 불러오기')+'</section>';
  root.innerHTML=initial;
  async function refresh() {
    if(!root.isConnected || busy || root.querySelector('dialog[open]'))return;
    const version=++loadVersion;
    try { const next=await api(trip.id,'list');if(!root.isConnected || busy || root.querySelector('dialog[open]') || version!==loadVersion)return;data=next;draw(); }
    catch(e){if(root.isConnected)showError(e.message);}
  }
  function draw(){
    const totals=financeTotals(data.entries,data.cash,data.memberId);
    root.innerHTML=`<section class="panel"><div class="section-title"><div><span class="eyebrow">MOA · 함께 관리하는 돈</span><h2>지출·공동 자금</h2></div>${button('refresh','새로고침')}</div><p class="help">개인 간 정산과 별도로 관리해요. 관리자: ${esc(person(trip.members[0].id))}</p><div class="finance-summary"><div><small>내가 돌려받을 금액</small><strong>${money(totals.myPending)}</strong></div>${data.manager?`<div><small>공동 자금 잔액</small><strong>${money(totals.balance)}</strong></div><div><small>전체 지급 대기</small><strong>${money(totals.pending)}</strong></div><div><small>승인된 지출 / 검토 대기</small><strong>${money(totals.cost)} / ${totals.review}건</strong></div>`:''}</div><div class="actions">${button('submit','＋ 지출 제출')}${data.manager?button('cash','＋ 입출금 기록'):''}</div><p data-finance-error class="form-error" role="alert"></p><h3>${data.manager?'제출 검토함':'내 제출 내역'}</h3>${data.entries.length?data.entries.map(e=>{
      const paid=data.cash.some(c=>c.entry_id===e.id);
      const duplicate=data.entries.some(other=>other.id!==e.id && other.title===e.title && other.amount===e.amount && other.spent_on===e.spent_on && other.status!=='rejected');
      return `<article class="finance-entry"><div class="section-title"><strong>${esc(e.title)} · ${money(e.amount)}</strong><span class="status-pill">${labels[e.status]}${paid?' · 지급 완료':''}</span></div><p>${esc(person(e.member_id))} · ${esc(e.spent_on)} · ${e.payment==='personal'?'개인 돈으로 결제':'공동 자금으로 결제'}${e.event?' · '+esc(e.event):''}</p><p>${esc(e.purpose)}</p>${e.note?`<p class="warning">${esc(e.note)}</p>`:''}${duplicate?'<p class="warning">날짜·금액·이름이 같은 지출이 있어요. 중복인지 확인해 주세요.</p>':''}${e.has_receipt?button('receipt','영수증 보기',e.id):`<p class="help">미첨부 사유: ${esc(e.missing_reason)}</p>`}<div class="actions">${e.member_id===data.memberId && ['submitted','changes'].includes(e.status)?button('edit','수정·다시 제출',e.id):''}${data.manager && e.status==='submitted'?button('review','검토하기',e.id):''}${data.manager && e.status==='approved' && e.payment==='personal' && !paid?button('pay','지급 완료 기록',e.id):''}</div></article>`;
    }).join(''):'<p class="help">아직 제출된 지출이 없어요. 영수증과 사용 내역을 함께 남겨 주세요.</p>'}${data.manager?`<h3>공동 자금 입출금</h3><p class="help">공동 자금으로 결제한 승인 지출은 잔액에 자동 반영돼요. 같은 지출을 출금으로 다시 기록하지 마세요. 잔액은 입력 기록 기준이며 은행과 자동 연결되지 않아요.</p>${data.cash.map(c=>`<div class="summary-row"><span>${esc(c.title)} · ${{income:'입금',outflow:'기타 출금',reimbursement:'개인 지출 환급'}[c.kind]}</span><strong>${c.kind==='income'?'+':'−'}${money(c.amount)}</strong></div>`).join('')}`:''}<details><summary>처리 이력</summary>${data.history.map(h=>`<p class="help">${esc(new Date(h.created_at).toLocaleString('ko-KR'))} · ${esc(person(h.actor))} · ${esc(({submitted:'제출',approved:'승인',changes:'보완 요청',rejected:'반려',paid:'지급 완료',cash:'입출금 기록'})[h.action])} ${esc(h.note)}</p>`).join('')}</details></section>`;
  }
  const field=(label,name,value='',extra='')=>`<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
  function dialog(title,content,save){
    const d=document.createElement('dialog');d.className='finance-dialog';
    d.innerHTML=`<form><h2>${title}</h2>${content}<p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="button secondary" data-dismiss>닫기</button>${save?'<button class="button" type="submit">저장하기</button>':''}</div></form>`;
    root.append(d);d.showModal();
    const close=()=>{if(!busy){d.close();d.remove();}};
    d.querySelector('[data-dismiss]').onclick=close;
    d.addEventListener('cancel',e=>{e.preventDefault();close();});
    d.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(!save||busy)return;
      busy=true;d.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{await save(new FormData(event.target));d.close();d.remove();busy=false;await refresh();}
      catch(e){d.querySelector('[role="alert"]').textContent=e.message;}
      finally{busy=false;d.querySelectorAll('button').forEach(b=>b.disabled=false);}
    };
  }
  root.addEventListener('click',async event=>{
    const b=event.target.closest('[data-finance]');if(!b||busy)return;
    const action=b.dataset.finance,entry=data?.entries.find(e=>e.id===b.dataset.id);
    try{
      if(action==='refresh')return await refresh();
      if(!data)return;
      if(action==='submit'||action==='edit'){
        const e=entry||{};
        dialog(entry?'지출 수정·다시 제출':'지출 제출',field('지출 이름','title',e.title,'required maxlength="100"')+field('금액 (원)','amount',e.amount,'type="number" min="1" max="1000000000" step="1" required')+field('사용 날짜','spent_on',e.spent_on||new Date().toLocaleDateString('sv-SE'),'type="date" required')+field('행사·분류 (선택)','event',e.event,'maxlength="100"')+field('사용 목적','purpose',e.purpose,'required maxlength="500"')+`<label>결제 방식<select name="payment"><option value="personal" ${e.payment==='personal'?'selected':''}>개인 돈으로 결제 · 환급 대상</option><option value="fund" ${e.payment==='fund'?'selected':''}>공동 자금으로 결제</option></select></label><label>영수증 사진 (선택)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label><p class="help">JPG·PNG·WebP, 최대 1.5MB. ${e.has_receipt?'새 사진을 선택하지 않으면 기존 영수증을 유지해요.':''} 자동 인식 없이 내용을 직접 입력해 주세요.</p>`+field('영수증 미첨부 사유','missing_reason',e.missing_reason,'maxlength="500"'),async form=>{
          const payload=Object.fromEntries([...form].filter(([k])=>k!=='photo'));payload.amount=Number(payload.amount);
          if(entry)Object.assign(payload,{id:e.id,revision:e.revision});
          const file=form.get('photo');
          if(file?.size){
            if(file.size>1572864||!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('1.5MB 이하 JPG·PNG·WebP 사진을 선택해 주세요.');
            payload.receipt=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('사진을 읽지 못했어요.'));reader.readAsDataURL(file);});
          }
          await api(trip.id,'submit',payload);
        });
      }
      if(action==='review')dialog('지출 검토',`<p>${esc(entry.title)} · ${money(entry.amount)}</p><label>처리<select name="status"><option value="approved">승인</option><option value="changes">보완 요청</option><option value="rejected">반려</option></select></label>`+field('사유 (보완·반려 시 필수)','note','','maxlength="500"'),form=>api(trip.id,'review',{...Object.fromEntries(form),id:entry.id,revision:entry.revision}));
      if(action==='pay')dialog('지급 완료 기록',`<p>${esc(person(entry.member_id))}님에게 ${money(entry.amount)}을 실제로 지급했나요?</p><p class="help">이 기능은 이체하지 않으며, 지급 사실만 기록해요.</p>`,()=>api(trip.id,'pay',{id:entry.id}));
      if(action==='cash')dialog('공동 자금 입출금',`<label>유형<select name="kind"><option value="income">입금</option><option value="outflow">기타 출금</option></select></label>`+field('내용','title','','required maxlength="100"')+field('금액 (원)','amount','','type="number" min="1" max="1000000000" step="1" required')+'<p class="help">승인 지출과 개인 환급은 자동 반영되므로 여기에 중복 입력하지 마세요.</p>',form=>api(trip.id,'cash',{...Object.fromEntries(form),amount:Number(form.get('amount'))}));
      if(action==='receipt'){
        b.disabled=true;
        const result=await api(trip.id,'receipt',{id:entry.id});
        if(root.isConnected && /^data:image\/(jpeg|png|webp);base64,/.test(result.receipt||''))dialog('영수증',`<img class="finance-receipt" src="${esc(result.receipt)}" alt="제출한 영수증">`);
      }
    }catch(e){showError(e.message);}finally{b.disabled=false;}
  });
  refresh();
  timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return;}if(!document.hidden)refresh();},10000);
}
