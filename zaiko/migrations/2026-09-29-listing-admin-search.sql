-- ============================================================
-- 出品先の「管理画面で探す」導線
--
--   これまで /zaiko の出品先にあった「商品URL」は、お客様が見る
--   販売ページです。これはそのまま残します。
--   ここで足すのは、店舗の担当者が商品を探して登録・更新するための
--   「管理画面」への導線です。対象は楽天とAmazon。
--
--   大事なところ
--     ・モールの管理画面URL・検索URLの形はコードに直書きしない。
--       店舗の契約や画面改定で変わるので、設定として持つ
--       （inventory_channel_settings）。
--     ・検索語つきURLの形は、実際に管理画面で1度検索して確かめた
--       ものだけを入れる。楽天とAmazonは、ログイン済みの管理画面で
--       確かめた形を既定として入れてある（下の 2）。
--       設定が空のサイトでは、画面は「検索語をコピーして管理画面を開く」
--       に切り替わる。
--     ・管理画面の直リンク（admin_url）は人が管理画面で開いたURLを
--       貼るための欄。こちらで組み立てたり推測したりしない。
--       楽天なら item.rms.rakuten.co.jp、Amazonなら
--       sellercentral.amazon.co.jp のhttpsだけを受ける。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 検索語つきURLのひな形を、販売サイトごとの設定に足す
--     {q} を検索語（URLエンコード済み）に差し替えて使う。
--     入れてよいのは、実際の管理画面で検索して確かめた形だけ。
-- ------------------------------------------------------------
alter table public.inventory_channel_settings
  add column if not exists admin_search_url_template text;

comment on column public.inventory_channel_settings.admin_search_url_template is
  'その販売サイトの管理画面で、検索語つきで検索結果を開くURLのひな形。{q} を検索語に差し替える。
   入れてよいのは、実際に管理画面で1度検索して確かめた形だけ（推測のURLは作らない）。
   空なら画面側は「検索語をコピーして管理画面のトップを開く」に切り替わる。';

-- ------------------------------------------------------------
-- 2) 管理画面のトップURLと、検索語つきURL。
--     まだ空の販売サイトにだけ既定を入れる。すでに店舗が入れている値は
--     上書きしない（画面が変わったとき店舗が入れ直せるようにするため）。
--
--     検索語つきURLは、ログイン済みの管理画面で実際に検索して確かめた形。
--       Amazon  … /product-search/keywords/search?q=…
--                 （過去のフォーラムにある /product-search/search?q=… ではない）
--       楽天RMS … ?type=keywordSearch&inventoryOutOfStock=INCLUDED-SKU&keyword=…
--                 在庫切れのSKUも含めて探す。出品を直しにいく用途では
--                 在庫0のものこそ見たいため。
--
--     楽天の店舗コード 439442 はこの店舗のもの。他店舗では設定画面から
--     入れ替えられるよう、コード側ではこの値を持たない。
-- ------------------------------------------------------------
update public.inventory_channel_settings
   set admin_home_url = 'https://item.rms.rakuten.co.jp/rms-sku/shops/439442/items'
 where channel = 'rakuten' and nullif(btrim(coalesce(admin_home_url, '')), '') is null;

update public.inventory_channel_settings
   set admin_search_url_template = 'https://item.rms.rakuten.co.jp/rms-sku/shops/439442/items'
       || '?type=keywordSearch&inventoryOutOfStock=INCLUDED-SKU&keyword={q}'
 where channel = 'rakuten' and nullif(btrim(coalesce(admin_search_url_template, '')), '') is null;

update public.inventory_channel_settings
   set admin_home_url = 'https://sellercentral.amazon.co.jp/product-search'
 where channel = 'amazon' and nullif(btrim(coalesce(admin_home_url, '')), '') is null;

update public.inventory_channel_settings
   set admin_search_url_template = 'https://sellercentral.amazon.co.jp/product-search/keywords/search?q={q}'
 where channel = 'amazon' and nullif(btrim(coalesce(admin_search_url_template, '')), '') is null;

-- ------------------------------------------------------------
-- 3) 管理画面URLの受け入れ規則
--
--     ・https だけ
--     ・楽天・Amazonは、その販売サイトの管理画面のドメインだけ
--     ・ログインセッションや認証トークンが載っている一時URLは断る
--       （貼った人のセッションが切れたあと使えないうえ、残すべきでない）
-- ------------------------------------------------------------
create or replace function public.inv_admin_url_check(
  p_channel text,
  p_url     text
) returns text
language plpgsql immutable set search_path = public, pg_catalog as $$
declare
  v_url  text := nullif(btrim(coalesce(p_url, '')), '');
  v_host text;
  v_want text;
begin
  if v_url is null then
    return null;                                   -- 空は「消す」の意味。素通し
  end if;
  if v_url !~* '^https://' then
    raise exception '管理画面URLは https:// で始まるものだけ登録できます';
  end if;
  -- https:// のうしろ、最初の / ? # までがホスト名
  v_host := lower(split_part(regexp_replace(v_url, '^https://', '', 'i'), '/', 1));
  v_host := split_part(split_part(v_host, '?', 1), '#', 1);
  v_host := split_part(v_host, '@', -1);           -- user:pass@host の形を除く
  v_host := split_part(v_host, ':', 1);            -- ポート番号を落とす

  v_want := case p_channel
              when 'rakuten' then 'item.rms.rakuten.co.jp'
              when 'amazon'  then 'sellercentral.amazon.co.jp'
              else null
            end;
  if v_want is not null and v_host <> v_want then
    raise exception '% の管理画面URLは % のものだけ登録できます（いまは %）',
      case p_channel when 'rakuten' then '楽天' else 'Amazon' end, v_want, v_host;
  end if;

  -- ログイン中だけ有効な一時URLは残さない
  if v_url ~* '(session[-_]?id|sessionid|access[-_]?token|id[-_]?token|refresh[-_]?token|auth[-_]?token|[?&]token=|[?&]code=|[?&]state=|jsessionid|sid=)' then
    raise exception 'ログイン中だけ有効なURL（セッションIDやトークンつき）は登録できません。
