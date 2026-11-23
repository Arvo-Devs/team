// The contract between the package and the app that installs it. Everything
// that differs from app to app comes in through here: the database, who is
// signed in, who has Mass Access, the app's nav list, its accounts, and how
// it makes a login and signs someone out. The shapes match @arvo/traffic and
// @arvo/signup-funnel, so an app that has those reuses its wiring.
//
// normalizeConfig reads it once, in createTeam. It imports nothing that needs
// Node, so a page that imports a type from here stays a browser bundle.
import type postgres from 'postgres';
import { navProblem, normalizePath, type TeamNav, type TeamNavItem } from './nav';

/**
 * A postgres.js client for the app's database, with the package's tables
 * (migrations/). Any client works, wrapped by drizzle or not, fetch_types on
 * or off: the package reads its lists as JSON it parses itself.
 */
export type TeamSql = postgres.Sql;

/** The person signed in, as the app's auth knows them on this request. */
export type TeamUser = Readonly<{
  id: string;
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean | null;
  /**
   * True while someone else is looking through this account (log in as, or
   * a staff "view as"). The package then gives no Mass Access and no team
   * pages, and writes nothing.
   */
  viewedAs?: boolean | null;
}>;

/** An account as the app knows it now. The package keeps none of this. */
export type TeamAccount = Readonly<{
  id: string;
  name?: string | null;
  email?: string | null;
  /** True when the account's email is confirmed. Someone whose email isn't can't be added. */
  emailVerified?: boolean | null;
  /** A picture for the avatar. */
  image?: string | null;
  /** When the account was made: a Date or ISO 8601. */
  createdAt?: Date | string | null;
  /** When the app last saw the account (its last sign-in or request), shown to Mass Access only. */
  lastSeenAt?: Date | string | null;
}>;

export type TeamAccounts = Readonly<{
  /** The accounts with these ids (any order; missing ones are left out). At most 500 ids per call. */
  byIds: (ids: readonly string[]) => Promise<readonly TeamAccount[]>;
  /** The account with this email (the package lower-cases and trims it first), or null. */
  byEmail: (email: string) => Promise<TeamAccount | null>;
  /** Every account with Mass Access, listed at the top of the Team page for Mass Access viewers only. */
  massAccess?: () => Promise<readonly TeamAccount[]>;
}>;

export type TeamCreateAccount = (input: Readonly<{ email: string; name: string; addedBy: Readonly<{ id: string; name: string | null }> }>) => Promise<Readonly<{
  id: string;
  /** True when this call made the account; false when one with that email was already there. */
  created: boolean;
  /** False when the email with their link to set a password didn't go out (the page then says how they can still get in). Default true. */
  emailed?: boolean;
}> | null>;

export type TeamLog = (line: string, error?: unknown) => void;

export type TeamConfig<User extends TeamUser = TeamUser> = Readonly<{
  /** The database, or null when it is not set up (the routes answer 503). A function, so nothing connects at build time. */
  db: () => Promise<TeamSql | null> | TeamSql | null;
  /** Who is signed in, asked on every call that needs it; `fresh` is true before any change. */
  signedInUser: (request: Request, options: Readonly<{ fresh: boolean }>) => Promise<User | null>;
  /** The app's one Mass Access check, by account id, read from its database every time. Only an exact true counts. */
  hasMassAccess: (userId: string) => boolean | Promise<boolean>;
  /** The app's nav list: every signed-in page, each saying who may open it (Framework Part 3). */
  nav: TeamNav;
  /** The address of the Team page itself in the nav. Its label is the page's title. */
  teamPage: string;
  /** The site's own hosts: a change that comes from any other site is refused. */
  siteHosts: readonly string[];
  /** The app's accounts, read live. */
  accounts: TeamAccounts;
  /**
   * Signs the account out on every device. Run after an account that already
   * existed joins the team (so a session someone else opened on it before the
   * email was confirmed can't use the new pages), and after a removal.
   */
  signOutEverywhere: (userId: string) => Promise<void>;
  /**
   * Makes a login for someone who has no account yet and emails them a link
   * to set their password. Without it, the Team page asks the manager to have
   * them sign up first.
   */
  createAccount?: TeamCreateAccount;
  /** The app's sign-up page, offered as a link to copy when someone has no account and the app can't make one. */
  signUpUrl?: string;
  /** Grants and action keys that left the app: removed from every role, and never used again. */
  retiredGrants?: readonly string[];
  /** Where routeHandlers are mounted. Default /api/team. */
  basePath?: string;
  /** Where errors are written. Default console.error. */
  log?: TeamLog;
}>;

/** The config as the server uses it: defaults filled in, and what is wrong with it, if anything. */
export type ResolvedTeamConfig<User extends TeamUser = TeamUser> = Readonly<{
  db: () => Promise<TeamSql | null>;
  signedInUser: (request: Request, options: Readonly<{ fresh: boolean }>) => Promise<User | null>;
  hasMassAccess: (userId: string) => Promise<boolean>;
  nav: TeamNav;
  /** The Team page's nav item; null when teamPage names none (problem says so). */
  teamItem: TeamNavItem | null;
  siteHosts: readonly string[];
  accounts: TeamAccounts;
  signOutEverywhere: (userId: string) => Promise<void>;
  createAccount: TeamCreateAccount | null;
  signUpUrl: string | null;
  retiredGrants: ReadonlySet<string>;
  /** With no slash at the end. */
  basePath: string;
  log: TeamLog;
  /** What is wrong with the nav list or the config, in a sentence a developer can act on, or null. */
  problem: string | null;
}>;

