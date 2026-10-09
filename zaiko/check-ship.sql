-- ============================================================
-- 発送の管理の点検（2026-10-19）
--
--   Supabase の SQL Editor に貼って、そのまま実行してください。
--   **psql のメタコマンド（\set / \pset / \echo）は使っていません。**
--   見出しは `select '--- n) … ---' as section;` の普通のSQLにしてあります
--   （SQL Editor はメタコマンドを解釈できないため）。
--   **全体が1つのトランザクションで、最後に必ず rollback します。**
--   途中で作った商品・個体・履歴はすべて消え、本番のデータは1行も変わりません
--   （在庫数も売上も動きません）。
--
--   見ること（14節）。導入前に売れていたものが未発送へ大量に入っていないかも見ます。
--
--   auth スキーマには触りません。「誰としてログインしているか」は、
--   Supabase 標準の auth.jwt() が読んでいる request.jwt.claims を
--   このトランザクションの中だけ差し替えて切り替えます。
-- ============================================================
begin;

insert into public.inventory_members(email, display_name, role) values
  ('chk-sh-admin@example.invalid','点検管理者','admin'),
  ('chk-sh-member@example.invalid','点検メンバー','member'),
  ('chk-sh-viewer@example.invalid','点検閲覧','viewer');

insert into public.inventory_products(code,name,maker,model,kind,category_id,location_id)
  values ('CHKSH','点検用プリンター','EPSON','PX-CHK','individual',
          (select id from public.inventory_categories order by id limit 1),
          (select id from public.inventory_locations order by id limit 1));

insert into public.inventory_items(id,product_code,name,maker,model,category_id,location_id,status,price,purchase_fee)
  select 'CHKSH-'||g,'CHKSH','点検用プリンター','EPSON','PX-CHK',
         (select id from public.inventory_categories order by id limit 1),
         (select id from public.inventory_locations order by id limit 1),'在庫',12000,0
    from generate_series(1,4) g;

-- 出品価格（これが発送で変わらないことを見る）
insert into public.inventory_channels(item_id, product_code, channel, state, price)
  values ('CHKSH-1','CHKSH','rakuten','出品中',18000);

set local role authenticated;
set local "request.jwt.claims" = '{"email":"chk-sh-member@example.invalid"}';

select '--- 1) 売ったばかりの個体は「未発送」 ---' as section;
select case when status='売却済' and sold_price=18000 and shipped_at is null and shipped_by is null
            then 'OK 売却済・未発送' else 'NG '||status end as r
  from (select * from public.inv_item_sell_channel('CHKSH-1','rakuten',18000::numeric,'点検')) x;

select '--- 2) 倉庫メンバーが発送できる。日時と担当者が残る ---' as section;
select case when shipped_at is not null and shipped_by='点検メンバー'
            then 'OK 発送済み（'||shipped_by||'）' else 'NG' end as r
  from (select * from public.inv_item_ship('CHKSH-1', true, '点検')) x;
select case when count(*)=1 then 'OK 履歴に「発送完了」が1件' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了';
select case when actor='点検メンバー' and before_value='未発送' and after_value like '発送済み%'
            then 'OK 誰がいつ何をしたかが残る' else 'NG '||coalesce(after_value,'(null)') end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了';

select '--- 3) 二重に押しても壊れない（履歴も増えない） ---' as section;
do $$
declare v_at timestamptz; v_n int;
begin
  select shipped_at into v_at from public.inventory_items where id='CHKSH-1';
  perform public.inv_item_ship('CHKSH-1', true, null);
  perform public.inv_item_ship('CHKSH-1', true, null);
  select count(*) into v_n from public.inventory_transactions
   where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了';
  if v_n = 1 and (select shipped_at from public.inventory_items where id='CHKSH-1') = v_at
    then raise notice 'OK 2回押しても1件のまま、日時も変わらない';
    else raise notice 'NG 履歴 %件', v_n; end if;
end $$;

select '--- 4) 発送では在庫状態・実売価格・販売先・出品価格が変わらない ---' as section;
select case when status='売却済' and sold_price=18000 and sold_channel='rakuten'
            then 'OK 販売の情報はそのまま' else 'NG' end as r
  from public.inventory_items where id='CHKSH-1';
select case when count(*)=1 then 'OK 楽天の登録価格は 18,000円 のまま' else 'NG' end as r
  from public.inventory_channels
 where item_id='CHKSH-1' and channel='rakuten' and price=18000 and state='出品中';

