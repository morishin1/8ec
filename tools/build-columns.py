#!/usr/bin/env python3
"""コラムの一覧ページと記事ページを組み立てる。

    python3 tools/build-columns.py

入力:
  assets/columns.json          記事の目次（タイトル・説明・カテゴリ・日付）
  column/_content/<slug>.html  記事本文だけを書いたHTML断片（h2 / p / ul / table など）

出力:
  column/index.html            コラム一覧
  column/<slug>.html           記事ページ（ヘッダー・フッター・見積もり導線を付けて出力）
  sitemap.xml                  コラムのURLを反映

本文だけを書けば体裁とSEOタグが揃うようにしてあるので、
記事を増やすときは _content に1ファイル足して columns.json に1行足す。
"""

import html
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLUMNS = ROOT / "assets" / "columns.json"
OUT = ROOT / "column"
CONTENT = OUT / "_content"
SITE = "https://8ec.jp"

NAV = """    <nav aria-label="メインナビゲーション">
      <a href="/#search">商品を探す</a>
      <a href="/#setup">設定・構築</a>
      <a href="/column/">IT調達コラム</a>
      <a href="/#flow">導入の流れ</a>
      <a href="/cloud.html">クラウド情シス</a>
      <a href="/shop/">ショップ</a>
      <a class="nav-cta" href="/#contact">無料見積もり →</a>
    </nav>"""

FOOTER = """<footer>
  <div class="wrap ft">
    <div class="brand">
      <span class="brand-mark" style="width:26px;height:26px;font-size:13px">8</span>
      <span style="font-size:12px;color:var(--muted)">EIGHT COMMERCE ／ 株式会社エイトが運営</span>
    </div>
    <div class="ft-links">
      <a href="/company.html">会社概要</a><a href="/pc.html">レンタルPC</a>
      <a href="/cloud.html">クラウド情シス</a><a href="/ai-dev.html">AI・開発支援</a>
      <a href="/shop/">ショップ</a><a href="/privacy.html">プライバシーポリシー</a>
      <a href="/terms.html">利用規約</a><a href="/tokushou.html">特定商取引法に基づく表記</a>
    </div>
    <small>© EIGHT COMMERCE. All Rights Reserved.</small>
  </div>
</footer>"""


