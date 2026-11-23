/**
 * The Team page against a real Postgres, through createTeam and the pretend
 * app (fake-app.ts): the README's example (a role that opens Email and Traffic),
 * a manager who can only give what they have, and the check every page asks.
 * Runs only with TEAM_TEST_PG_URL (a Postgres the test may create databases
 * on): each run makes its own database from migrations/*.sql and drops it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { createTeam, type Team } from '../src/index';
import type { AddResult, RoleView, TeamState } from '../src/shared/api';
import { cookieFor, fakeConfig, request, world, type FakeWorld, type Person } from './fake-app';

const ROOT_URL = process.env.TEAM_TEST_PG_URL ?? '';
const MIGRATIONS = join(import.meta.dir, '..', 'migrations');

async function migrate(sql: postgres.Sql) {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    for (const statement of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await sql.unsafe(statement);
    }
  }
}

describe.skipIf(!ROOT_URL)('team (pg)', () => {
  const database = `team_test_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let w: FakeWorld;
  let team: Team<Person>;

  const make = (overrides = {}) => createTeam(fakeConfig(w, { db: () => sql, ...overrides }));
  const call = async <T>(method: string, path: string, who: string | null, body?: unknown, extra: Record<string, unknown> = {}) => {
    const handler = team.routeHandlers[method as 'GET' | 'POST' | 'PATCH' | 'DELETE'];
    const response = await handler(request(`/api/team${path}`, { method, cookie: who ? cookieFor(who) : undefined, body, ...extra }));
    return { status: response.status, body: (await response.json()) as T & { error?: { code: string; message: string } } };
  };
  const state = (who: string) => call<TeamState>('GET', '', who);
  const newRole = (who: string, name: string, pages: string[], actions: string[] = []) =>
    call<RoleView>('POST', '/roles', who, { id: crypto.randomUUID(), name, pages, actions });
  const add = (who: string, email: string, roleIds: string[], name?: string) => call<AddResult>('POST', '/employees', who, { email, roleIds, name });
  const user = (id: string, viewedAs = false): Person => ({ id, email: w.accounts.get(id)?.email, viewedAs });

  beforeAll(async () => {
    admin = postgres(ROOT_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(ROOT_URL);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), { max: 4, onnotice: () => {} });
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`delete from team_employees`;
    await sql`delete from team_roles`;
    w = world();
    team = make();
  });

  test('the migration runs twice', async () => {
    await migrate(sql);
  });

  test("the README's example: a role that opens Email and Traffic, and nothing else", async () => {
    const marketing = await newRole('olive', 'Marketing', ['email', 'traffic']);
    expect(marketing.status).toBe(201);
    expect(marketing.body.pages).toEqual(['email', 'traffic']);
    const added = await add('olive', 'sam@example.com', [marketing.body.id]);
    expect(added.status).toBe(201);
    expect(added.body.outcome).toBe('joined');
    expect(added.body.opens).toEqual(['Overview', 'Email', 'Traffic']);
    expect(w.signedOut).toEqual(['sam']);

    expect(await team.can(user('sam'), 'email')).toBe(true);
    expect(await team.can(user('sam'), '/dashboard/admin/traffic/links/9')).toBe(true);
    expect(await team.can(user('sam'), 'signup-funnel')).toBe(false);
    expect(await team.can(user('sam'), 'team')).toBe(false);
    expect(await team.can(user('sam'), '/dashboard/admin/log-in-as')).toBe(false);
    expect(await team.can(user('cara'), 'email')).toBe(false);
    expect(await team.can(user('olive'), '/dashboard/admin/log-in-as')).toBe(true);
    // Viewing as Sam gives none of Sam's team pages, and no Mass Access to the owner.
    expect(await team.can(user('sam', true), 'email')).toBe(false);
    expect(await team.can(user('olive', true), 'email')).toBe(false);
    // Not a manager: the Team page and its routes are not there for Sam.
    expect((await state('sam')).status).toBe(404);
    expect((await state('cara')).status).toBe(404);
    expect((await call('GET', '', null)).status).toBe(404);
  });

  test('a manager gives only what they have, and their new role is theirs', async () => {
    const managers = await newRole('olive', 'Managers', ['team', 'email', 'traffic']);
    await add('olive', 'maya@example.com', [managers.body.id]);
    // Maya can't give Payouts: she can't open it.
    const refused = await newRole('maya', 'Books', ['payouts']);
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe("You can only give pages you can open yourself. Payouts isn't one of them.");
    const support = await newRole('maya', 'Support', ['email']);
    expect(support.status).toBe(201);
    expect(support.body.mine).toBe(true);
    // She can give Support (she holds it) but not a role she doesn't hold.
    const payouts = await newRole('olive', 'Payouts', ['payouts']);
    expect((await add('maya', 'bob@example.com', [payouts.body.id])).status).toBe(403);
    const sam = await add('maya', 'sam@example.com', [support.body.id]);
    expect(sam.status).toBe(201);
    expect(await team.can(user('sam'), 'email')).toBe(true);
    expect(await team.can(user('sam'), 'traffic')).toBe(false);

    // Bob has Support and Payouts: Maya can't take Support off him, or remove him.
    const bob = await add('olive', 'bob@example.com', [support.body.id, payouts.body.id]);
    const page = await state('maya');
    const bobRow = page.body.employees.find((e) => e.id === 'bob')!;
    expect(bobRow.hiddenRoles).toBe(1);
    expect(bobRow.canRemove).toBe(false);
    expect(page.body.roles.map((r) => r.name).sort()).toEqual(['Managers', 'Support']);
    expect(page.body.massAccess).toBeNull();
    expect(page.body.employees.some((e) => 'lastSeenAt' in e)).toBe(false);
    const take = await call('PATCH', '/employees/bob', 'maya', { roleIds: [], token: bobRow.token });
    expect(take.status).toBe(403);
    const remove = await call('DELETE', `/employees/bob?token=${bobRow.token}`, 'maya');
    expect(remove.status).toBe(403);
    // And she can't take pages off Support while Bob holds it.
    const edit = await call('PATCH', `/roles/${support.body.id}`, 'maya', { name: 'Support', pages: [], actions: [], version: support.body.version });
    expect([400, 403]).toContain(edit.status);
    expect(bob.status).toBe(201);
  });

  test('nobody changes their own roles, and Mass Access is never on the team', async () => {
    const managers = await newRole('olive', 'Managers', ['team']);
    await add('olive', 'maya@example.com', [managers.body.id]);
    const mine = (await state('maya')).body.employees.find((e) => e.you)!;
    expect(mine.canManage).toBe(false);
    expect((await call('PATCH', '/employees/maya', 'maya', { roleIds: [], token: mine.token })).status).toBe(403);
    expect((await add('olive', 'olive@example.com', [])).body.error?.code).toBe('self');
    w.massAccess.add('bob');
    expect((await add('olive', 'bob@example.com', [])).body.error?.code).toBe('has_mass_access');
  });

  test('an account whose email is not confirmed never joins; a new one is made when the app can', async () => {
    expect((await add('olive', 'una@example.com', [])).body.error?.code).toBe('email_not_confirmed');
    const made = await add('olive', 'new@example.com', [], 'Nia New');
    expect(made.status).toBe(201);
    expect(made.body.outcome).toBe('account_made');
    expect(w.signedOut).toEqual([]);
    expect((await add('olive', 'other@example.com', [])).body.error?.code).toBe('name_required');
    team = make({ createAccount: undefined, signUpUrl: 'https://example.com/sign-up' });
    const none = await add('olive', 'nobody@example.com', []);
    expect(none.body.error?.code).toBe('no_account');
    expect(none.body.error?.message).toContain('example.com');
  });

  test('a change from another site, or not as JSON, is refused before anything is read', async () => {
    const body = { id: crypto.randomUUID(), name: 'X', pages: ['email'], actions: [] };
    expect((await call('POST', '/roles', 'olive', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/roles', 'olive', body, { fetchSite: 'cross-site', origin: null })).status).toBe(403);
    expect((await call('POST', '/roles', 'olive', body, { contentType: 'text/plain' })).status).toBe(403);
    expect((await call('POST', '/roles', 'olive', body, { origin: null })).status).toBe(403);
    expect((await sql`select count(*)::int as n from team_roles`)[0]!.n).toBe(0);
    // Viewing as someone: no changes, Mass Access included.
    const viewAs = await team.routeHandlers.POST(request('/api/team/roles', { method: 'POST', cookie: cookieFor('olive', true), body }));
    expect(viewAs.status).toBe(404);
  });

  test('stale edits are refused', async () => {
    const role = await newRole('olive', 'Support', ['email']);
    const first = await call<RoleView>('PATCH', `/roles/${role.body.id}`, 'olive', { name: 'Support', pages: ['email', 'traffic'], actions: [], version: role.body.version });
    expect(first.status).toBe(200);
    const second = await call('PATCH', `/roles/${role.body.id}`, 'olive', { name: 'Support', pages: ['email'], actions: [], version: role.body.version });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('stale');
  });

  test('history says what happened, in sentences', async () => {
    const role = await newRole('olive', 'Support', ['email']);
    await add('olive', 'sam@example.com', [role.body.id]);
    const history = await call<{ rows: { text: string }[] }>('GET', '/history', 'olive');
    // History is never emptied between tests (nothing can delete from it): read the newest rows.
    expect(history.body.rows.slice(0, 2).map((r) => r.text)).toEqual(['Olive Owner added Sam Support with Support.', 'Olive Owner made the role Support. It opens Email.']);
    // postgres.js runs a query when it is awaited, so wrap it for expect().
    await expect((async () => void (await sql`delete from team_history`))()).rejects.toThrow('append-only');
  });

  test('view is one read, and a broken team read leaves Mass Access alone', async () => {
    const broken = createTeam(fakeConfig(w, { db: () => ({ begin: () => Promise.reject(new Error('down')) }) as never }));
    const v = await broken.view(user('olive'));
    expect(v.massAccess).toBe(true);
    expect(v.employee).toBe(false);
    expect(await broken.can(user('sam'), 'email')).toBe(false);
  });
});