select '--- 5) 閲覧（viewer）は発送できない ---' as section;
set local "request.jwt.claims" = '{"email":"chk-sh-viewer@example.invalid"}';
do $$ begin
  perform public.inv_item_ship('CHKSH-2', true, null);
  raise notice 'NG viewerが発送できてしまった';
exception when others then
  if sqlerrm like '%権限%' then raise notice 'OK viewerは断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;

select '--- 6) 発送を取り消せるのは管理者だけ ---' as section;
set local "request.jwt.claims" = '{"email":"chk-sh-member@example.invalid"}';
do $$ begin
  perform public.inv_item_ship('CHKSH-1', false, null);
  raise notice 'NG memberが取り消せてしまった';
exception when others then
  if sqlerrm like '%管理者だけ%' then raise notice 'OK memberは断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;
set local "request.jwt.claims" = '{"email":"chk-sh-admin@example.invalid"}';
select case when shipped_at is null and shipped_by is null then 'OK 管理者は取り消せた' else 'NG' end as r
  from (select * from public.inv_item_ship('CHKSH-1', false, '点検（取消）')) x;
select case when count(*)=1 then 'OK 履歴に「発送取消」が残る' else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKSH-1' and action='発送取消';

select '--- 7) まだ売っていないものは発送できない ---' as section;
do $$ begin
  perform public.inv_item_ship('CHKSH-3', true, null);
  raise notice 'NG 在庫のものを発送できてしまった';
exception when others then
  if sqlerrm like '%売却済%' then raise notice 'OK 売却済だけと断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;
select case when status='在庫' and shipped_at is null then 'OK 何も変わっていない' else 'NG' end as r
  from public.inventory_items where id='CHKSH-3';

select '--- 8) 未発送のまま売却取消できる（倉庫メンバーでも） ---' as section;
set local "request.jwt.claims" = '{"email":"chk-sh-member@example.invalid"}';
select case when status='売却済' and shipped_at is null then 'OK 売れた（未発送）' else 'NG' end as r
  from (select * from public.inv_item_sell_channel('CHKSH-2','rakuten',9000::numeric,'点検')) x;
select case when status='在庫' and sold_price is null and shipped_at is null
            then 'OK 在庫へ戻った' else 'NG '||status end as r
  from (select * from public.inv_item_sell_undo('CHKSH-2','点検')) x;

select '--- 9) 発送済みを売却取消できるのは管理者だけ ---' as section;
select case when shipped_at is not null then 'OK 売って発送した' else 'NG' end as r
  from (select * from public.inv_item_ship(
         (select id from (select * from public.inv_item_sell_channel('CHKSH-2','rakuten',9500::numeric,'点検')) y),
         true, '点検')) x;
do $$ begin
  perform public.inv_item_sell_undo('CHKSH-2','点検');
  raise notice 'NG memberが発送済みを戻せてしまった';
exception when others then
  if sqlerrm like '%管理者だけ%' then raise notice 'OK memberは断られた';
  else raise notice 'NG 別の理由: %', sqlerrm; end if;
end $$;
select case when status='売却済' and shipped_at is not null
            then 'OK 戻っていない（売却済・発送済みのまま）' else 'NG '||status end as r
  from public.inventory_items where id='CHKSH-2';
set local "request.jwt.claims" = '{"email":"chk-sh-admin@example.invalid"}';
select case when status='在庫' and shipped_at is null and shipped_by is null
            then 'OK 管理者は戻せて、発送の記録も消える' else 'NG '||status end as r
  from (select * from public.inv_item_sell_undo('CHKSH-2','点検')) x;

select '--- 10) もう一度売っても「発送済み」を持ち越さない ---' as section;
select case when status='売却済' and shipped_at is null
            then 'OK 新しい販売は未発送から始まる' else 'NG' end as r
  from (select * from public.inv_item_sell_channel('CHKSH-2','rakuten',9800::numeric,'点検')) x;
-- CHKSH-2 はここまでに3回売っている（8節で1回、9節で1回、10節で1回）。
-- 取り消しても「売却」の行は消さないので3件並ぶ
select case when count(*)=3 then 'OK 売却の履歴は消さず3件並ぶ（取消しても消さない）'
            else 'NG '||count(*) end as r
  from public.inventory_transactions
 where ref_kind='item' and ref_id='CHKSH-2' and action='売却';

