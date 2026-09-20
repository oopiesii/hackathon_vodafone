-- A large permission change already touches most monitored sources. In that case
-- marking every source dirty is both conservative and much cheaper than searching
-- every historical context_versions JSON value for cross-source replies.

create or replace function core.invalidate_curated_sources_update() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
declare ids bigint[];
begin
 select coalesce(array_agg(n.id),'{}') into ids
 from new_sources n join old_sources o using(id)
 where row(n.workflow_id,n.enabled,n.llm_allowed,n.llm_basis,n.kind)
   is distinct from row(o.workflow_id,o.enabled,o.llm_allowed,o.llm_basis,o.kind);
 if coalesce(array_length(ids,1),0)=0 then return null; end if;
 if array_length(ids,1)>=16 then
  perform core.mark_curated_sources_dirty(array(select id from core.sources));
 else
  perform core.mark_curated_sources_dirty(array(
   select unnest(ids)
   union
   select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
   where exists(select 1 from raw.items parent where parent.source_id=any(ids)
    and l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',parent.id)))
  ));
 end if;
 return null;
end $$;

revoke all on function core.invalidate_curated_sources_update() from public;
