// The app's nav list, as @arvo/team reads it, and the one rule that decides
// who may open each page. Framework Part 3: the nav is one list in one place,
// the source of truth for which pages exist and who sees them; this file is
// how the Team page, the server's check and the left nav all read that list.
//
// Plain TypeScript: no Node, no React, no database. The app's nav component
// (often a client component) imports it to filter the list with the view the
// server worked out, and the server imports it to check a page. Both ask
// canOpenPage, so the nav item and the page never disagree.

/**
 * Who may open a page. Every item says it; there is no default.
 * - `everyone`: anyone signed in (customer pages). Never in the Admin section.
 * - `employees`: every employee (an internal tool's Overview, say).
 * - `role`: the employees whose role gives it (its `grant`). Mass Access always.
 * - `mass-access`: only Mass Access. Never given to a role, never shown in the role editor.
 */
export type TeamAccessKind = 'everyone' | 'employees' | 'role' | 'mass-access';

export const ACCESS_KINDS: readonly TeamAccessKind[] = ['everyone', 'employees', 'role', 'mass-access'];

/** Something inside a page that a role is given apart from the page ("Make tracking links"). */
export type TeamNavAction = Readonly<{
  /** Stored in roles. Lower case letters, digits, dots, dashes and underscores (at most 60), unique across every grant and action. */
  key: string;
  /** In the role editor: "Make tracking links". */
  label: string;
  /** One line under the label. */
  description?: string;
}>;

/** One page in the nav. Other fields (an icon) are the app's and pass through untouched. */
export type TeamNavItem = Readonly<{
  /** The nav label, which is also the page's title, word for word. */
  label: string;
  /** The page's address. */
  href: string;
  /** Who may open it. */
  access: TeamAccessKind;
  /**
   * What roles store for a `role` page: a short name that never changes and
   * is never the href ("email", "traffic"), so the page can move. Required on
   * `role` pages. When a page leaves the app, its grant goes in the config's
   * retiredGrants and is never used again.
   */
  grant?: string;
  /** One line about the page, shown under it in the role editor. */
  description?: string;
  /** Things inside the page a role can be given apart from it. Only on `role` and `employees` pages. */
  actions?: readonly TeamNavAction[];
  /**
   * True when the addresses under this one are this page too (a link's own
   * page under Traffic, say), so whoever may open the page may open them.
   * Default false: an address no page lists opens for Mass Access only.
   */
  subpages?: boolean;
}>;

export type TeamNavSection<Item extends TeamNavItem = TeamNavItem> = Readonly<{
  /** The section's heading in the nav and in the role editor. Null for a first section with no heading. */
  label: string | null;
  items: readonly Item[];
}>;

export type TeamNav<Item extends TeamNavItem = TeamNavItem> = readonly TeamNavSection<Item>[];

/**
 * What one person may open, as the server worked it out on this request.
 * Plain JSON: the server layout hands it to the app's nav component.
 */
export type TeamView = Readonly<{
  /** Mass Access, from the app's own hasMassAccess. Never while viewing as someone. */
  massAccess: boolean;
  /** On the team. */
  employee: boolean;
  /** The grants the person's roles give. */
  pages: readonly string[];
  /** The action keys the person's roles give. */
  actions: readonly string[];
}>;

/** Someone the check knows nothing about (or anyone viewing as someone else): `everyone` pages only. */
export const NOBODY: TeamView = Object.freeze({ massAccess: false, employee: false, pages: Object.freeze([]), actions: Object.freeze([]) });

