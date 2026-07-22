# Notion お問い合わせフォーム連携

株式会社エイトの LP (`index.html`) のお問い合わせフォームから送信された内容を、
Notion の **「8grp問い合わせ管理」** データベースに自動追加するための
サーバーレス・プロキシです。

## 構成

```
┌─────────────┐   POST JSON   ┌──────────────────────┐   Notion API   ┌────────────────────┐
│  index.html │ ────────────▶ │  Cloudflare Worker   │ ─────────────▶ │ 8grp問い合わせ管理 │
│   (form)    │               │ eight-notion-proxy   │                │   (Notion DB)      │
└─────────────┘   200 / 502   └──────────────────────┘                └────────────────────┘
```

- **DB URL**: https://www.notion.so/65cbf47d1d4944a38e319639aaf54dec
- **Database ID**: `591ade7c-f5ff-492c-b150-3418b9e43c29`

## フィールドマッピング

| フォーム入力       | Notionプロパティ       | 備考                                     |
|--------------------|------------------------|------------------------------------------|
| お名前             | お名前 (title)         | 必須                                     |
| 会社名             | 会社名 (text)          |                                          |
| メールアドレス     | メールアドレス (email) | 必須・形式チェックあり                   |
| 電話番号           | 電話番号 (phone)       |                                          |
| ご利用用途         | お問い合わせ内容       | `【ご利用用途】…` として合成             |
| 希望台数           | お問い合わせ内容       | `【希望台数】…`                          |
| ご利用期間         | お問い合わせ内容       | `【ご利用期間】…`                        |
| ご要望・補足       | お問い合わせ内容       | `【ご要望・補足】…`                      |
| (自動)             | 件名 (text)            | `PCレンタル見積もり依頼：会社名 or 名前` |
| (自動・固定)       | お問い合わせ種別       | `レンタル問い合わせ` ※要事前追加         |
| (自動・固定)       | ステータス             | `未対応`                                 |
| (自動・固定)       | 重要度                 | `普通`                                   |
| (自動)             | 受信日時 (date)        | 送信時刻                                 |

### Notion側の「お問い合わせ種別」選択肢

| 値                         | 用途                                           |
|----------------------------|------------------------------------------------|
| サービスについて           | 既存（汎用サービス問い合わせ）                 |
| 採用について               | 既存                                           |
| 協業・パートナーについて   | 既存                                           |
| 取材・メディアについて     | 既存                                           |
| その他                     | 既存                                           |
| **レンタル問い合わせ**     | **このLPからの送信で使用** (黄色)              |

## デプロイ手順

### 1. Notion側の準備

1. https://www.notion.so/my-integrations で **「New integration」** を作成
   - Type: **Internal**
   - ワークスペース: `eight88` など該当のもの
2. 作成後に表示される **Internal Integration Secret**（`ntn_...` または `secret_...`）をコピー
3. Notionで **「8grp問い合わせ管理」DB** を開き、右上 **「…」 → 「接続」 → 作成したIntegrationを招待**
   （これをしないと Worker から書き込めません）

### 2. Cloudflare Worker をデプロイ

```bash
cd notion-proxy

# 初回のみ
npm install -g wrangler
wrangler login

# シークレット登録（対話プロンプトで貼り付け）
wrangler secret put NOTION_TOKEN
wrangler secret put ALLOWED_ORIGIN   # 例: https://8ec.jp  (未設定時は * = 誰からでも可)

# 任意：デフォルトDB以外を使う場合のみ
# wrangler secret put NOTION_DATABASE_ID

# デプロイ
wrangler deploy
```

デプロイ後、`https://eight-notion-proxy.<account>.workers.dev/api/contact` という URL が発行されます。

### 3. フォーム送信先を設定

#### パターンA: 同一ドメインに Worker を載せる（推奨）

Cloudflare ダッシュボードで Worker Route を追加：

```
Route: 8ec.jp/api/*
Zone:  8ec.jp
Worker: eight-notion-proxy
```

この設定なら `index.html` の `CONTACT_ENDPOINT = "/api/contact"` のままで動作します。

#### パターンB: Workers.dev サブドメインを直接指定

`index.html` を編集：

```js
const CONTACT_ENDPOINT = "https://eight-notion-proxy.<your-account>.workers.dev/api/contact";
```

この場合、Worker 側の `ALLOWED_ORIGIN` を LP のドメインに合わせて必ず設定してください
（CORS でブロックされないため）。

## 動作確認

```bash
curl -X POST https://eight-notion-proxy.<account>.workers.dev/api/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "テスト太郎",
    "company": "テスト株式会社",
    "email": "test@example.com",
    "tel": "03-0000-0000",
    "use": "training",
    "qty": "2〜5台",
    "term": "1ヶ月",
    "note": "動作確認テスト送信",
    "source": "curl test"
  }'
```

成功時 `{"ok":true,"pageId":"..."}` が返り、Notion の「8grp問い合わせ管理」に追加されます。

## トラブルシューティング

| 症状                                   | 原因 / 対処                                                                      |
|----------------------------------------|----------------------------------------------------------------------------------|
| 502 Notion API error / 401 Unauthorized | `NOTION_TOKEN` が未設定／誤り、またはDBにIntegration未招待                       |
| 502 / `object_not_found`               | DBがIntegrationと接続されていない（DB右上「…」→「接続」から追加）                |
| フロントで `Failed to fetch`           | CORS。`ALLOWED_ORIGIN` を LPのオリジンに一致させる                               |
| 400 `valid email is required`          | フォームのメール欄が空 or フォーマット不正                                       |
| 送信は成功するのに Notion に出ない     | 別のDBに入っている可能性。`NOTION_DATABASE_ID` を確認                            |
| 500 `option does not exist`            | 「お問い合わせ種別」に `レンタル問い合わせ` オプションが未登録。DB側で追加要     |

## セキュリティ

- `NOTION_TOKEN` は Cloudflare Workers の Secret として保持。フロントには一切渡らない。
- フォームにハニーポット (`name="website"` 隠しフィールド) あり。bot入力は 200 で黙って破棄。
- `ALLOWED_ORIGIN` で CORS を LPドメインに絞れば、他サイトからの転用を防げる。
- レート制限は未実装。大量送信が気になる場合は Cloudflare Rate Limiting Rules または
  Worker内で Turnstile 等の CAPTCHA 検証を追加することを推奨。

## ファイル

- `worker.js`     — Worker本体（1ファイル）
- `wrangler.toml` — Wrangler 設定
- `README.md`     — このファイル
