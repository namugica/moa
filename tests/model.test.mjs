import test from 'node:test';
import assert from 'node:assert/strict';
import {newTrip, splitExpense, balances, amount, dayCount, settlementPlan, settlementProgress} from '../model.mjs';
test('여행 기간 검증 및 멤버 중복 제거',()=>{
 assert.throws(()=>newTrip({title:'서울',destination:'서울',start:'2026-11-02',end:'2026-11-01',names:''}));
 const trip=newTrip({title:'서울',destination:'서울',start:'2026-11-01',end:'2026-11-02',names:'민지, 나, 민지, 수현'});
 assert.deepEqual(trip.members.map(m=>m.name),['나','민지','수현']);
 assert.equal(dayCount(trip.start,trip.end),2);
});
test('나머지 1원도 손실 없이 배분하며 부담액과 결제액의 합이 같다',()=>{
 const shares=splitExpense(10001,['a','b','c']);
 assert.deepEqual(shares.map(s=>s.amount),[3334,3334,3333]);
 const trip={members:[{id:'a'},{id:'b'},{id:'c'}],expenses:[{payerId:'a',amount:10001,shares},{payerId:'b',amount:5000,shares:splitExpense(5000,['b','c'])}]};
 const result=balances(trip);
 assert.equal(result.reduce((s,m)=>s+m.balance,0),0);
 assert.equal(result.find(m=>m.id==='a').balance,6667);
 assert.equal(result.find(m=>m.id==='c').share,5833);
});
test('정산 참여자와 금액 경계값 검증',()=>{
 assert.throws(()=>splitExpense(10,[])); assert.throws(()=>splitExpense(10,['a','a']));
 for(const value of [-1,1.5,'',NaN,Infinity,1000000001])assert.throws(()=>amount(value));
 assert.deepEqual(splitExpense(1,['a','b','c']).map(s=>s.amount),[1,0,0]);
 assert.equal(amount('0'),0);
});

test('정산 송금 계획의 각 개인 합계가 잔액과 일치하고 원 단위가 보존된다',async()=>{
 const {settlementPlan}=await import('../model.mjs');
 const trip={members:[{id:'a'},{id:'b'},{id:'c'}],expenses:[{payerId:'a',amount:10001,shares:splitExpense(10001,['a','b','c'])},{payerId:'b',amount:5000,shares:splitExpense(5000,['b','c'])}]};
 const plan=settlementPlan(trip);
 for(const m of balances(trip)){
  assert.equal(plan.filter(p=>p.to===m.id).reduce((s,p)=>s+p.amount,0)-plan.filter(p=>p.from===m.id).reduce((s,p)=>s+p.amount,0),m.balance);
 }
 assert.ok(plan.every(p=>Number.isSafeInteger(p.amount)&&p.amount>0));
 assert.deepEqual(settlementPlan({...trip,expenses:[]}),[]);
});

test('완료 표시는 해당 정산 계획 버전에만 적용되고 이전 여행 데이터도 읽는다',()=>{
 const trip={members:[{id:'a'},{id:'b'}],expenses:[{id:'e1',payerId:'a',amount:10000,shares:splitExpense(10000,['a','b'])}],settlementPlanRevision:'rev-one',settlementRecords:[{planKey:'rev-one',from:'b',to:'a',amount:5000,completedBy:'b',completedAt:'2026-10-22T00:00:00.000Z'}]};
 assert.equal(settlementProgress(trip)[0].completed,true);
 const changed=structuredClone(trip);changed.expenses[0].amount=12000;changed.expenses[0].shares=splitExpense(12000,['a','b']);changed.settlementPlanRevision='rev-two';
 assert.equal(settlementProgress(changed)[0].amount,6000);assert.equal(settlementProgress(changed)[0].completed,false);
 const legacy={members:trip.members,expenses:trip.expenses};
 assert.equal(settlementProgress(legacy)[0].completed,false);
});

