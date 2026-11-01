-- 8EC月末在庫: Supabase SQL Editorで、月末スナップショットmigration適用後に1度だけ実行。
-- pg_cron拡張が有効であること。ジョブのタイムゾーンはUTCを前提としている。
-- 毎日 15:00 UTC = 翌日 00:00 JST に実行し、
-- 日本時間で1日のときだけ前月末の在庫を保存。
-- 最初の自動取得は導入後の次の月末。すでに過ぎた月をバックフィルしない。
select cron.schedule(
  '8ec-month-end-inventory-jst',
  '0 15 * * *',
  $job$
    select public.inv_month_end_capture()
     where extract(day from (now() at time zone 'Asia/Tokyo')) = 1;
  $job$
);
-- 確認:
-- select jobid, jobname, schedule, command, active from cron.job where jobname = '8ec-month-end-inventory-jst';
-- 最終実行確認:
-- select * from public.inventory_month_end_snapshots order by month_end desc;
