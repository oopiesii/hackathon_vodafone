-- Effective classification: saved AI labels and exact-version human decisions.
-- Existing raw/mentions, collector receipts and historical migrations stay intact.
create view core.semantic_classifications as
select i.id raw_item_id,m.id,
 case when i.deleted or m.deleted then 'deleted'
      when m.id is null or m.raw_version<>i.version then 'pending'
      when coalesce(ar.scope->'test_source_ids','[]'::jsonb) @> jsonb_build_array(i.source_id) then 'rejected'
      when r.decision is not null then r.decision
      when gate.enabled then case
        when not coalesce(valid.current,false) then 'pending'
        when l.label->>'decision'='relevant' then 'accepted'
        when l.label->>'decision'='review' then 'review'
        else 'rejected' end
      when p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision then 'pending'
      else m.decision end decision,
 case when valid.current then case l.label->>'topic'
   when 'outage' then 'network' when 'recovery' then 'network' when 'infrastructure_attack' then 'network' when 'coverage' then 'network'
   when 'tariff' then 'billing' when 'billing' then 'billing' when 'support' then 'support'
   when 'internet' then 'internet' when 'roaming' then 'mobile' else 'other' end
   else m.category end topic,
 case when valid.current then case
   when l.label->'brands' ? 'vodafone' or l.label->>'relevance'='vodafone' then 'vodafone'
   when l.label->'brands' ? 'kyivstar' then 'kyivstar'
   when l.label->'brands' ? 'lifecell' then 'lifecell' else 'telecom' end
   else m.brand end brand,
 case when valid.current then coalesce(l.label->'brands','[]'::jsonb)
   else jsonb_build_array(m.brand) end brands,
 case when valid.current then l.label->>'sentiment'='negative' or exists(
   select 1 from jsonb_array_elements(l.label->'aspects') a where a->>'sentiment'='negative')
   when gate.enabled then false else
   m.quote ~* '(не працю|не работа|збій|сбой|скарг|жалоб|обур|поган|плох|шахрай|списан|подорожч|outage)' end negative,
 case when valid.current then l.label->>'topic'='outage'
   when gate.enabled then false else m.quote ~* '(не працю|не работа|збій|сбой|outage|network down)' end outage,
 case when valid.current then l.label->>'summary' else m.summary end summary,
 case when r.decision is not null then 'Рішення людини для цієї версії матеріалу.'
      when gate.enabled and not coalesce(valid.current,false) then 'Очікує семантичної перевірки: новий текст або змінений контекст.'
      when valid.current then l.label->>'reason' else m.reason end reason,
 case when r.decision is not null then 'human'
      when valid.current then 'semantic'
      when gate.enabled then 'pending' else 'rules' end classifier,
 case when valid.current then ar.model end model,
 case when valid.current then l.analyzed_at else m.analyzed_at end analyzed_at,
 case when valid.current then (select e->>'quote' from jsonb_array_elements(l.label->'evidence') e
   where e->>'id'=i.id::text and strpos(i.text,e->>'quote')>0 limit 1) end evidence_quote
from raw.items i
join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.mentions m on m.raw_item_id=i.id
left join core.processing_receipts p on p.raw_item_id=i.id
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version
cross join lateral (select exists(select 1 from core.analysis_runs ar
 where ar.workflow_id=s.workflow_id and ar.status='complete') enabled) gate
left join lateral (select l.* from core.analysis_labels l join core.analysis_runs ar on ar.id=l.run_id
 where l.raw_item_id=i.id and ar.workflow_id=s.workflow_id and ar.status='complete'
 order by ar.created_at desc,l.analyzed_at desc,l.run_id desc limit 1) l on gate.enabled
left join core.analysis_runs ar on ar.id=l.run_id
cross join lateral (select l.raw_version=i.version and not i.deleted and not exists(
 select 1 from jsonb_array_elements(l.label->'context_versions') cv
 left join raw.items parent on parent.id=(cv->>'id')::bigint
 left join core.sources ps on ps.id=parent.source_id
 where parent.id is null or parent.deleted or parent.version<>(cv->>'version')::int or ps.workflow_id<>s.workflow_id)
 and (l.label->>'missing_parent_key' is null or not exists(
 select 1 from raw.items parent where parent.source_id=i.source_id
 and parent.source_item_id=l.label->>'missing_parent_key' and not parent.deleted)) current) valid;

create view core.curated_items as
select d.raw_item_id,d.id,d.source_id,d.workflow_id,d.source_kind,d.source_title,d.kind,d.url,
 d.published_at,d.fetched_at,sc.analyzed_at,d.event_at,d.content_hash,d.canonical_item_id,
 d.quote,sc.topic,sc.brand,sc.decision,sc.negative,sc.outage,d.action,
 d.views,d.forwards,d.replies,d.reactions,d.metrics_observed_at,d.lag_seconds,d.watch_active,
 sc.summary,sc.reason,sc.classifier,sc.model,sc.evidence_quote,sc.brands
from core.dashboard_items d join core.semantic_classifications sc on sc.raw_item_id=d.raw_item_id;

-- Calculate monthly accepted/review aggregates from current semantic evidence.
-- Live contextual invalidation must not leave a stale cached label in a viewer count.
create view core.curated_daily_rollups as
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
from core.curated_items d
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
 grant select on core.curated_items,core.curated_daily_rollups to ufv_api;
 end if;
end $$;

