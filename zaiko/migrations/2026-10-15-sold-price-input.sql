-- ============================================================
-- QR販売で「実売価格」を入力できるようにする
--   2026-10-15
--
--   現場の運用に合わせて、倉庫メンバー（member）も **今回いくらで売ったか** を
--   入力・修正できるようにする。
--
--     QRで個体を開く → ［販売済みにする］ → 販売先を選ぶ
--       → DBに登録価格があれば、それを入力欄の初期値に出す
--       → admin / member がその金額を直せる
--       → ［販売済みにする］ → 入力した金額を inventory_items.sold_price へ
--
--   **出品価格・販売予定価格のマスタは変えない。**
--     inventory_channels.price          … 変えない
--     inventory_channel_listings.price  … 変えない
--     inventory_items.plan_price        … 変えない
--   変わるのは「今回の販売実績」＝ sold_price / sold_channel だけ。
--
--   「価格の確認」(66) とは役割が違う。混ぜない。
--     価格の確認   … **出品価格**を管理者が確認するまで「出品中」にできない
--     実売価格     … **今回いくらで売れたか**。現場が入力する
--   どちらも触るのは別の列で、互いの判定を見ない。
--
--   このmigrationでやること
--     1) inv_item_sell_channel() の「実売価格を受け取る」4引数の形を**足す**
--     2) 権限
--     3) 自己点検
--
--   ■ 本番を止めずに切り替えるため、3引数の形は**ここでは消さない**
--     いまの本番コードは3引数を呼んでいる。先に消すと、Vercel の新しいコードが
--     出るまでの間 QR販売が壊れる。逆にコードだけ先に出すと4引数がまだ無くて壊れる。
--     そこで、この移行のあいだだけ**2つを共存させる**（引数の数が違うので
--     曖昧にはならない）。
--
--       1. このmigrationを実行（4引数を足す。3引数はそのまま動く）
--       2. 新しいコードを Production へ出す（4引数を呼ぶ）
--       3. 本番でQR販売を1件ためして確認する
--       4. そのあと zaiko/migrations/2026-10-16-drop-sell-channel-3arg.sql で
--          3引数の形を落とす（cleanup）
--
--     どの時点でも、使える形が必ず1つ以上ある。
--
--   守るもの（1つも緩めない）
--     ・inv_can_edit() 必須（admin / member だけ。viewer は不可）
--     ・p_sold_price > 0（空・0円以下は通さない）
--     ・販売先は inv_sell_channels() の中だけ
--     ・売れるのは 在庫・出品中・販売予約 のときだけ
--     ・売却そのものは既存の inv_item_sell() → inv_item_op('売却') を通る
--     ・取り消し（inv_item_sell_undo）も既存のまま使える
-- ============================================================


-- ------------------------------------------------------------
-- 1) 実売価格を受け取る形を足す
--
--    **金額を画面から受け取るので、受け取った値を必ずここで検める。**
--      ・数値になるか（text ではなく numeric で受ける）
--      ・1円以上か
--      ・現実的な桁か（1億円以上は入力間違いとして止める）
--
--    登録価格は「初期値を出すため」と「履歴に残すため」にだけ使う。
--    登録価格が無くても、入力があれば売れる（現場で値段が決まることがある）。
--
--    **マスタへは書き戻さない。** この関数は inventory_channels /
--    inventory_channel_listings / plan_price を1行も UPDATE しない。
--
--    **3引数の形はここでは消さない**（上の切り替え手順を参照）。
--    引数の数が違うので、2つあっても呼び出しが曖昧になることはない。
-- ------------------------------------------------------------
create or replace function public.inv_item_sell_channel(
  p_item_id    text,
  p_channel    text,
  p_sold_price numeric,
  p_note       text default null
) returns public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  it      public.inventory_items;
  v_listed numeric;
  v_note   text;
  fmt     text := 'FM9,999,999,999';
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if coalesce(btrim(p_channel), '') = '' then
    raise exception '販売先を選んでください';
  end if;
  -- 知らない販売先では売らない（一覧は inv_sell_channels の1か所だけ）
  if not (p_channel = any (public.inv_sell_channels())) then
    raise exception '知らない販売先です（%）', p_channel;
  end if;

  -- 実売価格。空・0円以下は通さない
  if p_sold_price is null then
    raise exception '販売価格を入力してください';
  end if;
  if p_sold_price <= 0 then
    raise exception '販売価格は1円以上で入力してください';
  end if;
  if p_sold_price >= 100000000 then
    raise exception '販売価格が大きすぎます。桁を確かめてください（%円）',
      to_char(p_sold_price, fmt);
  end if;

  select * into it from public.inventory_items where id = p_item_id for update;
  if not found then
    raise exception '商品が見つかりません（%）', p_item_id;
  end if;
  if it.status not in ('在庫', '出品中', '販売予約') then
    raise exception '販売済みにできるのは 在庫・出品中・販売予約 のものだけです（いまは %）', it.status;
  end if;

  /* 登録価格は**記録のためだけ**に読む。売る金額には使わない。
     登録価格と実売価格が違っていてもよい（違ったことが履歴で分かるようにする）。 */
  v_listed := public.inv_item_channel_price(p_item_id, p_channel);
  if v_listed is not null and v_listed <> p_sold_price then
    v_note := '登録価格 ' || to_char(v_listed, fmt) || '円 → 実売 '
              || to_char(p_sold_price, fmt) || '円';
  elsif v_listed is null then
    v_note := '登録価格なし（手入力）→ 実売 ' || to_char(p_sold_price, fmt) || '円';
  end if;
  if v_note is not null then
    p_note := coalesce(nullif(btrim(coalesce(p_note, '')), '') || '／', '') || v_note;
  end if;

  /* 状態変更も履歴も、既存の売却処理をそのまま通す。
     **ここで出品価格マスタへ書き戻さない。** 変わるのは sold_price / sold_channel
     （と inv_item_op('売却') が触る status / user_name / loaned_at）だけ。 */
  it := public.inv_item_sell(p_item_id, p_channel, p_sold_price::text, p_note);
  return it;