export const TEAM_BASE_PATH = '/api/team';

const defaultLog: TeamLog = (line, error) => {
  if (error === undefined) console.error(line);
  else console.error(line, error);
};

/**
 * A nav list with everything unreadable left out: sections that aren't a
 * section, items with no label or address, action lists that aren't lists.
 * The rest is kept as it is, each unclear page closed by the check.
 */
function readableNav(raw: readonly unknown[]): TeamNav {
  const out: Array<TeamNav[number]> = [];
  for (const section of raw) {
    if (!section || typeof section !== 'object') continue;
    const { label, items } = section as { label?: unknown; items?: unknown };
    if (!Array.isArray(items)) continue;
    const kept: TeamNavItem[] = [];
    for (const item of items as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const page = item as Partial<TeamNavItem> & { actions?: unknown };
      if (typeof page.label !== 'string' || typeof page.href !== 'string') continue;
      const actions = Array.isArray(page.actions)
        ? (page.actions as unknown[]).filter(
            (a): a is NonNullable<TeamNavItem['actions']>[number] =>
              !!a && typeof a === 'object' && typeof (a as { key?: unknown }).key === 'string' && typeof (a as { label?: unknown }).label === 'string',
          )
        : undefined;
      kept.push({ ...(page as TeamNavItem), ...(page.actions === undefined ? {} : { actions: actions ?? [] }) });
    }
    out.push({ ...(section as TeamNav[number]), label: typeof label === 'string' ? label : null, items: kept });
  }
  return out;
}

/**
 * Reads the config once. Never throws: what is wrong is kept in `problem`,
 * logged once, and shown on the Team page to Mass Access; the check keeps
 * working on whatever the nav list says, each unclear page closed.
 */
export function normalizeConfig<User extends TeamUser>(input: TeamConfig<User>): ResolvedTeamConfig<User> {
  const log = typeof input?.log === 'function' ? input.log : defaultLog;
  const rawNav: TeamNav = Array.isArray(input?.nav) ? input.nav : [];
  const retired = Array.isArray(input?.retiredGrants) ? input.retiredGrants.filter((g): g is string => typeof g === 'string') : [];
  const teamPage = typeof input?.teamPage === 'string' ? input.teamPage : '';
  const siteHosts = Array.isArray(input?.siteHosts)
    ? input.siteHosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim().toLowerCase())
    : [];

  let problem = navProblem(rawNav, { teamPage, retiredGrants: retired });
  // A list the check refuses may hold anything. What can't be read is left out, so createTeam never throws on it.
  const nav = problem ? readableNav(rawNav) : rawNav;
  if (!problem && siteHosts.length === 0) problem = "siteHosts is empty: list the site's own hosts, so the Team page's changes can be checked.";
  if (!problem && typeof input?.signOutEverywhere !== 'function') problem = 'signOutEverywhere is missing: the Team page signs someone out when they join or are removed.';
  if (!problem && (typeof input?.accounts?.byIds !== 'function' || typeof input?.accounts?.byEmail !== 'function')) {
    problem = 'accounts.byIds and accounts.byEmail are missing: the Team page reads names and emails from the app.';
  }
  if (!problem && typeof input?.hasMassAccess !== 'function') problem = "hasMassAccess is missing: give the app's one Mass Access check (by account id).";
  if (!problem && typeof input?.signedInUser !== 'function') problem = 'signedInUser is missing.';
  if (problem) log(`[Team] not set up right: ${problem}`);

  const teamItem = teamPage ? (nav.flatMap((section) => section.items).find((item) => normalizePath(item.href) === normalizePath(teamPage)) ?? null) : null;
  const rawBase = typeof input?.basePath === 'string' ? input.basePath.trim() : '';
  const basePath = rawBase ? rawBase.replace(/\/+$/, '') : TEAM_BASE_PATH;
  const db = input?.db;
  const hasMassAccess = input?.hasMassAccess;
  const signOut = input?.signOutEverywhere;

  return {
    db: async () => (typeof db === 'function' ? ((await db()) ?? null) : null),
    signedInUser: typeof input?.signedInUser === 'function' ? input.signedInUser : async () => null,
    // Only an exact true counts: a throw, undefined, a string or a truthy object is no.
    hasMassAccess: async (userId) => {
      if (typeof hasMassAccess !== 'function' || typeof userId !== 'string' || !userId) return false;
      return (await hasMassAccess(userId)) === true;
    },
    nav,
    teamItem,
    siteHosts,
    accounts: input?.accounts ?? { byIds: async () => [], byEmail: async () => null },
    signOutEverywhere: typeof signOut === 'function' ? signOut : async () => undefined,
    createAccount: typeof input?.createAccount === 'function' ? input.createAccount : null,
    signUpUrl: typeof input?.signUpUrl === 'string' && input.signUpUrl.trim() ? input.signUpUrl.trim() : null,
    retiredGrants: new Set(retired),
    basePath,
    log,
    problem,
  };
}
