-- A summary is bound to the input generation, including manual review/deletion.
create view core.analyst_rollup_state with (security_barrier=true) as
select s.id source_id,s.workflow_id,coalesce(st.dirty,true) dirty,st.generated_at,st.invalidated_at
from core.sources s join core.workflows w on w.id=s.workflow_id
left join core.rss_sources r on r.source_id=s.id
left join core.dashboard_rollup_state st on st.source_id=s.id
where s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
 and (s.kind<>'rss' or r.rights_status='allowed');

-- Current manual decisions survive an explicit reprocess; stale rule decisions do not.
create or replace view core.analyst_items with (security_barrier=true) as
select i.id,i.source_id,s.workflow_id,i.source_item_id,i.parent_item_id,i.kind,
 i.text,i.version,i.published_at,i.fetched_at,i.content_scope,
 case when m.id is null then 'pending' when r.decision is not null then r.decision
      when p.raw_item_id is null or p.version<>i.version or p.processor_revision<>w.processor_revision then 'pending'
      else m.decision end rule_decision,m.category topic,m.brand
from raw.items i join core.sources s on s.id=i.source_id
join core.workflows w on w.id=s.workflow_id
left join core.rss_sources rs on rs.source_id=s.id
left join core.mentions m on m.raw_item_id=i.id and m.raw_version=i.version and not m.deleted
left join core.processing_receipts p on p.raw_item_id=i.id
left join core.review_decisions r on r.mention_id=m.id and r.raw_version=i.version
where not i.deleted and s.enabled and w.enabled and s.llm_allowed
 and length(trim(s.llm_basis))>=10 and (s.kind<>'rss' or rs.rights_status='allowed');

create or replace view core.current_ai_summaries with (security_barrier=true) as
select a.* from core.ai_summaries a where a.body->'provenance'->'source_states' is not null
and not exists (
 select 1 from jsonb_array_elements(a.input_versions) v
 left join core.analyst_items i on i.id=(v->>'id')::bigint and i.workflow_id=a.workflow_id
 where i.id is null or i.version<>(v->>'version')::integer
   or i.rule_decision is distinct from v->>'rule_decision'
) and not exists (
 select 1 from unnest(a.source_ids) sid
 left join core.analyst_rollup_state st on st.source_id=sid and st.workflow_id=a.workflow_id
 left join lateral (
  select v from jsonb_array_elements(a.body->'provenance'->'source_states') v
  where (v->>'source_id')::bigint=sid
 ) snapshot on true
 where st.source_id is null or snapshot.v is null
   or st.invalidated_at is distinct from (snapshot.v->>'invalidated_at')::timestamptz
   or (a."window"='30d' and (st.dirty or st.generated_at is null))
);

do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_analyst') then
  grant select on core.analyst_rollup_state to ufv_analyst;
 end if;
end $$;
