-- ============================================================
-- 発送の管理の点検（2026-10-19）
--
--   Supabase の SQL Editor に**全文を貼って1回実行**してください。
--   SQL Editor は**最後のSELECTの結果だけ**を出すので、14節の判定を
--   ぜんぶ1つの表にまとめて最後に出します。合否はその表だけで分かります。
--
--       section               | result
--       1 売却直後は未発送     | ✅
--       …                     | …
--       14 点検データrollback  | ✅
--       総合判定              | ✅ 14/14 PASS
--
--   **1つでもNGなら総合判定は ❌** になります（14項目そろって全部OKの
--   ときだけ PASS）。NGの行には理由も出ます。
--
--   psql のメタコマンド（\set / \pset / \echo）は使っていません。
--   NOTICE も使いません（SQL Editor では見えないため）。
--
--   **本番のデータは1行も変わりません。**
--   点検用の商品・個体・履歴は DO ブロックの中の副トランザクション
--   （begin … exception）で作り、最後に必ず巻き戻します。
--   判定は plpgsql の変数に持つので、巻き戻しても消えません。
--   在庫数・売上・出品価格も動きません。
--
--   結果をためる chk_ship_v1 は**一時テーブル**（セッション内だけ。
--   接続が切れると消えます）。本番の表は作りません。
--
--   auth スキーマには触りません。「誰としてログインしているか」は、
--   Supabase 標準の auth.jwt() が読んでいる request.jwt.claims を
--   この点検の中だけ差し替えて切り替えます。
-- ============================================================

create temp table if not exists chk_ship_v1(
  seq     int primary key,
  section text,
  result  text);
truncate table chk_ship_v1;

do $chk$
declare
  v_res    text[] := '{}';       -- 'seq|節の名前|判定'
  v_n      int := 0;             -- 判定した節の数
  v_bad    int := 0;             -- NGの数
  v_ok     boolean;
  v_detail text;
  v_cat    text;
  v_loc    text;
  it       public.inventory_items;
  v_at     timestamptz;
  v_cnt    int;
  v_a      numeric;
  v_b      numeric;
  v_info   text;
  CLAIM_M  text := '{"email":"chk-sh-member@example.invalid"}';
  CLAIM_V  text := '{"email":"chk-sh-viewer@example.invalid"}';
  CLAIM_A  text := '{"email":"chk-sh-admin@example.invalid"}';
