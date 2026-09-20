// ============================================================
// 型番ページ（/products/:slug）のサイトマップ
//
//   商品は /zaiko で増減するので、静的な sitemap.xml には書けません。
//   ここで公開ビュー（inv_public_products）を読んで、そのときの
//   型番ページの一覧を返します。robots.txt から参照します。
//
//   出すのは「公開している商品の型番ページ」だけです。
//   掲載の無い型番のページは noindex にしてあるので、ここにも出しません。
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "https://htglvascsuqkixpmclwr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_yZCcrwdqjuf0u_5WBWlHIw_AxdvteEV";
const SITE = (process.env.SITE_URL || "https://www.8ec.jp").replace(/\/+$/, "");

/** assets/catalog.js の slugOf と同じ作り（型番ページのURLを一致させる） */
function slugOf(maker, title, code) {
  const src = [maker, title].filter(Boolean).join(" ");
  const s = String(src)
    .replace(/[（(].*?[）)]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length >= 3 ? s : String(code || "").toLowerCase();
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

module.exports = async (req, res) => {
  try {
    const url = SUPABASE_URL
      + "/rest/v1/inv_public_products?select=code,name,model,maker,model_key,updated_at&limit=2000";
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
    });
    if (!r.ok) {
      console.error("sitemap-products: fetch failed", r.status);
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    }
    const rows = await r.json();

    // 同じ型番（model_key）は1ページにまとめる。枝番ぶんのURLは作らない
    const seen = new Map();
    (Array.isArray(rows) ? rows : []).forEach((x) => {
      const key = x.model_key || x.code;
      if (!seen.has(key)) seen.set(key, x);
      else if ((x.updated_at || "") > (seen.get(key).updated_at || "")) seen.set(key, x);
    });

    const used = new Set();
    const items = [];
    seen.forEach((x) => {
      let slug = slugOf(x.maker, x.name || x.model, x.code);
      if (used.has(slug)) {
        const extra = String(x.model || x.code || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        slug = extra ? `${slug}-${extra}` : slug;
      }
      if (!slug || used.has(slug)) return;
      used.add(slug);
      items.push({ slug, lastmod: (x.updated_at || "").slice(0, 10) });
    });

    const body = items.map((i) =>
      `  <url>\n    <loc>${esc(SITE)}/products/${esc(i.slug)}</loc>\n`
      + (i.lastmod ? `    <lastmod>${esc(i.lastmod)}</lastmod>\n` : "")
      + `    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
    ).join("\n");

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`
    );
  } catch (e) {
    console.error("sitemap-products error", e);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
};

module.exports.slugOf = slugOf;
