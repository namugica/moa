import test from 'node:test';
import assert from 'node:assert/strict';
import {balances, fundBalance, FUND_ID, splitExpense, settlementPlan, settlementProgress, validateLedger} from '../model.mjs';
import {validateTrip} from '../server.mjs';
import {parseReceiptText} from '../receipt-ocr.mjs';
const fixture=()=>({id:'trip',title:'모임',destination:'서울',start:'2026-11-18',end:'2026-11-18',status:'planning',items:[],members:['a','b','c'].map(id=>({id,name:id})),expenses:[],fundEntries:['a','b','c'].map(id=>({id,memberId:id,kind:'contribution',amount:100000,date:'2026-11-18'}))});
function expense(id,value,payment='fund',payerId='a',participants=['a','b','c']){return{id,title:'지출',amount:value,payment,payerId,itemId:null,shares:splitExpense(value,participants)};}
function conservation(trip){
 const rows=[...balances(trip),{id:FUND_ID,balance:-fundBalance(trip)}];
 const plan=settlementPlan(trip);
 assert.equal(rows.reduce((s,m)=>s+m.balance,0),0);
 for(const row of rows)assert.equal(plan.filter(p=>p.to===row.id).reduce((s,p)=>s+p.amount,0)-plan.filter(p=>p.from===row.id).reduce((s,p)=>s+p.amount,0),row.balance);
}
test('공동 자금 30만 원·공동 결제 24만 원·개인 결제 3만 원이면 4만/1만/1만 원 반환',()=>{
 const trip=fixture();trip.expenses=[expense('fund',240000),expense('personal',30000,'personal')];
 assert.equal(fundBalance(trip),60000);
 assert.deepEqual(balances(trip).map(m=>m.balance),[40000,10000,10000]);
 assert.deepEqual(settlementPlan(trip),[{from:FUND_ID,to:'a',amount:40000},{from:FUND_ID,to:'b',amount:10000},{from:FUND_ID,to:'c',amount:10000}]);
 assert.doesNotThrow(()=>validateTrip(trip));conservation(trip);
});
test('일부 참여자·원 단위 나머지·추가 납입·환급·잔액 부족도 금액을 보존한다',()=>{
 const trip=fixture();trip.expenses=[expense('fund',310001,'fund','a',['b','c']),expense('personal',17001,'personal','b')];
 trip.fundEntries.push({id:'extra',memberId:'b',kind:'contribution',amount:5000,date:'2026-11-18'},{id:'refund',memberId:'a',kind:'refund',amount:2000,date:'2026-11-18'});
 assert.equal(fundBalance(trip),-7001);assert.ok(settlementPlan(trip).some(p=>p.to===FUND_ID));conservation(trip);
 trip.members.push({id:'new',name:'새 친구'});assert.equal(balances(trip).at(-1).share,0);conservation(trip);
});
test('환급은 소비액을 중복 계산하지 않으며 최종 지급 표시는 보관자 명의로 검증한다',()=>{
 const trip=fixture();trip.expenses=[expense('p',30000,'personal')];
 trip.fundEntries.push({id:'refund',memberId:'a',kind:'refund',amount:30000,date:'2026-11-18'});
 assert.equal(balances(trip)[0].balance,90000);assert.equal(fundBalance(trip),270000);
 const transfer=settlementPlan(trip)[0];trip.settlementPlanRevision='revision';
 trip.settlementRecords=[{...transfer,planKey:'revision',completedBy:'a',completedAt:new Date().toISOString()}];
 assert.doesNotThrow(()=>validateTrip(trip));assert.equal(settlementProgress(trip)[0].completed,true);
 trip.settlementRecords[0].completedBy='b';assert.throws(()=>validateTrip(trip));
});
test('잘못된 공동 자금·예약 멤버 ID·결제 방식·날짜를 서버가 거절한다',()=>{
 const base=fixture();
 for(const mutate of [t=>t.fundEntries.push(t.fundEntries[0]),t=>t.fundEntries[0].memberId='outsider',t=>t.fundEntries[0].amount=-1,t=>t.fundEntries[0].date='2026-02-31',t=>t.fundEntries=null,t=>t.members[0].id=FUND_ID,t=>t.expenses.push({...expense('e',100),payment:'unknown'}),t=>t.expenses.push({...expense('e',100),spentOn:'2026-02-31'})]){const t=structuredClone(base);mutate(t);assert.throws(()=>validateTrip(t));}
});
test('영수증은 가게명 없이도 총액을 읽고 번호·날짜를 금액에서 제외한다',()=>{
 assert.equal(parseReceiptText('영수증\n2026-11-18\n합계 48,000원\n카드번호 1234\n승인번호 98765432').amount,48000);
 assert.equal(parseReceiptText('영수증\n총액\n12,345원').amount,12345);
 assert.equal(parseReceiptText('영수증\n2026-11-18\n전화 02-1234-5678\n카드번호 12345678').amount,'');
 assert.equal(parseReceiptText('영수증\n48,000원').amountConfidence,'low');
 assert.equal(parseReceiptText('영수증\n결제금액 48,000원').amountConfidence,'high');
 assert.equal(parseReceiptText('영수증\n2026-02-31').spent_on,'');
});

test('새 정산에서 실제 지급한 돈을 보존하고 지출 수정 뒤에는 차액만 계산한다',()=>{
 const trip=fixture();trip.expenses=[expense('fund',240000),expense('personal',30000,'personal')];
 trip.settlementPlanRevision='first';
 trip.settlementRecords=[{from:FUND_ID,to:'a',amount:40000,planKey:'first',completedBy:'a',ledger:true,completedAt:new Date().toISOString()}];
 assert.equal(settlementProgress(trip)[0].completed,true);
 trip.expenses.push(expense('extra',3000));trip.settlementPlanRevision='second';
 assert.equal(fundBalance(trip),17000);
 assert.deepEqual(balances(trip).map(m=>m.balance),[-1000,9000,9000]);
 conservation(trip);
 assert.deepEqual(settlementPlan(trip),[{from:'a',to:'b',amount:1000},{from:FUND_ID,to:'b',amount:8000},{from:FUND_ID,to:'c',amount:9000}]);
 trip.settlementPlanRevision='third';assert.equal(fundBalance(trip),17000,'later edits must not count the same payout twice');
});
