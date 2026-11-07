import test from 'node:test';
import assert from 'node:assert/strict';
import {financeTotals} from '../finance-model.mjs';
test('approval and reimbursement count costs once and cash only when moved',()=>{
 const entries=[{id:'a',member_id:'me',payment:'personal',status:'approved',amount:300},{id:'b',member_id:'other',payment:'fund',status:'approved',amount:200},{id:'c',member_id:'me',payment:'personal',status:'submitted',amount:999}];
 const cash=[{kind:'income',amount:1000}];
 assert.deepEqual(financeTotals(entries,cash,'me'),{cost:500,balance:800,pending:300,myPending:300,review:1});
 cash.push({kind:'reimbursement',entry_id:'a',amount:300});
 assert.deepEqual(financeTotals(entries,cash,'me'),{cost:500,balance:500,pending:0,myPending:0,review:1});
 cash.push({kind:'outflow',amount:50});
 assert.equal(financeTotals(entries,cash,'me').balance,450);
});
test('rejected and changes-requested costs never enter totals',()=>{
 assert.equal(financeTotals([{status:'changes',amount:200},{status:'rejected',amount:300}],[],'x').cost,0);
});
