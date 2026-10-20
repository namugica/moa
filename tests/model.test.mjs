import test from 'node:test';
import assert from 'node:assert/strict';
import {newTrip, splitExpense, balances, amount, dayCount} from '../model.mjs';
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
