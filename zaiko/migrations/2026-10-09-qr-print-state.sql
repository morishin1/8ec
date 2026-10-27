-- ============================================================
-- QRラベルの印刷状態を持つ
--   2026-10-09
--
--   これまで、QRラベルを印刷したという事実はどこにも残っていなかった。
--   ラベル画面は window.print() を呼ぶだけで、誰がいつ何枚出したか分からず、
--   現物にQRが貼ってあるはずかどうかも画面からは判断できなかった。
--
--   **ブラウザは「実際に紙が出たか」を保証できない**（印刷ダイアログを
--   キャンセルしても afterprint は発火する）。そこでシステム上は
--   「印刷操作をした時点」を発行済みとして記録する。
--   出なかったときは、そのまま再印刷すればよい（回数と日時が更新される）。
--
--   このmigrationでやること
--     1) inventory_items に3列（初回・最終・回数）
--     2) inv_qr_print_mark() … 印刷／既存在庫を印刷済みにする／未印刷に戻す
--
--   既存のQRのURL・管理番号・在庫状態・棚卸には一切触らない。
--   履歴（inventory_transactions）は追記のみで、1行も消さない。
-- ============================================================


-- ------------------------------------------------------------
-- 1) 印刷状態の3列
--
--    一覧は個体を select('*') で読んでいるので、列にしておけば
--    追加のクエリなしで何千件でもアイコンの色を出し分けられる。
--    「誰が印刷したか」は inventory_transactions.actor に残すので列は持たない。
-- ------------------------------------------------------------
alter table public.inventory_items
  add column if not exists qr_printed_at   timestamptz,
  add column if not exists qr_printed_last timestamptz,
  add column if not exists qr_print_count  integer not null default 0;

comment on column public.inventory_items.qr_printed_at is
  'QRラベルを最初に印刷操作した日時。NULL なら未印刷。';
comment on column public.inventory_items.qr_printed_last is
  'QRラベルを最後に印刷操作した日時（再印刷で更新される）。';
comment on column public.inventory_items.qr_print_count is
  'QRラベルの印刷操作の回数。0 なら未印刷。画面はこの値だけで色を決める。';

-- 「未印刷だけ」の絞り込みが増えるので索引を1つ
create index if not exists inventory_items_qr_print_idx
  on public.inventory_items (qr_print_count);


-- ------------------------------------------------------------
-- 2) 印刷状態を書き換える唯一の入口
--
--    p_mode
--      'print' … QRラベルの印刷操作をした（初回も再印刷も同じ）
--                回数を+1、初回が空なら埋め、最終を now() にする。
--                **再印刷を禁止しない。** 誤操作で紙が出なかったときは
--                そのまま押し直せばよい。一般（編集できる人）も実行できる。
--      'set'   … すでに現物へQRが貼ってある既存在庫を、印刷済みに合わせる。
--                **実際の印刷はしない。** 管理者だけ。
--                すでに印刷済みのものは触らない（回数を水増ししない）。
--      'clear' … 未印刷に戻す（誤操作の取消）。管理者だけ。
--
--    在庫の状態・在庫数・出品状態・8RENT・棚卸には触らない。
-- ------------------------------------------------------------
create or replace function public.inv_qr_print_mark(
  p_item_ids text[],
  p_mode     text default 'print',
  p_note     text default null
) returns setof public.inventory_items
language plpgsql security invoker set search_path = public as $$
declare
  v_actor text := public.inv_actor();
  v_label text;
  it      public.inventory_items;
  v_id    text;
