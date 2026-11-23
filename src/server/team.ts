// What the Team page does, below HTTP: the view one person gets, the page's
// state, and every change. Each change runs in one transaction that first
// locks the rows involved, then reads who the actor is NOW (their roles, and
// whether they can still open the Team page), then applies the rules
// (rules.ts), then writes the change and its history row together.
//
// Refusals are thrown as Refused and turned into the error body by the
// routes; the words are the copy deck's (design v2, section 10).
import { createHash } from 'node:crypto';
import type { ResolvedTeamConfig, TeamAccount, TeamSql, TeamUser } from '../config';
import { accessOf, allPages, canOpenPage, NOBODY, type TeamNavItem, type TeamView } from '../nav';
import type {
  AddResult,
  CatalogPage,
  CatalogSection,
  EmployeeView,
  HistoryPage,
  MassAccessView,
  RoleView,
  TeamErrorCode,
  TeamState,
} from '../shared/api';
import { opensLine, UUID } from '../shared/api';
import {
  added,
  catalogFor,
  cleanList,
  editedTicks,
  fullCatalog,
  inNavOrder,
  labelsInNavOrder,
  mergeSave,
  reaches,
  reachesHolders,
  refusedAdditions,
  removed,
  withActionPages,
  type Actor,
  type Catalog,
} from './rules';
import {
  deleteEmployee,
  deleteRole as deleteRoleRow,
  giveRoles,
  inTransaction,
  insertEmployee,
  insertHistory,
  insertRole,
  lockEmployees,
  lockRolesForShare,
  pgCode,
  pgConstraint,
  readAccess,
  readEmployee,
  readHistory,
  readHolders,
  readRole,
  readRolesByIds,
  readTeam,
  rolesHolding,
  takeRoles,
  unionOf,
  updateRole,
  type StoredEmployee,
  type StoredRole,
} from './store';

type ErrorType = 'invalid_request' | 'authentication' | 'permission' | 'not_found' | 'conflict' | 'internal';

