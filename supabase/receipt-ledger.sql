-- Apply after setup.sql and auth.sql. Safe to reapply; preserves all existing records.
begin;
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
    if not valid_id(m->'id') or not valid_text(m->'name',80) or m->>'id' = '__fund__' or (m->>'id') = any(members) then raise exception '멤버 정보를 확인해 주세요.'; end if;
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
    if e ? 'payment' and (jsonb_typeof(e->'payment') is distinct from 'string' or e->>'payment' not in ('personal','fund')) then raise exception '결제 방식을 확인해 주세요.'; end if;
    if e ? 'spentOn' and not is_date(e->>'spentOn') then raise exception '사용 날짜를 확인해 주세요.'; end if;
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
  if t ? 'fundEntries' then
    if jsonb_typeof(t->'fundEntries') is distinct from 'array' or jsonb_array_length(t->'fundEntries') > 2000 then raise exception '공동 자금 내역을 확인해 주세요.'; end if;
    items := '{}';
    for e in select value from jsonb_array_elements(t->'fundEntries') loop
      if not valid_id(e->'id') or (e->>'id')=any(items) or not coalesce((e->>'memberId')=any(members),false)
        or jsonb_typeof(e->'kind') is distinct from 'string' or (e->>'kind') not in ('contribution','refund')
        or not valid_amount(e->'amount') or (e->>'amount')::numeric < 1 or not is_date(e->>'date') then raise exception '공동 자금 내역을 확인해 주세요.'; end if;
      items := array_append(items,e->>'id');
    end loop;
  end if;
  if t ? 'settlementPlanRevision' and not valid_id(t->'settlementPlanRevision') then raise exception '정산 계획 버전을 확인해 주세요.'; end if;
  if t ? 'settlementRecords' then
    if jsonb_typeof(t->'settlementRecords') is distinct from 'array' or jsonb_array_length(t->'settlementRecords') > 4000 then raise exception '정산 완료 기록을 확인해 주세요.'; end if;
    for e in select value from jsonb_array_elements(t->'settlementRecords') loop
      if (e ? 'ledger' and jsonb_typeof(e->'ledger') is distinct from 'boolean') or not valid_id(e->'planKey') or not coalesce((e->>'from') = any(members || array['__fund__']),false) or not coalesce((e->>'to') = any(members || array['__fund__']),false)
        or (e->>'from') = (e->>'to') or jsonb_typeof(e->'amount') is distinct from 'number' or (e->>'amount') !~ '^\d+$' or (e->>'amount')::numeric not between 1 and 2000000000000
        or e->>'completedBy' is distinct from (case when e->>'from'='__fund__' then t->'members'->0->>'id' else e->>'from' end) or jsonb_typeof(e->'completedAt') is distinct from 'string'
        or length(e->>'completedAt') > 40 then raise exception '정산 완료 기록을 확인해 주세요.'; end if;
      if (select count(*) from jsonb_array_elements(t->'settlementRecords') prior
        where prior.value->>'planKey'=e->>'planKey' and prior.value->>'from'=e->>'from'
          and prior.value->>'to'=e->>'to' and prior.value->>'amount'=e->>'amount') > 1 then raise exception '정산 완료 기록이 중복되었어요.'; end if;
    end loop;
  end if;
end;
$$;

