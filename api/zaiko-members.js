// ============================================================
// /zaiko のメンバー管理（/api/zaiko-members）
//
//   ここでやること
//     create        … Supabase Auth にログインを作り、inventory_members に権限を登録する
//     password      … そのログインのパスワードを変える
//     auth-delete   … ログインアカウントそのものを消す（権限の解除とは別の操作）
//
//   なぜサーバー側でやるか
//     Supabase Auth の管理API（/auth/v1/admin/*）はサーバー鍵（service_role）が要る。
//     **サーバー鍵をブラウザへ出すことは絶対にしない。** 出した時点で、誰でも
//     どのアカウントのパスワードでも変えられるようになる。
//     そのため画面は /api/zaiko-members を叩き、鍵はこのサーバーの中だけに置く。
//
//   誰が叩いたかの確かめかた
//     ブラウザは自分のログイン（access token）を Authorization: Bearer で送る。
//     その token が本物かは **Supabase に聞く**（/auth/v1/user）。
//     そのうえで inventory_members の role を**サーバー鍵で**読み、admin でなければ断る。
//     画面から送られてきた role は一切見ない（member / viewer が直接叩いても通らない）。
//
//   パスワードの置き場所
//     **inventory_members にパスワードは保存しない。** Supabase Auth だけが持つ。
//       Supabase Auth     … ログインできるかどうか
//       inventory_members … 在庫管理の中での権限
//     ログにもパスワードは出さない。いまのパスワードを読み出す経路も作らない
//     （新しいパスワードを入れ直すことしかできない）。
//
//   ログインIDの決まり
//     ログイン画面の ID はメールアドレスの @ より前。mw → mw@8grp.co.jp。
//     ここで作るのもメールアドレスなので、ログインの仕組みは何も変えていない。
// ============================================================

const L = require("./_lib.js");
const { clean, clientKey, tooFast, rest, authAdmin, caller } = L;

const MAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["admin", "member", "viewer"];
const ROLE_LABEL = { admin: "管理者", member: "倉庫メンバー", viewer: "閲覧のみ" };
const PW_MIN = 8;
const PW_MAX = 72;              // bcrypt が見るのは72バイトまで。長すぎる入力は受け取らない

/** パスワードの形だけ見る。**値はどこにも残さない** */
function badPassword(pw) {
  const s = typeof pw === "string" ? pw : "";
  if (!s) return "パスワードを入力してください";
  if (s.length < PW_MIN) return `パスワードは${PW_MIN}文字以上にしてください`;
  if (Buffer.byteLength(s, "utf8") > PW_MAX) return "パスワードが長すぎます";
  if (/\s/.test(s)) return "パスワードに空白は使えません";
  return null;
}

/** そのメールアドレスのログインを1つ探す。
 *  filter は部分一致（LIKE '%x%'）なので、**こちらで完全一致を確かめる**。 */
async function findAuthUser(email) {
  const r = await authAdmin("users?per_page=200&filter=" + encodeURIComponent(email));
  if (!r.ok) return { error: r };
  const list = (r.out && (r.out.users || r.out)) || [];
  const hit = (Array.isArray(list) ? list : []).find(
    (u) => u && typeof u.email === "string" && u.email.trim().toLowerCase() === email);
  return { user: hit || null };
}

/** 管理APIが鍵を受け付けなかったときだけ、直し方が分かる返事にする */
function authFailed(res, r, fallback) {
  if (r && (r.status === 401 || r.status === 403)) {
    console.error("api: auth admin rejected the server key (status " + r.status + ")");
    return res.status(503).json({
      error: "ログインの管理機能を使えませんでした。Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を確かめてください",
    });
  }
  const msg = (r && r.out && (r.out.msg || r.out.message || r.out.error_description)) || fallback;
  return res.status(400).json({ error: msg });
}

