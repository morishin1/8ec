-- ============================================================
-- 公開側「カテゴリーから探す」を、カテゴリーマスター起点にする
--   2026-09-20（2026-09-19-dashboard-data-quality.sql の後に流す追補）
--
--   これまでトップの「カテゴリーから探す」は、公開中の商品から
--   category_id を逆算して並べていた。商品が0件のカテゴリーは消え、
--   お客様からは「8RENTはそれを扱っていない」ように見えていた。
--
--   カテゴリーマスター（inventory_categories）を表示元にする。
--   商品が0件でもカテゴリーは出し、件数は別に数える。
--
--   入っているもの
--     inventory_categories に公開用の列を足す
--       public_name    公開画面で出す名前（社内名とは別に持てる）
--       public_icon    タイルのアイコン（Material Symbols）
--       public_sort    公開画面での並び
--       public_listed  トップの「カテゴリーから探す」に出すかどうか
--     公開ビュー inv_public_categories（anon から読める）
--
--   既存のIDは変えない。表記が違うものは public_name を当てるだけにして、
--   似たカテゴリーを二重に作らない。既存IDで表せないものだけ新しく作る。
--
--   何度流しても同じ結果になる。
--
--   実行後の確認
--     select * from public.inv_public_categories;
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 41-1) カテゴリーマスターに公開用の情報を持たせる
--
--     社内で使う名前（inventory_categories.name）と、公開画面で見せる名前は
--     同じとは限らない。社内は「PC」で通っているが、公開側は「パソコン」に
--     したい、というような違いを、IDを変えずに吸収する。
-- ------------------------------------------------------------
alter table public.inventory_categories add column if not exists public_name   text;
alter table public.inventory_categories add column if not exists public_icon   text;
alter table public.inventory_categories add column if not exists public_sort   integer;
alter table public.inventory_categories add column if not exists public_listed boolean not null default false;

comment on column public.inventory_categories.public_name is
  '公開画面（8ECトップ）で出す名前。空なら name を使う。社内の呼び名を変えずに公開表記だけ変えるための列。';
comment on column public.inventory_categories.public_icon is
  'タイルのアイコン（Material Symbols の名前）。空なら devices_other。';
comment on column public.inventory_categories.public_sort is
  '公開画面での並び順。空なら sort_no を使う。';
comment on column public.inventory_categories.public_listed is
  'トップの「カテゴリーから探す」に出すかどうか。商品が0件でも出す（扱っていない、と見せないため）。';

-- ------------------------------------------------------------
-- 41-2) 公開する12カテゴリー
--
--     既存IDで表せるものは、IDをそのままに public_name を当てる。
--       pc      → パソコン                     （社内名は「PC」）
--       monitor → ディスプレイ・モニター
--       consume → パソコンサプライ・消耗品
--       network → 無線LAN・ネットワーク機器
--       printer → プリンター・プロジェクター
--       input   → キーボード・マウス・ウェブカメラ（社内名は「入力機器」）
--
--     既存IDで表せないものだけ、新しく作る。
--       software / storage / server / parts / mobile-acc / ups
--
--     どこにも寄せなかった既存カテゴリー（tablet・phone・other・cable・paper・
--     adapter）は消さない。public_listed=false のまま社内で使い続ける。
--     「スマホ・タブレットアクセサリ」は機器そのものではなく付属品なので、
--     tablet／phone には寄せず別IDにしている。
-- ------------------------------------------------------------

-- 既存IDで表せないカテゴリーを足す（すでにあれば触らない）
insert into public.inventory_categories (id, name, kind, code_prefix, sort_no) values
  ('software',   'ソフトウェア',           'quantity',   null,  160),
  ('storage',    '外付けドライブ・ストレージ', 'individual', 'ST',  80),
  ('server',     'サーバー関連',           'individual', 'SV',  90),
  ('parts',      'パソコンパーツ',         'quantity',   null,  170),
  ('mobile-acc', 'スマホ・タブレットアクセサリ', 'quantity', null,  180),
  ('ups',        'UPS（無停電電源装置）',   'individual', 'UP',  100)
on conflict (id) do nothing;

-- 公開する12カテゴリーを、指定された順番・表記で確定させる
update public.inventory_categories c
   set public_name   = v.pname,
       public_icon   = v.picon,
       public_sort   = v.psort,
       public_listed = true
  from (values
    ('pc',         'パソコン',                     'laptop_mac',        10),
    ('monitor',    'ディスプレイ・モニター',         'desktop_windows',   20),
    ('software',   'ソフトウェア',                 'apps',              30),
    ('consume',    'パソコンサプライ・消耗品',       'inventory_2',       40),
    ('network',    '無線LAN・ネットワーク機器',      'router',            50),
    ('printer',    'プリンター・プロジェクター',      'print',             60),
    ('storage',    '外付けドライブ・ストレージ',      'hard_drive',        70),
    ('input',      'キーボード・マウス・ウェブカメラ', 'keyboard',          80),
    ('server',     'サーバー関連',                 'dns',               90),
    ('parts',      'パソコンパーツ',               'memory',           100),
    ('mobile-acc', 'スマホ・タブレットアクセサリ',    'smartphone',       110),
    ('ups',        'UPS（無停電電源装置）',         'battery_charging_full', 120)
  ) as v(id, pname, picon, psort)
 where c.id = v.id;

-- ------------------------------------------------------------
-- 41-3) 公開ビュー
--
--     anon（公開キー）が読むのはこのビューだけ。件数は入れない。
--     カテゴリーごとの商品数は inv_public_catalog を数えて出す
--     （在庫数ではなく「公開している機種の数」なので、公開側で数えてよい）。
-- ------------------------------------------------------------
create or replace view public.inv_public_categories as
select c.id,
       coalesce(nullif(btrim(coalesce(c.public_name, '')), ''), c.name) as name,
       coalesce(nullif(btrim(coalesce(c.public_icon, '')), ''), 'devices_other') as icon,
       coalesce(c.public_sort, c.sort_no, 0) as sort_no
  from public.inventory_categories c
 where c.public_listed
 order by coalesce(c.public_sort, c.sort_no, 0), c.id;

comment on view public.inv_public_categories is
  '公開画面の「カテゴリーから探す」に出すカテゴリー。商品が0件でも消えない。
   名前は public_name（無ければ name）。並びは public_sort（無ければ sort_no）。';

grant select on public.inv_public_categories to anon, authenticated;

commit;
