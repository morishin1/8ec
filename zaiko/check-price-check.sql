\set ON_ERROR_STOP on
\pset footer off
-- ============================================================
-- 価格の確認の点検（2026-10-17 で「出品中の条件」から外したあと）
--
--   Supabase の SQL Editor に貼って実行してください。
--   **全体が1つのトランザクションで、最後に必ず rollback します。**
--   途中で作った商品・個体・履歴はすべて消え、本番のデータは1行も変わりません
--   （在庫数も売上も動きません）。
--
--   auth スキーマには触りません。「誰としてログインしているか」は、
--   Supabase 標準の auth.jwt() が読んでいる request.jwt.claims を
--   このトランザクションの中だけ差し替えて切り替えます。
--
--   見ること（12節）
--     価格が未設定・未確認でも「出品中」にできる（在庫状態と掲載は別もの）
--     価格の確認そのものは残っている（表示・管理者だけ・価格を変えたら外れる）
--     売却取消・棚卸差異確定取消は、未確認でも「出品中」へ戻る
--     売却・QR販売・実売価格の入力と修正には影響していない
-- ============================================================
begin;

-- 点検用の人・商品・個体（rollback で消えます）
insert into public.inventory_members(email, display_name, role) values
  ('chk-pc-admin@example.invalid','点検管理者','admin'),
  ('chk-pc-member@example.invalid','点検メンバー','member'),
  ('chk-pc-viewer@example.invalid','点検閲覧','viewer');

insert into public.inventory_products(code,name,maker,model,kind,category_id,location_id)
  values ('CHKPC','点検用PC','dynabook','B65/CHK','individual',
          (select id from public.inventory_categories order by id limit 1),
          (select id from public.inventory_locations order by id limit 1));

-- CHKPC-1 … 価格そのものが未設定（price / plan_price が null）
-- CHKPC-2 … 価格は入っているが未確認
-- CHKPC-3 … 売却取消を見る用
-- CHKPC-4 … 棚卸の差異確定取消を見る用
insert into public.inventory_items(id,product_code,name,maker,model,category_id,location_id,status,price,purchase_fee,plan_price)
  values
  ('CHKPC-1','CHKPC','点検用PC','dynabook','B65/CHK',
   (select id from public.inventory_categories order by id limit 1),
   (select id from public.inventory_locations order by id limit 1),'在庫',null,null,null),
  ('CHKPC-2','CHKPC','点検用PC','dynabook','B65/CHK',
   (select id from public.inventory_categories order by id limit 1),
   (select id from public.inventory_locations order by id limit 1),'在庫',30000,500,50000),
  ('CHKPC-3','CHKPC','点検用PC','dynabook','B65/CHK',
   (select id from public.inventory_categories order by id limit 1),
   (select id from public.inventory_locations order by id limit 1),'在庫',30000,0,50000),
  ('CHKPC-4','CHKPC','点検用PC','dynabook','B65/CHK',
   (select id from public.inventory_categories order by id limit 1),
   (select id from public.inventory_locations order by id limit 1),'在庫',30000,0,50000);

-- 点検用の棚卸（9節で使う）。inv_start_stocktake() は「実施中の棚卸がある」と
-- 断るので、本番に実施中のものがあっても点検できるよう、ここでは行を直接作ります
-- （rollback で消えます。本番の実施中の棚卸には一切触りません）。
create temp table chk_st(id bigint) on commit drop;
with s as (
  insert into public.inventory_stocktakes(actor, scope_location_id, status)
  values ('点検（rollbackで消えます）', null, 'open') returning id)
insert into chk_st select id from s;
insert into public.inventory_stocktake_items(stocktake_id, item_id, expected)
select (select id from chk_st), 'CHKPC-1', true;
-- 下の節は社員として実行するので、この控えだけ読めるようにしておく
grant select on chk_st to authenticated;

set local role authenticated;

\echo ''
\echo '--- 1) 入れたばかりの個体は「未確認」（表示は残っている） ---'
select case when count(*) = 4 then 'OK 4台すべて未確認' else 'NG '||count(*) end as r
  from public.inventory_items where id like 'CHKPC-%' and price_checked_at is null;

\echo '--- 2) 価格が未設定でも「出品中」にできる ---'
set local "request.jwt.claims" = '{"email":"chk-pc-admin@example.invalid"}';
do $$ begin
  perform public.inv_item_op('CHKPC-1','状態変更','出品中',null);
  raise notice 'OK 価格が空のままでも出品中にできた';
exception when others then
  raise notice 'NG 止まってしまった: %', sqlerrm;
end $$;
select case when status='出品中' and price is null and price_checked_at is null
            then 'OK 出品中・価格は空・未確認のまま' else 'NG '||status end as r
  from public.inventory_items where id='CHKPC-1';

\echo '--- 3) 価格は入っていて未確認でも「出品中」にできる ---'
do $$ begin
  perform public.inv_item_op('CHKPC-2','状態変更','出品中',null);
  raise notice 'OK 未確認でも出品中にできた';
exception when others then
  raise notice 'NG 止まってしまった: %', sqlerrm;
end $$;
select case when status='出品中' and price_checked_at is null
            then 'OK 出品中・未確認のまま' else 'NG '||status end as r
  from public.inventory_items where id='CHKPC-2';

\echo '--- 4) 倉庫メンバーでも出品中にできる（状態変更は member も可） ---'
set local "request.jwt.claims" = '{"email":"chk-pc-member@example.invalid"}';
do $$ begin
  perform public.inv_item_op('CHKPC-3','状態変更','出品中',null);
  raise notice 'OK memberも出品中にできた';
