-- Reviews/deletions must never remain visible to a viewer via yesterday's rollup.
-- Rebuilding is asynchronous; an invalidated source has no aggregate until refreshed.
create function core.invalidate_dashboard_rollups() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 if tg_table_name='review_decisions' then
  delete from core.daily_rollups where source_id=(select source_id from core.mentions where id=coalesce(new.mention_id,old.mention_id));
 elsif tg_table_name='workflows' then
  delete from core.daily_rollups where workflow_id=new.id;
 else
  delete from core.daily_rollups where source_id=coalesce(new.source_id,old.source_id);
 end if;
 return null;
end $$;
revoke all on function core.invalidate_dashboard_rollups() from public;
create trigger dashboard_review_changed after insert or update or delete on core.review_decisions
 for each row execute function core.invalidate_dashboard_rollups();
create trigger dashboard_item_changed after update of version,deleted on raw.items
 for each row when(old.version is distinct from new.version or old.deleted is distinct from new.deleted)
 execute function core.invalidate_dashboard_rollups();
create trigger dashboard_item_deleted after delete on raw.items
 for each row execute function core.invalidate_dashboard_rollups();
create trigger dashboard_mention_changed after update of decision,raw_version,category,brand,deleted on core.mentions
 for each row when(old.decision is distinct from new.decision or old.raw_version is distinct from new.raw_version
  or old.category is distinct from new.category or old.brand is distinct from new.brand or old.deleted is distinct from new.deleted)
 execute function core.invalidate_dashboard_rollups();
create trigger dashboard_workflow_reprocess after update of processor_revision on core.workflows
 for each row when(old.processor_revision is distinct from new.processor_revision)
 execute function core.invalidate_dashboard_rollups();
