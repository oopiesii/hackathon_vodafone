-- Source permissions are commonly changed in bulk. The original row trigger scanned
-- analysis_labels once per source, making a 68-source admin action take minutes.
-- Transition-table triggers collect the whole statement and invalidate once.

create function core.invalidate_curated_sources_insert() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
declare ids bigint[];
begin
 select coalesce(array_agg(id),'{}') into ids from new_sources;
 perform core.mark_curated_sources_dirty(array(
  select unnest(ids)
  union
  select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
  where exists(select 1 from raw.items parent where parent.source_id=any(ids)
   and l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',parent.id)))
 ));
 return null;
end $$;

create function core.invalidate_curated_sources_update() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
declare ids bigint[];
begin
 select coalesce(array_agg(n.id),'{}') into ids
 from new_sources n join old_sources o using(id)
 where row(n.workflow_id,n.enabled,n.llm_allowed,n.llm_basis,n.kind)
   is distinct from row(o.workflow_id,o.enabled,o.llm_allowed,o.llm_basis,o.kind);
 if coalesce(array_length(ids,1),0)=0 then return null; end if;
 perform core.mark_curated_sources_dirty(array(
  select unnest(ids)
  union
  select child.source_id from core.analysis_labels l join raw.items child on child.id=l.raw_item_id
  where exists(select 1 from raw.items parent where parent.source_id=any(ids)
   and l.label->'context_versions' @> jsonb_build_array(jsonb_build_object('id',parent.id)))
 ));
 return null;
end $$;

drop trigger curated_source_added on core.sources;
drop trigger curated_source_changed on core.sources;

create trigger curated_source_added after insert on core.sources
 referencing new table as new_sources for each statement
 execute function core.invalidate_curated_sources_insert();
create trigger curated_source_changed after update on core.sources
 referencing old table as old_sources new table as new_sources for each statement
 execute function core.invalidate_curated_sources_update();

revoke all on function core.invalidate_curated_sources_insert() from public;
revoke all on function core.invalidate_curated_sources_update() from public;
