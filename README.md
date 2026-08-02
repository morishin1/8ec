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
├── admin/              管理画面（EC在庫・ショップ出品・問い合わせ・レンタル）
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
