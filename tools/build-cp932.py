#!/usr/bin/env python3
"""Shift_JIS(CP932)の符号化表を admin/ec/cp932.js に書き出す。

    python3 tools/build-cp932.py

ブラウザは TextDecoder で Shift_JIS を「読む」ことはできるが「書く」ことはできない
（Encoding Standard がUTF-8以外のエンコーダを持たないと定めている）。
楽天RMSやYahoo!ショッピングの商品CSVは Shift_JIS で受け取る想定なので、
出力側だけ自前の変換表が要る。取り込み側は TextDecoder に任せるのでこの表は使わない。

表は「Unicode の連番と CP932 の連番が並走する区間」に畳んでから、
前の区間との差分を36進数で並べる。9,280文字ぶんが約80KBに収まる。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "admin" / "ec" / "cp932.js"

LO, HI = 0x80, 0x10000
D = "0123456789abcdefghijklmnopqrstuvwxyz"


def b36(n):
    """36進数にする。CP932の値はUnicode順に増えていかない（半角カナなど）ので、
    差分がマイナスになることがある。JavaScript の parseInt(s,36) は先頭の '-' を
    そのまま読むので、符号は前に付けるだけでよい。"""
    if n == 0:
        return "0"
    sign, n = ("-", -n) if n < 0 else ("", n)
    s = ""
    while n:
        s = D[n % 36] + s
        n //= 36
    return sign + s


def build():
    # 1文字ずつ encode すると環境によっては極端に遅いので、改行で区切って一括変換する。
    # CP932 の2バイト目に 0x0A は現れないため、結果を b"\n" で切り分けて元の文字に対応づけられる。
    chunks = "\n".join(chr(c) for c in range(LO, HI)).encode("cp932", "replace").split(b"\n")
    pairs = {}
    for i, b in enumerate(chunks):
        if len(b) == 1 and b != b"?":      # b"?" は変換できなかった文字
            pairs[LO + i] = b[0]
        elif len(b) == 2:
            pairs[LO + i] = (b[0] << 8) | b[1]

    ranges, cur = [], None
    for cp in sorted(pairs):
        v = pairs[cp]
        if cur and cp == cur[0] + cur[2] and v == cur[1] + cur[2]:
            cur[2] += 1
        else:
            cur = [cp, v, 1]
            ranges.append(cur)

    out, pu, ps = [], 0, 0
    for u, v, ln in ranges:
        out.append(b36(u - pu) + "," + b36(v - ps) + ("" if ln == 1 else "," + b36(ln)))
        pu, ps = u + ln, v + ln
    return pairs, ranges, "|".join(out)


def verify(pairs):
    """表どおりに符号化した結果が Python の cp932 と一致するか確かめる。"""
    bad = []
    for cp, v in pairs.items():
        want = bytes([v]) if v < 0x100 else bytes([v >> 8, v & 0xFF])
        if chr(cp).encode("cp932", "replace") != want:
            bad.append(cp)
    return bad


def main():
    pairs, ranges, table = build()
    bad = verify(pairs)
    if bad:
        raise SystemExit(f"変換表が cp932 と一致しません（{len(bad)}文字）")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "/* Shift_JIS(CP932) の符号化表。tools/build-cp932.py が生成する。手で編集しない。\n"
        f"   {len(pairs)}文字 / {len(ranges)}区間。\n"
        "   ブラウザは Shift_JIS を読めても書けないので、商品CSVを出力するときだけ使う。 */\n"
        "(function(){\n"
        '  var T="' + table + '";\n'
        "  var map=null;\n"
        "  function build(){\n"
        "    map=new Map();\n"
        "    var u=0,s=0,i,p,a,n,len,k;\n"
        '    var rows=T.split("|");\n'
        "    for(i=0;i<rows.length;i++){\n"
        '      p=rows[i].split(",");\n'
        "      a=u+parseInt(p[0],36); n=s+parseInt(p[1],36); len=p.length>2?parseInt(p[2],36):1;\n"
        "      for(k=0;k<len;k++) map.set(a+k,n+k);\n"
        "      u=a+len; s=n+len;\n"
        "    }\n"
        "    return map;\n"
        "  }\n"
        "  /* 文字列を Shift_JIS のバイト列にする。変換できない文字は fallback（既定は '?'）。 */\n"
        "  function encode(str,fallback){\n"
        "    var m=map||build();\n"
        "    var fb=(fallback==null?0x3f:fallback);\n"
        "    var out=[],i,c,v;\n"
        "    for(i=0;i<str.length;i++){\n"
        "      c=str.charCodeAt(i);\n"
        "      if(c<0x80){ out.push(c); continue; }\n"
        "      v=m.get(c);\n"
        "      if(v==null){ out.push(fb); }\n"
        "      else if(v<0x100){ out.push(v); }\n"
        "      else { out.push(v>>8, v&0xff); }\n"
        "    }\n"
        "    return new Uint8Array(out);\n"
        "  }\n"
        "  /* 変換できない文字を拾う。CSVを出す前に警告するために使う。 */\n"
        "  function unmappable(str){\n"
        "    var m=map||build(), bad=[], i, c;\n"
        "    for(i=0;i<str.length;i++){\n"
        "      c=str.charCodeAt(i);\n"
        "      if(c>=0x80&&m.get(c)==null&&bad.indexOf(str[i])<0) bad.push(str[i]);\n"
        "    }\n"
        "    return bad;\n"
        "  }\n"
        "  window.EightCP932={encode:encode,unmappable:unmappable};\n"
        "})();\n",
        encoding="utf-8",
    )
    print(f"{OUT.relative_to(ROOT)} を書き出しました（{len(pairs)}文字 / {OUT.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
