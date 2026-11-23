// The package's SQL. Every read returns one row with one text column of JSON
// built in Postgres, which the code parses and checks itself: whatever the
// app's postgres.js client does with arrays (fetch_types off), dates
// (drizzle's parsers) or column names (a camel-case transform), what arrives
// here is the same. Lists go in as JSON too (`${JSON.stringify(list)}::text::jsonb`),
// never as Postgres array parameters, and always cast through text
// (`::text::jsonb`): a client told the parameter is jsonb would encode the
// string a second time.
//
// Locks, everywhere the same order so two changes never wait on each other in
// a circle: team_employees rows (by user_id), then team_roles rows (by id).
import type { TeamSql } from '../config';
import { UUID } from '../shared/api';

type Tx = TeamSql;

export type StoredRole = Readonly<{
  id: string;
  name: string;
  pages: string[];
  actions: string[];
  version: number;
  updatedAt: string;
  people: number;
}>;

export type StoredEmployee = Readonly<{
  id: string;
  addedAt: string;
  addedBy: string | null;
  roleIds: string[];
}>;

export type HistoryInsert = Readonly<{
  actorId: string | null;
  action: string;
  subjectKind: 'role' | 'employee' | 'account';
  subjectId: string;
  detail: Record<string, unknown>;
}>;

export type StoredHistory = Readonly<{
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  subjectKind: string;
  subjectId: string;
  detail: Record<string, unknown>;
}>;

/** A Postgres error, as postgres.js throws it. */
export type PgError = Error & { code?: string; constraint_name?: string };

export function pgCode(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as PgError).code === 'string' ? (error as PgError).code! : null;
}

export function pgConstraint(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as PgError).constraint_name === 'string' ? (error as PgError).constraint_name! : null;
}

/** The single text column of a one-row answer, parsed. */
function one(rows: readonly Record<string, unknown>[]): unknown {
  const row = rows[0];
  if (!row) return null;
  const value = Object.values(row)[0];
  return typeof value === 'string' ? JSON.parse(value) : value;
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Every change locks the rows it touches and reads them again under the
 * lock, which is right at read committed only. On a database whose default
 * is repeatable read or serializable, the save that waited would fail with
 * a serialization error where it should answer "someone else changed this",
 * so each transaction names its isolation level.
 */
const ISOLATION = 'isolation level read committed';

/** Runs `work` in one read committed transaction; once more if Postgres picked it to break a deadlock. */
export async function inTransaction<T>(sql: TeamSql, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return (await sql.begin(ISOLATION, (tx) => work(tx as unknown as Tx))) as T;
  } catch (error) {
    if (pgCode(error) !== '40P01') throw error;
    return (await sql.begin(ISOLATION, (tx) => work(tx as unknown as Tx))) as T;
  }
}

// ---------------------------------------------------------------- reads

/** What one account's roles give: on the team or not, and the union of their roles' grants and actions. Null when the answer had another shape. */
export async function readAccess(sql: TeamSql, userId: string): Promise<{ employee: boolean; pages: string[]; actions: string[] } | null> {
  const rows = await sql`
    with me as (
      select exists (select 1 from team_employees where user_id = ${userId}::text) as employee
    ), granted as (
      select r.pages, r.actions
      from team_employee_roles er
      join team_roles r on r.id = er.role_id
      where er.user_id = ${userId}::text
    )
    select json_build_object(
      'employee', me.employee,
      'pages', coalesce((select jsonb_agg(distinct p.k) from granted g cross join lateral jsonb_array_elements_text(g.pages) as p(k)), '[]'::jsonb),
      'actions', coalesce((select jsonb_agg(distinct a.k) from granted g cross join lateral jsonb_array_elements_text(g.actions) as a(k)), '[]'::jsonb)
    )::text as j
    from me
  `;
  const out = one(rows) as { employee?: unknown; pages?: unknown; actions?: unknown } | null;
  if (!out || typeof out.employee !== 'boolean' || !isStringList(out.pages) || !isStringList(out.actions)) return null;
  return { employee: out.employee, pages: out.pages, actions: out.actions };
}

