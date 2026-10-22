-- Run AFTER setup.sql. Adds login accounts and one reusable link per trip.
-- Existing trips and individual invitations are preserved.
begin;
create table if not exists moa_private.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  avatar text not null default '🌿' check (avatar in ('🌿','🐻','🐱','🐶','🐰','🦊','🐼','🐧'))
);
create table if not exists moa_private.memberships (
  room_id uuid not null references moa_private.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id text not null,
  primary key(room_id,user_id), unique(room_id,member_id)
);
create index if not exists moa_membership_user on moa_private.memberships(user_id);
create table if not exists moa_private.common_invites (
  room_id uuid primary key references moa_private.rooms(id) on delete cascade,
  token text not null,
  token_hash text not null unique,
  expires_at bigint not null
);
alter table moa_private.profiles enable row level security;
alter table moa_private.memberships enable row level security;
alter table moa_private.common_invites enable row level security;
revoke all on all tables in schema moa_private from public,anon,authenticated;

create or replace function moa_private.snapshot(r moa_private.rooms, member_id text)
returns jsonb language sql stable set search_path = pg_catalog,moa_private as $$
  select jsonb_build_object('trip',r.trip,'version',r.version,'memberId',member_id,'ownerId',r.owner_id,
    'claimedIds',coalesce((select jsonb_agg(distinct id) from (
      select value as id from jsonb_each(r.sessions)
      union select to_jsonb(m.member_id) from moa_private.memberships m where m.room_id=r.id
    ) claimed),'[]'::jsonb));
$$;

create or replace function moa_private.apply_profile(room_id uuid, member_id text, display_name text, icon text)
returns moa_private.rooms language plpgsql set search_path=pg_catalog,moa_private as $$
declare r moa_private.rooms; members jsonb;
begin
  select * into r from rooms where id=room_id for update;
  select jsonb_agg(case when value->>'id'=member_id then value||jsonb_build_object('name',display_name,'avatar',icon) else value end order by ordinality)
    into members from jsonb_array_elements(r.trip->'members') with ordinality;
  if members is distinct from r.trip->'members' then update rooms set trip=jsonb_set(trip,'{members}',members),version=version+1,updated_at=now() where id=r.id returning * into r; end if;
  return r;
end;
$$;

