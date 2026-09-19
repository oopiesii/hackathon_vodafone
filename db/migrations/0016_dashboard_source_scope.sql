-- The server-side import CLI can move an existing source to another workflow.
-- Invalidate its generation in the same transaction; old-workflow aggregates
-- must not remain available to dashboard or analyst readers until next refresh.
create function core.invalidate_moved_dashboard_source() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
 insert into core.dashboard_rollup_state(source_id) values(new.id)
 on conflict(source_id) do update set dirty=true,invalidated_at=clock_timestamp();
 -- Lock order matches refresh_dashboard_rollups: state first, aggregates second.
 delete from core.daily_rollups where source_id=new.id;
 return null;
end $$;
revoke all on function core.invalidate_moved_dashboard_source() from public;
create trigger dashboard_source_workflow_changed after update of workflow_id on core.sources
 for each row when(old.workflow_id is distinct from new.workflow_id)
 execute function core.invalidate_moved_dashboard_source();
