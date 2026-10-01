-- ============================================================
-- 個体詳細から基本情報を直す
--   2026-10-11
--
--   /zaiko/items/:id を見ているときに、シリアル番号や仕入日を直す手段が
--   なかった（在庫一覧の「まとめて直す」はカテゴリ・メーカー・保管場所だけ）。
--   詳細画面の ［編集］ から直せるようにする。
--
--   直せるのは2種類だけで、**どちらがどちらの表かをはっきり分ける**。
--
--     この個体（inventory_items）   … 保管場所・シリアル番号・仕入日・備考
--     商品マスタ（inventory_products）… 商品名・メーカー・型番・カテゴリ・スペック
--
--   すでに専用の操作があるものはここでは触らない。
--     在庫状態・利用者 … inv_item_op（貸出／返却／修理・故障／売却／廃棄）
--     値段             … inv_item_price
--     棚卸             … inv_item_op('棚卸確認') / inv_stocktake_*
--     8RENT・出品      … inv_product_rental_set / inv_listing_set
--     QR・価格の確認   … inv_qr_print_mark / inv_price_check_set
--     管理番号・商品コード・仕入元ID … 変えない
--
--   **保管場所は既存の inv_item_op('移動') をそのまま呼ぶ。**
--   移動の検証も履歴もあちらが持っているので、ここで書き直さない。
--
--   **画面が呼ぶのは inv_item_basic_edit() の1回だけ。**
--   個体とマスタを別々に呼ぶと、片方だけ保存された半端な状態が起きうる
--     （個体は保存できたがマスタで失敗した、など）。
--   関数を1回呼べば、その中は1つの取引になるので、途中で失敗すれば何も変わらない。
--
--   このmigrationでやること
--     1) inv_item_edit()       … この個体の4項目（中で使う）
--     2) inv_product_edit()    … 商品マスタの5項目（中で使う。同じ商品の全個体に効く）
--     3) inv_item_basic_edit() … **画面が呼ぶのはこれ1つ。**上の2つをまとめて1回で終える
--     4) 権限
--
--   直せるのは**管理者だけ**（inv_is_admin()）。
--   在庫数・状態・価格・棚卸・8RENT・QRには触らない。
--   履歴（inventory_transactions）は追記のみで、1行も消さない。
-- ============================================================


-- ------------------------------------------------------------
-- 1) この個体を直す（inv_item_basic_edit の中で使う）
--
--    保管場所が変わるときは inv_item_op('移動') を呼ぶ（同じ取引の中なので、
--    移動だけ成功して残りが失敗する、ということは起きない）。
--    残りの3項目は「何が何に変わったか」を1行にまとめて履歴へ残す。
--    変わっていなければ履歴を足さない（水増ししない）。
-- ------------------------------------------------------------
create or replace function public.inv_item_edit(
  p_item_id      text,
  p_location_id  text default null,
  p_serial       text default null,
  p_purchased_on date default null,
  p_note         text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it      public.inventory_items;
  v_ser   text := nullif(btrim(coalesce(p_serial, '')), '');
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_loc   text := nullif(btrim(coalesce(p_location_id, '')), '');
  v_diff  text[] := '{}';
  v_show  text;
begin
  if not public.inv_is_admin() then
    raise exception '基本情報を直せるのは管理者だけです';
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;

  -- 保管場所は専用の操作にそのまま任せる（移動の履歴もあちらが残す）
  if v_loc is not null and v_loc is distinct from it.location_id then
    it := public.inv_item_op(p_item_id, '移動', v_loc, null);
  end if;

  v_show := 'なし';
  if v_ser is distinct from it.serial then
    v_diff := v_diff || ('シリアル番号 ' || coalesce(it.serial, v_show) || ' → ' || coalesce(v_ser, v_show));
  end if;
  if p_purchased_on is distinct from it.purchased_on then
    v_diff := v_diff || ('仕入日 ' || coalesce(to_char(it.purchased_on, 'YYYY/MM/DD'), v_show)
                         || ' → ' || coalesce(to_char(p_purchased_on, 'YYYY/MM/DD'), v_show));
  end if;
  if v_note is distinct from it.note then
    v_diff := v_diff || '備考';
  end if;

  if array_length(v_diff, 1) is null then
    return it;                       -- 何も変わっていない
  end if;

  update public.inventory_items
     set serial = v_ser, purchased_on = p_purchased_on, note = v_note
   where id = p_item_id returning * into it;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'item', p_item_id, it.name, '編集',
          'この個体', array_to_string(v_diff, '／'));

  return it;
