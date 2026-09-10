# 8ec.jp — 株式会社エイト コーポレートサイト

法人向け総合ITサービス「株式会社エイト」（[8ec.jp](https://8ec.jp/)）の静的サイトです。
これまで ZIP でやり取りしていたものを **git 管理下に整備** し、
リニューアル作業を差分・レビュー・履歴付きで進められるようにしています。
デプロイは **Vercel** に連動し、`main` への push で本番公開、PR ごとにプレビューURLが自動発行されます。

---

## ディレクトリ構成

```
.
├── index.html          トップページ
├── pc.html             レンタルパソコン
├── cloud.html          クラウド情シス
├── ai-dev.html         AI・業務システム開発
├── company.html        会社案内
├── privacy.html        プライバシーポリシー
├── terms.html          利用規約
├── tokushou.html       特定商取引法に基づく表記
├── 404.html            404 ページ
│
├── nav.css / nav.js    共通ナビゲーション
├── legal.css           規約系ページ用スタイル
├── quote-modal.js      見積もり／問い合わせモーダル
├── robots.txt
├── sitemap.xml
│
├── api/                Vercel サーバーレス関数（問い合わせ受付・Slack通知）
├── admin/              管理画面（EC在庫・棚卸・決算資料・ショップ出品・商品画像・問い合わせ・レンタル）
│   ├── setup-all.sql   追加機能のSupabase設定（棚卸・決算・商品画像をまとめて実行）
│   ├── ec-master-setup.sql  EC一元管理のSupabase設定（新品SKUの商品マスター）
│   └── ec/             EC一元管理（8EC・楽天・Amazon・Yahoo をまとめて扱う）
│       ├── connectors.js  モールごとのCSV仕様（モールを増やすときはここに足す）
│       └── cp932.js       Shift_JIS変換表（生成物／tools/build-cp932.py が作る）
├── shop/               公開ショップ（Stripe決済）
├── rental/             機材レンタル
├── assets/             画像・ロゴ・favicon・在庫データ・商品イラスト・コラム目次
├── column/             IT調達コラム（記事は生成物／詳細は column/README.md）
├── tools/              在庫取り込み・コラム生成のスクリプト
├── blog/               CMS 貼り付け用の自己完結HTML（4種）※詳細は blog/README.md
├── notion-proxy/       Notion API プロキシ（Cloudflare Worker・別デプロイ／Vercel配信対象外）
├── archive/            本番未リンクの過去生成物（参考保管／Vercel配信対象外）
│
├── vercel.json         Vercel 設定（静的配信・URL挙動）
└── .vercelignore       Vercel に配信しないもの（archive/・notion-proxy/ 等）
```

> `archive/` `notion-proxy/` は `.vercelignore` で **公開対象から除外** しています。

---

## 在庫データの更新

仕入先から届いた在庫Excelは、取り込みスクリプトで `assets/inventory-data.js` に反映します。
仕入先ごとに列の並びが違うので、読み取りルールは `tools/import-stock.py` に集約しています。

```bash
pip install openpyxl
python3 tools/import-stock.py <届いたxlsx> [<xlsx> ...]
```

- 対応フォーマット：SB C&S（HPEサーバー・ストレージ）／BUFFALO NW製品／LES PCStock（レノボ）／エレコム
- 同じ型番が既にあれば、**在庫・価格・更新日だけ**を上書きします
- 商品画像・メーカーページURL・カテゴリ分類は、手で整えた内容を残します
- 新しい仕入先が増えたときは `READERS` に読み取り関数を1つ足してください

### CSVで書き出す

仕入先に画像や見積もりを依頼するときの型番リスト、社内での内容確認に使えます。
Excelでそのまま開けるよう、BOM付きUTF-8・CRLF で出力します。

```bash
python3 tools/export-csv.py                 # 在庫一覧_YYYY-MM-DD.csv を作る
python3 tools/export-csv.py /path/out.csv   # 出力先を指定する
```

商品画像の有無も列に入るので、どの型番の画像が足りていないかがそのまま分かります。

---

## ヒーロー画像

トップページのヒーロー背景は `assets/hero-devices.svg` です。
商品一覧で使っている `assets/product-art.js` の機器イラストをそのまま並べて組み立てているので、
ヒーローと商品カードの画風が揃います。写真素材を使わないため権利の問題も起きません。

```bash
node tools/build-hero.js     # assets/hero-devices.svg を作り直す
```

機器の種類・位置・大きさは `tools/build-hero.js` の構図部分で調整します。
ベクターなので22KB（gzip後3KB）、拡大しても粗くなりません。

---

## 商品画像

実写があるものはそれを、無いものは `assets/product-art.js` が型番とカテゴリから機器の種類を
判定して描いたイラストを表示します。イラストには **「イメージ図」** と明示しているので、
実物の写真だと誤解されることはありません。

型番と画像の対応は `assets/product-images.json` に持ちます。在庫データとは別ファイルなので、
在庫を更新しても画像は消えません。

```bash
python3 tools/import-images.py --status      # 型番ごとの画像の有無を集計
```

### 画像を増やす

**型番から画像を自動検索する方式は採っていません。** 楽天・Yahoo!の商品APIはJANコードで
画像を返せますが、あれは他の小売店が撮影した写真で、自社の商用サイトに転載すると
著作権侵害になります。メーカーサイトの画像を直リンクするのも、相手の帯域を無断で使ううえ、
URLが変わると静かに壊れます。

使えるのは、**メーカーまたは仕入先から販売目的での利用を許諾された画像**だけです。
入手経路は主に2つで、どちらも取り込みツールが対応しています。

**1. 仕入先の商品マスタ（型番列と画像URL列を持つCSV / Excel）**

SB C&S・ダイワボウ情報システムなどが販売店向けに配布しているものです。
在庫表と同じ窓口で「画像URL付きの商品マスタ」を依頼すれば入手できます。

```bash
python3 tools/import-images.py --from-file 商品マスタ.xlsx \
    --model-col 型番 --url-col 画像URL --credit エレコム --download
```

**2. メーカーの販売店向け画像ダウンロード（型番名の画像ファイルが入ったフォルダ）**

エレコム・バッファロー・アイ・オー・データなどが、販売店アカウント向けに配布しています。

```bash
python3 tools/import-images.py --from-dir ~/Downloads/elecom-images --credit エレコム
```

**3. 手元でコピーしたURLを貼り付ける**

自社ショップの管理画面やメーカーの製品ページからコピーしたURLを、そのまま流し込めます。
区切りはタブ・カンマ・空白のいずれでも構いません。

```bash
python3 tools/import-images.py --paste --credit 自社撮影
# 型番<タブ>URL を1行ずつ貼り付けて Ctrl-D
```

**4. 自社ショップ（`/shop`）から型番一致で取り込む**

ショップは Supabase の `shop_products` ビューを見ており、`model`（型番）と画像URLが
同じ行にあります。そのため手で貼らなくても型番で自動照合できます。

```bash
python3 tools/import-images.py --from-shop          # 一致する型番を一覧表示するだけ
python3 tools/import-images.py --from-shop --yes    # 実際に取り込む
```

> **注意：** ショップはオークション仕入れの**中古品を1点ずつ**扱っており、写真はその個体を
> 撮ったものです。新品として掲載する法人在庫にそのまま流用すると、実物と食い違います
> （傷のある中古機の写真が「新品・在庫275点」の隣に出るなど）。著作権の問題はありませんが、
> 表示としての正確さの問題があるため、`--from-shop` は一覧を出すだけで止まり、
> 取り込むには `--yes` を明示する必要があります。

**5. 管理画面から登録する（`/admin/catalog/`）← 日常運用はこれ**

事務の共有アカウントでログインし、商品ごとに画像URLを入力します。
保存すると **デプロイを待たずにサイトへ反映** されます（Supabase の `catalog_images` に保存）。

- 型番・商品名・商品コード・メーカーで検索、画像の状態（未登録／準備中／画像あり）で絞り込み
- 「まとめて貼り付け」で、ExcelやCSVから2列（商品コード＋URL）をそのまま流し込める
- 「アップ」ボタンで画像ファイルを直接アップロード（Supabase Storage に入り、URLが自動で入る）
- 「JSON書き出し」で `assets/product-images.json` に反映する形でも取り出せる

初回のみ `admin/catalog/supabase-setup.sql` を Supabase の SQL Editor で実行してください。

**6. 自社で画像を用意する（`images/products/` 配信）**

商品コードでファイル名を固定し、自社ドメインから配信する方式です。
URLが `https://8ec.jp/images/products/<商品コード>.webp` で固定されるため、
正式な画像を同じファイル名で上書きすれば、データを触らずに差し替わります。

```bash
python3 tools/import-images.py --from-manifest assets/product-image-manifest.csv
```

マニフェストの「状態」列が「準備中」「差替待ち」のものは `placeholder` として登録され、
**サイト上ではイラスト表示のまま**になります。「商品画像準備中」の画像より、
機器の種類が分かるイラストの方が一覧で役に立つためです。
準備中の画像もそのまま出したい場合は `--show-placeholders` を付けてください。

`--download` を付けると画像を `assets/products/` に保存し、そちらを参照します。
直リンクを避けられるので、本番ではこちらを推奨します
（外部へ接続できる環境で実行してください）。

---

## コラム

中小企業のAI・IT機器の悩みを扱う `column/` 以下のコンテンツです。
記事の追加・自動生成の仕組みは **[column/README.md](column/README.md)** を参照してください。

- 目次は `assets/columns.json`、本文は `column/_content/<slug>.html`
- `python3 tools/build-columns.py` で記事ページ・一覧・sitemap を出力（記事HTMLは生成物なので直接編集しない）
- `.github/workflows/column-weekly.yml` が毎週月曜に1本書いて **PRを作成**（要 `ANTHROPIC_API_KEY` シークレット）

---

## ローカルでプレビューする

静的サイトなので、リポジトリ直下で簡易サーバーを立てればそのまま確認できます。

```bash
# Python がある場合
python3 -m http.server 8000
# → ブラウザで http://localhost:8000/ を開く

# もしくは Node がある場合
npx serve .
```

ビルド工程はありません。HTML/CSS/JS を直接編集します。

---

## デプロイ（git 連動 / Vercel）

GitHub リポジトリ `morishin1/8ec` を Vercel プロジェクト **8ec** に接続しています。

| きっかけ | 結果 |
|---|---|
| `main` へ push / マージ | **本番デプロイ**（https://8ec.vercel.app/ 、将来は 8ec.jp） |
| PR を作成 / 更新 | その差分の **プレビューURL** が PR に自動投稿される |

ビルドは不要（静的サイト）。`.vercelignore` で `archive/`・`notion-proxy/` 等は配信されません。

### Vercel 初回接続（1回のみ）

Vercel の `8ec` プロジェクト → **Settings → Git** →
**Connect Git Repository** で `morishin1/8ec` を接続し、Production Branch を `main` に設定します。
ビルド設定は次のとおり（静的サイト）:

- **Framework Preset**: Other
- **Build Command**: なし（空欄）
- **Output Directory**: 既定（リポジトリ直下）

### リニューアルの進め方（推奨フロー）

1. 作業用ブランチを切る（例: `git switch -c feature/top-renewal`）
2. HTML/CSS/JS を編集してコミット → PR を作成
3. PR に付く **プレビューURL** で仕上がりを確認・レビュー
4. `main` にマージ → 本番へ自動反映

### 本番 8ec.jp への切り替え

Vercel プロジェクトの **Settings → Domains** で `8ec.jp` を追加し、
表示される DNS レコード（A / CNAME）を 8ec.jp のネームサーバー側に設定すれば、
本番ドメインが Vercel の配信に切り替わります。

---

## EC一元管理（/admin/ec/）

8EC を商品・在庫のマスターにして、楽天・Amazon・Yahoo! への出品をまとめて扱う画面です。

### 中古（`/admin/`）との住み分け

いま動いている `/admin/` の EC在庫管理は、オークションで仕入れた**中古品を1台ずつ**扱う仕組みです
（1行＝現物1台。棚卸・決算資料・ショップ出品がこれに乗っています）。
一方このモール一元管理は、**同じ型番を何台も持つ新品SKU**が前提で、
「在庫10台 → 楽天で1台売れる → 9台」と数が減る必要があります。

この2つは数え方が根本的に違うので、**表を分けて併存**させています。
`/admin/ec/` は `ec_products` を、`/admin/` は従来どおり `ec_items` を使い、互いに影響しません。

| | `/admin/`（中古） | `/admin/ec/`（新品SKU） |
|---|---|---|
| 1行の意味 | 現物1台 | 1SKU（同じ型番を何台でも） |
| 在庫 | 売れたら「販売済み」になる | 数量が減る |
| 表 | `ec_items` | `ec_products` / `ec_listings` |

### セットアップ

Supabase の SQL Editor で `admin/ec-master-setup.sql` を実行します。何度実行しても安全です。
既存の `ec_items` には触れないので、棚卸・決算資料はそのまま動きます。

作られるもの：

| 表・関数 | 役割 |
|---|---|
| `ec_products` | 商品マスター。SKU・価格・在庫・スペック・中古PC向け項目 |
| `ec_listings` | SKU×モールの出品設定（出す/出さない・モール別の商品名と価格・出品状態） |
| `ec_stock_moves` | 在庫の増減履歴（いつ・どのモールで・いくつ・なぜ） |
| `ec_sync_log` | モール連携の実行履歴 |
| `ec_stock_apply()` | 在庫を増減する関数 |

### 在庫は必ず `ec_stock_apply()` を通す

在庫は複数のモールから同時に減りえます。画面側で「読んで、引いて、書き戻す」をやると、
ほぼ同時の2件で片方の減少が消えます。`ec_stock_apply()` は
`update ... returning` で1文にまとめて行ロックを取り、履歴を同じトランザクションで残します。
マイナス在庫になる場合は例外を投げて、増減ごとなかったことにします。

> 3セッションから同時に150回引く検証で、在庫100に対して成功100・失敗50、
> 残0・履歴100行・`stock_after` が100通り（＝取りこぼしなし）を確認しています。

### モールを増やすとき

モールごとの違いは `admin/ec/connectors.js` だけに閉じ込めてあります。
画面側はモール名を知らずに動くので、**コネクタを1つ足せば増やせます**。

```js
var NEWMALL = {
  key:'newmall', label:'新しいモール', short:'新', color:'#333', phase:2,
  csv:{ encoding:'shift_jis', sep:',', filename:(ymd)=>'newmall-'+ymd+'.csv',
        columns:[ {h:'商品コード', v:(p,l)=>p.sku}, ... ],   // 出力する列
        keyField:['商品コード'],                              // 取込のキー列
        fields:{ price:{h:['価格'], t:num, to:'listing.price'} } },
  api:null
};
```

### CSVの列名について

モールのCSVテンプレートは契約プランや店舗によって列が増減します。
`connectors.js` に書いてあるのは主要列で、**そのまま通る保証はありません**。
画面の「ヘッダー照合」に実物のテンプレートを読ませると、
食い違っている列（出力側の余分／取込側の不足）を出すので、最初の1回はそれで確かめてください。

文字コードは楽天・Yahoo!を Shift_JIS、Amazon・8EC を UTF-8 として出力します（画面で切り替え可）。
ブラウザは Shift_JIS を読めても書けないため、出力用の変換表だけ自前で持っています。

```bash
python3 tools/build-cp932.py   # admin/ec/cp932.js を作り直す（手で編集しない）
```

取り込み側は `TextDecoder` に任せるので変換表を使わず、Shift_JIS / UTF-8 を自動で見分けます。

### いまできること・これから

| | 内容 | 状態 |
|---|---|---|
| Phase 1 | 商品マスター・商品一覧・在庫一元管理・価格管理・ダッシュボード | 実装済み |
| Phase 1 | 楽天連携（CSV出力・取込） | 実装済み（列名の照合は要実施） |
| Phase 2 | Amazon・Yahoo!（CSVの雛形はあり） | 列の確認から |
| Phase 2〜3 | 各モールのAPI連携 | **外部の申請が先** |
| Phase 3 | 注文一元管理・AI商品登録補助 | 未着手 |

APIでの自動連携は、こちらだけでは進められません。先に次が要ります。

- 楽天：RMS WEB SERVICE の利用申請とライセンスキー
- Amazon：SP-API の開発者登録（審査あり）
- Yahoo!：ストアクリエイターProのAPI利用申請

取得できしだい、各コネクタの `api` に処理を足せば、CSVの運用はそのまま残せます。

---

## Supabase のセットアップ（管理画面・ショップ・フォーム）

`/admin/`（EC在庫管理・ショップ出品）、`/shop/`（公開ショップ）、各ページの
見積もりフォームは Supabase を使います。**SQL Editor で下記を上から順に実行**してください。
いずれも `create ... if not exists` 形式で、何度実行しても安全です。

| # | ファイル | 内容 |
|---|---|---|
| 1 | `admin/supabase-setup.sql` | `ec_items` テーブル本体・商品写真用ストレージ（`shop-images`）・発送添付用ストレージ |
| 2 | `shop/supabase-shop-setup.sql` | 公開ショップが読む `shop_products` ビュー |
| 3 | `admin/contact/supabase-setup.sql` | 問い合わせ・見積もりフォームの受信テーブル |
| 4 | `rental/supabase-setup.sql` | レンタル機材 |
| 5 | `admin/setup-all.sql` | 棚卸・決算資料（請求日／入金日）・商品画像管理 |
| 6 | `admin/ec-master-setup.sql` | EC一元管理（新品SKUの商品マスター）※上とは独立 |

### Edge Function（Stripe 決済リンクの自動生成）

管理画面の「ショップ出品」タブで決済リンクをボタン1つで発行するために、
Stripe の Products / Prices / Payment Links API を呼ぶ Edge Function をデプロイします。

```bash
# 管理者だけが叩く関数なので --no-verify-jwt は付けない
supabase functions deploy create-payment-link

# 公開ショップから呼ぶ動的チェックアウト（こちらは匿名アクセスのため --no-verify-jwt）
supabase functions deploy create-checkout --no-verify-jwt
```

デプロイ後、Supabase ダッシュボード → Edge Functions → 各関数の **Secrets** に設定します。

| Secret | 用途 |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe のシークレットキー（`sk_live_…` / テストは `sk_test_…`） |
| `SHOP_URL` | 任意。決済完了後の戻り先。既定は `https://www.8ec.jp/shop/` |

> `create-payment-link` は呼び出し元が管理者（`zimu@8grp.co.jp`）かを JWT で検証し、
> 価格は必ずサーバー側で DB から読み直します（金額をブラウザに信頼させません）。

---

## 問い合わせフォームと Slack 通知（Vercel 側の設定）

各ページのフォームは **`/api/contact`（Vercel のサーバーレス関数）** に送信され、
そこで Supabase への保存と Slack への通知をまとめて行います（`api/contact.js`）。

### Vercel の環境変数

プロジェクト → **Settings → Environment Variables** で設定します。
変更後は再デプロイすると反映されます。

| 変数名 | 必須 | 内容 |
|---|:--:|---|
| `SLACK_WEBHOOK_URL` | 任意 | Slack の受信 Webhook（`https://hooks.slack.com/services/...`）。**未設定でもフォームは動作します**（Slack 通知だけスキップ） |
| `SUPABASE_URL` | 任意 | 既定値がコードに入っているため通常は不要 |
| `SUPABASE_ANON_KEY` | 任意 | 同上（RLS で保護された公開鍵） |
| `ADMIN_CONTACT_URL` | 任意 | Slack 通知のボタンの遷移先。既定 `https://www.8ec.jp/admin/contact/` |

### Slack の受信 Webhook を作る

1. <https://api.slack.com/apps> → 「Create New App」→「From scratch」
2. アプリ名（例：8ec お問い合わせ通知）と通知先ワークスペースを選ぶ
3. 左メニュー「Incoming Webhooks」を On にする
4. 「Add New Webhook to Workspace」→ 通知したいチャンネルを選んで許可
5. 表示された URL を、Vercel の `SLACK_WEBHOOK_URL` に貼る

Webhook URL は **サーバー側の環境変数としてのみ参照** し、ブラウザに配信されるコードには
一切含めません（含めると URL を知った第三者が自由にチャンネルへ投稿できてしまうため）。

Slack 通知に失敗しても、お客様のフォーム送信は成功として扱います
（Slack 側の障害や URL 未設定で問い合わせを取りこぼさないため）。

---

## notion-proxy（Cloudflare Worker）

`notion-proxy/` は Notion のデータを安全に取得するためのプロキシで、
Vercel とは**別に** Cloudflare Workers へデプロイします（`NOTION_TOKEN` は
`wrangler secret put` で設定し、コードには含めません）。
詳細は [`notion-proxy/README.md`](notion-proxy/README.md) を参照してください。

---

## メモ

- 全ページ相対パス構成のため、独自ドメイン直下でもサブパスでも動作します。
- `.claude/settings.local.json`（各自のマシン依存設定）は `.gitignore` 済みでコミットされません。
