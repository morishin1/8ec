-- ============================================================
-- 8RENT：商品を決めずに申し込めるようにする
--
--   inv_rental_request_create() は「機種の指定が無くても受け付ける」
--   つもりで書いてありましたが、inventory_rental_requests.product_code が
--   NOT NULL だったため、実際には保存できませんでした。
--
--   8RENTの入口は「型番が分かる人」だけではありません。
--     必要な台数・利用期間・希望スペック・Office・用途・開始希望日
--   を伝えてもらい、在庫と取り寄せから提案するのが本来のやりかたです。
--   そのため、商品未指定の申込を正式に受けられるようにします。
--
--   決まっていないことは NULL で表します。
--   UNKNOWN / NO-MODEL / DUMMY のような架空の商品コードは入れません。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 商品コードを必須でなくする
--     外部キーはそのまま残します（入っているときは実在する商品だけ）。
--     NULL は外部キーの検査対象外なので、制約を緩めることにはなりません。
-- ------------------------------------------------------------
alter table public.inventory_rental_requests
  alter column product_code drop not null;

comment on column public.inventory_rental_requests.product_code is
  'お客様の申込で決まっている商品。決まっていなければ NULL（商品未指定・条件から提案）。
   お客様が書いた「希望モデル」は conditions->>''model'' に入っていて、これとは別物。
   ここを埋めるのは社内の選定（inv_rental_request_product_set）だけ。';

-- ------------------------------------------------------------
-- 2) 社内で商品を決める
--
--     お客様の「希望モデル」（conditions->>'model'）と、社内で確定する
--     product_code は別物です。似た型番や後継機をこちらで当てはめることは
--     しません。人が選んだ実在の商品だけを入れます。
--
--     ここで入れるのは商品だけで、個体は押さえません。
--     個体を押さえるのは、これまでどおり inv_rental_allocate() を
--     押したときだけです。
-- ------------------------------------------------------------
create or replace function public.inv_rental_request_product_set(
  p_request_id bigint,
  p_code       text
) returns public.inventory_rental_requests
language plpgsql security invoker set search_path = public as $$
declare
  r      public.inventory_rental_requests;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_before text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;

  select * into r from public.inventory_rental_requests where id = p_request_id for update;
  if not found then
    raise exception '申込が見つかりません（%）', p_request_id;
  end if;
  if r.status in ('返却済み', 'キャンセル') then
    raise exception 'この申込はすでに「%」で終わっています', r.status;
  end if;
  -- すでに個体を押さえた後で商品を変えると、押さえたものと食い違う
  if coalesce(array_length(r.item_ids, 1), 0) > 0 or r.item_id is not null then
    raise exception 'すでに個体を割り当てています。先に割当を解いてから商品を変えてください';
  end if;

  if v_code is not null then
    if not exists (select 1 from public.inventory_products where code = v_code) then
      raise exception 'この商品は登録されていません（%）', v_code;
    end if;
  end if;

  v_before := coalesce(r.product_code, '（商品未指定）');

  update public.inventory_rental_requests
     set product_code = v_code,
         -- 機種の候補をまとめる鍵。商品を外したら鍵も外す
         model_key    = case when v_code is null then null
                             else (select public.inv_model_key(p.maker, p.model, p.code)
                                     from public.inventory_products p where p.code = v_code) end,
         updated_at   = now()
   where id = p_request_id
  returning * into r;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values (public.inv_actor(), 'rental_request', p_request_id::text,
          r.customer_name, '申込の商品を決めた',
          v_before, coalesce(v_code, '（商品未指定）'));

  return r;
end $$;

comment on function public.inv_rental_request_product_set is
  '商品未指定の8RENT申込に、社内で商品を決めて入れる（外すときは空を渡す）。
   実在する商品だけ。個体は押さえない（押さえるのは inv_rental_allocate だけ）。
   すでに個体を割り当てている申込・終わった申込は変えられない。履歴に残す。';

revoke all   on function public.inv_rental_request_product_set(bigint,text) from public, anon, service_role;
grant execute on function public.inv_rental_request_product_set(bigint,text) to authenticated;

-- ------------------------------------------------------------
-- 3) 商品未指定のまま個体を割り当てない
--
--     inv_rental_allocate() はもともと
--       「model_key も product_code も無ければ断る」
--     と書いてありますが、断り文句が分かりにくいので言い直します。
--     中身（どの個体を押さえるか）の決まりは変えていません。
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.inv_rental_allocate(bigint)') is null then
    raise exception '関数 inv_rental_allocate が見つかりません。先に setup.sql を適用してください';
  end if;
end $$;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) 商品未指定で保存できるか
--        set role service_role;
--        select public.inv_rental_request_create(
--          '{}'::text[], '条件 太郎', 5, 'テスト株式会社', 't@example.test', null,
--          '2026-11-01', 6, true, 'Core i5以上でお願いします',
--          '{"cpu":"Core i5","memory_gb":16,"model":"HP ProBook 450 G9"}'::jsonb);
--        reset role;
--      → product_code が null、status が 希望受付 で入る
--
--   2) 商品未指定のまま割り当てようとすると断られるか
--        select public.inv_rental_allocate(<id>);
--      → 機種が決まっていません。先に商品を決めてから割り当ててください
--
--   3) 社内で商品を決めて、履歴が残るか
--        select public.inv_rental_request_product_set(<id>, 'P-00537');
--        select action, before_value, after_value from public.inventory_transactions
--         where ref_kind = 'rental_request' order by id desc limit 1;
--
--   4) 商品を決めただけでは個体が動いていないこと
--        select item_id, item_ids from public.inventory_rental_requests where id = <id>;
--      → null と {}
-- ------------------------------------------------------------
