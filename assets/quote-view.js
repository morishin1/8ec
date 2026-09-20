/* ===================================================================
   お客様向けの見積ページ（/q/:token）の中身。

   ・読み書きは /api/quote-view と /api/quote-decide を通す。
     Supabaseを直接たたかないのは、Slack通知をサーバー側で出すため。
   ・原価・粗利・社内メモ・在庫数・管理番号は、そもそも受け取らない。
   ・［この内容で進める］は契約ではない。押したあとも、
     契約・決済・機器の確保は起きない（そう書いてある）。
   =================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var yen = function (n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); };
  var KIND = {
    sale: '販売', rental: 'レンタル', setup: '初期設定費', kitting: 'キッティング費',
    install: '現地設置費', network: 'ネットワーク費', service_monthly: '月額サービス',
    training: '研修', other: 'その他'
  };

  var token = decodeURIComponent(location.pathname.replace(/\.html$/, '').replace(/^\/q\/?/, '').replace(/\/$/, ''))
    || new URLSearchParams(location.search).get('t') || '';

  function track(name, extra) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name, page: 'quote-view' }, extra || {}));
    } catch (_) { /* 計測でページを壊さない */ }
  }

  function card(inner) { return '<div class="card">' + inner + '</div>'; }

  function notFound(msg) {
    $('host').innerHTML = card(
      '<h1 style="margin:0;font-size:22px;letter-spacing:-.02em">お見積りを表示できません</h1>'
      + '<div class="warn">' + esc(msg) + '</div>'
      + '<p style="font-size:13px;color:#6C6E64;margin-top:16px">'
      + 'お手数ですが、担当者（03-6433-5025 平日9:00〜18:00）までお問い合わせください。</p>');
  }

  function rows(items) {
    return items.map(function (i) {
      var monthly = i.billing === 'monthly';
      return '<tr>'
        + '<td><span class="kind' + (monthly ? ' m' : '') + '">' + esc(KIND[i.kind] || i.kind) + '</span></td>'
        + '<td><div class="nm">' + esc(i.name) + '</div>'
          + (i.spec ? '<div class="sp">' + esc(i.spec) + '</div>' : '')
          + (i.note ? '<div class="sp">' + esc(i.note) + '</div>' : '') + '</td>'
        + '<td class="r num">' + i.qty + '</td>'
        + '<td class="r num hide">' + yen(i.unit_price) + (monthly ? '<div class="sp">／月</div>' : '') + '</td>'
        + '<td class="r num hide">' + (monthly ? (i.months || 1) + 'ヶ月' : '—') + '</td>'
        + '<td class="r num"><b>' + yen(i.amount) + '</b>'
          + (monthly ? '<div class="sp">' + yen(i.unit_price * i.qty) + '／月</div>' : '') + '</td>'
        + '</tr>';
    }).join('');
  }

  function render(q) {
    var t = q.totals || {};
    var who = [q.company, q.customer_name ? q.customer_name + ' 様' : ''].filter(Boolean).join('　');
    $('who').textContent = who;

    var head = '<div class="qhead">'
      + '<h1>' + esc(q.title || 'お見積り') + '</h1>'
      + '<div><div class="no">' + esc(q.quote_no) + (q.rev > 1 ? '（第' + q.rev + '版）' : '') + '</div></div>'
      + '</div>'
      + '<div class="qmeta">'
      + (who ? '<div>宛先：<b>' + esc(who) + '</b></div>' : '')
      + (q.valid_until ? '<div>有効期限：<b>' + esc(q.valid_until) + '</b></div>' : '')
      + '<div>消費税率：<b>' + Number(q.tax_rate || 10) + '%</b></div>'
      + '</div>';

    var table = '<table><thead><tr>'
      + '<th>種類</th><th>内容</th><th class="r">数量</th><th class="r hide">単価（税抜）</th>'
      + '<th class="r hide">期間</th><th class="r">金額（税抜）</th></tr></thead>'
      + '<tbody>' + rows(q.items || []) + '</tbody></table>';

    // 初期費用と月額をはっきり分ける（月額が総額に埋もれないように）
    var sum = '<div class="sum">'
      + '<div class="box on"><div class="k">初期費用（税抜）</div><div class="v num">' + yen(t.initial_total) + '</div>'
        + '<div class="note">機器の購入・設定・設置など、最初にかかるぶんです。</div></div>'
      + (t.monthly_total ? '<div class="box on"><div class="k">月額費用（税抜）</div>'
          + '<div class="v num">' + yen(t.monthly_total) + '<small>／月</small></div>'
          + '<div class="note">' + (t.months ? '利用期間 ' + t.months + 'ヶ月　期間総額 ' + yen(t.monthly_period_total) + '（税抜）' : '') + '</div></div>' : '')
      + '</div>';

    var tot = '<div class="tot">'
      + '<div class="lbl">小計（税抜）</div><div class="val num">' + yen(t.subtotal) + '</div>'
      + '<div class="lbl">消費税（' + Number(q.tax_rate || 10) + '%）</div><div class="val num">' + yen(t.tax) + '</div>'
      + '<div class="lbl grand">税込総額</div><div class="val grand num">' + yen(t.total) + '</div>'
      + '</div>';

    var note = q.note ? '<div class="note-b">' + esc(q.note) + '</div>' : '';

    var actions = '';
    if (q.status === '承認') {
      actions = '<div class="actions"><div class="info"><b>この内容で進めるご連絡をいただきました。</b><br>'
        + '担当者より契約手続きのご案内をします。'
        + 'この時点では、契約・決済・機器の確保は完了していません。</div></div>';
    } else if (q.status === '相談中') {
      actions = '<div class="actions"><div class="info"><b>ご相談を承りました。</b><br>'
        + '担当者が内容を確認して、1〜2営業日以内にご連絡します。</div></div>';
    } else if (!q.decidable) {
      var why = q.expired ? 'この見積は有効期限を過ぎています。担当者へお問い合わせください。'
        : q.newer_exists ? '新しい見積が発行されています。最新のお見積りURLをご確認いただくか、担当者へお問い合わせください。'
        : 'このお見積りは、現在お手続きいただけません（' + esc(q.status) + '）。担当者へお問い合わせください。';
      actions = '<div class="actions"><div class="warn">' + why + '</div></div>';
    } else {
      actions = '<div class="actions">'
        + '<h2>この内容でよろしいですか？</h2>'
        + '<p><b>この操作だけでは契約・決済・機器の確保は完了しません。</b>担当者より契約手続きのご案内をします。'
        + 'ご不明な点や変更したい点があれば、「内容について相談する」からお知らせください。</p>'
        + '<div class="btns">'
        + '<button class="btn lime" id="goOk">この内容で進める</button>'
        + '<button class="btn ghost" id="goAsk">内容について相談する</button>'
        + '<button class="btn ghost" onclick="window.print()">印刷 / PDF保存</button>'
        + '</div><div id="formHost"></div></div>';
    }

    if (q.newer_exists && q.decidable) {
      actions = '<div class="actions"><div class="warn">新しい見積が発行されています。'
        + 'お手数ですが、最新のお見積りURLをご確認ください。</div></div>' + actions;
    }

    $('host').innerHTML = card(head + table + sum + tot + note + actions);
    bind(q);
    track('quote_view', { quote_no: q.quote_no, status: q.status, decidable: !!q.decidable });
  }

  function bind(q) {
    var ok = $('goOk'), ask = $('goAsk');
    if (ok) ok.onclick = function () { form(q, 'approve'); };
    if (ask) ask.onclick = function () { form(q, 'consult'); };
  }

  function form(q, action) {
    var isOk = action === 'approve';
    $('formHost').innerHTML = '<div class="info" style="margin-top:18px">'
      + '<b>' + (isOk ? 'この内容で進める' : '内容について相談する') + '</b>'
      + (isOk ? '<div style="margin-top:6px">この操作だけでは契約・決済・機器の確保は完了しません。'
                + '担当者より契約手続きのご案内をします。</div>' : '')
      + '<div style="margin-top:14px">'
      + '<label class="field"><span>ご担当者名<span class="req">必須</span></span>'
        + '<input class="input" id="dName" autocomplete="name" placeholder="山田 太郎"></label>'
      + '<label class="field"><span>会社名</span>'
        + '<input class="input" id="dCompany" autocomplete="organization" placeholder="株式会社○○"></label>'
      + (isOk ? '' : '<label class="field"><span>ご相談の内容</span>'
        + '<textarea class="input" id="dMsg" placeholder="例）台数を10台に減らしたい／納期を早められますか"></textarea></label>')
      + '<div id="dAlert"></div>'
      + '<button class="btn ' + (isOk ? 'lime' : '') + '" id="dSend">'
        + (isOk ? 'この内容で進める' : 'この内容で相談する') + '</button>'
      + '</div></div>';
    $('dSend').onclick = function () { send(q, action); };
    $('dName').focus();
    track('quote_decide_open', { quote_no: q.quote_no, action: action });
  }

  async function send(q, action) {
    var name = ($('dName').value || '').trim();
    if (!name) {
      $('dAlert').innerHTML = '<div class="warn" style="margin:0 0 12px">ご担当者名を入力してください。</div>';
      $('dName').focus();
      return;
    }
    var btn = $('dSend');
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = '送信中…';
    try {
      var res = await fetch('/api/quote-decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token, action: action, name: name,
          company: ($('dCompany') || {}).value || '',
          message: ($('dMsg') || {}).value || ''
        })
      });
      var out = {};
      try { out = await res.json(); } catch (_) { /* JSONでない応答はステータスで判断する */ }
      if (!res.ok || out.error) throw new Error(out.error || ('HTTP ' + res.status));
      track('quote_decided', { quote_no: q.quote_no, action: action });
      $('host').innerHTML = card('<div class="done"><div class="ic">✓</div>'
        + '<h1 style="font-size:21px;margin:0 0 10px;letter-spacing:-.02em">'
        + (action === 'approve' ? 'ありがとうございます。承りました。' : 'ご相談を承りました。') + '</h1>'
        + '<p style="font-size:14px;color:#4A4C43;line-height:1.9;margin:0 auto;max-width:34em">'
        + (action === 'approve'
            ? '担当者より契約手続きのご案内をします。<br><b>この時点では、契約・決済・機器の確保は完了していません。</b>'
              + '内容の変更もまだ承れますので、お気軽にご連絡ください。'
            : '担当者が内容を確認し、1〜2営業日以内にご連絡します。')
        + '<br>お急ぎの場合は 03-6433-5025（平日9:00〜18:00）までお電話ください。</p></div>');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      $('dAlert').innerHTML = '<div class="warn" style="margin:0 0 12px">送信できませんでした（'
        + esc(err.message) + '）。お手数ですが、担当者へご連絡ください。</div>';
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  (async function main() {
    if (!token || token.length < 20) { notFound('URLが正しくありません。'); return; }
    try {
      var res = await fetch('/api/quote-view?t=' + encodeURIComponent(token));
      var q = await res.json();
      if (!res.ok || !q || q.found === false) {
        notFound('このお見積りは見つかりませんでした。URLをご確認ください。');
        return;
      }
      if (q.viewable === false) {
        notFound(q.reason === 'token_expired'
          ? 'このお見積りURLは期限が切れています。担当者へお問い合わせください。'
          : 'このお見積りは現在ご覧いただけません。');
        return;
      }
      render(q);
    } catch (_) {
      notFound('通信に失敗しました。時間をおいて再度お試しください。');
    }
  })();
})();
