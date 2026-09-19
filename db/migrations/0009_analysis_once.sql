-- Разова модельна розмітка; не замінює правила, людські рішення або raw.
create table core.analysis_runs (
 id uuid primary key,
 workflow_id bigint not null references core.workflows(id),
 created_at timestamptz not null default now(),
 cutoff_at timestamptz not null,
 completed_at timestamptz,
 model text not null,
 prompt_version text not null,
 scope jsonb not null,
 status text not null check(status in ('running','complete','partial','failed')),
 total integer not null check(total>=0),
 note text not null
);
create table core.analysis_labels (
 run_id uuid not null references core.analysis_runs(id),
 raw_item_id bigint not null references raw.items(id),
 raw_version integer not null,
 label jsonb not null,
 analyzed_at timestamptz not null default now(),
 primary key(run_id,raw_item_id)
);
create index analysis_labels_item on core.analysis_labels(raw_item_id,raw_version);
create table core.search_briefs (
 id bigint generated always as identity primary key,
 workflow_id bigint not null references core.workflows(id),
 searched_at timestamptz not null,
 query text not null,
 url text not null check(url like 'https://%'),
 publisher text not null,
 title text not null,
 published_on date,
 summary text not null,
 evidence_quote text not null,
 topic text not null,
 verification text not null,
 unique(workflow_id,searched_at,url)
);
do $$ begin
 if exists(select 1 from pg_roles where rolname='ufv_api') then
  grant select on core.analysis_runs,core.analysis_labels,core.search_briefs to ufv_api;
 end if;
end $$;
