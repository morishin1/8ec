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
├── assets/             画像・ロゴ・favicon
├── blog/               CMS 貼り付け用の自己完結HTML（4種）※詳細は blog/README.md
├── notion-proxy/       Notion API プロキシ（Cloudflare Worker・別デプロイ／Vercel配信対象外）
├── archive/            本番未リンクの過去生成物（参考保管／Vercel配信対象外）
│
├── vercel.json         Vercel 設定（静的配信・URL挙動）
└── .vercelignore       Vercel に配信しないもの（archive/・notion-proxy/ 等）
```

> `archive/` `notion-proxy/` は `.vercelignore` で **公開対象から除外** しています。

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

## notion-proxy（Cloudflare Worker）

`notion-proxy/` は Notion のデータを安全に取得するためのプロキシで、
Vercel とは**別に** Cloudflare Workers へデプロイします（`NOTION_TOKEN` は
`wrangler secret put` で設定し、コードには含めません）。
詳細は [`notion-proxy/README.md`](notion-proxy/README.md) を参照してください。

---

## メモ

- 全ページ相対パス構成のため、独自ドメイン直下でもサブパスでも動作します。
- `.claude/settings.local.json`（各自のマシン依存設定）は `.gitignore` 済みでコミットされません。
