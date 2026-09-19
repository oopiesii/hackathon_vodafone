-- Candidate compatibility for pending external snapshots 0020..0022.
-- Keep effective semantic policy; publish text-free aggregates as atomic generations.
create view core.semantic_source_runs as
select ar.id run_id,s.id source_id
from core.analysis_runs ar join core.sources s on s.workflow_id=ar.workflow_id
join core.workflows w on w.id=s.workflow_id
left join core.rss_sources rss on rss.source_id=s.id
where (
 coalesce(ar.scope->>'mode','')<>'continuous' and ar.status='complete'
 and jsonb_typeof(ar.scope->'source_ids')='array'
 and ar.scope->'source_ids' @> jsonb_build_array(s.id)
 and (ar.scope->>'source_kind' is null or ar.scope->>'source_kind'=s.kind)
) or (
 ar.scope->>'mode'='continuous' and ar.status in ('running','complete')
 and s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
 and (s.kind<>'rss' or rss.rights_status='allowed')
);

create or replace view core.semantic_classifications as
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
cross join lateral (select (exists(select 1 from core.analysis_runs completed
 where completed.workflow_id=s.workflow_id and completed.status='complete')
 or exists(select 1 from core.semantic_source_runs sr where sr.source_id=s.id)) enabled) gate
left join lateral (select l.* from core.analysis_labels l
 join core.semantic_source_runs sr on sr.run_id=l.run_id and sr.source_id=s.id
 join core.analysis_runs run on run.id=l.run_id
 where l.raw_item_id=i.id and (coalesce(run.scope->>'mode','')<>'continuous' or exists(
  select 1 from core.analyst_receipts receipt where receipt.raw_item_id=i.id
   and receipt.raw_version=l.raw_version and receipt.status='complete'
   and receipt.model=run.model and receipt.prompt_version=run.prompt_version))
 order by l.analyzed_at desc,run.created_at desc,l.run_id desc limit 1) l on gate.enabled
left join core.analysis_runs ar on ar.id=l.run_id
cross join lateral (select l.raw_version=i.version and not i.deleted and not exists(
 select 1 from jsonb_array_elements(l.label->'context_versions') cv
 left join raw.items parent on parent.id=(cv->>'id')::bigint
 left join core.sources ps on ps.id=parent.source_id
 left join core.rss_sources prs on prs.source_id=ps.id
 where parent.id is null or parent.deleted or parent.version<>(cv->>'version')::int or ps.workflow_id<>s.workflow_id
  or (ar.scope->>'mode'='continuous' and (not ps.enabled or not ps.llm_allowed
   or coalesce(length(trim(ps.llm_basis)),0)<10 or (ps.kind='rss' and prs.rights_status is distinct from 'allowed'))))
 and (l.label->>'missing_parent_key' is null or not exists(
 select 1 from raw.items parent where parent.source_id=i.source_id
 and parent.source_item_id=l.label->>'missing_parent_key' and not parent.deleted)) current offset 0) valid;

-- Keep parameterized candidate lookups from 0022. Currentness is checked again.
create or replace view core.curated_visible_items as
with candidates as materialized (
 select l.raw_item_id from core.analysis_labels l
 join raw.items i on i.id=l.raw_item_id
 join core.semantic_source_runs sr on sr.run_id=l.run_id and sr.source_id=i.source_id
 where l.label->>'decision' in ('relevant','review')
 union
 select m.raw_item_id from core.mentions m join core.review_decisions r on r.mention_id=m.id
 where r.raw_version=m.raw_version and r.decision in ('accepted','review')
 union
 select m.raw_item_id from core.mentions m
 join core.sources s on s.id=m.source_id
 where not exists(select 1 from core.analysis_runs completed where completed.workflow_id=s.workflow_id and completed.status='complete')
 and not exists(select 1 from core.semantic_source_runs sr where sr.source_id=m.source_id)
 and m.decision in ('accepted','review')
)
select d.* from candidates c
cross join lateral (select * from core.curated_items d where d.raw_item_id=c.raw_item_id offset 0) d
where d.decision in ('accepted','review');

alter table core.daily_rollups add column metrics_oldest_at timestamptz,
 add column metrics_newest_at timestamptz,
 add column rolling_7d_count integer not null default 0;

