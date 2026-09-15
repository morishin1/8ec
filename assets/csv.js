/* ========================================================================
   CSVの読み書き。管理画面どうしで同じ処理を二重に持たないためにここへ集約する。

     window.EightCsv.parse(text[, sep])   CSV文字列 → 行の配列
     window.EightCsv.build(rows[, sep])   行の配列 → CSV文字列
     window.EightCsv.decode(arrayBuffer)  文字コードを判別して文字列にする
     window.EightCsv.blob(text)           Excelでそのまま開けるBlobにする

   仕入先やモールから届くCSVは Shift_JIS のことが多い。ブラウザは TextDecoder で
   Shift_JIS を読めるので、UTF-8として読んで化けたら読み直す。
   書き出しは UTF-8 + BOM。Excelはこれで文字化けしない。
   ======================================================================== */
(function () {
  'use strict';

  /* RFC4180のCSV。改行やカンマを含む引用符つきの値に対応する。
     区切り文字を渡せばTSVも読める */
  function parse(text, sep) {
    sep = sep || ',';
    text = text.replace(/^﻿/, '');            // BOMは落とす
    var rows = [], row = [], val = '', quoted = false, i = 0;
    while (i < text.length) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { val += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        val += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === sep) { row.push(val); val = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(val); rows.push(row); row = []; val = ''; i++; continue; }
      val += c; i++;
    }
    if (val !== '' || row.length) { row.push(val); rows.push(row); }
    // 全部空の行は落とす（末尾の空行や、Excelが足す空行の対策）
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function cell(v, sep) {
    var s = (v == null ? '' : String(v));
    return /["\r\n]/.test(s) || s.indexOf(sep) >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function build(rows, sep) {
    sep = sep || ',';
    return rows.map(function (r) {
      return r.map(function (c) { return cell(c, sep); }).join(sep);
    }).join('\r\n') + '\r\n';
  }

  /* UTF-8として読んで U+FFFD が混ざるなら壊れている。Shift_JIS で読み直す */
  function decode(buf) {
    var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (utf8.indexOf('�') < 0) return { text: utf8, encoding: 'utf-8' };
    try {
      var sjis = new TextDecoder('shift_jis', { fatal: false }).decode(buf);
      if (sjis.indexOf('�') < 0) return { text: sjis, encoding: 'shift_jis' };
      var a = (utf8.match(/�/g) || []).length, b = (sjis.match(/�/g) || []).length;
      return b < a ? { text: sjis, encoding: 'shift_jis' } : { text: utf8, encoding: 'utf-8' };
    } catch (e) {
      return { text: utf8, encoding: 'utf-8' };
    }
  }

  function blob(text) {
    return new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  }

  /* ダウンロードは a要素を実際にDOMへ入れてから click する。
     revokeObjectURL をすぐ呼ぶとファイル名が失われる */
  function download(name, b) {
    var url = URL.createObjectURL(b);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  window.EightCsv = { parse: parse, build: build, decode: decode, blob: blob, download: download };
})();
