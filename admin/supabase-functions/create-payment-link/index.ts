// ============================================================
// 管理画面「ショップ出品」: Stripe 決済リンク自動生成 Edge Function
//
//   デプロイ:
//     supabase functions deploy create-payment-link
//   （create-checkout と違い --no-verify-jwt は付けません。管理者のみが叩く関数です）
//
//   Secrets（Supabase ダッシュボード → Edge Functions → create-payment-link → Secrets）:
//     STRIPE_SECRET_KEY   … Stripeのシークレットキー（sk_live_… / テストは sk_test_…）
//     SHOP_URL            … 任意。既定 https://www.8ec.jp/shop/（決済完了後の戻り先）
//   ※ SUPABASE_URL / SUPABASE_ANON_KEY は Supabase が自動で注入します。
//
//   処理の流れ（Stripe の Products → Prices → Payment Links を順に呼びます）:
//     1. 呼び出し元が管理者（zimu@8grp.co.jp）かをJWTで検証
//     2. ec_items から対象商品を取得（価格・名称はサーバー側で読む＝クライアントを信頼しない）
//     3. 既存の決済リンクがあれば active=false にして無効化
//     4. Product を作成（商品名・説明・画像）
//     5. Price を作成（JPY・単価。Stripeの価格は変更できないため毎回作り直す）
//     6. Payment Link を作成（配送先住所・電話番号を収集／1回売れたら締切）
//     7. 発行結果を ec_items に書き戻して URL を返す
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAIL = "zimu@8grp.co.jp";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Stripe API は application/x-www-form-urlencoded（ネストは角括弧記法） */
async function stripe(
  key: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_KEY) {
      return json({ error: "STRIPE_SECRET_KEY が未設定です。Supabase の Secrets に設定してください。" }, 500);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SHOP_URL = (Deno.env.get("SHOP_URL") || "https://www.8ec.jp/shop/").replace(/\/+$/, "") + "/";

    // ── 1. 管理者かどうかを検証 ──────────────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "ログインが必要です。" }, 401);

    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    const user = await ures.json();
    if (!ures.ok || !user?.email) return json({ error: "ログイン情報を確認できませんでした。" }, 401);
    if (user.email !== ADMIN_EMAIL) return json({ error: "この操作の権限がありません。" }, 403);

    const { id } = await req.json();
    if (!id) return json({ error: "商品IDがありません。" }, 400);

    // ── 2. 商品を取得（RLSは呼び出し元のJWTで評価される） ────────
    const sel = "id,mgmt_no,model,product_name,spec,shop_title,shop_description,shop_price," +
      "shop_image_url,shop_images,sold_at,stripe_payment_link_id";
    const pres = await fetch(
      `${SUPABASE_URL}/rest/v1/ec_items?id=eq.${encodeURIComponent(id)}&select=${sel}`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } },
    );
    const rows = await pres.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p) return json({ error: "商品が見つかりませんでした。" }, 404);
    if (p.sold_at) return json({ error: "販売済みの商品には決済リンクを作成できません。" }, 400);

    const amount = Math.round(Number(p.shop_price));
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "販売価格を入力してから決済リンクを作成してください。" }, 400);
    }

    const name = String(p.shop_title || p.model || p.product_name || p.mgmt_no || "商品").slice(0, 250);
    const description = String(p.shop_description || p.spec || "").trim().slice(0, 500);

    // 画像は公開URL（https）のみ。Stripeの上限は8枚。
    const rawImages: string[] = Array.isArray(p.shop_images) ? p.shop_images : [];
    const images = [p.shop_image_url, ...rawImages]
      .filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u))
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, 8);

    // ── 3. 既存リンクを無効化（旧価格のリンクが生き残らないように） ──
    if (p.stripe_payment_link_id) {
      // 失敗しても新規発行は続行する（すでに手動で消されている場合など）
      await stripe(STRIPE_KEY, `payment_links/${encodeURIComponent(p.stripe_payment_link_id)}`, {
        active: "false",
      });
    }

    // ── 4. Product を作成 ────────────────────────────────────
    const prodParams: Record<string, string> = { name };
    if (description) prodParams.description = description;
    images.forEach((u, i) => { prodParams[`images[${i}]`] = u; });
    prodParams["metadata[ec_item_id]"] = String(p.id);
    prodParams["metadata[mgmt_no]"] = String(p.mgmt_no || "");
    const prod = await stripe(STRIPE_KEY, "products", prodParams);
    if (!prod.ok) {
      return json({ error: "Stripeの商品作成に失敗しました：" + (prod.data?.error?.message || prod.status) }, 502);
    }

    // ── 5. Price を作成（JPYは最小単位＝円。小数なし） ──────────
    const price = await stripe(STRIPE_KEY, "prices", {
      product: prod.data.id,
      unit_amount: String(amount),
      currency: "jpy",
    });
    if (!price.ok) {
      return json({ error: "Stripeの価格作成に失敗しました：" + (price.data?.error?.message || price.status) }, 502);
    }

    // ── 6. Payment Link を作成 ──────────────────────────────
    const linkParams: Record<string, string> = {
      "line_items[0][price]": price.data.id,
      "line_items[0][quantity]": "1",
      // 中古品は基本的に1点もの。1回購入されたらリンクを自動で締め切り、二重販売を防ぐ。
      "restrictions[completed_sessions][limit]": "1",
      // 物販なので配送先住所と電話番号を収集
      "shipping_address_collection[allowed_countries][0]": "JP",
      "phone_number_collection[enabled]": "true",
      "after_completion[type]": "redirect",
      "after_completion[redirect][url]": `${SHOP_URL}?paid=1`,
      "metadata[ec_item_id]": String(p.id),
      "metadata[mgmt_no]": String(p.mgmt_no || ""),
    };
    const link = await stripe(STRIPE_KEY, "payment_links", linkParams);
    if (!link.ok) {
      return json({ error: "Stripeの決済リンク作成に失敗しました：" + (link.data?.error?.message || link.status) }, 502);
    }

    // ── 7. 結果を商品に書き戻す ──────────────────────────────
    const patch = {
      stripe_product_id: prod.data.id,
      stripe_price_id: price.data.id,
      stripe_payment_link_id: link.data.id,
      stripe_payment_link: link.data.url,
      stripe_synced_price: amount,
      updated_at: new Date().toISOString(),
    };
    const ures2 = await fetch(`${SUPABASE_URL}/rest/v1/ec_items?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
    if (!ures2.ok) {
      const t = await ures2.text();
      // Stripe側は作成できているので、URLは返して手動保存できるようにする
      return json({
        url: link.data.url,
        warning: "決済リンクは作成できましたが、商品への保存に失敗しました：" + t,
        ...patch,
      }, 200);
    }

    return json({ url: link.data.url, ...patch });
  } catch (e) {
    return json({ error: String(e && (e as Error).message ? (e as Error).message : e) }, 500);
  }
});
