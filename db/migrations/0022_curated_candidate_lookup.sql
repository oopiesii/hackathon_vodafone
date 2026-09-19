-- Keep each candidate lookup parameterized: do not expand the entire raw stream per candidate.
-- Limit expensive current-context and reaction lookups to potential visible records.
-- Currentness and human override are still rechecked by curated_items; no cache.
create or replace view core.curated_visible_items as
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
select d.* from candidates c
cross join lateral (select * from core.curated_items d where d.raw_item_id=c.raw_item_id offset 0) d
where d.decision in ('accepted','review');