function parseRole(raw: unknown): StoredRole | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !isStringList(r.pages) || !isStringList(r.actions)) return null;
  const version = Number(r.version);
  const people = Number(r.people ?? 0);
  if (!Number.isInteger(version) || version < 1 || !Number.isFinite(people)) return null;
  return { id: r.id, name: r.name, pages: r.pages, actions: r.actions, version, updatedAt: String(r.updatedAt ?? ''), people };
}

function parseEmployee(raw: unknown): StoredEmployee | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e.id !== 'string' || !isStringList(e.roleIds)) return null;
  return { id: e.id, addedAt: String(e.addedAt ?? ''), addedBy: asString(e.addedBy), roleIds: [...e.roleIds].sort() };
}

const ROLE_JSON = (alias: string) => `json_build_object(
  'id', ${alias}.id, 'name', ${alias}.name, 'pages', ${alias}.pages, 'actions', ${alias}.actions,
  'version', ${alias}.version, 'updatedAt', ${alias}.updated_at,
  'people', (select count(*) from team_employee_roles er where er.role_id = ${alias}.id))`;

/** Every role and every employee, for the Team page. */
export async function readTeam(sql: TeamSql): Promise<{ roles: StoredRole[]; employees: StoredEmployee[] }> {
  const rows = await sql.unsafe(`
    select json_build_object(
      'roles', coalesce((select json_agg(${ROLE_JSON('r')} order by lower(r.name), r.id) from team_roles r), '[]'::json),
      'employees', coalesce((
        select json_agg(json_build_object(
          'id', e.user_id, 'addedAt', e.added_at, 'addedBy', e.added_by,
          'roleIds', coalesce((select json_agg(er.role_id order by er.role_id) from team_employee_roles er where er.user_id = e.user_id), '[]'::json))
          order by e.added_at, e.user_id)
        from team_employees e), '[]'::json)
    )::text as j
  `);
  const out = one(rows) as { roles?: unknown; employees?: unknown } | null;
  const roles = Array.isArray(out?.roles) ? out!.roles.map(parseRole).filter((r): r is StoredRole => r !== null) : [];
  const employees = Array.isArray(out?.employees) ? out!.employees.map(parseEmployee).filter((e): e is StoredEmployee => e !== null) : [];
  return { roles, employees };
}

/** One role, or null. In a transaction, `lock` takes it for update. */
export async function readRole(tx: Tx, roleId: string, lock: 'none' | 'update' = 'none'): Promise<StoredRole | null> {
  if (!UUID.test(roleId)) return null;
  if (lock === 'update') await tx`select id from team_roles where id = ${roleId}::uuid for update`;
  const rows = await tx.unsafe(`select ${ROLE_JSON('r')}::text as j from team_roles r where r.id = $1::uuid`, [roleId]);
  return parseRole(one(rows));
}

/** The roles with these ids that still exist, taken for share in id order (so they can't be deleted under the change). */
export async function lockRolesForShare(tx: Tx, roleIds: readonly string[]): Promise<StoredRole[]> {
  const ids = [...new Set(roleIds)].filter((id) => UUID.test(id)).sort();
  if (ids.length === 0) return [];
  await tx`
    select id from team_roles
    where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))
    order by id
    for share
  `;
  const rows = await tx.unsafe(
    `select coalesce(json_agg(${ROLE_JSON('r')} order by r.id), '[]'::json)::text as j
     from team_roles r where r.id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))`,
    [JSON.stringify(ids)],
  );
  const out = one(rows);
  return Array.isArray(out) ? out.map(parseRole).filter((r): r is StoredRole => r !== null) : [];
}

/**
 * Locks these employees' rows in user_id order: `update` for the people the
 * change is about, `share` for the actor. Answers which of them are on the
 * team, with their role ids.
 */