exception when others then
  raise notice 'NG 止まってしまった: %', sqlerrm;
end $$;

\echo '--- 5) 閲覧（viewer）は状態を変えられない（ここは変えていない） ---'
set local "request.jwt.claims" = '{"email":"chk-pc-viewer@example.invalid"}';
do $$ begin
  perform public.inv_item_op('CHKPC-4','状態変更','出品中',null);
  raise notice 'NG viewerが変えられてしまった';
exception when others then
  if sqlerrm like '%権限%' then raise notice 'OK viewerは断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;
select case when status='在庫' then 'OK 在庫のまま' else 'NG '||status end as r
  from public.inventory_items where id='CHKPC-4';

\echo '--- 6) 確認済みにできるのは管理者だけ（残している） ---'
set local "request.jwt.claims" = '{"email":"chk-pc-member@example.invalid"}';
do $$ begin
  perform public.inv_price_check_set(array['CHKPC-2'], true, null);
  raise notice 'NG memberが確認できてしまった';
exception when others then
  if sqlerrm like '%管理者だけ%' then raise notice 'OK memberは断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;
set local "request.jwt.claims" = '{"email":"chk-pc-admin@example.invalid"}';
select case when price_checked_at is not null and price_checked_by is not null
            then 'OK 管理者が確認できた（'||price_checked_by||'）' else 'NG' end as r
  from public.inv_price_check_set(array['CHKPC-2'], true, null);
select case when count(*)=1 then 'OK 履歴に「価格確認」が残る' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKPC-2' and action='価格確認';

\echo '--- 7) 価格を変えたら確認が外れる（残している）。状態は落ちない ---'
select case when price_checked_at is null and status='出品中'
            then 'OK 確認は外れ、出品中のまま' else 'NG' end as r
  from (select * from public.inv_item_price('CHKPC-2', 31000, 500, 52000)) x;

\echo '--- 8) 未確認のまま売っても、取り消したら「出品中」へ戻る ---'
select case when status='売却済' and sold_price=48000 then 'OK 48,000円で売れた' else 'NG '||status end as r
  from (select * from public.inv_item_sell_channel('CHKPC-3','rakuten',48000::numeric,'点検')) x;
select case when status='出品中'
            then 'OK 出品中へ戻った（未確認でも在庫へ寄らない）'
            else 'NG '||status end as r
  from (select * from public.inv_item_sell_undo('CHKPC-3','点検')) x;
select case when count(*)=0 then 'OK 履歴に「在庫へ戻しました」の断りが無い' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKPC-3'
   and after_value like '%価格が未確認のため%';
select case when count(*)=1 then 'OK 売却の履歴は消えていない' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKPC-3' and action='売却';

\echo '--- 9) 棚卸の差異確定を取り消しても「出品中」へ戻る ---'
do $$
declare v_st bigint; v_back text;
begin
  select id into v_st from chk_st;
  perform public.inv_stocktake_mark_missing(v_st, 'CHKPC-1');
  if (select status from public.inventory_items where id='CHKPC-1') <> '不明' then
    raise notice 'NG 差異確定で「不明」にならなかった'; return;
  end if;
  v_back := (public.inv_stocktake_unmark_missing(v_st, 'CHKPC-1')).status;
  if v_back = '出品中' then raise notice 'OK 出品中へ戻った（価格未設定・未確認でも）';
  else raise notice 'NG % へ戻った', v_back; end if;
end $$;
select case when count(*)=0 then 'OK 履歴に「在庫へ戻しました」の断りが無い' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKPC-1' and after_value like '%価格が未確認のため%';

\echo '--- 10) 実売価格の入力・修正は未確認でも通る（影響させていない） ---'
select case when status='売却済' and sold_price=45000 then 'OK 未確認でも売れた' else 'NG' end as r
  from (select * from public.inv_item_sell_channel('CHKPC-2','amazon',45000::numeric,'点検')) x;
select case when sold_price=44000 and sold_channel='rakuten' and status='売却済'
            then 'OK 未確認でも実売価格・販売先を直せた' else 'NG' end as r
  from (select * from public.inv_item_sale_edit('CHKPC-2',44000::numeric,'rakuten','点検')) x;
select case when price_checked_at is null then 'OK 価格の確認は動いていない' else 'NG' end as r
  from public.inventory_items where id='CHKPC-2';

\echo '--- 11) 「価格が未確認です」で止める場所はもう無い ---'
select case when not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.prosrc like '%価格が未確認です%')
       then 'OK どこにも無い' else 'NG まだ残っている' end as r;
select case when (select prosrc from pg_proc
                   where oid='public.inv_price_check_guard()'::regprocedure)
                 like '%price_checked_at := null%'
            then 'OK 価格を変えたら外す判定は残っている' else 'NG' end as r;

rollback;

\echo ''
\echo '--- 12) 点検データが残っていないこと（rollback の確認） ---'
select case when (select count(*) from public.inventory_items where id like 'CHKPC-%') = 0
             and (select count(*) from public.inventory_products where code='CHKPC') = 0
             and (select count(*) from public.inventory_members
                   where email like 'chk-pc-%@example.invalid') = 0
            then 'OK 点検データは1行も残っていません' else 'NG 残っています' end as r;

\echo ''
\echo '価格の確認の点検：ここまで NG が無ければ問題なしです'
