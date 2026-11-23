/**
 * The nav list and THE rule (canOpenPage): who may open which page, how a
 * sub-page finds its page, references by grant or address, the nav as one
 * person sees it, and what navProblem refuses. No database: these are plain
 * functions the server and the app's nav share.
 */
import { describe, expect, test } from 'bun:test';
import {
  accessOf,
  canDoAction,
  canOpenPage,
  canOpenRef,
  filterNav,
  grantsOf,
  navProblem,
  NOBODY,
  normalizePath,
  pageFor,
  pageForRef,
  type TeamNav,
  type TeamNavItem,
  type TeamView,
} from '../src/nav';

const NAV: TeamNav = [
  {
    label: null,
    items: [
      { label: 'Home', href: '/dashboard', access: 'everyone' },
      { label: 'Overview', href: '/dashboard/overview', access: 'employees' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Email', href: '/dashboard/admin/email', access: 'role', grant: 'email' },
      {
        label: 'Traffic',
        href: '/dashboard/admin/traffic',
        access: 'role',
        grant: 'traffic',
        subpages: true,
        actions: [{ key: 'traffic.links', label: 'Make tracking links' }],
      },
      { label: 'Team', href: '/dashboard/admin/team', access: 'role', grant: 'team' },
      { label: 'Log in as', href: '/dashboard/admin/log-in-as', access: 'mass-access' },
    ],
  },
];

const view = (over: Partial<TeamView> = {}): TeamView => ({ ...NOBODY, ...over });
const item = (href: string) => NAV.flatMap((s) => s.items).find((i) => i.href === href)!;

describe('canOpenPage', () => {
  test('anyone signed in opens an everyone page, and only that', () => {
    expect(canOpenPage(NOBODY, item('/dashboard'))).toBe(true);
    expect(canOpenPage(NOBODY, item('/dashboard/overview'))).toBe(false);
    expect(canOpenPage(NOBODY, item('/dashboard/admin/email'))).toBe(false);
    expect(canOpenPage(NOBODY, item('/dashboard/admin/log-in-as'))).toBe(false);
  });

  test('an employee opens employees pages and the role pages their roles give', () => {
    const sam = view({ employee: true, pages: ['email'] });
    expect(canOpenPage(sam, item('/dashboard/overview'))).toBe(true);
    expect(canOpenPage(sam, item('/dashboard/admin/email'))).toBe(true);
    expect(canOpenPage(sam, item('/dashboard/admin/traffic'))).toBe(false);
    expect(canOpenPage(sam, item('/dashboard/admin/log-in-as'))).toBe(false);
  });

  test('without the person on the team, grants give nothing', () => {
    const removed = view({ employee: false, pages: ['email'] });
    expect(canOpenPage(removed, item('/dashboard/admin/email'))).toBe(false);
    expect(canOpenPage(removed, item('/dashboard/overview'))).toBe(false);
  });

  test('a role can never give a Mass Access page', () => {
    expect(canOpenPage(view({ employee: true, pages: ['log-in-as', '/dashboard/admin/log-in-as'] }), item('/dashboard/admin/log-in-as'))).toBe(false);
  });

  test('Mass Access opens every page', () => {
    const owner = view({ massAccess: true });
    for (const section of NAV) for (const page of section.items) expect(canOpenPage(owner, page)).toBe(true);
  });

  test('only an exact true counts', () => {
    const odd = { massAccess: 'yes', employee: 1, pages: 'email', actions: [] } as unknown as TeamView;
    expect(canOpenPage(odd, item('/dashboard/admin/email'))).toBe(false);
    expect(canOpenPage(odd, item('/dashboard/overview'))).toBe(false);
  });

  test('a missing or unknown access is closed: it counts as a role page with no grant', () => {
    const forgot = { label: 'Payouts', href: '/dashboard/admin/payouts' } as unknown as TeamNavItem;
    const typo = { label: 'Payouts', href: '/dashboard/admin/payouts', access: 'evryone' } as unknown as TeamNavItem;
    expect(accessOf(forgot)).toBe('role');
    expect(canOpenPage(NOBODY, forgot)).toBe(false);
    expect(canOpenPage(view({ employee: true, pages: ['email'] }), typo)).toBe(false);
    expect(canOpenPage(view({ massAccess: true }), forgot)).toBe(true);
  });

  test('a grant is matched whole, never as part of a longer one', () => {
    const templates = { label: 'T', href: '/t', access: 'role', grant: 'email' } as const;
    expect(canOpenPage(view({ employee: true, pages: ['email-templates'] }), templates)).toBe(false);
  });
});

describe('canDoAction', () => {
  test('needs the action and its page', () => {
    expect(canDoAction(view({ employee: true, pages: ['traffic'], actions: ['traffic.links'] }), NAV, 'traffic.links')).toBe(true);
    expect(canDoAction(view({ employee: true, pages: ['traffic'] }), NAV, 'traffic.links')).toBe(false);
    expect(canDoAction(view({ employee: true, actions: ['traffic.links'] }), NAV, 'traffic.links')).toBe(false);
  });

  test('Mass Access does every action; nobody does an unknown one', () => {
    expect(canDoAction(view({ massAccess: true }), NAV, 'traffic.links')).toBe(true);
    expect(canDoAction(view({ massAccess: true }), NAV, 'traffic.delete')).toBe(false);
  });
});

describe('pageFor and references', () => {
  test('a sub-page belongs to the nearest listed page above it, when that page says its subpages are its own', () => {
    expect(pageFor(NAV, '/dashboard/admin/traffic/links/42')?.label).toBe('Traffic');
    expect(pageFor(NAV, '/dashboard/admin/traffic/')?.label).toBe('Traffic');
    expect(pageFor(NAV, '/dashboard/admin/traffic?range=7d')?.label).toBe('Traffic');
    expect(pageFor(NAV, '/dashboard/admin/email/thread/9')).toBeNull();
    expect(pageFor(NAV, '/dashboard/anything')).toBeNull();
    expect(pageFor(NAV, '/elsewhere')).toBeNull();
  });

  test("an unlisted page in a branch the nav lists deeper is nobody's, never Home's", () => {
    expect(pageFor(NAV, '/dashboard/admin/unknown')).toBeNull();
    expect(pageFor(NAV, '/dashboard/admin')).toBeNull();
    const rooted: TeamNav = [
      { label: 'A', items: [{ label: 'Home', href: '/', access: 'everyone', subpages: true }, { label: 'X', href: '/admin/x', access: 'role', grant: 'x', subpages: true }] },
    ];
    expect(pageFor(rooted, '/about')?.label).toBe('Home');
    expect(pageFor(rooted, '/admin/y')).toBeNull();
    expect(pageFor(rooted, '/admin/x/1')?.label).toBe('X');
  });

  test('a reference is a grant or an address', () => {
    expect(pageForRef(NAV, 'email')?.label).toBe('Email');
    expect(pageForRef(NAV, '/dashboard/admin/traffic/links/9')?.label).toBe('Traffic');
    expect(pageForRef(NAV, '/dashboard/admin/email')?.label).toBe('Email');
    expect(pageForRef(NAV, 'nope')).toBeNull();
    expect(pageForRef(NAV, '')).toBeNull();
  });

  test('canOpenRef: an unknown grant opens for no one; an unlisted address only for Mass Access', () => {
    const sam = view({ employee: true, pages: ['email'] });
    expect(canOpenRef(sam, NAV, 'email')).toBe(true);
    expect(canOpenRef(sam, NAV, '/dashboard/admin/email')).toBe(true);
    expect(canOpenRef(sam, NAV, 'traffic')).toBe(false);
    expect(canOpenRef(view({ massAccess: true }), NAV, 'nope')).toBe(false);
    expect(canOpenRef(view({ massAccess: true }), NAV, '/dashboard/admin/unknown')).toBe(true);
    expect(canOpenRef(sam, NAV, '/dashboard/admin/unknown')).toBe(false);
  });

  test('normalizePath keeps the root and drops trailing slashes, queries and hashes', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('/a//')).toBe('/a');
    expect(normalizePath('/a?x=1#y')).toBe('/a');
  });
});

