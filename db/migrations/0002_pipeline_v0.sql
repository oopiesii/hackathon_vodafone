-- ЧЕРНЕТКА v0 контракту пайплайна. Поля взято з docs/CONTEXT.md («Обговорена архітектура», п. 1);
-- типи й обов'язковість ще не погоджені командою. Персональні дані авторів не зберігаємо: полів автора немає навмисно.

create table core.sources (
  id          bigint generated always as identity primary key,
  kind        text        not null,               -- 'telegram' | 'rss' | ...
  external_id text        not null,               -- напр. username або id каналу
  title       text,
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  unique (kind, external_id)
);

-- Пише collector. Повторне отримання того самого матеріалу не створює дубль.
create table raw.items (
  id             bigint generated always as identity primary key,
  source_id      bigint      not null references core.sources (id),
  source_item_id text        not null,
  parent_item_id text,                            -- коментар → пост, для контексту
  url            text,
  published_at   timestamptz,                     -- невідоме лишається null, не підміняємо fetched_at
  fetched_at     timestamptz not null default now(),
  title          text,
  text           text        not null,
  content_hash   text        not null,
  metrics        jsonb       not null default '{}', -- перегляди, реакції: агрегати без ідентифікаторів людей
  processed_at   timestamptz,                     -- ставить processor; null = ще в черзі
  unique (source_id, source_item_id)
);
create index raw_items_unprocessed on raw.items (id) where processed_at is null;
create index raw_items_hash on raw.items (content_hash);

-- Пише processor, читає API. Висновки окремо від сирого матеріалу.
create table core.mentions (
  id           bigint generated always as identity primary key,
  raw_item_id  bigint      not null unique references raw.items (id),
  source_id    bigint      not null references core.sources (id),
  url          text,
  published_at timestamptz,
  category     text,
  severity     text check (severity in ('h', 'm', 'l')),
  summary      text        not null,
  quote        text,                              -- дослівна цитата з raw.items.text
  analyzed_at  timestamptz not null default now()
);
create index core_mentions_published on core.mentions (published_at desc nulls last, id desc);
