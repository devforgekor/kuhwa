(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EdufineExcel = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var HEADERS = ['순번', '* 내용', 'S2B물품번호', '규격', '수량', '단위', '예상단가', '* 예상금액', '수수료'];
  var WIDTHS = [6, 50, 14, 20, 7, 6, 12, 13, 10];
  var NOTE = '※ 내용/규격/예상금액은 장바구니 기준, 수량은 결제 기준 (양쪽 일치 상품만)';
  var MIN_ROWS = 10;
  var HDR_ROW = 3;

  function build(result) {
    var ExcelJS = (root && root.ExcelJS) || (typeof globalThis !== 'undefined' && globalThis.ExcelJS);
    if (!ExcelJS) throw new Error('ExcelJS not loaded');
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('품목내역', { views: [{ state: 'frozen', ySplit: HDR_ROW }] });

    for (var w = 0; w < WIDTHS.length; w++) ws.getColumn(w + 1).width = WIDTHS[w];

    ws.mergeCells('A1:I1');
    var a1 = ws.getCell('A1');
    a1.value = '품목내역';
    a1.font = { bold: true, size: 14 };

    ws.mergeCells('A2:I2');
    var a2 = ws.getCell('A2');
    a2.value = NOTE;
    a2.font = { color: { argb: 'FF808080' } };

    for (var h = 0; h < HEADERS.length; h++) ws.getCell(HDR_ROW, h + 1).value = HEADERS[h];

    var rows = result.rows || [];
    var n = Math.max(MIN_ROWS, rows.length);
    var sumRow = HDR_ROW + 1 + n;
    for (var j = 0; j < rows.length; j++) {
      var rec = rows[j];
      var r = HDR_ROW + 1 + j;
      ws.getCell(r, 1).value = rec.no;
      ws.getCell(r, 2).value = rec.nameOut || '';
      ws.getCell(r, 4).value = rec.spec || '';
      if (typeof rec.qty === 'number') ws.getCell(r, 5).value = rec.qty;
      ws.getCell(r, 6).value = '개';
      if (rec.unitPrice !== null && rec.unitPrice !== undefined) ws.getCell(r, 7).value = rec.unitPrice;
      if (rec.price !== null && rec.price !== undefined) ws.getCell(r, 8).value = rec.price;
    }

    if (rows.length > 0) {
      ws.getCell(sumRow, 2).value = '합계';
      ws.getCell(sumRow, 5).value = result.qtySum;
      ws.getCell(sumRow, 8).value = result.priceSum;
    }

    for (var rr = HDR_ROW; rr <= sumRow; rr++) {
      for (var cc = 1; cc <= 9; cc++) {
        var cell = ws.getCell(rr, cc);
        var al = { vertical: 'center' };
        if (rr === HDR_ROW) al.horizontal = 'center';
        else if (cc === 1 || (cc >= 3 && cc <= 6) || cc === 9) al.horizontal = 'center';
        else if (cc === 2) al.wrapText = true;
        cell.alignment = al;
        cell.border = {
          top: { style: 'medium' },
          left: { style: 'medium' },
          right: { style: 'medium' },
          bottom: { style: 'medium' }
        };
        if (rr === HDR_ROW) {
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
        }
        if (rr === sumRow) {
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
        }
        if (cc === 7 || cc === 8) cell.numFmt = '#,##0';
      }
    }

    ws.getRow(HDR_ROW).height = 22;
    ws.getColumn(3).hidden = true;

    return wb;
  }

  function filename() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return '품목내역_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.xlsx';
  }

  async function download(result) {
    var wb = build(result);
    var buf = await wb.xlsx.writeBuffer();
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  return { build: build, download: download, filename: filename };
});