end $$;

comment on function public.inv_item_edit is
  'その1台の 保管場所・シリアル番号・仕入日・備考 を直す。
   保管場所は inv_item_op(''移動'') をそのまま呼ぶ。状態・利用者・価格・棚卸・
   管理番号・商品コード・仕入元ID には触らない。変わった項目だけ履歴に残す。';


-- ------------------------------------------------------------
-- 2) 商品マスタを直す（inv_item_basic_edit の中で使う）
--
--    **同じ商品コードにぶら下がる全個体に効く。** 画面でもそう書く。
--    個体側にある name / maker / model / category_id は表示用の写しなので、
--    inv_bulk_update_products と同じようにマスタへ合わせておく
--    （画面は prod(code) が正で読むが、写しが古いまま残らないようにする）。
--    spec はマスタにしかない。
-- ------------------------------------------------------------
create or replace function public.inv_product_edit(
  p_code        text,
  p_name        text default null,
  p_maker       text default null,
  p_model       text default null,
  p_category_id text default null,
  p_spec        text default null
) returns public.inventory_products
language plpgsql security invoker set search_path = public as $$
declare
  pr      public.inventory_products;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_maker text := nullif(btrim(coalesce(p_maker, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_cat   text := nullif(btrim(coalesce(p_category_id, '')), '');
  v_spec  text := nullif(btrim(coalesce(p_spec, '')), '');
  v_diff  text[] := '{}';
  v_show  text := 'なし';
begin
  if not public.inv_is_admin() then
    raise exception '基本情報を直せるのは管理者だけです';
  end if;

  select * into pr from public.inventory_products where code = p_code for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_code;
  end if;
  if v_name is null and v_model is null then
    raise exception '型番か商品名のどちらかは要ります';
  end if;
  if v_cat is not null and not exists (select 1 from public.inventory_categories where id = v_cat) then
    raise exception '知らないカテゴリです（%）', v_cat;
  end if;

  if v_name  is distinct from pr.name  then
    v_diff := v_diff || ('商品名 ' || coalesce(pr.name, v_show) || ' → ' || coalesce(v_name, v_show)); end if;
  if v_maker is distinct from pr.maker then
    v_diff := v_diff || ('メーカー ' || coalesce(pr.maker, v_show) || ' → ' || coalesce(v_maker, v_show)); end if;
  if v_model is distinct from pr.model then
    v_diff := v_diff || ('型番 ' || coalesce(pr.model, v_show) || ' → ' || coalesce(v_model, v_show)); end if;
  if v_cat   is distinct from pr.category_id then
    v_diff := v_diff || ('カテゴリ ' || coalesce((select name from public.inventory_categories where id = pr.category_id), v_show)
                         || ' → ' || coalesce((select name from public.inventory_categories where id = v_cat), v_show)); end if;
  if v_spec  is distinct from pr.spec  then v_diff := v_diff || 'スペック'; end if;

  if array_length(v_diff, 1) is null then
    return pr;                       -- 何も変わっていない
  end if;

  update public.inventory_products
     set name = coalesce(v_name, v_model), maker = v_maker, model = v_model,
         category_id = v_cat, spec = v_spec
   where code = p_code returning * into pr;

  -- 個体側の表示用の写しも合わせる（inv_bulk_update_products と同じ考えかた）
  update public.inventory_items
     set name = pr.name, maker = pr.maker, model = pr.model, category_id = pr.category_id
   where product_code = p_code;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'product', p_code, coalesce(pr.name, pr.model), '編集',
          '商品マスタ', array_to_string(v_diff, '／'));

  return pr;
end $$;

comment on function public.inv_product_edit is
  '商品マスタの 商品名・メーカー・型番・カテゴリ・スペック を直す。
   **同じ商品コードの全個体に効く。** 個体側の表示用の写しも合わせる。
   在庫数・状態・価格・8RENT・出品・商品コードには触らない。';


-- ------------------------------------------------------------
-- 3) 画面が呼ぶのはこれ1つ（個体とマスタをまとめて1回で終える）
--
--    **片方だけ保存される状態を作らないための関数。**
--    ブラウザから inv_item_edit と inv_product_edit を続けて呼ぶと、
--    1つめが成功して2つめが失敗したときに個体だけ保存されてしまう
--    （RPC 1回ごとに取引が閉じるため）。
--    1回の呼び出しにまとめれば、その中はまるごと1つの取引になり、
--    途中でどこが失敗しても**何も変わらない**。
--
--    新しい判断はここに置かない。権限も履歴も移動も、上の2つと
--    既存の inv_item_op('移動') がそのまま持つ。ここは順番に呼ぶだけ。
--
--    返すのは画面が描き直すのに要るものだけ。
--      item     … 直した1台
--      product  … 商品マスタ（マスタが変わったときだけ）
--      items    … 同じ商品の個体（**マスタが変わったときだけ**。
--                  表示用の写しが変わるので画面の手元も入れ替える）
-- ------------------------------------------------------------
create or replace function public.inv_item_basic_edit(
  p_item_id      text,
  p_location_id  text default null,
  p_serial       text default null,
  p_purchased_on date default null,
  p_note         text default null,
  p_name         text default null,
  p_maker        text default null,
  p_model        text default null,
  p_category_id  text default null,
  p_spec         text default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  it      public.inventory_items;
  was     public.inventory_products;
  pr      public.inventory_products;
  v_moved boolean := false;
begin
  if not public.inv_is_admin() then
    raise exception '基本情報を直せるのは管理者だけです';
  end if;

  select * into it from public.inventory_items where id = p_item_id;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  if coalesce(it.product_code, '') <> '' then
    select * into was from public.inventory_products where code = it.product_code;
  end if;

  -- 1) この個体（保管場所が変わるときは、この中で既存の inv_item_op('移動') を通る）
  it := public.inv_item_edit(p_item_id, p_location_id, p_serial, p_purchased_on, p_note);

  -- 2) 商品マスタ。商品が結びついていない個体では何もしない
  if was.code is not null then
    pr := public.inv_product_edit(was.code, p_name, p_maker, p_model, p_category_id, p_spec);
    v_moved := (pr.name        is distinct from was.name)
            or (pr.maker       is distinct from was.maker)
            or (pr.model       is distinct from was.model)
            or (pr.category_id is distinct from was.category_id);
    -- マスタが変わると個体側の写しも変わるので、返す1台を読み直す
    if v_moved then
      select * into it from public.inventory_items where id = p_item_id;
    end if;
  end if;

  return jsonb_build_object(
    'item', to_jsonb(it),
    'product', case when pr.code is null then null else to_jsonb(pr) end,
    -- 写しが変わったときだけ。毎回だと同じ商品の台数ぶん無駄に返すことになる
    'items', case when v_moved
      then coalesce((select jsonb_agg(to_jsonb(x)) from public.inventory_items x
                      where x.product_code = was.code), '[]'::jsonb)
      else null end);