begin
  -- ここから下（begin … exception）は**最後にまるごと巻き戻す**。
  -- 判定は変数 v_res に入れるので、巻き戻しても残る。
  begin
    select id into v_cat from public.inventory_categories order by id limit 1;
    select id into v_loc from public.inventory_locations   order by id limit 1;

    insert into public.inventory_members(email, display_name, role) values
      ('chk-sh-admin@example.invalid','点検管理者','admin'),
      ('chk-sh-member@example.invalid','点検メンバー','member'),
      ('chk-sh-viewer@example.invalid','点検閲覧','viewer');

    insert into public.inventory_products(code,name,maker,model,kind,category_id,location_id)
      values ('CHKSH','点検用プリンター','EPSON','PX-CHK','individual', v_cat, v_loc);

    insert into public.inventory_items(id,product_code,name,maker,model,
                                       category_id,location_id,status,price,purchase_fee)
      select 'CHKSH-'||g,'CHKSH','点検用プリンター','EPSON','PX-CHK',
             v_cat, v_loc, '在庫', 12000, 0
        from generate_series(1,4) g;

    -- 出品価格（これが発送で変わらないことを見る）
    insert into public.inventory_channels(item_id, product_code, channel, state, price)
      values ('CHKSH-1','CHKSH','rakuten','出品中',18000);

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', CLAIM_M, true);

    -- ---- 1) 売ったばかりの個体は「未発送」 ----
    select * into it from public.inv_item_sell_channel('CHKSH-1','rakuten',18000::numeric,'点検');
    v_ok := (it.status = '売却済' and it.sold_price = 18000
             and it.shipped_at is null and it.shipped_by is null);
    v_detail := '状態 '||it.status||'／shipped_at '||coalesce(it.shipped_at::text,'null');
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|1 売却直後は未発送|'
             || case when v_ok then '✅ 売却済・未発送' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 2) 倉庫メンバーが発送できる。日時と担当者と履歴が残る ----
    select * into it from public.inv_item_ship('CHKSH-1', true, '点検');
    v_ok := (it.shipped_at is not null and it.shipped_by = '点検メンバー');
    v_detail := '担当 '||coalesce(it.shipped_by,'null');
    select count(*) into v_cnt from public.inventory_transactions
     where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了';
    if v_cnt <> 1 then
      v_ok := false; v_detail := '履歴「発送完了」が '||v_cnt||'件';
    else
      if not exists (select 1 from public.inventory_transactions
                      where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了'
                        and actor='点検メンバー' and before_value='未発送'
                        and after_value like '発送済み%') then
        v_ok := false; v_detail := '履歴の中身（誰がいつ何を）が合わない';
      end if;
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|2 発送日時・担当者・履歴|'
             || case when v_ok then '✅ 発送済み（点検メンバー）＋履歴1件' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 3) 二重に押しても壊れない（履歴も増えない） ----
    select shipped_at into v_at from public.inventory_items where id='CHKSH-1';
    perform public.inv_item_ship('CHKSH-1', true, null);
    perform public.inv_item_ship('CHKSH-1', true, null);
    select count(*) into v_cnt from public.inventory_transactions
     where ref_kind='item' and ref_id='CHKSH-1' and action='発送完了';
    v_ok := (v_cnt = 1
             and (select shipped_at from public.inventory_items where id='CHKSH-1') = v_at);
    v_detail := '履歴 '||v_cnt||'件';
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|3 二重押し防止|'
             || case when v_ok then '✅ 2回押しても1件・日時も不変' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 4) 発送では在庫状態・実売価格・販売先・出品価格が変わらない ----
    select * into it from public.inventory_items where id='CHKSH-1';
    v_ok := (it.status='売却済' and it.sold_price=18000 and it.sold_channel='rakuten');
    v_detail := '販売情報が変わった（'||it.status||'／'||coalesce(it.sold_price::text,'null')||'）';
    if v_ok and not exists (select 1 from public.inventory_channels
                             where item_id='CHKSH-1' and channel='rakuten'
                               and price=18000 and state='出品中') then
      v_ok := false; v_detail := '楽天の登録価格（出品価格マスタ）が変わった';
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|4 発送で販売情報・出品価格を変えない|'
             || case when v_ok then '✅ どれも変わらない' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 5) 閲覧（viewer）は発送できない ----
    perform set_config('request.jwt.claims', CLAIM_V, true);
    v_ok := false; v_detail := 'viewerが発送できてしまった';
    begin
      perform public.inv_item_ship('CHKSH-2', true, null);
    exception when others then
      if sqlerrm like '%権限%' then v_ok := true;
      else v_detail := '別の理由: '||sqlerrm; end if;
    end;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|5 viewerは発送できない|'
             || case when v_ok then '✅ 断られた' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 6) 発送を取り消せるのは管理者だけ ----
    perform set_config('request.jwt.claims', CLAIM_M, true);
    v_ok := false; v_detail := 'memberが取り消せてしまった';
    begin
      perform public.inv_item_ship('CHKSH-1', false, null);
    exception when others then
      if sqlerrm like '%管理者だけ%' then v_ok := true;
      else v_detail := '別の理由: '||sqlerrm; end if;
    end;
    perform set_config('request.jwt.claims', CLAIM_A, true);
    if v_ok then
      select * into it from public.inv_item_ship('CHKSH-1', false, '点検（取消）');
      if it.shipped_at is not null or it.shipped_by is not null then
        v_ok := false; v_detail := '管理者でも取り消せなかった';
      else
        select count(*) into v_cnt from public.inventory_transactions
         where ref_kind='item' and ref_id='CHKSH-1' and action='発送取消';
        if v_cnt <> 1 then v_ok := false; v_detail := '履歴「発送取消」が '||v_cnt||'件'; end if;
      end if;
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|6 発送取消は管理者だけ|'
             || case when v_ok then '✅ memberは不可・管理者は可＋履歴1件' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 7) まだ売っていないものは発送できない ----
    v_ok := false; v_detail := '在庫のものを発送できてしまった';
    begin
      perform public.inv_item_ship('CHKSH-3', true, null);
    exception when others then
      if sqlerrm like '%売却済%' then v_ok := true;
      else v_detail := '別の理由: '||sqlerrm; end if;
    end;
    if v_ok then
      select * into it from public.inventory_items where id='CHKSH-3';
      if it.status <> '在庫' or it.shipped_at is not null then
        v_ok := false; v_detail := '状態が変わってしまった（'||it.status||'）';
      end if;
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|7 売却済だけ発送できる|'
             || case when v_ok then '✅ 断られ、何も変わらない' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 8) 未発送のまま売却取消できる（倉庫メンバーでも） ----
    perform set_config('request.jwt.claims', CLAIM_M, true);
    select * into it from public.inv_item_sell_channel('CHKSH-2','rakuten',9000::numeric,'点検');
    v_ok := (it.status='売却済' and it.shipped_at is null);
    v_detail := '売れていない（'||it.status||'）';
    if v_ok then
      select * into it from public.inv_item_sell_undo('CHKSH-2','点検');
      if it.status <> '在庫' or it.sold_price is not null or it.shipped_at is not null then
        v_ok := false; v_detail := '在庫へ戻らなかった（'||it.status||'）';
      end if;
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|8 未発送なら売却取消できる|'
             || case when v_ok then '✅ 在庫へ戻った' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 9) 発送済みを売却取消できるのは管理者だけ ----
    select * into it from public.inv_item_sell_channel('CHKSH-2','rakuten',9500::numeric,'点検');
    select * into it from public.inv_item_ship('CHKSH-2', true, '点検');
    v_ok := (it.shipped_at is not null);
    v_detail := '売って発送できなかった';
    if v_ok then
      v_ok := false; v_detail := 'memberが発送済みを戻せてしまった';
      begin
        perform public.inv_item_sell_undo('CHKSH-2','点検');
      exception when others then
        if sqlerrm like '%管理者だけ%' then v_ok := true;
        else v_detail := '別の理由: '||sqlerrm; end if;
      end;
    end if;
    if v_ok then
      select * into it from public.inventory_items where id='CHKSH-2';
      if it.status <> '売却済' or it.shipped_at is null then
        v_ok := false; v_detail := '戻ってしまった（'||it.status||'）';
      end if;
    end if;
    if v_ok then
      perform set_config('request.jwt.claims', CLAIM_A, true);
      select * into it from public.inv_item_sell_undo('CHKSH-2','点検');
      if it.status <> '在庫' or it.shipped_at is not null or it.shipped_by is not null then
        v_ok := false; v_detail := '管理者でも戻せなかった（'||it.status||'）';
      end if;
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|9 発送済みの売却取消は管理者だけ|'
             || case when v_ok then '✅ memberは不可・管理者は可（発送の記録も消える）'
                     else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 10) もう一度売っても「発送済み」を持ち越さない ----
    select * into it from public.inv_item_sell_channel('CHKSH-2','rakuten',9800::numeric,'点検');
    v_ok := (it.status='売却済' and it.shipped_at is null);
    v_detail := '発送済みが持ち越された';
    -- CHKSH-2 はここまでに3回売っている（8節で1回、9節で1回、10節で1回）。
    -- 取り消しても「売却」の行は消さないので3件並ぶ
    select count(*) into v_cnt from public.inventory_transactions
     where ref_kind='item' and ref_id='CHKSH-2' and action='売却';
    if v_ok and v_cnt <> 3 then
      v_ok := false; v_detail := '売却の履歴が '||v_cnt||'件（3件のはず）';
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|10 売り直しは未発送から・売却履歴は消さない|'
             || case when v_ok then '✅ 未発送から始まり、売却履歴は3件' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 11) 未発送の件数（メニューのバッジに出す数）が数えられる ----
    -- いま未発送なのは CHKSH-1（6節で発送を取り消した）と CHKSH-2（10節で売り直した）の2台
    select count(*) into v_cnt from public.inventory_items
     where status='売却済' and shipped_at is null and id like 'CHKSH-%';
    v_ok := (v_cnt = 2);
    v_detail := v_cnt||'台（2台のはず）';
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|11 未発送の件数を数えられる|'
             || case when v_ok then '✅ 点検ぶんの未発送は2台' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 12) 売上・粗利は発送では変わらない ----
    v_a := (public.inv_dashboard_stats(current_date) ->> 'sales_total')::numeric;
    perform public.inv_item_ship('CHKSH-2', true, '点検');
    v_b := (public.inv_dashboard_stats(current_date) ->> 'sales_total')::numeric;
    v_ok := (v_a = v_b);
    v_detail := v_a||' → '||v_b;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|12 売上・粗利は発送で変わらない|'
             || case when v_ok then '✅ 同じ（'||v_a||'円）' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ---- 13) 導入前に売れていたものが未発送へ入っていない ----
    -- 導入前の移行ぶん（shipped_by = '導入前移行'）を1台まねて作り、
    -- 未発送の数え方（画面のバッジと同じ条件）に入らないことを見る。
    -- 2回に分ける。1回でやると、トリガー（新しく売ったら発送の記録を持ち越さない）が
    -- そのまま shipped_at を消してしまう。**それが正しい動き**なので、
    -- ここでは「売ってから、あとで導入前移行として印を付ける」形でまねる
    update public.inventory_items
       set status = '売却済', sold_price = 3000, sold_channel = 'rakuten'
     where id = 'CHKSH-4';
    select * into it from public.inventory_items where id='CHKSH-4';
    v_ok := (it.shipped_at is null);
    v_detail := '新しく売ったものに発送の記録が持ち越された';
    update public.inventory_items
       set shipped_at = now(), shipped_by = '導入前移行'
     where id = 'CHKSH-4';
    if v_ok then
      select count(*) into v_cnt from public.inventory_items
       where status='売却済' and shipped_at is null and shipped_by = '導入前移行';
      if v_cnt <> 0 then
        v_ok := false; v_detail := '導入前のものが未発送に '||v_cnt||'台 入っている';
      end if;
    end if;
    if v_ok then
      select count(*) into v_cnt from public.inventory_items
       where id like 'CHKSH-%' and status='売却済' and shipped_by='導入前移行'
         and shipped_at is not null;
      if v_cnt <> 1 then
        v_ok := false; v_detail := '導入前のぶんを発送済みとして数えていない（'||v_cnt||'台）';
      end if;
    end if;
    -- **本番のデータそのもの**も見る。導入前の移行が効いていれば、
    -- 売却済のほとんどが発送済みになっていて、未発送はこれから出荷するものだけになる
    if v_ok then
      select count(*) into v_cnt from public.inventory_items where status='売却済';
      if v_cnt > 0
         and v_cnt = (select count(*) from public.inventory_items
                       where status='売却済' and shipped_at is null) then
        v_ok := false;
        v_detail := '本番の売却済 '||v_cnt||'台の全部が未発送（導入前の移行が動いていません）';
      end if;
    end if;
    if v_ok and exists (
         select 1 from public.inventory_transactions t
          join public.inventory_items i on i.id = t.ref_id
          where t.ref_kind='item' and t.action='発送完了' and i.shipped_by='導入前移行') then
      v_ok := false; v_detail := '導入前のぶんに「発送完了」の履歴がある';
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text||'|13 導入前の販売は未発送に入らない|'
             || case when v_ok then '✅ 未発送に入らず、履歴も作らない' else '❌ '||v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- 参考（判定ではなく、本番の件数をそのまま出す）
    v_info := '売却済 '
      || (select count(*) from public.inventory_items where status='売却済')
      || '台／うち未発送 '
      || (select count(*) from public.inventory_items
           where status='売却済' and shipped_at is null)
      || '台／うち導入前として移行 '
      || (select count(*) from public.inventory_items
           where status='売却済' and shipped_by='導入前移行')
      || '台（点検用の4台を含みます）';

    -- ここまでの変更を**まるごと巻き戻す**ために、わざと例外を投げる。
    -- 判定（v_res）は変数なので巻き戻っても残る。
    raise exception '__CHK_ROLLBACK__';

  exception when others then
    if sqlerrm <> '__CHK_ROLLBACK__' then
      -- 途中で思わぬエラーが出たとき。ここまでの判定は残したうえで NG を足す
      v_n := v_n + 1;
      v_res := v_res || (v_n::text||'|途中で止まりました|❌ '||sqlerrm);
      v_bad := v_bad + 1;
    end if;
    -- 点検用に切り替えたロールを元へ戻す
    begin execute 'reset role'; exception when others then null; end;
  end;

  -- ---- 14) 点検データが残っていないこと（巻き戻しの確認） ----
  select count(*) into v_cnt from public.inventory_items where id like 'CHKSH-%';
  v_ok := (v_cnt = 0
           and not exists (select 1 from public.inventory_products where code='CHKSH')
           and not exists (select 1 from public.inventory_members
                            where email like 'chk-sh-%@example.invalid'));
  v_detail := '点検データが残っている（個体 '||v_cnt||'台）';
  v_n := v_n + 1;
  v_res := v_res || (v_n::text||'|14 点検データrollback|'
           || case when v_ok then '✅ 1行も残っていない' else '❌ '||v_detail end);
  if not v_ok then v_bad := v_bad + 1; end if;

  -- ---- 結果を一時テーブルへ ----
  insert into chk_ship_v1(seq, section, result)
  select (split_part(x, '|', 1))::int, split_part(x, '|', 2), split_part(x, '|', 3)
    from unnest(v_res) as x;

  if v_info is not null then
    insert into chk_ship_v1(seq, section, result) values (90, '参考（本番の件数）', v_info);
  end if;

  -- **14項目そろって全部OKのときだけ PASS。** 足りなければ PASS にしない
  insert into chk_ship_v1(seq, section, result) values (99, '総合判定',
    case when v_bad = 0 and v_n = 14 then '✅ 14/14 PASS'
         when v_bad > 0 then '❌ NGあり（'||v_bad||'件／'||v_n||'項目を判定）'
         else '❌ 判定できたのは '||v_n||'項目だけです（14項目に足りません）' end);
end $chk$;

-- ============================================================
-- ここが最後のSELECT。SQL Editor にはこの表だけが出ます。
-- 「総合判定」が ✅ 14/14 PASS なら問題なしです。
-- ============================================================
select section, result
  from (select seq, section, result from chk_ship_v1
        union all
        select 0, '総合判定', '❌ 点検が走っていません（上のエラーを確認してください）'
         where not exists (select 1 from chk_ship_v1)) z
 order by seq;
