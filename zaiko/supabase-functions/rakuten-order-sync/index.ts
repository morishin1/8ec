/* 楽天の注文を /zaiko の在庫につなぐ Edge Function（rakuten-order-sync）。
 *
 *   ■ 画像・商品情報の同期（rakuten-product-sync）とは完全に別物です。
 *     あちらは Rakuten Developers API（applicationId）。
 *     こちらは RMS WEB SERVICE の Order API で、資格情報も別に発行します。
 *     rakuten-product-sync のコードには一切触れていません。
 *
 *   ■ 流れ
 *       searchOrder で期間内の注文番号を取る（注文番号の直接指定も可）
 *         → getOrder で明細（商品コード・数量・発送状況）を取る
 *         → inv_sale_orders_apply() に渡す
 *         → inv_sale_reserve() → inv_reserve_available_item() で個体を確保
 *         → 個体は「在庫」→「販売予約」。8RENTの貸出可能数からも自動で外れる
 *
 *   ■ この Edge Function は在庫を自分では動かしません
 *     在庫を動かす判断も、二重取り込みを防ぐ仕組みも、すべてSQL側にあります。
 *     ここは「楽天から取って形をそろえる」だけです。
 *       冪等 … inventory_sale_orders の 注文番号×明細番号×連番 で一意
 *       確保 … inv_reserve_available_item（for update skip locked）の共通ロック
 *     何度呼んでも在庫は二重に減りません。
 *
 *   ■ 発送済みの扱い（既定は「進めない」）
 *     注文を取得しただけでは売却済みにしません。楽天側が発送完了でも、
 *     既定ではその情報を渡さず「販売予約」で止めます。
 *     売却済みまで進めたいときだけ、明示的に { "ship": true } を送ります。
 *
 *   ■ 資格情報
 *     Supabase の Secrets から読みます。値はログにも応答にも出しません。
 *       RAKUTEN_RMS_SERVICE_SECRET   RMS WEB SERVICE のサービスシークレット
 *       RAKUTEN_RMS_LICENSE_KEY      RMS WEB SERVICE のライセンスキー
 *       RAKUTEN_SHOP_CODE            任意。未設定なら登録済みの出品情報から推測します
 *       SUPABASE_URL / SUPABASE_ANON_KEY … Supabaseが自動で入れます
 *
 *   ■ 呼び出し（/zaiko の「楽天の注文を取り込む」か、Dashboard の Test から）
 *       { "days": 3, "dryRun": true }                 … 3日ぶんを取得・照合するだけ
 *       { "order_numbers": ["123456-20260901-0000000001"], "dryRun": true }
 *       { "order_numbers": ["…"] }                    … その注文だけ在庫へ反映
 *       { "days": 3, "ship": true }                   … 発送済みは売却済みまで進める
 *
 *   デプロイ:
 *     supabase functions deploy rakuten-order-sync
 *   （--no-verify-jwt は付けません。社内の管理画面からログイン済みで呼びます）
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const RMS_BASE = "https://api.rms.rakuten.co.jp/es/2.0/order";

/* RMSの orderProgress。
   100=注文確認待ち 200=楽天処理中 300=発送待ち 400=変更確定待ち
   500=発送中 600=発送完了 700=支払手続き中 800=支払手続き済 900=キャンセル */
const PROGRESS_SHIPPED = new Set([600, 700, 800]);
const PROGRESS_CANCELLED = new Set([900]);

/* 資格情報は Authorization ヘッダの中だけで使い、ログにも応答にも出さない */
function esaHeader(serviceSecret: string, licenseKey: string) {
  return "ESA " + btoa(`${serviceSecret}:${licenseKey}`);
}

/* RMSは日本時間で期間を受け取る。UTCの文字列に +0900 を付けると9時間ずれるので、
   9時間足してから「日本時間の壁時計」を作る */
function jstStamp(d: Date) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + "+0900";
}

/* RMSは HTTP 200 でも MessageModelList にエラーを入れて返すことがある */
function rmsErrors(data: any): string[] {
  const list: any[] = Array.isArray(data?.MessageModelList) ? data.MessageModelList : [];
  return list
    .filter((m) => String(m?.messageType || "").toUpperCase() === "ERROR")
    .map((m) => [m?.messageCode, m?.message].filter(Boolean).join(" "));
}