/** A path without its query, hash and trailing slash ("/" stays "/"). */
export function normalizePath(path: string): string {
  const bare = (path.split(/[?#]/, 1)[0] ?? '').trim();
  if (!bare || bare === '/') return '/';
  return bare.replace(/\/+$/, '') || '/';
}

/** The item's access kind; anything missing or unknown counts as `role` (closed unless a role gives its grant). */
export function accessOf(item: Pick<TeamNavItem, 'access'>): TeamAccessKind {
  return ACCESS_KINDS.includes(item.access) ? item.access : 'role';
}

/**
 * THE rule. Mass Access opens everything; a Mass Access page opens for no
 * one else; an `everyone` page opens for anyone signed in; the rest need the
 * person on the team, and a `role` page needs a role that gives its grant.
 */
export function canOpenPage(view: TeamView, item: Pick<TeamNavItem, 'access' | 'grant'>): boolean {
  if (view.massAccess === true) return true;
  const access = accessOf(item);
  if (access === 'mass-access') return false;
  if (access === 'everyone') return true;
  if (view.employee !== true) return false;
  if (access === 'employees') return true;
  return typeof item.grant === 'string' && Array.isArray(view.pages) && view.pages.includes(item.grant);
}

/** Every page in the nav, in order, with its section's label. */
export function allPages<Item extends TeamNavItem>(nav: TeamNav<Item>): Array<{ item: Item; section: string | null }> {
  return nav.flatMap((section) => section.items.map((item) => ({ item, section: section.label })));
}

/** The `role` page that has this grant, or null. */
export function pageByGrant<Item extends TeamNavItem>(nav: TeamNav<Item>, grant: string): Item | null {
  for (const section of nav) for (const item of section.items) if (accessOf(item) === 'role' && item.grant === grant) return item;
  return null;
}

/** The page an action belongs to, with the action, or null. */
export function actionByKey<Item extends TeamNavItem>(nav: TeamNav<Item>, key: string): { item: Item; action: TeamNavAction } | null {
  for (const section of nav) {
    for (const item of section.items) {
      const action = item.actions?.find((candidate) => candidate.key === key);
      if (action) return { item, action };
    }
  }
  return null;
}

/** True when the person may open the action's page and has the action (Mass Access has every one). */
export function canDoAction(view: TeamView, nav: TeamNav, key: string): boolean {
  const found = actionByKey(nav, key);
  if (!found) return false;
  if (!canOpenPage(view, found.item)) return false;
  return view.massAccess === true || (Array.isArray(view.actions) && view.actions.includes(key));
}

/**
 * The listed page a path belongs to: the page itself; else the nearest
 * listed page above it, when that page says its `subpages` are its own
 * (`/admin/traffic/links/1` is Traffic's). Null for a path no page covers,
 * which opens for Mass Access only.
 *
 * Even a page with subpages only covers the paths below it that no other
 * branch of the nav claims: with Home at `/dashboard` and admin pages under
 * `/dashboard/admin/`, an unlisted `/dashboard/admin/new` is nobody's, never
 * Home's. A page missing from the nav fails closed instead of opening for
 * everyone (Part 3: if it exists, it's listed).
 */
export function pageFor<Item extends TeamNavItem>(nav: TeamNav<Item>, pathname: string): Item | null {
  const path = normalizePath(pathname);
  const segments = path.split('/').filter(Boolean);
  const byHref = new Map<string, Item>();
  // How far down the path's own branch the nav reaches (in segments).
  let reach = 0;
  for (const section of nav) {
    for (const item of section.items) {
      const href = normalizePath(item.href);
      if (!byHref.has(href)) byHref.set(href, item);
      const parts = href.split('/').filter(Boolean);
      let shared = 0;
      while (shared < parts.length && shared < segments.length && parts[shared] === segments[shared]) shared += 1;
      reach = Math.max(reach, shared);
    }
  }
  const exact = byHref.get(path);
  if (exact) return exact;
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const found = byHref.get(depth === 0 ? '/' : `/${segments.slice(0, depth).join('/')}`);
    // The nearest listed page above decides: its subpages are its own, or nobody's.
    // A listed page deeper in this branch than `found` means the branch is someone else's.
    if (found) return found.subpages === true && reach <= depth ? found : null;
  }
  return null;
}

/**
 * The page a reference names: an href (it starts with "/", sub-pages
 * included, see pageFor) or a `role` page's grant. Null when it names none.
 */
export function pageForRef<Item extends TeamNavItem>(nav: TeamNav<Item>, ref: string): Item | null {
  if (typeof ref !== 'string' || !ref) return null;
  return ref.startsWith('/') ? pageFor(nav, ref) : pageByGrant(nav, ref);
}

/**
 * True when the person may open the page a reference names. A reference
 * that names no page opens only for Mass Access when it is an href (an
 * unlisted path), and for no one when it is an unknown grant.
 */
export function canOpenRef(view: TeamView, nav: TeamNav, ref: string): boolean {
  const page = pageForRef(nav, ref);
  if (page) return canOpenPage(view, page);
  return typeof ref === 'string' && ref.startsWith('/') && view.massAccess === true;
}

/** The nav as one person sees it: pages they can't open are left out, and a section with nothing left goes too. */
export function filterNav<Item extends TeamNavItem>(nav: TeamNav<Item>, view: TeamView): Array<TeamNavSection<Item>> {
  return nav
    .map((section) => ({ ...section, items: section.items.filter((item) => canOpenPage(view, item)) }))
    .filter((section) => section.items.length > 0);
}

/** Every grant and action key the nav lists, for an app's own test to snapshot (a page that disappears without being retired fails it). */
export function grantsOf(nav: TeamNav): { pages: string[]; actions: string[] } {
  const pages: string[] = [];
  const actions: string[] = [];
  for (const { item } of allPages(nav)) {
    if (accessOf(item) === 'role' && typeof item.grant === 'string') pages.push(item.grant);
    for (const action of item.actions ?? []) actions.push(action.key);
  }
  return { pages, actions };
}

export const GRANT_PATTERN = /^[a-z][a-z0-9_.-]{0,59}$/;

/**
 * What is wrong with a nav list, in one sentence a developer can act on, or
 * null when nothing is. Every check here is something that would make the
 * Team page or the check say something untrue, or open a page to the wrong
 * people. An app's test should expect null (README, "Test it").
 */
export function navProblem(nav: unknown, options: Readonly<{ teamPage?: string; retiredGrants?: readonly string[] }> = {}): string | null {
  if (!Array.isArray(nav) || nav.length === 0) return "The nav list is empty: give createTeam the app's nav list (sections, each with items).";
  const keys = new Set<string>();
  const labels = new Map<string, number>();
  const hrefs = new Set<string>();
  const retired = new Set(options.retiredGrants ?? []);
  for (const [s, section] of nav.entries()) {
    if (!section || typeof section !== 'object') return `Nav section ${s + 1} is not an object.`;
    const { label, items } = section as { label?: unknown; items?: unknown };
    if (label !== null && (typeof label !== 'string' || !label.trim())) return `Nav section ${s + 1} needs a label (or null for no heading).`;
    const where = typeof label === 'string' ? `"${label}"` : `section ${s + 1}`;
    if (!Array.isArray(items)) return `The nav section ${where} has no items list.`;
    const adminSection = typeof label === 'string' && label.trim().toLowerCase() === 'admin';
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') return `An item in ${where} is not an object.`;
      const item = raw as Partial<TeamNavItem>;
      if (typeof item.label !== 'string' || !item.label.trim()) return `An item in ${where} has no label.`;
      if (typeof item.href !== 'string' || !item.href.startsWith('/')) return `"${item.label}" needs an href that starts with "/".`;
      const href = normalizePath(item.href);
      if (hrefs.has(href)) return `Two pages have the address "${href}".`;
      hrefs.add(href);
      labels.set(item.label.trim(), (labels.get(item.label.trim()) ?? 0) + 1);
      if (item.access === undefined) return `"${item.label}" has no access: say who may open it (${ACCESS_KINDS.join(', ')}).`;
      if (!ACCESS_KINDS.includes(item.access)) return `"${item.label}" has access "${String(item.access)}"; use one of ${ACCESS_KINDS.join(', ')}.`;
      if (item.subpages !== undefined && typeof item.subpages !== 'boolean') return `"${item.label}" has subpages that is not true or false.`;
      if (adminSection && item.access === 'everyone') return `"${item.label}" is in the Admin section but open to everyone: make it "role" or "mass-access".`;
      if (item.access === 'role') {
        if (typeof item.grant !== 'string' || !GRANT_PATTERN.test(item.grant)) {
          return `"${item.label}" is a role page, so it needs a grant: a short name like "email" (lower case letters, digits, dots, dashes or underscores, at most 60), never its address.`;
        }
        if (keys.has(item.grant)) return `The grant "${item.grant}" is used twice: give each page and action its own.`;
        if (retired.has(item.grant)) return `"${item.label}" uses the grant "${item.grant}", which is in retiredGrants: a grant that left the app is never used again.`;
        keys.add(item.grant);
      } else if (item.grant !== undefined) {
        return `"${item.label}" has a grant but is not a role page: only role pages are given by roles.`;
      }
      if (item.actions !== undefined) {
        if (!Array.isArray(item.actions)) return `"${item.label}" has actions that are not a list.`;
        if (item.actions.length > 0 && item.access !== 'role' && item.access !== 'employees') {
          return `"${item.label}" has actions, but a role can only be given actions on a "role" or "employees" page.`;
        }
        for (const action of item.actions as unknown[]) {
          const a = action as Partial<TeamNavAction> | null;
          if (!a || typeof a.key !== 'string' || !GRANT_PATTERN.test(a.key)) {
            return `An action on "${item.label}" needs a key of lower case letters, digits, dots, dashes or underscores (at most 60).`;
          }
          if (typeof a.label !== 'string' || !a.label.trim()) return `The action "${a.key}" on "${item.label}" has no label.`;
          if (keys.has(a.key)) return `The key "${a.key}" is used twice: give each page and action its own.`;
          if (retired.has(a.key)) return `The action "${a.key}" on "${item.label}" is in retiredGrants: a key that left the app is never used again.`;
          keys.add(a.key);
        }
      }
    }
  }
  if (options.teamPage !== undefined) {
    const team = (nav as TeamNav).flatMap((section) => section.items).find((item) => normalizePath(item.href) === normalizePath(options.teamPage!));
    if (!team) return `teamPage "${options.teamPage}" is not the address of a page in the nav: add the Team page to the Admin section.`;
    if (team.access !== 'role' && team.access !== 'mass-access') {
      return `The Team page must be a "role" page (it can be given to managers) or a "mass-access" page, not "${team.access}".`;
    }
    if ((labels.get(team.label.trim()) ?? 0) > 1) return `Another page is also called "${team.label}": the Team page's name must be its own.`;
  }
  return null;
}
