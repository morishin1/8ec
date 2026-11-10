-- ============================================================
-- 月別在庫（2026-10-27-month-stock.sql）の点検
--
--   Supabase SQL Editor に**全文を貼って1回実行**してください。
--   最後に出る1つの結果だけで合否が分かります。
--     すべてOK → 総合判定 '✅ 19/19 PASS'
--     1つでもNG → '❌ NGあり（n件）' か、SQLエラー
--
--   ■ 本番データについて
--     点検用のデータはすべて内側の塊の中で作り、最後にまるごと巻き戻します。
--     本番の在庫・売上・履歴・月次確定は1行も変わりません。
--     変えていないことは 18) で確かめています。
--
--   psql 専用の \set / \echo は使っていません（SQL Editor でそのまま動きます）。
-- ============================================================

create temp table if not exists chk_month_v1(seq int primary key, section text, result text);
truncate table chk_month_v1;

do $chk$
declare
  v_res   text[] := '{}';
  v_n     int := 0;
  v_bad   int := 0;
  v_ok    boolean;
  v_detail text;
  v_i     int;
  v_t     int;
  v_info  jsonb;
  v_info2 jsonb;
  v_rev   int;
  v_rev2  int;
  v_sum   int;
  v_locs  int;
  v_before text;
  v_act   text;
  v_json  jsonb;
  -- 本番の「いまの姿」を控えて、最後に変わっていないことを確かめる
  v_items0  bigint; v_tx0 bigint; v_close0 bigint; v_sold0 numeric;
  v_items1  bigint; v_tx1 bigint; v_close1 bigint; v_sold1 numeric;
  CLAIM_A text := '{"email":"chkmonth-admin@example.test"}';
  CLAIM_M text := '{"email":"chkmonth-member@example.test"}';
  -- **いつ実行しても同じ結果になるよう、月は「今から見て何か月前」で決める。**
  --   M2 = 2か月前（前月末ぶん）／M1 = 1か月前（確定する月）／M0 = 当月
  d0  timestamptz;  d1 timestamptz;  d2 timestamptz;
  ym1 text;         ym2 text;
