-- Disposable database only. Both the fresh install and upgrade use these functions.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
 t jsonb := '{"id":"ledger","title":"모임","destination":"서울","start":"2026-11-18","end":"2026-11-18","status":"planning","items":[],"members":[{"id":"a","name":"가"},{"id":"b","name":"나"},{"id":"c","name":"다"}],"expenses":[{"id":"f","title":"지출","amount":240000,"payment":"fund","payerId":"a","itemId":null,"shares":[{"memberId":"a","amount":80000},{"memberId":"b","amount":80000},{"memberId":"c","amount":80000}]},{"id":"p","title":"지출","amount":30000,"payment":"personal","payerId":"a","itemId":null,"shares":[{"memberId":"a","amount":10000},{"memberId":"b","amount":10000},{"memberId":"c","amount":10000}]}],"fundEntries":[{"id":"a","memberId":"a","kind":"contribution","amount":100000,"date":"2026-11-18"},{"id":"b","memberId":"b","kind":"contribution","amount":100000,"date":"2026-11-18"},{"id":"c","memberId":"c","kind":"contribution","amount":100000,"date":"2026-11-18"}]}';
 next_trip jsonb; owner jsonb; guest jsonb; invitation jsonb; saved jsonb; result jsonb; room_id uuid;
begin
 perform moa_private.validate_trip(t);
 assert moa_private.settlement_plan(t)='[{"from":"__fund__","to":"a","amount":40000},{"from":"__fund__","to":"b","amount":10000},{"from":"__fund__","to":"c","amount":10000}]'::jsonb,'pooled and personal costs must share one exact plan';
 begin
  perform moa_private.validate_trip(jsonb_set(t,'{fundEntries,0,amount}','-1'));
  raise exception 'negative contribution accepted';
 exception when raise_exception then assert sqlerrm<>'negative contribution accepted'; end;
 begin
  perform moa_private.validate_trip(jsonb_set(t,'{fundEntries,0,memberId}','"outsider"'));
  raise exception 'outsider accepted';
 exception when raise_exception then assert sqlerrm<>'outsider accepted'; end;
 begin
  perform moa_private.validate_trip(jsonb_set(t,'{fundEntries}','null'));
  raise exception 'null entries accepted';
 exception when raise_exception then assert sqlerrm<>'null entries accepted'; end;
 owner:=public.moa_api('create',payload=>jsonb_build_object('trip',t));
 room_id:=(owner->'trip'->>'id')::uuid;
 invitation:=public.moa_api('invite',trip_id=>room_id,session_token=>owner->>'token',payload=>'{"memberId":"b"}');
 guest:=public.moa_api('join',invite_token=>invitation->>'inviteToken');
 saved:=public.moa_api('get',trip_id=>room_id,session_token=>owner->>'token');
 t:=jsonb_set(saved->'trip','{settlementPlanRevision}','"rev-fund"');
 saved:=public.moa_api('update',trip_id=>room_id,session_token=>owner->>'token',payload=>jsonb_build_object('trip',t,'version',saved->'version'));
 next_trip:=jsonb_set(t,'{settlementRecords}','[{"from":"__fund__","to":"b","amount":10000,"completedBy":"a","planKey":"rev-fund","completedAt":"2026-11-18T00:00:00.000Z"}]');
 result:=public.moa_api('update',trip_id=>room_id,session_token=>guest->>'token',payload=>jsonb_build_object('trip',next_trip,'version',saved->'version'));
 assert result->>'_status'='403','guest must not sign for the fund custodian';
 result:=public.moa_api('update',trip_id=>room_id,session_token=>owner->>'token',payload=>jsonb_build_object('trip',next_trip,'version',saved->'version'));
 assert not result ? '_status','custodian can mark a real fund payout';
 result:=public.moa_api('update',trip_id=>room_id,session_token=>guest->>'token',payload=>jsonb_build_object('trip',t,'version',result->'version'));
 assert result->>'_status'='403','guest must not undo a fund payout';
 -- Real payouts created by the new UI survive subsequent expense revisions.
 t:=jsonb_set(t,'{settlementRecords}','[{"from":"__fund__","to":"a","amount":40000,"completedBy":"a","ledger":true,"planKey":"rev-fund","completedAt":"2026-11-18T00:00:00.000Z"}]');
 t:=jsonb_set(t,'{expenses}',(t->'expenses')||'[{"id":"extra","title":"지출","amount":3000,"payment":"fund","payerId":"a","itemId":null,"shares":[{"memberId":"a","amount":1000},{"memberId":"b","amount":1000},{"memberId":"c","amount":1000}]}]'::jsonb);
 t:=jsonb_set(t,'{settlementPlanRevision}','"revision-two"');
 perform moa_private.validate_trip(t);
 assert moa_private.settlement_plan(t)='[{"from":"a","to":"b","amount":1000},{"from":"__fund__","to":"b","amount":8000},{"from":"__fund__","to":"c","amount":9000}]'::jsonb,'past payouts must count once after edits';
 raise notice 'PASS: pooled fund parity, ledger validation, custodian-only payout, shared persistence';
end;
$$;
rollback;