begin
  if not public.inv_can_edit() then
    raise exception '操作する権限がありません（閲覧のみ）';
  end if;
  if p_mode not in ('print', 'set', 'clear') then
    raise exception '知らない操作です（%）', p_mode;
  end if;
  if p_mode in ('set', 'clear') and not public.inv_is_admin() then
    raise exception 'この操作は管理者だけができます（%）', p_mode;
  end if;
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception '対象が選ばれていません';
  end if;

  v_label := case p_mode
               when 'print' then 'QRラベル印刷'
               when 'set'   then 'QR印刷済みにする'
               else              'QR未印刷に戻す'
             end;

  foreach v_id in array p_item_ids loop
    select * into it from public.inventory_items where id = v_id for update;
    if not found then
      raise exception '商品が見つかりません（%）', v_id;
    end if;

    if p_mode = 'print' then
      update public.inventory_items
         set qr_printed_at   = coalesce(qr_printed_at, now()),
             qr_printed_last = now(),
             qr_print_count  = coalesce(qr_print_count, 0) + 1
       where id = v_id returning * into it;

    elsif p_mode = 'set' then
      -- すでに印刷済みなら何もしない（回数を水増ししない）
      if coalesce(it.qr_print_count, 0) > 0 then
        return next it;
        continue;
      end if;
      update public.inventory_items
         set qr_printed_at   = now(),
             qr_printed_last = now(),
             qr_print_count  = 1
       where id = v_id returning * into it;

    else
      if coalesce(it.qr_print_count, 0) = 0 then
        return next it;
        continue;
      end if;
      update public.inventory_items
         set qr_printed_at = null, qr_printed_last = null, qr_print_count = 0
       where id = v_id returning * into it;
    end if;

    insert into public.inventory_transactions
      (actor, ref_kind, ref_id, label, action, before_value, after_value)
    values (v_actor, 'item', v_id, it.name, v_label,
            case when p_mode = 'clear' then '印刷済み' else '未印刷' end,
            case when p_mode = 'clear' then '未印刷'
                 else '印刷済み（' || it.qr_print_count || '回目）'
                      || case when p_mode = 'set' then '／既存QRの貼付済みを登録' else '' end
            end || coalesce('／' || nullif(btrim(coalesce(p_note, '')), ''), ''));

    return next it;
  end loop;
end $$;

comment on function public.inv_qr_print_mark is
  'QRラベルの印刷状態だけを書き換える。print=印刷操作（再印刷も可・回数と日時を更新）、
   set=既存の貼付済みを印刷済みに合わせる（管理者・実際の印刷はしない）、
   clear=未印刷に戻す（管理者）。在庫の状態・在庫数・出品状態・8RENT・棚卸は変えない。
   誰がやったかは inventory_transactions に追記する。';


-- ------------------------------------------------------------
-- 3) 権限
--
--    2026-10-01-rpc-permission-hardening.sql の一括配り直しは
--    「そのとき存在した関数」への1回きりの処理なので、あとから足した関数には効かない。
--    既定では PUBLIC に EXECUTE が付き anon からも呼べてしまうため、明示的に配り直す。
--    管理者かどうかは関数の中で inv_is_admin() が見る。
-- ------------------------------------------------------------
revoke all on function public.inv_qr_print_mark(text[], text, text) from public, anon, service_role;
grant execute on function public.inv_qr_print_mark(text[], text, text) to authenticated;


-- ------------------------------------------------------------
-- 確認
-- ------------------------------------------------------------
select '印刷状態の列' as kind,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'inventory_items'
                     and column_name in ('qr_printed_at', 'qr_printed_last', 'qr_print_count')) = 3
            then 'OK 3列そろっている' else 'NG' end as result
union all
select '既定は未印刷',
       case when (select column_default from information_schema.columns
                   where table_schema = 'public' and table_name = 'inventory_items'
                     and column_name = 'qr_print_count') like '0%'
            then 'OK 0' else 'NG' end
union all
select '再印刷を止めていない',
       case when pg_get_functiondef('public.inv_qr_print_mark(text[],text,text)'::regprocedure)
                 like '%qr_print_count  = coalesce(qr_print_count, 0) + 1%'
            then 'OK 回数を足していく' else 'NG' end
union all
select 'set と clear は管理者だけ',
       case when pg_get_functiondef('public.inv_qr_print_mark(text[],text,text)'::regprocedure)
                 like '%if p_mode in (''set'', ''clear'') and not public.inv_is_admin() then%'
            then 'OK' else 'NG' end
union all
select 'anonは呼べない',
       case when has_function_privilege('anon', 'public.inv_qr_print_mark(text[],text,text)', 'execute')
            then 'NG anonが呼べる' else 'OK' end
union all
select '社員は呼べる',
       case when has_function_privilege('authenticated', 'public.inv_qr_print_mark(text[],text,text)', 'execute')
            then 'OK' else 'NG' end
union all
select 'いま未印刷の個体数',
       (select count(*)::text from public.inventory_items
         where coalesce(qr_print_count, 0) = 0 and status <> '廃棄') || '台';
