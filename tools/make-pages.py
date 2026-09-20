#!/usr/bin/env python3
"""下層ページ（/faq /cases /care /support /packs/*）を作る。

  どのページも同じ骨（共通ヘッダー・共通CSS・最後は3分診断）で、
  中身だけ差し替える。ここで作ったHTMLは tools/build-shell.py が
  ヘッダー・フッター・診断CTAを流し込んで仕上げる。

  書いてよいこと
    すでにサイトで案内している事実と、社内で決まっている運用だけ。
    決まっていない金額や条件は書かない（「ご相談ください」にする）。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HEAD = '''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://www.8ec.jp{url}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="COMMERCE（エイトコマース）">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{ogdesc}">
<meta property="og:url" content="https://www.8ec.jp{url}">
<meta property="og:locale" content="ja_JP">
<meta name="format-detection" content="telephone=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/shell.css">
<link rel="stylesheet" href="/assets/shop.css">
<style>
*{{box-sizing:border-box}}
html{{-webkit-text-size-adjust:100%}}
body{{margin:0;font-family:"Noto Sans JP",system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;
  color:var(--c-ink);background:#fff;line-height:1.75;font-feature-settings:"palt" 1}}
img{{max-width:100%;height:auto}}
h1{{font-size:clamp(28px,4vw,44px);letter-spacing:-.035em;line-height:1.22;margin:0}}
.page-hero{{background:var(--c-bg);border-bottom:1px solid var(--c-line)}}
.page-hero .in{{max-width:1240px;margin:0 auto;padding:54px 24px 46px}}
.page-hero p{{font-size:15.5px;line-height:1.9;color:var(--c-body);margin:16px 0 0;max-width:40em;text-wrap:pretty}}
.page-hero .row{{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}}
.crumb{{font-size:12px;color:var(--c-meta);margin-bottom:14px}}
.crumb a{{color:var(--c-meta)}}
main{{padding-bottom:10px}}
/* 質問と答え */
.qa{{border-top:1px solid var(--c-line)}}
.qa details{{border-bottom:1px solid var(--c-line);padding:4px 0}}
.qa summary{{display:flex;gap:12px;align-items:flex-start;cursor:pointer;padding:16px 0;font-size:16px;
  font-weight:700;line-height:1.6;list-style:none}}
.qa summary::-webkit-details-marker{{display:none}}
.qa summary::before{{content:"Q";flex:none;width:24px;height:24px;border-radius:50%;background:var(--c-ink);color:#fff;
  font-size:12px;display:flex;align-items:center;justify-content:center;margin-top:1px}}
.qa .a{{display:flex;gap:12px;padding:0 0 18px 0}}
.qa .a::before{{content:"A";flex:none;width:24px;height:24px;border-radius:50%;background:var(--c-lime);color:var(--c-ink);
  font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}}
.qa .a p{{margin:0;font-size:14.5px;line-height:1.95;color:var(--c-body)}}
/* 事例 */
.case{{border:1px solid var(--c-line);border-radius:4px;padding:24px 24px 20px;background:#fff}}
.case .tag{{display:inline-block;font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:2px;
  background:var(--c-lime-l);color:#43530E;margin-bottom:10px}}
.case h3{{margin:0 0 14px;font-size:20px;letter-spacing:-.02em;line-height:1.4}}
.case dl{{display:grid;grid-template-columns:7.5em 1fr;gap:9px 14px;margin:0;font-size:13.5px;line-height:1.8}}
.case dt{{color:var(--c-meta)}}
.case dd{{margin:0}}
.case .res{{margin-top:14px;padding-top:14px;border-top:1px solid var(--c-line);font-size:14px;line-height:1.85}}
.case .res b{{color:var(--c-lime-d)}}
.note-box{{border:1px solid var(--c-line);background:var(--c-bg);border-radius:3px;padding:16px 18px;
  font-size:13px;line-height:1.85;color:var(--c-body);margin-top:18px}}
.flow{{counter-reset:s;display:grid;gap:12px;margin-top:18px;padding:0;list-style:none}}
.flow li{{counter-increment:s;display:flex;gap:14px;align-items:flex-start;border:1px solid var(--c-line);
  border-radius:3px;background:#fff;padding:16px 18px}}
.flow li::before{{content:counter(s);flex:none;width:28px;height:28px;border-radius:50%;background:var(--c-ink);
  color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}}
.flow b{{display:block;font-size:15.5px;margin-bottom:4px}}
.flow p{{margin:0;font-size:13.5px;line-height:1.85;color:var(--c-body)}}
@media(max-width:560px){{
  .page-hero .in{{padding:38px 16px 34px}}
  .case{{padding:20px 18px 18px}}
  .case dl{{grid-template-columns:6.5em 1fr}}
}}
</style>
</head>
<body>
  <!-- SHELL:HEADER{active} -->
  <!-- /SHELL:HEADER -->
<main>
'''

TAIL = '''</main>
  <!-- SHELL:LEAD -->
  <!-- /SHELL:LEAD -->
  <!-- SHELL:FOOTER -->
  <!-- /SHELL:FOOTER -->
<script src="/assets/lead.js" defer></script>
</body>
</html>
'''


def page(name, title, desc, url, body, active='', ogdesc=None, extra_head=''):
    html = HEAD.format(title=title, desc=desc, url=url, ogdesc=ogdesc or desc[:110],
                       active=(':' + active) if active else '')
    if extra_head:
        html = html.replace('</head>', extra_head + '\n</head>')
    (ROOT / name).write_text(html + body + TAIL, encoding='utf-8')
    print('作った:', name)


# ============================================================
# /faq  よくある質問（AIにも引用されやすいよう、質問→短い答えの形でそろえる）
# ============================================================
FAQ = [
    ('レンタル', [
        ('最短でいつ届きますか。',
         '在庫がある機種は、ご注文確定から最短3営業日で出荷します。キッティングの内容や台数によって前後しますので、'
         'お急ぎの場合はご相談ください。故障時の代替機は最短翌営業日の出荷にも対応します。'),
        ('最短のレンタル期間は。',
         '1カ月からお借りいただけます。1台・1カ月のお試しもご用意しています。'
         '期間が決まっていない場合も、想定だけ伺えればご提案できます。'),
        ('PC以外の機器も一緒に借りられますか。',
         'サーバー・モニター・プロジェクター・タブレット・ネットワーク機器・周辺機器を同じ契約でまとめてお借りいただけます。'
         '返却日もそろえられますので、プロジェクト単位で管理しやすくなります。'),
        ('Officeは使えますか。',
         '対象PCでは月額に含まれます。Word・Excel・PowerPointを含むOffice環境をインストール済みでお届けしますので、'
         '別途ライセンスをご用意いただく必要はありません。対象かどうかは機種によりますので、ご希望をお知らせください。'),
        ('途中で台数を増やせますか。',
         '増やせます。同一機種の在庫がある場合は追加分のみ後から出荷します。'
         '契約期間は追加分から個別に起算しますので、返却日をそろえたい場合はご指定ください。'),
        ('在庫にない機種は借りられませんか。',
         '取り寄せでご用意できる場合があります。8RENTは在庫から選んでいただくサービスではなく、'
         'ご希望の機種・台数・期間を伺って、自社在庫と調達を組み合わせて用意するサービスです。'),
        ('申し込むと、その場で機器が確保されますか。',
         '確保されません。お申し込みは「ご希望の受付」で、在庫と調達状況を確認してから担当者がご案内します。'
         'ご希望台数をお知らせいただければ、用意できるかどうかをお返事します。'),
        ('返却のときは何をすればいいですか。',
         '回収キットをお送りします。返却後はデータを消去します。'
         'データ消去証明書が必要な場合は、お申し付けいただければ発行します。'),
    ]),
    ('購入', [
        ('新品と整備済みの違いは何ですか。',
         '新品はメーカー出荷状態の商品です。整備済みは、動作確認・清掃・初期化を済ませた中古品で、'
         '価格を抑えたい場合に向いています。どちらも法人向けにご用意できます。'),
        ('ここに無い機種も買えますか。',
         '国内大手ITディストリビューターの商品を幅広くお取り寄せできます。'
         '型番が決まっていなくても、用途と台数をお知らせいただければ構成からご提案します。'),
        ('法人価格はありますか。',
         '台数や構成に応じてお見積りします。掲載している価格は1台あたり・税抜で、'
         '複数台・キッティング込みのお見積りは別途ご案内します。最安値をうたうことはしていません。'),
        ('納期はどのくらいですか。',
         '在庫があるものは数営業日、お取り寄せは商品によって変わります。'
         'お見積りのときに、台数と構成にあわせた納期をご案内します。'),
        ('サイトからそのまま購入できますか。',
         'いまはご相談・お見積りを挟む形です。商品ページの「この商品を購入相談する」からご希望の台数をお知らせください。'
         'お見積りにご承諾いただいてからのご注文になります。'),
    ]),
    ('共通', [
        ('キッティング（初期設定）もお願いできますか。',
         'お願いいただけます。アカウント作成・指定ソフトの導入・セキュリティ設定まで済ませた状態で発送できます。'
         '台数がまとまる場合は、資産管理用のラベル貼付などもご相談ください。'),
        ('ネットワークやセキュリティもまとめて頼めますか。',
         'LAN配線の設計・Wi-Fi設計・ルーター/スイッチ/APの設定、ウイルス対策やVPNまで対応できます。'
         '現地での搬入・配線・接続確認は別途お見積りです。'),
        ('支払い方法は。',
         '請求書払い（月末締め翌月末払い）に対応しています。'
         'お支払い条件についてはお見積りのときにご案内します。'),
        ('購入とレンタル、どちらがよいか分かりません。',
         '利用期間と台数をお知らせいただければ、購入・レンタル・その組み合わせのどれが合うかを含めてご提案します。'
         '3分の無料診断からお送りいただくのがいちばん早いです。'),
        ('見積だけでも大丈夫ですか。',
         '大丈夫です。お見積りは無料で、その時点で費用も契約も発生しません。'
         '機器を押さえることもありませんので、比較検討の材料としてお使いください。'),
        ('AI研修・Office研修も頼めますか。',
         '承ります。生成AIを業務で使えるようにする研修と、Excel・Word・PowerPointの基礎研修をご用意しています。'
         '機器の導入とあわせてご依頼いただけます。'),
    ]),
]


def faq_body():
    import json
    blocks = []
    for cat, items in FAQ:
        qa = ''.join(
            f'''
        <details>
          <summary>{q}</summary>
          <div class="a"><p>{a}</p></div>
        </details>''' for q, a in items)
        blocks.append(f'''
    <div class="c-sec">
      <h2 class="c-h2">{cat}について</h2>
      <div class="qa" style="margin-top:14px">{qa}
      </div>
    </div>''')
    ld = {
        '@context': 'https://schema.org', '@type': 'FAQPage',
        'mainEntity': [
            {'@type': 'Question', 'name': q,
             'acceptedAnswer': {'@type': 'Answer', 'text': a}}
            for _, items in FAQ for q, a in items
        ]
    }
    head = f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>'
    body = f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　よくある質問</div>
      <h1>よくある質問</h1>
      <p>レンタル・購入・設定について、お問い合わせの多いものをまとめました。
        ここに無いことは、3分の無料診断か、お電話（03-6433-5025 平日9:00〜18:00）でお気軽にどうぞ。</p>
      <div class="row"><a class="c-cta" href="/quote" data-lead="faq-hero">3分で無料診断</a></div>
    </div>
  </div>
{''.join(blocks)}
'''
    return body, head


# ============================================================
# /cases  活用例・導入イメージ
#   実在の案件として公開できる根拠がないものを「導入事例」と書かない。
#   ここに載せるのは、ご依頼の多い形を整理した「活用例」で、
#   架空の企業名・成果を実績のようには出さない。
#   実績として公開できるものが確定したら、「導入事例」の節を別に作る。
# ============================================================
CASES = [
    dict(tag='新入社員', title='新入社員30名ぶんのPCを、入社日までに用意する',
         problem='4月入社の30名ぶんのPCを用意する必要があり、情報システム担当が1名しかいなかった。'
                 '例年は初期設定に数日かかっていた。',
         items='ノートPC 30台（Office付き）／キッティング／アカウント設定／セキュリティ設定',
         qty='30台', period='12ヶ月', how='レンタル',
         setup='アカウント作成・指定ソフト導入・セキュリティ設定まで済ませて発送。資産管理用のラベルも貼付。',
         result='入社日に合わせて納品でき、<b>初期設定の社内工数をほぼゼロにできます</b>。'
                '追加入社が決まったぶんも、同じ機種を後から追加できます。'),
    dict(tag='短期プロジェクト', title='3か月だけ使うPCを、増員に合わせて用意する',
         problem='受託案件のために3か月だけ増員することになり、PCとモニターが足りなくなった。'
                 '購入すると案件終了後に余ってしまう。',
         items='ノートPC／モニター・ドック／VPN・セキュリティ設定／一括返却',
         qty='10台前後', period='3ヶ月', how='レンタル',
         setup='既存の社内環境に合わせて設定し、VPNの接続確認まで実施。',
         result='案件終了後は<b>返却日をそろえて一括回収</b>できます。データ消去証明書も発行できるので、'
                '資産として残さずに済みます。'),
    dict(tag='オフィス開設', title='新しい拠点の立ち上げを、機器とネットワークごと任せる',
         problem='新拠点の開設が決まったが、PC・モニターのほかに回線やWi-Fiの手配も必要で、'
                 '何から頼めばよいか分からなかった。',
         items='PC・モニター／ルーター・スイッチ・無線AP／LAN・Wi-Fi設計／セキュリティ設定／現地設置',
         qty='拠点1か所ぶん', period='—', how='購入とレンタルの組み合わせ',
         setup='ネットワーク設計から現地の搬入・配線・接続確認まで（現地作業は別途お見積り）。',
         result='<b>窓口を1つにまとめられる</b>ので、開設日に合わせて一度に立ち上げられます。'),
    dict(tag='研修・イベント', title='3日間のセミナー会場へ、PCを直送して当日設置する',
         problem='会場で25台のPCを使う研修を行うが、社内に運ぶ人手も保管場所もなかった。',
         items='ノートPC 25台／プロジェクター／無線AP・回線手配／当日設置・撤収',
         qty='25台', period='3日間', how='レンタル',
         setup='会場へ直送し、当日に設置。回線が不安な会場には Wi-Fi ごと持ち込み。',
         result='設置は<b>当日に完了</b>できます。研修終了後はそのまま回収するので、社内作業が発生しません。'),
    dict(tag='PC入替', title='古い機体から順に入れ替えて、データ消去証明まで残す',
         problem='5年以上使っているPCが混在し、故障が増えていた。入替の段取りと、'
                 '古い機体のデータ消去をどうするかが課題だった。',
         items='ノートPC（整備済み中心）／キッティング／データ消去・証明書発行',
         qty='20台前後', period='—', how='購入（整備済み）',
         setup='部署ごとに順次入替。旧機は回収してデータを消去し、証明書を発行。',
         result='<b>業務を止めずに順番に入れ替えられます</b>。処分の記録も残せます。'),
    dict(tag='研修', title='研修でPCとAI講座をまとめて用意する',
         problem='受講者ぶんのPCを用意する必要があり、あわせて生成AIの使い方も学んでもらいたかった。',
         items='ノートPC／eラーニング／AI研修・Office研修',
         qty='40〜50台', period='3〜12ヶ月', how='レンタル',
         setup='受講者ぶんのアカウントを発行。研修の実施までまとめて対応。',
         result='<b>機器と学習環境を1つの契約で</b>用意でき、受講者の入れ替えにも対応できます。'),
]


def cases_body():
    cards = ''.join(f'''
      <div class="case">
        <span class="tag">{c['tag']}</span>
        <h3>{c['title']}</h3>
        <dl>
          <dt>課題</dt><dd>{c['problem']}</dd>
          <dt>用意したもの</dt><dd>{c['items']}</dd>
          <dt>台数</dt><dd>{c['qty']}</dd>
          <dt>期間</dt><dd>{c['period']}</dd>
          <dt>購入／レンタル</dt><dd>{c['how']}</dd>
          <dt>設定内容</dt><dd>{c['setup']}</dd>
        </dl>
        <p class="res">{c['result']}</p>
      </div>''' for c in CASES)
    return f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　活用例</div>
      <h1>活用例・導入イメージ</h1>
      <p>どんな場面で、何を、何台、どのくらいの期間でご用意できるのかを整理しました。
        <strong>特定のお客様の実績ではなく、ご相談の多い形を「こう進められます」としてまとめたもの</strong>です。
        近いものがあれば、そのまま「同じような形で」とご相談ください。</p>
      <div class="row"><a class="c-cta" href="/quote" data-lead="cases-hero">3分で無料診断</a>
        <a class="c-cta ghost" href="/rent">レンタル商品を見る</a></div>
    </div>
  </div>

  <div class="c-sec">
    <div class="c-grid g2">{cards}
    </div>
    <div class="note-box"><strong>上記は実在する特定企業の導入実績ではありません。</strong>
      ご相談の多い場面について、当社で対応できる進め方・台数・期間の目安を活用例として整理したものです。
      数字は一例で、実際の台数・期間・構成・効果はご相談内容によって変わります。
      具体的な条件でのお見積りは、3分の無料診断からお送りください。</div>
  </div>
'''


# ============================================================
# /care  8RENT Care
#   金額や免責の条件は決まっているものだけ書く。決まっていないものは
#   「ご契約内容により異なります」として、勝手に数字を作らない。
# ============================================================
CARE = [
    ('故障・初期不良', '通常のご利用範囲内で動かなくなった場合は、追加のご負担なく交換します。'
                     '到着後すぐの初期不良も同じ扱いです。まずはご連絡ください。'),
    ('代替機', '交換が必要な場合は代替機をお送りします。在庫状況により最短翌営業日の出荷にも対応します。'
              '設定済みの状態でお届けできるよう、ご利用環境を伺います。'),
    ('バッテリーの劣化', '使用に伴う自然な劣化は故障として扱い、必要に応じて交換・代替機で対応します。'),
    ('破損・水濡れ', 'ご連絡をいただいたうえで、修理または交換の方法をご相談します。'
                   'ご負担が発生するかどうかは、状況とご契約内容によって異なります。'),
    ('紛失・盗難', 'すぐにご連絡ください。端末の管理設定によっては、利用停止などの対応ができる場合があります。'
                 'そのうえで、補充の手配をご相談します。'),
    ('返却', '回収キットをお送りします。返却日をそろえたい場合はご指定ください。'
            '台数が多い場合は、拠点ごとの回収もご相談いただけます。'),
    ('データ消去', '返却後にデータを消去します。<b>データ消去証明書は、お申し付けいただければ発行します。</b>'
                 '入替のときの旧機についても同様に承ります。'),
    ('延長・台数の増減', '延長はご連絡いただければ対応します。増台も同一機種の在庫がある場合は追加分のみ後から出荷します。'
                      '契約期間は追加分から個別に起算します。'),
]


def care_body():
    rows = ''.join(f'''
      <div class="c-card">
        <h3>{t}</h3>
        <p>{d}</p>
      </div>''' for t, d in CARE)
    return f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　<a href="/rent">レンタル</a>　›　8RENT Care</div>
      <div style="font-size:13px;font-weight:900;letter-spacing:.18em;color:var(--c-lime-d);margin-bottom:10px">8RENT CARE</div>
      <h1>借りたあとの「もしも」を、<br>まとめて引き受けます。</h1>
      <p>法人で使う機器は、止まると仕事が止まります。故障・交換・返却・データ消去まで、
        窓口をひとつにまとめています。ご契約中はいつでもご相談ください。</p>
      <div class="row"><a class="c-cta" href="/quote" data-lead="care-hero">3分で無料診断</a>
        <a class="c-cta ghost" href="/rent">レンタル商品を見る</a></div>
    </div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">こんなときに</h2>
    <p class="c-lede">ご連絡いただいたあと、状況を伺って対応方法をご案内します。
      まず動かせる状態に戻すことを優先します。</p>
    <div class="c-grid g3" style="margin-top:20px">{rows}
    </div>
    <div class="note-box">具体的なご負担や対応の範囲は、機器・ご利用状況・ご契約内容によって異なります。
      お見積りのときに、対象となる範囲をあわせてご案内します。ここに書ききれない場合も、まずはご相談ください。</div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">困ったときの流れ</h2>
    <ol class="flow">
      <li><b>ご連絡</b><p>お電話（03-6433-5025 平日9:00〜18:00）またはメールで、管理番号と症状をお知らせください。</p></li>
      <li><b>状況の確認</b><p>設定で直るものか、交換が必要かを切り分けます。その場で解決することもあります。</p></li>
      <li><b>代替機の手配</b><p>交換が必要な場合は代替機をお送りします。設定済みの状態でお届けできるよう調整します。</p></li>
      <li><b>回収・データ消去</b><p>不具合のあった機器は回収し、データを消去します。証明書が必要な場合は発行します。</p></li>
    </ol>
  </div>
'''


# ============================================================
# /support  導入支援（キッティングから研修まで）
# ============================================================
SUPPORT = [
    ('初期設定・キッティング', 'OSの初期設定、アカウント作成、指定ソフトの導入、資産管理ラベルの貼付まで。'
                           '届いた箱を開けたら、そのまま業務に入れる状態でお渡しします。'),
    ('Office / Microsoft 365', 'ライセンスの手配から設定まで。対象PCではレンタル月額に含められます。'
                              'Microsoft 365 のアカウント設計もご相談いただけます。'),
    ('アカウント・メール', '社員ごとのアカウント、メール、共有フォルダの初期設定。'
                       '既存の環境に合わせて設定します。'),
    ('セキュリティ', 'ウイルス対策・VPN・端末管理（MDM）の導入。'
                 '持ち出しの多い部署に合わせた設定もご相談ください。'),
    ('ネットワーク・Wi-Fi', 'LAN配線の設計、ルーター・スイッチ・無線APの設定、回線の手配まで。'
                        '拠点の立ち上げにも対応します。'),
    ('現地設置・配線', '搬入・配線・接続確認までの現地作業。<b>現地作業は別途お見積り</b>で、'
                   'レンタル料金・販売価格には含まれません。'),
    ('AI研修・Office研修', '生成AIを業務で使えるようにする研修と、Excel・Word・PowerPointの基礎研修。'
                       '機器の導入とあわせてご依頼いただけます。'),
    ('返却・データ消去', '返却時の回収とデータ消去、証明書の発行。入替のときの旧機も同様に承ります。'),
]


def support_body():
    rows = ''.join(f'''
      <div class="c-card">
        <h3>{t}</h3>
        <p>{d}</p>
      </div>''' for t, d in SUPPORT)
    return f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　導入支援</div>
      <h1>機器を届けて終わり、<br>にはしません。</h1>
      <p>設定・ネットワーク・セキュリティ・研修まで、社員の方が仕事を始められる状態までご用意できます。
        購入・レンタルのどちらでもご依頼いただけます。</p>
      <div class="row"><a class="c-cta" href="/quote" data-lead="support-hero">3分で無料診断</a>
        <a class="c-cta ghost" href="/care">8RENT Care を見る</a></div>
    </div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">ご依頼いただけること</h2>
    <p class="c-lede">必要なものだけを選んでご依頼いただけます。
      どこまで頼めるか分からない場合は、いまの困りごとをそのままお知らせください。</p>
    <div class="c-grid g3" style="margin-top:20px">{rows}
    </div>
    <div class="note-box">現地設置・現地配線・接続確認・撤収は有料オプションです。レンタル料金・販売価格には含まれません。
      ご希望の場合は別途お見積りします。</div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">ご依頼の流れ</h2>
    <ol class="flow">
      <li><b>ご相談（3分の診断）</b><p>用途・人数・台数・必要な作業をお知らせください。機種が決まっていなくても大丈夫です。</p></li>
      <li><b>お見積り</b><p>機器と作業をまとめてお見積りします。購入・レンタル・組み合わせのどれが合うかもご提案します。</p></li>
      <li><b>設定・納品</b><p>設定を済ませてお届けします。現地作業が必要な場合は日程を調整します。</p></li>
      <li><b>運用中のサポート</b><p>故障・交換・増台・返却まで、同じ窓口でご相談いただけます。</p></li>
    </ol>
  </div>
'''


# ============================================================
# /packs/*  課題から入る集客ページ
#   1テーマ1ページ。中身はそのテーマの段取りに絞り、最後は診断へ送る。
# ============================================================
PACKS = [
    dict(slug='new-employee-pc', nav='新入社員PC',
         title='新入社員のPC調達｜入社日までに、設定済みで届ける',
         h1='新入社員のPCを、<br>入社日までにそろえる。',
         desc='新入社員ぶんのPCを、アカウント・Office・セキュリティまで設定した状態でお届けします。'
              '台数が決まっていなくても、人数と入社日だけでご相談いただけます。購入・レンタルどちらも対応。',
         lede='入社日は動かせません。台数がまとまるほど、設定の手間が効いてきます。'
              'COMMERCEは、機器の手配からキッティング・アカウント作成・セキュリティ設定までまとめて引き受けます。',
         points=[('入社日から逆算して手配', 'いつまでに何台必要かが決まれば、在庫と調達を組み合わせて間に合わせます。'),
                 ('設定済みで届く', 'アカウント・指定ソフト・セキュリティまで設定して発送。開梱したその日から使えます。'),
                 ('Officeもまとめて', 'Word・Excel・PowerPoint を入れた状態でお届けできます（対象機種）。'),
                 ('あとから増やせる', '追加入社が決まったぶんは、同じ機種を後から追加できます。')],
         purpose='新入社員・中途入社',
         services='初期設定・キッティング,Office / Microsoft 365,アカウント設定,セキュリティ'),
    dict(slug='short-term-rental', nav='短期レンタル',
         title='PCの短期レンタル｜1カ月から、必要な期間だけ',
         h1='1カ月だけ、<br>10台だけ、でも大丈夫です。',
         desc='短期プロジェクトや増員に合わせて、法人向けPC・モニターを1カ月からレンタルできます。'
              '設定済みで届き、返却・データ消去までまとめて対応します。',
         lede='使う期間が決まっているなら、買わずに借りるほうが身軽です。'
              '返却日をそろえられるので、プロジェクト単位で管理できます。',
         points=[('1カ月から', '期間が決まっていない場合も、想定だけ伺えればご提案できます。'),
                 ('返却まで任せられる', '回収キットをお送りし、返却後にデータを消去します。証明書も発行できます。'),
                 ('台数の増減に対応', '途中で増やす・一部だけ延ばす、といったご相談も承ります。'),
                 ('在庫に無くても調達', '希望の機種が手元に無い場合も、取り寄せてご用意できることがあります。')],
         purpose='短期プロジェクト',
         services='初期設定・キッティング,データ消去・証明書'),
    dict(slug='training-pc', nav='研修用PC',
         title='研修・セミナー用PCのレンタル｜会場直送・当日設置まで',
         h1='研修会場に、<br>PCごと届けます。',
         desc='研修・セミナー・イベントで使うPCやプロジェクターを、会場へ直送します。'
              '当日の設置・撤収、回線が不安な会場へのWi-Fi持ち込みもご相談いただけます。AI研修・Office研修も承ります。',
         lede='会場で使う機材は、運ぶ人手と保管場所がいちばんの悩みです。'
              '直送と当日設置まで引き受けるので、社内の作業を増やさずに開催できます。',
         points=[('会場へ直送', '社内を経由せず、会場へ直接お届けします。'),
                 ('当日設置・撤収', 'ご希望に応じて、設置と撤収までお手伝いします（別途お見積り）。'),
                 ('回線ごと持ち込み', '会場の回線が不安な場合は、無線APや回線の手配もご相談ください。'),
                 ('研修そのものも', 'AI研修・Office研修をあわせてご依頼いただけます。')],
         purpose='研修・イベント',
         services='初期設定・キッティング,ネットワーク・Wi-Fi,AI研修,Office研修'),
    dict(slug='office-opening', nav='オフィス開設',
         title='オフィス開設のIT手配｜PCからネットワークまで一式',
         h1='新しい拠点を、<br>一度に立ち上げる。',
         desc='新規オフィスの開設・移転にあわせて、PC・モニター・ネットワーク機器の手配から'
              'LAN配線・Wi-Fi設計・セキュリティ設定・現地設置までまとめてご相談いただけます。',
         lede='拠点の立ち上げは、頼む先が分かれるほど段取りが増えます。'
              '機器とネットワークを同じ窓口にまとめると、開設日に間に合わせやすくなります。',
         points=[('機器とネットワークを一緒に', 'PC・モニターだけでなく、ルーター・スイッチ・無線APまで。'),
                 ('設計から', 'LAN配線とWi-Fiの設計、回線の手配からご相談いただけます。'),
                 ('現地作業も手配', '搬入・配線・接続確認まで（現地作業は別途お見積り）。'),
                 ('購入とレンタルを組み合わせる', '長く使うものは購入、増減するものはレンタル、という分け方もできます。')],
         purpose='オフィス開設・移転',
         services='初期設定・キッティング,ネットワーク・Wi-Fi,セキュリティ,現地設置'),
    dict(slug='kitting', nav='キッティング',
         title='PCキッティング代行｜アカウント・ソフト・セキュリティまで',
         h1='開けたその日から、<br>使える状態で届ける。',
         desc='PCのキッティング（初期設定）を代行します。OS初期設定・アカウント作成・指定ソフト導入・'
              'セキュリティ設定・資産ラベル貼付まで。購入・レンタルのどちらでもご依頼いただけます。',
         lede='台数が増えるほど、1台あたりの設定時間がそのまま人件費になります。'
              '同じ作業をまとめて引き受けるので、担当者の手が空きます。',
         points=[('同じ設定を全台に', '1台ぶんの手順を決めれば、あとは同じ状態に仕上げます。'),
                 ('アカウント・メールまで', '社員ごとのアカウント、メール、共有フォルダの初期設定まで。'),
                 ('セキュリティ設定', 'ウイルス対策・VPN・端末管理（MDM）の導入もあわせて。'),
                 ('資産管理のラベル', '管理番号のラベル貼付など、あとの棚卸が楽になる準備もできます。')],
         purpose='PC入替',
         services='初期設定・キッティング,アカウント設定,セキュリティ'),
]


def pack_body(p):
    from urllib.parse import quote
    pts = ''.join(f'''
      <div class="c-card">
        <h3>{t}</h3>
        <p>{d}</p>
      </div>''' for t, d in p['points'])
    q = f"/quote?purpose={quote(p['purpose'])}&services={quote(p['services'])}"
    return f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　<a href="/packs/">用途から探す</a>　›　{p['nav']}</div>
      <h1>{p['h1']}</h1>
      <p>{p['lede']}</p>
      <div class="row"><a class="c-cta" href="{q}" data-lead="pack-{p['slug']}">3分で無料診断</a>
        <a class="c-cta ghost" href="/rent">レンタル商品を見る</a>
        <a class="c-cta ghost" href="/buy">購入できる商品を見る</a></div>
    </div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">この場面でできること</h2>
    <div class="c-grid g2" style="margin-top:20px">{pts}
    </div>
  </div>

  <div class="c-sec">
    <h2 class="c-h2">ご相談から納品まで</h2>
    <ol class="flow">
      <li><b>3分の診断</b><p>人数・台数・時期・必要な作業をお知らせください。機種が決まっていなくても大丈夫です。</p></li>
      <li><b>お見積り</b><p>在庫と調達状況を確認し、購入・レンタル・組み合わせでお見積りをお送りします。</p></li>
      <li><b>設定・納品</b><p>設定を済ませてお届けします。現地作業が必要な場合は日程を調整します。</p></li>
      <li><b>運用中のサポート</b><p>故障・交換・増台・返却まで、同じ窓口でご相談いただけます。</p></li>
    </ol>
    <div class="note-box">現地設置・現地配線・接続確認・撤収は有料オプションです。レンタル料金・販売価格には含まれません。</div>
  </div>
'''


def packs_index_body():
    cards = ''.join(f'''
      <a class="c-card" href="/packs/{p['slug']}" style="text-decoration:none;color:inherit;display:block">
        <h3>{p['nav']}</h3>
        <p>{p['lede']}</p>
      </a>''' for p in PACKS)
    return f'''  <div class="page-hero">
    <div class="in">
      <div class="crumb"><a href="/">COMMERCE</a>　›　用途から探す</div>
      <h1>用途から探す</h1>
      <p>よくある場面ごとに、必要になるものと段取りをまとめました。近いものからご相談ください。</p>
      <div class="row"><a class="c-cta" href="/quote" data-lead="packs-hero">3分で無料診断</a></div>
    </div>
  </div>
  <div class="c-sec">
    <div class="c-grid g3" style="margin-top:6px">{cards}
    </div>
  </div>
'''


def main():
    body, head = faq_body()
    page('faq.html', 'よくある質問｜COMMERCE（エイトコマース）',
         'レンタル・購入・設定についてのよくある質問。最短納期、最短レンタル期間、Office、キッティング、'
         'ネットワーク、支払い方法、購入とレンタルの選び方などをまとめています。',
         '/faq', body, active='faq', extra_head=head)

    page('cases.html', '活用例・導入イメージ｜法人IT調達・レンタル｜COMMERCE',
         '新入社員のPC一括調達、短期プロジェクト、新規オフィス開設、研修会場への直送、PC入替など、'
         '場面ごとに何をどのくらいの台数・期間でご用意できるかを整理した活用例です。'
         '特定企業の実績ではなく、対応できる進め方の目安としてご覧ください。',
         '/cases', cases_body())

    page('care.html', '8RENT Care｜故障・交換・返却・データ消去まで｜COMMERCE',
         'レンタル中の故障・初期不良・代替機・バッテリー・破損・紛失・返却・データ消去証明まで、'
         '8RENT Care の対応範囲と困ったときの流れをまとめています。',
         '/care', care_body())

    page('support.html', '導入支援｜キッティング・Office・ネットワーク・研修｜COMMERCE',
         '初期設定・キッティング、Office / Microsoft 365、アカウント設定、セキュリティ、ネットワーク・Wi-Fi、'
         '現地設置、AI研修・Office研修まで。法人のIT導入をまとめて引き受けます。',
         '/support', support_body(), active='support')

    (ROOT / 'packs').mkdir(exist_ok=True)
    page('packs/index.html', '用途から探す｜COMMERCE（エイトコマース）',
         '新入社員PC、短期レンタル、研修用PC、オフィス開設、キッティング。よくある場面ごとに、'
         '必要になるものと段取りをまとめています。', '/packs/', packs_index_body())
    for p in PACKS:
        page(f"packs/{p['slug']}.html", p['title'] + '｜COMMERCE', p['desc'],
             f"/packs/{p['slug']}", pack_body(p))


if __name__ == '__main__':
    main()