export async function lockEmployees(
  tx: Tx,
  wanted: ReadonlyArray<Readonly<{ id: string; mode: 'update' | 'share' }>>,
): Promise<Map<string, StoredEmployee>> {
  const byId = new Map<string, 'update' | 'share'>();
  for (const { id, mode } of wanted) if (byId.get(id) !== 'update') byId.set(id, mode);
  const found = new Map<string, StoredEmployee>();
  for (const id of [...byId.keys()].sort()) {
    const rows =
      byId.get(id) === 'update'
        ? await tx`select user_id from team_employees where user_id = ${id}::text for update`
        : await tx`select user_id from team_employees where user_id = ${id}::text for share`;
    if (rows.length === 0) continue;
    const employee = await readEmployee(tx, id);
    if (employee) found.set(id, employee);
  }
  return found;
}

export async function readEmployee(tx: Tx, userId: string): Promise<StoredEmployee | null> {
  const rows = await tx`
    select json_build_object(
      'id', e.user_id, 'addedAt', e.added_at, 'addedBy', e.added_by,
      'roleIds', coalesce((select json_agg(er.role_id order by er.role_id) from team_employee_roles er where er.user_id = e.user_id), '[]'::json)
    )::text as j
    from team_employees e where e.user_id = ${userId}::text
  `;
  return parseEmployee(one(rows));
}

