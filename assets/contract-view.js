/* ===================================================================
   お客様向けの契約手続きページ（/c/:token）

   ・読み書きは /api/contract-view と /api/contract-decide を通す。
     ブラウザから Supabase を直接呼ぶ経路は作らない。
   ・原価・粗利・社内メモ・在庫数・管理番号は、そもそも受け取らない。
   ・［この内容で契約手続きを進める］は契約成立ではない。
     担当者が中身を見てから契約を確定する。その旨を画面に必ず出す。
   =================================================================== */
(function () {
  'use strict';

  var token = (location.pathname.split('/c/')[1] || '').split('/')[0].split('?')[0];
  var q = null;                 // サーバーから受け取った契約の中身
  var step = 1;                 // いま何ステップ目か
  var STEPS = ['ご契約内容', '請求先', 'お届け先', 'お支払い方法', '最終確認'];

  // お客様が入力したもの（送るまでこの中だけに持つ）
  var form = {
    billingMode: 'same',        // same / other
    shippingMode: 'same',       // same / billing / other
    billing: {}, shipping: {},
    method: null, delivery: '', name: '', message: ''
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function yen(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }
  function card(inner) { return '<div class="card">' + inner + '</div>'; }
  var KIND = {
    sale: '販売', rental: 'レンタル', setup: '初期設定費', kitting: 'キッティング費',
    install: '現地設置・配線費', network: 'ネットワーク構築費', service_monthly: '月額サービス',
    training: '研修', other: 'その他'
  };

  function track(name, detail) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, detail || {}));
    } catch (_) { /* 計測でページを壊さない */ }
  }

  /* ---- 開けないときの画面 ---- */
  function cannot(title, body) {
    $('host').innerHTML = card('<div class="warn"><b>' + esc(title) + '</b><br>' + esc(body) + '</div>');
  }

  /* ---- ステップの見出し ---- */
  function stepsHtml() {
    return '<div class="steps">' + STEPS.map(function (s, n) {
      var cls = n + 1 < step ? ' done' : (n + 1 === step ? ' now' : '');
      return '<span class="stp' + cls + '">' + (n + 1) + '. ' + esc(s) + '</span>';
    }).join('<span class="sarrow">›</span>') + '</div>';
  }

  /* ---- STEP 1 ご契約内容（見るだけ） ---- */
  function step1() {
    var t = q.totals || {};
    var rows = (q.items || []).map(function (x) {
      var monthly = x.billing === 'monthly';
      return '<tr>'
        + '<td><span class="kind' + (monthly ? ' m' : '') + '">' + esc(KIND[x.kind] || x.kind) + '</span></td>'
        + '<td><div class="nm">' + esc(x.name) + '</div>'
        + (x.spec ? '<div class="sp">' + esc(x.spec) + '</div>' : '') + '</td>'
        + '<td class="r num">' + x.qty + '</td>'
        + '<td class="r num hide">' + yen(x.unit_price) + (monthly ? '<div class="sp">／月</div>' : '') + '</td>'
        + '<td class="r num hide">' + (monthly ? (x.months || 1) + 'ヶ月' : '—') + '</td>'
        + '<td class="r num"><b>' + yen(x.amount) + '</b></td>'
        + '</tr>';
    }).join('');

    return card(stepsHtml()
      + '<div class="qhead"><h1>' + esc(q.title || 'ご契約内容') + '</h1>'
      + '<div class="no">' + esc(q.contract_no || '') + '</div></div>'
      + '<div class="qmeta">'
      + '<div>ご契約先：<b>' + esc(q.company || '') + '</b>'
      + (q.customer_name ? '　' + esc(q.customer_name) + ' 様' : '') + '</div>'
      + (q.start_date ? '<div>ご利用開始：<b>' + esc(q.start_date) + '</b></div>' : '')
      + (q.end_date ? '<div>ご利用終了：<b>' + esc(q.end_date) + '</b></div>' : '')
      + (q.months ? '<div>ご利用期間：<b>' + q.months + 'ヶ月</b></div>' : '')
      + '</div>'
      + '<table><thead><tr><th>区分</th><th>内容</th><th class="r">数量</th>'
      + '<th class="r hide">単価（税抜）</th><th class="r hide">期間</th><th class="r">金額（税抜）</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="sum">'
      + '<div class="box"><div class="k">初期費用（税抜）</div><div class="v num">' + yen(t.initial_total) + '</div>'
      + '<div class="note">機器・設定・設置など、最初にかかるぶんです。</div></div>'
      + (t.monthly_total ? '<div class="box on"><div class="k">月額費用（税抜）</div>'
        + '<div class="v num">' + yen(t.monthly_total) + '<small>／月</small></div>'
        + '<div class="note">ご利用期間 ' + (t.months || 0) + 'ヶ月　期間総額 '
        + yen(t.monthly_period_total) + '（税抜）</div></div>' : '')
      + '</div>'
      + '<div class="tot">'
      + '<div class="lbl">小計（税抜）</div><div class="val num">' + yen(t.subtotal) + '</div>'
      + '<div class="lbl">消費税（' + (Number(q.tax_rate || 10)) + '%）</div><div class="val num">' + yen(t.tax) + '</div>'
      + '<div class="lbl grand">税込総額</div><div class="val grand num">' + yen(t.total) + '</div>'
      + '</div>'
      + (q.note ? '<div class="note-b">' + esc(q.note) + '</div>' : '')
      + '<div class="info">金額・商品名・数量はこのページでは変更できません。'
      + '変更が必要なときは担当者へご連絡ください。</div>'
      + '<div class="btns" style="margin-top:22px"><button class="btn" id="n1">請求先の確認へ進む</button></div>');
  }

  /* ---- STEP 2 請求先 ---- */
  function step2() {
    var b = form.billing;
    return card(stepsHtml()
      + '<h1 style="margin:0 0 6px;font-size:21px;letter-spacing:-.02em">請求先</h1>'
      + '<p style="margin:0 0 18px;font-size:13.5px;color:var(--c-body)">'
      + '請求書のお届け先です。ご契約先と同じでよろしければ、そのまま次へお進みください。</p>'
      + '<div class="pick">'
      + radio('bmode', 'same', 'ご契約先と同じ', esc(q.company || ''), form.billingMode === 'same')
      + radio('bmode', 'other', '別の請求先を指定する', '本社の経理部、親会社、自治体の担当課など', form.billingMode === 'other')
      + '</div>'
      + '<div id="bwrap" style="display:' + (form.billingMode === 'other' ? 'block' : 'none') + '">'
      + fld('bCompany', '請求先の会社名・団体名', b.company, '例）○○市役所', true)
      + '<div class="g2">' + fld('bDept', '部署', b.department, '例）総務部 経理課')
      + fld('bPerson', 'ご担当者', b.person) + '</div>'
      + '<div class="g2">' + fld('bPostal', '郵便番号', b.postal_code, '150-0001')
      + fld('bEmail', '請求書の送付先メール', b.email, '', false, 'email') + '</div>'
      + fld('bAddr', 'ご住所', b.address)
      + fld('bNote', '請求についてのご連絡事項', b.note, '例）請求書は郵送でお願いします')
      + '</div>'
      + '<div class="btns" style="margin-top:22px">'
      + '<button class="btn ghost" id="p2">戻る</button>'
      + '<button class="btn" id="n2">お届け先の確認へ進む</button></div>');
  }

  /* ---- STEP 3 お届け先 ---- */
  function step3() {
    var s = form.shipping;
    return card(stepsHtml()
      + '<h1 style="margin:0 0 6px;font-size:21px;letter-spacing:-.02em">お届け先</h1>'
      + '<p style="margin:0 0 18px;font-size:13.5px;color:var(--c-body)">機器をお届けする場所です。</p>'
      + '<div class="pick">'
      + radio('smode', 'same', 'ご契約先と同じ', esc(q.company || ''), form.shippingMode === 'same')
      + radio('smode', 'billing', '請求先と同じ',
              form.billingMode === 'other' ? esc(form.billing.company || '') : esc(q.company || ''),
              form.shippingMode === 'billing')
      + radio('smode', 'other', '別のお届け先を指定する', '支店・現場・イベント会場など', form.shippingMode === 'other')
      + '</div>'
      + '<div id="swrap" style="display:' + (form.shippingMode === 'other' ? 'block' : 'none') + '">'
      + fld('sCompany', 'お届け先の会社名・拠点名', s.company, '例）渋谷オフィス', true)
      + '<div class="g2">' + fld('sDept', '部署', s.department) + fld('sPerson', 'お受け取りのご担当者', s.person) + '</div>'
      + '<div class="g2">' + fld('sPostal', '郵便番号', s.postal_code, '150-0001')
      + fld('sPhone', 'お電話番号', s.phone, '', false, 'tel') + '</div>'
      + fld('sAddr', 'ご住所', s.address)
      + fld('sNote', 'お届けについてのご連絡事項', s.note, '例）搬入は平日午前のみ可')
      + '</div>'
      + fld('sDate', 'お届け希望日', form.delivery, '', false, 'date')
      + '<div class="info">ご希望日です。在庫・調達の状況を確認したうえで、'
      + '担当者から確定日をご案内します。</div>'
      + '<div class="btns" style="margin-top:22px">'
      + '<button class="btn ghost" id="p3">戻る</button>'
      + '<button class="btn" id="n3">お支払い方法へ進む</button></div>');
  }

  /* ---- STEP 4 お支払い方法 ---- */
  var METHOD_NOTE = {
    '請求書払い': function () { return q.payment_terms || 'お支払い条件は担当者からご案内します。'; },
    '銀行振込': function () {
      return q.payment_timing === '前払い'
        ? 'お振込（前払い）です。ご入金の確認後にご用意いたします。'
        : (q.payment_timing === '後払い'
          ? 'お振込（後払い）です。納品後のお支払いとなります。'
          : '前払い・後払いは担当者からご案内します。');
    },
    'カード': function () { return '契約確定後、カード決済用のURLをご案内します。'; }
  };
  function step4() {
    var allow = q.allowed_payment_methods || [];
    return card(stepsHtml()
      + '<h1 style="margin:0 0 6px;font-size:21px;letter-spacing:-.02em">お支払い方法</h1>'
      + (allow.length
        ? '<p style="margin:0 0 18px;font-size:13.5px;color:var(--c-body)">'
          + 'ご希望のお支払い方法をお選びください。最終的なお支払い条件は、担当者が確認のうえご案内します。</p>'
          + '<div class="pick">' + allow.map(function (m) {
              return radio('pmethod', m, m, (METHOD_NOTE[m] || function () { return ''; })(), form.method === m);
            }).join('') + '</div>'
        : '<div class="info">お支払い方法は担当者からご案内します。このまま次へお進みください。</div>')
      + '<div class="btns" style="margin-top:22px">'
      + '<button class="btn ghost" id="p4">戻る</button>'
      + '<button class="btn" id="n4">最終確認へ進む</button></div>');
  }

  /* ---- STEP 5 最終確認 ---- */
  function addrText(mode, o, fallbackName) {
    if (mode === 'same') return 'ご契約先と同じ（' + (q.company || '') + '）';
    if (mode === 'billing') return '請求先と同じ（' + (fallbackName || '') + '）';
    var lines = [o.company, o.department, o.person,
      [o.postal_code ? '〒' + o.postal_code : '', o.address].filter(Boolean).join(' '),
      o.phone, o.email, o.note].filter(Boolean);
    return lines.join('\n') || '（未入力）';
  }
  function step5() {
    var t = q.totals || {};
    var bName = form.billingMode === 'other' ? (form.billing.company || '') : (q.company || '');
    return card(stepsHtml()
      + '<h1 style="margin:0 0 6px;font-size:21px;letter-spacing:-.02em">最終確認</h1>'
      + '<p style="margin:0 0 4px;font-size:13.5px;color:var(--c-body)">この内容で担当者へお送りします。</p>'
      + '<div class="recap">'
      + row('ご契約', (q.contract_no || '') + '　' + (q.title || ''), null)
      + row('金額', '初期費用 ' + yen(t.initial_total)
          + (t.monthly_total ? '\n月額 ' + yen(t.monthly_total) + '／月 × ' + (t.months || 0) + 'ヶ月' : '')
          + '\n税込総額 ' + yen(t.total), null)
      + row('ご利用期間', (q.start_date || '未定') + ' 〜 ' + (q.end_date || '未定'), null)
      + row('請求先', addrText(form.billingMode, form.billing), 2)
      + row('お届け先', addrText(form.shippingMode, form.shipping, bName), 3)
      + row('お届け希望日', form.delivery || '（指定なし）', 3)
      + row('お支払い方法', form.method || '（担当者にご相談）', 4)
      + '</div>'
      + '<div style="margin-top:20px">'
      + fld('cName', 'お手続きされる方のお名前', form.name, '例）田中 太郎', true)
      + fld('cMsg', '担当者へのご連絡事項（任意）', form.message, '', false, 'textarea')
      + '</div>'
      + '<div class="info"><b>この操作だけでは契約・決済・発送は完了しません。</b>'
      + '担当者が内容を確認後、契約手続きを確定します。</div>'
      + '<div id="cAlert"></div>'
      + '<div class="btns" style="margin-top:20px">'
      + '<button class="btn ghost" id="p5">戻って修正</button>'
      + '<button class="btn lime" id="send">この内容で契約手続きを進める</button></div>');
  }
  function row(k, v, goto) {
    return '<div class="row"><div class="k">' + esc(k) + '</div>'
      + '<div class="v">' + esc(v) + '</div>'
      + (goto ? '<div class="fix"><button class="lnk" data-goto="' + goto + '">直す</button></div>' : '')
      + '</div>';
  }

  /* ---- 部品 ---- */
  function radio(name, val, title, desc, on) {
    return '<label class="' + (on ? 'on' : '') + '">'
      + '<input type="radio" name="' + name + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '>'
      + '<span><span class="t">' + esc(title) + '</span>'
      + (desc ? '<span class="d">' + esc(desc) + '</span>' : '') + '</span></label>';
  }
  function fld(id, label, val, ph, req, type) {
    if (type === 'textarea') {
      return '<label class="field"><span>' + esc(label) + '</span>'
        + '<textarea class="input" id="' + id + '" rows="3">' + esc(val || '') + '</textarea></label>';
    }
    return '<label class="field"><span>' + esc(label)
      + (req ? '<span class="req">必須</span>' : '') + '</span>'
      + '<input class="input" id="' + id + '" type="' + (type || 'text') + '"'
      + ' value="' + esc(val || '') + '"'
      + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></label>';
  }
  function val(id) { var e = $(id); return e ? e.value.trim() : ''; }

  /* ---- 入力を取り込む ---- */
  function grab2() {
    form.billing = {
      company: val('bCompany'), department: val('bDept'), person: val('bPerson'),
      postal_code: val('bPostal'), address: val('bAddr'), email: val('bEmail'), note: val('bNote')
    };
  }
  function grab3() {
    form.shipping = {
      company: val('sCompany'), department: val('sDept'), person: val('sPerson'),
      postal_code: val('sPostal'), address: val('sAddr'), phone: val('sPhone'), note: val('sNote')
    };
    form.delivery = val('sDate');
  }

  /* ---- 描く ---- */
  function render() {
    var html = step === 1 ? step1() : step === 2 ? step2() : step === 3 ? step3()
      : step === 4 ? step4() : step5();
    $('host').innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    bind();
  }
  function go(n) { step = n; track('contract_step', { step: n, contract_no: q.contract_no }); render(); }

  function bind() {
    if ($('n1')) $('n1').onclick = function () { go(2); };
    if ($('p2')) $('p2').onclick = function () { grab2(); go(1); };
    if ($('n2')) $('n2').onclick = function () {
      grab2();
      if (form.billingMode === 'other' && !form.billing.company) {
        alert('請求先の会社名・団体名をご入力ください。'); return;
      }
      go(3);
    };
    if ($('p3')) $('p3').onclick = function () { grab3(); go(2); };
    if ($('n3')) $('n3').onclick = function () {
      grab3();
      if (form.shippingMode === 'other' && !form.shipping.company) {
        alert('お届け先の会社名・拠点名をご入力ください。'); return;
      }
      go(4);
    };
    if ($('p4')) $('p4').onclick = function () { go(3); };
    if ($('n4')) $('n4').onclick = function () {
      var allow = q.allowed_payment_methods || [];
      if (allow.length && !form.method) { alert('お支払い方法をお選びください。'); return; }
      go(5);
    };
    if ($('p5')) $('p5').onclick = function () { form.name = val('cName'); form.message = val('cMsg'); go(2); };
    if ($('send')) $('send').onclick = send;

    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.onclick = function () { form.name = val('cName'); form.message = val('cMsg'); go(Number(b.dataset.goto)); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=bmode]'), function (r) {
      r.onchange = function () { grab2(); form.billingMode = r.value; render(); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=smode]'), function (r) {
      r.onchange = function () { grab3(); form.shippingMode = r.value; render(); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=pmethod]'), function (r) {
      r.onchange = function () { form.method = r.value; render(); };
    });
  }

  /* ---- 送る ---- */
  async function send() {
    form.name = val('cName');
    form.message = val('cMsg');
    if (!form.name) {
      $('cAlert').innerHTML = '<div class="warn" style="margin:16px 0 0">お手続きされる方のお名前をご入力ください。</div>';
      $('cName').focus();
      return;
    }
    var btn = $('send');
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = '送信中…';

    // 「同じ」を選んだところは、そのまま空で送る（サーバー側で契約先と同じ扱いになる）
    var billing = form.billingMode === 'other' ? form.billing : {};
    var shipping = form.shippingMode === 'other' ? form.shipping
      : (form.shippingMode === 'billing' ? (form.billingMode === 'other' ? form.billing : {}) : {});

    try {
      var res = await fetch('/api/contract-decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token, name: form.name, billing: billing, shipping: shipping,
          method: form.method, desired_delivery_date: form.delivery || null,
          message: form.message || null
        })
      });
      var out = {};
      try { out = await res.json(); } catch (_) { /* JSONでない応答はステータスで判断する */ }
      if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
      track('contract_confirmed', { contract_no: q.contract_no });
      $('host').innerHTML = card('<div class="done"><div class="ic">✓</div>'
        + '<h1 style="font-size:21px;margin:0 0 10px;letter-spacing:-.02em">ありがとうございます。承りました。</h1>'
        + '<p style="font-size:14px;color:#4A4C43;line-height:1.9;margin:0 auto;max-width:34em">'
        + '担当者が内容を確認し、契約手続きを確定のうえご連絡します。<br>'
        + '<b>この時点では、契約・決済・発送は完了していません。</b><br>'
        + 'お急ぎの場合は 03-6433-5025（平日9:00〜18:00）までお電話ください。</p></div>');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      $('cAlert').innerHTML = '<div class="warn" style="margin:16px 0 0">'
        + esc(err.message) + '</div>';
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ---- 読み込み ---- */
  (async function load() {
    if (!token) { cannot('URLが正しくありません', '担当者へお問い合わせください。'); return; }
    try {
      var res = await fetch('/api/contract-view?t=' + encodeURIComponent(token));
      q = await res.json();
    } catch (_) {
      cannot('読み込めませんでした', 'お手数ですが、時間をおいて開き直してください。');
      return;
    }
    if (!q || !q.found) {
      cannot('このご契約は見つかりませんでした',
        'URLをご確認ください。お手数ですが、担当者（03-6433-5025 平日9:00〜18:00）までお問い合わせください。');
      return;
    }
    if (!q.viewable) {
      var m = {
        cancelled: ['この契約手続きは取り消されています', '担当者へお問い合わせください。'],
        expired: ['このURLの有効期限が切れています', '担当者へ新しいURLをご依頼ください。'],
        revoked: ['このURLは無効になっています', '最新のご案内をご確認ください。']
      }[q.reason] || ['このページは開けません', '担当者へお問い合わせください。'];
      cannot(m[0], m[1]);
      return;
    }
    $('who').textContent = (q.company || '') + (q.customer_name ? '　' + q.customer_name + ' 様' : '');

    // すでに送信済み・契約確定後は、フォームを出さない
    if (q.confirmed) {
      $('host').innerHTML = card('<div class="qhead"><h1>' + esc(q.title || 'ご契約手続き') + '</h1>'
        + '<div class="no">' + esc(q.contract_no || '') + '</div></div>'
        + '<div class="info" style="margin-top:18px">'
        + (q.settled
          ? '<b>契約手続きは完了しています。</b><br>担当者から今後のご案内をお送りします。'
          : '<b>内容を受け付けました。</b><br>担当者が確認しています。'
            + '<br>変更が必要な場合は担当者へご連絡ください。')
        + '</div>');
      track('contract_already', { contract_no: q.contract_no });
      return;
    }

    // 担当者がすでに入れている内容を初期値にする
    var b = q.billing || {}, s = q.shipping || {};
    if (b.company) { form.billingMode = 'other'; form.billing = b; }
    if (s.company) { form.shippingMode = 'other'; form.shipping = s; }
    if (q.desired_delivery_date) form.delivery = q.desired_delivery_date;
    if (q.requested_payment_method) form.method = q.requested_payment_method;

    track('contract_open', { contract_no: q.contract_no });
    render();
  })();
})();
