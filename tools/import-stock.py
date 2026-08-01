#!/usr/bin/env python3
"""仕入先の在庫Excelを assets/inventory-data.js に取り込む。

在庫表は仕入先ごとにフォーマットが違い、更新のたびに手で直すと事故るので、
仕入先ごとの読み取りルールをこのファイルに集約している。

    pip install openpyxl
    python3 tools/import-stock.py <xlsx> [<xlsx> ...]

同じ型番が既にあれば在庫・価格・更新日だけ上書きし、
商品画像やメーカーページのURLなど手で足した情報は残す。
"""

import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "assets" / "inventory-data.js"

# 在庫表の「引当可能在庫数」などは空欄・"-"・全角が混ざるので、数値化はここに寄せる
def num(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "").replace("　", "")
    if not text or text in {"-", "―", "‐"}:
        return None
    text = text.translate(str.maketrans("０１２３４５６７８９", "0123456789"))
    return int(text) if re.fullmatch(r"\d+", text) else None


def text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def ymd(value):
    if isinstance(value, (datetime, date)):
        return (value.date() if isinstance(value, datetime) else value).isoformat()
    got = text(value)
    m = re.search(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})", got)
    return f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}" if m else ""


def rows_of(path, sheet, skip):
    book = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheet_obj = book[sheet]
    rows = list(sheet_obj.iter_rows(values_only=True))[skip:]
    book.close()
    return rows


# ---------------------------------------------------------------- 仕入先ごとの読み取り

def read_hpe(path):
    """SB C&S HPE サーバー・ストレージ在庫リスト。ヘッダーは8行目、基準日は3行目。"""
    updated = ymd(rows_of(path, "在庫表", 2)[0][1]) or "2026-07-24"
    out = []
    for row in rows_of(path, "在庫表", 8):
        model = text(row[3])
        if not model:
            continue
        record = {
            "source": "サーバー・ストレージ",
            "category": text(row[2]) or text(row[1]),
            "maker": "HPE",
            "model": model,
            "name": text(row[4]) or model,
            "productCode": text(row[5]),
            "stock": num(row[7]) or 0,
            "incomingAvailable": num(row[10]) or 0,
            "updated": updated,
        }
        if text(row[6]):
            record["status"] = text(row[6])
        if ymd(row[11]):
            record["leadTime"] = ymd(row[11])
        out.append(record)
    return out


def read_buffalo(path):
    """BUFFALO NW製品在庫状況。シートが機器種別、ヘッダーは3行目。価格欄は無い。"""
    updated = "2026-07-30"
    sheets = {
        "アクセスポイント": ("アクセスポイント", ["屋内外", "準拠規格", "PoE受電", "保証年数"], 5),
        "法人向け有線機器": ("法人向けスイッチ", ["ポート数", "シリーズ", "PoE給電", "最大伝送速度", "保証年数"], 5),
        "ルーター": ("ルーター", ["ポート数(WAN/LAN)", "VPN対地数", "NAT", "最大伝送速度", "保証年数"], 5),
    }
    out = []
    for sheet, (category, labels, first) in sheets.items():
        for row in rows_of(path, sheet, 3):
            model = text(row[2])
            if not model:
                continue
            specs = [
                f"{label} {text(row[first + i])}"
                for i, label in enumerate(labels)
                if first + i < len(row) and text(row[first + i]) not in {"", "-"}
            ]
            out.append({
                "source": "ネットワーク機器",
                "category": category,
                "maker": "バッファロー",
                "model": model,
                "name": model,
                "description": "／".join(specs),
                "productCode": text(row[1]),
                "stock": num(row[3]) or 0,
                "updated": updated,
            })
    return out


ELECOM_NETWORK = ("ネットワークケーブル", "Ｌ２スイッチ", "L2スイッチ", "無線アクセスポイント",
                  "ＬＡＮインターフェイス", "LANインターフェイス", "ハブ（イーサネットスイッチ）",
                  "ネットワークアダプター")


def read_elecom(path):
    """エレコム提供価格・在庫表。ヘッダーは3行目、在庫はレンジ表記（例 31~100）。"""
    updated = "2026-07-27"
    out = []
    for row in rows_of(path, "エレコム", 3):
        model = text(row[2])
        if not model:
            continue
        genre = text(row[6])
        record = {
            "source": "ネットワーク機器" if genre in ELECOM_NETWORK else "PC周辺機器",
            "category": genre or "PC・周辺機器",
            "maker": text(row[0]) or "エレコム",
            "model": model,
            "name": text(row[3]) or model,
            "productCode": text(row[1]),
            "updated": updated,
        }
        if num(row[4]):
            record["listPrice"] = num(row[4])
        if text(row[5]):
            record["stockLabel"] = text(row[5])
        if text(row[7]).startswith("http"):
            record["url"] = text(row[7])
        out.append(record)
    return out