/** 操作を履歴に残す。**パスワードは書かない。** */
async function log(actor, email, name, action, before, after) {
  try {
    await rest("inventory_transactions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        actor, ref_kind: "member", ref_id: email, label: name || email,
        action, before_value: before, after_value: after,
      },
    });
  } catch (e) {
    console.error("api: member log error", e && e.message);   // 履歴が書けなくても操作自体は通す
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST のみ受け付けます" }); }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  // 鍵が無ければ何もしない（公開鍵で代わりに動かすことはしない）
  if (!L.hasKey()) return L.keyMissing(res);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "リクエストの形式が不正です" });

  // 連打よけ。パスワードの総当たりをここへ持ち込ませない
  if (tooFast("zaiko-members", clientKey(req), 20, 60000)) return L.tooMany(res, 60);

  // ── 誰が叩いたか。**管理者以外はここで止まる** ──
  let who = null;
  try {
    who = await caller(req);
  } catch (e) {
    console.error("api: caller lookup error", e && e.message);
    return res.status(503).json({ error: "ただいま受け付けできません" });
  }
  if (!who) return res.status(401).json({ error: "ログインし直してください" });
  if (who.role !== "admin") return res.status(403).json({ error: "メンバーを直せるのは管理者だけです" });

  const action = String(body.action || "");
  const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
  if (!MAIL_RE.test(email)) return res.status(400).json({ error: "メールアドレスを正しく入力してください" });

  // ── 1) 追加：ログインを作って、権限を登録する ──
  if (action === "create") {
    const name = clean(body.name, 100);
    const role = ROLES.indexOf(String(body.role || "")) >= 0 ? String(body.role) : null;
    const bad = badPassword(body.password);
    if (!name) return res.status(400).json({ error: "氏名を入力してください" });
    if (!role) return res.status(400).json({ error: "権限を選んでください" });
    if (bad) return res.status(400).json({ error: bad });

    // すでに権限が登録されていれば、追加ではなく編集の話
    const cur = await rest("inventory_members?select=email&email=eq." + encodeURIComponent(email) + "&limit=1");
    if (cur.ok && Array.isArray(cur.out) && cur.out.length) {
      return res.status(409).json({ error: "このメールアドレスはすでに登録されています" });
    }

    // (a) ログインを作る
    const made = await authAdmin("users", {
      method: "POST",
      body: { email, password: body.password, email_confirm: true },
    });
    if (!made.ok) {
      const code = (made.out && (made.out.error_code || made.out.code)) || "";
      if (made.status === 422 && String(code).indexOf("email_exists") >= 0) {
        // Auth にはもう居る。権限だけ足す（ログインは作り直さない＝パスワードは変わらない）
        const only = await rest("inventory_members", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: { email, display_name: name, role },
        });
        if (!only.ok) return res.status(400).json({ error: "権限を登録できませんでした" });
        await log(who.name, email, name, "メンバー追加", "なし",
          ROLE_LABEL[role] + "（ログインは既存のものを使います）");
        return res.status(200).json({
          ok: true, member: (only.out && only.out[0]) || null,
          note: "このメールアドレスのログインはすでにありました。パスワードは変えていません",
        });
      }
      return authFailed(res, made, "ログインを作れませんでした");
    }

    // (b) 権限を登録する。ここで失敗したら、いま作ったログインは消しておく
    //     （誰のものとも分からないログインを残さない）
    const row = await rest("inventory_members", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { email, display_name: name, role },
    });
    if (!row.ok) {
      const id = made.out && made.out.id;
      if (id) await authAdmin("users/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
      return res.status(400).json({ error: "権限を登録できなかったので、ログインの作成も取り消しました" });
    }

    await log(who.name, email, name, "メンバー追加", "なし", ROLE_LABEL[role] + "（ログインを作成）");
    return res.status(200).json({ ok: true, member: (row.out && row.out[0]) || null });
  }

  // ── 2) パスワードを変える ──
  //     いまのパスワードは読み出せない（Supabase も持っているのはハッシュだけ）。
  //     できるのは「新しいものを入れ直す」ことだけ。
  if (action === "password") {
    const bad = badPassword(body.password);
    if (bad) return res.status(400).json({ error: bad });

    const found = await findAuthUser(email);
    if (found.error) return authFailed(res, found.error, "ログインを調べられませんでした");
    if (!found.user) return res.status(404).json({ error: "このメールアドレスのログインが見つかりません" });

    const upd = await authAdmin("users/" + encodeURIComponent(found.user.id), {
      method: "PUT",
      body: { password: body.password },
    });
    if (!upd.ok) return authFailed(res, upd, "パスワードを変えられませんでした");

    const cur = await rest("inventory_members?select=display_name&email=eq." + encodeURIComponent(email) + "&limit=1");
    const nm = (cur.ok && Array.isArray(cur.out) && cur.out[0] && cur.out[0].display_name) || email;
    // **値は書かない。** 変えたという事実だけ残す
    await log(who.name, email, nm, "パスワード変更", "（記録しません）", "新しいパスワードを設定");
    return res.status(200).json({ ok: true });
  }

  // ── 3) ログインアカウントそのものを消す ──
  //     在庫管理の権限を外す（inventory_members の削除）とは**別の操作**。
  //     画面側でも二重に確かめさせる。自分自身は消せない。
  if (action === "auth-delete") {
    if (email === who.email) return res.status(400).json({ error: "自分自身のログインは消せません" });
    if (body.confirm !== email) return res.status(400).json({ error: "確認のためメールアドレスを入力してください" });

    const found = await findAuthUser(email);
    if (found.error) return authFailed(res, found.error, "ログインを調べられませんでした");
    if (!found.user) return res.status(404).json({ error: "このメールアドレスのログインが見つかりません" });

    const del = await authAdmin("users/" + encodeURIComponent(found.user.id), { method: "DELETE" });
    if (!del.ok) return authFailed(res, del, "ログインを消せませんでした");

    await log(who.name, email, email, "ログイン削除", "ログインあり", "ログインなし（在庫管理の権限は別操作）");
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "操作が正しくありません" });
};

module.exports.badPassword = badPassword;
module.exports.findAuthUser = findAuthUser;
