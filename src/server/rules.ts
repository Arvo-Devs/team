// The Team page's rules as plain functions over plain data, so each one is a
// test without a database: what a person may give (their catalog), how a
// role's pages are saved, and whom a manager may take access from (reach).
// The routes call these inside the write's own transaction, after locking the
// rows involved (store.ts), so what they decide is what gets written.
//
// Words used here (design v2, section 6):
//   held(D)     the roles assigned to D
//   catalog(D)  what D may tick: Mass Access, every role page and action the
//               nav lists; anyone else, the role pages they can open now and
//               the actions they can do now
//   reach(D,P)  D may take access from P: P is not D, and every role P holds
//               is one D holds (Mass Access reaches everyone but Mass Access)
import { accessOf, allPages, canDoAction, canOpenPage, type TeamNav, type TeamView } from '../nav';

export type Catalog = Readonly<{ pages: ReadonlySet<string>; actions: ReadonlySet<string> }>;

/** Every role page's grant and every action the nav lists, less the retired ones: all Mass Access may give, and all a role may store. */
export function fullCatalog(nav: TeamNav, retired: ReadonlySet<string> = new Set()): Catalog {
  const pages = new Set<string>();
  const actions = new Set<string>();
  for (const { item } of allPages(nav)) {
    const access = accessOf(item);
    if (access === 'role' && typeof item.grant === 'string' && !retired.has(item.grant)) pages.add(item.grant);
    if (access === 'role' || access === 'employees') {
      for (const action of item.actions ?? []) if (!retired.has(action.key)) actions.add(action.key);
    }
  }
  return { pages, actions };
}

/** What this person may tick in the role editor and give to others. */
export function catalogFor(nav: TeamNav, view: TeamView, retired: ReadonlySet<string> = new Set()): Catalog {
  const all = fullCatalog(nav, retired);
  if (view.massAccess === true) return all;
  const pages = new Set<string>();
  const actions = new Set<string>();
  for (const { item } of allPages(nav)) {
    if (accessOf(item) === 'role' && typeof item.grant === 'string' && all.pages.has(item.grant) && canOpenPage(view, item)) pages.add(item.grant);
  }
  for (const key of all.actions) if (canDoAction(view, nav, key)) actions.add(key);
  return { pages, actions };
}

/** Strings only, each once, in the order given. */
export function cleanList(value: unknown, max = 500): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) return null;
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/** Each listed action's role page: its grant, or null when the action sits on a page that needs no grant. */
function rolePageOfActions(nav: TeamNav): Map<string, string | null> {
  const pageOfAction = new Map<string, string | null>();
  for (const { item } of allPages(nav)) {
    for (const action of item.actions ?? []) {
      pageOfAction.set(action.key, accessOf(item) === 'role' && typeof item.grant === 'string' ? item.grant : null);
    }
  }
  return pageOfAction;
}

/**
 * A new role's pages and actions made whole: each action brings its page
 * (when that page is a role page), and an action whose role page is not in
 * the role goes. Keys the nav does not list are left as they are (another
 * version of the app may know them).
 */
export function withActionPages(nav: TeamNav, pages: readonly string[], actions: readonly string[]): { pages: string[]; actions: string[] } {
  const pageOfAction = rolePageOfActions(nav);
  const outPages = [...pages];
  const have = new Set(outPages);
  for (const key of actions) {
    const page = pageOfAction.get(key);
    if (page && !have.has(page)) {
      have.add(page);
      outPages.push(page);
    }
  }
  const outActions = actions.filter((key) => {
    if (!pageOfAction.has(key)) return true; // not listed here: kept as it is
    const page = pageOfAction.get(key);
    return page === null || have.has(page!);
  });
  return { pages: outPages, actions: outActions };
}

/**
 * An edit's ticks made whole against the pages the role had. An action
 * ticked without its page brings the page when the role didn't have it (the
 * action was ticked fresh), and goes when the role did (the page was
 * unticked, and its actions leave with it). Keys the nav does not list are
 * left as they are.
 */
export function editedTicks(
  nav: TeamNav,
  storedPages: readonly string[],
  pages: readonly string[],
  actions: readonly string[],
): { pages: string[]; actions: string[] } {
  const pageOfAction = rolePageOfActions(nav);
  const had = new Set(storedPages);
  const outPages = [...pages];
  const have = new Set(outPages);
  const outActions: string[] = [];
  for (const key of actions) {
    const page = pageOfAction.get(key);
    if (page && !have.has(page)) {
      if (had.has(page)) continue; // its page was unticked
      have.add(page);
      outPages.push(page);
    }
    outActions.push(key);
  }
  return { pages: outPages, actions: outActions };
}

/**
 * What a save stores: what the editor ticked from what they may give, plus
 * what was stored that they may not give (pages they can't open, and keys
 * this version of the app doesn't list), so a save never takes away what
 * the editor couldn't see.
 */
export function mergeSave(stored: readonly string[], ticked: readonly string[], catalog: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ticked) {
    if (catalog.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const key of stored) {
    if (!catalog.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** The ticked keys that would be new to the role and are not the editor's to give: refused, never dropped quietly. */
export function refusedAdditions(stored: readonly string[], ticked: readonly string[], catalog: ReadonlySet<string>): string[] {
  const had = new Set(stored);
  return ticked.filter((key) => !had.has(key) && !catalog.has(key));
}

/** Keys in `before` that are not in `after`. */
export function removed(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after);
  return before.filter((key) => !kept.has(key));
}

/** Keys in `after` that are not in `before`. */
export function added(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return after.filter((key) => !had.has(key));
}

export type Actor = Readonly<{ id: string; massAccess: boolean; held: ReadonlySet<string> }>;
export type Target = Readonly<{ id: string; massAccess: boolean; roleIds: readonly string[] }>;

/**
 * May the actor take access from the target? Never from themselves through
 * this door, never from Mass Access, and a manager only from someone whose
 * every role is one the manager holds: nobody takes pages from someone who
 * has more than they do.
 */
export function reaches(actor: Actor, target: Target): boolean {
  if (target.id === actor.id) return false;
  if (target.massAccess) return false;
  if (actor.massAccess) return true;
  return target.roleIds.every((roleId) => actor.held.has(roleId));
}

/**
 * Taking pages off a role (or deleting it) touches everyone who holds it.
 * The actor may do it when every other holder is within reach. Holders with
 * Mass Access lose nothing (they open every page anyway), so they never
 * stop it.
 */
export function reachesHolders(actor: Actor, holders: readonly Target[]): boolean {
  if (actor.massAccess) return true;
  return holders.every((holder) => holder.id === actor.id || holder.massAccess || reaches(actor, holder));
}

/** The labels of grants and action keys in nav order, for "Opens Email, Traffic". Keys the nav doesn't list are left out. */
export function labelsInNavOrder(nav: TeamNav, keys: readonly string[]): string[] {
  const want = new Set(keys);
  const out: string[] = [];
  for (const { item } of allPages(nav)) {
    if (accessOf(item) === 'role' && typeof item.grant === 'string' && want.has(item.grant)) out.push(item.label);
  }
  return out;
}

/** Grants and action keys sorted into nav order; keys the nav doesn't list go last, as given. */
export function inNavOrder(nav: TeamNav, keys: readonly string[]): string[] {
  const order = new Map<string, number>();
  let n = 0;
  for (const { item } of allPages(nav)) {
    if (typeof item.grant === 'string') order.set(item.grant, n++);
    for (const action of item.actions ?? []) order.set(action.key, n++);
  }
  return [...keys].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
}