/** A refusal with the words to show. */
export class Refused extends Error {
  constructor(
    readonly type: ErrorType,
    readonly code: TeamErrorCode,
    message: string,
    readonly hint?: string,
    /** The field the refusal is about ('email', 'name', 'pages'), so the page shows it under that field. */
    readonly param?: string,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

const notFound = () => new Refused('not_found', 'route_not_found', 'This page does not exist.');

export const PAGE_LINE = 'Add the people who work here, and choose which pages each role opens.';
const BAD_NAV_LINE = "The app's list of pages has a mistake, so some employees may not get their pages. A developer can see what to fix in the server log.";
const HISTORY_PAGE = 50;
const NAME_MAX = 60;

/** The real person behind a request, as the Team page's changes need them. */
export type Me = Readonly<{ id: string; name: string | null; massAccess: boolean }>;

/** The stale-edit token for someone's roles: changes whenever any of their roles is given or taken, by anyone. */
export function tokenOf(roleIds: readonly string[]): string {
  return createHash('md5').update([...roleIds].sort().join(',')).digest('hex').slice(0, 20);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function personName(account: TeamAccount | undefined | null, fallback = 'Deleted account'): string {
  const name = typeof account?.name === 'string' ? account.name.trim() : '';
  if (name) return name;
  const email = typeof account?.email === 'string' ? account.email.trim() : '';
  return email || fallback;
}

/** A role's name as people type it: trimmed, inner spaces made single. */
export function cleanRoleName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name || null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

function siteOf(url: string | null): string {
  if (!url) return 'the site';
  try {
    return new URL(url).host;
  } catch {
    return 'the site';
  }
}

export function createTeamCore<User extends TeamUser>(config: ResolvedTeamConfig<User>) {
  const nav = config.nav;
  const full = fullCatalog(nav, config.retiredGrants);
  const logged = new Set<string>();
  let retiredDone = config.retiredGrants.size === 0;

  /** One log line per process per kind of failure: this runs for every customer's request. */
  function logOnce(key: string, line: string, error?: unknown) {
    if (logged.has(key)) return;
    logged.add(key);
    config.log(line, error);
  }

  async function database() {
    const sql = await config.db();
    if (!sql) throw new Refused('internal', 'not_set_up', 'The Team page has no database yet.');
    return sql;
  }

  /** Mass Access by account id, on an exact true only; a failure is no. */
  async function massAccessOf(userId: string): Promise<boolean> {
    try {
      return await config.hasMassAccess(userId);
    } catch (error) {
      logOnce('mass-access', '[Team] the app\'s hasMassAccess failed, so it counted as no', error);
      return false;
    }
  }

  /** What this person may open on this request. Never throws. */
  async function view(user: User | null | undefined): Promise<TeamView> {
    try {
      if (!user || typeof user.id !== 'string' || !user.id) return NOBODY;
      // Someone else is looking through this account: no Mass Access, no team pages.
      if (user.viewedAs) return NOBODY;
      const [massAccess, access] = await Promise.all([
        massAccessOf(user.id),
        (async () => {
          try {
            const sql = await config.db();
            if (!sql) {
              logOnce('no-db', '[Team] no database: give createTeam a db, so employees get their pages');
              return null;
            }
            const out = await readAccess(sql, user.id);
            if (!out) logOnce('shape', '[Team] the team read came back in a shape it should never have, so it counted as no pages');
            return out;
          } catch (error) {
            const code = pgCode(error);
            logOnce(
              `read-${code ?? 'error'}`,
              code === '42P01' ? '[Team] the team tables are missing: run migrations/0001_team.sql' : '[Team] could not read who is on the team, so employees got no team pages',
              error,
            );
            return null;
          }
        })(),
      ]);
      return { massAccess, employee: access?.employee === true, pages: access?.pages ?? [], actions: access?.actions ?? [] };
    } catch (error) {
      logOnce('view', '[Team] the check failed, so it counted as no', error);
      return NOBODY;
    }
  }

  /**
   * True when this view opens the Team page. A Team page the nav lists for
   * everyone or for every employee is a set-up mistake (the nav check says
   * so): until it is fixed the page stays with Mass Access, so the list of
   * who is on the team never opens to every account.
   */
  function managesTeam(v: TeamView): boolean {
    if (v.massAccess === true) return true;
    if (!config.teamItem) return false;
    const access = accessOf(config.teamItem);
    return (access === 'role' || access === 'mass-access') && canOpenPage(v, config.teamItem);
  }

  // ------------------------------------------------------------ the actor inside a change

  type ActorNow = Actor & Readonly<{ view: TeamView; catalog: Catalog; name: string | null }>;

  /**
   * Locks the employee rows the change touches (the actor's for share, the
   * people it is about for update; in user_id order), then works out who
   * the actor is now. Refuses with not found when the actor can no longer
   * open the Team page.
   */
  async function lockAndReadActor(
    tx: TeamSql,
    me: Me,
    targets: readonly string[],
  ): Promise<{ actor: ActorNow; people: Map<string, StoredEmployee> }> {
    const people = await lockEmployees(tx, [
      ...(me.massAccess ? [] : [{ id: me.id, mode: 'share' as const }]),
      ...targets.map((id) => ({ id, mode: 'update' as const })),
    ]);
    if (me.massAccess) {
      const v: TeamView = { massAccess: true, employee: people.has(me.id), pages: [], actions: [] };
      return { actor: { id: me.id, massAccess: true, held: new Set(), view: v, catalog: full, name: me.name }, people };
    }
    const mine = people.get(me.id) ?? (await readEmployee(tx, me.id));
    if (!mine) throw notFound();
    const roles = await readRolesByIds(tx, mine.roleIds);
    const union = unionOf(roles);
    const v: TeamView = { massAccess: false, employee: true, pages: union.pages, actions: union.actions };
    if (!managesTeam(v)) throw notFound();
    return {
      actor: { id: me.id, massAccess: false, held: new Set(mine.roleIds), view: v, catalog: catalogFor(nav, v, config.retiredGrants), name: me.name },
      people,
    };
  }

  function mustBeSetUp() {
    if (config.problem) {
      throw new Refused('internal', 'not_set_up', "The Team page isn't set up right, so changes are off for now. A developer can see what to fix in the server log.");
    }
  }

  async function accountsByIds(ids: readonly string[]): Promise<Map<string, TeamAccount>> {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    const out = new Map<string, TeamAccount>();
    for (let i = 0; i < unique.length; i += 500) {
      const found = await config.accounts.byIds(unique.slice(i, i + 500));
      for (const account of found ?? []) if (account && typeof account.id === 'string') out.set(account.id, account);
    }
    return out;
  }

  function roleLabelsOf(role: Pick<StoredRole, 'pages'>): string[] {
    return labelsInNavOrder(nav, role.pages);
  }

  function keyLabels(keys: readonly string[]): Array<{ key: string; label: string | null }> {
    const labels = labelMap();
    return keys.map((key) => ({ key, label: labels[key] ?? null }));
  }

  let labelCache: Record<string, string> | null = null;
  function labelMap(): Record<string, string> {
    if (labelCache) return labelCache;
    const out: Record<string, string> = {};
    for (const { item } of allPages(nav)) {
      if (accessOf(item) === 'role' && typeof item.grant === 'string') out[item.grant] = item.label;
      for (const action of item.actions ?? []) out[action.key] = action.label;
    }
    labelCache = out;
    return out;
  }

  function everyEmployeeLabels(): string[] {
    return allPages(nav).filter(({ item }) => accessOf(item) === 'employees').map(({ item }) => item.label);
  }

  /** The pages someone with these roles opens, in nav order (their every-employee pages first, in nav order with the rest). */
  function opensFor(roles: readonly StoredRole[]): string[] {
    const v: TeamView = { massAccess: false, employee: true, pages: unionOf(roles).pages, actions: [] };
    return allPages(nav)
      .filter(({ item }) => (accessOf(item) === 'employees' || accessOf(item) === 'role') && canOpenPage(v, item))
      .map(({ item }) => item.label);
  }

  // ------------------------------------------------------------ views for the page

  function roleView(role: StoredRole, held: ReadonlySet<string>): RoleView {
    const known = (keys: readonly string[], set: ReadonlySet<string>) => inNavOrder(nav, keys.filter((key) => set.has(key)));
    return {
      id: role.id,
      name: role.name,
      pages: known(role.pages, full.pages),
      actions: known(role.actions, full.actions),
      version: role.version,
      people: role.people,
      mine: held.has(role.id),
      updatedAt: iso(role.updatedAt) ?? new Date(0).toISOString(),
    };
  }

  function employeeView(
    employee: StoredEmployee,
    actor: Actor,
    accounts: Map<string, TeamAccount>,
    roleNames: Map<string, string>,
    massAccessIds: ReadonlySet<string>,
    viewerIsMassAccess: boolean,
  ): EmployeeView {
    const account = accounts.get(employee.id);
    const visible = viewerIsMassAccess ? employee.roleIds : employee.roleIds.filter((id) => actor.held.has(id));
    const byName = [...visible].sort((a, b) => (roleNames.get(a) ?? '').localeCompare(roleNames.get(b) ?? '', undefined, { sensitivity: 'base' }));
    const you = employee.id === actor.id;
    const isMassAccess = massAccessIds.has(employee.id);
    const target = { id: employee.id, massAccess: isMassAccess, roleIds: employee.roleIds };
    const addedBy = employee.addedBy === null ? 'The app' : accounts.has(employee.addedBy) ? personName(accounts.get(employee.addedBy)) : null;
    const out: EmployeeView = {
      id: employee.id,
      name: personName(account),
      email: typeof account?.email === 'string' && account.email ? account.email : null,
      image: typeof account?.image === 'string' && account.image ? account.image : null,
      roleIds: byName,
      hiddenRoles: employee.roleIds.length - visible.length,
      token: tokenOf(employee.roleIds),
      addedAt: iso(employee.addedAt) ?? new Date(0).toISOString(),
      addedBy,
      you,
      canManage: !you && !isMassAccess,
      canRemove: !you && !isMassAccess && reaches(actor, target),
      accountGone: !account,
    };
    return viewerIsMassAccess ? { ...out, lastSeenAt: iso(account?.lastSeenAt) } : out;
  }

  async function massAccessIdsAmong(ids: readonly string[]): Promise<Set<string>> {
    const answers = await Promise.all(ids.map(async (id) => [id, await massAccessOf(id)] as const));
    return new Set(answers.filter(([, yes]) => yes).map(([id]) => id));
  }

  /** Removes grants that left the app from every role, once per process. */
  async function retireGrants(sql: Awaited<ReturnType<typeof database>>) {
    if (retiredDone) return;
    const gone = [...config.retiredGrants];
    await inTransaction(sql, async (tx) => {
      for (const role of await rolesHolding(tx, gone)) {
        const locked = await readRole(tx, role.id, 'update');
        if (!locked) continue;
        const pages = locked.pages.filter((key) => !config.retiredGrants.has(key));
        const actions = locked.actions.filter((key) => !config.retiredGrants.has(key));
        const out = [...removed(locked.pages, pages), ...removed(locked.actions, actions)];
        if (out.length === 0) continue;
        await updateRole(tx, { id: locked.id, version: locked.version, name: locked.name, pages, actions, by: null });
        await insertHistory(tx, {
          actorId: null,
          action: 'role.pages_retired',
          subjectKind: 'role',
          subjectId: locked.id,
          detail: { name: locked.name, removed: out },
        });
      }
    });
    retiredDone = true;
  }

  /** GET: everything the Team page shows this viewer. */
  async function state(me: Me, v: TeamView): Promise<TeamState> {
    const sql = await database();
    if (!config.problem) {
      try {
        await retireGrants(sql);
      } catch (error) {
        logOnce('retire', '[Team] could not remove retired grants from roles (will try again)', error);
      }
    }
    const team = await readTeam(sql);
    const mine = team.employees.find((e) => e.id === me.id);
    const actor: Actor = { id: me.id, massAccess: me.massAccess, held: new Set(mine?.roleIds ?? []) };
    const catalog = me.massAccess ? full : catalogFor(nav, v, config.retiredGrants);
    const ids = [...team.employees.map((e) => e.id), ...team.employees.map((e) => e.addedBy).filter((id): id is string => !!id)];
    const [accounts, massAccessIds, massAccessAccounts] = await Promise.all([
      accountsByIds(ids),
      massAccessIdsAmong(team.employees.map((e) => e.id)),
      me.massAccess && config.accounts.massAccess ? config.accounts.massAccess().catch(() => [] as readonly TeamAccount[]) : Promise.resolve(null),
    ]);
    const roleNames = new Map(team.roles.map((r) => [r.id, r.name]));
    const visibleRoles = me.massAccess ? team.roles : team.roles.filter((r) => actor.held.has(r.id));

    const catalogSections: CatalogSection[] = [];
    for (const section of nav) {
      const pages = section.items.flatMap((item: TeamNavItem): CatalogPage[] => {
        const access = accessOf(item);
        const actions = (item.actions ?? [])
          .filter((a) => catalog.actions.has(a.key))
          .map((a) => ({ key: a.key, label: a.label, description: a.description ?? null }));
        if (access === 'employees') {
          return [{ grant: null, label: item.label, description: item.description ?? null, locked: true, teamPage: false, actions }];
        }
        if (access === 'role' && typeof item.grant === 'string' && catalog.pages.has(item.grant)) {
          return [{ grant: item.grant, label: item.label, description: item.description ?? null, locked: false, teamPage: item === config.teamItem, actions }];
        }
        return [];
      });
      if (pages.length > 0) catalogSections.push({ label: section.label, pages });
    }

    const assigned = new Set(team.roles.flatMap((r) => r.pages));
    const unassigned = me.massAccess
      ? allPages(nav)
          .filter(({ item }) => accessOf(item) === 'role' && typeof item.grant === 'string' && !assigned.has(item.grant))
          .map(({ item }) => item.label)
      : null;

    const massAccess: MassAccessView[] | null = me.massAccess
      ? (massAccessAccounts ?? []).map((a) => ({
          id: a.id,
          name: personName(a),
          email: typeof a.email === 'string' && a.email ? a.email : null,
          image: typeof a.image === 'string' && a.image ? a.image : null,
          lastSeenAt: iso(a.lastSeenAt),
          you: a.id === me.id,
        }))
      : null;

    const employees = team.employees
      .map((e) => employeeView(e, actor, accounts, roleNames, massAccessIds, me.massAccess))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return {
      title: config.teamItem?.label ?? 'Team',
      description: PAGE_LINE,
      viewer: { id: me.id, massAccess: me.massAccess, roleIds: mine?.roleIds ?? [] },
      canMakeAccounts: config.createAccount !== null,
      signUpUrl: config.createAccount ? null : config.signUpUrl,
      catalog: catalogSections,
      labels: labelMap(),
      everyEmployee: everyEmployeeLabels(),
      roles: visibleRoles.map((r) => roleView(r, actor.held)),
      employees,
      massAccess,
      unassigned,
      problem: me.massAccess && config.problem ? BAD_NAV_LINE : null,
    };
  }

  // ------------------------------------------------------------ employees

  /** The roles asked for, as ids that look right; refuses anything else. */
  function roleIdsFrom(value: unknown): string[] {
    const ids = cleanList(value ?? [], 200);
    if (!ids || ids.some((id) => !UUID.test(id))) throw new Refused('invalid_request', 'invalid_parameter', 'Pick roles from the list.');
    return ids.map((id) => id.toLowerCase());
  }

  /**
   * A manager gives only roles they hold. A role deleted a moment ago is in
   * nobody's hands, so it would read as "not yours": it is told apart first,
   * and the manager hears what Mass Access hears, that the role is gone.
   */
  async function refuseRolesNotHeld(db: TeamSql, held: ReadonlySet<string> | readonly string[], roleIds: readonly string[]) {
    const mine = held instanceof Set ? (held as ReadonlySet<string>) : new Set(held as readonly string[]);
    const outside = [...new Set(roleIds.filter((id) => !mine.has(id)))];
    if (outside.length === 0) return;
    if ((await readRolesByIds(db, outside)).length !== outside.length) {
      throw new Refused('conflict', 'role_gone', 'One of those roles was just deleted. Close this and try again.');
    }
    throw new Refused('permission', 'not_yours', 'You can only give roles you have yourself.');
  }

  async function oneEmployeeView(sql: Awaited<ReturnType<typeof database>>, me: Me, userId: string): Promise<EmployeeView | null> {
    const [employee, mine] = await Promise.all([readEmployee(sql, userId), me.massAccess ? Promise.resolve(null) : readEmployee(sql, me.id)]);
    if (!employee) return null;
    const roles = await readRolesByIds(sql, employee.roleIds);
    const accounts = await accountsByIds([employee.id, ...(employee.addedBy ? [employee.addedBy] : [])]);
    const actor: Actor = { id: me.id, massAccess: me.massAccess, held: new Set(mine?.roleIds ?? []) };
    const isMa = await massAccessOf(employee.id);
    return employeeView(employee, actor, accounts, new Map(roles.map((r) => [r.id, r.name])), isMa ? new Set([employee.id]) : new Set(), me.massAccess);
  }

  /**
   * Puts an existing account on the team with these roles, in one
   * transaction. `me` null is the app's own flow (join()).
   */
  async function putOnTeam(
    sql: Awaited<ReturnType<typeof database>>,
    me: Me | null,
    account: TeamAccount,
    roleIds: readonly string[],
    made: boolean,
  ): Promise<StoredRole[]> {
    return inTransaction(sql, async (tx) => {
      let actorHeld: ReadonlySet<string> | null = null;
      if (me) {
        const { actor } = await lockAndReadActor(tx, me, [account.id]);
        actorHeld = actor.massAccess ? null : actor.held;
      } else {
        await lockEmployees(tx, [{ id: account.id, mode: 'update' }]);
      }
      if (actorHeld) await refuseRolesNotHeld(tx, actorHeld, roleIds);
      const roles = await lockRolesForShare(tx, roleIds);
      if (roles.length !== new Set(roleIds).size) throw new Refused('conflict', 'role_gone', 'One of those roles was just deleted. Close this and try again.');
      if (!(await insertEmployee(tx, account.id, me?.id ?? null))) {
        throw new Refused('conflict', 'already_employee', `${personName(account)} is already an employee.`);
      }
      await giveRoles(tx, account.id, roleIds, me?.id ?? null);
      await insertHistory(tx, {
        actorId: me?.id ?? null,
        action: 'employee.added',
        subjectKind: 'employee',
        subjectId: account.id,
        detail: { made, roles: roles.map((r) => ({ id: r.id, name: r.name })) },
      });
      return roles;
    });
  }

  async function addEmployee(me: Me, body: Record<string, unknown>): Promise<AddResult> {
    mustBeSetUp();
    const email = cleanEmail(body.email);
    if (!email) throw new Refused('invalid_request', 'invalid_email', 'Type a full email address, like jordan@company.com.', undefined, 'email');
    const roleIds = roleIdsFrom(body.roleIds);
    const sql = await database();

    // Checked again inside the change; asked first so no login is made for a request that can't go through.
    if (!me.massAccess) {
      const mine = await readEmployee(sql, me.id);
      if (!mine) throw new Refused('permission', 'not_yours', 'You can only give roles you have yourself.');
      await refuseRolesNotHeld(sql, mine.roleIds, roleIds);
    }

    let account = await config.accounts.byEmail(email);
    let made = false;
    let emailed: boolean | null = null;
    if (!account) {
      if (!config.createAccount) {
        const site = siteOf(config.signUpUrl);
        throw new Refused('invalid_request', 'no_account', `No account has this email yet. Ask them to sign up at ${site} with it, then add them here.`, config.signUpUrl ?? undefined);
      }
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      if (name.length < 2 || name.length > 120) throw new Refused('invalid_request', 'name_required', 'Type their full name, at least 2 letters.', undefined, 'name');
      const result = await config.createAccount({ email, name, addedBy: { id: me.id, name: me.name } });
      if (!result || typeof result.id !== 'string' || !result.id) {
        throw new Refused('internal', 'internal_error', "Their account couldn't be made right now. Try again in a minute.");
      }
      const [fresh] = await config.accounts.byIds([result.id]);
      if (!fresh || cleanEmail(fresh.email) !== email) {
        throw new Refused('internal', 'internal_error', "Their account couldn't be made right now. Try again in a minute.");
      }
      account = fresh;
      made = result.created === true;
      emailed = made ? result.emailed !== false : null;
    }

    if (account.id === me.id) throw new Refused('invalid_request', 'self', "You can't add yourself.");
    if (await massAccessOf(account.id)) {
      throw new Refused('invalid_request', 'has_mass_access', `${personName(account)} has Mass Access, so they already open every page.`);
    }
    // An account someone else could have made with this address before it was confirmed never joins.
    if (!made && account.emailVerified !== true) {
      throw new Refused(
        'invalid_request',
        'email_not_confirmed',
        `${email} has an account that hasn't confirmed its email yet. Ask them to confirm it first, then add them.`,
        undefined,
        'email',
      );
    }

    const roles = await putOnTeam(sql, me, account, roleIds, made);
    if (!made) {
      // A session opened on this account before its email was confirmed must not get the new pages.
      try {
        await config.signOutEverywhere(account.id);
      } catch (error) {
        config.log(`[Team] could not sign ${account.id} out everywhere after they joined`, error);
      }
    }
    const employee = await oneEmployeeView(sql, me, account.id);
    if (!employee) throw new Refused('conflict', 'employee_gone', 'Someone else removed them.');
    return { outcome: made ? 'account_made' : 'joined', employee, opens: opensFor(roles), emailed };
  }

  async function manageEmployee(me: Me, userId: string, body: Record<string, unknown>): Promise<EmployeeView> {
    mustBeSetUp();
    const roleIds = roleIdsFrom(body.roleIds);
    const token = typeof body.token === 'string' ? body.token : '';
    if (userId === me.id) throw new Refused('permission', 'self', "You can't change your own roles. Ask someone else who manages the team.");
    if (await massAccessOf(userId)) throw new Refused('permission', 'has_mass_access', "Mass Access can't be changed here.");
    const sql = await database();
    await inTransaction(sql, async (tx) => {
      const { actor, people } = await lockAndReadActor(tx, me, [userId]);
      const person = people.get(userId);
      if (!person) throw new Refused('not_found', 'employee_gone', 'Someone else removed them.');
      if (tokenOf(person.roleIds) !== token) throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
      if (!actor.massAccess) await refuseRolesNotHeld(tx, actor.held, roleIds);
      const visible = (id: string) => actor.massAccess || actor.held.has(id);
      const give = roleIds.filter((id) => !person.roleIds.includes(id));
      const take = person.roleIds.filter((id) => visible(id) && !roleIds.includes(id));
      if (take.length > 0 && !reaches(actor, { id: person.id, massAccess: false, roleIds: person.roleIds })) {
        throw new Refused('permission', 'out_of_reach', 'Only someone who manages all of their roles can take a role off them.');
      }
      const given = await lockRolesForShare(tx, give);
      if (given.length !== give.length) throw new Refused('conflict', 'role_gone', 'One of those roles was just deleted. Close this and try again.');
      if (give.length === 0 && take.length === 0) return;
      const takenRoles = await readRolesByIds(tx, take);
      await takeRoles(tx, userId, take);
      await giveRoles(tx, userId, give, actor.id);
      await insertHistory(tx, {
        actorId: actor.id,
        action: 'employee.roles_changed',
        subjectKind: 'employee',
        subjectId: userId,
        detail: {
          added: given.map((r) => ({ id: r.id, name: r.name })),
          removed: takenRoles.map((r) => ({ id: r.id, name: r.name })),
        },
      });
    });
    const out = await oneEmployeeView(sql, me, userId);
    if (!out) throw new Refused('not_found', 'employee_gone', 'Someone else removed them.');
    return out;
  }

  /** Takes someone off the team. `me` null is the app's own flow (leave()); `token` null skips the stale check. */
  async function removeFromTeam(me: Me | null, userId: string, token: string | null): Promise<void> {
    const sql = await database();
    if (me && userId === me.id) throw new Refused('permission', 'self', "You can't remove yourself. Ask someone else who manages the team.");
    if (await massAccessOf(userId)) throw new Refused('permission', 'has_mass_access', "Mass Access can't be changed here.");
    await inTransaction(sql, async (tx) => {
      let actor: ActorNow | null = null;
      let person: StoredEmployee | undefined;
      if (me) {
        const locked = await lockAndReadActor(tx, me, [userId]);
        actor = locked.actor;
        person = locked.people.get(userId);
      } else {
        person = (await lockEmployees(tx, [{ id: userId, mode: 'update' }])).get(userId);
      }
      if (!person) throw new Refused('not_found', 'employee_gone', 'Someone else removed them.');
      if (token !== null && tokenOf(person.roleIds) !== token) {
        throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
      }
      if (actor && !reaches(actor, { id: person.id, massAccess: false, roleIds: person.roleIds })) {
        throw new Refused('permission', 'out_of_reach', 'Only someone who manages all of their roles can remove them.');
      }
      const roles = await readRolesByIds(tx, person.roleIds);
      await deleteEmployee(tx, userId);
      await insertHistory(tx, {
        actorId: me?.id ?? null,
        action: 'employee.removed',
        subjectKind: 'employee',
        subjectId: userId,
        detail: { roles: roles.map((r) => ({ id: r.id, name: r.name })) },
      });
    });
  }

  async function removeEmployee(me: Me, userId: string, token: string): Promise<void> {
    mustBeSetUp();
    await removeFromTeam(me, userId, token);
    try {
      await config.signOutEverywhere(userId);
    } catch (error) {
      config.log(`[Team] could not sign ${userId} out everywhere after they were removed`, error);
    }
  }

  // ------------------------------------------------------------ roles

  function roleInput(body: Record<string, unknown>): { name: string; pages: string[]; actions: string[] } {
    const name = cleanRoleName(body.name);
    if (!name) throw new Refused('invalid_request', 'invalid_parameter', 'Give the role a name.', undefined, 'name');
    if (name.length > NAME_MAX) throw new Refused('invalid_request', 'invalid_parameter', `Keep the name to ${NAME_MAX} letters or fewer.`, undefined, 'name');
    const pages = cleanList(body.pages ?? []);
    const actions = cleanList(body.actions ?? []);
    if (!pages || !actions) throw new Refused('invalid_request', 'invalid_parameter', 'Pick pages from the list.');
    return { name, pages, actions };
  }

  function refuseOutside(keys: readonly string[], actor: ActorNow, kind: 'pages' | 'actions') {
    const allowed = actor.catalog[kind];
    const all = full[kind];
    for (const key of keys) {
      if (!all.has(key)) throw new Refused('invalid_request', 'invalid_parameter', "One of those pages isn't in the app anymore. Reload the page and try again.");
      if (!allowed.has(key)) throw new Refused('permission', 'not_yours', 'You can only give pages you can open yourself.');
    }
  }

  /**
   * Which of a role's holders have Mass Access, asked before the change's
   * transaction opens. The app may read its Mass Access record through the
   * same client it gave as `db`; with one connection, a question asked
   * inside the transaction would wait on the transaction asking it, for
   * good. Mass Access reaches every holder, so it asks nothing.
   */
  async function massAccessAmongHolders(sql: TeamSql, me: Me, roleId: string): Promise<ReadonlySet<string>> {
    if (me.massAccess) return new Set();
    return massAccessIdsAmong((await readHolders(sql, roleId)).map((h) => h.id));
  }

  /**
   * The role's holders as they are under the change's locks. Someone given
   * the role after the Mass Access question was asked counts as not having
   * it: the change may then be refused where it could have gone through,
   * never the other way round.
   */
  async function holdersAsTargets(tx: TeamSql, roleId: string, withMassAccess: ReadonlySet<string>) {
    const holders = await readHolders(tx, roleId);
    return holders.map((h) => ({ id: h.id, massAccess: withMassAccess.has(h.id), roleIds: h.roleIds }));
  }

  function nameTaken(error: unknown): boolean {
    return pgCode(error) === '23505' && pgConstraint(error) === 'team_roles_name_unique';
  }

  async function createRole(me: Me, body: Record<string, unknown>): Promise<RoleView> {
    mustBeSetUp();
    const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id.toLowerCase() : null;
    if (!id) throw new Refused('invalid_request', 'invalid_parameter', 'Reload the page and try again.');
    const input = roleInput(body);
    const whole = withActionPages(nav, input.pages, input.actions);
    if (whole.pages.length + whole.actions.length === 0) throw new Refused('invalid_request', 'no_pages', 'Tick at least one page.', undefined, 'pages');
    const sql = await database();
    try {
      await inTransaction(sql, async (tx) => {
        const { actor } = await lockAndReadActor(tx, me, []);
        refuseOutside(whole.pages, actor, 'pages');
        refuseOutside(whole.actions, actor, 'actions');
        const pages = inNavOrder(nav, whole.pages);
        const actions = inNavOrder(nav, whole.actions);
        if (!(await insertRole(tx, { id, name: input.name, pages, actions, by: me.id }))) return; // a double click: the first one made it
        // A manager's new role is theirs too, so they can manage it.
        if (!actor.massAccess) await giveRoles(tx, me.id, [id], me.id);
        await insertHistory(tx, {
          actorId: me.id,
          action: 'role.made',
          subjectKind: 'role',
          subjectId: id,
          detail: { name: input.name, pages: keyLabels(pages), actions: keyLabels(actions) },
        });
      });
    } catch (error) {
      if (!nameTaken(error)) throw error;
      // Sent twice at the same moment (a second click, or a retry), the second
      // one can trip on the first one's name before it sees its id. The role
      // with this id and this name is the one the first click made.
      const twin = await readRole(sql, id);
      if (!twin || twin.name !== input.name) throw new Refused('conflict', 'name_taken', 'Pick another name: that one is taken.', undefined, 'name');
    }
    const role = await readRole(sql, id);
    if (!role) throw new Refused('conflict', 'role_gone', 'Someone else deleted this role.');
    const mine = me.massAccess ? null : await readEmployee(sql, me.id);
    const held = new Set(mine?.roleIds ?? []);
    // A second click is answered with the role the first one made, which a
    // manager holds. An id that is some other role's shows them nothing of it.
    if (!me.massAccess && !held.has(role.id)) throw new Refused('invalid_request', 'invalid_parameter', 'Reload the page and try again.');
    return roleView(role, held);
  }

  async function editRole(me: Me, roleId: string, body: Record<string, unknown>): Promise<RoleView> {
    mustBeSetUp();
    if (!UUID.test(roleId)) throw notFound();
    const input = roleInput(body);
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) throw new Refused('invalid_request', 'invalid_parameter', 'Reload the page and try again.');
    const sql = await database();
    const holdersWithMassAccess = await massAccessAmongHolders(sql, me, roleId);
    try {
      await inTransaction(sql, async (tx) => {
        const { actor } = await lockAndReadActor(tx, me, []);
        const role = await readRole(tx, roleId, 'update');
        if (!role) throw new Refused('conflict', 'role_gone', 'Someone else deleted this role.');
        if (!actor.massAccess && !actor.held.has(role.id)) throw notFound();
        if (role.version !== version) throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
        const ticked = editedTicks(nav, role.pages, input.pages, input.actions);
        for (const key of refusedAdditions(role.pages, ticked.pages, actor.catalog.pages)) refuseOutside([key], actor, 'pages');
        for (const key of refusedAdditions(role.actions, ticked.actions, actor.catalog.actions)) refuseOutside([key], actor, 'actions');
        // What the editor may not give stays exactly as it was stored. It is
        // never made whole again: a stored action whose page moved, or became
        // a role page, would bring in a page the editor can't open.
        const pages = inNavOrder(nav, mergeSave(role.pages, ticked.pages, actor.catalog.pages));
        const actions = inNavOrder(nav, mergeSave(role.actions, ticked.actions, actor.catalog.actions));
        if (pages.length + actions.length === 0) throw new Refused('invalid_request', 'no_pages', 'Tick at least one page.', undefined, 'pages');
        const lostPages = removed(role.pages, pages);
        const lostActions = removed(role.actions, actions);
        if ((lostPages.length > 0 || lostActions.length > 0) && !reachesHolders(actor, await holdersAsTargets(tx, role.id, holdersWithMassAccess))) {
          throw new Refused('permission', 'out_of_reach', "Some people in this role have roles you don't manage, so you can't take pages off it.");
        }
        const gotPages = added(role.pages, pages);
        const gotActions = added(role.actions, actions);
        // Whatever the steps above did, nothing new goes into a role unless the editor may give it.
        refuseOutside(gotPages, actor, 'pages');
        refuseOutside(gotActions, actor, 'actions');
        const renamed = role.name !== input.name;
        if (!renamed && gotPages.length + gotActions.length + lostPages.length + lostActions.length === 0) return;
        if (!(await updateRole(tx, { id: role.id, version, name: input.name, pages, actions, by: me.id }))) {
          throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
        }
        await insertHistory(tx, {
          actorId: me.id,
          action: 'role.changed',
          subjectKind: 'role',
          subjectId: role.id,
          detail: {
            name: input.name,
            ...(renamed ? { renamedFrom: role.name } : {}),
            added: keyLabels([...gotPages, ...gotActions]),
            removed: keyLabels([...lostPages, ...lostActions]),
          },
        });
      });
    } catch (error) {
      if (nameTaken(error)) throw new Refused('conflict', 'name_taken', 'Pick another name: that one is taken.', undefined, 'name');
      throw error;
    }
    const role = await readRole(sql, roleId);
    if (!role) throw new Refused('conflict', 'role_gone', 'Someone else deleted this role.');
    const mine = me.massAccess ? null : await readEmployee(sql, me.id);
    return roleView(role, new Set(mine?.roleIds ?? []));
  }

  async function deleteRole(me: Me, roleId: string, version: number): Promise<void> {
    mustBeSetUp();
    if (!UUID.test(roleId)) throw notFound();
    if (!Number.isInteger(version) || version < 1) throw new Refused('invalid_request', 'invalid_parameter', 'Reload the page and try again.');
    const sql = await database();
    const holdersWithMassAccess = await massAccessAmongHolders(sql, me, roleId);
    await inTransaction(sql, async (tx) => {
      const { actor } = await lockAndReadActor(tx, me, []);
      const role = await readRole(tx, roleId, 'update');
      if (!role) throw new Refused('conflict', 'role_gone', 'Someone else deleted this role.');
      if (!actor.massAccess && !actor.held.has(role.id)) throw notFound();
      if (role.version !== version) throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
      const holders = await holdersAsTargets(tx, role.id, holdersWithMassAccess);
      if (!reachesHolders(actor, holders)) {
        throw new Refused('permission', 'out_of_reach', "Some people in this role have roles you don't manage, so you can't delete it.");
      }
      if (!(await deleteRoleRow(tx, role.id, version))) {
        throw new Refused('conflict', 'stale', "Someone else changed this while you had it open, so your change wasn't saved.");
      }
      await insertHistory(tx, {
        actorId: me.id,
        action: 'role.deleted',
        subjectKind: 'role',
        subjectId: role.id,
        detail: { name: role.name, people: holders.length, pages: keyLabels(role.pages) },
      });
    });
  }

  // ------------------------------------------------------------ history

  function listOf(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  function namesOf(value: unknown): string[] {
    return Array.isArray(value)
      ? value.flatMap((entry) => {
          const e = entry as { name?: unknown; label?: unknown; key?: unknown } | null;
          if (!e) return [];
          if (typeof e.name === 'string') return [e.name];
          if (typeof e.label === 'string') return [e.label];
          return [];
        })
      : [];
  }

  async function history(before: string | null): Promise<HistoryPage> {
    const sql = await database();
    const rows = await readHistory(sql, before, HISTORY_PAGE + 1);
    const page = rows.slice(0, HISTORY_PAGE);
    const ids = page.flatMap((r) => [r.actorId, r.subjectKind === 'employee' || r.subjectKind === 'account' ? r.subjectId : null]).filter((id): id is string => !!id);
    const accounts = await accountsByIds(ids);
    const who = (id: string | null) => (id === null ? 'The app' : personName(accounts.get(id)));
    const text = (r: (typeof page)[number]): string => {
      const d = r.detail;
      const actor = who(r.actorId);
      const person = who(r.subjectId);
      const roles = listOf(namesOf(d.roles));
      switch (r.action) {
        case 'employee.added':
          return d.made === true
            ? `${actor} made an account for ${person} and added them${roles ? ` with ${roles}` : ''}.`
            : `${actor} added ${person}${roles ? ` with ${roles}` : ''}.`;
        case 'employee.roles_changed': {
          const parts = [namesOf(d.added).length ? `added ${listOf(namesOf(d.added))}` : '', namesOf(d.removed).length ? `took off ${listOf(namesOf(d.removed))}` : ''].filter(Boolean);
          return `${actor} changed ${person}'s roles: ${parts.join('; ')}.`;
        }
        case 'employee.removed':
          return `${actor} removed ${person}.`;
        case 'role.made': {
          const opens = listOf(namesOf(d.pages));
          return `${actor} made the role ${String(d.name ?? '')}.${opens ? ` It opens ${opens}.` : ''}`;
        }
        case 'role.changed': {
          const name = String(d.name ?? '');
          const sentences: string[] = [];
          if (typeof d.renamedFrom === 'string') sentences.push(`${actor} renamed ${d.renamedFrom} to ${name}.`);
          const parts = [namesOf(d.added).length ? `added ${listOf(namesOf(d.added))}` : '', namesOf(d.removed).length ? `took off ${listOf(namesOf(d.removed))}` : ''].filter(Boolean);
          if (parts.length) sentences.push(`${actor} changed ${name}: ${parts.join('; ')}.`);
          return sentences.join(' ') || `${actor} changed ${name}.`;
        }
        case 'role.deleted': {
          const people = Number(d.people ?? 0);
          return `${actor} deleted the role ${String(d.name ?? '')}.${people > 0 ? ` ${people === 1 ? '1 person' : `${people} people`} had it.` : ''}`;
        }
        case 'role.pages_retired': {
          const labels = labelMap();
          const gone = Array.isArray(d.removed) ? (d.removed as unknown[]).filter((k): k is string => typeof k === 'string') : [];
          const named = gone.map((k) => labels[k]).filter((l): l is string => !!l);
          return named.length
            ? `${listOf(named)} left the app, so ${named.length === 1 ? 'it' : 'they'} came off ${String(d.name ?? '')}.`
            : `A page that's gone came off ${String(d.name ?? '')}.`;
        }
        case 'account.forgotten':
          return 'A deleted account left the team.';
        default:
          return `${actor} made a change.`;
      }
    };
    return { rows: page.map((r) => ({ id: r.id, at: iso(r.at) ?? r.at, text: text(r) })), more: rows.length > HISTORY_PAGE };
  }

  // ------------------------------------------------------------ the app's own flows

  async function join(input: Readonly<{ userId: string; roleIds?: readonly string[]; by?: string | null }>): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      mustBeSetUp();
      const roleIds = roleIdsFrom(input.roleIds ?? []);
      const sql = await database();
      const [account] = await config.accounts.byIds([input.userId]);
      if (!account) return { ok: false, reason: 'No account has that id.' };
      if (await massAccessOf(account.id)) return { ok: false, reason: `${personName(account)} has Mass Access.` };
      let me: Me | null = null;
      if (input.by) {
        if (input.by === input.userId) return { ok: false, reason: "Someone can't add themselves." };
        me = { id: input.by, name: null, massAccess: await massAccessOf(input.by) };
      }
      await putOnTeam(sql, me, account, roleIds, false);
      return { ok: true };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.message };
      config.log('[Team] join failed', error);
      return { ok: false, reason: 'The change was not saved.' };
    }
  }