def head(title, description, canonical, extra=""):
    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{html.escape(description, quote=True)}">
  <title>{html.escape(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/column/column.css">
  <meta name="theme-color" content="#16305c">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="{canonical}">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="株式会社エイト">
  <meta property="og:title" content="{html.escape(title, quote=True)}">
  <meta property="og:description" content="{html.escape(description, quote=True)}">
  <meta property="og:url" content="{canonical}">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:image" content="{SITE}/assets/eight-commerce-hero-v2.png">
  <meta name="twitter:card" content="summary_large_image">
{extra}</head>
<body>

<header>
  <div class="wrap hd">
    <a class="brand" href="/" aria-label="エイトコマース トップ">
      <span class="brand-mark">8</span>
      <span><b>EIGHT COMMERCE</b><small>法人IT調達・導入・情シス支援</small></span>
    </a>
{NAV}
  </div>
</header>
"""


def article_ld(a, canonical):
    payload = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Article",
                "headline": a["title"],
                "description": a["description"],
                "datePublished": a["date"],
                "dateModified": a["date"],
                "inLanguage": "ja",
                "mainEntityOfPage": {"@type": "WebPage", "@id": canonical},
                "author": {"@type": "Organization", "name": "株式会社エイト", "url": f"{SITE}/"},
                "publisher": {
                    "@type": "Organization",
                    "name": "株式会社エイト",
                    "logo": {"@type": "ImageObject", "url": f"{SITE}/assets/eight-logo.svg"},
                },
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "ホーム", "item": f"{SITE}/"},
                    {"@type": "ListItem", "position": 2, "name": "IT調達コラム", "item": f"{SITE}/column/"},
                    {"@type": "ListItem", "position": 3, "name": a["title"], "item": canonical},
                ],
            },
        ],
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return '  <script type="application/ld+json">\n' + body + "\n  </script>\n"


def cta(a):
    """記事の内容から、そのまま見積もり・相談に進める導線を出す。"""
    query = a.get("relatedQuery", "")
    search = f'/?q={html.escape(query, quote=True)}' if query else "/#search"
    label = f"「{html.escape(query)}」の在庫と価格を見る →" if query else "商品を型番から探す →"
    return f"""<section class="cta">
  <h2>この記事の内容、自社ならどうなるか見積もれます</h2>
  <p>機器の選定から、キッティング・ネットワーク構築・クラウド設定まで一括でお請けします。
  型番が決まっていなくても、用途と台数だけで無料お見積もりが可能です。1〜2営業日以内にご回答します。</p>
  <div class="cta-btns">
    <a class="btn btn-navy" href="/#contact">無料で見積もりを依頼する →</a>
    <a class="btn btn-ghost" href="{search}">{label}</a>
  </div>
</section>"""


def card(a, heading="h3"):
    return f"""      <a class="col-card" href="/column/{a['slug']}.html">
        <div class="col-meta">
          <span class="col-cat">{html.escape(a['category'])}</span>
          <span class="col-date">{html.escape(a['date'].replace('-', '.'))}</span>
          <span class="col-read">読了 {a.get('readMinutes', 5)}分</span>
        </div>
        <{heading}>{html.escape(a['title'])}</{heading}>
        <p>{html.escape(a['description'])}</p>
        <span class="col-more">続きを読む →</span>
      </a>"""


def build_article(a, others):
    slug = a["slug"]
    body_file = CONTENT / f"{slug}.html"
    if not body_file.exists():
        print(f"  skip {slug}: {body_file.relative_to(ROOT)} がありません")
        return False

    canonical = f"{SITE}/column/{slug}.html"
    title = f"{a['title']}｜法人IT調達コラム｜エイトコマース"
    related = [x for x in others if x["slug"] != slug][:2]
    more = ""
    if related:
        more = ('<section class="more-list wrap">\n  <h2>あわせて読みたい</h2>\n  <div class="col-grid">\n'
                + "\n".join(card(x) for x in related) + "\n  </div>\n</section>")

    page = (
        head(title, a["description"], canonical, article_ld(a, canonical))
        + f"""
<main>
  <div class="wrap crumb"><a href="/">ホーム</a> ＞ <a href="/column/">IT調達コラム</a> ＞ {html.escape(a['title'])}</div>

  <article class="article">
    <div class="col-meta">
      <span class="col-cat">{html.escape(a['category'])}</span>
      <span class="col-date">{html.escape(a['date'].replace('-', '.'))}</span>
      <span class="col-read">読了 {a.get('readMinutes', 5)}分</span>
    </div>
    <h1>{html.escape(a['title'])}</h1>
    <p class="lead">{html.escape(a['description'])}</p>
{body_file.read_text(encoding='utf-8').rstrip()}
  </article>

  <div class="wrap">
{cta(a)}
  </div>
{more}
</main>

{FOOTER}
</body>
</html>
"""
    )
    (OUT / f"{slug}.html").write_text(page, encoding="utf-8")
    return True


def build_index(articles):
    canonical = f"{SITE}/column/"
    desc = ("中小企業がAI導入やIT機器の入れ替えでつまずくポイントを、"
            "現場の実例と数字で解決するコラムです。選び方・コスト・情シス運用まで扱います。")
    page = (
        head("法人IT調達コラム｜中小企業のAI・IT機器の悩みを解決｜エイトコマース", desc, canonical)
        + f"""
<main>
  <div class="wrap crumb"><a href="/">ホーム</a> ＞ IT調達コラム</div>

  <div class="wrap list-head">
    <p class="eyebrow">IT PROCUREMENT COLUMN</p>
    <h1>法人IT調達コラム</h1>
    <p>「AIを入れたいが何から手を付ければいいか分からない」「PCが重いが買い替え時期か判断できない」——
    中小企業のIT担当・経営者の方がつまずくポイントを、現場の実例と数字で解きほぐします。</p>
  </div>

  <div class="wrap">
    <div class="col-grid">
{chr(10).join(card(a, 'h2') for a in articles)}
    </div>
  </div>

  <div class="wrap">
{cta({'relatedQuery': ''})}
  </div>
</main>

{FOOTER}
</body>
</html>
"""
    )
    (OUT / "index.html").write_text(page, encoding="utf-8")


def update_sitemap(articles):
    path = ROOT / "sitemap.xml"
    if not path.exists():
        return
    xml = path.read_text(encoding="utf-8")
    xml = re.sub(r"\n\s*<!-- column:start -->.*?<!-- column:end -->", "", xml, flags=re.S)
    entries = [f"{SITE}/column/"] + [f"{SITE}/column/{a['slug']}.html" for a in articles]
    today = date.today().isoformat()
    block = "\n  <!-- column:start -->" + "".join(
        f"\n  <url><loc>{u}</loc><lastmod>{today}</lastmod><changefreq>weekly</changefreq></url>"
        for u in entries
    ) + "\n  <!-- column:end -->"
    xml = xml.replace("</urlset>", block + "\n</urlset>")
    path.write_text(xml, encoding="utf-8")


def main():
    data = json.loads(COLUMNS.read_text(encoding="utf-8"))
    articles = sorted(data["articles"], key=lambda a: a["date"], reverse=True)

    OUT.mkdir(exist_ok=True)
    CONTENT.mkdir(exist_ok=True)

    built = [a for a in articles if build_article(a, articles)]
    build_index(built)
    update_sitemap(built)
    print(f"コラム {len(built)} 本を出力しました（column/index.html ＋ 各記事）")


if __name__ == "__main__":
    main()
