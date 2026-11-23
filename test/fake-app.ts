// A pretend app for the tests: an internal tool with a Home page for anyone
// signed in, an Overview for every employee, and an Admin section with
// Email, Traffic, Sign-up funnel, the Team page and Log in as. Its sign-in
// reads a `session=<id>` cookie (a `viewas=1` cookie marks a view-as
// session), Mass Access is a set of account ids, and its accounts are an
// in-memory list the test fills.
import type { TeamAccount, TeamConfig, TeamCreateAccount, TeamUser } from '../src/config';
import type { TeamNav } from '../src/nav';

export const SITE = 'https://example.com';
export const SITE_HOSTS = ['example.com'];
export const TEAM_PAGE = '/dashboard/admin/team';

export const NAV: TeamNav = [
  {
    label: null,
    items: [
      { label: 'Home', href: '/dashboard', access: 'everyone' },
      { label: 'Overview', href: '/dashboard/overview', access: 'employees', description: 'How the business is doing.' },
    ],
  },
  {
    label: 'Admin',
    items: [
      {
        label: 'Email',
        href: '/dashboard/admin/email',
        access: 'role',
        grant: 'email',
        description: 'Read and answer the emails customers send to support.',
        actions: [{ key: 'email.settings', label: 'Change the email settings' }],
      },
      {
        label: 'Traffic',
        href: '/dashboard/admin/traffic',
        access: 'role',
        grant: 'traffic',
        description: 'Visits to the site and where they came from. Includes making tracking links.',
        subpages: true,
      },
      { label: 'Sign-up funnel', href: '/dashboard/admin/signup-funnel', access: 'role', grant: 'signup-funnel' },
      { label: 'Payouts', href: '/dashboard/admin/payouts', access: 'role', grant: 'payouts' },
      { label: 'Team', href: TEAM_PAGE, access: 'role', grant: 'team' },
      { label: 'Log in as', href: '/dashboard/admin/log-in-as', access: 'mass-access' },
    ],
  },
];

export type Person = TeamUser & { id: string };

export type FakeWorld = {
  accounts: Map<string, TeamAccount & { id: string }>;
  massAccess: Set<string>;
  signedOut: string[];
  made: string[];
  logs: string[];
};

export function world(): FakeWorld {
  const accounts = new Map<string, TeamAccount & { id: string }>();
  const add = (id: string, name: string, email: string, emailVerified = true) => accounts.set(id, { id, name, email, emailVerified, lastSeenAt: '2026-11-10T10:00:00.000Z' });
  add('olive', 'Olive Owner', 'olive@example.com');
  add('maya', 'Maya Manager', 'maya@example.com');
  add('sam', 'Sam Support', 'sam@example.com');
  add('bob', 'Bob Books', 'bob@example.com');
  add('cara', 'Cara Customer', 'cara@example.com');
  add('una', 'Una Unconfirmed', 'una@example.com', false);
  return { accounts, massAccess: new Set(['olive']), signedOut: [], made: [], logs: [] };
}

export function cookieFor(id: string, viewAs = false) {
  return `theme=dark; session=${id}${viewAs ? '; viewas=1' : ''}`;
}

type RequestOptions = Readonly<{
  method?: string;
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  contentType?: string | null;
  fetchSite?: string;
}>;

/** A request to the site as a browser on one of its pages would send it. */
export function request(path: string, options: RequestOptions = {}): Request {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  if (options.cookie) headers.set('cookie', options.cookie);
  if (method !== 'GET') {
    if (options.origin !== null) headers.set('origin', options.origin ?? SITE);
    if (options.fetchSite) headers.set('sec-fetch-site', options.fetchSite);
    // The page sends every change as JSON, a DELETE with no body too.
    if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json');
  }
  return new Request(`${SITE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
}

/** The fake app's config. `db` answers null (no database) unless the test gives one. */
export function fakeConfig(w: FakeWorld, overrides: Partial<TeamConfig<Person>> = {}): TeamConfig<Person> {
  const createAccount: TeamCreateAccount = async ({ email, name }) => {
    const existing = [...w.accounts.values()].find((a) => a.email === email);
    if (existing) return { id: existing.id, created: false };
    const id = `new-${w.accounts.size + 1}`;
    w.accounts.set(id, { id, name, email, emailVerified: false, lastSeenAt: null });
    w.made.push(id);
    return { id, created: true };
  };
  return {
    db: () => null,
    signedInUser: async (req) => {
      const cookie = req.headers.get('cookie') ?? '';
      const id = /(?:^|;\s*)session=([a-z0-9-]+)/.exec(cookie)?.[1];
      if (!id) return null;
      const account = w.accounts.get(id);
      if (!account) return null;
      return { id, email: account.email, name: account.name, emailVerified: account.emailVerified, viewedAs: /(?:^|;\s*)viewas=1/.test(cookie) };
    },
    hasMassAccess: (id) => w.massAccess.has(id),
    nav: NAV,
    teamPage: TEAM_PAGE,
    siteHosts: SITE_HOSTS,
    accounts: {
      byIds: async (ids) => ids.flatMap((id) => (w.accounts.has(id) ? [w.accounts.get(id)!] : [])),
      byEmail: async (email) => [...w.accounts.values()].find((a) => a.email === email) ?? null,
      massAccess: async () => [...w.massAccess].flatMap((id) => (w.accounts.has(id) ? [w.accounts.get(id)!] : [])),
    },
    signOutEverywhere: async (id) => {
      w.signedOut.push(id);
    },
    createAccount,
    log: (line) => w.logs.push(line),
    ...overrides,
  };
}
