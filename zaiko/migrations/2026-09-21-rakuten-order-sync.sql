-- ============================================================
-- 楽天の受注取り込みを、実際に動く権限にする
--   2026-09-21（2026-09-19-rakuten-orders.sql の追補）
--
--   受注取り込み（Edge Function rakuten-order-sync → inv_sale_orders_apply）を
--   実機で動かしたところ、
--
--     ERROR: permission denied for table inventory_sale_orders
--
--   で止まりました。原因は権限の与え方です。
--     inventory_sale_orders … authenticated には select だけを渡している
--     inv_sale_orders_apply … security invoker（＝呼んだ人の権限で動く）
--   なので、受注明細を1行も書けませんでした。
--
--   直し方は2つありました。
--     (A) 表に insert/update を渡す … ログインしていれば誰でも受注明細を
--         直接書き換えられるようになるので採りません。
--     (B) 関数を security definer にする … この方針にしました。
--         「値を変える操作は必ず関数を通す」という /zaiko の決まりのままで、
--         表は読み取り専用に保てます。権限の確認は関数の中の
--         inv_can_edit()（管理者・一般のみ）で、これまでどおり行います。
--
--   あわせて、発送済みまで進めたときに 売却先（sold_channel）が空のままだったのを直します。
--   inv_item_op('売却') ではなく inv_item_sell(…, p_channel, …) を通すようにしたので、
--   ダッシュボードと履歴に「楽天へ売った」ことが残ります（在庫の動きは同じ）。
--
--   在庫の動かし方・冪等の判定は変えていません。
--     inv_sale_orders_apply  受注明細の取り込み（在庫→販売予約）
--     inv_sale_order_link    未割当の明細に人が商品を当てる
--
--   在庫ロック（inv_reserve_available_item）・inv_sale_reserve・
--   8RENTのレンタル申込・楽天の商品画像同期には触れていません。
--
--   何度流しても同じ結果になります。
--
--   実行後の確認
--     select proname, prosecdef from pg_proc
--      where proname in ('inv_sale_orders_apply','inv_sale_order_link');
--     -- prosecdef が t（true）になっていれば適用できています
-- ============================================================

begin;

create or replace function public.inv_sale_orders_apply(
  p_orders  jsonb,
  p_channel text default 'rakuten'
) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  o            jsonb;
  v_order      text;
  v_line       text;
  v_qty        integer;
  v_unit       integer;
  v_code       text;
  v_item       public.inventory_items;
  v_row        public.inventory_sale_orders;
  v_shipped    boolean;
  v_cancelled  boolean;
  v_new        integer := 0;
  v_already    integer := 0;
  v_reserved   integer := 0;
  v_shippedn   integer := 0;
  v_cancelledn integer := 0;
  v_unmatched  jsonb := '[]'::jsonb;
  v_nostock    jsonb := '[]'::jsonb;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' then
    raise exception '受注データがありません';
  end if;

  for o in select value from jsonb_array_elements(p_orders) loop
    v_order := nullif(btrim(coalesce(o->>'order_number','')), '');
    v_line  := coalesce(nullif(btrim(coalesce(o->>'line_number','')), ''), '1');
    if v_order is null then
      continue;   -- 注文番号が無いものは冪等にできないので取り込まない
    end if;
    v_qty       := greatest(coalesce((o->>'qty')::integer, 1), 1);
    v_shipped   := coalesce((o->>'shipped')::boolean, false);
    v_cancelled := coalesce((o->>'cancelled')::boolean, false);
    v_code      := public.inv_listing_product(p_channel, o->>'item_code', o->>'item_url');

    for v_unit in 1..v_qty loop
      -- 同じ注文が同時に2回届いても在庫を二重に減らさないため、明細ごとに
      -- 先に鍵をかけてから在庫を確保する。あとから来たほうはここで待たされ、
      -- 下の select で「取り込み済み」を見つけて何もしない。
      -- （鍵を取らずに進めると、両方が在庫を取りにいって、あとから来たほうの
      --   unique 違反でロールバックしたときに確保が巻き戻ってしまう）
      perform pg_advisory_xact_lock(hashtextextended(
        p_channel || '/' || v_order || '/' || v_line || '/' || v_unit::text, 0));

      -- すでに取り込んだ明細か（注文番号×明細番号×連番で見る）
      select * into v_row from public.inventory_sale_orders
       where channel = p_channel and order_number = v_order
         and line_number = v_line and unit_no = v_unit
       for update;

      if found then
        v_already := v_already + 1;
        -- 取り込み済みでも、発送・キャンセルの知らせは進める
        if v_cancelled and v_row.status <> 'キャンセル' then
          if v_row.item_id is not null then
            select * into v_item from public.inventory_items where id = v_row.item_id for update;
            if v_item.status = '販売予約' then
              perform public.inv_item_op(v_row.item_id, '予約解除', null,
                       p_channel || ' 注文 ' || v_order || ' のキャンセル');
            end if;
          end if;
          update public.inventory_sale_orders set status = 'キャンセル' where id = v_row.id;
          v_cancelledn := v_cancelledn + 1;
        elsif v_shipped and v_row.status = '受注' and v_row.item_id is not null then
          select * into v_item from public.inventory_items where id = v_row.item_id for update;
          if v_item.status = '販売予約' then
            -- 売却先（sold_channel）も残す。inv_item_op だけだと「どこへ売ったか」が
            -- 空のままになり、ダッシュボードの売却先が分からなくなる
            perform public.inv_item_sell(v_row.item_id, p_channel,
                     nullif(v_row.price, null)::text,
                     p_channel || ' 注文 ' || v_order || ' 発送');
          end if;
          update public.inventory_sale_orders set status = '発送済' where id = v_row.id;
          v_shippedn := v_shippedn + 1;
        end if;
        continue;
      end if;

      -- ここから新しい明細
      if v_code is null then
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, price,
           ordered_at, status, note, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url',
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '未割当',
                'モールの商品コード・URLから商品を特定できませんでした', o)
        returning * into v_row;
        v_unmatched := v_unmatched || jsonb_build_object(
          'order_number', v_order, 'line_number', v_line,
          'item_code', o->>'item_code', 'item_url', o->>'item_url');
        v_new := v_new + 1;
        continue;
      end if;

      if v_cancelled then
        -- はじめからキャンセルの明細は、在庫を動かさずに記録だけ残す
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
           price, ordered_at, status, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, 'キャンセル', o);
        v_new := v_new + 1;
        continue;
      end if;

      -- 実在庫の確保。8RENTの予約中・貸出中は status が '在庫' ではないので選ばれない
      begin
        v_item := public.inv_sale_reserve(v_code, p_channel,
                    v_order || '-' || v_line || '-' || v_unit,
                    p_channel || ' 注文 ' || v_order);
      exception when others then
        v_item := null;
      end;

      if v_item.id is null then
        insert into public.inventory_sale_orders
          (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
           price, ordered_at, status, note, raw)
        values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
                (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '在庫なし',
                '確保できる在庫がありませんでした', o);
        v_nostock := v_nostock || jsonb_build_object(
          'order_number', v_order, 'line_number', v_line, 'product_code', v_code);
        v_new := v_new + 1;
        continue;
      end if;

      insert into public.inventory_sale_orders
        (channel, order_number, line_number, unit_no, item_code, item_url, product_code,
         item_id, price, ordered_at, status, raw)
      values (p_channel, v_order, v_line, v_unit, o->>'item_code', o->>'item_url', v_code,
              v_item.id, (o->>'price')::numeric, (o->>'ordered_at')::timestamptz, '受注', o)
      returning * into v_row;
      v_new := v_new + 1;
      v_reserved := v_reserved + 1;

      -- 取り込んだ時点ですでに発送済みなら、そのまま売却済へ進める
      if v_shipped then
        perform public.inv_item_sell(v_item.id, p_channel, (o->>'price'),
                 p_channel || ' 注文 ' || v_order || ' 発送');
        update public.inventory_sale_orders set status = '発送済' where id = v_row.id;
        v_shippedn := v_shippedn + 1;
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'channel', p_channel,
    'new', v_new, 'already', v_already,
    'reserved', v_reserved, 'shipped', v_shippedn, 'cancelled', v_cancelledn,
    'unmatched', v_unmatched, 'no_stock', v_nostock);