create or replace function moa_private.settlement_plan(t jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog,moa_private as $$
declare
  m jsonb; e jsonb; s jsonb; creditors jsonb := '[]'::jsonb; debtors jsonb := '[]'::jsonb;
  transfers jsonb := '[]'::jsonb; paid numeric; share numeric; balance numeric; fund numeric := 0;
  ci integer := 0; di integer := 0; creditor jsonb; debtor jsonb; value numeric;
begin
  for e in select element.value from jsonb_array_elements(coalesce(t->'fundEntries','[]'::jsonb)) as element loop
    fund := fund + case when e->>'kind'='contribution' then (e->>'amount')::numeric else -(e->>'amount')::numeric end;
  end loop;
  for e in select element.value from jsonb_array_elements(t->'expenses') as element loop
    if e->>'payment'='fund' then fund := fund-(e->>'amount')::numeric; end if;
  end loop;
  for e in select element.value from jsonb_array_elements(coalesce(t->'settlementRecords','[]'::jsonb)) as element loop
    if e->'ledger'='true'::jsonb and e->>'planKey' is distinct from t->>'settlementPlanRevision' then
      if e->>'to'='__fund__' then fund:=fund+(e->>'amount')::numeric; end if;
      if e->>'from'='__fund__' then fund:=fund-(e->>'amount')::numeric; end if;
    end if;
  end loop;
  for m in select element.value from jsonb_array_elements(t->'members') as element loop
    paid := 0; share := 0;
    for e in select element.value from jsonb_array_elements(t->'expenses') as element loop
      if e->>'payerId'=m->>'id' and coalesce(e->>'payment','personal')<>'fund' then paid := paid + (e->>'amount')::numeric; end if;
      for s in select element.value from jsonb_array_elements(e->'shares') as element loop
        if s->>'memberId'=m->>'id' then share := share + (s->>'amount')::numeric; end if;
      end loop;
    end loop;
    for e in select element.value from jsonb_array_elements(coalesce(t->'fundEntries','[]'::jsonb)) as element loop
      if e->>'memberId'=m->>'id' then paid := paid + case when e->>'kind'='contribution' then (e->>'amount')::numeric else -(e->>'amount')::numeric end; end if;
    end loop;
    for e in select element.value from jsonb_array_elements(coalesce(t->'settlementRecords','[]'::jsonb)) as element loop
      if e->'ledger'='true'::jsonb and e->>'planKey' is distinct from t->>'settlementPlanRevision' then
        if e->>'from'=m->>'id' then paid:=paid+(e->>'amount')::numeric; end if;
        if e->>'to'=m->>'id' then paid:=paid-(e->>'amount')::numeric; end if;
      end if;
    end loop;
    balance := paid-share;
    if balance>0 then creditors := creditors || jsonb_build_array(jsonb_build_object('id',m->>'id','left',balance));
    elsif balance<0 then debtors := debtors || jsonb_build_array(jsonb_build_object('id',m->>'id','left',-balance)); end if;
  end loop;
  if fund>0 then debtors := debtors || jsonb_build_array(jsonb_build_object('id','__fund__','left',fund));
  elsif fund<0 then creditors := creditors || jsonb_build_array(jsonb_build_object('id','__fund__','left',-fund)); end if;
  while di<jsonb_array_length(debtors) and ci<jsonb_array_length(creditors) loop
    debtor := debtors->di; creditor := creditors->ci;
    value := least((debtor->>'left')::numeric,(creditor->>'left')::numeric);
    transfers := transfers || jsonb_build_array(jsonb_build_object('from',debtor->>'id','to',creditor->>'id','amount',value));
    debtors := jsonb_set(debtors,array[di::text,'left'],to_jsonb((debtor->>'left')::numeric-value),false);
    creditors := jsonb_set(creditors,array[ci::text,'left'],to_jsonb((creditor->>'left')::numeric-value),false);
    if (debtors->di->>'left')::numeric=0 then di := di+1; end if;
    if (creditors->ci->>'left')::numeric=0 then ci := ci+1; end if;
  end loop;
  return transfers;
end;
$$;

create or replace function moa_private.validate_settlement_change(old_trip jsonb, new_trip jsonb, member_id text)
returns void language plpgsql immutable set search_path = pg_catalog,moa_private as $$
declare mark jsonb; plan jsonb;
begin
  for mark in select value from jsonb_array_elements(coalesce(old_trip->'settlementRecords','[]'::jsonb)) loop
    if not exists(select 1 from jsonb_array_elements(coalesce(new_trip->'settlementRecords','[]'::jsonb)) item where item.value=mark)
      and ((case when mark->>'from'='__fund__' then old_trip->'members'->0->>'id' else mark->>'from' end) is distinct from member_id or mark->>'planKey' is distinct from old_trip->>'settlementPlanRevision') then
      raise insufficient_privilege using message='다른 참여자의 정산 완료 기록은 변경할 수 없어요.';
    end if;
  end loop;
  plan := settlement_plan(new_trip);
  for mark in select value from jsonb_array_elements(coalesce(new_trip->'settlementRecords','[]'::jsonb)) loop
    if not exists(select 1 from jsonb_array_elements(coalesce(old_trip->'settlementRecords','[]'::jsonb)) item where item.value=mark) then
      if (case when mark->>'from'='__fund__' then new_trip->'members'->0->>'id' else mark->>'from' end) is distinct from member_id or mark->>'completedBy' is distinct from member_id
        or mark->>'planKey' is distinct from new_trip->>'settlementPlanRevision'
        or not exists(select 1 from jsonb_array_elements(plan) p where p->>'from'=mark->>'from' and p->>'to'=mark->>'to' and (p->>'amount')::numeric=(mark->>'amount')::numeric) then
        raise insufficient_privilege using message='내 정산 계획에 있는 송금만 완료 처리할 수 있어요.';
      end if;
    end if;
  end loop;
end;
$$;

revoke all on all functions in schema moa_private from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
