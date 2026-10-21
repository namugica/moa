-- MOA: run this entire file once in the Supabase SQL Editor.
-- Re-running is safe. It does not modify other applications' tables.
begin;
create schema if not exists moa_private;
revoke all on schema moa_private from public, anon, authenticated;

create table if not exists moa_private.rooms (
  id uuid primary key default gen_random_uuid(),
  trip jsonb not null,
  version bigint not null default 1,
  owner_id text not null,
  sessions jsonb not null default '{}'::jsonb,
  invites jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table moa_private.rooms enable row level security;
revoke all on all tables in schema moa_private from public, anon, authenticated;
create index if not exists moa_invite_lookup on moa_private.rooms using gin(invites);

create or replace function moa_private.is_date(value text)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
begin
  return value is not null and value ~ '^\d{4}-\d{2}-\d{2}$' and to_char(value::date,'YYYY-MM-DD') = value;
exception when others then return false;
end;
$$;

create or replace function moa_private.valid_text(value jsonb, max_length integer)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(value) = 'string' and length(btrim(value #>> '{}')) between 1 and max_length, false);
$$;

create or replace function moa_private.valid_id(value jsonb)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '^[A-Za-z0-9_-]{1,80}$', false);
$$;

create or replace function moa_private.valid_amount(value jsonb)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(value) = 'number' and (value #>> '{}') ~ '^\d+$'
    then (value #>> '{}')::numeric between 0 and 1000000000 else false end;
$$;

create or replace function moa_private.validate_trip(t jsonb)
returns void language plpgsql set search_path = pg_catalog, moa_private as $$
declare
  m jsonb; i jsonb; e jsonb; s record;
  members text[] := '{}'; items text[] := '{}'; expenses text[] := '{}';
  participants text[]; n integer; total numeric; expected numeric;
begin
  if jsonb_typeof(t) is distinct from 'object' or not valid_id(t->'id') or not valid_text(t->'title',80) or not valid_text(t->'destination',80)
    or not is_date(t->>'start') or not is_date(t->>'end') or (t->>'start') > (t->>'end')
    or jsonb_typeof(t->'status') is distinct from 'string' or (t->>'status') not in ('planning','traveling','finished') then
    raise exception '여행 정보가 올바르지 않아요.';
  end if;
  if jsonb_typeof(t->'members') is distinct from 'array' then raise exception '멤버 목록을 확인해 주세요.'; end if;
  if jsonb_array_length(t->'members') not between 1 and 20 then raise exception '멤버는 1~20명까지 가능해요.'; end if;
  for m in select value from jsonb_array_elements(t->'members') loop
    if not valid_id(m->'id') or not valid_text(m->'name',80) or (m->>'id') = any(members) then raise exception '멤버 정보를 확인해 주세요.'; end if;
    members := array_append(members,m->>'id');
  end loop;
  if jsonb_typeof(t->'items') is distinct from 'array' or jsonb_typeof(t->'expenses') is distinct from 'array' then raise exception '일정과 지출 목록을 확인해 주세요.'; end if;
  if jsonb_array_length(t->'items') > 2000 or jsonb_array_length(t->'expenses') > 2000 then raise exception '일정 또는 지출이 너무 많아요.'; end if;
  for i in select value from jsonb_array_elements(t->'items') loop
    if not valid_id(i->'id') or (i->>'id') = any(items) or not valid_text(i->'place',100)
      or not is_date(i->>'date') or (i->>'date') < (t->>'start') or (i->>'date') > (t->>'end')
      or not valid_amount(i->'estimate') or not valid_amount(i->'order')
      or jsonb_typeof(i->'note') is distinct from 'string' or length(i->>'note') > 1000
      or jsonb_typeof(i->'time') is distinct from 'string' or (i->>'time') !~ '^([0-1][0-9]|2[0-3]):[0-5][0-9]$|^$'
      or jsonb_typeof(i->'category') is distinct from 'string' or (i->>'category') not in ('관광','맛집','카페','이동','숙소','기타') then raise exception '일정 내용을 확인해 주세요.'; end if;
    items := array_append(items,i->>'id');
  end loop;
  for e in select value from jsonb_array_elements(t->'expenses') loop
    if not valid_id(e->'id') or (e->>'id') = any(expenses) or not valid_text(e->'title',100) or not valid_amount(e->'amount')
      or coalesce((e->>'payerId') = any(members),false) = false
      or not (e ? 'itemId') or (e->'itemId' <> 'null'::jsonb and not coalesce((e->>'itemId') = any(items),false))
      or jsonb_typeof(e->'shares') is distinct from 'array' then raise exception '지출 내용을 확인해 주세요.'; end if;
    n := jsonb_array_length(e->'shares'); total := (e->>'amount')::numeric; participants := '{}';
    if n not between 1 and 20 then raise exception '함께 쓴 멤버를 선택해 주세요.'; end if;
    for s in select value, ordinality from jsonb_array_elements(e->'shares') with ordinality loop
      expected := trunc(total / n) + case when s.ordinality <= mod(total,n) then 1 else 0 end;
      if not coalesce((s.value->>'memberId') = any(members),false) or (s.value->>'memberId') = any(participants)
        or not valid_amount(s.value->'amount') or (s.value->>'amount')::numeric <> expected then raise exception '분할 금액 또는 참여자가 올바르지 않아요.'; end if;
      participants := array_append(participants,s.value->>'memberId');
    end loop;
    expenses := array_append(expenses,e->>'id');
  end loop;
end;
$$;

create or replace function moa_private.snapshot(r moa_private.rooms, member_id text)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('trip',r.trip,'version',r.version,'memberId',member_id,'ownerId',r.owner_id,
    'claimedIds',coalesce((select jsonb_agg(distinct value) from jsonb_each(r.sessions)),'[]'::jsonb));
$$;

-- The only exposed entry point. Public keys alone cannot read trips; a per-member
-- random capability is required. Database tables and helper functions stay private.
create or replace function public.moa_api(
  action text,
  trip_id uuid default null,
  session_token text default null,
  invite_token text default null,
  payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, moa_private as $$
declare
  r moa_private.rooms; t jsonb; invitation jsonb;
  member_id text; target text; friend_name text; generated text; digest text;
  room_id uuid; expires_at bigint; result jsonb;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' or octet_length(payload::text) > 1000000 then
    return jsonb_build_object('_status',400,'error','요청 데이터가 올바르지 않거나 너무 커요.');
  end if;
  if action = 'create' then
    t := payload->'trip'; perform validate_trip(t);
    room_id := gen_random_uuid(); generated := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
    digest := encode(sha256(convert_to(generated,'UTF8')),'hex');
    insert into moa_private.rooms(id,trip,owner_id,sessions)
      values(room_id,jsonb_set(t,'{id}',to_jsonb(room_id::text)),t->'members'->0->>'id',jsonb_build_object(digest,t->'members'->0->>'id')) returning * into r;
    return snapshot(r,r.owner_id) || jsonb_build_object('token',generated);
  end if;
  if action in ('preview','join') then
    if invite_token is null or invite_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('_status',404,'error','유효하지 않은 초대 링크예요.'); end if;
    digest := encode(sha256(convert_to(invite_token,'UTF8')),'hex');
    select * into r from moa_private.rooms where invites ? digest for update;
    if not found then return jsonb_build_object('_status',404,'error','초대 링크를 찾을 수 없어요.'); end if;
    invitation := r.invites->digest;
    if (invitation->>'used')::boolean or (invitation->>'expiresAt')::bigint < now_ms then
      return jsonb_build_object('_status',410,'error','이미 사용했거나 만료된 초대 링크예요. 여행을 만든 친구에게 새 링크를 요청해 주세요.');
    end if;
    member_id := invitation->>'memberId';
    if action = 'preview' then
      return jsonb_build_object('title',r.trip->>'title','memberName',(select value->>'name' from jsonb_array_elements(r.trip->'members') where value->>'id' = member_id));
    end if;
    generated := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','');
    update moa_private.rooms set sessions = sessions || jsonb_build_object(encode(sha256(convert_to(generated,'UTF8')),'hex'),member_id),
      invites = jsonb_set(invites,array[digest,'used'],'true'::jsonb), updated_at = now()
      where id = r.id returning * into r;
    return snapshot(r,member_id) || jsonb_build_object('token',generated);
  end if;
  if session_token is null or session_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('_status',401,'error','이 여행에 참여할 권한이 없어요.'); end if;
  select * into r from moa_private.rooms where id = trip_id for update;
  if not found then return jsonb_build_object('_status',401,'error','이 여행에 참여할 권한이 없어요.'); end if;
  member_id := r.sessions->>encode(sha256(convert_to(session_token,'UTF8')),'hex');
  if member_id is null then return jsonb_build_object('_status',401,'error','이 여행에 참여할 권한이 없어요.'); end if;
  if action = 'get' then return snapshot(r,member_id); end if;
  if action = 'update' then
    if payload->'version' is distinct from to_jsonb(r.version) then
      return snapshot(r,member_id) || jsonb_build_object('_status',409,'error','친구가 먼저 변경했어요. 최신 내용을 확인하고 다시 저장해 주세요.');
    end if;
    t := payload->'trip'; perform validate_trip(t);
    if t->>'id' <> r.id::text or t->'members' is distinct from r.trip->'members' then return jsonb_build_object('_status',400,'error','멤버 변경은 초대 기능을 이용해 주세요.'); end if;
    update moa_private.rooms set trip = t, version = version + 1, updated_at = now() where id = r.id returning * into r;
    return snapshot(r,member_id);
  end if;
  if action = 'invite' then
    if member_id <> r.owner_id then return jsonb_build_object('_status',403,'error','초대 링크는 여행을 만든 사람만 만들 수 있어요.'); end if;
    target := nullif(payload->>'memberId',''); friend_name := btrim(payload->>'name');
    if target is null then
      if not valid_text(to_jsonb(friend_name),80) then return jsonb_build_object('_status',400,'error','초대할 친구 이름을 입력해 주세요.'); end if;
      if jsonb_array_length(r.trip->'members') >= 20 then return jsonb_build_object('_status',400,'error','여행은 최대 20명까지 함께할 수 있어요.'); end if;
      if exists(select 1 from jsonb_array_elements(r.trip->'members') where value->>'name' = friend_name) then return jsonb_build_object('_status',400,'error','이미 있는 이름이에요. 목록에서 선택해 주세요.'); end if;
      target := gen_random_uuid()::text;
      r.trip := jsonb_set(r.trip,'{members}',(r.trip->'members') || jsonb_build_array(jsonb_build_object('id',target,'name',friend_name)));
    end if;
    if not exists(select 1 from jsonb_array_elements(r.trip->'members') where value->>'id' = target)
      or exists(select 1 from jsonb_each_text(r.sessions) where value = target) then return jsonb_build_object('_status',409,'error','이미 참여했거나 없는 멤버예요.'); end if;
    generated := replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''); expires_at := now_ms + 7 * 86400000::bigint;
    select coalesce(jsonb_object_agg(key,case when value->>'memberId' = target then value || '{"used":true}'::jsonb else value end),'{}'::jsonb) into r.invites from jsonb_each(r.invites);
    r.invites := r.invites || jsonb_build_object(encode(sha256(convert_to(generated,'UTF8')),'hex'),jsonb_build_object('memberId',target,'expiresAt',expires_at,'used',false));
    update moa_private.rooms set trip = r.trip, invites = r.invites, version = version + 1, updated_at = now() where id = r.id returning * into r;
    return snapshot(r,member_id) || jsonb_build_object('inviteToken',generated,'expiresAt',expires_at);
  end if;
  return jsonb_build_object('_status',400,'error','지원하지 않는 요청이에요.');
exception when raise_exception then
  return jsonb_build_object('_status',400,'error',sqlerrm);
when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  return jsonb_build_object('_status',400,'error','데이터 형식을 확인해 주세요.');
end;
$$;

revoke all on all functions in schema moa_private from public, anon, authenticated;
revoke all on function public.moa_api(text,uuid,text,text,jsonb) from public;
grant execute on function public.moa_api(text,uuid,text,text,jsonb) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
