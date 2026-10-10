'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../public/parser.js');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  [PASS] ' + name + ' = ' + a); }
  else { fail++; console.log('  [FAIL] ' + name + ' = ' + a + ' (expected ' + e + ')'); }
}

const cartMulti = fx('test_cart_multi.txt');
const payMulti = fx('test_pay_multi.txt');
const cartSingle = fx('test_cart.txt');
const paySingle = fx('test_pay.txt');
const cartReal = fx('test_cart_real.txt');
const payReal = fx('test_pay_real.txt');

console.log('===== T1 : 다중 4건 (100,600) =====');
let r = P.parse(cartMulti, payMulti);
eq('code', r.status.code, 'OK');
eq('canDownload', r.status.canDownload, true);
eq('message', r.status.message, '일치 4건 반영 완료 (100,600원)');
eq('rows', r.rows.length, 4);
eq('prices', r.rows.map(x => x.price), [24400, 13900, 12800, 49500]);
eq('qtys', r.rows.map(x => x.qty), [1, 1, 1, 3]);
eq('unitPrices', r.rows.map(x => x.unitPrice), [24400, 13900, 12800, 16500]);
eq('qtySum', r.qtySum, 6);
eq('priceSum', r.priceSum, 100600);
eq('name0', r.rows[0].nameOut, '티니월드 뽀송클레이 15종 세트');
eq('spec0', r.rows[0].spec, '혼합색상, 50g, 1세트');
eq('spec2', r.rows[2].spec, '2개');
eq('spec3', r.rows[3].spec, '');
eq('totalGoods', r.meta.totalGoods, 100600);
eq('totalPaid', r.meta.totalPaid, 98400);

console.log('===== T2 : 단일 1건 (49,500) =====');
r = P.parse(cartSingle, paySingle);
eq('code', r.status.code, 'OK');
eq('message', r.status.message, '일치 1건 반영 완료 (49,500원)');
eq('rows', r.rows.length, 1);
eq('price', r.rows[0].price, 49500);
eq('qty', r.rows[0].qty, 3);
eq('qtySum', r.qtySum, 3);
eq('priceSum', r.priceSum, 49500);
eq('payCount', r.meta.payCount, 1);

console.log('===== T3 : 실제 데이터 5건 (113,400 / 총상품 115,600) =====');
r = P.parse(cartReal, payReal);
eq('code', r.status.code, 'OK');
eq('canDownload', r.status.canDownload, true);
eq('message', r.status.message, '일치 5건 반영 완료 (113,400원)');
eq('rows', r.rows.length, 5);
eq('prices', r.rows.map(x => x.price), [24400, 11700, 15000, 12800, 49500]);
eq('qtys', r.rows.map(x => x.qty), [1, 1, 2, 1, 3]);
eq('qtySum', r.qtySum, 8);
eq('priceSum', r.priceSum, 113400);
eq('totalGoods', r.meta.totalGoods, 115600);
eq('totalPaid', r.meta.totalPaid, 113400);
eq('matchCount', r.meta.matchCount, 5);

console.log('===== T4 : 미입력 =====');
r = P.parse('', '');
eq('code', r.status.code, 'EMPTY_PAY');
eq('message', r.status.message, '결제 페이지 텍스트를 붙여넣으세요');
eq('canDownload', r.status.canDownload, false);
r = P.parse('', paySingle);
eq('code', r.status.code, 'EMPTY_CART');
eq('message', r.status.message, '장바구니 텍스트를 붙여넣으세요');

console.log('===== T5 : 불일치 =====');
const negCart = ['존재하지 않는 다른 상품', '옵션: 테스트', '삭제', '내일(금) 도착', '1,000', '원', '1'].join('\n');
r = P.parse(negCart, paySingle);
eq('code', r.status.code, 'NO_MATCH');
eq('message', r.status.message, '장바구니와 일치하는 상품 없음');
eq('rows', r.rows.length, 0);

console.log('===== T6 : 부분 일치 (1/2) =====');
const cart6 = ['테스트상품A', '옵션: 빨강', '내일(금) 도착', '10%', '5,000', '원', '1'].join('\n');
const pay6 = [
  '테스트상품A', '수량 1개 / 무료배송',
  '테스트상품B', '수량 1개 / 무료배송',
  '총 상품 가격', '10,000원', '총 결제 금액', '10,000원'
].join('\n');
r = P.parse(cart6, pay6);
eq('code', r.status.code, 'PARTIAL');
eq('message', r.status.message, '일치 1건 / 결제 2건 - 불일치 있음');
eq('rows', r.rows.length, 1);
eq('price', r.rows[0].price, 5000);
eq('payCount', r.meta.payCount, 2);
eq('matchCount', r.meta.matchCount, 1);
eq('canDownload', r.status.canDownload, false);

console.log('===== T7 : 대량 주문 45건 (제한 해제) =====');
{
  const cartL = [], payL = [];
  for (let i = 1; i <= 45; i++) {
    const n = '대량상품' + String(i).padStart(2, '0');
    cartL.push(n, '옵션: 색' + i, '내일(금) 도착', '1,000', '원', '1', '');
    payL.push(n + ', 색' + i, '수량 1개 / 무료배송');
  }
  payL.push('총 상품 가격', '45,000원', '총 결제 금액', '45,000원');
  r = P.parse(cartL.join('\n'), payL.join('\n'));
  eq('code', r.status.code, 'OK');
  eq('payCount', r.meta.payCount, 45);
  eq('rows', r.rows.length, 45);
  eq('priceSum', r.priceSum, 45000);
  eq('message', r.status.message, '일치 45건 반영 완료 (45,000원)');
}

console.log('===== T8 : 금액 불일치 경고 =====');
const payBad = paySingle.split('49,500원').join('40,000원');
r = P.parse(cartSingle, payBad);
eq('code', r.status.code, 'WARN');
eq('message', r.status.message, '금액 확인: 내역합계 49,500원 / 총상품가격 40,000원 / 총결제 40,000원');
eq('canDownload', r.status.canDownload, false);

console.log('');
console.log('===== RESULT: PASS=' + pass + ' FAIL=' + fail + ' =====');
process.exit(fail > 0 ? 1 : 0);
