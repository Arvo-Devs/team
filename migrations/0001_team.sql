-- @arvo/team 0001: the company's own team.
--
--   team_roles           a role: a name, and the app's pages and actions it opens
--   team_employees       who is on the team (the company's own staff, never customers)
--   team_employee_roles  which roles each person holds
--   team_history         every change to the three above; append-only
--
-- Company-level tables, like Better Auth's and the framework's Mass Access
-- record: no organization_id and no row-level security. Names and emails of
-- accounts are read live from the app and never kept here. team_history keeps
-- account ids, role names and page grants with their labels, never an email,
-- because nothing can remove a row from it.
--
-- pages and actions are jsonb arrays of strings, never text[]: a postgres.js
-- client with fetch_types off reads a text[] as one string, and a check on
-- that string could match part of a grant.
--
-- Unqualified names on purpose: everything goes in the schema the migration
-- runs in. Postgres 14 or later. Every statement can run twice. Never edit
-- this file once applied: a later version adds 0002. An app whose
-- low-privilege login is not app_user grants the same rights to its own login
-- (README, "Grants").

create table if not exists team_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pages jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint team_roles_name_check check (char_length(name) between 1 and 60 and name = btrim(name) and name !~ '[[:space:]]{2}'),
  constraint team_roles_pages_check check (
    jsonb_typeof(pages) = 'array' and jsonb_array_length(pages) <= 500
    and not jsonb_path_exists(pages, '$[*] ? (@.type() != "string")')),
  constraint team_roles_actions_check check (
    jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 500
    and not jsonb_path_exists(actions, '$[*] ? (@.type() != "string")')),
  constraint team_roles_version_check check (version >= 1)
);
--> statement-breakpoint
create table if not exists team_employees (
  user_id text primary key,
  added_at timestamptz not null default now(),
  added_by text,
  constraint team_employees_user_id_check check (char_length(user_id) between 1 and 255)
);
--> statement-breakpoint
create table if not exists team_employee_roles (
  user_id text not null,
  role_id uuid not null,
  given_at timestamptz not null default now(),
  given_by text,
  constraint team_employee_roles_pkey primary key (user_id, role_id),
  constraint team_employee_roles_user_fk foreign key (user_id) references team_employees (user_id) on delete cascade,
  constraint team_employee_roles_role_fk foreign key (role_id) references team_roles (id) on delete cascade
);
--> statement-breakpoint
create table if not exists team_history (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id text,
  action text not null,
  subject_kind text not null,
  subject_id text not null,
  detail jsonb not null default '{}'::jsonb,
  constraint team_history_action_check check (action ~ '^[a-z]+([.][a-z_]+)+$'),
  constraint team_history_subject_kind_check check (subject_kind in ('role', 'employee', 'account')),
  constraint team_history_detail_check check (jsonb_typeof(detail) = 'object')
);
--> statement-breakpoint
-- Stop if a table here already had one of these names and is not this
-- package's: "create table if not exists" above keeps such a table without a word.
do $team$
declare
  missing text;
begin
  select string_agg(want.t || '.' || want.c, ', ') into missing
  from (values ('team_roles', 'pages'), ('team_employees', 'added_by'), ('team_employee_roles', 'given_by'),
               ('team_history', 'subject_kind'))
       as want(t, c)
  where not exists (
    select 1 from information_schema.columns col
    where col.table_schema = current_schema() and col.table_name = want.t and col.column_name = want.c);
  if missing is not null then
    raise exception '@arvo/team: a table here has one of its names but not its columns (%); rename that table first', missing;
  end if;
end
$team$;
--> statement-breakpoint
create unique index if not exists team_roles_name_unique on team_roles (lower(name));
--> statement-breakpoint
create index if not exists team_employee_roles_role_idx on team_employee_roles (role_id);
--> statement-breakpoint
create index if not exists team_history_subject_idx on team_history (subject_kind, subject_id, id);
--> statement-breakpoint
create or replace function team_history_refuse_change() returns trigger
language plpgsql as $team$
begin
  raise exception 'team_history is append-only: % refused', tg_op
    using errcode = 'insufficient_privilege';
end
$team$;
--> statement-breakpoint
create or replace trigger team_history_append_only
  before update or delete on team_history
  for each row execute function team_history_refuse_change();
--> statement-breakpoint
create or replace trigger team_history_no_truncate
  before truncate on team_history
  for each statement execute function team_history_refuse_change();
--> statement-breakpoint
-- Default privileges hand an app login every new table (the framework's
-- create-app-role.sql); take history back to read and add only. The trigger
-- above refuses for every login that does not own the table.
do $team$
begin
  revoke all on table team_history from public;
  if exists (select from pg_roles where rolname = 'app_user') then
    grant select, insert, update, delete on table team_roles, team_employees, team_employee_roles to app_user;
    revoke all on table team_history from app_user;
    grant select, insert on table team_history to app_user;
  end if;
end
$team$;