end $$;

comment on function public.inv_item_basic_edit is
  '個体詳細の［編集］の保存。**画面が呼ぶのはこれ1つだけ。**
   inv_item_edit と inv_product_edit を1回の呼び出し＝1つの取引でまとめて行うので、
   片方だけ保存された状態にならない。判断は足さず、順番に呼ぶだけ。';


-- ------------------------------------------------------------
-- 4) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」への1回きりの処理なので、あとから足した関数には効かない。
--    既定では PUBLIC に EXECUTE が付き anon からも呼べてしまうため、明示的に配り直す。
--    3つとも関数の中で inv_is_admin() が見る。
--    商品名・型番・カテゴリは**同じ商品の全個体に効く**ので、直せるのは管理者だけ。
--    倉庫メンバーは移動・棚卸確認・入出庫・販売済みなど、既存の操作をそのまま使う。
--    新しい権限は作らず、すでにある inv_is_admin() を見ている。
--
--    inv_item_edit / inv_product_edit も authenticated に渡したままにする。
--    security invoker なので、呼ぶ人に EXECUTE が無いと
--    inv_item_basic_edit の中からも呼べなくなるため（security definer は使わない。
--    この仕組みの関数はすべて invoker ＋ inv_can_edit() でそろえている）。
--    画面から呼ぶのは inv_item_basic_edit だけにしている。
-- ------------------------------------------------------------
revoke all on function public.inv_item_edit(text, text, text, date, text) from public, anon, service_role;
grant execute on function public.inv_item_edit(text, text, text, date, text) to authenticated;

