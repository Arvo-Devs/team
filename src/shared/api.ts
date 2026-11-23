// The JSON the Team routes send and take: the contract between the server
// (src/server/routes.ts) and the page (src/client/*). Plain types and a few
// pure helpers; no Node, no React.
//
// Every answer that refuses is the error body the other imports use:
// { error: { type, code, message, hint?, param? }, requestId }. `message` is
// already in the copy deck's plain words, so the page shows it as it is.

import type { TeamView } from '../nav';

export type { TeamView };

/** One page in the role editor's checklist, in nav order. */
export type CatalogPage = Readonly<{
  /** The grant a role stores; null for an `employees` page (every employee has it, drawn locked). */
  grant: string | null;
  label: string;
  /** The nav item's one line, or null. */
  description: string | null;
  /** True for an `employees` page: a lock, its name, "Included for every employee". */
  locked: boolean;
  /** True for the Team page itself: its row says what managing the team means. */
  teamPage: boolean;
  /** The actions inside the page this viewer may give, in nav order. */
  actions: ReadonlyArray<Readonly<{ key: string; label: string; description: string | null }>>;
}>;

/** A nav section in the role editor. A null label is a section with no heading. */
export type CatalogSection = Readonly<{ label: string | null; pages: readonly CatalogPage[] }>;

/** A role as one viewer may see it. */
export type RoleView = Readonly<{
  id: string;
  name: string;
  /** The grants it stores, in nav order (keys this version of the app doesn't list are left out). */
  pages: readonly string[];
  /** The action keys it stores, in nav order. */
  actions: readonly string[];
  /** Sent back with a change or a delete; a mismatch is a 409. */
  version: number;
  /** How many employees hold it (all of them, whoever looks). */
  people: number;
  /** True when the viewer holds it. */
  mine: boolean;
  /** ISO 8601. */
  updatedAt: string;
}>;

/** An employee as one viewer may see them. */
export type EmployeeView = Readonly<{
  id: string;
  /** The account's name, else its email, else "Deleted account". */
  name: string;
  /** Null when the account is gone. */
  email: string | null;
  image: string | null;
  /** The roles of theirs the viewer may see (Mass Access: all), ids in name order. */
  roleIds: readonly string[];
  /** How many of their roles the viewer can't see ("+2 more"). */
  hiddenRoles: number;
  /** Sent back with a change or a removal; a mismatch is a 409. */
  token: string;
  /** ISO 8601. */
  addedAt: string;
  /** Who added them, by current name ("The app" for an app's own flow). Null when not known. */
  addedBy: string | null;
  /** ISO 8601, or null for never; only Mass Access viewers get it (absent otherwise). */
  lastSeenAt?: string | null;
  /** True for the viewer's own row: no Manage. */
  you: boolean;
  /** True when the viewer may change their roles. */
  canManage: boolean;
  /** True when the viewer may remove them. */
  canRemove: boolean;
  /** True when the app no longer has the account. */
  accountGone: boolean;
}>;

/** A Mass Access account, listed at the top for Mass Access viewers only. */
export type MassAccessView = Readonly<{
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  lastSeenAt: string | null;
  you: boolean;
}>;

/** GET {basePath}: everything the Team page shows to this viewer. */
export type TeamState = Readonly<{
  /** The page's title (the Team page's nav label) and its one line. */
  title: string;
  description: string;
  viewer: Readonly<{
    id: string;
    massAccess: boolean;
    /** The ids of the roles the viewer holds. */
    roleIds: readonly string[];
  }>;
  /** True when the app can make a login for someone with no account (Add employee asks for a full name). */
  canMakeAccounts: boolean;
  /** The app's sign-up page, to copy for someone with no account; null when the app can make logins or has none. */
  signUpUrl: string | null;
  /** The role editor's checklist: what this viewer may tick, plus the locked every-employee pages. */
  catalog: readonly CatalogSection[];
  /** Labels for every grant and action key the nav lists (to say "Opens Email, Traffic"). */
  labels: Readonly<Record<string, string>>;
  /** The labels of the pages every employee opens without a role, in nav order. */
  everyEmployee: readonly string[];
  /** The roles this viewer may see (Mass Access: all; anyone else: the ones they hold), by name. */
  roles: readonly RoleView[];
  /** Every employee, by name. */
  employees: readonly EmployeeView[];
  /** Mass Access viewers only; null for anyone else. */
  massAccess: readonly MassAccessView[] | null;
  /** Mass Access viewers only: the labels of role pages no role opens yet. Null for anyone else. */
  unassigned: readonly string[] | null;
  /** Mass Access viewers only: one plain line when the app's setup has a mistake. */
  problem: string | null;
}>;

/** POST {basePath}/employees */
export type AddEmployeeBody = Readonly<{ email: string; name?: string; roleIds: readonly string[] }>;

/** What Add employee did. */
export type AddResult = Readonly<{
  /** `joined`: an account that already existed is on the team now; `account_made`: the app made a login and emailed them. */
  outcome: 'joined' | 'account_made';
  employee: EmployeeView;
  /** The labels of the pages they open now, in nav order. */
  opens: readonly string[];
  /** For `account_made`: false when the app said the email with their link didn't go out. Null for `joined`. */
  emailed: boolean | null;
}>;

/** PATCH {basePath}/employees/<id> */
export type ManageEmployeeBody = Readonly<{ roleIds: readonly string[]; token: string }>;

/** POST {basePath}/roles (the id is made by the page, so a double click makes one role) */
export type NewRoleBody = Readonly<{ id: string; name: string; pages: readonly string[]; actions: readonly string[] }>;

/** PATCH {basePath}/roles/<id> */
export type EditRoleBody = Readonly<{ name: string; pages: readonly string[]; actions: readonly string[]; version: number }>;

/** One change, as a sentence (names read now). */
export type HistoryRow = Readonly<{ id: string; at: string; text: string }>;

/** GET {basePath}/history?before=<id>: 50 at a time, newest first. Mass Access only. */
export type HistoryPage = Readonly<{ rows: readonly HistoryRow[]; more: boolean }>;

/** The error codes the routes send, for the page to tell cases apart. The message is what to show. */
export type TeamErrorCode =
  | 'route_not_found'
  | 'not_signed_in'
  | 'invalid_parameter'
  | 'invalid_json'
  | 'body_too_large'
  | 'cross_site'
  | 'not_json'
  | 'not_set_up'
  | 'internal_error'
  | 'invalid_email'
  | 'name_required'
  | 'already_employee'
  | 'has_mass_access'
  | 'self'
  | 'email_not_confirmed'
  | 'no_account'
  | 'not_yours'
  | 'out_of_reach'
  | 'stale'
  | 'role_gone'
  | 'employee_gone'
  | 'name_taken'
  | 'no_pages';

/** How many page names a list shows before "and N more". */
export const OPENS_SHOWN = 4;

/** "Email, Traffic, Sign-up funnel and 3 more": labels in order, the first four, then how many more. */
export function opensLine(labels: readonly string[], shown = OPENS_SHOWN): string {
  if (labels.length <= shown) return labels.join(', ');
  return `${labels.slice(0, shown).join(', ')} and ${labels.length - shown} more`;
}

/** A uuid v4 for a new role, made in the browser (crypto.randomUUID where there is one). */
export function newRoleId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