/** These roles as they are now, without locking them. */
export async function readRolesByIds(tx: Tx, roleIds: readonly string[]): Promise<StoredRole[]> {
  const ids = [...new Set(roleIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const rows = await tx.unsafe(
    `select coalesce(json_agg(${ROLE_JSON('r')} order by r.id), '[]'::json)::text as j
     from team_roles r where r.id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))`,
    [JSON.stringify(ids)],
  );
  const out = one(rows);
  return Array.isArray(out) ? out.map(parseRole).filter((r): r is StoredRole => r !== null) : [];
}

/** The employees holding a role, with all their role ids. */
export async function readHolders(tx: Tx, roleId: string): Promise<StoredEmployee[]> {
  const rows = await tx`
    select coalesce(json_agg(json_build_object(
      'id', e.user_id, 'addedAt', e.added_at, 'addedBy', e.added_by,
      'roleIds', coalesce((select json_agg(x.role_id order by x.role_id) from team_employee_roles x where x.user_id = e.user_id), '[]'::json)
    ) order by e.user_id), '[]'::json)::text as j
    from team_employees e
    where e.user_id in (select er.user_id from team_employee_roles er where er.role_id = ${roleId}::uuid)
  `;
  const out = one(rows);
  return Array.isArray(out) ? out.map(parseEmployee).filter((e): e is StoredEmployee => e !== null) : [];
}

/** The grants and actions of these roles together. */
export function unionOf(roles: readonly StoredRole[]): { pages: string[]; actions: string[] } {
  return { pages: [...new Set(roles.flatMap((r) => r.pages))], actions: [...new Set(roles.flatMap((r) => r.actions))] };
}

export async function readHistory(sql: TeamSql, before: string | null, limit: number): Promise<StoredHistory[]> {
  const rows = await sql`
    select coalesce(json_agg(json_build_object(
      'id', h.id::text, 'at', h.at, 'actorId', h.actor_id, 'action', h.action,
      'subjectKind', h.subject_kind, 'subjectId', h.subject_id, 'detail', h.detail
    ) order by h.id desc), '[]'::json)::text as j
    from (
      select * from team_history
      where ${before}::bigint is null or id < ${before}::bigint
      order by id desc
      limit ${limit}
    ) h
  `;
  const out = one(rows);
  if (!Array.isArray(out)) return [];
  return out.flatMap((raw) => {
    const h = raw as Record<string, unknown>;
    if (typeof h.id !== 'string' || typeof h.action !== 'string' || typeof h.subjectId !== 'string') return [];
    const detail = h.detail && typeof h.detail === 'object' && !Array.isArray(h.detail) ? (h.detail as Record<string, unknown>) : {};
    return [{ id: h.id, at: String(h.at ?? ''), actorId: asString(h.actorId), action: h.action, subjectKind: String(h.subjectKind ?? ''), subjectId: h.subjectId, detail }];
  });
}

// ---------------------------------------------------------------- writes (inside a transaction)

export async function insertHistory(tx: Tx, row: HistoryInsert): Promise<void> {
  await tx`
    insert into team_history (actor_id, action, subject_kind, subject_id, detail)
    values (${row.actorId}::text, ${row.action}, ${row.subjectKind}, ${row.subjectId}::text, ${JSON.stringify(row.detail)}::text::jsonb)
  `;
}

/** A new role with the page's own id; null when a role with that id is already there (a double click). */
export async function insertRole(
  tx: Tx,
  role: Readonly<{ id: string; name: string; pages: readonly string[]; actions: readonly string[]; by: string | null }>,
): Promise<boolean> {
  const rows = await tx`
    insert into team_roles (id, name, pages, actions, created_by, updated_by)
    values (${role.id}::uuid, ${role.name}, ${JSON.stringify(role.pages)}::text::jsonb, ${JSON.stringify(role.actions)}::text::jsonb, ${role.by}::text, ${role.by}::text)
    on conflict (id) do nothing
    returning id
  `;
  return rows.length > 0;
}

/** Changes a role if it is still at `version`; true when it was. */
export async function updateRole(
  tx: Tx,
  role: Readonly<{ id: string; version: number; name: string; pages: readonly string[]; actions: readonly string[]; by: string | null }>,
): Promise<boolean> {
  const rows = await tx`
    update team_roles
       set name = ${role.name}, pages = ${JSON.stringify(role.pages)}::text::jsonb, actions = ${JSON.stringify(role.actions)}::text::jsonb,
           version = version + 1, updated_at = now(), updated_by = ${role.by}::text
     where id = ${role.id}::uuid and version = ${role.version}::int
    returning id
  `;
  return rows.length > 0;
}

export async function deleteRole(tx: Tx, roleId: string, version: number): Promise<boolean> {
  const rows = await tx`delete from team_roles where id = ${roleId}::uuid and version = ${version}::int returning id`;
  return rows.length > 0;
}

/** Puts someone on the team; false when they already were. */
export async function insertEmployee(tx: Tx, userId: string, by: string | null): Promise<boolean> {
  const rows = await tx`
    insert into team_employees (user_id, added_by) values (${userId}::text, ${by}::text)
    on conflict (user_id) do nothing
    returning user_id
  `;
  return rows.length > 0;
}

export async function giveRoles(tx: Tx, userId: string, roleIds: readonly string[], by: string | null): Promise<void> {
  if (roleIds.length === 0) return;
  await tx`
    insert into team_employee_roles (user_id, role_id, given_by)
    select ${userId}::text, value::uuid, ${by}::text from jsonb_array_elements_text(${JSON.stringify([...roleIds].sort())}::text::jsonb)
    on conflict (user_id, role_id) do nothing
  `;
}

export async function takeRoles(tx: Tx, userId: string, roleIds: readonly string[]): Promise<void> {
  if (roleIds.length === 0) return;
  await tx`
    delete from team_employee_roles
    where user_id = ${userId}::text
      and role_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(roleIds)}::text::jsonb))
  `;
}

export async function deleteEmployee(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx`delete from team_employees where user_id = ${userId}::text returning user_id`;
  return rows.length > 0;
}

/** Roles that hold any of these keys, for removing keys that left the app. */
export async function rolesHolding(tx: Tx, keys: readonly string[]): Promise<StoredRole[]> {
  if (keys.length === 0) return [];
  const rows = await tx.unsafe(
    `select coalesce(json_agg(${ROLE_JSON('r')} order by r.id), '[]'::json)::text as j
     from team_roles r
     where exists (select 1 from jsonb_array_elements_text(r.pages) p where p in (select jsonb_array_elements_text($1::text::jsonb)))
        or exists (select 1 from jsonb_array_elements_text(r.actions) a where a in (select jsonb_array_elements_text($1::text::jsonb)))`,
    [JSON.stringify(keys)],
  );
  const out = one(rows);
  return Array.isArray(out) ? out.map(parseRole).filter((r): r is StoredRole => r !== null) : [];
}
