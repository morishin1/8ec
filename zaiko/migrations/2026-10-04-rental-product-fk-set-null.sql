-- ============================================================
-- レンタル申込を、商品マスタの削除で消さない
--
--   inventory_rental_requests.product_code の外部キーが
--   ON DELETE CASCADE になっていました。商品マスタを1件消しただけで、
--   その商品で来ていた過去のレンタル申込ごと消える状態です。
--
--     inventory_rental_requests_product_code_fkey
--       FOREIGN KEY (product_code) REFERENCES inventory_products(code)
--       ON DELETE CASCADE          ← これ
--
--   レンタル申込は、お客様の連絡先・希望台数・希望期間・希望スペック・
--   希望モデル・ご連絡事項を持つ、契約前の大事な記録です。
--   商品の整理と一緒に消えてよいものではありません。
--
--   2026-10-03 で product_code を NULL 可にしたので、
--   ON DELETE SET NULL に変えます。商品が消えても申込は残り、
--   「商品未指定（条件から提案）」として扱えます。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 外部キーを付け替える
--     参照先（inventory_products.code）も、列（product_code）も変えません。
--     変えるのは「参照先が消えたときどうするか」だけです。
-- ------------------------------------------------------------
alter table public.inventory_rental_requests
  drop constraint if exists inventory_rental_requests_product_code_fkey;

alter table public.inventory_rental_requests
  add constraint inventory_rental_requests_product_code_fkey
  foreign key (product_code) references public.inventory_products(code)
  on delete set null;

-- ------------------------------------------------------------
-- 2) 商品を消すときに、レンタル申込への影響を履歴へ残す
--
--     外部キーの ON DELETE SET NULL はDBが静かに行うので、それだけでは
--     inventory_transactions に何も残りません。あとから
--     「この申込はなぜ商品未指定なのか」が分からなくなります。
--     商品を消す前に、影響する申込の件数を履歴へ書きます。
--
--     inv_delete_products() の中身はここだけ足して、ほかは変えていません。
-- ------------------------------------------------------------
create or replace function public.inv_delete_products(p_codes text[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  n_products integer := 0;
  n_units    integer := 0;
  n_chans    integer := 0;
  n_listings integer := 0;
  n_rentals  integer := 0;
  p          record;
begin
  if not public.inv_is_admin() then
    raise exception '削除は管理者だけができます';
  end if;
  if p_codes is null or array_length(p_codes, 1) is null then
    raise exception '対象が選ばれていません';
  end if;
  if exists (select 1 from public.inventory_stocktakes where status = 'open') then
    raise exception '実施中の棚卸があります。先に棚卸を終了してください';
  end if;

  -- 先に「何を消すのか」を履歴へ。消したあとでは名前が分からなくなる
  for p in
    select pr.code, pr.name, pr.model,
           (select count(*) from public.inventory_items i where i.product_code = pr.code) as units,
           (select count(*) from public.inventory_rental_requests r where r.product_code = pr.code) as rentals
      from public.inventory_products pr
     where pr.code = any(p_codes)
  loop
    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values
      (public.inv_actor(), 'product', p.code, coalesce(nullif(p.name,''), p.model), '削除',
       format('%s（個体 %s台）', coalesce(nullif(p.model,''), p.code), p.units), '削除');

    -- レンタル申込は消さずに残す（商品だけ外れて「商品未指定」になる）。
    -- DBが静かに外すので、そのことをここで書いておく
    if p.rentals > 0 then
      n_rentals := n_rentals + p.rentals;
      insert into public.inventory_transactions
        (actor, ref_kind, ref_id, label, action, before_value, after_value)
      values
        (public.inv_actor(), 'product', p.code, coalesce(nullif(p.name,''), p.model),
         'レンタル申込の商品を外した',
         format('%s（%s）の申込 %s件', p.code, coalesce(nullif(p.model,''), p.code), p.rentals),
         '申込は残し、商品未指定にしました');
    end if;
  end loop;

  delete from public.inventory_loans
   where item_id in (select id from public.inventory_items where product_code = any(p_codes));
  delete from public.inventory_stocktake_items
   where item_id in (select id from public.inventory_items where product_code = any(p_codes));

  with d as (delete from public.inventory_items where product_code = any(p_codes) returning 1)
  select count(*) into n_units from d;
  with d as (delete from public.inventory_channels where product_code = any(p_codes) returning 1)
  select count(*) into n_chans from d;
  with d as (delete from public.inventory_channel_listings where product_code = any(p_codes) returning 1)
  select count(*) into n_listings from d;
  with d as (delete from public.inventory_products where code = any(p_codes) returning 1)
  select count(*) into n_products from d;

  return jsonb_build_object('products', n_products, 'units', n_units,
                            'channels', n_chans + n_listings, 'rentals', n_rentals);
end $$;

comment on function public.inv_delete_products is
  '選んだ商品を、ぶら下がる個体と販売情報ごと消す。管理者のみ。何を消したかは履歴に残す。
   レンタル申込は消さない（商品だけ外れて「商品未指定」になる）。外した件数も履歴に残す。';

-- 作り直したので権限を入れ直す（create or replace でも既定のPUBLICが付き直す）
revoke all   on function public.inv_delete_products(text[]) from public, anon, service_role;
grant execute on function public.inv_delete_products(text[]) to authenticated;

-- ------------------------------------------------------------
-- 確かめかた
--
--   1) 外部キーが SET NULL になったか
--        select conname, pg_get_constraintdef(oid) from pg_constraint
--         where conrelid = 'public.inventory_rental_requests'::regclass
--           and contype = 'f'
--           and pg_get_constraintdef(oid) ilike '%product_code%';
--      → ON DELETE SET NULL を含む
--
--   2) 商品を消しても申込が残るか
--        商品ありの申込を1件作ってから、その商品を消して
--        select id, product_code, customer_name, qty, conditions
--          from public.inventory_rental_requests where id = <id>;
--      → 行は残り、product_code だけ null。ほかはそのまま
--
--   3) 履歴に残るか
--        select action, before_value, after_value from public.inventory_transactions
--         where ref_kind = 'product' order by id desc limit 3;
--      → 「レンタル申込の商品を外した」が出る
-- ------------------------------------------------------------