  async function leave(input: Readonly<{ userId: string; by?: string | null }>): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      mustBeSetUp();
      const me: Me | null = input.by ? { id: input.by, name: null, massAccess: await massAccessOf(input.by) } : null;
      await removeFromTeam(me, input.userId, null);
      return { ok: true };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.message };
      config.log('[Team] leave failed', error);
      return { ok: false, reason: 'The change was not saved.' };
    }
  }

  async function forgetAccount(userId: string): Promise<number | null> {
    try {
      if (typeof userId !== 'string' || !userId) return 0;
      const sql = await config.db();
      if (!sql) return null;
      return await inTransaction(sql, async (tx) => {
        if (!(await deleteEmployee(tx, userId))) return 0;
        await insertHistory(tx, { actorId: null, action: 'account.forgotten', subjectKind: 'account', subjectId: userId, detail: {} });
        return 1;
      });
    } catch (error) {
      config.log("[Team] an account's team rows were not removed", error);
      return null;
    }
  }

  return {
    view,
    managesTeam,
    massAccessOf,
    state,
    addEmployee,
    manageEmployee,
    removeEmployee,
    createRole,
    editRole,
    deleteRole,
    history,
    join,
    leave,
    forgetAccount,
    logOnce,
    opensLine,
  };
}

export type TeamCore<User extends TeamUser = TeamUser> = ReturnType<typeof createTeamCore<User>>;
