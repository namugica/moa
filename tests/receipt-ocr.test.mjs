import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText } from '../receipt-ocr.mjs';

test('Korean receipt total and date are parsed with high confidence', () => {
  const result = parseReceiptText('우리마트\n출력일시: 2025-12-26 20:09\n합계액: 3,560원\n승인번호: 66415935');
  assert.equal(result.title, '우리마트');
  assert.equal(result.amount, 3560);
  assert.equal(result.amountConfidence, 'high');
  assert.equal(result.spent_on, '2025-12-26');
});

test('total value on the next line is selected over tax and item prices', () => {
  const result = parseReceiptText('당근 1,980원\n부가세 600원\n결제 금액\n3,560원');
  assert.equal(result.amount, 3560);
  assert.equal(result.amountConfidence, 'high');
});

test('identifiers and tax alone are not treated as the expense amount', () => {
  const result = parseReceiptText('전화번호 043-277-3700\n승인번호 66415935\n부가세 600원');
  assert.equal(result.amount, '');
  assert.equal(result.amountConfidence, 'low');
});

test('English receipt total labels remain supported', () => {
  const result = parseReceiptText('NORTHSTAR MARKET\nTOTAL 5,750\n2024-04-12');
  assert.equal(result.amount, 5750);
  assert.equal(result.amountConfidence, 'high');
  assert.equal(result.spent_on, '2024-04-12');
});
