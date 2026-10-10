(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var cartEl = $('cart'), payEl = $('pay');
  var statusEl = $('status'), resultEl = $('result');
  var tbodyEl = $('tbody'), qtySumEl = $('qtySum'), amtSumEl = $('amtSum');
  var metaEl = $('meta'), dlBtn = $('download'), hintEl = $('hint');

  var lastResult = null;
  var timer = null;

  function renderEmpty() {
    statusEl.hidden = true;
    resultEl.hidden = true;
    lastResult = null;
  }

  function run() {
    var cart = cartEl.value, pay = payEl.value;
    if (cart === '' && pay === '') { renderEmpty(); return; }

    var res;
    try {
      res = EdufineParser.parse(cart, pay);
    } catch (e) {
      statusEl.textContent = '파싱 오류: ' + e.message;
      statusEl.className = 'status err';
      statusEl.hidden = false;
      resultEl.hidden = true;
      lastResult = null;
      return;
    }
    lastResult = res;

    statusEl.textContent = res.status.message;
    statusEl.className = 'status ' + ({
      OK: 'ok', WARN: 'warn', PARTIAL: 'warn',
      NO_MATCH: 'err', EMPTY_PAY: 'info', EMPTY_CART: 'info'
    }[res.status.code] || 'info');
    statusEl.hidden = false;

    tbodyEl.innerHTML = '';
    for (var i = 0; i < res.rows.length; i++) {
      var r = res.rows[i];
      var tr = document.createElement('tr');
      var vals = [
        String(r.no),
        r.nameOut || '',
        r.spec || '',
        typeof r.qty === 'number' ? String(r.qty) : '',
        '개',
        r.unitPrice !== null && r.unitPrice !== undefined ? EdufineParser.fmt(r.unitPrice) : '',
        r.price !== null && r.price !== undefined ? EdufineParser.fmt(r.price) : ''
      ];
      for (var c = 0; c < vals.length; c++) {
        var td = document.createElement('td');
        td.textContent = vals[c];
        if (c === 1 || c === 2) td.className = 'left';
        tr.appendChild(td);
      }
      tbodyEl.appendChild(tr);
    }
    qtySumEl.textContent = res.rows.length > 0 ? EdufineParser.fmt(res.qtySum) : '';
    amtSumEl.textContent = res.rows.length > 0 ? EdufineParser.fmt(res.priceSum) : '';

    var m = res.meta;
    metaEl.textContent = '결제 ' + m.payCount + '건 · 일치 ' + m.matchCount + '건 · 총 상품 가격 ' +
      (m.totalGoods === null ? '-' : EdufineParser.fmt(m.totalGoods)) + '원 · 총 결제 ' +
      (m.totalPaid === null ? '-' : EdufineParser.fmt(m.totalPaid)) + '원';

    dlBtn.disabled = !res.status.canDownload;
    hintEl.textContent = res.status.canDownload
      ? ''
      : '다운로드는 검증 통과 시에만 가능합니다';
    resultEl.hidden = false;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 400);
  }

  function pasteInto(el) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      el.focus();
      alert('이 브라우저는 자동 붙여넣기를 지원하지 않습니다. Ctrl+V로 붙여넣어 주세요.');
      return;
    }
    navigator.clipboard.readText().then(function (t) {
      el.value = t;
      run();
    }).catch(function () {
      el.focus();
    });
  }

  $('pasteCart').addEventListener('click', function () { pasteInto(cartEl); });
  $('pastePay').addEventListener('click', function () { pasteInto(payEl); });
  $('clearCart').addEventListener('click', function () { cartEl.value = ''; run(); });
  $('clearPay').addEventListener('click', function () { payEl.value = ''; run(); });

  cartEl.addEventListener('input', schedule);
  payEl.addEventListener('input', schedule);

  dlBtn.addEventListener('click', function () {
    if (!lastResult || !lastResult.status.canDownload) return;
    dlBtn.disabled = true;
    EdufineExcel.download(lastResult).catch(function (e) {
      alert('엑셀 생성 오류: ' + e.message);
    }).finally(function () {
      dlBtn.disabled = !lastResult || !lastResult.status.canDownload;
    });
  });
})();
