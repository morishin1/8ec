-- 2026-11-09: 管理番号単位の個体メモを商品マスタと完全に分離する
-- 新たなメモカラム・データ移行は不要:
--   inventory_items.note    = 個体メモ（管理番号単位）
--   inventory_products.note = 型番共通メモ（商品コード単位）
-- 既存メモは一切コピー・上書き・削除しない。
--
-- 基本情報の編集RPCは商品マスタにも触るため、メモ専用RPCを追加する。
-- このRPCは inventory_items.note の1行だけを変更する。
create or replace function public.inv_item_note_edit(
  p_item_id text,
  p_note text default null
)
returns public.inventory_items
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.inv_is_admin() then
    raise exception '個体メモを編集できるのは管理者だけです';
  end if;

  select * into v_item
    from public.inventory_items
   where id = p_item_id and deleted_at is null
   for update;

  if not found then
    raise exception '個体が見つかりません（%）', p_item_id;
  end if;

  if v_item.note is not distinct from v_note then
    return v_item; -- 変更なし: 履歴を増やさない
  end if;

  update public.inventory_items
     set note = v_note
   where id = p_item_id
   returning * into v_item;

  insert into public.inventory_transactions
    (actor, ref_kind, ref_id, label, action, before_value, after_value)
  values
    (public.inv_actor(), 'item', p_item_id, v_item.name, '編集',
     'この個体', '個体メモ');

  return v_item;
end;
$$;

comment on function public.inv_item_note_edit(text,text) is
  '管理者のみ。対象管理番号の inventory_items.note だけを更新し履歴を記録する。inventory_products と他の個体は変更しない。';

revoke all on function public.inv_item_note_edit(text,text) from public;
revoke all on function public.inv_item_note_edit(text,text) from anon;
grant execute on function public.inv_item_note_edit(text,text) to authenticated;
