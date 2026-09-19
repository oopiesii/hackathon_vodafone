/** Operator totals need current decisions and collection times, not material text or metrics. */
export const operatorCountsSql = `with candidates as materialized (
 select id,source_kind,
  case when published_at is not null and fetched_at>=published_at
   then extract(epoch from fetched_at-published_at)::double precision end lag_seconds
 from core.incoming_items
 where workflow_id=$1 and coalesce(published_at,fetched_at)>=$2 and coalesce(published_at,fetched_at)<=$3
)
select c.source_kind,sc.decision,count(*)::int count,
 coalesce(array_agg(c.lag_seconds) filter(where c.lag_seconds is not null),'{}') lag_samples
from candidates c
cross join lateral (
 select decision from core.curated_items where raw_item_id=c.id offset 0
) sc
where sc.decision<>'deleted'
group by c.source_kind,sc.decision`;

// A week currently contains nearly the entire input. Its set-based plan is faster
// than one parameterized lookup per item; retain it until a bounded aggregate exists.
export const wideOperatorCountsSql = `select source_kind,decision,count(*)::int count,
 coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}') lag_samples
from core.curated_items where workflow_id=$1 and event_at>=$2 and event_at<=$3 and decision<>'deleted'
group by source_kind,decision`;

/** Recheck visibility once per requested material, then scan only its first two hours of metrics. */
export const growthSql = `with visible as materialized (
 select raw_item_id,published_at from core.curated_visible_items
 where raw_item_id=any($1::bigint[]) and workflow_id=$2 and decision=any($3::text[])
  and event_at>=$4 and event_at<=$5
  and (kind<>'comment' or (watch_active and event_at>=$5::timestamptz-interval '7 days'))
)
select m.item_id,count(*)::int observations,
 (array_agg(m.views order by m.observed_at desc,m.id desc))[1] last_views,
 (array_agg(m.views order by m.observed_at,m.id))[1] first_views,
 extract(epoch from max(m.observed_at)-min(m.observed_at)) seconds
from visible v join core.telegram_metrics m on m.item_id=v.raw_item_id
 and m.observed_at>=v.published_at and m.observed_at<=v.published_at+interval '2 hours'
where m.views is not null
group by m.item_id having count(*)>=2 and max(m.observed_at)>min(m.observed_at)`;
