import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuth } from '../auth.mjs';
const memory=()=>{const entries=new Map();return {getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k),entries};};
const response=(data,status=200)=>new Response(status===204?null:JSON.stringify(data),{status});
const user={id:'user-1',user_metadata:{full_name:'지우'}};
const tokens={access_token:'access-test',refresh_token:'refresh-test',expires_in:3600,user};
function fixture(fetcher){
 const storage=memory(),transientStorage=memory(),location={href:'https://namugica.github.io/moa/#invite/friend-link',hash:'#invite/friend-link'},navigations=[];
 let time=1000000;
 const options={url:'https://example.supabase.co',publishableKey:'sb_publishable_test',storage,transientStorage,location,now:()=>time,navigate:url=>navigations.push(url),replaceUrl:url=>{location.href=url;location.hash=new URL(url).hash;},fetcher};
 return {options,storage,transientStorage,location,navigations,auth:createAuth(options),advance:ms=>{time+=ms;}};
}

test('구글·카카오 OAuth는 PKCE를 사용하고 초대 화면으로 돌아온다',async()=>{
 for(const provider of ['google','kakao']){
  const calls=[];
  const f=fixture(async(url,options)=>{calls.push({url,options});return response(url.endsWith('/settings')?{external:{google:true,kakao:true}}:url.includes('/token?')?tokens:user);});
  await f.auth.signIn(provider);
  const destination=new URL(f.navigations[0]);
  assert.equal(destination.searchParams.get('provider'),provider);
  assert.equal(destination.searchParams.get('redirect_to'),'https://namugica.github.io/moa/');
  const pending=JSON.parse([...f.transientStorage.entries.values()][0]);
  assert.equal(destination.searchParams.get('code_challenge'),createHash('sha256').update(pending.verifier).digest('base64url'));
  assert.ok(pending.verifier.length>=43);
  f.location.href='https://namugica.github.io/moa/?code=one-time-code';f.location.hash='';
  const reloaded=createAuth(f.options);await reloaded.initialize();
  assert.equal(reloaded.getUser().id,user.id);
  assert.equal(f.location.href,'https://namugica.github.io/moa/#invite/friend-link');
  assert.equal(f.transientStorage.entries.size,0);
  const exchange=calls.find(c=>c.url.includes('grant_type=pkce'));
  assert.deepEqual(JSON.parse(exchange.options.body),{auth_code:'one-time-code',code_verifier:pending.verifier});
  assert.equal(exchange.options.headers.Authorization,undefined,'public key must not be treated as a JWT');
 }
});

test('저장한 로그인 요청이 없는 콜백과 취소된 로그인을 처리한다',async()=>{
 let calls=0;
 const f=fixture(async()=>{calls++;return response(tokens);});
 f.location.href='https://namugica.github.io/moa/?code=unsolicited';
 await assert.rejects(f.auth.initialize(),/만료/);
 assert.equal(calls,0);assert.ok(!f.location.href.includes('code='));
 f.location.href='https://namugica.github.io/moa/?error=access_denied&error_description=sensitive';
 await assert.rejects(f.auth.initialize(),/취소/);
 assert.ok(!f.location.href.includes('error'));
});

test('만료된 토큰은 중복 없이 갱신하고 같은 계정의 여행 상태를 초기화하지 않는다',async()=>{
 let refreshes=0,changes=0;
 const f=fixture(async(url)=>{if(url.includes('refresh_token')){refreshes++;return response(tokens);}return response(user);});
 f.storage.setItem(f.auth.storageKey,JSON.stringify({...tokens,expires_at:0}));
 f.auth.onChange(()=>changes++);
 await f.auth.initialize();assert.equal(refreshes,1);
 const initialChanges=changes;
 f.advance(3600000);
 assert.deepEqual(await Promise.all([f.auth.getAccessToken(),f.auth.getAccessToken(),f.auth.getAccessToken()]),['access-test','access-test','access-test']);
 assert.equal(refreshes,2);assert.equal(changes,initialChanges);
});

test('로그아웃 중 완료된 토큰 갱신이 계정을 다시 로그인시키지 않는다',async()=>{
 let finishRefresh,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 const f=fixture(async(url)=>{
  if(url.includes('refresh_token'))return new Promise(resolve=>{finishRefresh=()=>resolve(response(tokens));started();});
  if(url.includes('/logout'))return response(null,204);
  return response(user);
 });
 f.storage.setItem(f.auth.storageKey,JSON.stringify({...tokens,expires_at:99999}));
 await f.auth.initialize();f.advance(100000000);
 const pending=f.auth.getAccessToken();await waiting;
 await f.auth.signOut();finishRefresh();
 await assert.rejects(pending,/상태가 변경/);
 assert.equal(f.auth.getUser(),null);assert.equal(f.storage.getItem(f.auth.storageKey),null);
});

test('아직 설정되지 않은 소셜 로그인은 이동하지 않고 안내한다',async()=>{
 const f=fixture(async()=>response({external:{google:false,kakao:false}}));
 for(const provider of ['google','kakao'])await assert.rejects(f.auth.signIn(provider),/아직 준비/);
 assert.equal(f.navigations.length,0);assert.equal(f.transientStorage.entries.size,0);
});
