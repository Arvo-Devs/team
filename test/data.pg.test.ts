/**
 * The Team tables under real use, against a real Postgres: changes that land
 * at the same moment on separate connections, a role deleted while it is
 * being given, double clicks, what deleting a role or an account leaves
 * behind, the app login's rights on each table, the postgres.js settings
 * apps use, the tables in another schema, the migration run twice or onto
 * someone else's table, and the read every request makes.
 *
 * "At the same moment" is made sure of, not hoped for: a test holds a row
 * lock on its own connection until every request it started is waiting on
 * that lock inside its transaction (pg_stat_activity says so), then lets go.
 *
 * Runs only with TEAM_TEST_PG_URL (a Postgres the test may create databases
 * and logins on). Everything it makes is named for this run and dropped at
 * the end. History rows can't be deleted, so each test reads only the rows
 * newer than where it started.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { TeamConfig } from '../src/config';
import { createTeam, type Team, type TeamView } from '../src/index';
import { tokenOf } from '../src/server/team';
import type { AddResult, EmployeeView, HistoryPage, RoleView, TeamState } from '../src/shared/api';
import { cookieFor, fakeConfig, NAV, request, world, type FakeWorld, type Person } from './fake-app';

const ROOT_URL = process.env.TEAM_TEST_PG_URL ?? '';
const MIGRATIONS = join(import.meta.dir, '..', 'migrations');
const RUN = `${process.pid}_${Date.now()}`;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type ErrorBody = { error?: { type: string; code: string; message: string; param?: string } };
type Answer<T> = { status: number; body: T & ErrorBody };
type Options = NonNullable<Parameters<typeof postgres>[1]>;

/** The migration's statements, split where drizzle splits them. */
function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS, file), 'utf8'))
    .join('\n--> statement-breakpoint\n');
}

async function migrate(sql: postgres.Sql, rewrite: (text: string) => string = (text) => text) {
  for (const statement of rewrite(migrationText()).split('--> statement-breakpoint')) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function callOn<T = unknown>(t: Team<Person>, method: Method, path: string, who: string | null, body?: unknown): Promise<Answer<T>> {
  const response = await t.routeHandlers[method](request(`/api/team${path}`, { method, cookie: who ? cookieFor(who) : undefined, body }));
  return { status: response.status, body: (await response.json()) as T & ErrorBody };
}

/** What Postgres said when it refused; fails the test when the work went through. */
async function refusal(work: () => PromiseLike<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work();
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return { code: String(e.code), message: String(e.message) };
  }
  throw new Error('it went through, and it should have been refused');
}

/** A door the test opens later. */
function door() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const sortedView = (v: TeamView) => ({ ...v, pages: [...v.pages].sort(), actions: [...v.actions].sort() });

