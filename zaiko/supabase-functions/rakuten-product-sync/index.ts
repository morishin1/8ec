// ============================================================
// /zaiko 「楽天商品を同期」: Rakuten Developers API 呼び出し Edge Function
//
//   デプロイ:
//     supabase functions deploy rakuten-product-sync
//   （/zaiko のスタッフだけが叩く関数なので --no-verify-jwt は付けません）
//
//   Secrets（Supabase ダッシュボード → Edge Functions → rakuten-product-sync → Secrets）:
//     RAKUTEN_APPLICATION_ID … Rakuten Developers の Application ID
//     RAKUTEN_ACCESS_KEY     … Rakuten Developers の Access Key
//     RAKUTEN_SHOP_CODE      … 自社楽天店舗の shopCode（例: https://www.rakuten.co.jp/{shopCode}/
//                               や既存の商品URL https://item.rakuten.co.jp/{shopCode}/{itemCode}/
//                               のパスにある文字列。自社の商品ページから確認できます）
//   ※ SUPABASE_URL / SUPABASE_ANON_KEY は Supabase が自動で注入します。
//   ※ Access Key はこの関数（サーバー側）でしか読みません。ブラウザ側のJSやHTML、
//     このリポジトリのどこにも直接書きません。
//
//   処理の流れ:
//     1. 呼び出し元が /zaiko の編集権限を持つか（inventory_members）をJWTで確認
//     2. Rakuten Developers の商品検索APIを、自社 shopCode を指定して呼ぶ
//        （他店舗の商品は取得しない）
//     3. 商品名・商品説明からスペック（CPU/メモリ/ストレージ/OS等）を抽出
//     4. 正規化したデータを inv_rakuten_sync_apply（SQL関数）へ渡し、
//        既存の inventory_products と照合・不足情報の補完を行わせる
//        （実在庫 inventory_items はここでは一切作らない）
//     5. 新規○件・更新○件・変更なし○件・要確認○件・エラー○件を返す
//
//   【重要・現状の制約】
//     ここで呼んでいるのは「Rakuten Developers 商品検索API」で、商品情報の
//     取得だけができます。受注・キャンセル・発送状態の取得や、楽天側の
//     在庫数量の更新には、別途 RMS WEB SERVICE の利用申請が必要です
//     （このEdge Functionはそちらにはまだ対応していません）。
//
//   【要確認・実機テストで最初に見るべき点】
//     楽天のAPI仕様は変更されることがあります。認証やエンドポイントで
//     エラーが出た場合は、公式ドキュメント
//     https://webservice.rakuten.co.jp/documentation/ichiba-item-search
//     の最新仕様と、下の RAKUTEN_ENDPOINT / buildAuthVariants() を照らし合わせて
//     ください。accessKeyの渡し方（クエリパラメータかヘッダか）は複数パターンを
//     自動で試すようにしていますが、それでも失敗する場合はここを更新してください。
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 楽天市場商品検索API。日付付きバージョンは仕様変更で変わることがある。
// 2026-07-01版が最新として案内されているものを既定にしている（要確認）。
const RAKUTEN_ENDPOINT = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601";

/**
 * 楽天の商品URL（https://item.rakuten.co.jp/{shopCode}/{itemNumber}/…）から
 * itemCode（"shopCode:itemNumber" 形式）を取り出す。パスの形が違えば null。
 */
