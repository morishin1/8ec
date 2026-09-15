#!/usr/bin/env python3
"""セットアップSQLを、流す前に機械的に点検する。

    python3 tools/check-sql.py

いま見ているのは1点だけ。

  WHERE のない DELETE / UPDATE が無いこと

Supabase では「WHEREのないDELETE/UPDATE」を禁止する保護（safeupdate）を
入れられる。入っていると関数の中でも弾かれ、
「DELETE requires a WHERE clause」で止まる。

なお `where true` や `where 1=1` はプランナに畳み込まれて消えるため、
保護をすり抜けられない。全行が対象でよいときは、主キーへの
`is not null` のように、プランに Filter として残る条件を書くこと。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"archive", "node_modules", ".git"}
# プランナに畳み込まれて消えてしまい、保護をすり抜けられない書き方
FOLDED = re.compile(r"\bwhere\s+(true|1\s*=\s*1)\s*(?:;|$|\))", re.I)


def statements(sql):
    """コメントと文字列リテラルを外してから、文に切り分ける。"""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    sql = re.sub(r"--[^\n]*", " ", sql)
    # $$ ... $$ の中も対象にしたいので、区切りだけ空白にする
    sql = sql.replace("$$", " ")
    for m in re.finditer(r"[^;]+;", sql):
        yield m.group(0), sql[: m.start()].count("\n") + 1


def check(path):
    sql = path.read_text(encoding="utf-8")
    bad = []
    for stmt, line in statements(sql):
        flat = " ".join(stmt.split())
        # on conflict ... do update set は「WHEREのないUPDATE」ではない
        head = re.match(r"\s*(delete\s+from|update)\s+[a-zA-Z0-9_.\"]+", flat, re.I)
        if not head:
            # CTE の中（with d as (delete from ...)）も拾う
            head = re.search(r"\b(delete\s+from)\s+[a-zA-Z0-9_.\"]+", flat, re.I)
            if not head:
                continue
        kind = "DELETE" if head.group(1).lower().startswith("delete") else "UPDATE"
        if kind == "UPDATE" and not re.match(r"\s*update\b", flat, re.I):
            continue
        if not re.search(r"\bwhere\b", flat, re.I):
            bad.append((line, kind, "WHERE がありません", flat[:100]))
        elif FOLDED.search(flat):
            bad.append((line, kind, "where true / 1=1 は畳み込まれて消えます", flat[:100]))
    return bad


def main():
    files = [p for p in sorted(ROOT.rglob("*.sql"))
             if not SKIP_DIRS & set(p.relative_to(ROOT).parts)]
    total = 0
    for f in files:
        for line, kind, why, stmt in check(f):
            total += 1
            print(f"{f.relative_to(ROOT)}:{line}  {kind}: {why}\n    {stmt}")
    if total:
        print(f"\n{total} 件見つかりました。全行が対象なら、主キーへの is not null を付けてください。")
        return 1
    print(f"{len(files)} 本のSQLを確認しました。WHERE のない DELETE / UPDATE はありません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
