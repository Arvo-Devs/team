// @arvo/team on the server. createTeam(config) reads the app's config once
// and gives back the Team page's routes and the one check every page asks:
// the nav item (view), the page (requirePage, requireArea) and the data
// (can, canDo). Keep one per process (README, "One server file").
//
// Server only: it uses Node's crypto. The nav rules are in ./nav and the page
// is in ./client.
import { notFound } from 'next/navigation';
import { normalizeConfig, type TeamConfig, type TeamUser } from './config';
import { canDoAction, canOpenPage, canOpenRef, pageFor, type TeamView } from './nav';
import { createRouteHandlers, type RouteHandler } from './server/routes';
import { createTeamCore } from './server/team';

export type TeamResult = { ok: true } | { ok: false; reason: string };

export type Team<User extends TeamUser = TeamUser> = Readonly<{
  /** GET, POST, PATCH and DELETE for one catch-all route file at basePath. */
  routeHandlers: Readonly<{ GET: RouteHandler; POST: RouteHandler; PATCH: RouteHandler; DELETE: RouteHandler }>;
  /**
   * What this person may open, from one database read (Mass Access from the
   * app's own check, alongside). Plain JSON for the app's nav. Wrap it in
   * React's cache() so a page render reads it once. Never throws: a failure
   * gives no team pages and leaves Mass Access as the app's check said.
   */
  view: (user: User | null | undefined) => Promise<TeamView>;
  /** May this person open the page a grant ('email') or an address ('/dashboard/admin/email') names? */
  can: (user: User | null | undefined, ref: string) => Promise<boolean>;
  /** May this person do this action (its page included)? */
  canDo: (user: User | null | undefined, actionKey: string) => Promise<boolean>;
  /** May this person open this address (a sub-page counts as its page)? */
  canOpen: (user: User | null | undefined, pathname: string) => Promise<boolean>;
  /**
   * For the top of a page: "page not found" (Next's notFound()) unless the
   * person may open it. Never wrap it in try/catch: notFound() works by
   * throwing. Any failure counts as no.
   */
  requirePage: (user: User | null | undefined, ref: string) => Promise<void>;
  /**
   * For an admin folder's layout, in place of a Mass-Access-only gate:
   * "page not found" unless the person has Mass Access or is on the team.
   * Each page under it still calls requirePage.
   */
  requireArea: (user: User | null | undefined) => Promise<void>;
  /** Puts an account on the team from the app's own proven flow (an invite link it already checked). `by` null is the app itself. */
  join: (input: Readonly<{ userId: string; roleIds?: readonly string[]; by?: string | null }>) => Promise<TeamResult>;
  /** Takes someone off the team from the app's own flow. */
  leave: (input: Readonly<{ userId: string; by?: string | null }>) => Promise<TeamResult>;
  /**
   * For the app's delete-account code: takes the account off the team.
   * Answers how many rows went (0 or 1), or null when it could not (try
   * again later). Never throws. History keeps its rows (ids only).
   */
  forgetAccount: (userId: string) => Promise<number | null>;
}>;

/** Never throws, whatever the config: what is wrong is logged, shown to Mass Access on the Team page, and changes are off until it is fixed. */
export function createTeam<User extends TeamUser = TeamUser>(input: TeamConfig<User>): Team<User> {
  const config = normalizeConfig(input);
  const core = createTeamCore(config);
  const nav = config.nav;

  async function allowed(work: () => Promise<boolean>): Promise<boolean> {
    try {
      return (await work()) === true;
    } catch (error) {
      core.logOnce('check', '[Team] a page check failed, so it counted as no', error);
      return false;
    }
  }

  const can = (user: User | null | undefined, ref: string) =>
    allowed(async () => {
      // An everyone page is for any signed-in account: nobody signed out opens a page through here.
      if (!user) return false;
      const ok = canOpenRef(await core.view(user), nav, ref);
      if (!ok && typeof ref === 'string' && !ref.startsWith('/') && !nav.some((s) => s.items.some((i) => i.grant === ref))) {
        core.logOnce(`unknown-${ref}`, `[Team] can() was asked about "${ref}", which is no page's grant in the nav list, so it answered no`);
      }
      return ok;
    });

  return {
    routeHandlers: createRouteHandlers(config, core),
    view: (user) => core.view(user),
    can,
    canDo: (user, actionKey) => allowed(async () => (user ? canDoAction(await core.view(user), nav, actionKey) : false)),
    canOpen: (user, pathname) =>
      allowed(async () => {
        if (!user) return false;
        const page = pageFor(nav, pathname);
        const v = await core.view(user);
        return page ? canOpenPage(v, page) : v.massAccess === true;
      }),
    requirePage: async (user, ref) => {
      const ok = await can(user, ref);
      if (!user || ok !== true) notFound();
    },
    requireArea: async (user) => {
      const ok = await allowed(async () => {
        const v = await core.view(user);
        return v.massAccess === true || v.employee === true;
      });
      if (!user || ok !== true) notFound();
    },
    join: (input) => core.join(input),
    leave: (input) => core.leave(input),
    forgetAccount: (userId) => core.forgetAccount(userId),
  };
}

export type { TeamAccount, TeamAccounts, TeamConfig, TeamCreateAccount, TeamLog, TeamSql, TeamUser } from './config';
export type { TeamAccessKind, TeamNav, TeamNavAction, TeamNavItem, TeamNavSection, TeamView } from './nav';
export type * from './shared/api';
export { navProblem, NOBODY } from './nav';
