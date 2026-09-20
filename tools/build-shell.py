#!/usr/bin/env python3
"""公開サイトの共通ヘッダー・フッター・最終CTAを、全ページへ同じ形で入れる。

  なぜスクリプトにするか
    このサイトはビルドを持たない静的HTMLなので、共通部分をJSで描くと
    検索エンジン・AIの読み取りに不利になる。かといって手で同じHTMLを
    何ページにも貼ると必ずずれる。そこで「1か所で書いて、全ページへ流し込む」。

  使い方
    python3 tools/build-shell.py          … 全ページを書き換える
    python3 tools/build-shell.py --check  … ずれているページがないか見るだけ

  各ページ側には、次の目印を置いておく（中身は毎回この スクリプトが入れ替える）。
    <!-- SHELL:HEADER --> … <!-- /SHELL:HEADER -->
    <!-- SHELL:LEAD -->   … <!-- /SHELL:LEAD -->     最終CTA（3分で無料診断）
    <!-- SHELL:FOOTER --> … <!-- /SHELL:FOOTER -->
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ヘッダーの並び。どのページでも同じ。active はページ側の指定で決まる
NAV = [
    ("rent",  "/rent", "レンタル"),
    ("buy",   "/buy",  "購入"),
    ("pc",    "/pc",   "法人PC"),
    ("support", "/support", "導入支援"),
    ("faq",   "/faq",  "よくある質問"),
]

# 共通の主CTA。サイト全体でこの1つに寄せる
CTA_LABEL = "3分で無料診断"
CTA_HREF = "/quote"


def header(active: str) -> str:
    items = "".join(
        '\n        <a href="%s"%s>%s</a>' % (href, ' aria-current="page"' if key == active else "", label)
        for key, href, label in NAV
    )
    return f'''<header class="c-head">
      <div class="in">
        <a class="logo" href="/" aria-label="COMMERCE（エイトコマース）トップへ">
          <img src="/assets/commerce-logo.png" alt="COMMERCE エイトコマース" width="260" height="56" decoding="async">
        </a>
        <nav class="c-nav" aria-label="メインナビゲーション">{items}
        </nav>
        <a class="cta" href="{CTA_HREF}" data-lead="header">{CTA_LABEL}</a>
      </div>
    </header>'''


def lead(variant: str = "") -> str:
    """どのページの最後にも置く、診断への導線。"""
    return f'''<section class="c-lead">
      <div class="in">
        <h2>何を選べばいいか分からなくても大丈夫です。</h2>
        <p>人数・用途・期間を選ぶだけで、購入・レンタル・その組み合わせのどれが合うかをご提案します。
          入力は3分ほど。お見積りは無料で、この時点で費用は発生しません。</p>
        <div class="row">
          <a class="c-cta" href="{CTA_HREF}" data-lead="{variant or 'footer'}">{CTA_LABEL}</a>
          <a class="c-cta ghost" href="/rent">レンタル商品を見る</a>
          <a class="c-cta ghost" href="/buy">購入できる商品を見る</a>
        </div>
        <div class="marks"><span>見積無料</span><span>1台から相談OK</span>
          <span>在庫がなくても調達可能</span><span>購入・レンタルは後から決められる</span></div>
      </div>
    </section>'''


FOOTER = '''<footer class="c-foot">
      <div class="in">
        <div class="brand">
          <img src="/assets/commerce-logo.png" alt="COMMERCE エイトコマース" width="260" height="56" decoding="async">
          <p>法人向けに、IT機器の調達・レンタル・販売・設定をまとめて承ります。
            PCからネットワーク、セキュリティ、会議室機器まで。1台からご相談いただけます。</p>
        </div>
        <div class="col">
          <h3>サービス</h3>
          <a href="/rent">レンタル（8RENT）</a>
          <a href="/buy">購入（法人IT販売）</a>
          <a href="/pc">法人PC</a>
          <a href="/support">導入支援</a>
          <a href="/care">8RENT Care</a>
        </div>
        <div class="col">
          <h3>探す・知る</h3>
          <a href="/quote">3分で無料診断</a>
          <a href="/cases">活用例・導入イメージ</a>
          <a href="/faq">よくある質問</a>
          <a href="/column/">コラム</a>
        </div>
        <div class="col">
          <h3>会社</h3>
          <a href="/company.html">会社概要</a>
          <a href="/cloud.html">クラウド情シス</a>
          <a href="/ai-dev.html">AI・業務システム開発</a>
          <a href="/#contact">お問い合わせ</a>
        </div>
      </div>
      <div class="base">
        <div class="in">
          <span>運営会社：株式会社エイト（COMMERCE／8RENT）</span>
          <a href="/privacy.html">プライバシーポリシー</a>
          <a href="/terms.html">利用規約</a>
          <a href="/tokushou.html">特定商取引法に基づく表記</a>
          <span>© 8 Inc.</span>
        </div>
      </div>
    </footer>'''


def replace(text: str, name: str, body: str) -> str:
    pat = re.compile(r"(<!-- SHELL:%s(?::[a-z-]+)? -->)(.*?)(<!-- /SHELL:%s -->)" % (name, name), re.S)
    if not pat.search(text):
        return text
    return pat.sub(lambda m: m.group(1) + "\n" + body + "\n    " + m.group(3), text)


def active_of(text: str) -> str:
    m = re.search(r"<!-- SHELL:HEADER(?::([a-z-]+))? -->", text)
    return (m.group(1) or "") if m else ""


def main() -> int:
    check = "--check" in sys.argv
    changed = []
    for path in sorted(list(ROOT.glob("*.html")) + list(ROOT.glob("*/*.html"))):
        if "/zaiko/" in str(path) or "/shop/" in str(path) or "/admin/" in str(path):
            continue
        text = path.read_text(encoding="utf-8")
        if "<!-- SHELL:HEADER" not in text:
            continue
        out = replace(text, "HEADER", header(active_of(text)))
        out = replace(out, "LEAD", lead(path.stem))
        out = replace(out, "FOOTER", FOOTER)
        if out != text:
            changed.append(path.relative_to(ROOT))
            if not check:
                path.write_text(out, encoding="utf-8")
    if check:
        print("ずれているページ:", ", ".join(map(str, changed)) or "なし")
        return 1 if changed else 0
    print("そろえたページ:", ", ".join(map(str, changed)) or "なし（すべて最新）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