describe('filterNav and grantsOf', () => {
  test('leaves out what someone cannot open, and an emptied section', () => {
    expect(filterNav(NAV, NOBODY).map((s) => s.label)).toEqual([null]);
    expect(filterNav(NAV, NOBODY)[0]!.items.map((i) => i.label)).toEqual(['Home']);
    const sam = filterNav(NAV, view({ employee: true, pages: ['email'] }));
    expect(sam.map((s) => s.items.map((i) => i.label))).toEqual([['Home', 'Overview'], ['Email']]);
  });

  test("passes the app's own fields through", () => {
    const withIcons = [{ label: 'Main', items: [{ label: 'Home', href: '/', access: 'everyone' as const, icon: 'house' }] }];
    expect(filterNav(withIcons, NOBODY)[0]!.items[0]!.icon).toBe('house');
  });

  test('grantsOf lists every grant and action', () => {
    expect(grantsOf(NAV)).toEqual({ pages: ['email', 'traffic', 'team'], actions: ['traffic.links'] });
  });
});

describe('navProblem', () => {
  test('a good list has none', () => {
    expect(navProblem(NAV, { teamPage: '/dashboard/admin/team' })).toBeNull();
  });

  const one = (items: unknown[], label: string | null = 'A') => [{ label, items }];

  test('says what is wrong, in a sentence', () => {
    expect(navProblem([])).toContain('empty');
    expect(navProblem(one([{ label: 'X', href: 'x', access: 'everyone' }]))).toContain('starts with "/"');
    expect(navProblem(one([{ label: 'X', href: '/x' }]))).toContain('has no access');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'admin' }]))).toContain('access "admin"');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'role' }]))).toContain('needs a grant');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'role', grant: '/x' }]))).toContain('needs a grant');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'everyone', grant: 'x' }]))).toContain('not a role page');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'everyone' }, { label: 'Y', href: '/x/', access: 'everyone' }]))).toContain('Two pages have the address');
    expect(
      navProblem(one([{ label: 'X', href: '/x', access: 'role', grant: 'x' }, { label: 'Y', href: '/y', access: 'role', grant: 'x' }])),
    ).toContain('used twice');
    expect(
      navProblem(one([{ label: 'X', href: '/x', access: 'everyone', actions: [{ key: 'x.do', label: 'Do' }] }])),
    ).toContain('only be given actions');
    expect(
      navProblem(one([{ label: 'X', href: '/x', access: 'role', grant: 'x', actions: [{ key: 'x', label: 'Do' }] }])),
    ).toContain('used twice');
    expect(navProblem(one([{ label: 'Pay', href: '/a/pay', access: 'everyone' }], 'Admin'))).toContain('Admin section but open to everyone');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'role', grant: 'old' }]), { retiredGrants: ['old'] })).toContain('retiredGrants');
    expect(navProblem(one([{ label: 'X', href: '/x', access: 'everyone' }], ''))).toContain('needs a label');
    expect(navProblem(NAV, { teamPage: '/dashboard/admin/nope' })).toContain('not the address of a page');
    expect(navProblem(NAV, { teamPage: '/dashboard' })).toContain('must be a "role" page');
    expect(
      navProblem([...NAV, { label: 'More', items: [{ label: 'Team', href: '/dashboard/team', access: 'everyone' }] }], { teamPage: '/dashboard/admin/team' }),
    ).toContain('also called "Team"');
  });
});