begin
  select count(*), coalesce(sum(coalesce(sold_price,0)),0) into v_items0, v_sold0 from public.inventory_items;
  select count(*) into v_tx0    from public.inventory_transactions;
  select count(*) into v_close0 from public.inventory_month_closes;

  begin   -- ← ここから下で作ったものは、最後にまるごと巻き戻す

    -- ---------- 足場 ----------
    -- 月の初日 00:00 JST。暦の上で引いてから JST とみなす（UTCのまま引くと1日ずれる）
    d0 := (date_trunc('month', now() at time zone 'Asia/Tokyo'))            at time zone 'Asia/Tokyo';
    d1 := (date_trunc('month', now() at time zone 'Asia/Tokyo') - interval '1 month') at time zone 'Asia/Tokyo';
    d2 := (date_trunc('month', now() at time zone 'Asia/Tokyo') - interval '2 months') at time zone 'Asia/Tokyo';
    ym1 := to_char(d1 at time zone 'Asia/Tokyo', 'YYYY-MM');
    ym2 := to_char(d2 at time zone 'Asia/Tokyo', 'YYYY-MM');

    insert into public.inventory_members (email, display_name, role) values
      ('chkmonth-admin@example.test',  '点検管理者', 'admin'),
      ('chkmonth-member@example.test', '点検担当',   'member');

    insert into public.inventory_categories (id, name, kind, code_prefix, sort_no, enabled) values
      ('CHKM-PC', '点検PC', 'individual', 'CHKM', 900, true);

    insert into public.inventory_locations (id, name, parent_id, kind, sort_no, enabled) values
      ('CHKM-K',  '点検柏',   null,      'site', 900, true),
      ('CHKM-K1', '点検倉庫', 'CHKM-K',  'room', 901, true),
      ('CHKM-T',  '点検つくば', null,    'site', 902, true),
      ('CHKM-T1', '点検倉庫', 'CHKM-T',  'room', 903, true);

    insert into public.inventory_products (code, name, model, maker, kind, category_id, location_id, qty)
    values ('CHKM-P1', '点検ノートPC', 'CHK-100', '点検社', 'individual', 'CHKM-PC', 'CHKM-K1', 0),
           ('CHKM-Q1', '点検コピー用紙', 'CHK-A4', '点検社', 'quantity',  'CHKM-PC', 'CHKM-K1', 40);

    -- 個体を作る。**実際の登録と同じ形の履歴**（action='登録'）も一緒に入れる
    for v_i in 1..18 loop
      insert into public.inventory_items
        (id, product_code, name, model, maker, category_id, location_id, status,
         price, purchase_fee, serial, purchased_on, created_at)
      values ('CHKM-' || lpad(v_i::text, 2, '0'), 'CHKM-P1', '点検ノートPC', 'CHK-100', '点検社',
              'CHKM-PC',
              case when v_i = 18 then null else 'CHKM-K1' end,   -- 18番だけ保管場所なし
              '在庫', 30000, 1000, 'SN-' || v_i, date '2026-09-01',
              case when v_i <= 6  then d2 + interval '14 days'   -- 2か月前に入った6台
                   when v_i <= 15 then d1 + interval '4 days'    -- 1か月前に入った9台
                   when v_i = 16  then d0 - interval '1 minute'  -- 1か月前の**最後の1分**
                   when v_i = 17  then d0                        -- 当月の**最初の瞬間**
                   else d1 + interval '2 days' end);             -- 保管場所なしの1台
      insert into public.inventory_transactions
        (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
      values ((select created_at from public.inventory_items where id='CHKM-'||lpad(v_i::text,2,'0')),
              '点検担当', 'item', 'CHKM-' || lpad(v_i::text, 2, '0'), '点検ノートPC',
              '登録', '—', '在庫（点検柏 / 点検倉庫）');
    end loop;

    -- 10/20 に3台を売却（当月出庫3）
    for v_i in 1..3 loop
      update public.inventory_items set status = '売却済', sold_price = 50000
       where id = 'CHKM-' || lpad(v_i::text, 2, '0');
      insert into public.inventory_transactions
        (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
      values (d1 + interval '19 days', '点検担当', 'item',
              'CHKM-' || lpad(v_i::text, 2, '0'), '点検ノートPC', '売却', '在庫', '売却済（rakuten）（50,000円）');
    end loop;

    -- 10/25 に1台を発送（在庫は減らさない。二重減算の確認用）
    update public.inventory_items
       set shipped_at = d1 + interval '24 days', shipped_by = '点検担当'
     where id = 'CHKM-01';
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (d1 + interval '24 days', '点検担当', 'item', 'CHKM-01', '点検ノートPC',
            '発送完了', '未発送', '発送済み');

    -- 10/10 に売却 → 10/28 に売却取消（10月末には在庫に戻っている）
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (d1 + interval '9 days', '点検担当', 'item', 'CHKM-05', '点検ノートPC',
            '売却', '在庫', '売却済（rakuten）（48,000円）'),
           (d1 + interval '27 days', '点検担当', 'item', 'CHKM-05', '点検ノートPC',
            '売却取消', '売却済', '在庫');

    -- 10/15 に1台を 点検柏/点検倉庫 → 点検つくば/点検倉庫 へ移動
    update public.inventory_items set location_id = 'CHKM-T1' where id = 'CHKM-06';
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (d1 + interval '14 days', '点検担当', 'item', 'CHKM-06', '点検ノートPC',
            '移動', '点検柏 / 点検倉庫', '点検つくば / 点検倉庫');

    -- 11/10 に1台を売却（10月の数を動かしてはいけない）
    update public.inventory_items set status = '売却済', sold_price = 52000 where id = 'CHKM-04';
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (now(), '点検担当', 'item', 'CHKM-04', '点検ノートPC',
            '売却', '在庫', '売却済（rakuten）（52,000円）');

    -- 数量品。10月に +10 / -4、11月に -5
    update public.inventory_products set qty = 41 where code = 'CHKM-Q1';
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (d2 + interval '19 days', '点検担当', 'product', 'CHKM-Q1', '点検コピー用紙',
            '登録', '—', '40（点検柏 / 点検倉庫）'),
           (d1 + interval '7 days', '点検担当', 'product', 'CHKM-Q1', '点検コピー用紙',
            '入庫', '40', '50（+10）'),
           (d1 + interval '17 days', '点検担当', 'product', 'CHKM-Q1', '点検コピー用紙',
            '出庫', '50', '46（-4）'),
           (now(), '点検担当', 'product', 'CHKM-Q1', '点検コピー用紙',
            '出庫', '46', '41（-5）');

    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', CLAIM_A, true);

    -- ============================================================
    --  1) 月末 = 前月末 + 当月入庫 − 当月出庫
    -- ============================================================
    -- 9月末：1〜5 の5台（18番は10/03なのでまだ無い）
    select count(*) into v_i from public.inv_month_rows(ym2) where item_id like 'CHKM-%';
    -- 10月末：9月末5 ＋ 入庫（6〜15 の10台、18番、16番）− 出庫（1〜3 の3台）
    select count(*) into v_t from public.inv_month_rows(ym1) where item_id like 'CHKM-%';
    v_ok := (v_i = 6 and v_t = 14);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|1 月末在庫が「前月末＋入庫−出庫」になる|' ||
      case when v_ok then '✅ ' || ym2 || '末 6台 → ' || ym1 || '末 14台（入庫 11・出庫 3）'
           else '❌ ' || ym2 || '末 ' || v_i || '台／' || ym1 || '末 ' || v_t || '台（期待 6／14）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    select coalesce(sum(in_qty),0), coalesce(sum(out_qty),0) into v_i, v_t
      from public.inv_month_by_product(ym1) where kind = '個体管理' and product_code = 'CHKM-P1';
    v_ok := (v_i = 11 and v_t = 3);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|2 当月入庫・当月出庫の数が合う|' ||
      case when v_ok then '✅ 入庫 11台／出庫 3台'
           else '❌ 入庫 ' || v_i || '／出庫 ' || v_t || '（期待 11／3）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    --  3) 月の境界（10/31 23:59 JST と 11/01 00:00 JST）
    -- ============================================================
    select count(*) into v_i from public.inv_month_rows(ym1) where item_id = 'CHKM-16';
    select count(*) into v_t from public.inv_month_rows(ym1) where item_id = 'CHKM-17';
    v_ok := (v_i = 1 and v_t = 0);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|3 月の最後の1分は当月に入る|' ||
      case when v_ok then '✅ ' || ym1 || ' の最後の1分の1台は入り、翌月00:00の1台は入らない'
           else '❌ 月末最後の1分 ' || v_i || '／翌月00:00 ' || v_t || '（期待 1／0）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    select count(*) into v_i from public.inv_month_rows(public.inv_month_now()) where item_id = 'CHKM-17';
    v_ok := (v_i = 1);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|4 翌月00:00 のものは翌月に入る|' ||
      case when v_ok then '✅ 当月に入った' else '❌ 当月にも入っていない' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    --  5) 売却と発送で二重に減らさない
    -- ============================================================
    -- CHKM-01 は 10/20 売却・10/25 発送。10月末には「出ていった1台」として1回だけ数える
    select count(*) into v_i from public.inv_month_rows(ym1) where item_id = 'CHKM-01';
    select count(*) into v_t from public.inv_month_rows(ym2) where item_id = 'CHKM-01';
    v_ok := (v_i = 0 and v_t = 1);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|5 売却した1台は1回だけ減る（発送では減らない）|' ||
      case when v_ok then '✅ ' || ym2 || '末はあり、' || ym1 || '末は無し（出庫は1回だけ）'
           else '❌ ' || ym1 || '末 ' || v_i || '／' || ym2 || '末 ' || v_t || '（期待 0／1）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- 発送の履歴が逆再生の対象に入っていないこと（入っていると状態が壊れる）
    v_ok := not ('発送完了' = any (public.inv_month_rewind_actions()))
        and not ('発送取消' = any (public.inv_month_rewind_actions()))
        and not ('棚卸確認' = any (public.inv_month_rewind_actions()))
        and not ('編集'     = any (public.inv_month_rewind_actions()));
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|6 状態を変えない履歴は逆再生に使わない|' ||
      case when v_ok then '✅ 発送完了・発送取消・棚卸確認・編集 は対象外'
           else '❌ 状態を変えない履歴が逆再生の対象に入っています' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    --  7) 売却取消が正しい月・状態に戻る
    -- ============================================================
    select status into v_before from public.inv_month_rows(ym1) where item_id = 'CHKM-05';
    select count(*) into v_i from public.inv_month_rows(ym1) where item_id = 'CHKM-05';
    v_ok := (v_i = 1 and v_before = '在庫');
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|7 売却取消は正しい月・状態に戻る|' ||
      case when v_ok then '✅ 月中に売却→同じ月に取消した1台は、月末に「在庫」で数える'
           else '❌ ' || ym1 || '末 ' || v_i || '件／状態 ' || coalesce(v_before,'なし') || '（期待 1件／在庫）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    --  8) 保管場所の移動では全社在庫が動かない
    -- ============================================================
    select coalesce(sum(moved_in),0), coalesce(sum(in_qty),0) - coalesce(sum(out_qty),0)
      into v_i, v_t
      from public.inv_month_by_location(ym1)
     where location_id in ('CHKM-K1', 'CHKM-T1');
    select location_id into v_before from public.inv_month_rows(ym1) where item_id = 'CHKM-06';
    v_ok := (v_i = 1 and v_before = 'CHKM-T1');
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|8 倉庫間の移動は場所別にだけ出る|' ||
      case when v_ok then '✅ 移動1台が場所別に出て、移動先は点検つくばになっている'
           else '❌ 移動 ' || v_i || '件／移動先 ' || coalesce(v_before,'なし') || '（期待 1／CHKM-T1）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- 9月末は移動前の場所にいること（いまの場所をそのまま出していない）
    select location_id into v_before from public.inv_month_rows(ym2) where item_id = 'CHKM-06';
    v_ok := (v_before = 'CHKM-K1');
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|9 過去月は当時の保管場所を出す（いまの場所ではない）|' ||
      case when v_ok then '✅ ' || ym2 || '末は移動前の 点検柏 / 点検倉庫'
           else '❌ ' || ym2 || '末の場所が ' || coalesce(v_before,'なし') || '（期待 CHKM-K1）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 10) 商品別・個体別・保管場所別の合計が一致する
    -- ============================================================
    select count(*) into v_i    from public.inv_month_rows(ym1) where item_id like 'CHKM-%';
    select coalesce(sum(end_qty),0) into v_t
      from public.inv_month_by_product(ym1) where kind = '個体管理' and product_code = 'CHKM-P1';
    select coalesce(sum(end_qty),0) into v_locs
      from public.inv_month_by_location(ym1)
     where location_id in ('CHKM-K1','CHKM-T1') or location_id is null;
    v_ok := (v_i = v_t and v_i = v_locs);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|10 個体別・商品別・保管場所別の合計が一致する|' ||
      case when v_ok then '✅ どれも ' || v_i || '台'
           else '❌ 個体別 ' || v_i || '／商品別 ' || v_t || '／場所別 ' || v_locs end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 11) 保管場所未登録・管理番号重複が隠れない
    -- ============================================================
    select coalesce(sum(end_qty),0) into v_i
      from public.inv_month_by_location(ym1) where location_id is null;
    v_info := public.inv_month_info(ym1);
    v_ok := (v_i >= 1 and (v_info -> 'quality' ->> 'no_location')::int >= 1);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|11 保管場所が入っていない在庫を「未登録」で出す|' ||
      case when v_ok then '✅ 場所別に未登録 ' || v_i || '台が出て、点検にも ' ||
                           (v_info -> 'quality' ->> 'no_location') || '件として出る'
           else '❌ 未登録が隠れています（場所別 ' || v_i || '／点検 ' ||
                coalesce(v_info -> 'quality' ->> 'no_location','なし') || '）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 12) 数量管理品の月末数量
    -- ============================================================
    -- 9月末 40 ／ 10月 +10 −4 → 10月末 46 ／ 11月 −5 → 11月末 41
    select qty into v_i from public.inv_month_product_rows(ym2) where product_code = 'CHKM-Q1';
    select qty into v_t from public.inv_month_product_rows(ym1) where product_code = 'CHKM-Q1';
    select coalesce(sum(prev_qty),0), coalesce(sum(in_qty),0) - coalesce(sum(out_qty),0)
      into v_locs, v_sum
      from public.inv_month_by_product(ym1) where kind = '数量管理' and product_code = 'CHKM-Q1';
    v_ok := (v_i = 40 and v_t = 46 and v_locs = 40 and v_sum = 6);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|12 数量管理品も月末の数量が出る|' ||
      case when v_ok then '✅ ' || ym2 || '末 40 → ' || ym1 || '末 46（入庫10・出庫4）'
           else '❌ ' || ym2 || '末 ' || coalesce(v_i::text,'なし') || '／' || ym1 || '末 ' || coalesce(v_t::text,'なし') ||
                '／前月末 ' || v_locs || '／純増 ' || v_sum || '（期待 40／46／40／6）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 13) 月次確定：確定したら後の販売で動かない
    -- ============================================================
    v_json := public.inv_month_close(ym1, '点検');
    v_rev  := (v_json ->> 'revision')::int;
    select count(*) into v_i from public.inventory_month_items
     where ym = ym1 and revision = v_rev and item_id like 'CHKM-%';
    -- 確定後に「11月に売れた」ことにしてみる（本当の運用で起きること）
    update public.inventory_items set status = '売却済' where id = 'CHKM-07';
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (now(), '点検担当', 'item', 'CHKM-07', '点検ノートPC', '売却', '在庫', '売却済');
    select count(*) into v_t from public.inv_month_rows(ym1) where item_id like 'CHKM-%';
    v_ok := (v_i = 14 and v_t = 14);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|13 確定した月は、あとから売れても動かない|' ||
      case when v_ok then '✅ 確定時 14台、あとから1台売れても 14台のまま'
           else '❌ 確定時 ' || v_i || '台／いま ' || v_t || '台（どちらも14のはず）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 14) 確定の連打で版も明細も増えない（冪等）
    -- ============================================================
    v_json  := public.inv_month_close(ym1, 'もう一度');
    v_json  := public.inv_month_close(ym1);
    select count(*) into v_i from public.inventory_month_closes where ym = ym1;
    select count(*) into v_t from public.inventory_month_items where ym = ym1;
    v_ok := (v_i = 1 and v_t = (select count(*) from public.inventory_month_items
                                 where ym = ym1 and revision = 1));
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|14 同じ月の確定を連打しても増えない|' ||
      case when v_ok then '✅ 版は1つのまま、明細も重なっていない'
           else '❌ 版 ' || v_i || '件／明細 ' || v_t || '件（版は1のはず）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 15) 訂正すると版が上がり、前の版も理由も残る
    -- ============================================================
    v_json := public.inv_month_close(ym1, null, '数え直したため');
    v_rev2 := (v_json ->> 'revision')::int;
    select count(*) into v_i from public.inventory_month_closes where ym = ym1;
    select count(*) into v_t from public.inventory_transactions
     where ref_kind = 'month' and ref_id = ym1 and action = '月次訂正'
       and after_value like '%数え直したため%';
    v_ok := (v_rev2 = 2 and v_i = 2 and v_t = 1
             and exists (select 1 from public.inventory_month_closes
                          where ym = ym1 and revision = 1));
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|15 訂正で版が上がり、前の版と理由が残る|' ||
      case when v_ok then '✅ 2版になり、1版も履歴（理由つき）も残っている'
           else '❌ 新しい版 ' || coalesce(v_rev2::text,'なし') || '／版の数 ' || v_i ||
                '／訂正の履歴 ' || v_t || '（期待 2／2／1）' end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 16) 履歴がそろわない月は確定させない
    -- ============================================================
    -- レンタルの履歴（前の状態を残していない）を9月に差し込む
    insert into public.inventory_transactions
      (occurred_at, actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (d1 + interval '25 days', '点検担当', 'item', 'CHKM-02', '点検ノートPC',
            'レンタル貸出中', '申込', '貸出中');
    v_info2 := public.inv_month_info(ym2);
    v_ok := ((v_info2 -> 'quality' ->> 'unrestorable')::int >= 1
             and (v_info2 -> 'quality' ->> 'can_confirm')::boolean = false);
    if v_ok then
      begin
        v_json := public.inv_month_close(ym2, '通ってはいけない');
        v_ok := false; v_detail := '履歴がそろっていないのに確定できてしまいました';
      exception when others then
        v_ok := (sqlerrm like '%履歴がそろっていない%');
        v_detail := sqlerrm;
      end;
    else
      v_detail := '復元不可として数えられていません';
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|16 履歴がそろわない月は確定させない|' ||
      case when v_ok then '✅ 復元不可として数え、確定も断った' else '❌ ' || v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 17) 権限：member は確定も訂正もできない
    -- ============================================================
    perform set_config('request.jwt.claims', CLAIM_M, true);
    begin
      v_json := public.inv_month_close(ym1, 'メンバーが押した');
      v_ok := false; v_detail := 'member が確定できてしまいました';
    exception when others then
      v_ok := (sqlerrm like '%管理者だけ%');
      v_detail := sqlerrm;
    end;
    if v_ok then
      -- 読むほうは member でもできる（画面に出す必要がある）
      select count(*) into v_i from public.inv_month_rows(ym1) where item_id like 'CHKM-%';
      v_ok := (v_i = 14);
      v_detail := 'member が読めた件数 ' || v_i;
    end if;
    perform set_config('request.jwt.claims', CLAIM_A, true);
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|17 確定は管理者だけ、閲覧は member も可|' ||
      case when v_ok then '✅ member の確定は断られ、月末在庫は読めた'
           else '❌ ' || coalesce(v_detail,'') end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- 当月・未来月は確定させない
    begin
      v_json := public.inv_month_close(public.inv_month_now(), null);
      v_ok := false; v_detail := '当月を確定できてしまいました';
    exception when others then
      v_ok := (sqlerrm like '%まだ終わっていない月%'); v_detail := sqlerrm;
    end;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|18 当月・未来月は確定させない|' ||
      case when v_ok then '✅ 当月の確定は断られた' else '❌ ' || v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    -- ============================================================
    -- 19) 月の境目の計算そのもの（実行する月に左右されない）
    --
    --     timestamptz のまま + interval '1 month' をすると、
    --     2026-10-01 00:00 JST（＝UTCでは9月30日15:00）に1か月足して
    --     10月30日15:00 ＝ 10月31日00:00 JST になり、月末の1日が落ちる。
    --     前の月が30日・当月が31日のときだけ出るので、**実行した月によっては
    --     足場の検査では見つからない。** ここで暦そのものを直接確かめる。
    -- ============================================================
    v_detail := '';
    v_ok := true;
    -- 1年ぶん、どの月でも「その月の月末 ＝ 翌月の月初」になること
    for v_i in 1..12 loop
      declare
        v_ym   text := '2026-' || lpad(v_i::text, 2, '0');
        v_next text := to_char(
          (to_date('2026-' || lpad(v_i::text, 2, '0') || '-01', 'YYYY-MM-DD') + interval '1 month'),
          'YYYY-MM');
      begin
        if public.inv_month_end_at(v_ym) <> public.inv_month_start_at(v_next) then
          v_ok := false;
          v_detail := v_detail || v_ym || '末=' ||
            to_char(public.inv_month_end_at(v_ym) at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') || ' ';
        end if;
        if public.inv_month_prev(v_next) <> v_ym then
          v_ok := false;
          v_detail := v_detail || '前月(' || v_next || ')=' || public.inv_month_prev(v_next) || ' ';
        end if;
      end;
    end loop;
    -- 年またぎ・閏年も
    if public.inv_month_end_at('2026-12') <> '2027-01-01 00:00+09'::timestamptz then
      v_ok := false; v_detail := v_detail || '年またぎ ';
    end if;
    if public.inv_month_end_at('2024-02') <> '2024-03-01 00:00+09'::timestamptz then
      v_ok := false; v_detail := v_detail || '閏年2月 ';
    end if;
    if public.inv_month_end_at('2026-10') <> '2026-11-01 00:00+09'::timestamptz then
      v_ok := false; v_detail := v_detail || '2026-10 ';
    end if;
    v_n := v_n + 1;
    v_res := v_res || (v_n::text || '|19 月末の瞬間は必ず「翌月1日 00:00 JST」|' ||
      case when v_ok then '✅ 12か月ぶん・年またぎ・閏年2月まで、暦どおり'
           else '❌ ずれています：' || v_detail end);
    if not v_ok then v_bad := v_bad + 1; end if;

    perform set_config('role', 'postgres', true);
    raise exception '__CHK_ROLLBACK__';

  exception when others then
    if sqlerrm <> '__CHK_ROLLBACK__' then
      v_n := v_n + 1;
      v_res := v_res || (v_n::text || '|途中で止まりました|❌ ' || sqlerrm);
      v_bad := v_bad + 1;
    end if;
    begin execute 'reset role'; exception when others then null; end;
  end;

  -- ---------- 巻き戻したあとで、本番が変わっていないことを確かめる ----------
  select count(*), coalesce(sum(coalesce(sold_price,0)),0) into v_items1, v_sold1 from public.inventory_items;
  select count(*) into v_tx1    from public.inventory_transactions;
  select count(*) into v_close1 from public.inventory_month_closes;
  v_ok := (v_items0 = v_items1 and v_tx0 = v_tx1 and v_close0 = v_close1 and v_sold0 = v_sold1);
  if not v_ok then v_bad := v_bad + 1; end if;

  insert into chk_month_v1(seq, section, result)
    select (split_part(x, '|', 1))::int, split_part(x, '|', 2), split_part(x, '|', 3)
      from unnest(v_res) as x;

  insert into chk_month_v1 values (90, '点検データが残っていないこと',
    case when v_ok then '✅ 在庫 ' || v_items1 || '件・履歴 ' || v_tx1 || '件・月次確定 ' || v_close1 ||
                        '件とも、はじめと同じ（売上の合計も同じ）'
         else '❌ 本番のデータが変わっています（在庫 ' || v_items0 || '→' || v_items1 ||
              '／履歴 ' || v_tx0 || '→' || v_tx1 || '／月次確定 ' || v_close0 || '→' || v_close1 || '）' end);

  insert into chk_month_v1 values (99, '総合判定',
    case when v_bad = 0 and v_n = 19 then '✅ 19/19 PASS'
         when v_bad > 0 then '❌ NGあり（' || v_bad || '件／' || v_n || '項目を判定）'
         else '❌ 判定できたのは ' || v_n || '項目だけです（19項目に足りません）' end);
end $chk$;

select section, result
  from (select seq, section, result from chk_month_v1
        union all
        select 0, '総合判定', '❌ 点検が走っていません（上のエラーを確認してください）'
         where not exists (select 1 from chk_month_v1)) z
 order by seq;
