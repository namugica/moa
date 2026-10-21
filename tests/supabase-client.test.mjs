import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseTransport } from '../supabase-client.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {'Content-Type':'application/json'} });

test('Supabase RPC 요청에서 공개 키와 멤버 세션을 구분하고 여행·초대 작업을 전달한다', async () => {
  const calls=[];
  const transport=createSupabaseTransport({url:'https://example.supabase.co/',publishableKey:'sb_publishable_test',fetcher:async(url,options)=>{calls.push({url,...options,body:JSON.parse(options.body)});return response({ok:true});}});
  await transport.request('/trips',{method:'POST',data:{trip:{title:'서울'}}});
  await transport.request('/trips/trip-1',{token:'member-session'});
  await transport.request('/trips/trip-1',{token:'member-session',method:'PATCH',data:{version:2,trip:{title:'제주'}}});
  await transport.request('/trips/trip-1/invites',{token:'member-session',method:'POST',data:{memberId:'friend'}});
  await transport.request('/invites/invite-token');
  await transport.request('/invites/invite-token/join',{method:'POST',data:{}});
  assert.deepEqual(calls.map(c=>c.body.action),['create','get','update','invite','preview','join']);
  for(const call of calls){
    assert.equal(call.url,'https://example.supabase.co/rest/v1/rpc/moa_api');
    assert.equal(call.headers.apikey,'sb_publishable_test');
    assert.equal(call.headers.Authorization,undefined,'publishable keys are not bearer JWTs');
    assert.ok(!call.url.includes('member-session'),'session must not go into URLs');
  }
  assert.equal(calls[1].body.session_token,'member-session');
  assert.equal(calls[2].body.payload.version,2);
  assert.equal(calls[3].body.payload.memberId,'friend');
  assert.equal(calls[5].body.invite_token,'invite-token');
});

test('데이터 충돌은 최신 내용을 전달하고 초기 SQL 미설정은 실행할 파일을 안내한다', async () => {
  const snapshot={_status:409,error:'친구가 먼저 변경했어요.',trip:{id:'trip-1'},version:4};
  const transport=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'public',fetcher:async()=>response(snapshot)});
  await assert.rejects(transport.request('/trips/trip-1',{method:'PATCH'}),error=>error.status===409&&error.snapshot.version===4);
  const missing=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'public',fetcher:async()=>response({code:'PGRST202'},404)});
  await assert.rejects(missing.request('/trips/trip-1'),/supabase\/setup.sql/);
});

test('자동 동기화는 연결 실패 후 회복하고 권한 거절 시 재시도를 멈춘다', async () => {
  let calls=0, stop;
  const statuses=[], versions=[];
  const complete=new Promise(resolve=>{
    const transport=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'public',intervalMs:5,fetcher:async()=>{
      calls++;
      if(calls===1)throw new TypeError('offline');
      if(calls===2)return response({trip:{id:'trip-1'},version:2});
      return response({_status:401,error:'권한 없음'});
    }});
    stop=transport.subscribe('trip-1','member-token',data=>versions.push(data.version),status=>{statuses.push(status);if(status==='unauthorized')resolve();});
  });
  await complete;
  assert.deepEqual(statuses,['reconnecting','connected','unauthorized']);
  assert.deepEqual(versions,[2]);assert.equal(calls,3);stop();
});

test('페이지 이동으로 취소한 요청은 나중에 완료되어도 화면을 갱신하지 않는다', async () => {
  let resolveFetch, started;
  const fetched=new Promise(resolve=>{started=resolve;});
  const updated=[];
  const transport=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'public',fetcher:()=>new Promise(resolve=>{resolveFetch=resolve;started();})});
  const stop=transport.subscribe('trip-1','member-token',data=>updated.push(data),status=>updated.push(status));
  await fetched;stop();resolveFetch(response({trip:{id:'trip-1'},version:1}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(updated,[]);
});

test('계정 API는 검증할 JWT를 헤더로 보내고 계정용 RPC로 요청한다',async()=>{
 const calls=[];
 const transport=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'sb_publishable_test',getAccessToken:async()=>'user-jwt',fetcher:async(url,options)=>{calls.push({url,...options,body:JSON.parse(options.body)});return response({ok:true});}});
 await transport.request('/account/profile');
 await transport.request('/account/trips');
 await transport.request('/account/trips/room-1/invites',{method:'POST'});
 await transport.request('/account/adopt',{method:'POST',data:{tripId:'room-1',token:'old-member-capability'}});
 assert.deepEqual(calls.map(c=>c.body.action),['profile','list','invite','adopt']);
 for(const call of calls){assert.ok(call.url.endsWith('/moa_account_api'));assert.equal(call.headers.Authorization,'Bearer user-jwt');assert.equal(call.headers.apikey,'sb_publishable_test');}
 assert.equal(calls[3].body.payload.token,'old-member-capability');
 assert.equal(calls[3].body.trip_id,'room-1');
});

test('공통 초대 미리보기만 비로그인 상태로 가능하고 계정 요청은 로그인 필요',async()=>{
 let calls=0;
 const transport=createSupabaseTransport({url:'https://example.supabase.co',publishableKey:'public',fetcher:async()=>{calls++;return response({title:'여행',common:true});}});
 assert.equal((await transport.request('/account/invites/common-token')).common,true);
 await assert.rejects(transport.request('/account/trips'),error=>error.status===401);
 assert.equal(calls,1);
});
