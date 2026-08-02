#!/usr/bin/env python3
"""在庫データをCSVで書き出す。

    python3 tools/export-csv.py [出力先.csv]

仕入先に画像を依頼するときの型番リストや、社内で内容を確認するときに使う。
Excelでそのまま開けるよう、BOM付きUTF-8・CRLF で出力する。
"""

import csv
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INVENTORY = ROOT / "assets" / "inventory-data.js"
IMAGES_JSON = ROOT / "assets" / "product-images.json"

# (CSVの見出し, レコードのキー)。並びはそのままCSVの列順になる
COLUMNS = [
    ("分類", "source"),
    ("カテゴリ", "category"),
    ("メーカー", "maker"),
    ("型番", "model"),
    ("商品名", "name"),
    ("仕様・備考", "description"),
    ("商品コード", "productCode"),
    ("標準価格(税抜)", "listPrice"),
    ("在庫数", "stock"),
    ("在庫レンジ", "stockLabel"),
    ("入荷後引当可能数", "incomingAvailable"),
    ("入荷予定日", "leadTime"),
    ("終息情報", "status"),
    ("在庫更新日", "updated"),
    ("仕入先URL", "url"),
    ("商品画像URL", "image"),
    ("メーカーページ", "manufacturerPage"),
]


def load_inventory():
    src = INVENTORY.read_text(encoding="utf-8")
    return json.loads(src[src.index("{"):].rstrip().rstrip(";"))


def load_images():
    if not IMAGES_JSON.exists():
        return {}
    return json.loads(IMAGES_JSON.read_text(encoding="utf-8")).get("images", {})


def main():
    data = load_inventory()
    images = load_images()
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / f"在庫一覧_{date.today().isoformat()}.csv"

    # Excelで文字化けしないよう BOM 付き、改行は CRLF
    with out.open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh, lineterminator="\r\n")
        w.writerow([label for label, _ in COLUMNS] + ["商品画像の有無"])

        for rec in data["records"]:
            row = []
            for _, key in COLUMNS:
                value = rec.get(key, "")
                if key == "image" and not value:
                    entry = images.get(rec.get("model", ""))
                    value = entry.get("src", "") if entry else ""
                row.append("" if value is None else value)
            has_image = bool(rec.get("image")) or rec.get("model", "") in images
            row.append("あり" if has_image else "なし（イメージ図）")
            w.writerow(row)

    print(f"{out} に {len(data['records'])} 件を書き出しました")
    counts = {}
    for rec in data["records"]:
        counts[rec["source"]] = counts.get(rec["source"], 0) + 1
    for source, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {source}: {n}")


if __name__ == "__main__":
    main()