function extractItemCodeFromUrl(url: string): string | null {
  const m = /item\.rakuten\.co\.jp\/([^\/]+)\/([^\/?]+)/i.exec(url || "");
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * accessKeyの渡し方は複数の可能性がある（クエリパラメータ／ヘッダ）ため、
 * 最初にクエリパラメータ方式を試し、認証エラー（400/401/403）ならヘッダ方式で
 * 再試行する。どちらで成功したかをログ的に返す。
 *
 * itemCode を渡すと、その1件だけに絞った接続テストになる（shopCodeも
 * 一緒に渡すので、自社店舗の商品であることの確認も兼ねる）。
 */
async function fetchRakutenPage(
  applicationId: string,
  accessKey: string,
  shopCode: string,
  page: number,
  hits: number,
  itemCode?: string | null,
): Promise<{ ok: boolean; status: number; authMode: string; data: any }> {
  const baseParams = new URLSearchParams({
    format: "json",
    applicationId,
    shopCode,
    page: String(page),
    hits: String(Math.min(hits, 30)),
    availability: "0", // 在庫の有無に関わらず自社の全商品を対象にする
  });
  if (itemCode) baseParams.set("itemCode", itemCode);

  // 方式1: accessKey もクエリパラメータで渡す（楽天の歴史的な標準形）
  {
    const params = new URLSearchParams(baseParams);
    params.set("accessKey", accessKey);
    const res = await fetch(`${RAKUTEN_ENDPOINT}?${params.toString()}`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && !data.error) {
      return { ok: true, status: res.status, authMode: "query:accessKey", data };
    }
    if (res.status !== 400 && res.status !== 401 && res.status !== 403) {
      return { ok: false, status: res.status, authMode: "query:accessKey", data };
    }
  }

  // 方式2: accessKey を Authorization ヘッダで渡す（新しい鍵の位置づけを踏まえた代替案）
  {
    const res = await fetch(`${RAKUTEN_ENDPOINT}?${baseParams.toString()}`, {
      headers: { Authorization: `ESA ${accessKey}` },
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && !data.error) {
      return { ok: true, status: res.status, authMode: "header:Authorization=ESA", data };
    }
    return { ok: false, status: res.status, authMode: "header:Authorization=ESA", data };
  }
}

// ---- スペック抽出（商品名・商品説明から）。Node.jsで動作確認したロジックをそのまま使う ----
function hasFeature(text: string, positive: RegExp, negativeNear?: RegExp): boolean | null {
  if (!text) return null;
  const m = positive.exec(text);
  if (!m) return null;
  if (negativeNear) {
    const after = text.slice(m.index, m.index + m[0].length + 6);
    if (negativeNear.test(after)) return false;
  }
  return true;
}
const NEG = /(なし|無し|非搭載|未搭載|無い)/;

function extractSpec(name: string, caption: string): Record<string, unknown> {
  const text = [name || "", caption || ""].join("\n");
  const out: Record<string, unknown> = {};

  let m: RegExpExecArray | null;
  m = /Core\s*i([3579])[\s-]*(\d{4,5}[A-Z]{0,2})?/i.exec(text);
  if (m) {
    out.cpu = "Core i" + m[1] + (m[2] ? "-" + m[2].toUpperCase() : "");
    if (m[2]) {
      const digits = m[2].replace(/[A-Z]/gi, "");
      const gen = digits.length >= 4 ? parseInt(digits.slice(0, digits.length === 5 ? 2 : 1), 10) : null;
      if (gen && gen >= 1 && gen <= 16) out.cpu_gen = `第${gen}世代`;
    }
  } else if ((m = /Core\s*Ultra\s*([579])(?:\D*(\d{3}[A-Z]?))?/i.exec(text))) {
    out.cpu = "Core Ultra " + m[1] + (m[2] ? " " + m[2].toUpperCase() : "");
  } else if ((m = /Ryzen\s*([3579])\s*(\d{4}[A-Z]{0,2})?/i.exec(text))) {
    out.cpu = "Ryzen " + m[1] + (m[2] ? " " + m[2].toUpperCase() : "");
  } else if (/Celeron/i.test(text)) {
    out.cpu = "Celeron";
  } else if (/Pentium/i.test(text)) {
    out.cpu = "Pentium";
  } else if ((m = /Apple\s*(M[1-4]\s*(Pro|Max|Ultra)?)/i.exec(text))) {
    out.cpu = "Apple " + m[1].replace(/\s+/g, " ").trim();
  }
  if (!out.cpu_gen) {
    m = /第\s*(\d{1,2})\s*世代/.exec(text);
    if (m) out.cpu_gen = `第${m[1]}世代`;
  }

  m = /(\d{1,3})\s*GB\s*(?:の)?メモリ/i.exec(text) || /(?:メモリ|RAM)\s*[:：]?\s*(\d{1,3})\s*GB/i.exec(text);
  if (m) out.memory = m[1] + "GB";

  m = /SSD\s*[:：]?\s*(\d{1,4})\s*(GB|TB)/i.exec(text) || /(\d{1,4})\s*(GB|TB)\s*(?:の)?SSD/i.exec(text);
  if (m) {
    out.storage_type = "SSD";
    out.storage_capacity = m[1] + m[2].toUpperCase();
  } else if (
    (m = /HDD\s*[:：]?\s*(\d{1,4})\s*(GB|TB)/i.exec(text)) ||
    (m = /(\d{1,4})\s*(GB|TB)\s*(?:の)?HDD/i.exec(text))
  ) {
    out.storage_type = "HDD";
    out.storage_capacity = m[1] + m[2].toUpperCase();
  }

  m = /(\d{1,2}\.\d)\s*(?:型|インチ|inch)/i.exec(text);
  if (m) out.screen_size = m[1] + "型";

  m = /Windows\s*(11|10|8\.1|7)\s*(Pro|Home|Enterprise)?/i.exec(text);
  if (m) out.os = "Windows " + m[1] + (m[2] ? " " + m[2] : "");
  else if (/Mac\s*OS|macOS/i.exec(text)) out.os = "macOS";
  else if (/Chrome\s*OS/i.exec(text)) out.os = "Chrome OS";

  const office = hasFeature(text, /Office|オフィス|Word.{0,3}Excel|Microsoft\s*365/i, NEG);
  if (office != null) out.office_supported = office;
  const cam = hasFeature(text, /Web\s*カメラ|カメラ内蔵|カメラ付き|内蔵カメラ/i, NEG);
  if (cam != null) out.webcam = cam;
  const wifi = hasFeature(text, /Wi-?Fi|無線LAN/i, NEG);
  if (wifi != null) out.wifi = wifi;
  const bt = hasFeature(text, /Bluetooth|ブルートゥース/i, NEG);
  if (bt != null) out.bluetooth = bt;
  const numpad = hasFeature(text, /テンキー/i, NEG);
  if (numpad != null) out.numpad = numpad;

  m = /付属品\s*[:：]\s*([^\n。]{2,60})/.exec(text);
  if (m) out.accessories = m[1].trim();

  return out;
}

/** 「型番：XXXX」のように明示されている場合だけ型番として扱う。
 *  自由記述からの当てずっぽうの型番抽出は誤マッチの元になるためやらない
 *  （型番が取れない商品は、既存のinventory_channels紐付け／新規登録にまわる）。 */
function extractExplicitModel(name: string, caption: string): string | null {
  const text = [name || "", caption || ""].join("\n");
  const m = /(?:型番|品番|モデル)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})/.exec(text);
  return m ? m[1].trim() : null;
}

