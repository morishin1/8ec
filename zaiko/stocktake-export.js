/* 8EC: 直近の完了済み棚卸一覧CSV（管理者のみ） */
'use strict';
let stocktakeExportBusy = false;
async function exportLatestStocktakeCsv() {
  if (!canAdmin() || stocktakeExportBusy) return;
  const st = (db.stPast || []).find(s => s.status === 'closed');
  if (!st) { toast('完了済みの棚卸がありません'); return; }
  if (!window.EightCsv) { toast('CSV出力の準備ができていません。再読み込みしてください'); return; }
  stocktakeExportBusy = true;
  try {
    const records = [];
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const { data, error } = await sb.from('inventory_stocktake_items')
        .select('item_id,expected,checked_at,missing_at')
        .eq('stocktake_id', st.id).order('item_id', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw error;
      records.push(...(data || []));
      if (!data || data.length < 1000) { complete = true; break; }
    }
    if (!complete) throw new Error('10万行を超えるため全件取得を確認してください');
    const items = new Map();
    const ids = [...new Set(records.map(r => r.item_id).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from('inventory_items')
        .select('id,name,maker,model,serial,product_code,location_id,status,purchased_on,cost')
        .in('id', ids.slice(i, i + 100)).limit(100);
      if (error) throw error;
      (data || []).forEach(it => items.set(it.id, it));
    }
    const statusOf = r => {
      if (r.expected === false) return r.checked_at ? '帳簿外現物' : '帳簿外・未確認';
      if (r.checked_at) return '現物確認済み';
      if (r.missing_at) return '差異確定（現物なし）';
      return '未確認';
    };
    const scope = st.scope_location_id ? locPath(st.scope_location_id) : '全拠点';
    const start = st.started_at ? fmtDT(st.started_at) : '';
    const finish = st.closed_at ? fmtDT(st.closed_at) : '';
    const header = ['棚卸ID','棚卸開始','棚卸完了','棚卸範囲','棚卸担当','管理番号',
      '商品名','メーカー','型番','シリアル番号','商品コード','棚卸結果',
      '現物確認日時','差異確定日時','現在の状態','現在の保管場所',
      '仕入日','現在の仕入原価（参考）','原価の確認'];
    const dataRows = records.map(r => {
      const it = items.get(r.item_id);
      const cost = it ? it.cost : null;
      const hasCost = cost != null && Number(cost) > 0;
      return [st.id, start, finish, scope, st.actor || '', r.item_id,
        it?.name || '(現在マスターなし)', it?.maker || '', it?.model || '',
        it?.serial || '', it?.product_code || '', statusOf(r),
        r.checked_at ? fmtDT(r.checked_at) : '',
        r.missing_at ? fmtDT(r.missing_at) : '',
        it?.status || '', it ? locPath(it.location_id) : '',
        it?.purchased_on || '', cost == null ? '' : cost,
        !it ? '個体不明' : hasCost ? '登録あり' : '0円・未登録要確認'];
    });
    const filename = '8EC_直近棚卸_' + ymd(new Date(st.started_at)) + '_No' + st.id + '.csv';
    window.EightCsv.download(filename,
      window.EightCsv.blob(window.EightCsv.build([header].concat(dataRows))));
    toast('直近の完了済み棚卸 ' + records.length + '行を出力しました');
  } catch(e) {
    toast('棚卸CSVを出力できませんでした：' + (e.message || e));
  } finally {
    stocktakeExportBusy = false;
  }
}
