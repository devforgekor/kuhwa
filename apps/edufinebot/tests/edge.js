'use strict';
const fs = require('fs');
const path = require('path');

global.self = global;
global.ExcelJS = require('../public/vendor/exceljs.min.js');
const P = require('../public/parser.js');
const E = require('../public/excel.js');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const cartMulti = fx('test_cart_multi.txt');
const payMulti = fx('test_pay_multi.txt');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  [PASS] ' + name + ' = ' + a); }
  else { fail++; console.log('  [FAIL] ' + name + ' = ' + a + ' (expected ' + e + ')'); }
}

console.log('===== E1 : CRLF 개행 =====');
let r = P.parse(cartMulti.replace(/\n/g, '\r\n'), payMulti.replace(/\n/g, '\r\n'));
eq('code', r.status.code, 'OK');
eq('priceSum', r.priceSum, 100600);
eq('rows', r.rows.length, 4);

console.log('===== E2 : 말 줄바꿈 무시 =====');
r = P.parse(cartMulti + '\n\n', payMulti + '\r\n');
eq('code', r.status.code, 'OK');
eq('priceSum', r.priceSum, 100600);

console.log('===== E3 : 대량 주문 45건 + 엑셀 동적 행 확장 =====');
{
  const cart = [], pay = [];
  for (let i = 1; i <= 45; i++) {
    const n = '테스트상품' + String(i).padStart(2, '0');
    cart.push(n, '옵션: 색' + i, '내일(금) 도착', '1,000', '원', '1', '');
    pay.push(n + ', 색' + i, '수량 1개 / 무료배송');
  }
  pay.push('총 상품 가격', '45,000원', '총 결제 금액', '45,000원');
  r = P.parse(cart.join('\n'), pay.join('\n'));
  eq('code', r.status.code, 'OK');
  eq('rows', r.rows.length, 45);
  eq('priceSum', r.priceSum, 45000);
  eq('canDownload', r.status.canDownload, true);
  const ws = E.build(r).getWorksheet('품목내역');
  eq('row34_data_not_sum', ws.getCell('B34').value, '테스트상품31');
  eq('sumLabel', ws.getCell('B49').value, '합계');
  eq('sumQty', ws.getCell('E49').value, 45);
  eq('sumAmt', ws.getCell('H49').value, 45000);
}

console.log('===== E4 : 이름접두 폴백 매칭 =====');
{
  const cart = ['가나다라마바사상품', '내일 도착', '5,000', '원', '1'];
  const pay = ['가나다라마바사상품 블루 특가', '수량 1개', '총 상품 가격', '5,000원', '총 결제 금액', '5,000원'];
  r = P.parse(cart.join('\n'), pay.join('\n'));
  eq('code', r.status.code, 'OK');
  eq('nameOut', r.rows[0].nameOut, '가나다라마바사상품');
  eq('price', r.rows[0].price, 5000);
}

console.log('===== E5 : "=..." 상품명 엑셀 안전 (수식 미인식) =====');
{
  const cart = ['=SUM(A1:A9)', '옵션: 테스트', '내일 도착', '1,000', '원', '1'];
  const pay = ['=SUM(A1:A9), 테스트', '수량 1개', '총 상품 가격', '1,000원', '총 결제 금액', '1,000원'];
  r = P.parse(cart.join('\n'), pay.join('\n'));
  eq('code', r.status.code, 'OK');
  eq('nameOut', r.rows[0].nameOut, '=SUM(A1:A9)');
  const wb = E.build(r);
  const cell = wb.getWorksheet('품목내역').getCell('B4');
  eq('cellValue', cell.value, '=SUM(A1:A9)');
  eq('isPlainText', typeof cell.value === 'string', true);
  eq('min10rows_sumRow', wb.getWorksheet('품목내역').getCell('B14').value, '합계');
}

console.log('===== E6 : 가격 파싱 실패 → 경고 + 빈 금액셀 =====');
{
  const cart = ['가나다라마바사상품', '옵션: 색1', '내일 도착', '할인', '원', '(1개당 500원)'];
  const pay = ['가나다라마바사상품, 색1', '수량 1개', '총 상품 가격', '100원', '총 결제 금액', '100원'];
  r = P.parse(cart.join('\n'), pay.join('\n'));
  eq('code', r.status.code, 'WARN');
  eq('price', r.rows[0].price, null);
  eq('unitPrice', r.rows[0].unitPrice, null);
  eq('priceSum', r.priceSum, 0);
  const wb = E.build(r);
  const h4 = wb.getWorksheet('품목내역').getCell('H4');
  eq('H4empty', h4.value == null, true);
}

console.log('===== E7 : 두 자리 수량 =====');
{
  const cart = ['가나다라마바사상품', '내일 도착', '5,000', '원', '1'];
  const pay = ['가나다라마바사상품', '수량 12개 / 무료배송', '총 상품 가격', '5,000원', '총 결제 금액', '5,000원'];
  r = P.parse(cart.join('\n'), pay.join('\n'));
  eq('qty', r.rows[0].qty, 12);
  eq('qtySum', r.qtySum, 12);
  eq('code', r.status.code, 'OK');
}

console.log('');
console.log('===== EDGE RESULT: PASS=' + pass + ' FAIL=' + fail + ' =====');
process.exit(fail > 0 ? 1 : 0);
