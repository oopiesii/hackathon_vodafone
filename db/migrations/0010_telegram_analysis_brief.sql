alter table core.analysis_runs add column progress jsonb not null default '{}';
create table core.analysis_briefs (
 run_id uuid primary key references core.analysis_runs(id),
 model text not null,
 brief jsonb not null,
 generated_at timestamptz not null default now()
);
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.analysis_briefs to ufv_api;
 end if;
end $$;
