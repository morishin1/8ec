// ============================================================
// /zaiko のメンバー管理（/api/zaiko-members）
//
//   ここでやること
//     create    … Supabase Auth にログインを作り、inventory_members に権限を登録する
//                  （Auth に同じIDのログインだけが残っていたときは、**今回入力した
//                    パスワードで上書き**してから権限を足す。管理者が決めたIDと
//                    パスワードでそのまま入れる、を守るため）
//     password  … そのログインのパスワードを変える
//     delete    … ログインと在庫管理の権限を**まとめて**消す（アカウントごと削除）
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
//     画面が送ってくるのは**ログインIDだけ**（例 tanaka）。
//     メールアドレスは**サーバーがここで組み立てる**（tanaka → tanaka@8grp.co.jp）。
//     画面からメールアドレスを受け取らないので、別のドメインのアカウントは作れない。
//     ログイン画面の ID も昔から「メールアドレスの @ より前」なので、
//     ログインの仕組みそのものは何も変えていない。
// ============================================================

const L = require("./_lib.js");
const { clean, clientKey, tooFast, rest, authAdmin, caller } = L;

// ログインIDから作るメールアドレスのドメイン。**画面からは受け取らない**
const MAIL_DOMAIN = "@8grp.co.jp";
// ログインID。小文字・数字と . _ - だけ。@ も空白も入れられない
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
// 管理画面で選べるのは2つだけ。viewer は**既存データの互換**のために残してあるが、
// ここでは受け付けない（画面にも出さない）
const ROLES = ["admin", "member"];
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

