-- Local integration tests. Run only against a disposable database after setup.sql.
begin;
set local plpgsql.check_asserts = on;
set local role anon;
do $$
declare
  t jsonb := '{"id":"local-trip","title":"함께 제주","destination":"제주","start":"2026-11-01","end":"2026-11-02","status":"planning","members":[{"id":"owner","name":"지우"},{"id":"friend","name":"민지"}],"items":[],"expenses":[]}';
  owner jsonb; invitation jsonb; guest jsonb; seen jsonb; saved jsonb; result jsonb;
  path uuid; secret text; link text;
begin
  assert not has_schema_privilege(current_user,'moa_private','USAGE'), 'private schema must be inaccessible';
  begin
    perform 1 from moa_private.rooms;
    raise exception 'direct reads should have failed';
  exception when insufficient_privilege then null;
  end;
  owner := public.moa_api('create',payload=>jsonb_build_object('trip',t));
  assert owner->>'token' ~ '^[a-f0-9]{64}$', 'create must issue a random session';
  path := (owner->'trip'->>'id')::uuid; secret := owner->>'token';
  assert (public.moa_api('get',trip_id=>path)->>'_status')::int = 401, 'public key alone cannot read trips';
  assert (public.moa_api('get',trip_id=>path,session_token=>repeat('a',64))->>'_status')::int = 401, 'wrong session must fail';
  invitation := public.moa_api('invite',trip_id=>path,session_token=>secret,payload=>'{"memberId":"friend"}');
  link := invitation->>'inviteToken';
  result := public.moa_api('preview',invite_token=>link);
  assert result = '{"title":"함께 제주","memberName":"민지"}'::jsonb, 'preview reveals only the intended friend and title';
  guest := public.moa_api('join',invite_token=>link);
  assert guest->>'memberId' = 'friend', 'join must bind the invited identity';
  assert guest->>'token' <> secret, 'owner and guest sessions must differ';
  assert (public.moa_api('join',invite_token=>link)->>'_status')::int = 410, 'an invitation is single use';
  assert (public.moa_api('invite',trip_id=>path,session_token=>guest->>'token',payload=>'{"name":"다른 친구"}')->>'_status')::int = 403, 'only owner can invite';
  seen := public.moa_api('get',trip_id=>path,session_token=>secret);
  t := jsonb_set(seen->'trip','{expenses}','[{"id":"lunch","title":"점심","amount":10001,"payerId":"owner","itemId":null,"shares":[{"memberId":"owner","amount":5001},{"memberId":"friend","amount":5000}]}]');
  saved := public.moa_api('update',trip_id=>path,session_token=>secret,payload=>jsonb_build_object('trip',t,'version',seen->'version'));
  assert saved->'trip'->'expenses' = t->'expenses', 'save should keep the expense and exact won split';
  assert public.moa_api('get',trip_id=>path,session_token=>guest->>'token')->'trip' = saved->'trip', 'all members see identical records';
  result := public.moa_api('update',trip_id=>path,session_token=>guest->>'token',payload=>jsonb_build_object('trip',seen->'trip','version',seen->'version'));
  assert (result->>'_status')::int = 409 and result->'trip' = saved->'trip', 'stale updates return current data without overwriting';
  result := public.moa_api('update',trip_id=>path,session_token=>secret,payload=>jsonb_build_object('trip',jsonb_set(t,'{members,0,name}','"사칭"'),'version',saved->'version'));
  assert (result->>'_status')::int = 400, 'membership cannot be changed through edit';
  result := public.moa_api('update',trip_id=>path,session_token=>secret,payload=>jsonb_build_object('trip',jsonb_set(t,'{expenses,0,shares,0,amount}','9999'),'version',saved->'version'));
  assert (result->>'_status')::int = 400, 'invalid split must be rejected';
  invitation := public.moa_api('invite',trip_id=>path,session_token=>secret,payload=>'{"name":"수현"}');
  assert jsonb_array_length(invitation->'trip'->'members') = 3, 'new friends can be added';
  link := invitation->>'inviteToken';
  result := public.moa_api('invite',trip_id=>path,session_token=>secret,payload=>jsonb_build_object('memberId',invitation->'trip'->'members'->2->>'id'));
  assert (public.moa_api('preview',invite_token=>link)->>'_status')::int = 410, 'reissuing invalidates the old link';
  assert jsonb_array_length(result->'trip'->'expenses'->0->'shares') = 2, 'new member must not change old expense shares';
  assert (public.moa_api('create',payload=>jsonb_build_object('trip',jsonb_set(t,'{members}','[null]')))->>'_status')::int = 400, 'invalid members must fail';
  assert (public.moa_api('create',payload=>jsonb_build_object('trip',jsonb_set(t,'{start}','"2026-02-31"')))->>'_status')::int = 400, 'invalid calendar dates must fail';
  raise notice 'PASS: private access, member sessions, single-use invite, preview, shared edits, CAS conflict, validation, new member, reissue';
end;
$$;
rollback;