select '--- 11) 未発送の件数（メニューのバッジに出す数）が数えられる ---' as section;
-- いま未発送なのは CHKSH-1（6節で発送を取り消した）と CHKSH-2（10節で売り直した）の2台
select case when count(*)=2 then 'OK 点検ぶんの未発送は2台（'
                 || string_agg(id, '・' order by id) || '）'
            else 'NG '||count(*)||'台：'||coalesce(string_agg(id,'・' order by id),'') end as r
  from public.inventory_items
 where status='売却済' and shipped_at is null and id like 'CHKSH-%';

select '--- 12) 売上・粗利は発送では変わらない ---' as section;
do $$
declare a numeric; b numeric;
begin
  a := (public.inv_dashboard_stats(current_date) ->> 'sales_total')::numeric;
  perform public.inv_item_ship('CHKSH-2', true, '点検');
  b := (public.inv_dashboard_stats(current_date) ->> 'sales_total')::numeric;
  if a = b then raise notice 'OK 発送しても今月売上は同じ（%円）', a;
  else raise notice 'NG % → %', a, b; end if;
end $$;

select '--- 13) 導入前に売れていたものが未発送へ入っていない ---' as section;
-- 導入前の移行ぶん（shipped_by = '導入前移行'）を1台まねて作り、
-- 未発送の数え方（画面のバッジと同じ条件）に入らないことを見る
-- 2回に分ける。1回でやると、トリガー（新しく売ったら発送の記録を持ち越さない）が
-- そのまま shipped_at を消してしまう。**それが正しい動き**なので、
-- ここでは「売ってから、あとで導入前移行として印を付ける」形でまねる
update public.inventory_items
   set status = '売却済', sold_price = 3000, sold_channel = 'rakuten'
 where id = 'CHKSH-4';
select case when shipped_at is null
            then 'OK 新しく売ったものに発送の記録は持ち越されない'
            else 'NG 持ち越されている' end as r
  from public.inventory_items where id = 'CHKSH-4';
update public.inventory_items
   set shipped_at = now(), shipped_by = '導入前移行'
 where id = 'CHKSH-4';
select case when count(*) = 0
            then 'OK 導入前のものは未発送に入らない'
            else 'NG '||count(*)||'台 入っている' end as r
  from public.inventory_items
 where status = '売却済' and shipped_at is null and shipped_by = '導入前移行';
select case when count(*) = 1 then 'OK 導入前のぶんは発送済みとして数える' else 'NG '||count(*) end as r
  from public.inventory_items
 where id like 'CHKSH-%' and status = '売却済' and shipped_by = '導入前移行'
   and shipped_at is not null;

-- **本番のデータそのもの**を見る。導入前の移行が効いていれば、
-- 売却済のほとんどが発送済みになっていて、未発送はこれから出荷するものだけになる
select '本番：売却済 '
       || (select count(*) from public.inventory_items where status = '売却済')
       || '台／うち未発送 '
       || (select count(*) from public.inventory_items
            where status = '売却済' and shipped_at is null)
       || '台／うち導入前として移行 '
       || (select count(*) from public.inventory_items
            where status = '売却済' and shipped_by = '導入前移行')
       || '台' as r;
select case when (select count(*) from public.inventory_items where status = '売却済') = 0
            then 'OK（売却済がまだありません）'
            when (select count(*) from public.inventory_items
                   where status = '売却済' and shipped_at is null)
               = (select count(*) from public.inventory_items where status = '売却済')
            then 'NG 売却済の全部が未発送になっています（導入前の移行が動いていません）'
            else 'OK 売却済の全部が未発送にはなっていません' end as r;
select case when not exists (
              select 1 from public.inventory_transactions t
               join public.inventory_items i on i.id = t.ref_id
               where t.ref_kind = 'item' and t.action = '発送完了'
                 and i.shipped_by = '導入前移行')
            then 'OK 導入前のぶんに「発送完了」の履歴を作っていない' else 'NG' end as r;

rollback;

select '--- 14) 点検データが残っていないこと（rollback の確認） ---' as section;
select case when (select count(*) from public.inventory_items where id like 'CHKSH-%') = 0
             and (select count(*) from public.inventory_products where code='CHKSH') = 0
             and (select count(*) from public.inventory_members
                   where email like 'chk-sh-%@example.invalid') = 0
            then 'OK 点検データは1行も残っていません' else 'NG 残っています' end as r;

select '発送の管理の点検：ここまで NG が無ければ問題なしです' as section;
