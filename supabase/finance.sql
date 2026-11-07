-- Apply after setup.sql and auth.sql. Additive; existing settlement data is unchanged.
begin;
create table if not exists moa_private.finance_entries (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references moa_private.rooms(id),
 member_id text not null, title text not null, amount bigint not null check(amount between 1 and 1000000000),
 spent_on date not null, event text not null default '', purpose text not null,
 payment text not null check(payment in ('personal','fund')),
 status text not null default 'submitted' check(status in ('submitted','approved','changes','rejected')),
 note text not null default '', receipt text, missing_reason text not null default '',
 revision integer not null default 1, created_at timestamptz not null default now()
);
create table if not exists moa_private.finance_cash (
 id uuid primary key default gen_random_uuid(), room_id uuid not null references moa_private.rooms(id),
 kind text not null check(kind in ('income','outflow','reimbursement')), amount bigint not null check(amount between 1 and 1000000000),
 title text not null, entry_id uuid unique references moa_private.finance_entries(id),
 created_at timestamptz not null default now(), actor text not null,
 check((kind='reimbursement') = (entry_id is not null))
);
create table if not exists moa_private.finance_history (
 id bigint generated always as identity primary key, room_id uuid not null references moa_private.rooms(id),
 entry_id uuid references moa_private.finance_entries(id), actor text not null, action text not null,
 note text not null default '', created_at timestamptz not null default now()
);
alter table moa_private.finance_entries enable row level security;
alter table moa_private.finance_cash enable row level security;
alter table moa_private.finance_history enable row level security;
revoke all on moa_private.finance_entries,moa_private.finance_cash,moa_private.finance_history from public,anon,authenticated;
create index if not exists finance_room on moa_private.finance_entries(room_id);
create index if not exists finance_cash_room on moa_private.finance_cash(room_id);
create or replace function public.moa_finance_api(action text, trip_id uuid, payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,moa_private as $$
declare
 r moa_private.rooms; me text; manager boolean; e moa_private.finance_entries;
 entry_key uuid; n bigint; picture text; target text;
begin
 if auth.uid() is null then return jsonb_build_object('_status',401,'error','로그인한 뒤 이용해 주세요.'); end if;
 if payload is null or jsonb_typeof(payload)<>'object' or octet_length(payload::text)>2200000 then raise exception '첨부 파일 또는 입력 크기를 확인해 주세요.'; end if;
 -- Serialize all operations per space, including approval and payment.
 select * into r from rooms where id=trip_id for update;
 select m.member_id into me from memberships m where m.room_id=trip_id and m.user_id=auth.uid();
 if me is null then return jsonb_build_object('_status',403,'error','이 공간의 참여자만 이용할 수 있어요.'); end if;
 manager := me=r.owner_id;
 if action='list' then
  return jsonb_build_object('manager',manager,'memberId',me,
   'entries',coalesce((select jsonb_agg((to_jsonb(f)-'receipt')||jsonb_build_object('has_receipt',f.receipt is not null) order by f.created_at desc) from finance_entries f where f.room_id=trip_id and (manager or f.member_id=me)),'[]'::jsonb),
   'cash',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from finance_cash c where c.room_id=trip_id and (manager or exists(select 1 from finance_entries f where f.id=c.entry_id and f.member_id=me))),'[]'::jsonb),
   'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.id desc) from finance_history h where h.room_id=trip_id and (manager or exists(select 1 from finance_entries f where f.id=h.entry_id and f.member_id=me))),'[]'::jsonb));
 end if;
 if action in ('receipt','submit','review','pay') and payload ? 'id' then
  entry_key:=(payload->>'id')::uuid;
  select * into e from finance_entries where id=entry_key and room_id=trip_id for update;
  if not found or (not manager and e.member_id<>me) then return jsonb_build_object('_status',403,'error','접근할 수 없는 지출이에요.'); end if;
 end if;
 if action='receipt' then return jsonb_build_object('receipt',e.receipt); end if;
 if action='submit' then
  if entry_key is not null and (e.member_id<>me or e.status not in ('changes','submitted')) then raise exception '본인의 검토 전 또는 보완 요청 지출만 수정할 수 있어요.'; end if;
  if entry_key is not null and (payload->>'revision')::int is distinct from e.revision then return jsonb_build_object('_status',409,'error','내역이 변경됐어요. 새로고침 후 다시 확인해 주세요.'); end if;
  if not valid_text(payload->'title',100) or not valid_text(payload->'purpose',500) or length(coalesce(payload->>'event',''))>100 then raise exception '지출 이름과 사용 목적을 확인해 주세요.'; end if;
  if coalesce(payload->>'amount','') !~ '^[0-9]{1,10}$' then raise exception '금액은 양의 정수로 입력해 주세요.'; end if;
  n:=(payload->>'amount')::bigint;
  if n<1 or n>1000000000 or coalesce(payload->>'payment','') not in ('personal','fund') then raise exception '금액과 결제 방식을 확인해 주세요.'; end if;
  if coalesce(payload->>'spent_on','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '사용 날짜를 확인해 주세요.'; end if;
  picture:=case when payload ? 'receipt' then payload->>'receipt' else e.receipt end;
  if picture is not null and (length(picture)>2100000 or picture !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$') then raise exception '영수증은 1.5MB 이하 JPG, PNG, WebP 사진으로 첨부해 주세요.'; end if;
  if length(coalesce(payload->>'missing_reason',''))>500 or (picture is null and not valid_text(payload->'missing_reason',500)) then raise exception '영수증을 첨부하거나 미첨부 사유를 입력해 주세요.'; end if;
  if entry_key is null then
   insert into finance_entries(room_id,member_id,title,amount,spent_on,event,purpose,payment,receipt,missing_reason)
    values(trip_id,me,btrim(payload->>'title'),n,(payload->>'spent_on')::date,coalesce(payload->>'event',''),payload->>'purpose',payload->>'payment',picture,coalesce(payload->>'missing_reason','')) returning * into e;
  else
   update finance_entries set title=btrim(payload->>'title'),amount=n,spent_on=(payload->>'spent_on')::date,event=coalesce(payload->>'event',''),purpose=payload->>'purpose',payment=payload->>'payment',receipt=picture,missing_reason=coalesce(payload->>'missing_reason',''),status='submitted',note='',revision=revision+1 where id=e.id returning * into e;
  end if;
  insert into finance_history(room_id,entry_id,actor,action) values(trip_id,e.id,me,'submitted');
  return jsonb_build_object('ok',true);
 end if;
 if not manager then return jsonb_build_object('_status',403,'error','관리자만 처리할 수 있어요.'); end if;
 if action='review' then
  if e.id is null or e.status<>'submitted' or (payload->>'revision')::int is distinct from e.revision then return jsonb_build_object('_status',409,'error','이미 처리되거나 수정된 지출이에요. 다시 확인해 주세요.'); end if;
  target:=payload->>'status';
  if coalesce(target,'') not in ('approved','changes','rejected') or length(coalesce(payload->>'note',''))>500 then raise exception '처리 상태를 확인해 주세요.'; end if;
  if target<>'approved' and not valid_text(payload->'note',500) then raise exception '보완 또는 반려 사유를 입력해 주세요.'; end if;
  update finance_entries set status=target,note=coalesce(payload->>'note',''),revision=revision+1 where id=e.id;
  insert into finance_history(room_id,entry_id,actor,action,note) values(trip_id,e.id,me,target,coalesce(payload->>'note',''));
  return jsonb_build_object('ok',true);
 end if;
 if action='pay' then
  if e.id is null or e.status<>'approved' or e.payment<>'personal' then raise exception '승인된 개인 결제 지출만 지급할 수 있어요.'; end if;
  if exists(select 1 from finance_cash where entry_id=e.id) then return jsonb_build_object('_status',409,'error','이미 지급 완료된 지출이에요.'); end if;
  insert into finance_cash(room_id,kind,amount,title,entry_id,actor) values(trip_id,'reimbursement',e.amount,e.title,e.id,me);
  insert into finance_history(room_id,entry_id,actor,action) values(trip_id,e.id,me,'paid');
  return jsonb_build_object('ok',true);
 end if;
 if action='cash' then
  if coalesce(payload->>'kind','') not in ('income','outflow') or not valid_text(payload->'title',100) or coalesce(payload->>'amount','') !~ '^[0-9]{1,10}$' then raise exception '입출금 내용을 확인해 주세요.'; end if;
  n:=(payload->>'amount')::bigint;
  if n<1 or n>1000000000 then raise exception '금액은 1원부터 10억 원까지 입력해 주세요.'; end if;
  insert into finance_cash(room_id,kind,amount,title,actor) values(trip_id,payload->>'kind',n,payload->>'title',me);
  insert into finance_history(room_id,actor,action,note) values(trip_id,me,'cash',payload->>'title');
  return jsonb_build_object('ok',true);
 end if;
 raise exception '지원하지 않는 요청이에요.';
exception when raise_exception or invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range or check_violation then return jsonb_build_object('_status',400,'error',sqlerrm);
end;
$$;
revoke all on function public.moa_finance_api(text,uuid,jsonb) from public,anon;
grant execute on function public.moa_finance_api(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
