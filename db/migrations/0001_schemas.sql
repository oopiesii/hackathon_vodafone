-- Межі володіння даними. Сервіс пише лише у свою схему, читати може сусідню.
--   auth — apps/api (Better Auth): користувачі, сесії, ролі. Таблиці створює `npm run auth:migrate`.
--   raw  — services/collector-*: сирі матеріали для повторної обробки.
--   core — services/processor: нормалізоване й проаналізоване; звідси читає apps/api.
create schema if not exists auth;
create schema if not exists raw;
create schema if not exists core;