/** ログインIDからメールアドレスを作る。**組み立てるのはここだけ。** */
function mailOf(loginId) {
  const id = String(loginId == null ? "" : loginId).trim().toLowerCase();
  return ID_RE.test(id) ? id + MAIL_DOMAIN : null;
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
  // **画面が送ってくるのはログインIDだけ。** メールアドレスはここで組み立てる
  const loginId = String(body.loginId == null ? "" : body.loginId).trim().toLowerCase();
  const email = mailOf(loginId);
  if (!email) {
    return res.status(400).json({
      error: "ログインIDは半角の小文字・数字と . _ - だけで、2文字以上32文字以内にしてください",
    });
  }

  // ── 1) 追加：ログインを作って、権限を登録する ──
  if (action === "create") {
    const name = clean(body.name, 100);
    const role = ROLES.indexOf(String(body.role || "")) >= 0 ? String(body.role) : null;
    const bad = badPassword(body.password);
    if (!name) return res.status(400).json({ error: "氏名を入力してください" });
    if (!role) return res.status(400).json({ error: "権限は 管理者 か メンバー を選んでください" });
    if (bad) return res.status(400).json({ error: bad });

    // すでに権限が登録されていれば、追加ではなく編集の話
    const cur = await rest("inventory_members?select=email&email=eq." + encodeURIComponent(email) + "&limit=1");
    if (cur.ok && Array.isArray(cur.out) && cur.out.length) {
      return res.status(409).json({ error: "このログインIDはすでに使われています" });
    }

    // 自分自身は「追加」の対象にならない（権限の行があるので上の 409 で止まるが、
    // 万一そこを抜けても**自分のパスワードを書き換えない**ようここでも断る）
    if (email === who.email) {
      return res.status(409).json({ error: "このログインIDはすでに使われています" });
    }

    // (a) ログインを作る
    const made = await authAdmin("users", {
      method: "POST",
      body: { email, password: body.password, email_confirm: true },
    });
    if (!made.ok) {
      const code = (made.out && (made.out.error_code || made.out.code)) || "";
      if (made.status === 422 && String(code).indexOf("email_exists") >= 0) {
        /* Auth にログインだけが残っていて、在庫管理の権限（inventory_members）が無い状態。
           前に作って権限を外した、途中で失敗した、などで起きる。
           **管理者が決めたIDとパスワードでそのまま入れる**のが今回の約束なので、
           ログインは作り直さず、**パスワードを今回の入力で上書き**してから権限を足す。
           （上の 409 と、ひとつ上の自分自身チェックを通っているので、
             ここへ来るのは「権限の行が無い」＝運用から外れているログインだけ） */
        const found = await findAuthUser(email);
        if (found.error) return authFailed(res, found.error, "ログインを調べられませんでした");
        if (!found.user) return authFailed(res, made, "ログインを作れませんでした");

        const upd = await authAdmin("users/" + encodeURIComponent(found.user.id), {
          method: "PUT",
          body: { password: body.password, email_confirm: true },
        });
        if (!upd.ok) return authFailed(res, upd, "パスワードを設定できませんでした");

        const only = await rest("inventory_members", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: { email, display_name: name, role },
        });
        /* ここで失敗しても、**このログインは消さない。**
           自分で作ったものではない（前からあった）ので、消す判断はこちらでしない */
        if (!only.ok) return res.status(400).json({ error: "権限を登録できませんでした" });

        await log(who.name, email, name, "メンバー追加", "なし",
          ROLE_LABEL[role] + "（既存のログインにパスワードを再設定）");
        return res.status(200).json({ ok: true, member: (only.out && only.out[0]) || null });
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
    if (!found.user) return res.status(404).json({ error: "このログインIDのアカウントが見つかりません" });

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

  // ── 3) アカウントを消す ──
  //     **ログイン（Supabase Auth）と在庫管理の権限（inventory_members）を
  //     まとめて消す。** 片方だけ残ると「ログインできるのに権限が無い」
  //     「権限はあるのにログインできない」という分かりにくい状態になる。
  //
  //     止めるもの（画面でも同じ判定をするが、**本体はこちら**）
  //       ・自分自身は消せない（消すと誰もこの画面を開けなくなる）
  //       ・最後の管理者は消せない（同上）
  //       ・確認のためログインIDを打ち直してもらう
  if (action === "delete") {
    if (email === who.email) return res.status(400).json({ error: "自分自身のアカウントは消せません" });
    if (String(body.confirm || "").trim().toLowerCase() !== loginId) {
      return res.status(400).json({ error: "確認のためログインIDを入力してください" });
    }

    // いまの権限と、管理者が何人いるか
    const cur = await rest("inventory_members?select=email,display_name,role&email=eq." +
      encodeURIComponent(email) + "&limit=1");
    const row = (cur.ok && Array.isArray(cur.out) && cur.out[0]) || null;
    if (row && row.role === "admin") {
      const adm = await rest("inventory_members?select=email&role=eq.admin");
      const n = (adm.ok && Array.isArray(adm.out) && adm.out.length) || 0;
      if (n <= 1) {
        return res.status(400).json({ error: "最後の管理者は消せません。先に別の管理者を足してください" });
      }
    }

    // (a) ログインを消す。もう無いときは、権限の削除だけ進める
    const found = await findAuthUser(email);
    if (found.error) return authFailed(res, found.error, "ログインを調べられませんでした");
    if (found.user) {
      const del = await authAdmin("users/" + encodeURIComponent(found.user.id), { method: "DELETE" });
      if (!del.ok) return authFailed(res, del, "ログインを消せませんでした");
    }

    // (b) 在庫管理の権限も消す
    const off = await rest("inventory_members?email=eq." + encodeURIComponent(email), {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    if (!off.ok) {
      return res.status(400).json({
        error: "ログインは消しましたが、在庫管理の権限を外せませんでした。もう一度お試しください",
      });
    }

    await log(who.name, email, (row && row.display_name) || loginId, "アカウント削除",
      row ? ROLE_LABEL[row.role] || row.role : "権限なし",
      found.user ? "ログイン・権限とも削除" : "権限を削除（ログインは元から無し）");
    return res.status(200).json({ ok: true, hadLogin: !!found.user });
  }

  return res.status(400).json({ error: "操作が正しくありません" });
};

module.exports.badPassword = badPassword;
module.exports.findAuthUser = findAuthUser;
module.exports.mailOf = mailOf;