async function rms(path: string, auth: string, body: unknown) {
  const res = await fetch(`${RMS_BASE}/${path}/`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch (_) { data = null; }
  const errors = rmsErrors(data);
  return { ok: res.ok && errors.length === 0, status: res.status, data, errors };
}

/* 楽天の応答をそのまま返すと長いので、確認に足りるぶんだけに切る。
   資格情報は応答に含まれないが、念のため長さも抑える */
const trim = (data: unknown, max = 800) => {
  try { return JSON.stringify(data).slice(0, max); } catch (_) { return null; }
};

/* RMSのgetOrderの返しを、SQL側（inv_sale_orders_apply）が読む形にそろえる。
   商品の特定はモールの商品コード（itemNumber）と商品URL（manageNumber）だけで行い、
   ここでは推測しない。当たらなければSQL側が「未割当」で記録して人に知らせる。

   opts.ship が false（既定）のときは shipped を必ず false にする。
   「注文を取ってきただけで売却済みになった」を起こさないため。 */
function normalizeOrders(orderModelList: any[], shopCode: string, opts?: { ship?: boolean }) {
  const ship = !!(opts && opts.ship);
  const lines: any[] = [];
  for (const o of orderModelList || []) {
    const orderNumber = String(o?.orderNumber || "").trim();
    if (!orderNumber) continue;
    const progress = Number(o?.orderProgress);
    const rmsShipped = PROGRESS_SHIPPED.has(progress);
    const cancelled = PROGRESS_CANCELLED.has(progress) || !!o?.cancelDueDate;
    const orderedAt = o?.orderDatetime ? String(o.orderDatetime).replace(" ", "T") : null;
    const pkgs: any[] = Array.isArray(o?.PackageModelList) ? o.PackageModelList : [];
    for (const pkg of pkgs) {
      const items: any[] = Array.isArray(pkg?.ItemModelList) ? pkg.ItemModelList : [];
      for (const it of items) {
        // 明細番号。RMSは itemDetailId を返すが、無い店舗設定もあるので
        // そのときは商品管理番号で代用する（同じ注文の中で一意になればよい）
        const lineNumber = String(
          it?.itemDetailId ?? it?.itemNumber ?? it?.manageNumber ?? lines.length + 1,
        ).trim();
        const manage = String(it?.manageNumber || "").trim();
        lines.push({
          order_number: orderNumber,
          line_number: lineNumber,
          // external_item_code に入っているのと同じ形（shopCode:itemNumber）にそろえる
          item_code: it?.itemNumber && shopCode ? `${shopCode}:${String(it.itemNumber).trim()}` : null,
          item_url: manage && shopCode ? `https://item.rakuten.co.jp/${shopCode}/${manage}/` : null,
          qty: Math.max(1, Number(it?.units) || 1),
          price: it?.price != null ? Number(it.price) : null,
          ordered_at: orderedAt,
          // 既定では発送済みを伝えない（売却済みまで進めない）
          shipped: ship && rmsShipped,
          cancelled,
          raw: {
            manageNumber: manage,
            itemNumber: it?.itemNumber ?? null,
            orderProgress: progress,
            // 楽天側の発送状況は記録だけ残す（在庫は動かさない）
            rms_shipped: rmsShipped,
          },
        });
      }
    }
  }
  return lines;
}

/* 店舗コード（8commerce など）。
   秘密情報ではないので Secrets を増やさず、登録済みの出品情報から拾えるようにする。
     external_item_code … "8commerce:10000999" の前半
     url                … "https://item.rakuten.co.jp/8commerce/xxx/" の1つ目のパス
   いちばん多く出てくるものを採る。 */
function shopCodeFromListings(rows: any[]): string {
  const count = new Map<string, number>();
  const add = (s: string | null) => {
    const v = (s || "").trim();
    if (v) count.set(v, (count.get(v) || 0) + 1);
  };
  for (const r of rows || []) {
    const code = String(r?.external_item_code || "");
    if (code.includes(":")) add(code.split(":")[0]);
    const m = String(r?.url || "").match(/^https?:\/\/item\.rakuten\.co\.jp\/([^/]+)\//i);
    if (m) add(m[1]);
  }
  let best = "", n = 0;
  for (const [k, v] of count) if (v > n) { best = k; n = v; }
  return best;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SERVICE_SECRET = Deno.env.get("RAKUTEN_RMS_SERVICE_SECRET") ?? "";
    const LICENSE_KEY = Deno.env.get("RAKUTEN_RMS_LICENSE_KEY") ?? "";
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

    if (!SERVICE_SECRET || !LICENSE_KEY) {
      return json({
        error: "楽天RMSの資格情報が設定されていません。",
        detail: "RAKUTEN_RMS_SERVICE_SECRET / RAKUTEN_RMS_LICENSE_KEY を設定してください。"
          + "（画像同期で使う Rakuten Developers API とは別の、RMS WEB SERVICE の資格情報です）",
      }, 400);
    }
    if (!token) return json({ error: "ログインしてから実行してください。" }, 401);

    const body = await req.json().catch(() => ({}));
    // dryRun / dry_run / dry のどれでも受ける（Dashboard の Test から打ちやすいように）
    const dryRun = !!(body?.dryRun ?? body?.dry_run ?? body?.dry);
    // 発送済みを売却済みまで進めるか。既定は進めない
    const ship = !!(body?.ship ?? body?.mark_shipped);
    const days = Math.max(1, Math.min(Number(body?.days) || 3, 31));
    const maxOrders = Math.max(1, Math.min(Number(body?.max) || 100, 300));
    const version = Math.max(1, Math.min(Number(body?.version) || 7, 9));
    const picked: string[] = Array.isArray(body?.order_numbers)
      ? body.order_numbers.map((x: unknown) => String(x || "").trim()).filter(Boolean).slice(0, maxOrders)
      : [];
    const auth = esaHeader(SERVICE_SECRET, LICENSE_KEY);

    const sbHeaders = {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // ── 0. 店舗コード ──
    let shopCode = (Deno.env.get("RAKUTEN_SHOP_CODE") ?? "").trim();
    let shopCodeFrom = shopCode ? "環境変数" : "";
    if (!shopCode) {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/inventory_channel_listings?channel=eq.rakuten&select=external_item_code,url&limit=300`,
        { headers: sbHeaders },
      );
      const rows = r.ok ? await r.json().catch(() => []) : [];
      shopCode = shopCodeFromListings(Array.isArray(rows) ? rows : []);
      shopCodeFrom = shopCode ? "登録済みの出品情報から推測" : "";
    }
    if (!shopCode) {
      return json({
        error: "楽天の店舗コードが分かりませんでした。",
        detail: "商品の「楽天」出品に商品コード（8commerce:… の形）か掲載URLを1件以上登録するか、"
          + "Secrets に RAKUTEN_SHOP_CODE を設定してください。",
      }, 400);
    }

    // ── 1. 対象の注文番号を決める ──
    let numbers: string[] = picked;
    if (numbers.length === 0) {
      const end = new Date();
      const begin = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      let page = 1;
      while (numbers.length < maxOrders) {
        const search = await rms("searchOrder", auth, {
          dateType: 1,                       // 1=注文日
          startDatetime: jstStamp(begin),
          endDatetime: jstStamp(end),
          PaginationRequestModel: { requestRecordsAmount: 100, requestPage: page },
        });
        if (!search.ok) {
          return json({
            error: "楽天RMSの注文検索に失敗しました（資格情報またはAPI利用申請をご確認ください）。",
            status: search.status,
            rms_errors: search.errors,
            rms_response: trim(search.data),
          }, 502);
        }
        const got: string[] = Array.isArray(search.data?.orderNumberList) ? search.data.orderNumberList : [];
        numbers.push(...got);
        const total = Number(search.data?.PaginationResponseModel?.totalPages) || 1;
        if (got.length === 0 || page >= total) break;
        page += 1;
      }
      numbers = numbers.slice(0, maxOrders);
    }
    // 資格情報は出さない。件数と条件だけ残す
    console.log(JSON.stringify({ step: "search", days, picked: picked.length, orders: numbers.length, dryRun, ship }));

    if (numbers.length === 0) {
      return json({
        days, dry_run: dryRun, ship, shop_code: shopCode,
        order_count: 0, line_count: 0,
        new: 0, already: 0, reserved: 0, shipped: 0, cancelled: 0, unmatched: [], no_stock: [],
      });
    }

    // ── 2. 注文の明細を取る（100件ずつ） ──
    const orders: any[] = [];
    for (let i = 0; i < numbers.length; i += 100) {
      const got = await rms("getOrder", auth, {
        orderNumberList: numbers.slice(i, i + 100),
        version,
      });
      if (!got.ok) {
        return json({
          error: "楽天RMSの注文取得に失敗しました。",
          status: got.status,
          rms_errors: got.errors,
          rms_response: trim(got.data),
        }, 502);
      }
      if (Array.isArray(got.data?.OrderModelList)) orders.push(...got.data.OrderModelList);
    }
    const lines = normalizeOrders(orders, shopCode, { ship });
    console.log(JSON.stringify({ step: "getOrder", orders: orders.length, lines: lines.length }));

    // ── 3. 照合（どの商品に当たるか）──
    //     dryRun のときは「在庫を動かさずに照合結果だけ」を返したいので、
    //     SQL側と同じ関数（inv_listing_product）で引く。推測はしない。
    if (dryRun) {
      const cache = new Map<string, string | null>();
      // 照合そのものが試せなかった（権限が足りない等）ときに、
      // 「商品が当たらなかった」と取り違えないよう別に覚えておく
      let matchError: string | null = null;
      for (const l of lines) {
        const key = `${l.item_code || ""}|${l.item_url || ""}`;
        if (!cache.has(key)) {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_listing_product`, {
            method: "POST",
            headers: sbHeaders,
            body: JSON.stringify({ p_channel: "rakuten", p_item_code: l.item_code, p_item_url: l.item_url }),
          });
          if (!r.ok && !matchError) {
            matchError = `商品の照合ができませんでした（HTTP ${r.status}）。`
              + "管理者・一般メンバーとしてログインした状態で実行してください"
              + "（/zaiko の「楽天の注文を取り込む」から実行するのが確実です）。";
          }
          const v = r.ok ? await r.json().catch(() => null) : null;
          cache.set(key, typeof v === "string" && v ? v : null);
        }
        l.product_code = cache.get(key) ?? null;
        l.matched = matchError ? null : !!l.product_code;
      }
      if (matchError) {
        return json({
          dry_run: true, ship, shop_code: shopCode, shop_code_from: shopCodeFrom,
          days: picked.length ? null : days,
          order_count: orders.length, line_count: lines.length,
          matched: null, unmatched: null,
          warning: matchError,
          note: "在庫は動かしていません。楽天からの取得はできています（下の明細）。",
          lines,
        });
      }
      return json({
        dry_run: true, ship, shop_code: shopCode, shop_code_from: shopCodeFrom,
        days: picked.length ? null : days,
        order_count: orders.length,
        line_count: lines.length,
        matched: lines.filter((l) => l.matched).length,
        unmatched: lines.filter((l) => !l.matched).length,
        note: "在庫は動かしていません。商品が当たっているか（product_code）を確認してください。",
        lines,
      });
    }

    // ── 4. 在庫へ反映（判断も冪等性もSQL側） ──
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_sale_orders_apply`, {
      method: "POST",
      headers: sbHeaders,
      body: JSON.stringify({ p_orders: lines, p_channel: "rakuten" }),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      return json({ error: "在庫へ反映できませんでした：" + (out?.message || `HTTP ${res.status}`) }, 502);
    }
    return json({
      days: picked.length ? null : days,
      ship, shop_code: shopCode,
      order_count: orders.length,
      line_count: lines.length,
      ...out,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

export { normalizeOrders, shopCodeFromListings, jstStamp, rmsErrors };
