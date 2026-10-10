(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdufineParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_LINES = 2000;

  function xtrim(s) {
    return String(s).replace(/ {2,}/g, ' ').trim();
  }

  function splitLines(text) {
    if (text == null) return [];
    return String(text).replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_LINES);
  }

  function fmt(n) {
    return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  }

  function money(v) {
    var s = xtrim(v).replace(/원/g, '').replace(/,/g, '');
    if (s === '') return null;
    var n = Number(s);
    return isNaN(n) ? null : n;
  }

  function labeledAmount(lines, label) {
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i].indexOf(label);
      if (p < 0) continue;
      var cands = [
        xtrim(lines[i].slice(p + label.length)),
        xtrim(lines[i + 1] || ''),
        xtrim(lines[i + 2] || '')
      ];
      for (var j = 0; j < cands.length; j++) {
        var m = money(cands[j]);
        if (m !== null) return m;
      }
      return null;
    }
    return null;
  }

  function nearestAbove(lines, i) {
    for (var k = i - 1; k >= 0; k--) {
      if (lines[k] !== '') return xtrim(lines[k]);
    }
    return '';
  }

  function cartHelpers(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') { out.push({ F: '', G: '', H: '' }); continue; }
      var p = line.indexOf('옵션:');
      var F, G;
      if (p >= 0) {
        F = xtrim(line.slice(0, p));
        G = xtrim(line.slice(p + 3));
      } else {
        F = xtrim(line);
        var nxt = lines[i + 1];
        G = (nxt != null && nxt.slice(0, 3) === '옵션:') ? xtrim(nxt.slice(3)) : '';
      }
      var H = F === '' ? '' : (G === '' ? F : F + ', ' + G);
      out.push({ F: F, G: G, H: H });
    }
    return out;
  }

  function paymentItems(lines) {
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var p = line.indexOf('수량');
      if (p < 0) continue;
      var inline = xtrim(line.slice(0, p));
      var name = inline !== '' ? inline : nearestAbove(lines, i);
      var qty = null;
      var g = line.indexOf('개', p);
      if (g >= 0) {
        var qs = xtrim(line.slice(p + 2, g));
        if (qs !== '') {
          var n = Number(qs);
          if (!isNaN(n)) qty = n;
        }
      }
      items.push({ lineIdx: i, name: name, qty: qty });
    }
    return items;
  }

  function parse(cartText, paymentText) {
    var cartLines = splitLines(cartText);
    var payLines = splitLines(paymentText);
    var payItems = paymentItems(payLines);
    var payCount = payItems.length;
    var cartContent = 0;
    for (var ci = 0; ci < cartLines.length; ci++) if (cartLines[ci] !== '') cartContent++;
    var totalGoods = labeledAmount(payLines, '총 상품 가격');
    var totalPaid = labeledAmount(payLines, '총 결제 금액');
    var helpers = cartHelpers(cartLines);

    var items = [];
    var matchCount = 0;
    for (var k = 0; k < payItems.length; k++) {
      var it = payItems[k];
      var rec = {
        no: 0, payIdx: k, name: it.name, qty: it.qty,
        status: '', cartIdx: -1, nameOut: '', spec: '',
        price: null, unitPrice: null
      };
      if (it.name !== '') {
        var m = -1;
        for (var i1 = 0; i1 < helpers.length; i1++) {
          if (xtrim(helpers[i1].H) === xtrim(it.name)) { m = i1; break; }
        }
        if (m < 0) {
          var tn = xtrim(it.name);
          for (var i2 = 0; i2 < helpers.length; i2++) {
            var tf = xtrim(helpers[i2].F);
            if (tf !== '' && tf.length >= 5 && tn.indexOf(tf) === 0) { m = i2; break; }
          }
        }
        if (m >= 0) {
          rec.status = '일치';
          rec.cartIdx = m;
          rec.nameOut = helpers[m].F;
          rec.spec = helpers[m].G;
          matchCount++;
          var P = -1;
          for (var a = m + 1; a <= m + 15 && a < cartLines.length; a++) {
            if (cartLines[a].indexOf('도착') >= 0) { P = a; break; }
          }
          if (P >= 0) {
            var Q = -1;
            for (var b = P + 1; b <= P + 8 && b < cartLines.length; b++) {
              var tb = xtrim(cartLines[b]);
              if (tb.slice(0, 2) === '0.' || tb.slice(-1) === '%') { Q = b; break; }
            }
            var R = -1;
            var start = Q >= 0 ? Q : P;
            for (var c = start + 1; c <= start + 10 && c < cartLines.length; c++) {
              var s = xtrim(cartLines[c]);
              if (s !== '' && s !== '할인' && s !== '원' && s.slice(0, 1) !== '(') { R = c; break; }
            }
            if (R >= 0) rec.price = money(cartLines[R]);
          }
        } else {
          rec.status = '불일치';
        }
      }
      items.push(rec);
    }

    var rows = [];
    var no = 0;
    for (var k2 = 0; k2 < items.length; k2++) {
      var r = items[k2];
      if (r.status !== '일치') continue;
      no++;
      r.no = no;
      r.unitPrice = (r.price !== null && typeof r.qty === 'number' && r.qty !== 0) ? r.price / r.qty : null;
      rows.push(r);
    }

    var qtySum = 0;
    var priceSum = 0;
    for (var k3 = 0; k3 < rows.length; k3++) {
      if (typeof rows[k3].qty === 'number') qtySum += rows[k3].qty;
      if (rows[k3].price !== null) priceSum += rows[k3].price;
    }

    var code, message, canDownload = false;
    if (payCount === 0) {
      code = 'EMPTY_PAY';
      message = '결제 페이지 텍스트를 붙여넣으세요';
    } else if (cartContent === 0) {
      code = 'EMPTY_CART';
      message = '장바구니 텍스트를 붙여넣으세요';
    } else if (matchCount === 0) {
      code = 'NO_MATCH';
      message = '장바구니와 일치하는 상품 없음';
    } else if (matchCount < payCount) {
      code = 'PARTIAL';
      message = '일치 ' + matchCount + '건 / 결제 ' + payCount + '건 - 불일치 있음';
    } else if (priceSum === totalGoods || (totalPaid !== null && priceSum === totalPaid)) {
      code = 'OK';
      message = '일치 ' + matchCount + '건 반영 완료 (' + fmt(priceSum) + '원)';
      canDownload = true;
    } else {
      code = 'WARN';
      message = '금액 확인: 내역합계 ' + fmt(priceSum) + '원 / 총상품가격 ' +
        (totalGoods === null ? '-' : fmt(totalGoods)) + '원 / 총결제 ' +
        (totalPaid === null ? '-' : fmt(totalPaid)) + '원';
    }

    return {
      status: { code: code, message: message, canDownload: canDownload },
      rows: rows,
      qtySum: qtySum,
      priceSum: priceSum,
      meta: {
        payCount: payCount,
        matchCount: matchCount,
        totalGoods: totalGoods,
        totalPaid: totalPaid,
        cartLines: cartContent
      }
    };
  }

  return { parse: parse, fmt: fmt };
});
