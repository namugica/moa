import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createMoaServer } from '../server.mjs';
import { newTrip, splitExpense, balances, settlementPlan } from '../model.mjs';

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'moa-test-'));
  let server, base;
  async function start() { server = createMoaServer({ dataDir, allowedOrigins: 'https://namugica.github.io' }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { server.closeSharedStreams(); const closed = new Promise(r => server.close(r)); server.closeAllConnections(); await closed; }
  await start();
  t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (path, { token, method = 'GET', data } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const create = async () => (await call('/api/trips', { method: 'POST', data: { trip: newTrip({ title:'함께 제주', destination:'제주', start:'2026-11-01', end:'2026-11-02', names:'민지', myName:'지우' }) } })).data;
  return { call, create, restart: async () => { await stop(); await start(); }, base: () => base };
}

test('초대 권한·일회용 참여·개인별 정산·동시 수정 충돌을 보장한다', async t => {
  const { call, create } = await fixture(t);
  const owner = await create(), path = `/api/trips/${owner.trip.id}`;
  assert.equal((await call(path)).status, 401);
  const invitation = await call(path+'/invites', { token:owner.token, method:'POST', data:{memberId:owner.trip.members[1].id} });
  assert.equal(invitation.status, 201);
  const invitePath = '/api/invites/'+invitation.data.inviteToken;
  const preview = await call(invitePath);
  assert.deepEqual(preview.data, {title:'함께 제주',memberName:'민지'});
  const [first, second] = await Promise.all([call(invitePath+'/join',{method:'POST',data:{}}),call(invitePath+'/join',{method:'POST',data:{}})]);
  assert.deepEqual([first.status,second.status].sort(),[200,410]);
  const guest = first.status === 200 ? first.data : second.data;
  assert.notEqual(guest.memberId, owner.memberId);
  assert.equal((await call(path+'/invites',{token:guest.token,method:'POST',data:{name:'다른 친구'}})).status,403);
  const shared = (await call(path,{token:owner.token})).data;
  const trip = structuredClone(shared.trip);
  trip.expenses.push({id:crypto.randomUUID(),title:'점심',amount:10001,payerId:owner.memberId,itemId:null,shares:splitExpense(10001,trip.members.map(m=>m.id))});
  const saved = await call(path,{token:owner.token,method:'PATCH',data:{trip,version:shared.version}});
  assert.equal(saved.status,200);
  const seen = (await call(path,{token:guest.token})).data;
  assert.deepEqual(seen.trip,saved.data.trip);
  assert.deepEqual(balances(seen.trip).map(m=>m.balance),[5000,-5000]);
  assert.deepEqual(settlementPlan(seen.trip),[{from:guest.memberId,to:owner.memberId,amount:5000}]);
  const conflict = await call(path,{token:guest.token,method:'PATCH',data:{trip:shared.trip,version:shared.version}});
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.trip.expenses.length,1);
  const tampered = structuredClone(seen.trip); tampered.members[0].name='사칭';
  assert.equal((await call(path,{token:guest.token,method:'PATCH',data:{trip:tampered,version:seen.version}})).status,400);
  tampered.members=seen.trip.members; tampered.expenses[0].shares[0].amount++;
  assert.equal((await call(path,{token:guest.token,method:'PATCH',data:{trip:tampered,version:seen.version}})).status,400);
});

test('초대 재발급, 잘못된 링크, 새 멤버 추가와 서버 재시작 후 저장 복구', async t => {
  const {call,create,restart}=await fixture(t);
  const owner=await create(), path=`/api/trips/${owner.trip.id}`;
  const invite=async data=>(await call(path+'/invites',{token:owner.token,method:'POST',data})).data;
  const old=await invite({memberId:owner.trip.members[1].id});
  const replacement=await invite({memberId:owner.trip.members[1].id});
  assert.equal((await call('/api/invites/'+old.inviteToken)).status,410);
  assert.equal((await call('/api/invites/bad')).status,404);
  const added=await invite({name:'수현'});
  assert.equal(added.trip.members.length,3);
  assert.equal(added.trip.expenses.length,0);
  await restart();
  assert.equal((await call('/api/invites/'+replacement.inviteToken)).status,200);
  const restored=await call(path,{token:owner.token});
  assert.equal(restored.status,200); assert.equal(restored.data.trip.members.length,3);
  for(const privatePath of ['/.moa-data/trips.json','/.git/config','/server.mjs','/tests/server.test.mjs']) assert.equal((await call(privatePath)).status,404);
});

test('다른 브라우저에 SSE 변경을 전달하고 재연결 시 최신 상태를 보낸다', async t => {
  const {call,create,base}=await fixture(t);
  const owner=await create(), path=`/api/trips/${owner.trip.id}`;
  const controller=new AbortController();
  const response=await fetch(base()+path+'/events',{headers:{Authorization:`Bearer ${owner.token}`},signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(), decoder=new TextDecoder();
  const initial=decoder.decode((await reader.read()).value);
  assert.match(initial,/"version":1/); assert.ok(!initial.includes(owner.token));
  const trip=structuredClone(owner.trip);trip.status='traveling';
  assert.equal((await call(path,{token:owner.token,method:'PATCH',data:{trip,version:owner.version}})).status,200);
  const event=decoder.decode((await reader.read()).value);
  assert.match(event,/"status":"traveling"/); assert.match(event,/"version":2/);
  controller.abort();
  const reconnect=new AbortController();
  const latest=await fetch(base()+path+'/events',{headers:{Authorization:`Bearer ${owner.token}`},signal:reconnect.signal});
  assert.match(decoder.decode((await latest.body.getReader().read()).value),/"version":2/);
  reconnect.abort();
});


test('GitHub Pages 출처의 API 사전 요청만 허용하고 잘못된 데이터를 거절한다', async t => {
  const {call,create,base}=await fixture(t);
  for(const [origin,status] of [['https://namugica.github.io',204],['https://untrusted.example',403]]){
    const response=await fetch(base()+'/api/trips',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authorization'}});
    assert.equal(response.status,status);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),status===204?origin:null);
  }
  const owner=await create();
  const bad=structuredClone(owner.trip);bad.members=[null];
  assert.equal((await call('/api/trips',{method:'POST',data:{trip:bad}})).status,400);
  bad.members=owner.trip.members;bad.start='2026-02-31';bad.end='2026-03-05';
  assert.equal((await call('/api/trips',{method:'POST',data:{trip:bad}})).status,400);
});

test('정산 완료는 송금자 본인만 기록·취소할 수 있고 지출 변경 후에는 과거 표시를 적용하지 않는다',async t=>{
  const {call,create}=await fixture(t);
  const owner=await create(),path=`/api/trips/${owner.trip.id}`;
  const invite=(await call(path+'/invites',{token:owner.token,method:'POST',data:{memberId:owner.trip.members[1].id}})).data;
  const guest=(await call('/api/invites/'+invite.inviteToken+'/join',{method:'POST',data:{}})).data;
  let latest=(await call(path,{token:owner.token})).data;
  const trip=structuredClone(latest.trip);trip.expenses=[{id:crypto.randomUUID(),title:'점심',amount:10000,payerId:owner.memberId,itemId:null,shares:splitExpense(10000,trip.members.map(m=>m.id))}];trip.settlementPlanRevision='rev-one';
  latest=(await call(path,{token:owner.token,method:'PATCH',data:{trip,version:latest.version}})).data;
  const marked=structuredClone(latest.trip);marked.settlementRecords=[{planKey:'rev-one',from:guest.memberId,to:owner.memberId,amount:5000,completedBy:guest.memberId,completedAt:'2026-10-22T00:00:00.000Z'}];
  const paid=await call(path,{token:guest.token,method:'PATCH',data:{trip:marked,version:latest.version}});
  assert.equal(paid.status,200);
  const unauthorized=structuredClone(paid.data.trip);unauthorized.settlementRecords=[];
  assert.equal((await call(path,{token:owner.token,method:'PATCH',data:{trip:unauthorized,version:paid.data.version}})).status,403);
  const undone=await call(path,{token:guest.token,method:'PATCH',data:{trip:unauthorized,version:paid.data.version}});
  assert.equal(undone.status,200);
  const markedAgain=structuredClone(undone.data.trip);markedAgain.settlementRecords=[...marked.settlementRecords];
  const confirmed=await call(path,{token:guest.token,method:'PATCH',data:{trip:markedAgain,version:undone.data.version}});
  const changed=structuredClone(confirmed.data.trip);changed.expenses[0].amount=12000;changed.expenses[0].shares=splitExpense(12000,changed.members.map(m=>m.id));changed.settlementPlanRevision='rev-two';
  const revised=await call(path,{token:owner.token,method:'PATCH',data:{trip:changed,version:confirmed.data.version}});
  assert.equal(revised.status,200);
  assert.equal(settlementPlan(revised.data.trip)[0].amount,6000);
  const {settlementProgress}=await import('../model.mjs');
  assert.equal(settlementProgress(revised.data.trip)[0].completed,false);
  assert.equal(revised.data.trip.settlementRecords.length,1,'old marks remain historical data but are not attached to the new plan');
});

test('동시에 두 참여자가 완료 표시를 저장하면 한 변경은 충돌로 반환하고 기록을 덮어쓰지 않는다',async t=>{
  const {call}=await fixture(t);
  const owner=(await call('/api/trips',{method:'POST',data:{trip:newTrip({title:'세 명 여행',destination:'제주',start:'2026-11-01',end:'2026-11-02',names:'민지, 수현'})}})).data;const path=`/api/trips/${owner.trip.id}`;
  const tokens=[];
  for(const member of owner.trip.members.slice(1)){
    const invitation=(await call(path+'/invites',{token:owner.token,method:'POST',data:{memberId:member.id}})).data;
    tokens.push((await call('/api/invites/'+invitation.inviteToken+'/join',{method:'POST',data:{}})).data);
  }
  let current=(await call(path,{token:owner.token})).data;
  const base=structuredClone(current.trip);base.expenses=[{id:crypto.randomUUID(),title:'택시',amount:9000,payerId:base.members[0].id,itemId:null,shares:splitExpense(9000,base.members.map(m=>m.id))}];base.settlementPlanRevision='shared-plan';
  current=(await call(path,{token:owner.token,method:'PATCH',data:{trip:base,version:current.version}})).data;
  const plan=settlementPlan(current.trip);
  assert.equal(plan.length,2);
  const attempts=await Promise.all(tokens.map(token=>{
    const transfer=plan.find(p=>p.from===token.memberId);
    const trip=structuredClone(current.trip);trip.settlementRecords=[{planKey:'shared-plan',...transfer,completedBy:token.memberId,completedAt:'2026-10-22T00:00:00.000Z'}];
    return call(path,{token:token.token,method:'PATCH',data:{trip,version:current.version}});
  }));
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
  const winner=attempts.find(result=>result.status===200).data;
  assert.equal(winner.trip.settlementRecords.length,1);
  assert.equal((await call(path,{token:owner.token})).data.trip.settlementRecords.length,1);
});

