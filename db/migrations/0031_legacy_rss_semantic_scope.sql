-- The first authorized RSS run predates source_ids and used {"rss":"allowed"}.
-- Match only that explicit legacy contract; empty scopes and Telegram never qualify.
create or replace view core.semantic_source_runs as
select ar.id run_id,s.id source_id
from core.analysis_runs ar join core.sources s on s.workflow_id=ar.workflow_id
join core.workflows w on w.id=s.workflow_id
left join core.rss_sources rss on rss.source_id=s.id
where (
 coalesce(ar.scope->>'mode','')<>'continuous' and ar.status='complete'
 and (
  (jsonb_typeof(ar.scope->'source_ids')='array'
   and ar.scope->'source_ids' @> jsonb_build_array(s.id)
   and (ar.scope->>'source_kind' is null or ar.scope->>'source_kind'=s.kind))
  or (not (ar.scope ? 'source_ids') and ar.scope->>'rss'='allowed'
   and s.kind='rss' and rss.rights_status='allowed'
   and (ar.scope->>'source_kind' is null or ar.scope->>'source_kind'='rss'))
 )
) or (
 ar.scope->>'mode'='continuous' and ar.status in ('running','complete')
 and s.enabled and w.enabled and s.llm_allowed and length(trim(s.llm_basis))>=10
 and (s.kind<>'rss' or rss.rights_status='allowed')
);
-- Existing snapshots may have omitted these labels under the stricter 0030 gate.
select core.mark_curated_sources_dirty(array(
 select distinct s.id from core.sources s join core.analysis_runs ar on ar.workflow_id=s.workflow_id
 where s.kind='rss' and ar.status='complete' and not (ar.scope ? 'source_ids')
 and ar.scope->>'rss'='allowed' and coalesce(ar.scope->>'mode','')<>'continuous'
));
