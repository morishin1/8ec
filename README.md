# 8ec.jp — 株式会社エイト コーポレートサイト

法人向け総合ITサービス「株式会社エイト」（[8ec.jp](https://8ec.jp/)）の静的サイトです。
これまで ZIP でやり取りしていたものを **git 管理下に整備** し、
リニューアル作業を差分・レビュー・履歴付きで進められるようにしています。

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
│
├── blog/               CMS 貼り付け用の自己完結HTML（4種）※詳細は blog/README.md
│
├── notion-proxy/       Notion API プロキシ（Cloudflare Worker・別デプロイ）
│
└── archive/            本番からリンクされていない過去の生成物（参考保管）
    ├── スピードレンタルPC.html   （旧ビルダー出力・8.5MB / 現在は pc.html に置換済み）
    └── index-bundle-src.html
```

> `archive/` の中身は本番サイトからは配信されません（公開対象から除外）。
> 履歴として残しているだけなので、不要になれば削除して構いません。

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

## デプロイ（git 連動 / GitHub Pages）

`main` ブランチへ push（マージ）されると、GitHub Actions
（[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)）が
静的サイトを **GitHub Pages へ自動公開** します。

公開URL（ステージング）: **https://morishin1.github.io/8ec/**

`archive/` `notion-proxy/` `README.md` などは公開対象から除外されます。

### 初回だけ必要な設定

リポジトリの **Settings → Pages → Build and deployment → Source** を
**「GitHub Actions」** に設定してください（初回の1回のみ）。
以降は `main` への push ごとに自動反映されます。

### リニューアルの進め方（推奨フロー）

1. 作業用ブランチを切る（例: `git switch -c feature/top-renewal`）
2. HTML/CSS/JS を編集してコミット
3. Pull Request を作成 → 差分をレビュー
4. `main` にマージ → GitHub Pages（ステージング）へ自動反映
5. 内容を確認できたら本番化（下記）

### 本番 8ec.jp への切り替えについて

現状、本番 `8ec.jp` のホスティング／DNS はこのリポジトリからは**変更していません**。
GitHub Pages で仕上がりを確認し、準備ができた段階で以下のいずれかを行います。

- **A.** `8ec.jp` の DNS を GitHub Pages に向け、独自ドメインとして公開する
  （Settings → Pages → Custom domain に `8ec.jp` を設定）
- **B.** 別ホスティング（Cloudflare Pages / 既存レンタルサーバー等）へ
  自動デプロイするワークフローに差し替える

どちらで進めるか決まったら、切り替え手順をこの README に追記します。

---

## notion-proxy（Cloudflare Worker）

`notion-proxy/` は Notion のデータを安全に取得するためのプロキシで、
GitHub Pages とは**別に** Cloudflare Workers へデプロイします。
詳細は [`notion-proxy/README.md`](notion-proxy/README.md) を参照してください。

---

## メモ

- 全ページ相対パス構成のため、独自ドメイン直下でもサブパス（`/8ec/`）でも動作します。
- `.claude/settings.local.json`（各自のマシン依存設定）は `.gitignore` 済みでコミットされません。
