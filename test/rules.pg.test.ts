/**
 * @arvo/team against design v2: one or more tests for every rule in section
 * 6 (rules 1 to 12) and for section 5 (adding someone), driven through
 * team.routeHandlers and the createTeam API the way an app calls them, with
 * the pretend app in fake-app.ts and a real Postgres.
 *
 * Runs only with TEAM_TEST_PG_URL (a Postgres the test may create databases
 * on). This file makes its own database (team_rules_<pid>_<time>) from
 * migrations/*.sql and drops it at the end. History rows can never be
 * deleted, so a history check only reads rows newer than a mark it takes
 * first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { TeamConfig } from '../src/config';
import { createTeam, type Team } from '../src/index';
import type { TeamNav } from '../src/nav';
import type { AddResult, EmployeeView, HistoryPage, RoleView, TeamState, TeamView } from '../src/shared/api';
import { cookieFor, fakeConfig, NAV, SITE, world, type FakeWorld, type Person } from './fake-app';

const ROOT_URL = process.env.TEAM_TEST_PG_URL ?? '';
const MIGRATIONS = join(import.meta.dir, '..', 'migrations');
/** What Next's notFound() throws carries this digest. */
const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404';
/** The error in the 404 a route that doesn't exist answers. */
const ROUTE_404 = { type: 'not_found', code: 'route_not_found', message: 'This page does not exist.' };
const NOBODY_VIEW = { massAccess: false, employee: false, pages: [], actions: [] };

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type ErrorBody = { type: string; code: string; message: string; hint?: string; param?: string };
type Answer<T> = { status: number; body: T & { error?: ErrorBody; requestId?: string }; headers: Headers };
type CallOptions = {
  body?: unknown;
  viewAs?: boolean;
  /** Default: the site's own origin on a change. null sends none. */
  origin?: string | null;
  /** Default: application/json on a change (the page sends it on DELETE too). null sends none. */
  contentType?: string | null;
  /** Default: same-origin on a change, as a browser says. null sends none. */
  fetchSite?: string | null;
};
type HistoryRow = { id: string; actor_id: string | null; action: string; subject_kind: string; subject_id: string; detail: Record<string, unknown> };
type Fixture = { managers: RoleView; support: RoleView; payouts: RoleView };
type Db = TeamConfig<Person>['db'];

function statements(file: string): string[] {
  return readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.trim());
}

async function migrate(sql: postgres.Sql) {
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of statements(file)) await sql.unsafe(statement);
  }
}

/** True when work() threw Next's notFound(); false when it went through. Any other throw fails the test. */
async function saysNotFound(work: () => Promise<void>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (typeof digest === 'string' && digest.includes(NOT_FOUND_DIGEST)) return true;
    throw error;
  }
}

const sorted = <T,>(list: readonly T[]): T[] => [...list].sort();

/** The nav with one more action, on the role page that has this grant. */
function withAction(nav: TeamNav, grant: string, action: { key: string; label: string }): TeamNav {
  return nav.map((section) => ({
    ...section,
    items: section.items.map((item) => (item.grant === grant ? { ...item, actions: [...(item.actions ?? []), action] } : item)),
  }));
}