create or replace function public.moa_account_api(
  action text, trip_id uuid default null, session_token text default null,
  invite_token text default null, payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog,moa_private as $$
declare
  uid uuid := auth.uid(); r moa_private.rooms; p moa_private.profiles;
  link moa_private.common_invites; member_id text; generated text; digest text;
  t jsonb; result jsonb; row jsonb; rows jsonb := '[]'::jsonb;
  now_ms bigint := floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if payload is null or jsonb_typeof(payload)<>'object' or octet_length(payload::text)>1000000 then
    return jsonb_build_object('_status',400,'error','요청 데이터가 올바르지 않아요.');
  end if;
  if action='preview' then
    if invite_token is null or invite_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('_status',404,'error','초대 링크를 확인해 주세요.'); end if;
    select * into link from common_invites where token_hash=encode(sha256(convert_to(invite_token,'UTF8')),'hex');
    if not found then return public.moa_api('preview',invite_token=>invite_token); end if;
    if link.expires_at<now_ms then return jsonb_build_object('_status',410,'error','초대가 만료되었어요. 새 링크를 요청해 주세요.'); end if;
    return jsonb_build_object('title',(select trip->>'title' from rooms where id=link.room_id),'common',true);
  end if;
  if uid is null then return jsonb_build_object('_status',401,'error','로그인한 뒤 이용해 주세요.'); end if;
  if action='profile' then
    select * into p from profiles where user_id=uid;
    if not found then return jsonb_build_object('profile',null); end if;
    return jsonb_build_object('profile',jsonb_build_object('name',p.name,'avatar',p.avatar));
  end if;
  if action='save_profile' then
    if not valid_text(payload->'name',80) or coalesce(payload->>'avatar','') not in ('🌿','🐻','🐱','🐶','🐰','🦊','🐼','🐧') then
      return jsonb_build_object('_status',400,'error','이름과 프로필 아이콘을 확인해 주세요.');
    end if;
    insert into profiles(user_id,name,avatar) values(uid,btrim(payload->>'name'),payload->>'avatar')
      on conflict(user_id) do update set name=excluded.name,avatar=excluded.avatar returning * into p;
    for r in select rooms.* from rooms join memberships m on m.room_id=rooms.id where m.user_id=uid order by rooms.id for update of rooms loop
      select m.member_id into member_id from memberships m where m.room_id=r.id and m.user_id=uid;
      select jsonb_agg(case when value->>'id'=member_id then value||jsonb_build_object('name',p.name,'avatar',p.avatar) else value end order by ordinality)
        into t from jsonb_array_elements(r.trip->'members') with ordinality;
      if t is distinct from r.trip->'members' then update rooms set trip=jsonb_set(trip,'{members}',t),version=version+1,updated_at=now() where id=r.id; end if;
    end loop;
    return jsonb_build_object('profile',jsonb_build_object('name',p.name,'avatar',p.avatar));
  end if;
  if action='list' then
    for r in select rooms.* from rooms join memberships m on m.room_id=rooms.id where m.user_id=uid order by rooms.updated_at desc loop
      select m.member_id into member_id from memberships m where m.room_id=r.id and m.user_id=uid;
      rows:=rows||jsonb_build_array(snapshot(r,member_id)||'{"account":true}'::jsonb);
    end loop;
    return jsonb_build_object('trips',rows);
  end if;
  select * into p from profiles where user_id=uid;
  if not found then return jsonb_build_object('_status',428,'error','먼저 내 이름과 프로필을 설정해 주세요.'); end if;
  if action='create' then
    t:=payload->'trip'; perform validate_trip(t);
    t:=jsonb_set(t,'{members,0}',(t->'members'->0)||jsonb_build_object('name',p.name,'avatar',p.avatar));
    result:=public.moa_api('create',payload=>jsonb_build_object('trip',t));
    if result ? '_status' then return result; end if;
    select * into r from rooms where id=(result->'trip'->>'id')::uuid for update;
    member_id:=r.owner_id;
    insert into memberships(room_id,user_id,member_id) values(r.id,uid,member_id);
    update rooms set sessions='{}'::jsonb where id=r.id returning * into r;
    return snapshot(r,member_id)||'{"account":true}'::jsonb;
  end if;
  if action='join' then
    if invite_token is null or invite_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('_status',404,'error','초대 링크를 확인해 주세요.'); end if;
    digest:=encode(sha256(convert_to(invite_token,'UTF8')),'hex');
    select * into link from common_invites where token_hash=digest;
    if found then
      select * into r from rooms where id=link.room_id for update;
      -- Re-read after locking the room, so rotating a link invalidates waiting joins.
      select * into link from common_invites where room_id=r.id and token_hash=digest;
      if not found or link.expires_at<now_ms then return jsonb_build_object('_status',410,'error','초대가 만료되었어요. 새 링크를 요청해 주세요.'); end if;
      select m.member_id into member_id from memberships m where m.room_id=r.id and m.user_id=uid;
      if found then return snapshot(r,member_id)||'{"account":true}'::jsonb; end if;
      if jsonb_array_length(r.trip->'members')>=20 then return jsonb_build_object('_status',400,'error','여행은 최대 20명까지 함께할 수 있어요.'); end if;
      member_id:=gen_random_uuid()::text;
      t:=(r.trip->'members')||jsonb_build_array(jsonb_build_object('id',member_id,'name',p.name,'avatar',p.avatar));
      insert into memberships(room_id,user_id,member_id) values(r.id,uid,member_id);
      update rooms set trip=jsonb_set(trip,'{members}',t),version=version+1,updated_at=now() where id=r.id returning * into r;
      return snapshot(r,member_id)||'{"account":true}'::jsonb;
    end if;
    -- Old per-member links remain usable and bind the invited member to this account.
    select * into r from rooms where invites ? digest for update;
    if not found then return jsonb_build_object('_status',404,'error','초대 링크를 찾을 수 없어요.'); end if;
    select m.member_id into member_id from memberships m where m.room_id=r.id and m.user_id=uid;
    if found then return snapshot(r,member_id)||'{"account":true}'::jsonb; end if;
    result:=public.moa_api('join',invite_token=>invite_token);
    if result ? '_status' then return result; end if;
    member_id:=result->>'memberId';
    insert into memberships(room_id,user_id,member_id) values(r.id,uid,member_id);
    select * into r from rooms where id=r.id;
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into r.sessions from jsonb_each(r.sessions) where value<>to_jsonb(member_id);
    update rooms set sessions=r.sessions where id=r.id returning * into r;
    r:=apply_profile(r.id,member_id,p.name,p.avatar);
    return snapshot(r,member_id)||'{"account":true}'::jsonb;
  end if;
  select * into r from rooms where id=trip_id for update;
  if not found then return jsonb_build_object('_status',403,'error','이 여행에 참여할 권한이 없어요.'); end if;
  select m.member_id into member_id from memberships m where m.room_id=r.id and m.user_id=uid;
  if action='adopt' and not found then
    if coalesce(payload->>'token','') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('_status',403,'error','기존 여행의 참여 정보를 확인해 주세요.'); end if;
    member_id:=r.sessions->>encode(sha256(convert_to(payload->>'token','UTF8')),'hex');
    if member_id is null then return jsonb_build_object('_status',403,'error','기존 여행의 참여 정보를 확인해 주세요.'); end if;
    insert into memberships(room_id,user_id,member_id) values(r.id,uid,member_id);
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into r.sessions from jsonb_each(r.sessions) where value<>to_jsonb(member_id);
    update rooms set sessions=r.sessions where id=r.id returning * into r;
    r:=apply_profile(r.id,member_id,p.name,p.avatar);
    return snapshot(r,member_id)||'{"account":true}'::jsonb;
  end if;
  if member_id is null then return jsonb_build_object('_status',403,'error','이 여행에 참여할 권한이 없어요.'); end if;
  if action in ('get','adopt') then return snapshot(r,member_id)||'{"account":true}'::jsonb; end if;
  if action='update' then
    if payload->'version' is distinct from to_jsonb(r.version) then return snapshot(r,member_id)||'{"account":true,"_status":409,"error":"친구가 먼저 변경했어요. 최신 내용을 확인하고 다시 저장해 주세요."}'::jsonb; end if;
    t:=payload->'trip'; perform validate_trip(t);
    if t->>'id'<>r.id::text or t->'members' is distinct from r.trip->'members' then return jsonb_build_object('_status',400,'error','멤버는 초대와 프로필 설정으로 변경해 주세요.'); end if;
    perform validate_settlement_change(r.trip,t,member_id);
    update rooms set trip=t,version=version+1,updated_at=now() where id=r.id returning * into r;
    return snapshot(r,member_id)||'{"account":true}'::jsonb;
  end if;
  if action='invite' then
    if member_id<>r.owner_id then return jsonb_build_object('_status',403,'error','초대 링크는 여행을 만든 사람만 만들 수 있어요.'); end if;
    select * into link from common_invites where room_id=r.id;
    if not found or link.expires_at<now_ms or payload->'rotate'='true'::jsonb then
      generated:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
      insert into common_invites(room_id,token,token_hash,expires_at) values(r.id,generated,encode(sha256(convert_to(generated,'UTF8')),'hex'),now_ms+7*86400000::bigint)
        on conflict(room_id) do update set token=excluded.token,token_hash=excluded.token_hash,expires_at=excluded.expires_at returning * into link;
    end if;
    return snapshot(r,member_id)||jsonb_build_object('account',true,'common',true,'inviteToken',link.token,'expiresAt',link.expires_at);
  end if;
  return jsonb_build_object('_status',400,'error','지원하지 않는 요청이에요.');
exception when unique_violation then return jsonb_build_object('_status',409,'error','이미 다른 계정과 연결된 멤버예요.');
when raise_exception then return jsonb_build_object('_status',400,'error',sqlerrm);
when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then return jsonb_build_object('_status',400,'error','데이터 형식을 확인해 주세요.');
end;
$$;
revoke all on all functions in schema moa_private from public,anon,authenticated;
revoke all on function public.moa_account_api(text,uuid,text,text,jsonb) from public;
grant execute on function public.moa_account_api(text,uuid,text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;

