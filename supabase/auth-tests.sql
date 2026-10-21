-- Disposable local database only; auth.uid() comes from the test JWT fixture.
begin;
insert into auth.users(id) values
 ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),
 ('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004');
set local role authenticated;
do $$
declare
  owner_uid text:='00000000-0000-0000-0000-000000000001';
  friend_uid text:='00000000-0000-0000-0000-000000000002';
  other_uid text:='00000000-0000-0000-0000-000000000003';
  outsider_uid text:='00000000-0000-0000-0000-000000000004';
  t jsonb:='{"id":"personal","title":"계정 여행","destination":"제주","start":"2026-11-01","end":"2026-11-02","status":"planning","members":[{"id":"owner","name":"나"}],"items":[],"expenses":[]}';
  owner jsonb; invitation jsonb; friend jsonb; other jsonb; result jsonb; saved jsonb; legacy jsonb; old_link jsonb;
  room_id uuid; link text; member_id text; friend_id text;
begin
  perform set_config('request.jwt.claims','{}',true);
  assert (public.moa_account_api('list')->>'_status')::int=401,'anonymous users must not load account trips';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid)::text,true);
  assert public.moa_account_api('profile')->'profile'='null'::jsonb,'new users set their own profile';
  assert (public.moa_account_api('create',payload=>jsonb_build_object('trip',t))->>'_status')::int=428,'profile is required';
  result:=public.moa_account_api('save_profile',payload=>'{"name":"지우","avatar":"🌿"}');
  assert result->'profile'->>'name'='지우','own profile saved';
  owner:=public.moa_account_api('create',payload=>jsonb_build_object('trip',t));
  assert owner->>'account'='true' and not(owner ? 'token'),'account trips do not issue browser capabilities';
  room_id:=(owner->'trip'->>'id')::uuid; member_id:=owner->>'memberId';
  assert owner->'trip'->'members'->0->>'name'='지우','owner uses account profile';
  assert jsonb_array_length(public.moa_account_api('list')->'trips')=1,'trip is recoverable by login alone';
  invitation:=public.moa_account_api('invite',trip_id=>room_id);
  link:=invitation->>'inviteToken';
  assert length(link)=64,'common invite is random';
  assert public.moa_account_api('invite',trip_id=>room_id)->>'inviteToken'=link,'same common link across devices';
  perform set_config('request.jwt.claims','{}',true);
  assert public.moa_account_api('preview',invite_token=>link)='{"title":"계정 여행","common":true}'::jsonb,'signed out can preview only the trip title';
  assert (public.moa_account_api('join',invite_token=>link)->>'_status')::int=401,'joining requires a verified account';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',friend_uid)::text,true);
  perform public.moa_account_api('save_profile',payload=>'{"name":"민지","avatar":"🐱"}');
  assert (public.moa_account_api('get',trip_id=>room_id)->>'_status')::int=403,'other accounts cannot guess a trip ID';
  friend:=public.moa_account_api('join',invite_token=>link); friend_id:=friend->>'memberId';
  assert friend_id<>member_id,'each account has its own settlement identity';
  assert jsonb_array_length(friend->'trip'->'members')=2,'friend is added after login';
  assert jsonb_array_length(public.moa_account_api('join',invite_token=>link)->'trip'->'members')=2,'repeat joins and new devices do not duplicate members';
  assert (public.moa_account_api('invite',trip_id=>room_id)->>'_status')::int=403,'friend cannot replace owner invitation';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_uid)::text,true);
  perform public.moa_account_api('save_profile',payload=>'{"name":"민지","avatar":"🐶"}');
  other:=public.moa_account_api('join',invite_token=>link);
  assert other->>'memberId'<>friend_id,'same display names must never merge accounts';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid)::text,true);
  owner:=public.moa_account_api('get',trip_id=>room_id);
  t:=jsonb_set(owner->'trip','{expenses}',jsonb_build_array(jsonb_build_object('id','lunch','title','점심','amount',10001,'payerId',member_id,'itemId',null,
    'shares',jsonb_build_array(jsonb_build_object('memberId',member_id,'amount',5001),jsonb_build_object('memberId',friend_id,'amount',5000)))));
  saved:=public.moa_account_api('update',trip_id=>room_id,payload=>jsonb_build_object('trip',t,'version',owner->'version'));
  assert saved->'trip'->'expenses'=t->'expenses','account expenses save with exact division';
  result:=public.moa_account_api('update',trip_id=>room_id,payload=>jsonb_build_object('trip',owner->'trip','version',owner->'version'));
  assert result->>'_status'='409','account edits still enforce concurrent version checks';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',friend_uid)::text,true);
  assert public.moa_account_api('get',trip_id=>room_id)->'trip'=saved->'trip','friend sees identical expenses';
  perform public.moa_account_api('save_profile',payload=>'{"name":"민지 새이름","avatar":"🐼"}');
  result:=public.moa_account_api('get',trip_id=>room_id);
  assert exists(select 1 from jsonb_array_elements(result->'trip'->'members') where value->>'id'=friend_id and value->>'name'='민지 새이름'),'profile edits preserve the member ID';
  assert result->'trip'->'expenses'=saved->'trip'->'expenses','profile changes do not alter settlement history';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider_uid)::text,true);
  assert jsonb_array_length(public.moa_account_api('list')->'trips')=0,'account isolation holds after switching users';
  perform public.moa_account_api('save_profile',payload=>'{"name":"외부인","avatar":"🐧"}');
  assert public.moa_account_api('get',trip_id=>room_id)->>'_status'='403','outsider remains blocked';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_uid)::text,true);
  t:=jsonb_set(t,'{members}','[{"id":"old-owner","name":"나"},{"id":"old-friend","name":"민지"}]');t:=jsonb_set(t,'{expenses}','[]');
  legacy:=public.moa_api('create',payload=>jsonb_build_object('trip',t));
  old_link:=public.moa_api('invite',trip_id=>(legacy->'trip'->>'id')::uuid,session_token=>legacy->>'token',payload=>'{"memberId":"old-friend"}');
  result:=public.moa_account_api('adopt',trip_id=>(legacy->'trip'->>'id')::uuid,payload=>jsonb_build_object('token',legacy->>'token'));
  assert result->>'memberId'='old-owner','legacy member identity is bound using possession of its capability';
  assert public.moa_api('get',trip_id=>(legacy->'trip'->>'id')::uuid,session_token=>legacy->>'token')->>'_status'='401','old capability is revoked after binding';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',friend_uid)::text,true);
  result:=public.moa_account_api('join',invite_token=>old_link->>'inviteToken');
  assert result->>'memberId'='old-friend','existing individual links can attach to login accounts';
  raise notice 'PASS: authenticated profiles, common links, identity isolation, repeat joins, cross-device restore, version conflicts, legacy migration';
end;
$$;
rollback;