-- Reads here never reach raw text, labels or contextual evidence.
create or replace view core.curated_daily_rollups as
select r.day,r.workflow_id,r.source_id,r.source_kind,r.topic,r.brand,r.decision,
 r.count,r.negative_count,r.negative_reach,r.views_measured,
 r.reaction_negative::numeric,r.reaction_ironic::numeric,r.reaction_sad::numeric,r.reaction_positive::numeric,
 r.reactions_measured,r.lag_samples,r.complaints,r.generated_at,r.metrics_oldest_at,r.metrics_newest_at,r.rolling_7d_count
from core.daily_rollups r join core.sources s on s.id=r.source_id and s.workflow_id=r.workflow_id
join core.dashboard_rollup_state st on st.source_id=s.id and not st.dirty and st.generated_at is not null
where r.decision in ('accepted','review');

create function core.refresh_dashboard_rollups(target_source_id bigint) returns void language plpgsql security definer
set search_path=pg_catalog,core set jit=off as $$
declare targets bigint[];
begin
 if not pg_try_advisory_xact_lock(727115) then return; end if;
 insert into core.dashboard_rollup_state(source_id) select id from core.sources on conflict do nothing;
 select array_agg(source_id) into targets from (
  select source_id from core.dashboard_rollup_state
   where (target_source_id is null or source_id=target_source_id)
    and (dirty or generated_at is null or generated_at<now()-interval '60 seconds')
   order by source_id for update
 ) pending;
 if targets is null then return; end if;
 delete from core.daily_rollups where source_id=any(targets);
 insert into core.daily_rollups(day,workflow_id,source_id,source_kind,topic,brand,decision,count,negative_count,
 negative_reach,views_measured,reaction_negative,reaction_ironic,reaction_sad,reaction_positive,reactions_measured,lag_samples,complaints,metrics_oldest_at,metrics_newest_at,rolling_7d_count)
 select (event_at at time zone 'Europe/Kyiv')::date,workflow_id,source_id,source_kind,coalesce(topic,'other'),coalesce(brand,'telecom'),decision,
 count(*)::int,count(*) filter(where negative)::int,
 coalesce(sum(views) filter(where negative and decision='accepted'),0)::bigint,
 count(views) filter(where negative and decision='accepted')::int,
 coalesce(sum(rx.neg),0),coalesce(sum(rx.ironic),0),coalesce(sum(rx.sad),0),coalesce(sum(rx.pos),0),
 count(reactions)::int,coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}'),
 count(*) filter(where negative and kind='comment' and watch_active)::int,
 min(metrics_observed_at) filter(where jsonb_typeof(reactions)='object'),
 max(metrics_observed_at) filter(where jsonb_typeof(reactions)='object'),
 count(*) filter(where event_at>=now()-interval '7 days')::int
 from (select id from raw.items where source_id=any(targets)
  and coalesce(published_at,fetched_at)>=((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv') candidate
 cross join lateral (select event_at,workflow_id,source_id,source_kind,topic,brand,decision,negative,
  views,reactions,lag_seconds,kind,watch_active,metrics_observed_at from core.curated_items
  where raw_item_id=candidate.id offset 0) d
 left join lateral (
  select sum(value::bigint) filter(where key=any(array['👎','😡','🤬','🤮','💩','🤡'])) neg,
   sum(value::bigint) filter(where key=any(array['🤣','😁','😈'])) ironic,
   sum(value::bigint) filter(where key=any(array['😢','💔','😭'])) sad,
   sum(value::bigint) filter(where not(key=any(array['👎','😡','🤬','🤮','💩','🤡','🤣','😁','😈','😢','💔','😭']))) pos
  from jsonb_each_text(case when jsonb_typeof(d.reactions)='object' then d.reactions else '{}'::jsonb end) where value ~ '^\d+$'
 ) rx on true
 where event_at>=((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv'
 and event_at<=now() and decision<>'deleted'
 and (kind<>'comment' or (watch_active and event_at>=now()-interval '7 days'))
 group by 1,2,3,4,5,6,7;
 update core.dashboard_rollup_state set dirty=false,generated_at=clock_timestamp() where source_id=any(targets);
end $$;

-- Preserve the existing manual/test entry point; runtime uses one source per transaction.
create or replace function core.refresh_dashboard_rollups() returns void language plpgsql security definer
set search_path=pg_catalog,core set jit=off as $$
begin
 perform core.refresh_dashboard_rollups(null::bigint);
end $$;

-- Acquire source locks in stable order. Callers never touch rollup rows first.
create function core.mark_curated_sources_dirty(ids bigint[]) returns void language plpgsql security definer
set search_path=pg_catalog,core as $$
declare sid bigint;
begin
 for sid in select distinct s.id from core.sources s where s.id=any(ids) order by s.id loop
  insert into core.dashboard_rollup_state(source_id) values(sid)
  on conflict(source_id) do update set dirty=true,invalidated_at=clock_timestamp();
 end loop;
end $$;

create index analysis_labels_context_lookup on core.analysis_labels using gin ((label->'context_versions') jsonb_path_ops);
create index analysis_labels_missing_parent_lookup on core.analysis_labels ((label->>'missing_parent_key'))
 where label->>'missing_parent_key' is not null;

create function core.invalidate_curated_label() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 perform core.mark_curated_sources_dirty(array(select distinct i.source_id from raw.items i
  where i.id in (new.raw_item_id,old.raw_item_id)));
 return null;
end $$;
create trigger curated_label_changed after insert or update or delete on core.analysis_labels
 for each row execute function core.invalidate_curated_label();
create trigger curated_receipt_changed after insert or update or delete on core.analyst_receipts
 for each row execute function core.invalidate_curated_label();

create function core.invalidate_curated_run() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 -- Activating/retracting a scoped run changes the pending gate even for unlabeled items.
 perform core.mark_curated_sources_dirty(array(select id from core.sources
  where workflow_id in (new.workflow_id,old.workflow_id)));
 return null;
end $$;
create trigger curated_run_added after insert or delete on core.analysis_runs
 for each row execute function core.invalidate_curated_run();
create trigger curated_run_changed after update of status,scope,workflow_id,model,prompt_version on core.analysis_runs
 for each row when(old.status is distinct from new.status or old.scope is distinct from new.scope
  or old.workflow_id is distinct from new.workflow_id or old.model is distinct from new.model
  or old.prompt_version is distinct from new.prompt_version)
 execute function core.invalidate_curated_run();

create function core.invalidate_curated_context() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 -- A newly arrived item does not revoke old accepted evidence. Its count joins the
 -- next timed generation; an arriving missing parent does revoke dependent labels.
 if tg_op='INSERT' then
  insert into core.dashboard_rollup_state(source_id) values(new.source_id) on conflict do nothing;
 end if;
 perform core.mark_curated_sources_dirty(array(
  select id from core.sources where tg_op<>'INSERT' and id in (new.source_id,old.source_id)
  union select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
   where l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',coalesce(new.id,old.id)))
    or (child.source_id in (new.source_id,old.source_id)
     and l.label->>'missing_parent_key' in (new.source_item_id,old.source_item_id))
 ));
 return null;
end $$;
-- Runs before the older dashboard_* item triggers; lock every affected source first.
create trigger curated_raw_added after insert or delete on raw.items
 for each row execute function core.invalidate_curated_context();
create trigger curated_raw_changed after update of version,deleted,source_id,source_item_id on raw.items
 for each row when(old.version is distinct from new.version or old.deleted is distinct from new.deleted
  or old.source_id is distinct from new.source_id or old.source_item_id is distinct from new.source_item_id)
 execute function core.invalidate_curated_context();

create function core.invalidate_curated_source() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 perform core.mark_curated_sources_dirty(array(
  select new.id union
  select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
  where exists(select 1 from raw.items parent where parent.source_id=new.id
   and l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',parent.id)))
 ));
 return null;
end $$;
create trigger curated_source_added after insert on core.sources
 for each row execute function core.invalidate_curated_source();
create trigger curated_source_changed after update of workflow_id,enabled,llm_allowed,llm_basis,kind on core.sources
 for each row when(old.workflow_id is distinct from new.workflow_id or old.enabled is distinct from new.enabled
  or old.llm_allowed is distinct from new.llm_allowed or old.llm_basis is distinct from new.llm_basis
  or old.kind is distinct from new.kind)
 execute function core.invalidate_curated_source();

create function core.invalidate_curated_workflow() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 perform core.mark_curated_sources_dirty(array(select id from core.sources where workflow_id=new.id));
 return null;
end $$;
create trigger curated_workflow_enabled after update of enabled on core.workflows
 for each row when(old.enabled is distinct from new.enabled) execute function core.invalidate_curated_workflow();

create function core.invalidate_curated_rss_rights() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 perform core.mark_curated_sources_dirty(array(
  select s.id from core.sources s where s.id in (new.source_id,old.source_id)
  union select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
  where exists(select 1 from raw.items parent where parent.source_id in (new.source_id,old.source_id)
   and l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',parent.id)))
 ));
 return null;
end $$;
create trigger curated_rss_rights_changed after insert or update of rights_status,source_id or delete on core.rss_sources
 for each row execute function core.invalidate_curated_rss_rights();

-- S2 input provenance and currentness use the same effective decisions as the feed.
-- The historical name rule_decision is retained for the existing worker contract.
create or replace view core.analyst_items with (security_barrier=true) as
select i.id,i.source_id,s.workflow_id,i.source_item_id,i.parent_item_id,i.kind,
 i.text,i.version,i.published_at,i.fetched_at,i.content_scope,
 sc.decision rule_decision,sc.topic,sc.brand
from raw.items i join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.rss_sources rs on rs.source_id=s.id
join core.semantic_classifications sc on sc.raw_item_id=i.id
where not i.deleted and s.enabled and w.enabled and s.llm_allowed
 and length(trim(s.llm_basis))>=10 and (s.kind<>'rss' or rs.rights_status='allowed');

create or replace view core.analyst_rollups with (security_barrier=true) as
select d.* from core.daily_rollups d join core.sources s on s.id=d.source_id and s.workflow_id=d.workflow_id
join core.workflows w on w.id=s.workflow_id left join core.rss_sources r on r.source_id=s.id
join core.dashboard_rollup_state st on st.source_id=s.id and not st.dirty and st.generated_at is not null
where s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
 and (s.kind<>'rss' or r.rights_status='allowed');

revoke all on function core.mark_curated_sources_dirty(bigint[]) from public;
revoke all on function core.invalidate_curated_label() from public;
revoke all on function core.invalidate_curated_run() from public;
revoke all on function core.invalidate_curated_context() from public;
revoke all on function core.invalidate_curated_source() from public;
revoke all on function core.invalidate_curated_workflow() from public;
revoke all on function core.invalidate_curated_rss_rights() from public;
revoke all on function core.refresh_dashboard_rollups() from public;
revoke all on function core.refresh_dashboard_rollups(bigint) from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_processor') then
  grant select on core.dashboard_rollup_state to ufv_processor;
  grant execute on function core.refresh_dashboard_rollups(bigint) to ufv_processor;
 end if;
end $$;
create or replace function core.invalidate_dashboard_rollups() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 if tg_table_name='mentions' then
  -- A rules-only context retry cannot change a globally pending semantic item.
  -- Never suppress version, deletion, content, human or already-labeled changes.
  if old.raw_version=new.raw_version and old.deleted=new.deleted and old.quote is not distinct from new.quote
   and not exists(select 1 from core.analysis_labels where raw_item_id=new.raw_item_id)
   and not exists(select 1 from core.review_decisions where mention_id=new.id and raw_version=new.raw_version)
   and (exists(select 1 from core.sources s join core.analysis_runs ar on ar.workflow_id=s.workflow_id
        where s.id=new.source_id and ar.status='complete')
     or exists(select 1 from core.semantic_source_runs sr where sr.source_id=new.source_id)) then
   return null;
  end if;
 end if;
 if tg_table_name='workflows' then
  insert into core.dashboard_rollup_state(source_id) select id from core.sources where workflow_id=new.id
   on conflict(source_id) do update set dirty=true,invalidated_at=clock_timestamp();
 elsif tg_table_name='review_decisions' then
  insert into core.dashboard_rollup_state(source_id)
   select source_id from core.mentions where id=coalesce(new.mention_id,old.mention_id)
   on conflict(source_id) do update set dirty=true,invalidated_at=clock_timestamp();
 else
  insert into core.dashboard_rollup_state(source_id) select id from core.sources where id=coalesce(new.source_id,old.source_id)
   on conflict(source_id) do update set dirty=true,invalidated_at=clock_timestamp();
 end if;
 return null;
end $$;

-- Publish no old rules-only generations after changing the classification contract.
select core.mark_curated_sources_dirty(array(select id from core.sources));
