import { appPool } from '../db/pool.js';

// Call only AFTER the surrounding document/inbox permission check.
export async function telegramDetail(itemId:string){
  const [metrics,watch,metadata]=await Promise.all([
    appPool.query('select id,observed_at,views,forwards,replies,reactions,available from core.telegram_metrics where item_id=$1 and not deleted order by observed_at desc,id desc limit 100',[itemId]),
    appPool.query('select state,next_check_at,last_checked_at,last_activity_at,reason,last_error,override_mode,collected_replies from core.telegram_watches where item_id=$1 and not deleted',[itemId]),
    appPool.query('select normalization_version,content_truncated,topic_id,(canonical_item_id is not null) has_duplicate from core.telegram_item_metadata where id=$1',[itemId]),
  ]);
  return {metrics:metrics.rows.reverse(),watch:watch.rows[0]||null,metadata:metadata.rows[0]||null};
}