end $$;


create or replace function public.inv_sale_order_link(
  p_id   bigint,
  p_code text
) returns public.inventory_sale_orders
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  r      public.inventory_sale_orders;
  v_item public.inventory_items;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  select * into r from public.inventory_sale_orders where id = p_id for update;
  if not found then
    raise exception '受注明細が見つかりません（%）', p_id;
  end if;
  if r.item_id is not null then
    raise exception 'この明細にはすでに個体が割り当たっています（%）', r.item_id;
  end if;
  if r.status = 'キャンセル' then
    raise exception 'キャンセル済みの明細です';
  end if;
  if not exists (select 1 from public.inventory_products where code = p_code) then
    raise exception '商品が見つかりません（%）', p_code;
  end if;

  v_item := public.inv_sale_reserve(p_code, r.channel,
              r.order_number || '-' || r.line_number || '-' || r.unit_no,
              r.channel || ' 注文 ' || r.order_number || '（手動で割り当て）');
  if v_item.id is null then
    raise exception 'この商品に確保できる在庫がありません（%）', p_code;
  end if;

  update public.inventory_sale_orders
     set product_code = p_code, item_id = v_item.id, status = '受注',
         note = null
   where id = p_id
  returning * into r;
  return r;
end $$;


comment on function public.inv_sale_orders_apply is
  'モールの受注明細を取り込み、在庫を1台ずつ確保する（在庫→販売予約、発送済みで届いたら売却済）。
   注文番号×明細番号×連番で冪等。商品を特定できない明細は在庫を動かさず「未割当」で記録する。
   確保は inv_sale_reserve（inv_reserve_available_item）を通すので、8RENTの申込と同じ1台を
   二重に取ることはない。security definer だが、操作できるのは inv_can_edit()（管理者・一般）だけ。';

comment on function public.inv_sale_order_link is
  '商品を特定できなかった受注明細に、人が商品を当てて在庫を確保する。確保は inv_sale_reserve を通す。
   security definer だが、操作できるのは inv_can_edit()（管理者・一般）だけ。';

-- 表そのものは読み取り専用のまま（書き込みは上の2つの関数だけ）
revoke insert, update, delete on public.inventory_sale_orders from authenticated;
grant select on public.inventory_sale_orders to authenticated;

revoke all on function public.inv_sale_orders_apply(jsonb,text) from public;
revoke all on function public.inv_sale_order_link(bigint,text) from public;
grant execute on function public.inv_sale_orders_apply(jsonb,text) to authenticated;
grant execute on function public.inv_sale_order_link(bigint,text) to authenticated;

commit;