end $$;

/* 3引数の形と共存するあいだは、**引数まで書かないと名前が曖昧**になる
   （comment on function は同名の関数が2つあると決められない）。 */
comment on function public.inv_item_sell_channel(text, text, numeric, text) is
  '販売先を選んで1台を売却済にする。**実売価格（p_sold_price）を画面から受け取る。**
   1円以上・1億円未満でなければ通さない。登録価格は履歴に残すためだけに読み、
   出品価格・販売予定価格のマスタ（inventory_channels / inventory_channel_listings /
   plan_price）へは1行も書き戻さない。売却そのものは既存の
   inv_item_sell() → inv_item_op(''売却'') をそのまま通る。
   売れるのは 在庫・出品中・販売予約 のときだけで、admin / member だけ（viewer は不可）。';


-- ------------------------------------------------------------
-- 2) 権限
--
--    足した4引数の形へ配り直す（既定では PUBLIC に EXECUTE が付くため）。
--    3引数の形の権限はそのまま（切り替えのあいだ本番コードが使う）。
-- ------------------------------------------------------------
revoke all on function public.inv_item_sell_channel(text, text, numeric, text) from public, anon, service_role;
grant execute on function public.inv_item_sell_channel(text, text, numeric, text) to authenticated;


-- ------------------------------------------------------------
-- 自己点検（17項目＋件数2行）
-- ------------------------------------------------------------
select '実売価格を受け取る形になっている' as kind,
       case when to_regprocedure('public.inv_item_sell_channel(text,text,numeric,text)') is not null
            then 'OK' else 'NG' end as result
union all
select '3引数の形も残っている（切り替えのあいだ本番コードが使う）',
       case when to_regprocedure('public.inv_item_sell_channel(text,text,text)') is not null
            then 'OK いまのコードはこれを呼べる'
            else 'OK すでに cleanup 済み' end
union all
select '2つあっても呼び出しは曖昧にならない（引数の数が違う）',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'inv_item_sell_channel') <= 2
            then 'OK' else 'NG 同じ引数数のものがある' end
union all
select '権限は inv_can_edit（admin / member だけ）',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%if not public.inv_can_edit() then%'
            then 'OK' else 'NG' end
union all
select '空では売れない',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%p_sold_price is null%'
            then 'OK' else 'NG' end
union all
select '0円以下では売れない',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%p_sold_price <= 0%'
            then 'OK' else 'NG' end
union all
select '桁の入力間違いも止める',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%p_sold_price >= 100000000%'
            then 'OK' else 'NG' end
union all
select '販売先は inv_sell_channels の中だけ',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%public.inv_sell_channels()%'
            then 'OK' else 'NG' end
union all
select '売れる状態は 在庫・出品中・販売予約 のまま',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%in (''在庫'', ''出品中'', ''販売予約'')%'
            then 'OK' else 'NG' end
union all
select '売却は既存の inv_item_sell を通る',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%public.inv_item_sell(p_item_id, p_channel, p_sold_price::text, p_note)%'
            then 'OK' else 'NG' end
union all
select '出品価格マスタへ書き戻さない',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 not like '%update public.inventory_channels%'
            and pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 not like '%update public.inventory_channel_listings%'
            and pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 not like '%plan_price =%'
            then 'OK' else 'NG 書き戻している' end
union all
select '登録価格との違いを履歴に残す',
       case when pg_get_functiondef('public.inv_item_sell_channel(text,text,numeric,text)'::regprocedure)
                 like '%登録価格 %→ 実売 %'
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_item_sell_channel(text,text,numeric,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select 'service_roleも呼べない',
       case when has_function_privilege('service_role', 'public.inv_item_sell_channel(text,text,numeric,text)', 'execute')
            then 'NG service_roleが呼べる' else 'OK' end
union all
select '社員は呼べる',
       case when has_function_privilege('authenticated', 'public.inv_item_sell_channel(text,text,numeric,text)', 'execute')
            then 'OK' else 'NG' end
union all
select '登録価格を読む関数（#52）はそのまま',
       case when to_regprocedure('public.inv_item_channel_price(text,text)') is not null
            then 'OK' else 'NG' end
union all
select '売却取消（#49）もそのまま',
       case when to_regprocedure('public.inv_item_sell_undo(text,text)') is not null
            then 'OK' else 'NG' end
union all
select 'いま売却済の台数',
       (select count(*)::text from public.inventory_items where status = '売却済') || '台'
union all
select 'うち実売価格が入っている台数',
       (select count(*)::text from public.inventory_items
         where status = '売却済' and sold_price is not null) || '台';
