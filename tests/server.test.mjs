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