def read_les(path):
    """LES（レノボ）PC在庫。型番の頭でノートPC・タブレット・周辺機器を振り分ける。"""
    updated = "2026-07-31"
    out = []
    for row in rows_of(path, "LES_PCStock在庫", 1):
        model = text(row[3])
        if not model:
            continue
        # レノボの型番は先頭2〜3桁で製品系列が決まる。既存データの分類に合わせている
        if re.match(r"^(21|83)", model):          # ThinkPad / IdeaPad・V シリーズ
            source, category = "PC・タブレット", "ノートブックＰＣ"
        elif model.startswith("ZA"):              # Tab シリーズ
            source, category = "PC・タブレット", "タブレット"
        elif re.match(r"^(11|12|13|30)", model):  # ThinkCentre / ThinkStation
            source, category = "PC・タブレット", "デスクトップ"
        else:                                     # オプション類（0A/0B/4X/40/4Y/6x など）
            source, category = "PC周辺機器", "PC・周辺機器"
        record = {
            "source": source,
            "category": category,
            "maker": "レノボ・ジャパン",
            "model": model,
            "name": text(row[4]) or model,
            "productCode": text(row[2]),
            "stock": num(row[6]) or 0,
            "updated": updated,
        }
        if num(row[5]):
            record["listPrice"] = num(row[5])
        out.append(record)
    return out


READERS = [
    ("HPE", lambda p: "HPE" in p.name.upper(), read_hpe),
    ("BUFFALO", lambda p: "NW" in p.name.upper() or "BUFFALO" in p.name.upper(), read_buffalo),
    ("LES", lambda p: "LES" in p.name.upper() or "PCSTOCK" in p.name.upper().replace("_", ""), read_les),
    ("エレコム", lambda p: True, read_elecom),
]

# 在庫の実数が入ってくる列を持つ仕入先。既存レコードの更新時、
# 実数とレンジ表記が混ざらないよう、入ってきた側の表記に合わせる
STOCK_KEYS = ("stock", "stockLabel", "incomingAvailable", "leadTime", "listPrice", "status")
# 手で足した情報は在庫更新で消さない
KEEP_KEYS = ("image", "manufacturerPage", "imageCredit", "description", "url")
# 分類は既存のものを正とする。仕入先の在庫表はジャンル名の粒度がまちまちで、
# 更新のたびに「デスクトップ」が「周辺機器」に落ちるといった事故が起きるため
PIN_KEYS = ("source", "category")


def load_existing():
    src = DATA.read_text(encoding="utf-8")
    start = src.index("{")
    return json.loads(src[start:].rstrip().rstrip(";"))


def merge(existing, incoming):
    by_model = {r["model"]: r for r in existing["records"]}
    added, updated_n = 0, 0

    for rec in incoming:
        old = by_model.get(rec["model"])
        if old is None:
            existing["records"].append(rec)
            by_model[rec["model"]] = rec
            added += 1
            continue
        for key in KEEP_KEYS:
            if key in old and key not in rec:
                rec[key] = old[key]
        for key in PIN_KEYS:
            if key in old:
                rec[key] = old[key]
        # 在庫表記が実数⇄レンジで切り替わったら、古い方の表記は残さない
        for key in STOCK_KEYS:
            old.pop(key, None)
        old.update(rec)
        updated_n += 1

    counts = {}
    for r in existing["records"]:
        counts[r["source"]] = counts.get(r["source"], 0) + 1
    existing["counts"] = dict(sorted(counts.items(), key=lambda kv: -kv[1]))
    existing["total"] = len(existing["records"])
    return added, updated_n


def main(paths):
    data = load_existing()
    before = len(data["records"])

    for raw in paths:
        path = Path(raw)
        for label, matches, reader in READERS:
            if matches(path):
                records = reader(path)
                added, updated_n = merge(data, records)
                print(f"{label:9s} {path.name}: 読み取り {len(records):4d}  新規 {added:4d}  更新 {updated_n:4d}")
                break

    data["version"] = f"{date.today().isoformat()}-data-v5"
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    DATA.write_text(f"window.EIGHT_INVENTORY = {body};\n", encoding="utf-8")

    print(f"\n合計 {before} → {data['total']} 件")
    for source, n in data["counts"].items():
        print(f"  {source}: {n}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
