-- Limit expensive current-context and reaction lookups to potential visible records.
-- Currentness and human override are still rechecked by curated_items; no cache.
create view core.curated_visible_items as
with candidates as materialized (
 select l.raw_item_id from core.analysis_labels l join core.analysis_runs ar on ar.id=l.run_id
 where ar.status='complete' and l.label->>'decision' in ('relevant','review')
 union
 select m.raw_item_id from core.mentions m join core.review_decisions r on r.mention_id=m.id
 where r.decision in ('accepted','review')
 union
 select m.raw_item_id from core.mentions m join core.sources s on s.id=m.source_id
 where not exists(select 1 from core.analysis_runs ar where ar.workflow_id=s.workflow_id and ar.status='complete')
 and m.decision in ('accepted','review')
)
select d.* from candidates c join core.curated_items d on d.raw_item_id=c.raw_item_id
where d.decision in ('accepted','review');

create or replace view core.curated_daily_rollups as
select (event_at at time zone 'Europe/Kyiv')::date as day,workflow_id,source_id,source_kind,
 coalesce(topic,'other') topic,coalesce(brand,'telecom') brand,decision,
 count(*)::int count,count(*) filter(where negative)::int negative_count,
 coalesce(sum(views) filter(where negative and decision='accepted'),0)::bigint negative_reach,
 count(views) filter(where negative and decision='accepted')::int views_measured,
 coalesce(sum(rx.neg),0) reaction_negative,coalesce(sum(rx.ironic),0) reaction_ironic,
 coalesce(sum(rx.sad),0) reaction_sad,coalesce(sum(rx.pos),0) reaction_positive,
 count(reactions)::int reactions_measured,
 coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}') lag_samples,
 count(*) filter(where negative and kind='comment' and watch_active)::int complaints,now() generated_at
from core.curated_visible_items d
left join lateral (
 select sum(value::bigint) filter(where key=any(array['👎','😡','🤬','🤮','💩','🤡'])) neg,
 sum(value::bigint) filter(where key=any(array['🤣','😁','😈'])) ironic,
 sum(value::bigint) filter(where key=any(array['😢','💔','😭'])) sad,
 sum(value::bigint) filter(where not(key=any(array['👎','😡','🤬','🤮','💩','🤡','🤣','😁','😈','😢','💔','😭']))) pos
 from jsonb_each_text(case when jsonb_typeof(d.reactions)='object' then d.reactions else '{}'::jsonb end)
 where value ~ '^\d+$'
) rx on true
where event_at>=((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv'
 and event_at<=now() and decision in ('accepted','review')
 and (kind<>'comment' or (watch_active and event_at>=now()-interval '7 days'))
group by 1,2,3,4,5,6,7;

do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
 grant select on core.curated_visible_items to ufv_api;
 end if;
end $$;
