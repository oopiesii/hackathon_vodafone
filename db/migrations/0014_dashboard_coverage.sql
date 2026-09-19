-- Per-source atomic rollup generations with visible coverage, no silent partial totals.
create table core.dashboard_rollup_state (
 source_id bigint primary key references core.sources(id) on delete cascade,
 dirty boolean not null default true, generated_at timestamptz, invalidated_at timestamptz not null default now()
);
insert into core.dashboard_rollup_state(source_id) select id from core.sources;
create or replace function core.invalidate_dashboard_rollups() returns trigger language plpgsql security definer
set search_path=pg_catalog,core as $$
begin
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
-- A generation is published together with all its aggregates. Row locks serialize
-- invalidation; a concurrent edit marks the source dirty again after this commit.
create or replace function core.refresh_dashboard_rollups() returns void language plpgsql security definer
set search_path=pg_catalog,core as $$
declare targets bigint[];
begin
 if not pg_try_advisory_xact_lock(727115) then return; end if;
 insert into core.dashboard_rollup_state(source_id) select id from core.sources on conflict do nothing;
 select array_agg(source_id) into targets from (
  select source_id from core.dashboard_rollup_state
   where dirty or generated_at is null or generated_at<now()-interval '60 seconds'
   order by source_id for update
 ) pending;
 if targets is null then return; end if;
 delete from core.daily_rollups where source_id=any(targets);
 insert into core.daily_rollups(day,workflow_id,source_id,source_kind,topic,brand,decision,count,negative_count,
 negative_reach,views_measured,reaction_negative,reaction_ironic,reaction_sad,reaction_positive,reactions_measured,lag_samples,complaints)
 select (event_at at time zone 'Europe/Kyiv')::date,workflow_id,source_id,source_kind,coalesce(topic,'other'),coalesce(brand,'telecom'),decision,
 count(*)::int,count(*) filter(where negative)::int,
 coalesce(sum(views) filter(where negative and decision='accepted'),0)::bigint,
 count(views) filter(where negative and decision='accepted')::int,
 coalesce(sum(rx.neg),0),coalesce(sum(rx.ironic),0),coalesce(sum(rx.sad),0),coalesce(sum(rx.pos),0),
 count(reactions)::int,coalesce(array_agg(lag_seconds) filter(where lag_seconds is not null),'{}'),
 count(*) filter(where negative and kind='comment' and watch_active)::int
 from core.dashboard_items d
 left join lateral (
  select sum(value::bigint) filter(where key=any(array['👎','😡','🤬','🤮','💩','🤡'])) neg,
   sum(value::bigint) filter(where key=any(array['🤣','😁','😈'])) ironic,
   sum(value::bigint) filter(where key=any(array['😢','💔','😭'])) sad,
   sum(value::bigint) filter(where not(key=any(array['👎','😡','🤬','🤮','💩','🤡','🤣','😁','😈','😢','💔','😭']))) pos
  from jsonb_each_text(case when jsonb_typeof(d.reactions)='object' then d.reactions else '{}'::jsonb end) where value ~ '^\d+$'
 ) rx on true
 where source_id=any(targets) and event_at>=((now() at time zone 'Europe/Kyiv')::date-29)::timestamp at time zone 'Europe/Kyiv'
 and event_at<=now() and decision<>'deleted'
 and (kind<>'comment' or (watch_active and event_at>=now()-interval '7 days'))
 group by 1,2,3,4,5,6,7;
 update core.dashboard_rollup_state set dirty=false,generated_at=clock_timestamp() where source_id=any(targets);
end $$;
create view core.dashboard_rollup_coverage as
 select s.workflow_id,count(*)::int source_count,
 count(*) filter(where st.source_id is null or st.dirty or st.generated_at is null)::int dirty_sources,
 min(st.generated_at) generated_at
 from core.sources s left join core.dashboard_rollup_state st on st.source_id=s.id group by s.workflow_id;
revoke all on function core.invalidate_dashboard_rollups() from public;
revoke all on function core.refresh_dashboard_rollups() from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.dashboard_rollup_state,core.dashboard_rollup_coverage to ufv_api;
 end if;
end $$;
select core.refresh_dashboard_rollups();