describe.skipIf(!ROOT_URL)('the team tables under real use (pg)', () => {
  const database = `team_data_${RUN}`;
  const ownerLogin = `team_owner_${RUN}`;
  const appLogin = `team_app_${RUN}`;
  const handLogin = `team_hand_${RUN}`;
  let admin: postgres.Sql; // the server's own database: makes and drops this run's database and logins
  let sql: postgres.Sql; // the test's pool on this run's database (the owner of public's tables)
  let w: FakeWorld;
  let team: Team<Person>;
  const opened: postgres.Sql[] = [];
  const doors: Array<() => void> = [];

  function urlFor(login?: string): string {
    const url = new URL(ROOT_URL);
    url.pathname = `/${database}`;
    if (login) {
      url.username = login;
      url.password = '';
    }
    return url.toString();
  }

  /** A client of its own, one connection unless the options say otherwise; ended after the test. */
  function connect(options: Options = {}, login?: string): postgres.Sql {
    const client = postgres(urlFor(login), { max: 1, onnotice: () => {}, ...options });
    opened.push(client);
    return client;
  }

  const teamOn = (db: postgres.Sql, overrides: Partial<TeamConfig<Person>> = {}) => createTeam(fakeConfig(w, { db: () => db, ...overrides }));
  const call = <T = unknown>(method: Method, path: string, who: string | null, body?: unknown) => callOn<T>(team, method, path, who, body);
  const state = (who: string) => call<TeamState>('GET', '', who);
  const user = (id: string, viewedAs = false): Person => ({ id, email: w.accounts.get(id)?.email, viewedAs });

  async function newRole(name: string, pages: string[], actions: string[] = [], who = 'olive'): Promise<RoleView> {
    const made = await call<RoleView>('POST', '/roles', who, { id: crypto.randomUUID(), name, pages, actions });
    expect(made.status).toBe(201);
    return made.body;
  }

  async function addPerson(email: string, roleIds: string[], who = 'olive'): Promise<AddResult> {
    const added = await call<AddResult>('POST', '/employees', who, { email, roleIds });
    expect(added.status).toBe(201);
    return added.body;
  }

  async function tokenFor(id: string, who = 'olive'): Promise<string> {
    const row = (await state(who)).body.employees.find((e) => e.id === id);
    if (!row) throw new Error(`${id} is not on the team`);
    return row.token;
  }

  async function rolesOf(userId: string): Promise<string[]> {
    return (await sql`select role_id::text as id from team_employee_roles where user_id = ${userId} order by role_id`).map((r) => r.id as string);
  }

  async function count(query: string, params: string[] = []): Promise<number> {
    return (await sql.unsafe(query, params))[0]!.n as number;
  }

  async function historyMark(db: postgres.Sql = sql): Promise<string> {
    return (await db`select coalesce(max(id), 0)::text as id from team_history`)[0]!.id as string;
  }

  async function historySince(mark: string, db: postgres.Sql = sql) {
    const rows = await db`select actor_id, action, subject_kind, subject_id, detail::text as detail from team_history where id > ${mark}::bigint order by id`;
    return rows.map((r) => ({
      actor: r.actor_id as string | null,
      action: r.action as string,
      kind: r.subject_kind as string,
      subject: r.subject_id as string,
      detail: JSON.parse(r.detail as string) as Record<string, unknown>,
    }));
  }

  /** Role rows whose role or person is gone (the foreign keys should make this always 0). */
  async function orphans(schema = 'public'): Promise<number> {
    return count(`select count(*)::int as n from ${schema}.team_employee_roles er
      where not exists (select 1 from ${schema}.team_roles r where r.id = er.role_id)
         or not exists (select 1 from ${schema}.team_employees e where e.user_id = er.user_id)`);
  }

  /** Takes row locks on a connection of its own and keeps them until the returned function is called. */
  async function hold(statement: string, params: string[] = []): Promise<() => Promise<void>> {
    const client = connect();
    const locked = door();
    const release = door();
    doors.push(release.open);
    const done = client.begin(async (tx) => {
      await tx.unsafe(statement, params);
      locked.open();
      await release.opened;
    });
    await Promise.race([locked.opened, done]);
    return async () => {
      release.open();
      await done;
    };
  }

  /** Waits until `n` queries on this run's database are waiting on a lock; fails if one of `pending` is answered first. */
  async function waitForLockWaits(n: number, pending: Array<Promise<unknown>> = []) {
    let answered: unknown;
    for (const p of pending) p.then((value) => (answered ??= value), (error) => (answered ??= String(error)));
    const until = Date.now() + 5000;
    for (;;) {
      const waiting = (await admin`select count(*)::int as n from pg_stat_activity where datname = ${database} and wait_event_type = 'Lock'`)[0]!.n as number;
      if (waiting >= n) return;
      if (answered !== undefined) throw new Error(`answered before ${n} were waiting on a lock: ${JSON.stringify(answered)}`);
      if (Date.now() > until) throw new Error(`${waiting} of ${n} waiting on a lock after 5 s`);
      await Bun.sleep(5);
    }
  }

  const notAnswered = () => w.logs.filter((line) => line.includes('not answered'));

  beforeAll(async () => {
    admin = postgres(ROOT_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    sql = postgres(urlFor(), { max: 4, onnotice: () => {} });
    await migrate(sql);
  });

  afterAll(async () => {
    for (const open of doors) open();
    await Promise.all(opened.map((client) => client.end({ timeout: 1 }).catch(() => {})));
    await sql?.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    for (const login of [appLogin, handLogin, ownerLogin]) await admin?.unsafe(`drop role if exists "${login}"`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`delete from team_employees`;
    await sql`delete from team_roles`;
    w = world();
    team = teamOn(sql);
  });

  afterEach(async () => {
    // A test that failed half way leaves no lock or connection behind for the next one.
    for (const open of doors.splice(0)) open();
    await Promise.all(opened.splice(0).map((client) => client.end({ timeout: 1 }).catch(() => {})));
  });

  // ------------------------------------------------------------ (1) at the same moment

  describe('two changes at the same moment, on separate connections', () => {
    test('two managers change the same person at once: one wins, the other gets 409 stale, nothing half-written', async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      const growth = await newRole('Growth', ['traffic']);
      const funnel = await newRole('Funnel', ['signup-funnel']);
      const all = [managers.id, support.id, growth.id, funnel.id];
      await addPerson('maya@example.com', all);
      await addPerson('bob@example.com', all);
      await addPerson('sam@example.com', [support.id]);
      const token = await tokenFor('sam');
      const mayaSide = teamOn(connect());
      const bobSide = teamOn(connect());
      const mark = await historyMark();

      // Both saves wait on Sam's row, so both are inside their transactions at once.
      const free = await hold(`select user_id from team_employees where user_id = 'sam' for update`);
      const maya = callOn<EmployeeView>(mayaSide, 'PATCH', '/employees/sam', 'maya', { roleIds: [growth.id], token });
      const bob = callOn<EmployeeView>(bobSide, 'PATCH', '/employees/sam', 'bob', { roleIds: [funnel.id], token });
      await waitForLockWaits(2, [maya, bob]);
      await free();
      const answers = await Promise.all([maya, bob]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      const mayaWon = answers[0]!.status === 200;
      const [won, lost] = mayaWon ? answers : [answers[1]!, answers[0]!];
      const given = mayaWon ? growth : funnel;
      expect(lost!.body.error?.code).toBe('stale');
      expect(won!.body.token).toBe(tokenOf([given.id]));
      expect(await rolesOf('sam')).toEqual([given.id]);
      const rows = await historySince(mark);
      expect(rows.map((r) => [r.action, r.subject, r.actor])).toEqual([['employee.roles_changed', 'sam', mayaWon ? 'maya' : 'bob']]);
      expect(rows[0]!.detail).toEqual({ added: [{ id: given.id, name: given.name }], removed: [{ id: support.id, name: 'Support' }] });
      expect(await orphans()).toBe(0);
      expect(notAnswered()).toEqual([]);
    });

    test('the same two saves racing round after round, no lock held: exactly one lands each round', async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      const growth = await newRole('Growth', ['traffic']);
      const funnel = await newRole('Funnel', ['signup-funnel']);
      const all = [managers.id, support.id, growth.id, funnel.id];
      await addPerson('maya@example.com', all);
      await addPerson('bob@example.com', all);
      await addPerson('sam@example.com', [support.id]);
      const mayaSide = teamOn(connect());
      const bobSide = teamOn(connect());
      const choices = [[support.id], [growth.id], [funnel.id], [support.id, growth.id], [growth.id, funnel.id]].map((c) => [...c].sort());

      for (let round = 0; round < 10; round++) {
        const now = await rolesOf('sam');
        const token = tokenOf(now);
        const others = choices.filter((c) => c.join() !== now.join());
        const forMaya = others[round % others.length]!;
        const forBob = others[(round + 1) % others.length]!;
        const mark = await historyMark();
        const answers = await Promise.all([
          callOn(mayaSide, 'PATCH', '/employees/sam', 'maya', { roleIds: forMaya, token }),
          callOn(bobSide, 'PATCH', '/employees/sam', 'bob', { roleIds: forBob, token }),
        ]);
        expect({ round, statuses: answers.map((a) => a.status).sort() }).toEqual({ round, statuses: [200, 409] });
        expect(answers.find((a) => a.status === 409)!.body.error?.code).toBe('stale');
        expect(await rolesOf('sam')).toEqual(answers[0]!.status === 200 ? forMaya : forBob);
        expect((await historySince(mark)).length).toBe(1);
      }
      expect(await orphans()).toBe(0);
      expect(notAnswered()).toEqual([]);
    });

    for (const isolation of ['repeatable read', 'serializable']) {
      test(`on a database whose default isolation is ${isolation}, two saves from the same token still answer one 200 and one 409 stale`, async () => {
        const managers = await newRole('Managers', ['team']);
        const support = await newRole('Support', ['email']);
        const growth = await newRole('Growth', ['traffic']);
        const funnel = await newRole('Funnel', ['signup-funnel']);
        const all = [managers.id, support.id, growth.id, funnel.id];
        await addPerson('maya@example.com', all);
        await addPerson('bob@example.com', all);
        await addPerson('sam@example.com', [support.id]);
        const token = await tokenFor('sam');
        // ALTER DATABASE ... SET default_transaction_isolation does the same for every connection.
        const setting = { connection: { default_transaction_isolation: isolation } } as Options;
        const mayaSide = teamOn(connect(setting));
        const bobSide = teamOn(connect(setting));
        const mark = await historyMark();

        // Both keep Support and give one more: Maya Growth, Bob Funnel.
        const free = await hold(`select user_id from team_employees where user_id = 'sam' for update`);
        const maya = callOn<EmployeeView>(mayaSide, 'PATCH', '/employees/sam', 'maya', { roleIds: [support.id, growth.id], token });
        const bob = callOn<EmployeeView>(bobSide, 'PATCH', '/employees/sam', 'bob', { roleIds: [support.id, funnel.id], token });
        await waitForLockWaits(2, [maya, bob]);
        await free();
        const answers = await Promise.all([maya, bob]);

        expect({
          statuses: answers.map((a) => a.status).sort(),
          codes: answers.map((a) => a.body.error?.code ?? null).sort(),
          rolesSamHas: (await rolesOf('sam')).length,
          historyRows: (await historySince(mark)).length,
        }).toEqual({ statuses: [200, 409], codes: [null, 'stale'], rolesSamHas: 2, historyRows: 1 });
      });
    }

    test('two people add the same email at once: one 201, one 409 already_employee, one row', async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      await addPerson('maya@example.com', [managers.id, support.id]);
      w.signedOut.length = 0;
      const oliveSide = teamOn(connect());
      const mayaSide = teamOn(connect());
      const mark = await historyMark();

      // Both adds wait for the role they give, inside their transactions.
      const free = await hold('select id from team_roles where id = $1::uuid for update', [support.id]);
      const byOlive = callOn<AddResult>(oliveSide, 'POST', '/employees', 'olive', { email: 'sam@example.com', roleIds: [support.id] });
      const byMaya = callOn<AddResult>(mayaSide, 'POST', '/employees', 'maya', { email: ' Sam@Example.com', roleIds: [support.id] });
      await waitForLockWaits(2, [byOlive, byMaya]);
      await free();
      const answers = await Promise.all([byOlive, byMaya]);

      expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
      expect(answers.find((a) => a.status === 409)!.body.error).toMatchObject({ code: 'already_employee', message: 'Sam Support is already an employee.' });
      const winner = answers[0]!.status === 201 ? 'olive' : 'maya';
      const rows = await sql`select user_id, added_by from team_employees where user_id = 'sam'`;
      expect(rows.map((r) => [r.user_id, r.added_by])).toEqual([['sam', winner]]);
      expect(await rolesOf('sam')).toEqual([support.id]);
      expect((await historySince(mark)).map((r) => [r.action, r.subject, r.actor])).toEqual([['employee.added', 'sam', winner]]);
      expect(w.signedOut).toEqual(['sam']);
      expect(await orphans()).toBe(0);
      expect(notAnswered()).toEqual([]);
    });

    test('a double click on Add employee with no roles: one 201, one 409 already_employee, one row', async () => {
      const managers = await newRole('Managers', ['team']);
      await addPerson('maya@example.com', [managers.id]);
      const first = teamOn(connect());
      const second = teamOn(connect());
      const mark = await historyMark();

      // Both clicks wait on Maya's own row (a change reads its actor for share).
      const free = await hold(`select user_id from team_employees where user_id = 'maya' for update`);
      const one = callOn<AddResult>(first, 'POST', '/employees', 'maya', { email: 'sam@example.com', roleIds: [] });
      const two = callOn<AddResult>(second, 'POST', '/employees', 'maya', { email: 'sam@example.com', roleIds: [] });
      await waitForLockWaits(2, [one, two]);
      await free();
      const answers = await Promise.all([one, two]);

      expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
      expect(answers.find((a) => a.status === 409)!.body.error?.code).toBe('already_employee');
      expect(await count(`select count(*)::int as n from team_employees where user_id = 'sam'`)).toBe(1);
      expect(await rolesOf('sam')).toEqual([]);
      expect((await historySince(mark)).map((r) => [r.action, r.subject])).toEqual([['employee.added', 'sam']]);
    });

    test('a role deleted while it is being given: the give and the add answer 409 role_gone, no orphan rows, no 500', async () => {
      const support = await newRole('Support', ['email']);
      await addPerson('bob@example.com', [support.id]); // a holder, so the delete has role rows to take with it
      await addPerson('sam@example.com', []);
      const samToken = await tokenFor('sam');
      const deleter = teamOn(connect());
      const giver = teamOn(connect());
      const adder = teamOn(connect());
      const mark = await historyMark();

      // The role's people rows are held, so the delete stops part way: the role is locked and deleted, not yet committed.
      const free = await hold('select 1 from team_employee_roles where role_id = $1::uuid for key share', [support.id]);
      const deleting = callOn(deleter, 'DELETE', `/roles/${support.id}?version=${support.version}`, 'olive');
      await waitForLockWaits(1, [deleting]);
      const giving = callOn<EmployeeView>(giver, 'PATCH', '/employees/sam', 'olive', { roleIds: [support.id], token: samToken });
      const adding = callOn<AddResult>(adder, 'POST', '/employees', 'olive', { email: 'maya@example.com', roleIds: [support.id] });
      await waitForLockWaits(3, [giving, adding]);
      await free();
      const [deleted, gave, added] = await Promise.all([deleting, giving, adding]);

      expect(deleted.status).toBe(200);
      expect({ status: gave.status, code: gave.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      expect({ status: added.status, code: added.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      expect(await rolesOf('sam')).toEqual([]);
      expect(await count(`select count(*)::int as n from team_employees where user_id = 'maya'`)).toBe(0);
      expect(await count('select count(*)::int as n from team_employee_roles where role_id = $1::uuid', [support.id])).toBe(0);
      expect(await orphans()).toBe(0);
      expect((await historySince(mark)).map((r) => r.action)).toEqual(['role.deleted']);
      expect(notAnswered()).toEqual([]);
    });

    test('a manager giving a role while it is being deleted gets 409 role_gone too', async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      await addPerson('maya@example.com', [managers.id, support.id]);
      await addPerson('bob@example.com', [support.id]);
      await addPerson('sam@example.com', []);
      w.accounts.set('dina', { id: 'dina', name: 'Dina Design', email: 'dina@example.com', emailVerified: true });
      const samToken = await tokenFor('sam');
      const deleter = teamOn(connect());
      const giver = teamOn(connect());
      const adder = teamOn(connect());
      const mark = await historyMark();

      // As above: the delete stops part way, and Maya still holds Support when her changes read her roles.
      const free = await hold('select 1 from team_employee_roles where role_id = $1::uuid for key share', [support.id]);
      const deleting = callOn(deleter, 'DELETE', `/roles/${support.id}?version=${support.version}`, 'olive');
      await waitForLockWaits(1, [deleting]);
      const giving = callOn<EmployeeView>(giver, 'PATCH', '/employees/sam', 'maya', { roleIds: [support.id], token: samToken });
      const adding = callOn<AddResult>(adder, 'POST', '/employees', 'maya', { email: 'dina@example.com', roleIds: [support.id] });
      await waitForLockWaits(3, [giving, adding]);
      await free();
      const [deleted, gave, added] = await Promise.all([deleting, giving, adding]);

      expect(deleted.status).toBe(200);
      expect({ status: gave.status, code: gave.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      expect({ status: added.status, code: added.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      expect(await rolesOf('sam')).toEqual([]);
      expect(await count(`select count(*)::int as n from team_employees where user_id = 'dina'`)).toBe(0);
      expect(await orphans()).toBe(0);
      expect((await historySince(mark)).map((r) => r.action)).toEqual(['role.deleted']);
    });

    test("a manager's Manage dialog still ticks a role someone deleted a moment ago: Save answers 409 role_gone", async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      await addPerson('maya@example.com', [managers.id, support.id]);
      await addPerson('sam@example.com', []);
      const samToken = await tokenFor('sam', 'maya');
      // Maya opened Manage for Sam and ticked Support; Olive deletes Support before Maya presses Save.
      expect((await call('DELETE', `/roles/${support.id}?version=${support.version}`, 'olive')).status).toBe(200);
      // Mass Access, in the same spot, is told the role is gone.
      const byOlive = await call('PATCH', '/employees/sam', 'olive', { roleIds: [support.id], token: samToken });
      expect({ status: byOlive.status, code: byOlive.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      const byMaya = await call('PATCH', '/employees/sam', 'maya', { roleIds: [support.id], token: samToken });
      expect({ status: byMaya.status, code: byMaya.body.error?.code, message: byMaya.body.error?.message }).toEqual({
        status: 409,
        code: 'role_gone',
        message: 'One of those roles was just deleted. Close this and try again.',
      });
    });

    test("a manager's Add dialog still ticks a role someone deleted a moment ago: Add answers 409 role_gone", async () => {
      const managers = await newRole('Managers', ['team']);
      const support = await newRole('Support', ['email']);
      await addPerson('maya@example.com', [managers.id, support.id]);
      expect((await call('DELETE', `/roles/${support.id}?version=${support.version}`, 'olive')).status).toBe(200);
      const byOlive = await call('POST', '/employees', 'olive', { email: 'bob@example.com', roleIds: [support.id] });
      expect({ status: byOlive.status, code: byOlive.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      const byMaya = await call('POST', '/employees', 'maya', { email: 'sam@example.com', roleIds: [support.id] });
      expect({ status: byMaya.status, code: byMaya.body.error?.code }).toEqual({ status: 409, code: 'role_gone' });
      expect(await count(`select count(*)::int as n from team_employees where user_id in ('bob', 'sam')`)).toBe(0);
    });

    test('a role edited twice at once from the same version: one 200, one 409 stale, one history row', async () => {
      const managers = await newRole('Managers', ['team', 'traffic']);
      const support = await newRole('Support', ['email']);
      await addPerson('maya@example.com', [managers.id, support.id]);
      const oliveSide = teamOn(connect());
      const mayaSide = teamOn(connect());
      const mark = await historyMark();

      const free = await hold('select id from team_roles where id = $1::uuid for update', [support.id]);
      const byOlive = callOn<RoleView>(oliveSide, 'PATCH', `/roles/${support.id}`, 'olive', { name: 'Support', pages: ['email', 'signup-funnel'], actions: [], version: support.version });
      const byMaya = callOn<RoleView>(mayaSide, 'PATCH', `/roles/${support.id}`, 'maya', { name: 'Helpdesk', pages: ['email', 'traffic'], actions: [], version: support.version });
      await waitForLockWaits(2, [byOlive, byMaya]);
      await free();
      const answers = await Promise.all([byOlive, byMaya]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(answers.find((a) => a.status === 409)!.body.error?.code).toBe('stale');
      const oliveWon = answers[0]!.status === 200;
      const stored = (await sql`select name, pages::text as pages, version from team_roles where id = ${support.id}::uuid`)[0]!;
      expect({ name: stored.name, pages: JSON.parse(stored.pages as string), version: stored.version }).toEqual(
        oliveWon ? { name: 'Support', pages: ['email', 'signup-funnel'], version: 2 } : { name: 'Helpdesk', pages: ['email', 'traffic'], version: 2 },
      );
      expect((answers[oliveWon ? 0 : 1]!.body as RoleView).version).toBe(2);
      expect((await historySince(mark)).map((r) => [r.action, r.actor])).toEqual([['role.changed', oliveWon ? 'olive' : 'maya']]);
    });

    test('two roles renamed to the same name at once: one 200, one 409 name_taken, the other role as it was', async () => {
      const support = await newRole('Support', ['email']);
      const sales = await newRole('Sales', ['traffic']);
      const one = teamOn(connect());
      const two = teamOn(connect());
      const mark = await historyMark();

      const free = await hold('select id from team_roles where id in ($1::uuid, $2::uuid) order by id for update', [support.id, sales.id]);
      const renameSupport = callOn<RoleView>(one, 'PATCH', `/roles/${support.id}`, 'olive', { name: 'Front desk', pages: ['email'], actions: [], version: 1 });
      const renameSales = callOn<RoleView>(two, 'PATCH', `/roles/${sales.id}`, 'olive', { name: 'front  desk', pages: ['traffic'], actions: [], version: 1 });
      await waitForLockWaits(2, [renameSupport, renameSales]);
      await free();
      const answers = await Promise.all([renameSupport, renameSales]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(answers.find((a) => a.status === 409)!.body.error).toMatchObject({ code: 'name_taken', message: 'Pick another name: that one is taken.', param: 'name' });
      const supportWon = answers[0]!.status === 200;
      const rows = await sql`select id::text as id, name, version from team_roles order by name`;
      expect(rows.map((r) => [r.id, r.name, r.version]).sort()).toEqual(
        (supportWon
          ? [
              [support.id, 'Front desk', 2],
              [sales.id, 'Sales', 1],
            ]
          : [
              [support.id, 'Support', 1],
              [sales.id, 'front desk', 2],
            ]
        ).sort(),
      );
      expect((await historySince(mark)).map((r) => [r.action, r.subject])).toEqual([['role.changed', supportWon ? support.id : sales.id]]);
    });

    /**
     * The same New role sent twice (a second click, or a retry of the same dialog while the first is still on its
     * way). Both requests wait for the roles table, then their INSERTs go at the same instant.
     */
    async function sameRoleTwice(one: Team<Person>, two: Team<Person>, by: string, body: Record<string, unknown>) {
      const free = await hold('lock table team_roles in share mode');
      const first = callOn<RoleView>(one, 'POST', '/roles', by, body);
      const second = callOn<RoleView>(two, 'POST', '/roles', by, body);
      await waitForLockWaits(2, [first, second]);
      await free();
      return Promise.all([first, second]);
    }

    test("a manager's New role sent twice at once with the same id (a second click, or a retry): one role, both answered 201", async () => {
      const managers = await newRole('Managers', ['team', 'email', 'traffic']);
      await addPerson('maya@example.com', [managers.id]);
      const one = teamOn(connect());
      const two = teamOn(connect());
      // It goes wrong in most rounds; ten rounds show it every run.
      for (let round = 0; round < 10; round++) {
        const body = { id: crypto.randomUUID(), name: `Support ${round}`, pages: ['email'], actions: [] };
        const mark = await historyMark();
        const answers = await sameRoleTwice(one, two, 'maya', body);
        expect({ round, answers: answers.map((a) => [a.status, a.body.id, a.body.mine, a.body.error?.code]) }).toEqual({
          round,
          answers: [
            [201, body.id, true, undefined],
            [201, body.id, true, undefined],
          ],
        });
        expect(await count('select count(*)::int as n from team_roles where id = $1::uuid', [body.id])).toBe(1);
        expect(await count(`select count(*)::int as n from team_employee_roles where user_id = 'maya' and role_id = $1::uuid`, [body.id])).toBe(1);
        expect((await historySince(mark)).map((r) => [r.action, r.subject, r.actor])).toEqual([['role.made', body.id, 'maya']]);
      }
    }, 30_000);

    test('Mass Access New role sent twice at once with the same id: one role, both answered 201', async () => {
      const one = teamOn(connect());
      const two = teamOn(connect());
      for (let round = 0; round < 10; round++) {
        const body = { id: crypto.randomUUID(), name: `Books ${round}`, pages: ['payouts'], actions: [] };
        const mark = await historyMark();
        const answers = await sameRoleTwice(one, two, 'olive', body);
        expect({ round, answers: answers.map((a) => [a.status, a.body.id, a.body.error?.code]) }).toEqual({
          round,
          answers: [
            [201, body.id, undefined],
            [201, body.id, undefined],
          ],
        });
        expect(await count('select count(*)::int as n from team_roles where id = $1::uuid', [body.id])).toBe(1);
        expect((await historySince(mark)).map((r) => [r.action, r.subject])).toEqual([['role.made', body.id]]);
      }
    }, 30_000);

    test('two New role with the same name in different case at once: one 201, one 409 name_taken, one role', async () => {
      let arrived = 0;
      const both = door();
      doors.push(both.open);
      const together = async (id: string) => {
        if (id === 'olive' && ++arrived <= 2) {
          if (arrived === 2) both.open();
          await both.opened;
        }
        return w.massAccess.has(id);
      };
      const a = teamOn(connect(), { hasMassAccess: together });
      const b = teamOn(connect(), { hasMassAccess: together });
      const mark = await historyMark();
      const answers = await Promise.all([
        callOn<RoleView>(a, 'POST', '/roles', 'olive', { id: crypto.randomUUID(), name: 'Support', pages: ['email'], actions: [] }),
        callOn<RoleView>(b, 'POST', '/roles', 'olive', { id: crypto.randomUUID(), name: 'SUPPORT', pages: ['traffic'], actions: [] }),
      ]);
      expect(answers.map((x) => x.status).sort()).toEqual([201, 409]);
      expect(answers.find((x) => x.status === 409)!.body.error?.code).toBe('name_taken');
      expect(await count(`select count(*)::int as n from team_roles where lower(name) = 'support'`)).toBe(1);
      expect((await historySince(mark)).map((r) => r.action)).toEqual(['role.made']);
    });

    test('a deadlock is retried once, and the change goes through', async () => {
      const support = await newRole('Support', ['email']);
      await addPerson('sam@example.com', []);
      const token = await tokenFor('sam');
      // The package's connection is the one Postgres stops when a deadlock forms; the other waits long.
      const giver = teamOn(connect({ connection: { deadlock_timeout: '300ms' } }));
      const other = connect({ connection: { deadlock_timeout: '20s' } });
      const mark = await historyMark();
      const hasRole = door();
      // Locks the role, then (once the give waits for the role, holding Sam's row) asks for Sam's row: a circle.
      const crossing = other.begin(async (tx) => {
        await tx`select id from team_roles where id = ${support.id}::uuid for update`;
        hasRole.open();
        await waitForLockWaits(1);
        await tx`select user_id from team_employees where user_id = 'sam' for update`;
      });
      await hasRole.opened;
      const giving = callOn<EmployeeView>(giver, 'PATCH', '/employees/sam', 'olive', { roleIds: [support.id], token });
      // The other side got Sam's row, so Postgres stopped the package's transaction, not this one; the package tried again.
      await crossing;
      const gave = await giving;
      expect(gave.status).toBe(200);
      expect(await rolesOf('sam')).toEqual([support.id]);
      expect((await historySince(mark)).map((r) => r.action)).toEqual(['employee.roles_changed']);
      expect(w.logs).toEqual([]);
    }, 15_000);

    test('two servers that come up with a retired grant at the same moment take it off each role once', async () => {
      const books = await newRole('Books', ['payouts', 'email']);
      const pay = await newRole('Pay', ['payouts', 'traffic']);
      await newRole('Support', ['email']);
      const nextNav = NAV.map((section) => ({ ...section, items: section.items.filter((item) => item.grant !== 'payouts') }));
      const nextVersion = (db: postgres.Sql) => createTeam(fakeConfig(w, { db: () => db, nav: nextNav, retiredGrants: ['payouts'] }));
      const a = nextVersion(connect());
      const b = nextVersion(connect());
      const mark = await historyMark();

      const free = await hold('select id from team_roles where id in ($1::uuid, $2::uuid) order by id for update', [books.id, pay.id]);
      const pageA = callOn<TeamState>(a, 'GET', '', 'olive');
      const pageB = callOn<TeamState>(b, 'GET', '', 'olive');
      await waitForLockWaits(2, [pageA, pageB]);
      await free();
      const answers = await Promise.all([pageA, pageB]);

      expect(answers.map((x) => [x.status, x.body.problem])).toEqual([
        [200, null],
        [200, null],
      ]);
      const stored = await sql`select name, pages::text as pages, version from team_roles order by name`;
      expect(stored.map((r) => [r.name, JSON.parse(r.pages as string), r.version])).toEqual([
        ['Books', ['email'], 2],
        ['Pay', ['traffic'], 2],
        ['Support', ['email'], 1],
      ]);
      const rows = await historySince(mark);
      expect(rows.map((r) => [r.action, r.subject, r.actor, r.detail.removed]).sort()).toEqual(
        [
          ['role.pages_retired', books.id, null, ['payouts']],
          ['role.pages_retired', pay.id, null, ['payouts']],
        ].sort(),
      );
    });

    test("deleting a role finishes when the app's Mass Access check reads through the same one-connection client", async () => {
      const support = await newRole('Support', ['email']);
      await addPerson('bob@example.com', [support.id]);
      const shared = connect();
      // An app whose Mass Access record is a table in the same database, read through the client it gave as db.
      // The delete asks the app about each person in the role while its transaction holds the only connection,
      // so that question waits for a connection that is never given back.
      const t = teamOn(shared, { hasMassAccess: async (id) => (await shared`select ${id}::text = 'olive' as yes`)[0]!.yes === true });
      const deleting = callOn(t, 'DELETE', `/roles/${support.id}?version=${support.version}`, 'olive');
      const outcome = await Promise.race([deleting.then((a) => a.status), Bun.sleep(3000).then(() => 'no answer after 3 s')]);
      // Frees the connection the change is stuck on, so nothing is left waiting.
      if (outcome !== 200) await shared.end({ timeout: 0 });
      expect(outcome).toBe(200);
    }, 10_000);
  });

  // ------------------------------------------------------------ (2) deleting a role

  test("deleting a role takes it off everyone who had it, and their tokens change", async () => {
    const support = await newRole('Support', ['email']);
    const growth = await newRole('Growth', ['traffic']);
    await addPerson('sam@example.com', [support.id, growth.id]);
    await addPerson('bob@example.com', [support.id]);
    const before = (await state('olive')).body;
    const samBefore = before.employees.find((e) => e.id === 'sam')!;
    const bobBefore = before.employees.find((e) => e.id === 'bob')!;
    expect(before.roles.find((r) => r.id === support.id)!.people).toBe(2);
    const mark = await historyMark();

    const deleted = await call<{ deleted: boolean }>('DELETE', `/roles/${support.id}?version=${support.version}`, 'olive');
    expect({ status: deleted.status, body: deleted.body }).toEqual({ status: 200, body: { deleted: true } });

    expect(await rolesOf('sam')).toEqual([growth.id]);
    expect(await rolesOf('bob')).toEqual([]);
    expect(await count('select count(*)::int as n from team_employee_roles where role_id = $1::uuid', [support.id])).toBe(0);
    expect(await count(`select count(*)::int as n from team_employees where user_id in ('sam', 'bob')`)).toBe(2);
    const after = (await state('olive')).body;
    const samAfter = after.employees.find((e) => e.id === 'sam')!;
    const bobAfter = after.employees.find((e) => e.id === 'bob')!;
    expect(samAfter.token).not.toBe(samBefore.token);
    expect(samAfter.token).toBe(tokenOf([growth.id]));
    expect(bobAfter.token).not.toBe(bobBefore.token);
    expect(bobAfter.token).toBe(tokenOf([]));
    expect(after.roles.map((r) => [r.id, r.people])).toEqual([[growth.id, 1]]);

    // A dialog opened before the delete is stale now.
    const manage = await call('PATCH', '/employees/sam', 'olive', { roleIds: [growth.id], token: samBefore.token });
    expect({ status: manage.status, code: manage.body.error?.code }).toEqual({ status: 409, code: 'stale' });
    const remove = await call('DELETE', `/employees/bob?token=${bobBefore.token}`, 'olive');
    expect({ status: remove.status, code: remove.body.error?.code }).toEqual({ status: 409, code: 'stale' });

    expect(sortedView(await team.view(user('sam')))).toEqual({ massAccess: false, employee: true, pages: ['traffic'], actions: [] });
    expect(await team.view(user('bob'))).toEqual({ massAccess: false, employee: true, pages: [], actions: [] });
    const rows = await historySince(mark);
    expect(rows.map((r) => [r.action, r.subject, r.actor])).toEqual([['role.deleted', support.id, 'olive']]);
    expect(rows[0]!.detail).toEqual({ name: 'Support', people: 2, pages: [{ key: 'email', label: 'Email' }] });
  });

  // ------------------------------------------------------------ (3) a deleted account

  test('forgetAccount takes the account and its roles off the team, adds account.forgotten, and changes no history row', async () => {
    const managers = await newRole('Managers', ['team', 'email']);
    const support = await newRole('Support', ['email']);
    await addPerson('maya@example.com', [managers.id, support.id]);
    await addPerson('bob@example.com', [support.id], 'maya');
    const snapshot = async () =>
      (await sql`select h.id::text as id, h.at::text as at, h.actor_id, h.action, h.subject_kind, h.subject_id, h.detail::text as detail from team_history h order by h.id`).map((r) => ({ ...r }));
    const before = await snapshot();

    expect(await team.forgetAccount('maya')).toBe(1);

    expect(await count(`select count(*)::int as n from team_employees where user_id = 'maya'`)).toBe(0);
    expect(await rolesOf('maya')).toEqual([]);
    // Only Maya's rows went: Bob, whom she added, stays as he was; the roles stay.
    const bob = await sql`select e.added_by, er.given_by, er.role_id::text as role_id from team_employees e join team_employee_roles er using (user_id) where e.user_id = 'bob'`;
    expect(bob.map((r) => [r.added_by, r.given_by, r.role_id])).toEqual([['maya', 'maya', support.id]]);
    expect(await count('select count(*)::int as n from team_roles')).toBe(2);
    const after = await snapshot();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((r) => [r.actor_id, r.action, r.subject_kind, r.subject_id, r.detail])).toEqual([[null, 'account.forgotten', 'account', 'maya', '{}']]);

    // Nothing to do: nothing written.
    expect(await team.forgetAccount('maya')).toBe(0);
    expect(await team.forgetAccount('cara')).toBe(0);
    expect(await team.forgetAccount('')).toBe(0);
    expect((await snapshot()).length).toBe(after.length);
    expect(await team.view(user('maya'))).toEqual({ massAccess: false, employee: false, pages: [], actions: [] });
    expect((await call<HistoryPage>('GET', '/history', 'olive')).body.rows[0]!.text).toBe('A deleted account left the team.');

    // No database, or one that is down: null, never a throw.
    expect(await createTeam(fakeConfig(w, { db: () => null })).forgetAccount('bob')).toBeNull();
    expect(await createTeam(fakeConfig(w, { db: () => ({ begin: () => Promise.reject(new Error('down')) }) as never })).forgetAccount('bob')).toBeNull();
    expect(await count(`select count(*)::int as n from team_employees where user_id = 'bob'`)).toBe(1);
  });

  // ------------------------------------------------------------ (5) the same answers through every client an app uses

  /**
   * The main flow through one client: roles made, people added (one made by
   * the app), the check, the page for Mass Access and for a manager, a
   * manager's change, a rename, a delete, a forgotten account and History.
   * Answers what people would see, without ids, tokens or times.
   */
  async function mainFlow(db: postgres.Sql): Promise<Record<string, unknown>> {
    const fw = world();
    const t = createTeam(fakeConfig(fw, { db: () => db }));
    const who = (id: string): Person => ({ id, email: fw.accounts.get(id)?.email ?? null });
    const [managersId, supportId] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string];
    const mark = (await db`select coalesce(max(id), 0)::text as id from team_history`)[0]!.id as string;
    const role = (r: Answer<RoleView>) => ({ status: r.status, name: r.body.name, pages: r.body.pages, actions: r.body.actions, version: r.body.version, people: r.body.people, mine: r.body.mine, error: r.body.error?.code });
    const added = (a: Answer<AddResult>) => ({ status: a.status, outcome: a.body.outcome, opens: a.body.opens, emailed: a.body.emailed, roles: a.body.employee?.roleIds.length, error: a.body.error?.code });
    const digest = (s: Answer<TeamState>) => ({
      status: s.status,
      viewer: s.body.viewer?.massAccess,
      roles: s.body.roles?.map((r) => [r.name, r.pages, r.actions, r.version, r.people, r.mine]),
      employees: s.body.employees?.map((e) => [e.id, e.name, e.roleIds.length, e.hiddenRoles, e.you, e.canManage, e.canRemove, e.addedBy, e.lastSeenAt ?? 'absent', /^[0-9a-f]{20}$/.test(e.token)]),
      massAccess: s.body.massAccess?.map((m) => m.name) ?? null,
      unassigned: s.body.unassigned,
      catalog: s.body.catalog?.map((section) => [section.label, section.pages.map((p) => [p.grant ?? p.label, p.locked, p.teamPage, p.actions.map((a) => a.key)])]),
    });
    const out: Record<string, unknown> = {};
    out.managers = role(await callOn<RoleView>(t, 'POST', '/roles', 'olive', { id: managersId, name: 'Managers', pages: ['team'], actions: [] }));
    out.support = role(await callOn<RoleView>(t, 'POST', '/roles', 'olive', { id: supportId, name: 'Support', pages: ['email', 'traffic'], actions: ['email.settings'] }));
    out.addMaya = added(await callOn<AddResult>(t, 'POST', '/employees', 'olive', { email: 'maya@example.com', roleIds: [managersId, supportId] }));
    out.addSam = added(await callOn<AddResult>(t, 'POST', '/employees', 'maya', { email: 'sam@example.com', roleIds: [supportId] }));
    out.addNia = added(await callOn<AddResult>(t, 'POST', '/employees', 'olive', { email: 'nia@example.com', name: 'Nia New', roleIds: [] }));
    out.views = {
      olive: sortedView(await t.view(who('olive'))),
      maya: sortedView(await t.view(who('maya'))),
      sam: sortedView(await t.view(who('sam'))),
      cara: sortedView(await t.view(who('cara'))),
    };
    out.checks = [
      await t.can(who('sam'), 'email'),
      await t.can(who('sam'), '/dashboard/admin/traffic/links/9'),
      await t.can(who('sam'), 'team'),
      await t.canDo(who('sam'), 'email.settings'),
      await t.can(who('cara'), 'email'),
      await t.canOpen(who('maya'), '/dashboard/admin/team'),
    ];
    out.pageForOlive = digest(await callOn<TeamState>(t, 'GET', '', 'olive'));
    const mayaPage = await callOn<TeamState>(t, 'GET', '', 'maya');
    out.pageForMaya = digest(mayaPage);
    out.pageForSam = (await callOn(t, 'GET', '', 'sam')).status;
    const samToken = mayaPage.body.employees.find((e) => e.id === 'sam')!.token;
    const manage = await callOn<EmployeeView>(t, 'PATCH', '/employees/sam', 'maya', { roleIds: [], token: samToken });
    out.manage = { status: manage.status, roles: manage.body.roleIds?.length, error: manage.body.error?.code };
    out.samAfter = sortedView(await t.view(who('sam')));
    out.rename = role(await callOn<RoleView>(t, 'PATCH', `/roles/${supportId}`, 'olive', { name: 'Support desk', pages: ['email', 'traffic'], actions: ['email.settings'], version: 1 }));
    out.deleteManagers = (await callOn(t, 'DELETE', `/roles/${managersId}?version=1`, 'olive')).status;
    out.forget = [await t.forgetAccount('sam'), await t.forgetAccount('sam')];
    const history = await callOn<HistoryPage>(t, 'GET', '/history', 'olive');
    out.history = history.body.rows.filter((r) => BigInt(r.id) > BigInt(mark)).map((r) => r.text);
    out.signedOut = fw.signedOut;
    out.logs = fw.logs;
    return out;
  }

  let baselineFlow: Record<string, unknown> | null = null;
  /** The main flow through a plain client on public's tables, checked once. */
  async function baseline(): Promise<Record<string, unknown>> {
    if (baselineFlow) return baselineFlow;
    await sql`delete from team_employees`;
    await sql`delete from team_roles`;
    const out = await mainFlow(connect());
    expect(out.history).toEqual([
      'A deleted account left the team.',
      'Olive Owner deleted the role Managers. 1 person had it.',
      'Olive Owner renamed Support to Support desk.',
      "Maya Manager changed Sam Support's roles: took off Support.",
      'Olive Owner made an account for Nia New and added them.',
      'Maya Manager added Sam Support with Support.',
      'Olive Owner added Maya Manager with Managers and Support.',
      'Olive Owner made the role Support. It opens Email and Traffic.',
      'Olive Owner made the role Managers. It opens Team.',
    ]);
    expect(out.views).toEqual({
      olive: { massAccess: true, employee: false, pages: [], actions: [] },
      maya: { massAccess: false, employee: true, pages: ['email', 'team', 'traffic'], actions: ['email.settings'] },
      sam: { massAccess: false, employee: true, pages: ['email', 'traffic'], actions: ['email.settings'] },
      cara: { massAccess: false, employee: false, pages: [], actions: [] },
    });
    expect(out.checks).toEqual([true, true, false, true, false, true]);
    expect(out.addNia).toEqual({ status: 201, outcome: 'account_made', opens: ['Overview'], emailed: true, roles: 0, error: undefined });
    expect([out.manage, out.samAfter, out.deleteManagers, out.forget, out.signedOut, out.logs]).toEqual([
      { status: 200, roles: 0, error: undefined },
      { massAccess: false, employee: true, pages: [], actions: [] },
      200,
      [1, 0],
      ['maya', 'sam'],
      [],
    ]);
    baselineFlow = out;
    return out;
  }

  test('the same answers with fetch_types off, prepare off and the camel-case transform', async () => {
    const plain = await baseline();
    const settings: Array<[string, Options]> = [
      ['fetch_types: false', { fetch_types: false }],
      ['prepare: false', { prepare: false }],
      ['transform: postgres.camel', { transform: postgres.camel }],
      ['all three', { fetch_types: false, prepare: false, transform: postgres.camel }],
    ];
    for (const [label, options] of settings) {
      await sql`delete from team_employees`;
      await sql`delete from team_roles`;
      expect({ label, flow: await mainFlow(connect(options)) }).toEqual({ label, flow: plain });
    }
  }, 30_000);

  test('the tables in another schema: the migration and every read and write stay in it', async () => {
    const plain = await baseline();
    await sql`create schema site`;
    const site = connect({ connection: { search_path: 'site' } });
    await migrate(site);
    await migrate(site);
    const tables = await sql`select table_name from information_schema.tables where table_schema = 'site' order by 1`;
    expect(tables.map((r) => r.table_name)).toEqual(['team_employee_roles', 'team_employees', 'team_history', 'team_roles']);
    await sql`delete from team_employees`;
    await sql`delete from team_roles`;
    const publicMark = await historyMark();

    expect(await mainFlow(site)).toEqual(plain);
    // BetterFans Link's kind of client: the schema, fetch_types off, no prepared statements, camel case.
    await sql`delete from site.team_employees`;
    await sql`delete from site.team_roles`;
    expect(await mainFlow(connect({ connection: { search_path: 'site' }, fetch_types: false, prepare: false, transform: postgres.camel }))).toEqual(plain);

    // Nothing landed in public's tables.
    expect(await historySince(publicMark)).toEqual([]);
    expect(await count('select count(*)::int as n from public.team_roles')).toBe(0);
    expect(await count('select count(*)::int as n from site.team_history')).toBe(18);
    expect(await count('select count(*)::int as n from site.team_roles')).toBe(1);
    // The guard still holds in that schema.
    expect((await refusal(() => site`delete from team_history`)).message).toContain('append-only');
  }, 30_000);

  // ------------------------------------------------------------ (4) the app login's rights

  test("the app login: reads and writes the team, reads and adds history, and can't change, empty or unguard history", async () => {
    for (const login of [ownerLogin, appLogin, handLogin]) await admin.unsafe(`create role "${login}" login`);
    await sql.unsafe(`create schema grants authorization "${ownerLogin}"`);
    await sql.unsafe(`grant usage on schema grants to "${appLogin}", "${handLogin}"`);
    // Like the framework's create-app-role.sql: every table the owner makes here is the app login's, in full.
    await sql.unsafe(`alter default privileges for role "${ownerLogin}" in schema grants grant all on tables to "${appLogin}"`);
    const asOwner = connect({ connection: { search_path: 'grants' } }, ownerLogin);
    // The migration, run by the owner, with its own grants block for a login called app_user. Logins are
    // server-wide, so this run's login stands in for the name (a real app_user would be shared with other runs).
    const named = (text: string) => {
      expect(text).toContain("rolname = 'app_user'");
      return text.replaceAll('app_user', appLogin);
    };
    await migrate(asOwner, named);
    await migrate(asOwner, named);
    // A login with another name and no default privileges: the README's grants, by hand.
    await asOwner.unsafe(`grant select, insert, update, delete on table team_roles, team_employees, team_employee_roles to "${handLogin}"`);
    await asOwner.unsafe(`grant select, insert on table team_history to "${handLogin}"`);

    const rights = async (login: string) =>
      (
        await sql`
        select t.name, string_agg(p.name, ' ' order by p.n) filter (where has_table_privilege(${login}, 'grants.' || t.name, p.name)) as rights
        from (values ('team_roles'), ('team_employees'), ('team_employee_roles'), ('team_history')) t(name)
        cross join (values (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE'), (5, 'TRUNCATE'), (6, 'TRIGGER')) p(n, name)
        group by t.name order by t.name`
      ).map((r) => [r.name, r.rights]);
    expect(await rights(appLogin)).toEqual([
      ['team_employee_roles', 'SELECT INSERT UPDATE DELETE TRUNCATE TRIGGER'],
      ['team_employees', 'SELECT INSERT UPDATE DELETE TRUNCATE TRIGGER'],
      ['team_history', 'SELECT INSERT'],
      ['team_roles', 'SELECT INSERT UPDATE DELETE TRUNCATE TRIGGER'],
    ]);
    expect(await rights(handLogin)).toEqual([
      ['team_employee_roles', 'SELECT INSERT UPDATE DELETE'],
      ['team_employees', 'SELECT INSERT UPDATE DELETE'],
      ['team_history', 'SELECT INSERT'],
      ['team_roles', 'SELECT INSERT UPDATE DELETE'],
    ]);

    const plain = await baseline();
    for (const login of [appLogin, handLogin]) {
      const db = connect({ connection: { search_path: 'grants' } }, login);
      expect((await db`select current_user as me`)[0]!.me).toBe(login);
      // Reads and writes the three team tables, locks included.
      const [role] = await db`insert into team_roles (name, pages) values ('Probe', '["email"]') returning id::text as id`;
      await db`update team_roles set name = 'Probe two' where id = ${role!.id}::uuid`;
      await db`insert into team_employees (user_id) values ('probe')`;
      await db`insert into team_employee_roles (user_id, role_id) values ('probe', ${role!.id}::uuid)`;
      await db.begin(async (tx) => {
        await tx`select user_id from team_employees where user_id = 'probe' for update`;
        await tx`select id from team_roles where id = ${role!.id}::uuid for share`;
      });
      expect((await db`select count(*)::int as n from team_employee_roles where user_id = 'probe'`)[0]!.n).toBe(1);
      await db`delete from team_roles where id = ${role!.id}::uuid`; // its role rows go with it
      await db`delete from team_employees where user_id = 'probe'`;
      // Reads and adds history (an identity id: no sequence to grant).
      await db`insert into team_history (action, subject_kind, subject_id) values ('probe.added', 'account', 'probe')`;
      expect((await db`select count(*)::int as n from team_history where subject_id = 'probe'`)[0]!.n).toBeGreaterThan(0);
      // Never changes it, empties it, or switches its guard off.
      for (const statement of [
        `update team_history set action = 'probe.changed'`,
        `delete from team_history`,
        `truncate team_history`,
        `alter table team_history disable trigger team_history_append_only`,
        `alter table team_history disable trigger all`,
        `alter table team_history owner to "${login}"`,
        `drop table team_history`,
        `create trigger probe before insert on team_history for each row execute function team_history_refuse_change()`,
        `set session_replication_role = replica`,
      ]) {
        expect({ login: login === appLogin ? 'app_user' : 'by hand', statement, code: (await refusal(() => db.unsafe(statement))).code }).toEqual({
          login: login === appLogin ? 'app_user' : 'by hand',
          statement,
          code: '42501',
        });
      }
      // And the package works as this login, start to end.
      await db`delete from team_employees`;
      await db`delete from team_roles`;
      expect(await mainFlow(db)).toEqual(plain);
    }

    // Even a login handed history in full (create-app-role.sql run again) can't change it: the trigger refuses.
    await asOwner.unsafe(`grant all on table team_history to "${handLogin}"`);
    const handed = connect({ connection: { search_path: 'grants' } }, handLogin);
    for (const statement of [`update team_history set action = 'probe.changed'`, `delete from team_history`, `truncate team_history`]) {
      const no = await refusal(() => handed.unsafe(statement));
      expect({ statement, code: no.code, message: no.message }).toEqual({ statement, code: '42501', message: expect.stringContaining('team_history is append-only') });
    }
    expect((await refusal(() => handed`alter table team_history disable trigger team_history_append_only`)).code).toBe('42501');
  }, 30_000);

  // ------------------------------------------------------------ (6) the migration again, and onto someone else's table

  test('the migration runs twice over live data, and stops on a team_roles that is not ours, leaving it as it was', async () => {
    const support = await newRole('Support', ['email']);
    await addPerson('sam@example.com', [support.id]);
    const historyBefore = await count('select count(*)::int as n from team_history');
    await migrate(sql);
    await migrate(sql);
    expect(await rolesOf('sam')).toEqual([support.id]);
    expect(await count('select count(*)::int as n from team_history')).toBe(historyBefore);
    expect((await refusal(() => sql`delete from team_history`)).message).toContain('append-only');

    const theirs = async (schema: string, idType: string) => {
      await sql.unsafe(`create schema ${schema}`);
      await sql.unsafe(`create table ${schema}.team_roles (id ${idType} primary key, title text not null)`);
      await sql.unsafe(`insert into ${schema}.team_roles (id, title) values (${idType === 'uuid' ? 'gen_random_uuid()' : '1'}, 'Keep me')`);
      const into = connect({ connection: { search_path: schema } });
      const stopped = await refusal(() => migrate(into));
      const columns = await sql`select column_name from information_schema.columns where table_schema = ${schema} and table_name = 'team_roles' order by ordinal_position`;
      const rows = await sql.unsafe(`select title from ${schema}.team_roles`);
      return { stopped, columns: columns.map((c) => c.column_name), rows: rows.map((r) => r.title) };
    };
    // Someone else's team_roles, keyed by uuid: the guard names it.
    const uuidKeyed = await theirs('clash_uuid', 'uuid');
    expect(uuidKeyed.stopped.message).toBe('@arvo/team: a table here has one of its names but not its columns (team_roles.pages); rename that table first');
    expect([uuidKeyed.columns, uuidKeyed.rows]).toEqual([['id', 'title'], ['Keep me']]);
    // An app's own team_roles keyed by a whole number: still stopped (refusal() fails if not), still untouched.
    const intKeyed = await theirs('clash_int', 'integer');
    expect([intKeyed.columns, intKeyed.rows]).toEqual([['id', 'title'], ['Keep me']]);
  });

  // ------------------------------------------------------------ (7) the read every request makes

  test('view() for a customer is one query and writes nothing, even on a read-only connection', async () => {
    const support = await newRole('Support', ['email']);
    await addPerson('sam@example.com', [support.id]);
    const queries: string[] = [];
    const readOnly = connect({ debug: (_connection, query) => queries.push(query), connection: { default_transaction_read_only: true } });
    await readOnly`select 1`; // connects (and reads the types) before counting
    const t = teamOn(readOnly);
    const mark = await historyMark();

    queries.length = 0;
    expect(await t.view(user('cara'))).toEqual({ massAccess: false, employee: false, pages: [], actions: [] });
    expect(queries.length).toBe(1);
    expect(queries[0]).not.toMatch(/\b(insert|update|delete|begin|for update|for share)\b/i);

    queries.length = 0;
    expect(await t.view(user('sam'))).toEqual({ massAccess: false, employee: true, pages: ['email'], actions: [] });
    expect(await t.view(user('olive'))).toEqual({ massAccess: true, employee: false, pages: [], actions: [] });
    expect(await t.can(user('cara'), 'email')).toBe(false);
    expect(await t.canDo(user('cara'), 'email.settings')).toBe(false);
    expect(queries.length).toBe(4);

    // Viewing as someone, and nobody signed in: no query at all.
    queries.length = 0;
    expect(await t.view(user('sam', true))).toEqual({ massAccess: false, employee: false, pages: [], actions: [] });
    expect(await t.view(null)).toEqual({ massAccess: false, employee: false, pages: [], actions: [] });
    expect(queries.length).toBe(0);

    expect(w.logs).toEqual([]);
    expect(await historyMark()).toBe(mark);
    expect(await count(`select count(*)::int as n from team_employees where user_id = 'cara'`)).toBe(0);
  });

  // ------------------------------------------------------------ two versions of the app on one database

  test('a role keeps the keys a newer version of the app stored when an older server saves it', async () => {
    const id = crypto.randomUUID();
    // A newer app version made this role: a page and an action this nav doesn't list.
    await sql`insert into team_roles (id, name, pages, actions) values (${id}::uuid, 'Support', '["email","refunds"]'::jsonb, '["email.export"]'::jsonb)`;
    const shown = (await state('olive')).body.roles.find((r) => r.id === id)!;
    expect([shown.pages, shown.actions]).toEqual([['email'], []]);
    const saved = await call<RoleView>('PATCH', `/roles/${id}`, 'olive', { name: 'Support desk', pages: ['email', 'traffic'], actions: [], version: shown.version });
    expect(saved.status).toBe(200);
    const stored = (await sql`select name, pages::text as pages, actions::text as actions from team_roles where id = ${id}::uuid`)[0]!;
    expect([stored.name, JSON.parse(stored.pages as string), JSON.parse(stored.actions as string)]).toEqual(['Support desk', ['email', 'traffic', 'refunds'], ['email.export']]);
  });
});