function normalizeItem(raw: any): Record<string, unknown> {
  const item = raw?.Item || raw;
  const name: string = item.itemName || "";
  const caption: string = item.itemCaption || "";
  const images: string[] = Array.isArray(item.mediumImageUrls)
    ? item.mediumImageUrls.map((x: any) => (typeof x === "string" ? x : x?.imageUrl)).filter(Boolean)
    : [];
  return {
    item_code: item.itemCode || null,
    item_url: item.itemUrl || null,
    shop_code: item.shopCode || null,
    name,
    caption,
    price: item.itemPrice ?? null,
    image_url: images[0] || null,
    images,
    maker: null, // 楽天の商品検索APIには「メーカー」専用フィールドが無いため、基本は照合結果か人の入力に任せる
    model: extractExplicitModel(name, caption),
    genre_id: item.genreId || null,
    extracted: extractSpec(name, caption),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const APP_ID = Deno.env.get("RAKUTEN_APPLICATION_ID");
    const ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY");
    const SHOP_CODE = Deno.env.get("RAKUTEN_SHOP_CODE");
    if (!APP_ID || !ACCESS_KEY || !SHOP_CODE) {
      return json({
        error: "RAKUTEN_APPLICATION_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_SHOP_CODE が未設定です。" +
          "Supabase の Edge Functions → rakuten-product-sync → Secrets に設定してください。",
      }, 500);
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── 1. /zaiko の編集権限があるかを確認 ──────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "ログインが必要です。" }, 401);

    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    const user = await ures.json();
    if (!ures.ok || !user?.email) return json({ error: "ログイン情報を確認できませんでした。" }, 401);

    const mres = await fetch(
      `${SUPABASE_URL}/rest/v1/inventory_members?email=eq.${encodeURIComponent(user.email)}&select=role`,
      { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } },
    );
    const members = await mres.json();
    const role = Array.isArray(members) && members[0] ? members[0].role : null;
    if (!role || !["admin", "member"].includes(role)) {
      return json({ error: "この操作の権限がありません。" }, 403);
    }

    // ── 2. リクエスト内容 ──────────────────────────────────────
    // item_url または item_code を渡すと、その1件だけの接続テストになる
    // （既存の inventory_channel_listings に登録済みのURLを使う想定）。
    // どちらも無ければ、これまで通り自社shopCodeの一覧をhits件数ぶん取得する。
    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(Number(body?.limit) || 30, 30));
    const page = Math.max(1, Number(body?.page) || 1);
    const targetItemCode: string | null = body?.item_code
      ? String(body.item_code)
      : body?.item_url
      ? extractItemCodeFromUrl(String(body.item_url))
      : null;
    if ((body?.item_url || body?.item_code) && !targetItemCode) {
      return json({ error: "item_url からitemCodeを読み取れませんでした（https://item.rakuten.co.jp/店舗ID/商品番号/ の形式をご確認ください）。" }, 400);
    }

    // ── 3. 楽天APIを呼ぶ（自社shopCodeだけを対象） ──────────────
    const rk = await fetchRakutenPage(APP_ID, ACCESS_KEY, SHOP_CODE, page, limit, targetItemCode);
    if (!rk.ok) {
      return json({
        error: "楽天APIの呼び出しに失敗しました（認証情報または仕様をご確認ください）。",
        status: rk.status,
        auth_mode_tried: rk.authMode,
        rakuten_response: rk.data,
      }, 502);
    }

    const items: any[] = Array.isArray(rk.data?.Items) ? rk.data.Items.slice(0, limit) : [];
    if (targetItemCode && items.length === 0) {
      return json({
        error: `指定した商品（${targetItemCode}）が見つかりませんでした。自社店舗（${SHOP_CODE}）の商品か、URLをご確認ください。`,
        auth_mode: rk.authMode,
        rakuten_response: rk.data,
      }, 404);
    }
    const normalized = items.map(normalizeItem);

    // ── 4. 正規化した商品データを、既存の商品マスターと照合・補完するSQL関数へ渡す ──
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inv_rakuten_sync_apply`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_items: normalized }),
    });
    const rpcData = await rpcRes.json();
    if (!rpcRes.ok) {
      return json({ error: "商品マスターへの反映に失敗しました：" + (rpcData?.message || JSON.stringify(rpcData)) }, 502);
    }

    return json({
      auth_mode: rk.authMode,
      fetched_count: items.length,
      total_available: rk.data?.count ?? null,
      // 実機確認用：各商品でどの項目が取れた／取れなかったかを見えるようにする
      fetched_fields_sample: normalized.slice(0, 5).map((n: any) => ({
        item_code: n.item_code,
        name: n.name,
        has_caption: !!n.caption,
        has_image: !!n.image_url,
        image_count: (n.images || []).length,
        model_explicit: n.model,
        extracted: n.extracted,
      })),
      ...rpcData,
    });
  } catch (e) {
    return json({ error: String(e && (e as Error).message ? (e as Error).message : e) }, 500);
  }
});
