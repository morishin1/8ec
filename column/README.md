# IT調達コラム

中小企業がAI導入やIT機器の入れ替えでつまずくポイントを、実例と数字で解決するコラムです。
オーガニック検索での流入を、そのまま見積もり・構築の相談につなげることが目的です。

## 構成

| パス | 役割 |
|---|---|
| `assets/columns.json` | 記事の目次（タイトル・説明・カテゴリ・日付・関連キーワード） |
| `column/_content/<slug>.html` | 記事本文だけを書いたHTML断片 |
| `column/<slug>.html` | 生成物。直接編集しない |
| `column/index.html` | 生成物。コラム一覧 |
| `column/column.css` | 共通スタイル |
| `tools/new-column.py` | 記事を1本追加する（目次への追記＋本文の雛形作成） |
| `tools/build-columns.py` | 目次と本文から記事ページ・一覧・sitemap を出力 |

トップページ（`index.html`）のコラム欄は `assets/columns.json` を読み、最新3本を表示します。
ヘッダーの「IT調達コラム」は `/column/` を指しています。

## 手で1本書くとき

```bash
python3 tools/new-column.py --topics          # 未使用のテーマ候補を見る

python3 tools/new-column.py \
  --slug wifi-slow-office \
  --title "オフィスのWi-Fiが遅い原因を、現地調査の実データで切り分ける" \
  --description "APの台数を足す前に測るべき3点を、実測値をもとに整理します。" \
  --category ネットワーク --read 8 --query アクセスポイント

# column/_content/wifi-slow-office.html に本文を書く
python3 tools/build-columns.py
```

`--query` に入れたキーワードは、記事末の「在庫と価格を見る」ボタンのリンク先
（`/?q=<キーワード>`）になります。トップページはこのクエリを受け取って
検索結果を絞り込んだ状態で開くので、記事から見積もりまで一直線でつながります。

## 自動生成（週1本）

GitHub Actions の `.github/workflows/column-weekly.yml` が毎週月曜に走り、
Claude Code に記事を1本書かせて **プルリクエストを作成** します。
PRにはVercelのプレビューURLが付くので、そこで表示を確認してからマージしてください。
マージすると `main` への push で本番に反映されます。

自動生成に求めていること:

- 既出タイトルと重複しないテーマを `--topics` から選ぶ
- 一般論で終わらせず、読者が自社に当てはめられる数字・表・チェック項目を入れる
- 実績や納入事例など、裏を取れない固有の事実は書かない
- 最後に、該当する機器の在庫検索か見積もりへつなぐ

**必要な設定：** リポジトリの Secrets に `ANTHROPIC_API_KEY` を登録してください。
未登録のあいだワークフローは何もせず終了します（失敗扱いにはなりません）。

自動化を止めたいときは、GitHub の Actions 画面でこのワークフローを無効化するか、
`.github/workflows/column-weekly.yml` を削除してください。