管理画面で商品を開いたあとの、毎回同じになるURLを貼ってください';
  end if;
  return v_url;
end $$;

comment on function public.inv_admin_url_check is
  '管理画面URLとして受けてよい形か確かめる。https のみ、楽天・Amazonはそのサイトの
   管理画面ドメインのみ、セッションIDやトークンつきの一時URLは断る。空は素通し（消す意味）。';

-- ------------------------------------------------------------
-- 4) 商品ごとの管理画面URL（人が管理画面で開いたURLを貼る欄）
--     受け入れ規則をDB側でも通す。
--
--     まだ出品していない商品でも、管理画面で先に商品を作ってURLが
--     分かっていることがある。その場合は掲載の行が無いので、
--     UPDATE だけだと保存できない。行が無ければ作る。
--     入れるのは admin_url だけで、出品状態・価格・SKU・商品URLは
--     触らない（作られた行は「未出品」のまま）。
-- ------------------------------------------------------------
create or replace function public.inv_listing_admin_url_set(
  p_code    text,
  p_channel text,
  p_url     text
) returns public.inventory_channel_listings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_listings;
  v text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if not exists (select 1 from public.inventory_products where code = p_code) then
    raise exception 'この型番は登録されていません（%）', p_code;
  end if;
  v := public.inv_admin_url_check(p_channel, p_url);

  update public.inventory_channel_listings
     set admin_url = v, updated_at = now()
   where product_code = p_code and channel = p_channel
  returning * into r;
  if found then
    return r;
  end if;

  -- 掲載の行が無いとき。消す指示（空）なら、空の行を作らずに終わる
  if v is null then
    return null;
  end if;
  insert into public.inventory_channel_listings (product_code, channel, admin_url)
  values (p_code, p_channel, v)
  on conflict (product_code, channel) do update
    set admin_url = excluded.admin_url, updated_at = now()
  returning * into r;
  return r;
end $$;

comment on function public.inv_listing_admin_url_set is
  'その商品の販売サイト管理画面URL（直リンク）を入れ直す。人が管理画面で確かめた値だけを入れる。
   https のみ、楽天・Amazonはそのサイトの管理画面ドメインのみ、一時URLは断る。';

-- ------------------------------------------------------------
-- 5) 販売サイトごとの設定。検索URLのひな形を足し、受け入れ規則を通す
--
--     引数が1つ増える。既定値つきで足すと4引数の呼び出しがどちらの関数か
--     決まらなくなるので、古い署名は先に落とす。
-- ------------------------------------------------------------
drop function if exists public.inv_channel_settings_set(text,text,text,text);

create or replace function public.inv_channel_settings_set(
  p_channel  text,
  p_home     text default null,
  p_template text default null,
  p_note     text default null,
  p_search   text default null
) returns public.inventory_channel_settings
language plpgsql security invoker set search_path = public as $$
declare
  r public.inventory_channel_settings;
  v_home   text;
  v_tpl    text;
  v_search text;
begin
  if not public.inv_is_admin() then
    raise exception '販売サイトの設定は管理者だけが変えられます';
  end if;
  v_home := public.inv_admin_url_check(p_channel, p_home);

  -- ひな形は差し替え前だと形が崩れているので、いちど埋めてから確かめる。
  -- 保存するのはひな形のまま。
  v_tpl := nullif(btrim(coalesce(p_template, '')), '');
  if v_tpl is not null then
    perform public.inv_admin_url_check(p_channel,
      replace(replace(replace(v_tpl, '{manage}', 'x'), '{sku}', 'x'), '{item_code}', 'x'));
  end if;

  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_search is not null then
    if position('{q}' in v_search) = 0 then
      raise exception '検索URLのひな形には、検索語が入る {q} を含めてください';
    end if;
    perform public.inv_admin_url_check(p_channel, replace(v_search, '{q}', 'x'));
  end if;

  insert into public.inventory_channel_settings
         (channel, admin_home_url, admin_item_url_template, note, admin_search_url_template)
  values (p_channel, v_home, v_tpl, nullif(btrim(coalesce(p_note, '')), ''), v_search)
  on conflict (channel) do update
    set admin_home_url            = v_home,
        admin_item_url_template   = v_tpl,
        admin_search_url_template = v_search,
        note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), public.inventory_channel_settings.note)
  returning * into r;
  return r;
end $$;

comment on function public.inv_channel_settings_set is
  '販売サイトの管理画面URL（トップ・商品ごとのひな形・検索語つきのひな形）を設定する。管理者だけ。
   検索語つきのひな形は、実際の管理画面で検索して確かめた人だけが入れる。';

revoke all on function public.inv_admin_url_check(text,text) from public, anon;
grant execute on function public.inv_admin_url_check(text,text) to authenticated;
grant execute on function public.inv_channel_settings_set(text,text,text,text,text) to authenticated;
