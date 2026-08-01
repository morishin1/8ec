#!/usr/bin/env python3
"""コラムを1本追加する。記事の自動生成ルーティンが呼ぶ入口。

    python3 tools/new-column.py --slug wifi-slow-office \\
        --title "オフィスのWi-Fiが遅い原因を、現地調査の実データで切り分ける" \\
        --description "..." --category ネットワーク --read 8 --query アクセスポイント

assets/columns.json に1件足し、column/_content/<slug>.html の雛形を作る。
本文を書き込んだあと tools/build-columns.py を実行すると、記事ページと一覧が出力される。

--topics を付けると、既出テーマと重複しない切り口を選ぶための材料として、
未使用の想定テーマ一覧だけを表示して終了する。
"""

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLUMNS = ROOT / "assets" / "columns.json"
CONTENT = ROOT / "column" / "_content"

# 中小企業がAI・IT機器で実際に詰まる論点。ルーティンはここから未使用のものを選ぶ
TOPIC_POOL = [
    ("AI活用", "生成AIの社内ルールを、A4一枚で作るなら何を書くか"),
    ("AI活用", "AI議事録を導入しても議事録が減らない会社の共通点"),
    ("AI活用", "社内問い合わせをAIに任せる前に、情シスが用意する3点"),
    ("AI活用", "AI搭載PC（NPU）は今買うべきか、様子を見るべきか"),
    ("コスト", "IT予算が毎年膨らむ会社が見直していない固定費"),
    ("コスト", "ライセンスの棚卸しで、使われていない席を見つける手順"),
    ("情シス運用", "情シス担当が1人の会社で、属人化を止める最低限の記録"),
    ("情シス運用", "入退社が重なる4月に、PC手配が間に合わなくなる理由"),
    ("情シス運用", "資産管理台帳をExcelで回し続けるときの限界と対処"),
    ("ネットワーク", "オフィスのWi-Fiが遅い原因を、現地調査の実データで切り分ける"),
    ("ネットワーク", "拠点を増やすときのネットワーク設計、最初の分岐点"),
    ("ネットワーク", "在宅勤務のVPNが遅い、を回線契約以外で改善する"),
    ("セキュリティ", "中小企業がまず埋めるべきセキュリティの穴は入退社処理"),
    ("セキュリティ", "UTMを入れたのに守れていない、が起きる設定の落とし穴"),
    ("セキュリティ", "ランサムウェア対策として、バックアップをどう置くか"),
    ("選び方", "法人ノートPCの選定で、スペック表に出ない比較軸"),
    ("選び方", "モニターは何インチ・何枚が業務効率に効くのか"),
    ("選び方", "オフィス移転のIT準備を、逆算スケジュールで組む"),
]

TEMPLATE = """    <h2>（見出し1：読者が抱えている状況を言語化する）</h2>
    <p>（本文）</p>

    <h2>（見出し2：原因や判断基準を、数字か表で示す）</h2>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>項目</th><th>内容</th><th>目安</th></tr></thead>
        <tbody>
          <tr><td></td><td></td><td class="num"></td></tr>
        </tbody>
      </table>
    </div>

    <div class="note">
      <p><strong>目安：</strong>（読者が自社に当てはめられる具体的な数字や手順）</p>
    </div>

    <h2>（見出し3：実際にどう進めるか）</h2>
    <ol>
      <li></li>
    </ol>

    <h2>まとめ</h2>
    <ul>
      <li></li>
    </ul>
"""


def load():
    return json.loads(COLUMNS.read_text(encoding="utf-8"))


def show_topics():
    data = load()
    used = {a["title"] for a in data["articles"]}
    print("未使用のテーマ候補：")
    for category, title in TOPIC_POOL:
        if title not in used:
            print(f"  [{category}] {title}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--topics", action="store_true", help="未使用のテーマ候補を表示して終了")
    ap.add_argument("--slug", help="URLに使う英小文字・ハイフンのスラッグ")
    ap.add_argument("--title")
    ap.add_argument("--description")
    ap.add_argument("--category", default="情シス運用")
    ap.add_argument("--read", type=int, default=7, help="読了目安（分）")
    ap.add_argument("--query", default="", help="記事末の在庫検索リンクに使うキーワード")
    ap.add_argument("--date", default=date.today().isoformat())
    args = ap.parse_args()

    if args.topics:
        show_topics()
        return

    for field in ("slug", "title", "description"):
        if not getattr(args, field):
            sys.exit(f"--{field} は必須です（--topics でテーマ候補を確認できます）")
    if not re.fullmatch(r"[a-z0-9-]+", args.slug):
        sys.exit("--slug は英小文字・数字・ハイフンのみで指定してください")

    data = load()
    if any(a["slug"] == args.slug for a in data["articles"]):
        sys.exit(f"スラッグ {args.slug} は既に使われています")
    if any(a["title"] == args.title for a in data["articles"]):
        sys.exit("同じタイトルの記事が既にあります")

    data["articles"].append({
        "slug": args.slug,
        "title": args.title,
        "description": args.description,
        "category": args.category,
        "date": args.date,
        "readMinutes": args.read,
        "relatedQuery": args.query,
    })
    data["updated"] = date.today().isoformat()
    COLUMNS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    CONTENT.mkdir(parents=True, exist_ok=True)
    body = CONTENT / f"{args.slug}.html"
    if not body.exists():
        body.write_text(TEMPLATE, encoding="utf-8")

    print(f"追加しました: {body.relative_to(ROOT)}")
    print("本文を書いたあと、python3 tools/build-columns.py を実行してください。")


if __name__ == "__main__":
    main()
