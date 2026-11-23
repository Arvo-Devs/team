// The Team page's sentences that depend on a number or a list, in one place,
// so they read the same wherever they appear and match the copy deck
// (design §10) word for word. Plain functions: no React, no fetching.
import { opensLine, type CatalogSection, type RoleView, type TeamState } from '../shared/api';

/** "Nobody yet", "1 person", "3 people". */
export function peopleWord(count: number): string {
  if (count <= 0) return 'Nobody yet';
  return count === 1 ? '1 person' : `${count} people`;
}

/** "1 role", "2 roles". */
export function rolesWord(count: number): string {
  return count === 1 ? '1 role' : `${count} roles`;
}

/** The names of the pages a role opens, in nav order; a grant the app no longer lists is left out. */
export function roleLabels(role: Pick<RoleView, 'pages'>, labels: Readonly<Record<string, string>>): string[] {
  return role.pages.flatMap((grant) => (typeof labels[grant] === 'string' ? [labels[grant]] : []));
}

/** "Email, Traffic, Sign-up funnel and 3 more", or "" for a role that opens nothing the app lists. */
export function roleOpens(role: Pick<RoleView, 'pages'>, labels: Readonly<Record<string, string>>): string {
  return opensLine(roleLabels(role, labels));
}

/** Where each page sits in the nav: a role page by its grant, an every-employee page by its name. */
export function navOrder(catalog: readonly CatalogSection[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const section of catalog) {
    for (const page of section.pages) {
      const key = page.grant ? `grant:${page.grant}` : `label:${page.label}`;
      if (!order.has(key)) order.set(key, order.size);
    }
  }
  return order;
}

/**
 * What someone with these roles opens: the pages every employee gets and
 * each chosen role's pages, once each, in nav order.
 */
export function opensWith(state: Pick<TeamState, 'roles' | 'labels' | 'everyEmployee' | 'catalog'>, roleIds: readonly string[]): string[] {
  const order = navOrder(state.catalog);
  const found: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (key: string, label: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ key, label });
  };
  for (const label of state.everyEmployee) add(`label:${label}`, label);
  const chosen = new Set(roleIds);
  for (const role of state.roles) {
    if (!chosen.has(role.id)) continue;
    for (const grant of role.pages) if (typeof state.labels[grant] === 'string') add(`grant:${grant}`, state.labels[grant]);
  }
  // A page the catalog doesn't list (there should be none) keeps its place after the ones it does.
  const at = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return found
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => at(a.key) - at(b.key) || a.index - b.index)
    .map((entry) => entry.label);
}

/**
 * The live line under the roles: Add employee's "They'll open: …" and
 * Manage's "Can open: …". `roles` counts every role they would have,
 * hidden ones included.
 */
export function opensSentence(start: "They'll open" | 'Can open', opens: readonly string[], roles: number, everyEmployee: readonly string[]): string {
  if (roles === 0) {
    return everyEmployee.length > 0
      ? `With no role, they'll open only what every employee gets: ${everyEmployee.join(', ')}.`
      : "With no role, they can't open any page yet.";
  }
  return opens.length > 0 ? `${start}: ${opens.join(', ')}.` : "Their roles don't open any page yet.";
}

/** Add employee, done, for an account that was already there. */
export function joinedLine(email: string, opens: readonly string[]): string {
  return opens.length > 0
    ? `${email} can open: ${opens.join(', ')}. They'll need to sign in again to see them.`
    : `${email} is on the team. With no role, they can't open any page yet.`;
}

/** Add employee, done, when the app made their login (and whether the email with their link went out). */
export function madeLine(opens: readonly string[], emailed: boolean | null = true): string {
  const start =
    emailed === false
      ? "They're on the team, but the email with their link didn't go out. They can set a password with Forgot password on the sign-in page."
      : "They're on the team. They can sign in once they set their password from the email.";
  return opens.length > 0 ? `${start} They'll open: ${opens.join(', ')}.` : start;
}

/** Manage, for someone looking who doesn't manage all of the person's roles. */
export function hiddenRolesLine(name: string, hidden: number): string {
  return `${name} also has ${rolesWord(hidden)} you don't manage. They stay as they are.`;
}

/** Manage's line under the name: "jordan@company.com · Added Sep 12 by Ana Lee". */
export function addedLine(email: string | null, addedOn: string, addedBy: string | null): string {
  const added = `Added ${addedOn}${addedBy ? ` by ${addedBy}` : ''}`;
  return email ? `${email} · ${added}` : added;
}

/** Delete role's consequence: who has it, and what they lose. */
export function deleteRoleLine(people: number): string {
  if (people <= 0) return 'Nobody has this role yet.';
  return `${people === 1 ? '1 person has' : `${people} people have`} it. They lose its pages unless another of their roles opens them.`;
}

/** What the search box matches: someone's name, email and the role names shown for them, lower case. */
export function matches(query: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

/** The text looks like a whole email address: something, @, something with a dot. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}