describe.skipIf(!ROOT_URL)('design v2 rules (pg)', () => {
  const database = `team_rules_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  /** The same database with a search_path that has no team tables: every read is 42P01. */
  let empty: postgres.Sql;
  let w: FakeWorld;
  let team: Team<Person>;
  let sessions: Array<{ method: string; path: string; fresh: boolean }>;

  function urlFor(name: string): string {
    const url = new URL(ROOT_URL);
    url.pathname = `/${name}`;
    return url.toString();
  }

  /** The fake app's config on this database, with every session check recorded. */
  function make(overrides: Partial<TeamConfig<Person>> = {}): Team<Person> {
    const base = fakeConfig(w, { db: () => sql });
    const signedInUser = base.signedInUser;
    return createTeam<Person>({
      ...base,
      signedInUser: async (request, options) => {
        sessions.push({ method: request.method, path: new URL(request.url).pathname, fresh: options.fresh });
        return signedInUser(request, options);
      },
      ...overrides,
    });
  }

  function request(method: Method, path: string, cookie: string | null, o: CallOptions): Request {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    if (method !== 'GET') {
      const origin = o.origin === undefined ? SITE : o.origin;
      if (origin !== null) headers.set('origin', origin);
      const contentType = o.contentType === undefined ? 'application/json' : o.contentType;
      if (contentType !== null) headers.set('content-type', contentType);
      const fetchSite = o.fetchSite === undefined ? 'same-origin' : o.fetchSite;
      if (fetchSite !== null) headers.set('sec-fetch-site', fetchSite);
    }
    const body = o.body === undefined || method === 'GET' ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    return new Request(`${SITE}/api/team${path}`, { method, headers, body });
  }

  /** One call to the Team routes, as the browser on the site's own page sends it (unless the options say otherwise). */
  async function call<T = Record<string, unknown>>(method: Method, path: string, who: string | null, o: CallOptions = {}, on: Team<Person> = team): Promise<Answer<T>> {
    const response = await on.routeHandlers[method](request(method, path, who ? cookieFor(who, o.viewAs === true) : null, o));
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body: body as Answer<T>['body'], headers: response.headers };
  }

  const state = (who: string, on: Team<Person> = team) => call<TeamState>('GET', '', who, {}, on);
  const add = (who: string, email: string, roleIds: string[], extra: Record<string, unknown> = {}, on: Team<Person> = team) =>
    call<AddResult>('POST', '/employees', who, { body: { email, roleIds, ...extra } }, on);
  const manage = (who: string, id: string, roleIds: string[], token: string) => call<EmployeeView>('PATCH', `/employees/${id}`, who, { body: { roleIds, token } });
  const remove = (who: string, id: string, token: string) => call<{ removed: true }>('DELETE', `/employees/${id}?token=${encodeURIComponent(token)}`, who);
  const editRole = (who: string, r: { id: string; version: number }, body: { name: string; pages: string[]; actions?: string[] }, on: Team<Person> = team) =>
    call<RoleView>('PATCH', `/roles/${r.id}`, who, { body: { actions: [], ...body, version: r.version } }, on);
  const deleteRole = (who: string, r: { id: string; version: number }) => call<{ deleted: true }>('DELETE', `/roles/${r.id}?version=${r.version}`, who);
  const person = (id: string, viewedAs = false): Person => ({ id, email: w.accounts.get(id)?.email ?? null, name: w.accounts.get(id)?.name ?? null, viewedAs });

  async function role(who: string, name: string, pages: string[], actions: string[] = [], on: Team<Person> = team): Promise<RoleView> {
    const made = await call<RoleView>('POST', '/roles', who, { body: { id: crypto.randomUUID(), name, pages, actions } }, on);
    expect({ name, status: made.status, error: made.body.error }).toEqual({ name, status: 201, error: undefined });
    return made.body;
  }

  async function employeeRow(viewer: string, id: string): Promise<EmployeeView> {
    const s = await state(viewer);
    expect(s.status).toBe(200);
    const row = s.body.employees.find((e) => e.id === id);
    if (!row) throw new Error(`${viewer} sees no row for ${id}`);
    return row;
  }

  function account(id: string, name: string, emailVerified = true) {
    w.accounts.set(id, { id, name, email: `${id}@example.com`, emailVerified, lastSeenAt: null });
  }

  /**
   * Managers (Team, Email, Traffic), Support (Email, Traffic) and Books
   * (Payouts), made by Mass Access. Maya: Managers + Support. Sam: Support.
   * Bob: Support + Books, so he is out of Maya's reach.
   */
  async function setup(): Promise<Fixture> {
    const managers = await role('olive', 'Managers', ['team', 'email', 'traffic']);
    const support = await role('olive', 'Support', ['email', 'traffic']);
    const payouts = await role('olive', 'Books', ['payouts']);
    for (const [email, roleIds] of [
      ['maya@example.com', [managers.id, support.id]],
      ['sam@example.com', [support.id]],
      ['bob@example.com', [support.id, payouts.id]],
    ] as const) {
      const added = await add('olive', email, [...roleIds]);
      expect({ email, status: added.status }).toEqual({ email, status: 201 });
    }
    w.signedOut.length = 0;
    sessions.length = 0;
    return { managers, support, payouts };
  }

  // ------------------------------------------------------------ the database, read directly

  /** Everything the Team page can change, and the newest history id: equal before and after means nothing was written. */
  async function snapshot(): Promise<string> {
    const roles = await sql`select id::text as id, name, pages::text as pages, actions::text as actions, version, updated_at::text as updated from team_roles order by id`;
    const employees = await sql`select user_id, added_by, added_at::text as added from team_employees order by user_id`;
    const links = await sql`select user_id, role_id::text as role_id from team_employee_roles order by user_id, role_id`;
    const [history] = await sql`select coalesce(max(id), 0)::text as id from team_history`;
    return JSON.stringify({ roles: [...roles], employees: [...employees], links: [...links], history: history!.id });
  }

  async function mark(): Promise<string> {
    const [row] = await sql`select coalesce(max(id), 0)::text as id from team_history`;
    return row!.id as string;
  }

  async function historySince(from: string): Promise<HistoryRow[]> {
    const rows = await sql`
      select id::text as id, actor_id, action, subject_kind, subject_id, detail::text as detail
      from team_history where id > ${from}::bigint order by id`;
    return rows.map((r) => ({
      id: r.id as string,
      actor_id: (r.actor_id as string | null) ?? null,
      action: r.action as string,
      subject_kind: r.subject_kind as string,
      subject_id: r.subject_id as string,
      detail: JSON.parse(r.detail as string) as Record<string, unknown>,
    }));
  }

  async function stored(roleId: string): Promise<{ name: string; pages: string[]; actions: string[]; version: number } | null> {
    const [row] = await sql`select name, pages::text as pages, actions::text as actions, version from team_roles where id = ${roleId}::uuid`;
    if (!row) return null;
    return { name: row.name as string, pages: JSON.parse(row.pages as string), actions: JSON.parse(row.actions as string), version: Number(row.version) };
  }

  async function rolesOf(userId: string): Promise<string[]> {
    const rows = await sql`select role_id::text as id from team_employee_roles where user_id = ${userId} order by role_id`;
    return rows.map((r) => r.id as string);
  }

  async function isEmployee(userId: string): Promise<boolean> {
    return (await sql`select 1 from team_employees where user_id = ${userId}`).length === 1;
  }

  /** A role written straight to the table, as another version of the app (or an older server) left it. */
  async function insertRoleRow(name: string, pages: string[], actions: string[]): Promise<string> {
    const [row] = await sql`
      insert into team_roles (name, pages, actions, created_by, updated_by)
      values (${name}, ${JSON.stringify(pages)}::text::jsonb, ${JSON.stringify(actions)}::text::jsonb, 'another-version', 'another-version')
      returning id::text as id`;
    return row!.id as string;
  }

  beforeAll(async () => {
    admin = postgres(urlFor('postgres'), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    sql = postgres(urlFor(database), { max: 4, onnotice: () => {} });
    await migrate(sql);
    await sql.unsafe('create schema if not exists team_rules_empty');
    empty = postgres(urlFor(database), { max: 1, onnotice: () => {}, connection: { search_path: 'team_rules_empty' } });
  });

  afterAll(async () => {
    await empty?.end();
    await sql?.end();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`delete from team_employees`;
    await sql`delete from team_roles`;
    w = world();
    sessions = [];
    team = make();
  });

  // ================================================================ rule 1

  describe('rule 1: the Team routes are not there for anyone who may not open the Team page', () => {
    test('every Team route answers the unknown-route 404 to signed-out, view-as (Mass Access too), customers and employees without the Team page, and writes nothing', async () => {
      const f = await setup();
      account('nora', 'Nora None');
      expect((await add('olive', 'nora@example.com', [])).status).toBe(201); // an employee with no roles
      w.signedOut.length = 0;
      const sam = await employeeRow('olive', 'sam');

      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
        const unknown = await call(method, '/no-such-route', 'olive', { body: method === 'GET' ? undefined : {} });
        expect({ method, status: unknown.status, error: unknown.body.error }).toEqual({ method, status: 404, error: ROUTE_404 });
      }

      // Real ids, tokens and versions, so a check that let one through would write something.
      const routes: Array<[Method, string, unknown?]> = [
        ['GET', ''],
        ['GET', '/'],
        ['GET', '/history'],
        ['POST', '/employees', { email: 'cara@example.com', roleIds: [f.support.id] }],
        ['PATCH', '/employees/sam', { roleIds: [f.support.id, f.payouts.id], token: sam.token }],
        ['DELETE', `/employees/sam?token=${sam.token}`],
        ['POST', '/roles', { id: crypto.randomUUID(), name: 'Sneaky', pages: ['payouts'], actions: [] }],
        ['PATCH', `/roles/${f.support.id}`, { name: 'Renamed', pages: ['payouts'], actions: [], version: f.support.version }],
        ['DELETE', `/roles/${f.payouts.id}?version=${f.payouts.version}`],
      ];
      const people: Array<{ label: string; who: string | null; viewAs?: boolean }> = [
        { label: 'signed out', who: null },
        { label: 'Mass Access viewing as someone', who: 'olive', viewAs: true },
        { label: 'a manager viewing as someone', who: 'maya', viewAs: true },
        { label: 'a customer', who: 'cara' },
        { label: 'an employee whose roles skip the Team page', who: 'sam' },
        { label: 'an employee with no roles', who: 'nora' },
      ];
      const before = await snapshot();
      for (const p of people) {
        for (const [method, path, body] of routes) {
          const r = await call(method, path, p.who, { body, viewAs: p.viewAs });
          expect({ who: p.label, route: `${method} ${path}`, status: r.status, error: r.body.error, keys: Object.keys(r.body).sort(), store: r.headers.get('cache-control') }).toEqual({
            who: p.label,
            route: `${method} ${path}`,
            status: 404,
            error: ROUTE_404,
            keys: ['error', 'requestId'],
            store: 'no-store',
          });
        }
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
      expect(w.made).toEqual([]);
    });

    test('history is for Mass Access only: a manager gets the unknown-route 404, whatever the query', async () => {
      await setup();
      for (const path of ['/history', '/history?before=5', '/history?before=not-a-number']) {
        const r = await call('GET', path, 'maya');
        expect({ path, status: r.status, error: r.body.error }).toEqual({ path, status: 404, error: ROUTE_404 });
      }
      const olive = await call<HistoryPage>('GET', '/history', 'olive');
      expect(olive.status).toBe(200);
      expect(olive.body.rows.length).toBeGreaterThan(0);
      expect((await call('GET', '/history?before=not-a-number', 'olive')).status).toBe(400);
      // The page's own state tells a manager nothing about history either.
      expect((await state('maya')).body.problem).toBeNull();
    });

    test('GET me: anyone signed in gets their own view; view-as gets the NOBODY view; signed out gets the 404', async () => {
      await setup();
      const me = async (who: string | null, viewAs = false) => {
        const r = await call<TeamView>('GET', '/me', who, { viewAs });
        if (r.status !== 200) return { status: r.status, error: r.body.error };
        return { status: 200, view: { massAccess: r.body.massAccess, employee: r.body.employee, pages: sorted(r.body.pages), actions: sorted(r.body.actions) } };
      };
      expect(await me('cara')).toEqual({ status: 200, view: NOBODY_VIEW });
      expect(await me('una')).toEqual({ status: 200, view: NOBODY_VIEW });
      expect(await me('sam')).toEqual({ status: 200, view: { massAccess: false, employee: true, pages: ['email', 'traffic'], actions: [] } });
      expect(await me('maya')).toEqual({ status: 200, view: { massAccess: false, employee: true, pages: ['email', 'team', 'traffic'], actions: [] } });
      expect(await me('olive')).toEqual({ status: 200, view: { massAccess: true, employee: false, pages: [], actions: [] } });
      expect(await me('olive', true)).toEqual({ status: 200, view: NOBODY_VIEW });
      expect(await me('maya', true)).toEqual({ status: 200, view: NOBODY_VIEW });
      expect(await me(null)).toEqual({ status: 404, error: ROUTE_404 });
    });

    test('a refused change does not show a signed-out visitor that a Team route exists: it gets the unknown-route answer whatever it sent', async () => {
      const body = { id: crypto.randomUUID(), name: 'Probe', pages: ['email'], actions: [] };
      for (const headers of [{ origin: 'https://evil.example' }, { contentType: 'text/plain' }] as const) {
        const real = await call('POST', '/roles', null, { body, ...headers });
        const unknown = await call('POST', '/no-such-route', null, { body, ...headers });
        expect({ headers, status: real.status, error: real.body.error }).toEqual({ headers, status: unknown.status, error: unknown.body.error });
      }
    });
  });

  // ================================================================ rule 2

  describe("rule 2: changes come only as JSON from the site's own pages, with a fresh session", () => {
    async function writes(f: Fixture): Promise<Array<[Method, string, unknown?]>> {
      const sam = await employeeRow('olive', 'sam');
      return [
        ['POST', '/employees', { email: 'cara@example.com', roleIds: [f.support.id] }],
        ['PATCH', '/employees/sam', { roleIds: [], token: sam.token }],
        ['DELETE', `/employees/sam?token=${sam.token}`],
        ['POST', '/roles', { id: crypto.randomUUID(), name: 'Sneaky', pages: ['payouts'], actions: [] }],
        ['PATCH', `/roles/${f.support.id}`, { name: 'Renamed', pages: ['email'], actions: [], version: f.support.version }],
        ['DELETE', `/roles/${f.payouts.id}?version=${f.payouts.version}`],
      ];
    }

    test('a change from another site is refused with 403 and nothing is written', async () => {
      const f = await setup();
      const routes = await writes(f);
      const before = await snapshot();
      const tries: Array<{ label: string; origin?: string | null; fetchSite?: string | null }> = [
        { label: 'another site', origin: 'https://evil.example' },
        { label: 'a look-alike host', origin: 'https://example.com.evil.example' },
        { label: 'a sub-domain siteHosts does not list', origin: 'https://admin.example.com' },
        { label: 'an opaque origin', origin: 'null' },
        { label: 'our origin, but the browser says cross-site', fetchSite: 'cross-site' },
        { label: 'no origin, and the browser says cross-site', origin: null, fetchSite: 'cross-site' },
      ];
      for (const t of tries) {
        for (const [method, path, body] of routes) {
          const r = await call(method, path, 'olive', { body, origin: t.origin, fetchSite: t.fetchSite });
          expect({ t: t.label, route: `${method} ${path}`, status: r.status, code: r.body.error?.code }).toEqual({
            t: t.label,
            route: `${method} ${path}`,
            status: 403,
            code: 'cross_site',
          });
        }
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
      expect(w.made).toEqual([]);
    });

    test('a POST or PATCH that is not JSON is refused and writes nothing', async () => {
      const f = await setup();
      const routes = (await writes(f)).filter(([method]) => method !== 'DELETE');
      const before = await snapshot();
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
        for (const [method, path, body] of routes) {
          const r = await call(method, path, 'olive', { body, contentType });
          expect({ contentType, route: `${method} ${path}`, refused: r.status >= 400 && r.status < 500 }).toEqual({ contentType, route: `${method} ${path}`, refused: true });
        }
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });

    test('a POST or PATCH that is not JSON is a 403', async () => {
      const f = await setup();
      for (const [method, path, body] of (await writes(f)).filter(([m]) => m !== 'DELETE')) {
        const r = await call(method, path, 'olive', { body, contentType: 'text/plain' });
        expect({ route: `${method} ${path}`, status: r.status }).toEqual({ route: `${method} ${path}`, status: 403 });
      }
    });

    test('a DELETE that is not sent as JSON is refused and writes nothing', async () => {
      const f = await setup();
      const sam = await employeeRow('olive', 'sam');
      const before = await snapshot();
      const removeSam = await call('DELETE', `/employees/sam?token=${sam.token}`, 'olive', { contentType: 'text/plain' });
      const deleteBooks = await call('DELETE', `/roles/${f.payouts.id}?version=${f.payouts.version}`, 'olive', { contentType: null });
      expect([removeSam.status, deleteBooks.status]).toEqual([403, 403]);
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });

    test('a change with no Origin header is refused: the Origin host must be one of siteHosts', async () => {
      await setup();
      const before = await snapshot();
      const r = await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: 'No origin', pages: ['email'], actions: [] }, origin: null, fetchSite: null });
      expect(r.status).toBe(403);
      expect(await snapshot()).toBe(before);
    });

    test('JSON with a charset, in any case, from the listed host on any port, goes through', async () => {
      await setup();
      const ok = [
        { contentType: 'application/json; charset=utf-8' },
        { contentType: 'Application/JSON' },
        { origin: 'https://example.com:8443' },
        { origin: 'https://EXAMPLE.com' },
      ];
      for (const [n, o] of ok.entries()) {
        const r = await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: `Fine ${n}`, pages: ['email'], actions: [] }, ...o });
        expect({ o, status: r.status }).toEqual({ o, status: 201 });
      }
    });

    test('every change reads the session fresh; a read does not have to', async () => {
      const f = await setup();
      const sam = await employeeRow('olive', 'sam');
      const temp = await role('olive', 'Temp', ['email']);
      sessions.length = 0;
      expect((await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: 'Fresh', pages: ['email'], actions: [] } })).status).toBe(201);
      expect((await editRole('olive', f.payouts, { name: 'Books', pages: ['payouts', 'email'] })).status).toBe(200);
      expect((await deleteRole('olive', temp)).status).toBe(200);
      expect((await add('olive', 'cara@example.com', [])).status).toBe(201);
      const changed = await manage('olive', 'sam', [f.support.id, f.payouts.id], sam.token);
      expect(changed.status).toBe(200);
      expect((await remove('olive', 'sam', changed.body.token)).status).toBe(200);
      const changes = sessions.filter((s) => s.method !== 'GET');
      expect(changes.map((s) => s.method)).toEqual(['POST', 'PATCH', 'DELETE', 'POST', 'PATCH', 'DELETE']);
      expect(changes.every((s) => s.fresh === true)).toBe(true);
    });

    test('no GET writes anything', async () => {
      const f = await setup();
      const before = await snapshot();
      const paths = ['', '/me', '/history', '/history?before=999999', '/employees', '/employees/sam', '/roles', `/roles/${f.support.id}`];
      for (const who of ['olive', 'maya', 'sam', 'cara', null]) {
        for (const path of paths) {
          await call('GET', path, who);
          if (who) await call('GET', path, who, { viewAs: true });
        }
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });
  });

  // ================================================================ rule 3

  describe('rule 3: making a role', () => {
    test('a manager can only put in a new role the pages they can open and the actions they can do; a refusal is a 403 and writes nothing', async () => {
      await setup();
      const before = await snapshot();
      const tries: Array<[string[], string[]]> = [
        [['payouts'], []],
        [['signup-funnel'], []],
        [['email', 'payouts'], []],
        [['email'], ['email.settings']],
        [[], ['email.settings']],
      ];
      for (const [pages, actions] of tries) {
        const r = await call('POST', '/roles', 'maya', { body: { id: crypto.randomUUID(), name: 'Books two', pages, actions } });
        expect({ pages, actions, status: r.status, code: r.body.error?.code }).toEqual({ pages, actions, status: 403, code: 'not_yours' });
      }
      expect(await snapshot()).toBe(before);
    });

    test('the 403 names the first refused item', async () => {
      await setup();
      const r = await call('POST', '/roles', 'maya', { body: { id: crypto.randomUUID(), name: 'Books two', pages: ['email', 'payouts', 'signup-funnel'], actions: [] } });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body.error)).toMatch(/payouts|Payouts/);
    });

    test("a manager's new role is assigned to them in the same transaction, with one history row", async () => {
      await setup();
      const from = await mark();
      const made = await role('maya', 'Front desk', ['team', 'email']);
      expect([made.mine, made.people, made.pages, made.actions]).toEqual([true, 1, ['email', 'team'], []]);
      const rows = await historySince(from);
      expect(rows.map((h) => [h.action, h.actor_id, h.subject_kind, h.subject_id])).toEqual([['role.made', 'maya', 'role', made.id]]);
      // now() is the transaction's start: the role, maya's hold on it and its history row share it.
      const [same] = await sql`
        select r.created_at = er.given_at as given, r.created_at = h.at as history, er.given_by
        from team_roles r
        join team_employee_roles er on er.role_id = r.id and er.user_id = 'maya'
        join team_history h on h.id = ${rows[0]!.id}::bigint
        where r.id = ${made.id}::uuid`;
      expect(same).toEqual({ given: true, history: true, given_by: 'maya' });
      expect((await state('maya')).body.roles.some((r) => r.id === made.id && r.mine)).toBe(true);
    });

    test('a role Mass Access makes goes to nobody, even when that Mass Access account is also on the team', async () => {
      await setup();
      const byOlive = await role('olive', 'Unassigned', ['payouts']);
      expect([byOlive.people, byOlive.mine]).toEqual([0, false]);
      w.massAccess.add('bob'); // bob is on the team, and has Mass Access now
      const byBob = await role('bob', 'Also unassigned', ['email']);
      expect([byBob.people, byBob.mine]).toEqual([0, false]);
      expect(await sql`select user_id from team_employee_roles where role_id in (${byOlive.id}::uuid, ${byBob.id}::uuid)`).toHaveLength(0);
    });

    test('each action brings its page, for Mass Access and for a manager who can do it', async () => {
      const f = await setup();
      const alone = await role('olive', 'Settings only', [], ['email.settings']);
      expect([alone.pages, alone.actions]).toEqual([['email'], ['email.settings']]);
      const inbox = await role('olive', 'Inbox', ['email'], ['email.settings']);
      const maya = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [f.managers.id, f.support.id, inbox.id], maya.token)).status).toBe(200);
      const hers = await role('maya', 'Inbox helpers', ['traffic'], ['email.settings']);
      expect([hers.pages, hers.actions]).toEqual([['email', 'traffic'], ['email.settings']]);
      expect(await stored(hers.id)).toMatchObject({ pages: ['email', 'traffic'], actions: ['email.settings'] });
    });

    test('never stored, by anyone: unknown, retired, mass-access, every-employee and everyone keys, or an address', async () => {
      team = make({ retiredGrants: ['old-reports', 'old.export'] });
      const f = await setup();
      const before = await snapshot();
      const badPages = ['nope', 'old-reports', 'log-in-as', '/dashboard/admin/log-in-as', 'overview', '/dashboard/overview', 'home', '/dashboard', 'Email', '/dashboard/admin/email', 'email.settings'];
      for (const key of badPages) {
        const made = await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: 'Bad', pages: ['email', key], actions: [] } });
        const edited = await editRole('olive', f.support, { name: 'Support', pages: ['email', 'traffic', key] });
        expect({ key, made: made.status, edited: edited.status }).toEqual({ key, made: 400, edited: 400 });
      }
      for (const key of ['nope.action', 'old.export', 'email']) {
        const made = await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: 'Bad', pages: ['email'], actions: [key] } });
        const edited = await editRole('olive', f.support, { name: 'Support', pages: ['email', 'traffic'], actions: [key] });
        expect({ key, made: made.status, edited: edited.status }).toEqual({ key, made: 400, edited: 400 });
      }
      expect(await snapshot()).toBe(before);
    });
  });

  // ================================================================ rule 4

  describe('rule 4: editing a role', () => {
    test('only someone who holds the role (or Mass Access) may edit or delete it, and the refusal shows nothing of it', async () => {
      const f = await setup();
      const before = await snapshot();
      const edit = await editRole('maya', f.payouts, { name: 'Books', pages: ['payouts', 'email'] });
      const del = await deleteRole('maya', f.payouts);
      for (const r of [edit, del]) {
        expect([403, 404]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toContain('Books');
      }
      expect(await snapshot()).toBe(before);
      expect((await editRole('olive', f.payouts, { name: 'Books', pages: ['payouts', 'email'] })).status).toBe(200);
    });

    test('a holder may rename a role even when its other holders are out of their reach', async () => {
      const f = await setup();
      const from = await mark();
      const renamed = await editRole('maya', f.support, { name: 'Helpdesk', pages: ['email', 'traffic'] });
      expect([renamed.status, renamed.body.name, renamed.body.version]).toEqual([200, 'Helpdesk', f.support.version + 1]);
      expect((await stored(f.support.id))?.name).toBe('Helpdesk');
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.detail.renamedFrom, h.detail.name])).toEqual([['role.changed', 'maya', 'Support', 'Helpdesk']]);
    });

    test("adding to a role is limited to the editor's catalog, and needs no reach", async () => {
      const f = await setup();
      const before = await snapshot();
      const tries: Array<[string[], string[]]> = [
        [['email', 'traffic', 'payouts'], []],
        [['email', 'traffic', 'signup-funnel'], []],
        [['email', 'traffic'], ['email.settings']],
      ];
      for (const [pages, actions] of tries) {
        const r = await editRole('maya', f.support, { name: 'Support', pages, actions });
        expect({ pages, actions, status: r.status, code: r.body.error?.code }).toEqual({ pages, actions, status: 403, code: 'not_yours' });
      }
      expect(await snapshot()).toBe(before);
      // The Team page is hers to give; bob (out of her reach) gets it with the role, and that is allowed.
      const r = await editRole('maya', f.support, { name: 'Support', pages: ['email', 'traffic', 'team'] });
      expect(r.status).toBe(200);
      expect((await stored(f.support.id))?.pages).toEqual(['email', 'traffic', 'team']);
    });

    test('taking pages or actions off a role, or deleting it, needs every other holder in reach; Mass Access holders never stop it', async () => {
      const f = await setup();
      // Support also gets the email settings action (Mass Access gives it), so Maya can do it too.
      const withAction = await editRole('olive', f.support, { name: 'Support', pages: ['email', 'traffic'], actions: ['email.settings'] });
      expect(withAction.status).toBe(200);
      const support = withAction.body;
      const before = await snapshot();
      const offPage = await editRole('maya', support, { name: 'Support', pages: ['email'], actions: ['email.settings'] });
      const offAction = await editRole('maya', support, { name: 'Support', pages: ['email', 'traffic'], actions: [] });
      const del = await deleteRole('maya', support);
      for (const r of [offPage, offAction, del]) expect([r.status, r.body.error?.code]).toEqual([403, 'out_of_reach']);
      expect(await snapshot()).toBe(before);

      // bob gets Mass Access: he loses nothing, so he no longer stops her.
      w.massAccess.add('bob');
      const now = await editRole('maya', support, { name: 'Support', pages: ['email'], actions: ['email.settings'] });
      expect(now.status).toBe(200);
      expect(await stored(f.support.id)).toMatchObject({ pages: ['email'], actions: ['email.settings'] });
      w.massAccess.delete('bob');
      expect((await deleteRole('maya', now.body)).status).toBe(403);

      // Once bob holds only roles she holds, she may delete it; its holders lose it.
      const bob = await employeeRow('olive', 'bob');
      expect((await manage('olive', 'bob', [f.support.id], bob.token)).status).toBe(200);
      const gone = await deleteRole('maya', now.body);
      expect([gone.status, gone.body]).toEqual([200, { deleted: true }]);
      expect(await stored(f.support.id)).toBeNull();
      expect(await rolesOf('sam')).toEqual([]);
      expect(await rolesOf('maya')).toEqual([f.managers.id]);
    });

    test("a save keeps what the editor couldn't see: keys this version of the app doesn't list, whoever saves", async () => {
      const f = await setup();
      // A newer version of the app stored a page and an action this one doesn't list.
      const reports = await insertRoleRow('Reports', ['email', 'reports-v2'], ['email.settings', 'reports-v2.export']);
      const maya = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [f.managers.id, f.support.id, reports], maya.token)).status).toBe(200);
      const seen = (await state('maya')).body.roles.find((r) => r.id === reports)!;
      expect([seen.pages, seen.actions]).toEqual([['email'], ['email.settings']]); // the editor is shown only what this version lists

      // Maya ticks Traffic and unticks the action (she is its only holder).
      const saved = await editRole('maya', seen, { name: 'Reports', pages: ['email', 'traffic'], actions: [] });
      expect(saved.status).toBe(200);
      let row = (await stored(reports))!;
      expect([sorted(row.pages), sorted(row.actions)]).toEqual([['email', 'reports-v2', 'traffic'], ['reports-v2.export']]);

      // Mass Access saving keeps them too.
      const again = await editRole('olive', saved.body, { name: 'Reports', pages: ['traffic'], actions: [] });
      expect(again.status).toBe(200);
      row = (await stored(reports))!;
      expect([sorted(row.pages), sorted(row.actions)]).toEqual([['reports-v2', 'traffic'], ['reports-v2.export']]);
    });

    test('unticking a page drops its actions (as the page sends it); ticking an action brings its page back', async () => {
      await setup();
      const r = await role('olive', 'Mail', ['traffic'], ['email.settings']);
      expect([r.pages, r.actions]).toEqual([['email', 'traffic'], ['email.settings']]);
      const off = await editRole('olive', r, { name: 'Mail', pages: ['traffic'], actions: [] });
      expect(off.status).toBe(200);
      expect(await stored(r.id)).toMatchObject({ pages: ['traffic'], actions: [] });
      const on = await editRole('olive', off.body, { name: 'Mail', pages: ['traffic'], actions: ['email.settings'] });
      expect(on.status).toBe(200);
      expect(await stored(r.id)).toMatchObject({ pages: ['email', 'traffic'], actions: ['email.settings'] });
    });

    test('an action left ticked under a page that was unticked is dropped with the page', async () => {
      await setup();
      const r = await role('olive', 'Mail', ['email', 'traffic'], ['email.settings']);
      const saved = await editRole('olive', r, { name: 'Mail', pages: ['traffic'], actions: ['email.settings'] });
      expect(saved.status).toBe(200);
      expect(await stored(r.id)).toMatchObject({ pages: ['traffic'], actions: [] });
    });

    test("an action kept because the editor can't give it never brings in a page they can't open (an action that moved to another page)", async () => {
      // Version 1 of the app has "Make tracking links" on Traffic.
      const v1 = make({ nav: withAction(NAV, 'traffic', { key: 'links.make', label: 'Make tracking links' }) });
      const managers = await role('olive', 'Managers', ['team', 'email'], [], v1);
      const links = await role('olive', 'Links', ['traffic'], ['links.make'], v1);
      expect((await add('olive', 'maya@example.com', [managers.id, links.id], {}, v1)).status).toBe(201);
      // Version 2 moves the action to Payouts. Maya can't open Payouts.
      const v2 = make({ nav: withAction(NAV, 'payouts', { key: 'links.make', label: 'Make tracking links' }) });
      expect(await v2.can(person('maya'), 'payouts')).toBe(false);
      // She renames Links: her editor shows Traffic ticked, and nothing else she could give.
      const seen = (await state('maya', v2)).body.roles.find((r) => r.id === links.id)!;
      const saved = await editRole('maya', seen, { name: 'Tracking', pages: ['traffic'], actions: [] }, v2);
      expect(saved.status).toBe(200);
      expect((await stored(links.id))?.pages).not.toContain('payouts');
      expect(await v2.can(person('maya'), 'payouts')).toBe(false);
    });

    test("pressing Save on an unchanged role never adds a page the editor can't give (an every-employee page with an action became a role page)", async () => {
      const withExport = (access: 'employees' | 'role'): TeamNav =>
        NAV.map((section) => ({
          ...section,
          items: section.items.map((item) =>
            item.href === '/dashboard/overview'
              ? { ...item, access, ...(access === 'role' ? { grant: 'overview' } : {}), actions: [{ key: 'overview.export', label: 'Export the overview' }] }
              : item,
          ),
        }));
      // Version 1 of the app: Overview is for every employee, and has an Export action.
      const v1 = make({ nav: withExport('employees') });
      const managers = await role('olive', 'Managers', ['team', 'email'], [], v1);
      const reports = await role('olive', 'Reports', ['email'], ['overview.export'], v1);
      expect((await add('olive', 'maya@example.com', [managers.id, reports.id], {}, v1)).status).toBe(201);
      // Version 2 makes Overview a role page. Nobody gave it to Maya.
      const v2 = make({ nav: withExport('role') });
      expect(await v2.can(person('maya'), 'overview')).toBe(false);
      // She opens Reports and presses Save: her editor sends what she could tick, Email and nothing else.
      const from = await mark();
      const saved = await editRole('maya', reports, { name: 'Reports', pages: ['email'], actions: [] }, v2);
      expect(saved.status).toBe(200);
      expect(await stored(reports.id)).toMatchObject({ pages: ['email'], actions: ['overview.export'], version: reports.version });
      expect(await v2.can(person('maya'), 'overview')).toBe(false);
      expect(await historySince(from)).toEqual([]);
      // Ticking the action herself is refused: its page is not hers to give.
      const ticked = await editRole('maya', reports, { name: 'Reports', pages: ['email'], actions: ['overview.export'] }, v2);
      expect([ticked.status, ticked.body.error?.code]).toEqual([403, 'not_yours']);
      expect(await stored(reports.id)).toMatchObject({ pages: ['email'], actions: ['overview.export'] });
    });
  });

  // ================================================================ rule 5

  describe('rule 5: managing someone', () => {
    test('only an employee can be managed (else 404); never yourself or a Mass Access account (403); nothing written', async () => {
      const f = await setup();
      const before = await snapshot();
      for (const who of ['olive', 'maya']) {
        const r = await manage(who, 'cara', [f.support.id], 'any');
        expect({ who, status: r.status }).toEqual({ who, status: 404 });
      }
      const mine = await employeeRow('maya', 'maya');
      expect([mine.you, mine.canManage, mine.canRemove]).toEqual([true, false, false]);
      const self = await manage('maya', 'maya', [f.managers.id], mine.token);
      expect([self.status, self.body.error?.code]).toEqual([403, 'self']);
      expect(self.body.error?.message).toBe("You can't change your own roles. Ask someone else who manages the team.");

      w.massAccess.add('bob'); // still on the team, now Mass Access
      const bob = await employeeRow('olive', 'bob');
      for (const who of ['olive', 'maya']) {
        const r = await manage(who, 'bob', [f.support.id], bob.token);
        expect({ who, status: r.status, code: r.body.error?.code, message: r.body.error?.message }).toEqual({
          who,
          status: 403,
          code: 'has_mass_access',
          message: "Mass Access can't be changed here.",
        });
      }
      expect(await snapshot()).toBe(before);
    });

    test('the roles asked for must be ones the manager holds; Mass Access may give any', async () => {
      const f = await setup();
      const sam = await employeeRow('maya', 'sam');
      const before = await snapshot();
      const r = await manage('maya', 'sam', [f.support.id, f.payouts.id], sam.token);
      expect([r.status, r.body.error?.code]).toEqual([403, 'not_yours']);
      expect(await snapshot()).toBe(before);
      const o = await manage('olive', 'sam', [f.support.id, f.payouts.id], sam.token);
      expect(o.status).toBe(200);
      expect(await rolesOf('sam')).toEqual(sorted([f.support.id, f.payouts.id]));
    });

    test("giving works for anyone; taking a role off needs reach; roles the manager can't see stay as they are", async () => {
      const f = await setup();
      const bob = await employeeRow('maya', 'bob');
      expect([bob.roleIds, bob.hiddenRoles, bob.canManage, bob.canRemove]).toEqual([[f.support.id], 1, true, false]);
      // Give bob Managers: he holds Books, which she doesn't, but giving needs no reach.
      const given = await manage('maya', 'bob', [f.support.id, f.managers.id], bob.token);
      expect(given.status).toBe(200);
      expect(await rolesOf('bob')).toEqual(sorted([f.managers.id, f.support.id, f.payouts.id]));
      expect([sorted(given.body.roleIds), given.body.hiddenRoles]).toEqual([sorted([f.managers.id, f.support.id]), 1]);
      // Taking Support off bob needs reach.
      const before = await snapshot();
      const take = await manage('maya', 'bob', [f.managers.id], given.body.token);
      expect([take.status, take.body.error?.code]).toEqual([403, 'out_of_reach']);
      expect(await snapshot()).toBe(before);
      // Sam is in reach: Support comes off, and he stays an employee with no roles.
      const sam = await employeeRow('maya', 'sam');
      const off = await manage('maya', 'sam', [], sam.token);
      expect(off.status).toBe(200);
      expect(await rolesOf('sam')).toEqual([]);
      expect(await isEmployee('sam')).toBe(true);
    });
  });

  // ================================================================ rule 6

  describe('rule 6: removing someone', () => {
    test('never yourself, a Mass Access account, or someone out of reach; nothing written and nobody signed out', async () => {
      await setup();
      const before = await snapshot();
      const mine = await employeeRow('maya', 'maya');
      const self = await remove('maya', 'maya', mine.token);
      expect([self.status, self.body.error?.code]).toEqual([403, 'self']);
      const olive = await remove('maya', 'olive', 'any');
      expect([olive.status, olive.body.error?.code]).toEqual([403, 'has_mass_access']);
      const bob = await employeeRow('maya', 'bob');
      const outOfReach = await remove('maya', 'bob', bob.token);
      expect([outOfReach.status, outOfReach.body.error?.code]).toEqual([403, 'out_of_reach']);
      w.massAccess.add('bob');
      for (const who of ['olive', 'maya']) {
        const r = await remove(who, 'bob', bob.token);
        expect({ who, status: r.status, code: r.body.error?.code }).toEqual({ who, status: 403, code: 'has_mass_access' });
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
      // Not on the team: 404.
      expect((await remove('olive', 'cara', 'any')).status).toBe(404);
    });

    test('a removal keeps the account, signs them out everywhere after it is saved, and writes one history row', async () => {
      const seen: Array<[string, boolean]> = [];
      team = make({ signOutEverywhere: async (id) => void seen.push([id, await isEmployee(id)]) });
      const f = await setup();
      seen.length = 0;
      const sam = await employeeRow('maya', 'sam');
      const from = await mark();
      const r = await remove('maya', 'sam', sam.token);
      expect([r.status, r.body]).toEqual([200, { removed: true }]);
      expect(seen).toEqual([['sam', false]]); // once, and only after the removal was committed
      expect(w.accounts.has('sam')).toBe(true);
      expect(await rolesOf('sam')).toEqual([]);
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.subject_id])).toEqual([['employee.removed', 'maya', 'sam']]);
      expect(await team.can(person('sam'), 'email')).toBe(false);
      const again = await add('olive', 'sam@example.com', [f.support.id]);
      expect([again.status, again.body.outcome]).toEqual([201, 'joined']);
    });
  });

  // ================================================================ rule 7 and section 5

  describe('rule 7 and section 5: adding someone', () => {
    test('a manager adds only with roles they hold, Mass Access with any; a refusal makes no login and writes nothing', async () => {
      const f = await setup();
      const before = await snapshot();
      const r1 = await add('maya', 'cara@example.com', [f.payouts.id]);
      const r2 = await add('maya', 'nia@example.com', [f.support.id, f.payouts.id], { name: 'Nia New' });
      for (const r of [r1, r2]) expect([r.status, r.body.error?.code]).toEqual([403, 'not_yours']);
      expect(w.made).toEqual([]);
      expect(w.signedOut).toEqual([]);
      expect(await snapshot()).toBe(before);
      expect((await add('maya', 'cara@example.com', [f.support.id])).status).toBe(201);
      account('dee', 'Dee Daily');
      expect((await add('olive', 'dee@example.com', [f.payouts.id, f.managers.id])).status).toBe(201);
      expect(await rolesOf('dee')).toEqual(sorted([f.payouts.id, f.managers.id]));
    });

    test('an existing confirmed account joins at once and is signed out everywhere after it is saved', async () => {
      const seen: Array<[string, boolean]> = [];
      team = make({ signOutEverywhere: async (id) => void seen.push([id, await isEmployee(id)]) });
      const f = await setup();
      seen.length = 0;
      const from = await mark();
      const r = await add('maya', ' CARA@Example.com ', [f.support.id]);
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ outcome: 'joined', emailed: null, opens: ['Overview', 'Email', 'Traffic'] });
      expect(r.body.employee).toMatchObject({ id: 'cara', name: 'Cara Customer', email: 'cara@example.com', roleIds: [f.support.id], you: false });
      expect(seen).toEqual([['cara', true]]); // once, and only after the join was committed
      expect(await team.can(person('cara'), 'email')).toBe(true);
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.subject_id, h.detail.made])).toEqual([['employee.added', 'maya', 'cara', false]]);
    });

    test('refused with one plain line, nothing written, nobody signed out: Mass Access, already an employee, yourself, an unconfirmed email, a bad email', async () => {
      await setup();
      account('mia', 'Mia Mass');
      w.massAccess.add('mia');
      // An app that can't say whether the email is confirmed: not confirmed.
      w.accounts.set('vic', { id: 'vic', name: 'Vic Vague', email: 'vic@example.com', emailVerified: null, lastSeenAt: null });
      const before = await snapshot();
      const cases: Array<{ who: string; email: string; code: string; message: string; param?: string }> = [
        { who: 'olive', email: 'mia@example.com', code: 'has_mass_access', message: 'Mia Mass has Mass Access, so they already open every page.', param: 'email' },
        { who: 'maya', email: 'olive@example.com', code: 'has_mass_access', message: 'Olive Owner has Mass Access, so they already open every page.', param: 'email' },
        { who: 'maya', email: 'sam@example.com', code: 'already_employee', message: 'Sam Support is already an employee.', param: 'email' },
        { who: 'maya', email: 'maya@example.com', code: 'self', message: "You can't add yourself.", param: 'email' },
        { who: 'olive', email: 'olive@example.com', code: 'self', message: "You can't add yourself.", param: 'email' },
        {
          who: 'maya',
          email: 'una@example.com',
          code: 'email_not_confirmed',
          message: "una@example.com has an account that hasn't confirmed its email yet. Ask them to confirm it first, then add them.",
          param: 'email',
        },
        {
          who: 'olive',
          email: 'vic@example.com',
          code: 'email_not_confirmed',
          message: "vic@example.com has an account that hasn't confirmed its email yet. Ask them to confirm it first, then add them.",
          param: 'email',
        },
        { who: 'maya', email: 'not-an-email', code: 'invalid_email', message: 'Type a full email address, like jordan@company.com.', param: 'email' },
      ];
      for (const c of cases) {
        const r = await add(c.who, c.email, []);
        expect({ email: c.email, refused: r.status >= 400 && r.status < 500, code: r.body.error?.code, message: r.body.error?.message, param: r.body.error?.param }).toEqual({
          email: c.email,
          refused: true,
          code: c.code,
          message: c.message,
          param: c.param,
        });
        expect(r.body.error?.message).not.toContain('Forgot password');
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
      expect(w.made).toEqual([]);
    });

    test('no account, and the app can make one: account_made, emailed, joined at once with no sign-out', async () => {
      const f = await setup();
      const makeAccount = fakeConfig(w).createAccount!;
      const asked: unknown[] = [];
      team = make({ createAccount: async (input) => (asked.push(input), makeAccount(input)) });
      const from = await mark();
      const r = await add('maya', 'nia@example.com', [f.support.id], { name: '  Nia   New ' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ outcome: 'account_made', emailed: true, opens: ['Overview', 'Email', 'Traffic'] });
      expect(asked).toEqual([{ email: 'nia@example.com', name: 'Nia New', addedBy: { id: 'maya', name: 'Maya Manager' } }]);
      const id = r.body.employee.id;
      expect(w.made).toEqual([id]);
      expect(w.signedOut).toEqual([]);
      expect(await rolesOf(id)).toEqual([f.support.id]);
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.subject_id, h.detail.made])).toEqual([['employee.added', 'maya', id, true]]);

      // The app says the email with the link didn't go out.
      team = make({ createAccount: async (input) => ({ ...(await makeAccount(input))!, emailed: false }) });
      const r2 = await add('olive', 'otto@example.com', [], { name: 'Otto Other' });
      expect([r2.status, r2.body.outcome, r2.body.emailed]).toEqual([201, 'account_made', false]);

      // A full name is needed, and no login is made without one.
      const r3 = await add('olive', 'pat@example.com', [], { name: 'P' });
      expect([r3.status, r3.body.error?.code, r3.body.error?.param]).toEqual([400, 'name_required', 'name']);
      expect(w.made).toHaveLength(2);
      expect(w.signedOut).toEqual([]);
    });

    test('a role that is gone is refused before any login is made, for Mass Access too', async () => {
      await setup();
      const gone = crypto.randomUUID();
      const r = await add('olive', 'nia@example.com', [gone], { name: 'Nia New' });
      expect([r.status, r.body.error?.code]).toEqual([409, 'role_gone']);
      expect(w.made).toEqual([]);
    });

    test('a login made just before the add is refused: the answer says the login exists and what to do', async () => {
      const f = await setup();
      const makeAccount = fakeConfig(w).createAccount!;
      // The role is deleted in the moment between the app making the login and the person being put on the team.
      team = make({
        createAccount: async (input) => {
          const made = await makeAccount(input);
          await sql`delete from team_roles where id = ${f.payouts.id}::uuid`;
          return made;
        },
      });
      const r = await add('olive', 'nia@example.com', [f.payouts.id], { name: 'Nia New' });
      expect([r.status, r.body.error?.code]).toEqual([409, 'account_made_not_added']);
      expect(r.body.error?.message).toBe(
        "One of those roles was just deleted. Close this and try again. Their login was made and they were emailed, but they aren't on the team yet. Once they've confirmed their email, add them again.",
      );
      expect(w.made).toHaveLength(1);
      expect(await rolesOf(w.made[0]!)).toEqual([]);
      expect((await state('olive')).body.employees.map((e) => e.id)).not.toContain(w.made[0]!);
    });

    test('a refusal about the typed email names the email field, so the page shows it under Email', async () => {
      await setup();
      w.massAccess.add('cara');
      const tries: Array<[string, string, string]> = [
        ['maya', 'maya@example.com', 'self'],
        ['olive', 'sam@example.com', 'already_employee'],
        ['olive', 'cara@example.com', 'has_mass_access'],
      ];
      for (const [who, email, code] of tries) {
        const r = await add(who, email, []);
        expect({ email, code: r.body.error?.code, param: r.body.error?.param }).toEqual({ email, code, param: 'email' });
      }
    });

    test('createAccount answering created: false means the account-exists rules apply', async () => {
      const f = await setup();
      // The account appeared between the email lookup and createAccount, so byEmail missed it.
      const accounts = fakeConfig(w).accounts;
      team = make({ accounts: { ...accounts, byEmail: async () => null } });
      const joined = await add('olive', 'cara@example.com', [f.support.id], { name: 'Cara Customer' });
      expect([joined.status, joined.body.outcome, joined.body.emailed]).toEqual([201, 'joined', null]);
      expect(w.signedOut).toEqual(['cara']);
      const before = await snapshot();
      const refusals: Array<[string, string, string]> = [
        ['olive', 'una@example.com', 'email_not_confirmed'],
        ['maya', 'olive@example.com', 'has_mass_access'],
        ['maya', 'maya@example.com', 'self'],
        ['olive', 'sam@example.com', 'already_employee'],
      ];
      for (const [who, email, code] of refusals) {
        const r = await add(who, email, [], { name: 'Some Name' });
        expect({ email, code: r.body.error?.code }).toEqual({ email, code });
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual(['cara']);
      expect(w.made).toEqual([]);
    });

    test('createAccount answering nothing, or an account with another email, is refused and writes nothing', async () => {
      const f = await setup();
      const before = await snapshot();
      const answers = [async () => ({ id: 'cara', created: true }), async () => null, async () => ({ id: 'no-such-account', created: true })];
      for (const createAccount of answers) {
        team = make({ createAccount });
        const r = await add('olive', 'zed@example.com', [f.support.id], { name: 'Zed Zero' });
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });

    test('no account and no createAccount: the sign-up line, with the link to copy when there is one', async () => {
      await setup();
      const before = await snapshot();
      team = make({ createAccount: undefined, signUpUrl: 'https://app.example.com/sign-up' });
      const r = await add('olive', 'nobody@example.com', []);
      expect(r.body.error).toMatchObject({
        code: 'no_account',
        message: 'No account has this email yet. Ask them to sign up at app.example.com with it, then add them here.',
        hint: 'https://app.example.com/sign-up',
      });
      expect((await state('olive')).body).toMatchObject({ canMakeAccounts: false, signUpUrl: 'https://app.example.com/sign-up' });
      team = make({ createAccount: undefined });
      const r2 = await add('olive', 'nobody@example.com', []);
      expect(r2.body.error?.message).toBe('No account has this email yet. Ask them to sign up at the site with it, then add them here.');
      expect(r2.body.error?.hint).toBeUndefined();
      expect(await snapshot()).toBe(before);
    });

    test('Undo: the token the add answered removes them again', async () => {
      const f = await setup();
      const r = await add('maya', 'cara@example.com', [f.support.id]);
      const undo = await remove('maya', 'cara', r.body.employee.token);
      expect([undo.status, undo.body]).toEqual([200, { removed: true }]);
      expect(await isEmployee('cara')).toBe(false);
    });
  });

  // ================================================================ rule 8

  describe('rule 8: stale edits', () => {
    test('a stale role version is a 409 for edit and delete, and nothing is written', async () => {
      const f = await setup();
      const first = await editRole('olive', f.support, { name: 'Support', pages: ['email', 'traffic', 'signup-funnel'] });
      expect([first.status, first.body.version]).toEqual([200, f.support.version + 1]);
      const before = await snapshot();
      const staleEdit = await editRole('maya', f.support, { name: 'Support desk', pages: ['email'] });
      const staleDelete = await deleteRole('olive', f.support);
      for (const r of [staleEdit, staleDelete]) expect([r.status, r.body.error?.code]).toEqual([409, 'stale']);
      expect(staleEdit.body.error?.message).toBe("Someone else changed this while you had it open, so your change wasn't saved.");
      expect(await snapshot()).toBe(before);
    });

    test("a stale employee token is a 409 for manage and remove, and nothing is written; a role's pages changing doesn't make it stale", async () => {
      const f = await setup();
      const opened = await employeeRow('olive', 'sam');
      expect((await editRole('olive', f.support, { name: 'Support', pages: ['email'] })).status).toBe(200);
      expect((await employeeRow('olive', 'sam')).token).toBe(opened.token);
      // Someone else gives sam a role meanwhile.
      const mayas = await employeeRow('maya', 'sam');
      expect((await manage('maya', 'sam', [f.support.id, f.managers.id], mayas.token)).status).toBe(200);
      const before = await snapshot();
      const tries = [await manage('olive', 'sam', [], opened.token), await remove('olive', 'sam', opened.token), await remove('olive', 'sam', '')];
      for (const r of tries) expect([r.status, r.body.error?.code]).toEqual([409, 'stale']);
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });

    test('two saves opened from the same token at the same time: one is saved, the other is a 409', async () => {
      const f = await setup();
      const opened = await employeeRow('olive', 'sam');
      const results = await Promise.all([
        manage('olive', 'sam', [f.support.id, f.managers.id], opened.token),
        manage('olive', 'sam', [f.support.id, f.payouts.id], opened.token),
      ]);
      expect(sorted(results.map((r) => r.status))).toEqual([200, 409]);
      expect(await rolesOf('sam')).toHaveLength(2);
    });

    test('two edits of a role from the same version at the same time: one is saved, the other is a 409', async () => {
      const f = await setup();
      const results = await Promise.all([
        editRole('olive', f.support, { name: 'Support A', pages: ['email'] }),
        editRole('maya', f.support, { name: 'Support B', pages: ['email', 'traffic', 'team'] }),
        deleteRole('olive', f.support),
      ]);
      expect(sorted(results.map((r) => r.status))).toEqual([200, 409, 409]);
    });

    test(
      'a burst of overlapping changes never ends in a server error (one lock order; stale or gone is a 409, never a 23503 or a deadlock)',
      async () => {
        account('dee', 'Dee Daily');
        account('eve', 'Eve Evening');
        for (let round = 0; round < 4; round += 1) {
          await sql`delete from team_employees`;
          await sql`delete from team_roles`;
          const f = await setup();
          const s = (await state('olive')).body;
          const token = (id: string) => s.employees.find((e) => e.id === id)!.token;
          const work: Array<() => Promise<{ status: number } | { ok: boolean } | number | null>> = [
            () => manage('olive', 'sam', [f.support.id, f.managers.id], token('sam')),
            () => manage('maya', 'sam', [f.support.id, f.managers.id], token('sam')),
            () => manage('olive', 'bob', [f.support.id], token('bob')),
            () => manage('olive', 'maya', [f.managers.id, f.support.id, f.payouts.id], token('maya')),
            () => editRole('maya', f.support, { name: 'Support', pages: ['email', 'traffic', 'team'] }),
            () => editRole('olive', f.support, { name: 'Support', pages: ['email'] }),
            () => editRole('olive', f.managers, { name: 'Managers', pages: ['team', 'email', 'traffic', 'signup-funnel'] }),
            () => deleteRole('olive', f.payouts),
            () => deleteRole('maya', f.support),
            () => add('maya', 'dee@example.com', [f.support.id]),
            () => add('olive', 'eve@example.com', [f.payouts.id, f.managers.id]),
            () => remove('maya', 'sam', token('sam')),
            () => remove('olive', 'bob', token('bob')),
            () => call('POST', '/roles', 'maya', { body: { id: crypto.randomUUID(), name: `Burst ${round}`, pages: ['email'], actions: [] } }),
            () => state('maya'),
            () => state('olive'),
            () => team.join({ userId: 'cara', roleIds: [f.support.id], by: 'maya' }),
            () => team.leave({ userId: 'maya', by: null }),
            () => team.forgetAccount('bob'),
          ];
          const results = await Promise.all(work.map((run) => run()));
          const failed = results.flatMap((r, i) => (r !== null && typeof r === 'object' && 'status' in r && r.status >= 500 ? [`#${i}: ${r.status}`] : r === null ? [`#${i}: null`] : []));
          expect({ round, failed }).toEqual({ round, failed: [] });
        }
      },
      30_000,
    );

    test('a taken name is a 409 that only says to pick another name, even for a role the manager does not hold', async () => {
      const f = await setup();
      const before = await snapshot();
      const made = await call('POST', '/roles', 'maya', { body: { id: crypto.randomUUID(), name: '  books ', pages: ['email'], actions: [] } });
      const renamed = await editRole('maya', f.support, { name: 'BOOKS', pages: ['email', 'traffic'] });
      for (const r of [made, renamed]) {
        expect([r.status, r.body.error]).toEqual([409, { type: 'conflict', code: 'name_taken', message: 'Pick another name: that one is taken.', param: 'name' }]);
        expect(JSON.stringify(r.body)).not.toContain(f.payouts.id);
      }
      expect(await snapshot()).toBe(before);
    });

    test('a role deleted while the dialog was open is a 409, wherever it is used', async () => {
      const f = await setup();
      const temp = await role('olive', 'Temp', ['email']);
      expect((await deleteRole('olive', temp)).status).toBe(200);
      const sam = await employeeRow('olive', 'sam');
      const before = await snapshot();
      const tries = [
        await editRole('olive', temp, { name: 'Temp', pages: ['email'] }),
        await deleteRole('olive', temp),
        await manage('olive', 'sam', [f.support.id, temp.id], sam.token),
        await add('olive', 'cara@example.com', [temp.id]),
      ];
      for (const r of tries) expect([r.status, r.body.error?.code]).toEqual([409, 'role_gone']);
      expect(await snapshot()).toBe(before);
      expect(w.signedOut).toEqual([]);
    });

    test("the actor's own roles are read inside each change, not taken from the page they opened", async () => {
      const f = await setup();
      const sam = await employeeRow('maya', 'sam'); // opened while Maya held Support
      const maya = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [f.managers.id], maya.token)).status).toBe(200);
      const before = await snapshot();
      const give = await manage('maya', 'sam', [f.support.id, f.managers.id], sam.token);
      expect([give.status, give.body.error?.code]).toEqual([403, 'not_yours']);
      expect((await add('maya', 'cara@example.com', [f.support.id])).status).toBe(403);
      expect(await snapshot()).toBe(before);
      // Once Managers goes too, she can't manage the team at all.
      const maya2 = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [], maya2.token)).status).toBe(200);
      const late = await call('POST', '/roles', 'maya', { body: { id: crypto.randomUUID(), name: 'Late', pages: ['email'], actions: [] } });
      expect([late.status, late.body.error]).toEqual([404, ROUTE_404]);
      expect(await sql`select 1 from team_roles where name = 'Late'`).toHaveLength(0);
    });
  });

  // ================================================================ rule 9

  describe('rule 9: history', () => {
    test('one row per change, written in the same transaction as the change; the actor is who made it (null for the app); never an email', async () => {
      const from = await mark();
      const f = await setup();
      const first = await historySince(from);
      expect(first.map((h) => [h.action, h.actor_id])).toEqual([
        ['role.made', 'olive'],
        ['role.made', 'olive'],
        ['role.made', 'olive'],
        ['employee.added', 'olive'],
        ['employee.added', 'olive'],
        ['employee.added', 'olive'],
      ]);
      // Role names, and grants with their labels at that moment.
      expect(first[0]!.detail).toEqual({
        name: 'Managers',
        pages: [
          { key: 'email', label: 'Email' },
          { key: 'traffic', label: 'Traffic' },
          { key: 'team', label: 'Team' },
        ],
        actions: [],
      });
      const mayaAdded = first[3]!.detail as { made: boolean; roles: Array<{ id: string; name: string }> };
      expect([mayaAdded.made, sorted(mayaAdded.roles.map((r) => r.name))]).toEqual([false, ['Managers', 'Support']]);

      const second = await mark();
      const sam = await employeeRow('olive', 'sam');
      expect((await editRole('olive', f.support, { name: 'Support', pages: ['email', 'traffic', 'signup-funnel'] })).status).toBe(200);
      const supportNow = (await state('olive')).body.roles.find((r) => r.id === f.support.id)!;
      expect((await editRole('olive', supportNow, { name: 'Support', pages: ['email', 'traffic', 'signup-funnel'] })).status).toBe(200); // no change: no row
      const changed = await manage('maya', 'sam', [f.support.id, f.managers.id], sam.token);
      expect(changed.status).toBe(200);
      expect((await manage('maya', 'sam', [f.support.id, f.managers.id], changed.body.token)).status).toBe(200); // no change: no row
      expect((await add('olive', 'una@example.com', [])).status).toBe(400); // refused: no row
      expect((await remove('olive', 'sam', changed.body.token)).status).toBe(200);
      expect((await deleteRole('olive', f.payouts)).status).toBe(200);
      expect(await team.join({ userId: 'cara', roleIds: [], by: null })).toEqual({ ok: true });
      const rows = await historySince(second);
      expect(rows.map((h) => [h.action, h.actor_id, h.subject_kind])).toEqual([
        ['role.changed', 'olive', 'role'],
        ['employee.roles_changed', 'maya', 'employee'],
        ['employee.removed', 'olive', 'employee'],
        ['role.deleted', 'olive', 'role'],
        ['employee.added', null, 'employee'],
      ]);
      expect(rows[0]!.detail).toEqual({ name: 'Support', added: [{ key: 'signup-funnel', label: 'Sign-up funnel' }], removed: [] });
      expect(rows[3]!.detail).toEqual({ name: 'Books', people: 1, pages: [{ key: 'payouts', label: 'Payouts' }] });

      // Each row has its change's own time: now() is the transaction's start.
      const apart = await sql`
        select h.id from team_history h
        left join team_roles r on r.id::text = h.subject_id
        left join team_employees e on e.user_id = h.subject_id
        where h.id > ${from}::bigint
          and ((h.action = 'role.made' and r.id is not null and h.at <> r.created_at)
            or (h.action = 'role.changed' and r.id is not null and h.at <> r.updated_at)
            or (h.action = 'employee.added' and e.user_id is not null and h.at <> e.added_at))`;
      expect(apart).toHaveLength(0);
      expect(JSON.stringify([...first, ...rows].map((h) => h.detail))).not.toContain('@');
    });

    test('history names people as they are now, "Deleted account" once gone, and "The app" for the app', async () => {
      await setup();
      const newest = async () => (await call<HistoryPage>('GET', '/history', 'olive')).body.rows[0]!.text;
      expect(await newest()).toMatch(/^Olive Owner added Bob Books with (Support and Books|Books and Support)\.$/);
      w.accounts.set('bob', { ...w.accounts.get('bob')!, name: 'Robert Books' });
      expect(await newest()).toMatch(/^Olive Owner added Robert Books with /);
      w.accounts.delete('bob');
      expect(await newest()).toMatch(/^Olive Owner added Deleted account with /);
      expect(await team.join({ userId: 'cara', roleIds: [], by: null })).toEqual({ ok: true });
      expect(await newest()).toBe('The app added Cara Customer.');
    });

    test('history cannot be changed or emptied, and the app login may only read it and add to it', async () => {
      await setup();
      await expect((async () => void (await sql`update team_history set action = 'x.y'`))()).rejects.toThrow('append-only');
      await expect((async () => void (await sql`delete from team_history`))()).rejects.toThrow('append-only');
      await expect((async () => void (await sql`truncate team_history`))()).rejects.toThrow('append-only');

      // The grants block, with an app_user login that exists only inside this transaction (roles are cluster-wide).
      // (The file's header comment names app_user too, so look for the grant itself.)
      const grants = statements('0001_team.sql').find((s) => s.includes('grant select, insert on table team_history to app_user'))!;
      expect(grants).toBeDefined();
      class Rollback extends Error {}
      const seen: Record<string, unknown> = {};
      await sql
        .begin(async (tx) => {
          await tx.unsafe('create role app_user');
          // As the framework's default privileges would have: every new table, every right.
          await tx.unsafe('grant all on table team_history, team_roles, team_employees, team_employee_roles to app_user');
          await tx.unsafe(grants);
          const [p] = await tx`
            select has_table_privilege('app_user', 'team_history', 'SELECT') as select,
                   has_table_privilege('app_user', 'team_history', 'INSERT') as insert,
                   has_table_privilege('app_user', 'team_history', 'UPDATE') as update,
                   has_table_privilege('app_user', 'team_history', 'DELETE') as delete,
                   has_table_privilege('app_user', 'team_history', 'TRUNCATE') as truncate,
                   has_table_privilege('app_user', 'team_roles', 'UPDATE') as roles_update`;
          seen.privileges = { ...p };
          await tx.unsafe('set local role app_user');
          await tx`insert into team_history (actor_id, action, subject_kind, subject_id, detail) values ('olive', 'role.made', 'role', 'x', '{}'::jsonb)`;
          seen.inserted = true;
          await tx.savepoint(async (sp) => void (await sp`update team_history set action = 'x.y'`)).catch((error: Error) => (seen.update = error.message));
          await tx.savepoint(async (sp) => void (await sp`delete from team_history`)).catch((error: Error) => (seen.delete = error.message));
          throw new Rollback();
        })
        .catch((error) => {
          if (!(error instanceof Rollback)) throw error;
        });
      expect(seen.privileges).toEqual({ select: true, insert: true, update: false, delete: false, truncate: false, roles_update: true });
      expect(seen.inserted).toBe(true);
      expect(String(seen.update)).toMatch(/permission denied|append-only/);
      expect(String(seen.delete)).toMatch(/permission denied|append-only/);
    });
  });

  // ================================================================ rule 10

  describe('rule 10: what a manager never gets', () => {
    test("a manager's page: only the roles they hold, '+N more' for the rest, their own catalog; no Mass Access rows, last seen, unassigned pages or problem line", async () => {
      const f = await setup();
      const s = (await state('maya')).body;
      expect(s.viewer).toEqual({ id: 'maya', massAccess: false, roleIds: sorted([f.managers.id, f.support.id]) });
      expect(sorted(s.roles.map((r) => r.name))).toEqual(['Managers', 'Support']);
      expect([s.massAccess, s.unassigned, s.problem]).toEqual([null, null, null]);
      for (const e of s.employees) {
        expect({ id: e.id, lastSeen: 'lastSeenAt' in e }).toEqual({ id: e.id, lastSeen: false });
        expect(e.roleIds.every((id) => id === f.managers.id || id === f.support.id)).toBe(true);
      }
      expect(sorted(s.employees.map((e) => e.id))).toEqual(['bob', 'maya', 'sam']);
      const bob = s.employees.find((e) => e.id === 'bob')!;
      expect([bob.roleIds, bob.hiddenRoles]).toEqual([[f.support.id], 1]);
      const text = JSON.stringify(s);
      expect(text).not.toContain(f.payouts.id);
      expect(text).not.toContain('"Books"');
      expect(text).not.toContain('olive@example.com');
      // The editor's checklist: her pages and actions only, plus the locked every-employee page.
      expect(s.catalog.flatMap((section) => section.pages.map((p) => p.grant ?? `locked:${p.label}`))).toEqual(['locked:Overview', 'email', 'traffic', 'team']);
      expect(s.catalog.flatMap((section) => section.pages.flatMap((p) => p.actions.map((a) => a.key)))).toEqual([]);
    });

    test("the answers to a manager's own changes keep to the same rules", async () => {
      const f = await setup();
      const added = await add('maya', 'cara@example.com', [f.support.id]);
      expect(added.status).toBe(201);
      expect('lastSeenAt' in added.body.employee).toBe(false);
      const bob = await employeeRow('maya', 'bob');
      const given = await manage('maya', 'bob', [f.support.id, f.managers.id], bob.token);
      expect(given.status).toBe(200);
      expect('lastSeenAt' in given.body).toBe(false);
      expect([given.body.roleIds.includes(f.payouts.id), given.body.hiddenRoles]).toEqual([false, 1]);
      const edited = await editRole('maya', f.support, { name: 'Support', pages: ['email', 'traffic', 'team'] });
      expect(JSON.stringify(edited.body)).not.toContain('Books');
    });

    test('Mass Access gets every role, every catalog page and action, the Mass Access rows and last seen', async () => {
      const f = await setup();
      w.accounts.set('sam', { ...w.accounts.get('sam')!, lastSeenAt: null });
      const s = (await state('olive')).body;
      expect(sorted(s.roles.map((r) => r.name))).toEqual(['Books', 'Managers', 'Support']);
      expect(s.massAccess?.map((m) => [m.id, m.you, m.lastSeenAt])).toEqual([['olive', true, '2026-11-10T10:00:00.000Z']]);
      expect(s.employees.map((e) => [e.id, e.lastSeenAt])).toEqual(
        expect.arrayContaining([
          ['bob', '2026-11-10T10:00:00.000Z'],
          ['sam', null],
        ]),
      );
      const bob = s.employees.find((e) => e.id === 'bob')!;
      expect([sorted(bob.roleIds), bob.hiddenRoles, bob.canRemove]).toEqual([sorted([f.support.id, f.payouts.id]), 0, true]);
      expect(s.catalog.flatMap((section) => section.pages.map((p) => p.grant ?? `locked:${p.label}`))).toEqual(['locked:Overview', 'email', 'traffic', 'signup-funnel', 'payouts', 'team']);
      expect(s.catalog.flatMap((section) => section.pages.flatMap((p) => p.actions.map((a) => a.key)))).toEqual(['email.settings']);
      expect(s.unassigned).toEqual(['Sign-up funnel']);
    });

    test('an employee who now has Mass Access is a Mass Access row, so a manager is not shown it', async () => {
      await setup();
      w.massAccess.add('bob');
      const s = (await state('maya')).body;
      expect(s.employees.map((e) => e.id)).not.toContain('bob');
    });

    test('POST roles with the id of a role the manager no longer holds shows them nothing of it', async () => {
      const f = await setup();
      // Maya held Books once, so her page had its id; then it was taken off her and renamed.
      let maya = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [f.managers.id, f.support.id, f.payouts.id], maya.token)).status).toBe(200);
      maya = await employeeRow('olive', 'maya');
      expect((await manage('olive', 'maya', [f.managers.id, f.support.id], maya.token)).status).toBe(200);
      expect((await editRole('olive', f.payouts, { name: 'Payroll secrets', pages: ['payouts', 'signup-funnel'] })).status).toBe(200);
      const r = await call<RoleView>('POST', '/roles', 'maya', { body: { id: f.payouts.id, name: 'Anything', pages: ['email'], actions: [] } });
      expect(JSON.stringify(r.body)).not.toContain('Payroll secrets');
      expect(JSON.stringify(r.body)).not.toContain('signup-funnel');
    });
  });

  // ================================================================ rule 11

  describe('rule 11: grants that left the app', () => {
    test('retired grants come off every role the first time the server sees them: one UPDATE and one history row per role; unknown keys stay', async () => {
      const analysts = await insertRoleRow('Analysts', ['email', 'old-reports', 'reports-v2'], ['email.settings', 'old.export', 'reports-v2.export']);
      const onlyOld = await insertRoleRow('Old only', ['old-reports'], []);
      const plain = await insertRoleRow('Plain', ['traffic'], []);
      const from = await mark();
      team = make({ retiredGrants: ['old-reports', 'old.export'] });
      expect((await state('olive')).status).toBe(200);
      expect(await stored(analysts)).toMatchObject({ pages: ['email', 'reports-v2'], actions: ['email.settings', 'reports-v2.export'], version: 2 });
      expect(await stored(onlyOld)).toMatchObject({ pages: [], actions: [], version: 2 });
      expect(await stored(plain)).toMatchObject({ pages: ['traffic'], version: 1 });
      const rows = await historySince(from);
      expect(sorted(rows.map((h) => `${h.action} ${h.actor_id} ${h.subject_id}`))).toEqual(sorted([`role.pages_retired null ${analysts}`, `role.pages_retired null ${onlyOld}`]));
      expect(rows.find((h) => h.subject_id === analysts)!.detail).toEqual({ name: 'Analysts', removed: ['old-reports', 'old.export'] });
      // Seen again, by this server and by another one: nothing more is written.
      await state('olive');
      await state('maya');
      await state('olive', make({ retiredGrants: ['old-reports', 'old.export'] }));
      expect(await historySince(from)).toHaveLength(2);
      expect((await stored(analysts))?.version).toBe(2);
    });

    test('two servers that see them at the same time still write one history row per role', async () => {
      const ids = await Promise.all([1, 2, 3].map((n) => insertRoleRow(`Old ${n}`, ['email', 'old-reports'], [])));
      const from = await mark();
      const a = make({ retiredGrants: ['old-reports'] });
      const b = make({ retiredGrants: ['old-reports'] });
      const [ra, rb] = await Promise.all([state('olive', a), state('olive', b)]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const rows = await historySince(from);
      expect(sorted(rows.map((h) => `${h.action} ${h.subject_id}`))).toEqual(sorted(ids.map((id) => `role.pages_retired ${id}`)));
      for (const id of ids) expect(await stored(id)).toMatchObject({ pages: ['email'], version: 2 });
    });

    test("a mass-access page's grant comes off every role, even while the nav check complains about it", async () => {
      const nav: TeamNav = NAV.map((section) => ({ ...section, items: section.items.map((item) => (item.access === 'mass-access' ? { ...item, grant: 'log-in-as' } : item)) }));
      const id = await insertRoleRow('Impersonators', ['email', 'log-in-as'], []);
      const from = await mark();
      team = make({ nav });
      expect((await state('olive')).status).toBe(200);
      expect((await stored(id))?.pages).toEqual(['email']);
      expect((await historySince(from)).map((h) => [h.action, h.subject_id])).toEqual([['role.pages_retired', id]]);
    });
  });

  // ================================================================ rule 12

  describe('rule 12: forgetAccount', () => {
    test('takes the account off the team, roles and all, with one history row; earlier rows stay', async () => {
      const f = await setup();
      const [{ n: before }] = (await sql`select count(*)::int as n from team_history where subject_id = 'sam'`) as unknown as [{ n: number }];
      expect(before).toBeGreaterThanOrEqual(1);
      const from = await mark();
      expect(await team.forgetAccount('sam')).toBe(1);
      expect(await isEmployee('sam')).toBe(false);
      expect(await rolesOf('sam')).toEqual([]);
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.subject_kind, h.subject_id])).toEqual([['account.forgotten', null, 'account', 'sam']]);
      const [{ n: after }] = (await sql`select count(*)::int as n from team_history where subject_id = 'sam' and id <= ${from}::bigint`) as unknown as [{ n: number }];
      expect(after).toBe(before);
      expect(await team.can(person('sam'), 'email')).toBe(false);
      expect((await stored(f.support.id))?.name).toBe('Support');
      expect((await state('olive')).body.roles.find((r) => r.id === f.support.id)?.people).toBe(2);
    });

    test('answers 0 when there is nothing to forget, null when it cannot, and never throws', async () => {
      await setup();
      const from = await mark();
      expect(await team.forgetAccount('cara')).toBe(0);
      expect(await team.forgetAccount('')).toBe(0);
      expect(await historySince(from)).toHaveLength(0);
      const broken: Db[] = [
        () => null,
        () => false as unknown as postgres.Sql,
        () => {
          throw new Error('db() threw');
        },
        () => Promise.reject(new Error('db() rejected')),
        () => (() => Promise.reject(new Error('every query fails'))) as unknown as postgres.Sql,
        () => empty,
      ];
      for (const db of broken) expect(await make({ db }).forgetAccount('sam')).toBeNull();
      expect(await isEmployee('sam')).toBe(true);
    });
  });

  // ================================================================ join and leave

  describe("join and leave: the app's own flows", () => {
    test('by: null is the app itself: no delegation checks, history actor null, nobody signed out; refusals answer ok: false', async () => {
      const f = await setup();
      const from = await mark();
      expect(await team.join({ userId: 'cara', roleIds: [f.payouts.id], by: null })).toEqual({ ok: true });
      expect(await rolesOf('cara')).toEqual([f.payouts.id]);
      expect(await team.can(person('cara'), 'payouts')).toBe(true);
      expect(await team.leave({ userId: 'cara', by: null })).toEqual({ ok: true });
      expect(await isEmployee('cara')).toBe(false);
      expect((await historySince(from)).map((h) => [h.action, h.actor_id, h.subject_id])).toEqual([
        ['employee.added', null, 'cara'],
        ['employee.removed', null, 'cara'],
      ]);
      expect(w.signedOut).toEqual([]);

      const before = await snapshot();
      const refused = [
        await team.join({ userId: 'olive', by: null }),
        await team.join({ userId: 'sam', by: null }),
        await team.join({ userId: 'no-such-account', by: null }),
        await team.join({ userId: 'cara', roleIds: ['not-a-uuid'], by: null }),
        await team.join({ userId: 'cara', roleIds: [crypto.randomUUID()], by: null }),
        await team.leave({ userId: 'olive', by: null }),
        await team.leave({ userId: 'cara', by: null }),
      ];
      for (const r of refused) {
        expect(r.ok).toBe(false);
        expect(typeof (r as { reason?: unknown }).reason).toBe('string');
      }
      expect(await snapshot()).toBe(before);
    });

    test("by: someone applies that person's rules", async () => {
      const f = await setup();
      const before = await snapshot();
      const refused = [
        await team.join({ userId: 'cara', roleIds: [f.payouts.id], by: 'maya' }),
        await team.join({ userId: 'maya', roleIds: [], by: 'maya' }),
        await team.join({ userId: 'cara', roleIds: [], by: 'sam' }),
        await team.leave({ userId: 'bob', by: 'maya' }),
        await team.leave({ userId: 'maya', by: 'maya' }),
        await team.leave({ userId: 'sam', by: 'sam' }),
        await team.leave({ userId: 'bob', by: 'sam' }),
      ];
      for (const r of refused) expect(r.ok).toBe(false);
      expect(await snapshot()).toBe(before);
      const from = await mark();
      expect(await team.join({ userId: 'cara', roleIds: [f.support.id], by: 'maya' })).toEqual({ ok: true });
      expect(await team.leave({ userId: 'cara', by: 'maya' })).toEqual({ ok: true });
      expect((await historySince(from)).map((h) => [h.action, h.actor_id])).toEqual([
        ['employee.added', 'maya'],
        ['employee.removed', 'maya'],
      ]);
    });
  });

  // ================================================================ requirePage, requireArea

  describe('requirePage and requireArea', () => {
    test('let in exactly the people a page opens for, and never call notFound() for them', async () => {
      await setup();
      const cases: Array<[string, Person | null, string, boolean]> = [
        ['Mass Access, a role page', person('olive'), 'payouts', true],
        ['Mass Access, a mass-access page', person('olive'), '/dashboard/admin/log-in-as', true],
        ['Mass Access, an address no page lists', person('olive'), '/dashboard/admin/not-listed', true],
        ['an employee, a page their role gives', person('sam'), 'email', true],
        ['an employee, the same page by address', person('sam'), '/dashboard/admin/email', true],
        ['an employee, under a page with subpages', person('sam'), '/dashboard/admin/traffic/links/9', true],
        ['an employee, the every-employee page', person('sam'), '/dashboard/overview', true],
        ['a manager, the Team page', person('maya'), '/dashboard/admin/team', true],
        ['a customer, an everyone page', person('cara'), '/dashboard', true],
        ['an employee, a page no role of theirs gives', person('sam'), 'payouts', false],
        ['an employee, under a page without subpages', person('sam'), '/dashboard/admin/email/inbox', false],
        ['an employee, the Team page', person('sam'), 'team', false],
        ['a manager, a mass-access page', person('maya'), '/dashboard/admin/log-in-as', false],
        ['a customer, the every-employee page', person('cara'), '/dashboard/overview', false],
        ['Mass Access viewing as someone', person('olive', true), 'email', false],
        ['an employee viewing as someone', person('sam', true), 'email', false],
        ['signed out, an everyone page', null, '/dashboard', false],
        ['signed out, a role page', null, 'email', false],
        ['Mass Access, a grant no page has', person('olive'), 'no-such-grant', false],
      ];
      for (const [label, who, ref, opens] of cases) {
        expect({ label, ref, notFound: await saysNotFound(() => team.requirePage(who, ref)) }).toEqual({ label, ref, notFound: !opens });
      }
      const areas: Array<[string, Person | null, boolean]> = [
        ['Mass Access', person('olive'), true],
        ['an employee', person('sam'), true],
        ['a manager', person('maya'), true],
        ['a customer', person('cara'), false],
        ['Mass Access viewing as someone', person('olive', true), false],
        ['a manager viewing as someone', person('maya', true), false],
        ['signed out', null, false],
      ];
      for (const [label, who, opens] of areas) {
        expect({ label, notFound: await saysNotFound(() => team.requireArea(who)) }).toEqual({ label, notFound: !opens });
      }
      // An employee with no roles is in the area and gets the every-employee pages, nothing more.
      expect(await team.join({ userId: 'cara', roleIds: [], by: null })).toEqual({ ok: true });
      expect(await saysNotFound(() => team.requireArea(person('cara')))).toBe(false);
      expect(await saysNotFound(() => team.requirePage(person('cara'), '/dashboard/overview'))).toBe(false);
      expect(await saysNotFound(() => team.requirePage(person('cara'), 'email'))).toBe(true);
    });

    test(
      'with no database, a false one, or one that throws: notFound() for employees, Mass Access still in, nothing else thrown',
      async () => {
        await setup();
        const missing = postgres(urlFor(`${database}_missing`), { max: 1, onnotice: () => {}, connect_timeout: 5 });
        const variants: Array<[string, Db]> = [
          ['no database', () => null],
          ['a false database', () => false as unknown as postgres.Sql],
          [
            'db() throws',
            () => {
              throw new Error('db() threw');
            },
          ],
          ['db() rejects', () => Promise.reject(new Error('db() rejected'))],
          ['every query fails', () => (() => Promise.reject(new Error('every query fails'))) as unknown as postgres.Sql],
          ['a database that does not exist', () => missing],
          ['the tables are missing (42P01)', () => empty],
        ];
        try {
          for (const [label, db] of variants) {
            w.logs.length = 0;
            const t = make({ db });
            for (const [who, ref] of [
              [person('sam'), 'email'],
              [person('sam'), '/dashboard/overview'],
              [person('maya'), 'team'],
            ] as const) {
              expect({ label, ref, notFound: await saysNotFound(() => t.requirePage(who, ref)) }).toEqual({ label, ref, notFound: true });
            }
            expect({ label, area: await saysNotFound(() => t.requireArea(person('sam'))) }).toEqual({ label, area: true });
            // Mass Access is the app's own check, so it stays.
            expect({ label, page: await saysNotFound(() => t.requirePage(person('olive'), 'payouts')), area: await saysNotFound(() => t.requireArea(person('olive'))) }).toEqual({
              label,
              page: false,
              area: false,
            });
            // An everyone page needs no database.
            expect({ label, page: await saysNotFound(() => t.requirePage(person('cara'), '/dashboard')) }).toEqual({ label, page: false });
            expect(await t.view(person('sam'))).toEqual(NOBODY_VIEW);
            expect(await t.can(person('sam'), 'email')).toBe(false);
            expect(await t.canDo(person('olive'), 'email.settings')).toBe(true);
            // The routes answer instead of crashing: GET me still works, the page and changes are a 503.
            expect({ label, me: (await call<TeamView>('GET', '/me', 'olive', {}, t)).body.massAccess }).toEqual({ label, me: true });
            expect({ label, page: (await call('GET', '', 'olive', {}, t)).status }).toEqual({ label, page: 503 });
            const change = await call('POST', '/roles', 'olive', { body: { id: crypto.randomUUID(), name: 'Nowhere', pages: ['email'], actions: [] } }, t);
            expect({ label, change: change.status }).toEqual({ label, change: 503 });
            // The check's failures are logged once per kind, however many requests hit them (a failed request logs each time).
            const checks = w.logs.filter((line) => !line.includes('a request was not answered'));
            expect({ label, repeated: checks.filter((line, i) => checks.indexOf(line) !== i) }).toEqual({ label, repeated: [] });
            if (label.includes('42P01')) expect(w.logs.filter((line) => line.includes('run migrations/0001_team.sql'))).toHaveLength(1);
          }
        } finally {
          await missing.end();
        }
      },
      30_000,
    );

    test('a Mass Access check that throws or answers anything but true counts as no', async () => {
      await setup();
      const odd: Array<[string, TeamConfig<Person>['hasMassAccess']]> = [
        [
          'throws',
          () => {
            throw new Error('auth is down');
          },
        ],
        ['rejects', () => Promise.reject(new Error('auth is down'))],
        ['answers "true"', () => 'true' as unknown as boolean],
        ['answers 1', () => 1 as unknown as boolean],
        ['answers an object', () => ({}) as unknown as boolean],
      ];
      for (const [label, hasMassAccess] of odd) {
        const t = make({ hasMassAccess });
        expect({ label, area: await saysNotFound(() => t.requireArea(person('olive'))), page: await saysNotFound(() => t.requirePage(person('olive'), 'email')) }).toEqual({
          label,
          area: true,
          page: true,
        });
        expect({ label, status: (await call('GET', '', 'olive', {}, t)).status }).toEqual({ label, status: 404 });
        expect({ label, employee: await saysNotFound(() => t.requirePage(person('sam'), 'email')) }).toEqual({ label, employee: false });
      }
    });
  });

  // ================================================================ can and canDo

  describe('can and canDo with keys the nav does not list', () => {
    test('can() with an unknown grant is false for everyone, Mass Access included, and is logged once', async () => {
      await setup();
      w.logs.length = 0;
      const everyone = [person('olive'), person('maya'), person('sam'), person('cara'), person('olive', true), null];
      for (let round = 0; round < 3; round += 1) {
        for (const p of everyone) expect({ who: p?.id ?? null, can: await team.can(p, 'no-such-grant') }).toEqual({ who: p?.id ?? null, can: false });
      }
      expect(w.logs.filter((line) => line.includes('no-such-grant'))).toHaveLength(1);
      expect(await team.can(person('olive'), 'Email')).toBe(false); // a label is not a grant
      expect(await team.can(person('olive'), 'payouts')).toBe(true);
      expect(await team.can(person('sam'), 'email')).toBe(true);
      expect(w.logs.filter((line) => line.includes('no-such-grant'))).toHaveLength(1);
    });

    test('canDo() with an unknown action is false for everyone, Mass Access included', async () => {
      await setup();
      for (const p of [person('olive'), person('maya'), person('sam'), person('cara'), null]) {
        expect({ who: p?.id ?? null, can: await team.canDo(p, 'no-such.action') }).toEqual({ who: p?.id ?? null, can: false });
      }
      expect(await team.canDo(person('olive'), 'email.settings')).toBe(true);
      expect(await team.canDo(person('maya'), 'email.settings')).toBe(false);
    });

    test('an everyone page is for signed-in accounts, so can() and canOpen() say no to a signed-out person, as requirePage does', async () => {
      await setup();
      expect(await saysNotFound(() => team.requirePage(null, '/dashboard'))).toBe(true);
      expect(await team.can(null, '/dashboard')).toBe(false);
      expect(await team.canOpen(null, '/dashboard')).toBe(false);
    });

    test('canDo() with an unknown action is logged once, like can()', async () => {
      await setup();
      w.logs.length = 0;
      for (let round = 0; round < 3; round += 1) await team.canDo(person('olive'), 'no-such.action');
      expect(w.logs.filter((line) => line.includes('no-such.action'))).toHaveLength(1);
    });
  });
});