revoke all on function public.inv_product_edit(text, text, text, text, text, text) from public, anon, service_role;
grant execute on function public.inv_product_edit(text, text, text, text, text, text) to authenticated;

revoke all on function public.inv_item_basic_edit(text, text, text, date, text, text, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.inv_item_basic_edit(text, text, text, date, text, text, text, text, text, text)
  to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '関数がある' as kind,
       case when to_regprocedure('public.inv_item_edit(text,text,text,date,text)') is not null
             and to_regprocedure('public.inv_product_edit(text,text,text,text,text,text)') is not null
             and to_regprocedure('public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)') is not null
            then 'OK 3つとも' else 'NG' end as result
union all
select '保存は1回で終わる',
       case when pg_get_functiondef('public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)'::regprocedure)
                 like '%public.inv_item_edit(p_item_id%'
             and pg_get_functiondef('public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)'::regprocedure)
                 like '%public.inv_product_edit(was.code%'
            then 'OK 中で2つとも呼んでいる' else 'NG' end
union all
select '個体は4項目だけ直す',
       case when pg_get_functiondef('public.inv_item_edit(text,text,text,date,text)'::regprocedure)
                 like '%set serial = v_ser, purchased_on = p_purchased_on, note = v_note%'
            then 'OK' else 'NG' end
union all
select '個体の状態・価格・棚卸には触らない',
       case when pg_get_functiondef('public.inv_item_edit(text,text,text,date,text)'::regprocedure)
                 ~ '(set|,)\s*(status|user_name|price|plan_price|purchase_fee|last_checked_at|qr_print_count|price_checked_at)\s*='
            then 'NG 触っている' else 'OK' end
union all
select '保管場所は既存の移動を呼ぶ',
       case when pg_get_functiondef('public.inv_item_edit(text,text,text,date,text)'::regprocedure)
                 like '%public.inv_item_op(p_item_id, ''移動''%'
            then 'OK' else 'NG' end
union all
select 'マスタは5項目だけ直す',
       case when pg_get_functiondef('public.inv_product_edit(text,text,text,text,text,text)'::regprocedure)
                 like '%set name = coalesce(v_name, v_model), maker = v_maker, model = v_model,%'
            then 'OK' else 'NG' end
union all
select 'マスタは在庫数・8RENTに触らない',
       case when pg_get_functiondef('public.inv_product_edit(text,text,text,text,text,text)'::regprocedure)
                 ~ '(set|,)\s*(qty|min_qty|rental_enabled|sale_enabled|unit_price)\s*='
            then 'NG 触っている' else 'OK' end
union all
select 'どちらも履歴に残す',
       case when pg_get_functiondef('public.inv_item_edit(text,text,text,date,text)'::regprocedure)
                 like '%insert into public.inventory_transactions%'
             and pg_get_functiondef('public.inv_product_edit(text,text,text,text,text,text)'::regprocedure)
                 like '%insert into public.inventory_transactions%'
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_edit(text,text,text,date,text)', 'execute')
              or has_function_privilege('anon', 'public.inv_product_edit(text,text,text,text,text,text)', 'execute')
              or has_function_privilege('anon', 'public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '直せるのは管理者だけ',
       case when pg_get_functiondef('public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)'::regprocedure)
                 like '%if not public.inv_is_admin() then%'
             and pg_get_functiondef('public.inv_item_edit(text,text,text,date,text)'::regprocedure)
                 like '%if not public.inv_is_admin() then%'
             and pg_get_functiondef('public.inv_product_edit(text,text,text,text,text,text)'::regprocedure)
                 like '%if not public.inv_is_admin() then%'
            then 'OK' else 'NG' end
union all
select '社員は呼べる（中で管理者かを見る）',
       case when has_function_privilege('authenticated', 'public.inv_item_edit(text,text,text,date,text)', 'execute')
             and has_function_privilege('authenticated', 'public.inv_product_edit(text,text,text,text,text,text)', 'execute')
             and has_function_privilege('authenticated', 'public.inv_item_basic_edit(text,text,text,date,text,text,text,text,text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'シリアル番号が空の個体数',
       (select count(*)::text from public.inventory_items
         where coalesce(btrim(serial), '') = '' and status <> '廃棄') || '台'
union all
select '仕入日が空の個体数',
       (select count(*)::text from public.inventory_items
         where purchased_on is null and status <> '廃棄') || '台';
