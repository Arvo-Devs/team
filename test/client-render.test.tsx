/**
 * The Team page renders each of its states without throwing, with the copy
 * deck's words (design §10): a Mass Access viewer's page and a manager's,
 * both empty states, the Roles and History tabs, the role editor's
 * checklist, loading, and failures that never show a request id or an error
 * code. Rendered to a string with react-dom/server, with the routes' answers
 * seeded into react-query's cache under the page's own keys. Dialogs open in
 * a portal, which a string render leaves out, so their fields are drawn
 * alone; the sentences they build are checked as plain functions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { TeamPage, TeamPageGate, TeamPageSkeleton } from '../src/client';
import { historyKey, stateKey, teamRoutes, viewKey } from '../src/client/api';
import { TEAM_CLIENT_BASE_PATH } from '../src/client/context';
import { EVERY_EMPLOYEE_LINE, PagesChecklist, RoleEditorFields, TEAM_PAGE_LINE } from '../src/client/role-editor';
import { deleteRoleLine, hiddenRolesLine, joinedLine, madeLine, opensSentence, opensWith, peopleWord, roleOpens } from '../src/client/words';
import { TEAM_BASE_PATH } from '../src/config';
import type { TeamNav, TeamView } from '../src/nav';
import { UUID, type CatalogSection, type EmployeeView, type HistoryPage, type RoleView, type TeamState } from '../src/shared/api';
import { ERROR_WORDS, InlineError, TeamError } from '../src/ui/ui-deps';

const BASE = '/api/team';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// ------------------------------------------------------------ the routes' answers

const CATALOG: CatalogSection[] = [
  {
    label: null,
    pages: [{ grant: null, label: 'Overview', description: 'How the business is doing.', locked: true, teamPage: false, actions: [] }],
  },
  {
    label: 'Admin',
    pages: [
      {
        grant: 'email',
        label: 'Email',
        description: 'Read and answer the emails customers send to support.',
        locked: false,
        teamPage: false,
        actions: [{ key: 'email.settings', label: 'Change the email settings', description: null }],
      },
      {
        grant: 'traffic',
        label: 'Traffic',
        description: 'Visits to the site and where they came from.',
        locked: false,
        teamPage: false,
        actions: [{ key: 'traffic.links', label: 'Make tracking links', description: 'Tagged links for posts.' }],
      },
      { grant: 'signup-funnel', label: 'Sign-up funnel', description: null, locked: false, teamPage: false, actions: [] },
      { grant: 'billing', label: 'Billing', description: null, locked: false, teamPage: false, actions: [] },
      { grant: 'reports', label: 'Reports', description: null, locked: false, teamPage: false, actions: [] },
      { grant: 'team', label: 'Team', description: 'Who works here.', locked: false, teamPage: true, actions: [] },
    ],
  },
];

const LABELS: Record<string, string> = {
  email: 'Email',
  'email.settings': 'Change the email settings',
  traffic: 'Traffic',
  'traffic.links': 'Make tracking links',
  'signup-funnel': 'Sign-up funnel',
  billing: 'Billing',
  reports: 'Reports',
  team: 'Team',
};

const role = (over: Partial<RoleView> & Pick<RoleView, 'id' | 'name' | 'pages'>): RoleView => ({
  actions: [],
  version: 1,
  people: 0,
  mine: false,
  updatedAt: daysAgo(3),
  ...over,
});

const MARKETING = role({ id: '11111111-1111-4111-8111-111111111111', name: 'Marketing', pages: ['email', 'traffic', 'signup-funnel', 'billing', 'reports', 'team'], people: 3 });
const SUPPORT = role({ id: '22222222-2222-4222-8222-222222222222', name: 'Support', pages: ['email'], actions: ['email.settings'], people: 1 });
const ANALYST = role({ id: '33333333-3333-4333-8333-333333333333', name: 'Analyst', pages: ['reports'], people: 0 });

const employee = (over: Partial<EmployeeView> & Pick<EmployeeView, 'id' | 'name'>): EmployeeView => ({
  email: `${over.name.toLowerCase().replace(/\s+/g, '.')}@company.test`,
  image: null,
  roleIds: [],
  hiddenRoles: 0,
  token: 'tok',
  addedAt: daysAgo(10),
  addedBy: 'Morgan Diaz',
  you: false,
  canManage: true,
  canRemove: true,
  accountGone: false,
  ...over,
});

/** What a Mass Access viewer gets: every role, every employee with when they were last seen, the Mass Access accounts, and History. */
function massAccessState(over: Partial<TeamState> = {}): TeamState {
  return {
    title: 'Team',
    description: 'Add the people who work here, and choose which pages each role opens.',
    viewer: { id: 'ma-1', massAccess: true, roleIds: [] },
    canMakeAccounts: true,
    signUpUrl: null,
    catalog: CATALOG,
    labels: LABELS,
    everyEmployee: ['Overview'],
    roles: [ANALYST, MARKETING, SUPPORT],
    employees: [
      employee({ id: 'e-jordan', name: 'Jordan Lee', roleIds: [MARKETING.id, SUPPORT.id], lastSeenAt: daysAgo(2) }),
      employee({ id: 'e-sam', name: 'Sam Rivera', roleIds: [SUPPORT.id], lastSeenAt: null }),
    ],
    massAccess: [{ id: 'ma-1', name: 'Morgan Diaz', email: 'morgan@company.test', image: null, lastSeenAt: daysAgo(0.01), you: true }],
    unassigned: ['Billing'],
    problem: null,
    ...over,
  };
}

/** What a manager gets: the roles they hold, "+N more" for the rest, no Mass Access rows, no last seen, no History. */
function managerState(over: Partial<TeamState> = {}): TeamState {
  const marketing = { ...MARKETING, mine: true };
  return {
    ...massAccessState(),
    viewer: { id: 'e-riley', massAccess: false, roleIds: [marketing.id] },
    catalog: CATALOG,
    roles: [marketing],
    employees: [
      employee({ id: 'e-jordan', name: 'Jordan Lee', roleIds: [marketing.id], hiddenRoles: 1 }),
      employee({ id: 'e-riley', name: 'Riley Chen', roleIds: [marketing.id], you: true, canManage: false, canRemove: false }),
      employee({ id: 'e-sam', name: 'Sam Rivera', roleIds: [], hiddenRoles: 1, canRemove: false }),
    ],
    massAccess: null,
    unassigned: null,
    problem: null,
    ...over,
  };
}

// ------------------------------------------------------------ rendering

// Without retryOnMount: false, a query that failed with nothing cached shows as loading again on its next render.
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
const clean = (html: string) => html.replaceAll('<!-- -->', '');
/** The text of the page, tags out, so a sentence split over elements reads whole. */
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function draw(node: ReactNode, qc: QueryClient, search = ''): string {
  return clean(
    renderToString(
      <SearchParamsContext value={new URLSearchParams(search)}>
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </SearchParamsContext>,
    ),
  );
}

function page(state: TeamState | null, search = '', props: Parameters<typeof TeamPage>[0] = {}): string {
  const qc = client();
  if (state) qc.setQueryData(stateKey(BASE), state);
  return draw(<TeamPage {...props} />, qc, search);
}

/** The Employees table (wide screens) and the stacked blocks (under 640px). */
function parts(html: string, label: string) {
  const tableAt = html.indexOf(`aria-label="${label}"><thead`);
  const table = tableAt < 0 ? '' : html.slice(tableAt, html.indexOf('</table>', tableAt));
  const listAt = html.indexOf(`<ul aria-label="${label}"`);
  const list = listAt < 0 ? '' : html.slice(listAt, html.indexOf('</ul>', listAt));
  return { table, list };
}

const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => words(m[1]!));

describe('the Employees tab, for a Mass Access viewer', () => {
  const html = page(massAccessState());
  const { table, list } = parts(html, 'Employees');

  test('the top: the nav label, its one line, and Add employee', () => {
    expect(html).toMatch(/<h1[^>]*>Team<\/h1>/);
    expect(words(html)).toContain('Add the people who work here, and choose which pages each role opens.');
    expect(words(html)).toContain('Add employee');
    expect(html).not.toContain('Still loading');
  });

  test('tabs with counts, History included', () => {
    expect(tabs(html)).toEqual(['Employees 2', 'Roles 3', 'History']);
    expect(html).toMatch(/aria-selected="true"[^>]*>Employees/);
  });

  test('the Mass Access rows come first, with "Every page" and the lock tag instead of Manage', () => {
    for (const part of [table, list]) {
      expect(part.indexOf('Morgan Diaz')).toBeGreaterThan(0);
      expect(part.indexOf('Morgan Diaz')).toBeLessThan(part.indexOf('Jordan Lee'));
      expect(part.indexOf('Jordan Lee')).toBeLessThan(part.indexOf('Sam Rivera'));
    }
    expect(words(table)).toContain('Morgan Diaz You morgan@company.test Every page');
    expect(table).toContain('Mass Access');
    expect(table).not.toContain('aria-label="Manage Morgan Diaz"');
  });

  test('every role as a tag, last seen, and Manage on each employee', () => {
    expect(table).toContain('>Last seen</th>');
    expect(words(table)).toContain('Jordan Lee jordan.lee@company.test Marketing Support 2 days ago');
    expect(words(table)).toContain('Sam Rivera sam.rivera@company.test Support No recent sign-in');
    expect(table).toContain('aria-label="Manage Jordan Lee"');
    expect(table).toContain('aria-label="Manage Sam Rivera"');
    expect(words(list)).toContain('Last seen 2 days ago');
    expect(words(list)).toContain('No recent sign-in');
  });

  test('a search box, and both drawings: the table from 640px, tappable blocks under it', () => {
    expect(html).toContain('placeholder="Search by name, email or role"');
    expect(table).not.toBe('');
    expect(list).not.toBe('');
    expect(html).toMatch(/class="[^"]*hidden @min-\[640px\]:block[^"]*"><table/);
    expect(html).toMatch(/<ul aria-label="Employees" class="[^"]*@min-\[640px\]:hidden/);
    // A block someone can manage is one button.
    expect(list).toMatch(/<button type="button"[^>]*>.*Jordan Lee/);
  });

  test('a Mass Access viewer who is also listed as an employee shows once, as Mass Access', () => {
    const state = massAccessState();
    const twice = page({ ...state, employees: [...state.employees, employee({ id: 'ma-1', name: 'Morgan Diaz', roleIds: [SUPPORT.id] })] });
    expect(tabs(twice)[0]).toBe('Employees 2');
    expect(parts(twice, 'Employees').table.match(/Morgan Diaz/g)).toHaveLength(1);
  });
});

describe('the Employees tab, for a manager', () => {
  const html = page(managerState());
  const { table, list } = parts(html, 'Employees');

  test('no History tab, and the counts are what they can see', () => {
    expect(tabs(html)).toEqual(['Employees 3', 'Roles 1']);
    expect(html).not.toContain('>History<');
  });

  test('roles they can see as tags, the rest as "+1 more"; none at all says "No roles" only when there are none', () => {
    expect(words(table)).toContain('Jordan Lee jordan.lee@company.test Marketing +1 more');
    // Sam's one role is not theirs: "+1 more", never "No roles".
    expect(words(table)).toContain('Sam Rivera sam.rivera@company.test +1 more');
    expect(table).not.toContain('No roles');
    const none = page(managerState({ employees: [employee({ id: 'e-new', name: 'Pat New', roleIds: [] })] }));
    expect(words(parts(none, 'Employees').table)).toContain('Pat New pat.new@company.test No roles');
  });

  test('their own row says "You" and has no Manage', () => {
    expect(words(table)).toContain('Riley Chen You riley.chen@company.test');
    expect(table).not.toContain('aria-label="Manage Riley Chen"');
    expect(table).toContain('aria-label="Manage Jordan Lee"');
    expect(list).not.toMatch(/<button type="button"[^>]*>(?:(?!<\/button>).)*Riley Chen/);
  });

  test('no last seen and no Mass Access rows', () => {
    expect(html).not.toContain('Last seen');
    expect(html).not.toContain('No recent sign-in');
    expect(html).not.toContain('Every page');
    expect(html).not.toContain('Mass Access');
  });

  test('History in the address opens Employees for them', () => {
    const asked = page(managerState(), 'tab=history');
    expect(asked).toMatch(/aria-selected="true"[^>]*>Employees/);
    expect(asked).toContain('aria-label="Manage Jordan Lee"');
  });
});

describe('an empty team', () => {
  test('with roles: add someone', () => {
    const html = page(massAccessState({ employees: [] }));
    expect(words(html)).toContain('No employees yet Add someone by email and pick their role. Add employee');
    expect(html).not.toContain('placeholder="Search by name, email or role"');
    expect(tabs(html)[0]).toBe('Employees 0');
  });

  test('without roles: start with a role', () => {
    const html = page(massAccessState({ employees: [], roles: [] }));
    expect(words(html)).toContain('No employees yet Start with a role: the pages one job needs, like Marketing. Then add the people who do that job. New role');
  });
});

describe('the Roles tab', () => {
  const html = page(massAccessState(), 'tab=roles');
  const { table, list } = parts(html, 'Roles');

  test('the tab is the one in the address, and its main button is New role', () => {
    expect(html).toMatch(/aria-selected="true"[^>]*>Roles/);
    const top = html.slice(0, html.indexOf('role="tablist"'));
    expect(words(top)).toContain('New role');
    expect(words(top)).not.toContain('Add employee');
  });

  test('Role, Opens, People and Edit: four pages, then "and N more"; people counted in words', () => {
    for (const column of ['Role', 'Opens', 'People']) expect(table).toContain(`>${column}</th>`);
    expect(words(table)).toContain('Marketing Email, Traffic, Sign-up funnel, Billing and 2 more 3 people');
    expect(words(table)).toContain('Support Email 1 person');
    expect(words(table)).toContain('Analyst Reports Nobody yet');
    expect(table).toContain('aria-label="Edit Marketing"');
    expect(words(list)).toContain('Marketing Opens Email, Traffic, Sign-up funnel, Billing and 2 more 3 people');
  });

  test('Mass Access sees the pages no role opens yet; a manager does not', () => {
    expect(words(html)).toContain('Not in any role yet: Billing.');
    expect(page(managerState(), 'tab=roles')).not.toContain('Not in any role yet');
  });

  test('no roles: what a role is, and New role', () => {
    const empty = page(massAccessState({ roles: [], employees: [] }), 'tab=roles');
    expect(words(empty)).toContain('No roles yet A role is the set of pages one job needs. Make one for each job, like Marketing or Support. New role');
    expect(empty).not.toContain('Not in any role yet');
  });
});

describe('the History tab', () => {
  const history = (pages: HistoryPage[]) => {
    const qc = client();
    qc.setQueryData(stateKey(BASE), massAccessState());
    qc.setQueryData(historyKey(BASE), { pages, pageParams: pages.map((_, i) => (i === 0 ? null : String(i))) });
    return draw(<TeamPage />, qc, 'tab=history');
  };

  test('changes as sentences, newest first, with Show older while there are more', () => {
    const html = history([
      {
        rows: [
          { id: '2', at: daysAgo(1), text: 'Morgan Diaz added Jordan Lee with Marketing.' },
          { id: '1', at: daysAgo(2), text: 'Morgan Diaz made the role Marketing. It opens Email, Traffic.' },
        ],
        more: true,
      },
    ]);
    expect(html).toMatch(/aria-selected="true"[^>]*>History/);
    expect(html).toContain('>When</th>');
    expect(html).toContain('>What changed</th>');
    const table = parts(html, 'History').table;
    expect(table.indexOf('added Jordan Lee')).toBeLessThan(table.indexOf('made the role Marketing'));
    expect(words(html)).toContain('Show older');
    // No main button on History.
    expect(words(html.slice(0, html.indexOf('role="tablist"')))).not.toMatch(/Add employee|New role/);
  });

  test('the last page has no Show older; none at all says so', () => {
    expect(history([{ rows: [{ id: '1', at: daysAgo(1), text: 'Morgan Diaz removed Sam Rivera.' }], more: false }])).not.toContain('Show older');
    expect(words(history([{ rows: [], more: false }]))).toContain('No changes yet Every change to employees and roles shows up here.');
  });
});

describe('the role editor', () => {
  const fields = (pages: string[], actions: string[] = [], viewer = { id: 'v', massAccess: true, roleIds: [] as string[] }, isNew = true) =>
    clean(
      renderToString(
        <RoleEditorFields
          state={{ catalog: CATALOG, viewer }}
          isNew={isNew}
          name=""
          onName={() => undefined}
          pages={pages}
          actions={actions}
          onPage={() => undefined}
          onAction={() => undefined}
        />,
      ),
    );

  test('the name, with its hint, and the pages with how many are ticked', () => {
    const html = fields(['email', 'team']);
    expect(words(html)).toContain('Name Name it after the job.');
    expect(html).toContain('placeholder="e.g. Marketing"');
    expect(words(html)).toContain('Pages 2 of 6 People in this role can open the pages you tick.');
  });

  test('groups are the nav sections; a section with no label has no heading', () => {
    const html = fields([]);
    expect([...html.matchAll(/<legend[^>]*>([^<]*)<\/legend>/g)].map((m) => m[1])).toEqual(['Admin']);
    expect([...html.matchAll(/<fieldset/g)]).toHaveLength(2);
    // Two columns once the list is 560px wide, one under it.
    expect(html).toContain('@min-[560px]:columns-2');
  });

  test('the every-employee page is locked, with its line; the Team page says what managing the team means', () => {
    const html = fields([]);
    expect(words(html)).toContain(`Overview ${EVERY_EMPLOYEE_LINE}`);
    expect(html).toMatch(/data-locked=""[^>]*>.*?Overview/);
    expect(words(html)).toContain(`Team ${TEAM_PAGE_LINE}`);
    expect(html).not.toContain('Who works here.');
    expect(words(html)).toContain('Email Read and answer the emails customers send to support.');
  });

  test("a page's actions show only once the page is ticked, indented under it", () => {
    const none = fields([]);
    expect(none).not.toContain('Change the email settings');
    expect(none).not.toContain('Make tracking links');
    const email = fields(['email'], ['email.settings']);
    expect(email).toContain('Change the email settings');
    expect(email).not.toContain('Make tracking links');
    expect(email).toContain('aria-label="Inside Email"');
    const traffic = fields(['traffic']);
    expect(words(traffic)).toContain('Make tracking links Tagged links for posts.');
    expect(traffic).not.toContain('Change the email settings');
  });

  test('ticked rows are tinted and checked; the rest are not', () => {
    const html = fields(['email']);
    const row = (label: string) => html.slice(html.lastIndexOf('<label', html.indexOf(`>${label}</span>`)), html.indexOf(`>${label}</span>`));
    expect(row('Email')).toContain('bg-primary/5');
    expect(row('Email')).toContain('aria-checked="true"');
    expect(row('Traffic')).not.toContain('bg-primary/5');
    expect(row('Traffic')).toContain('aria-checked="false"');
  });

  test('a manager making a role is told they will be in it; Mass Access and an edit are not', () => {
    const manager = { id: 'm', massAccess: false, roleIds: ['x'] };
    expect(words(fields([], [], manager))).toContain("You'll be in this role too, so you can manage it.");
    expect(fields([])).not.toContain('in this role too');
    expect(fields([], [], manager, false)).not.toContain('in this role too');
  });

  test('the checklist alone draws the same rows', () => {
    const html = clean(renderToString(<PagesChecklist catalog={CATALOG} pages={['traffic']} actions={['traffic.links']} onPage={() => undefined} onAction={() => undefined} />));
    expect(html).toContain('aria-label="Pages"');
    expect(html).toMatch(/Make tracking links[\s\S]*?<\/label>/);
  });
});

describe('the sentences the dialogs build', () => {
  const state = massAccessState();

  test("Add employee's live line: what they'll open, or what having no role means", () => {
    expect(opensSentence("They'll open", opensWith(state, [SUPPORT.id]), 1, state.everyEmployee)).toBe("They'll open: Overview, Email.");
    expect(opensSentence("They'll open", opensWith(state, []), 0, state.everyEmployee)).toBe("With no role, they'll open only what every employee gets: Overview.");
    expect(opensSentence("They'll open", [], 0, [])).toBe("With no role, they can't open any page yet.");
    expect(opensSentence('Can open', opensWith(state, [ANALYST.id, SUPPORT.id]), 2, state.everyEmployee)).toBe('Can open: Overview, Email, Reports.');
  });

  test('pages from several roles come once each, in nav order', () => {
    expect(opensWith(state, [MARKETING.id, SUPPORT.id, ANALYST.id])).toEqual(['Overview', 'Email', 'Traffic', 'Sign-up funnel', 'Billing', 'Reports', 'Team']);
  });

  test('the done lines, the hidden-roles line, the delete line and people counts', () => {
    expect(joinedLine('jordan@company.test', ['Overview', 'Email'])).toBe("jordan@company.test can open: Overview, Email. They'll need to sign in again to see them.");
    expect(madeLine(['Overview', 'Email'])).toBe("They're on the team. They can sign in once they set their password from the email. They'll open: Overview, Email.");
    expect(hiddenRolesLine('Jordan Lee', 1)).toBe("Jordan Lee also has 1 role you don't manage. They stay as they are.");
    expect(hiddenRolesLine('Jordan Lee', 2)).toBe("Jordan Lee also has 2 roles you don't manage. They stay as they are.");
    expect(deleteRoleLine(0)).toBe('Nobody has this role yet.');
    expect(deleteRoleLine(1)).toBe('1 person has it. They lose its pages unless another of their roles opens them.');
    expect(deleteRoleLine(4)).toBe('4 people have it. They lose its pages unless another of their roles opens them.');
    expect([0, 1, 2].map(peopleWord)).toEqual(['Nobody yet', '1 person', '2 people']);
    expect(roleOpens(MARKETING, LABELS)).toBe('Email, Traffic, Sign-up funnel, Billing and 2 more');
  });
});

describe('loading', () => {
  test('four placeholder rows, and the main button says Still loading', () => {
    const html = page(null);
    expect(html).toContain('aria-busy="true"');
    expect([...html.matchAll(/data-skeleton-row=""/g)]).toHaveLength(4);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Still loading<\/button>/);
    expect(tabs(html)).toEqual(['Employees', 'Roles']);
    expect(html).not.toContain('No employees yet');
  });

  test('the skeleton an app can show on its own is the same page', () => {
    const html = clean(renderToString(<TeamPageSkeleton />));
    expect([...html.matchAll(/data-skeleton-row=""/g)]).toHaveLength(4);
    expect(html).toContain('Still loading');
  });
});

describe('the page top', () => {
  test("renderHeader draws the app's own top with the title, the line and the main button", () => {
    const html = page(massAccessState({ title: 'Staff' }), '', {
      renderHeader: ({ title, description, actions }) => (
        <header data-app-header="">
          <h1>{title}</h1>
          <p>{description}</p>
          <div>{actions}</div>
        </header>
      ),
    });
    expect(html).toContain('<header data-app-header=""><h1>Staff</h1>');
    expect(words(html)).toContain('Staff Add the people who work here, and choose which pages each role opens. Add employee');
  });

  test('a mistake in the app\'s setup is said to Mass Access in one plain line', () => {
    const line = "The app's list of pages has a mistake, so some employees may not get their pages. A developer can see what to fix in the server log.";
    expect(words(page(massAccessState({ problem: line })))).toContain(line);
  });
});

describe('failures never show a request id or an error code', () => {
  const failed = async (error: TeamError) => {
    const qc = client();
    await qc.prefetchQuery({ queryKey: stateKey(BASE), queryFn: () => Promise.reject(error) });
    expect(qc.getQueryState(stateKey(BASE))?.status).toBe('error');
    return draw(<TeamPage />, qc);
  };

  test('the server not answering: the deck\'s line, with Try again', async () => {
    const html = await failed(new TeamError(503, { type: 'internal', code: 'internal_error', message: 'The Team page is not answering right now.', hint: 'Try again in a minute.' }, 'req_abc123'));
    expect(words(html)).toContain("The team didn't load. Try again in a minute. Try again");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('req_abc123');
    expect(html).not.toContain('internal_error');
    expect(html).not.toContain('not answering');
  });

  test('offline, signed out, and a Team page that is not theirs anymore', async () => {
    const offline = await failed(new TeamError(0, { message: 'no answer' }, null));
    expect(words(offline)).toContain(`${ERROR_WORDS.offline} Try again`);
    const signedOut = await failed(new TeamError(401, { type: 'authentication', code: 'not_signed_in', message: 'Sign in.' }, 'req_out'));
    expect(words(signedOut)).toContain(ERROR_WORDS.signedOut);
    expect(signedOut).not.toContain('Try again');
    const lost = await failed(new TeamError(404, { type: 'not_found', code: 'route_not_found', message: 'This page does not exist.' }, 'req_gone'));
    expect(words(lost)).toContain("You can't manage the team anymore. Ask whoever manages it.");
    for (const html of [offline, signedOut, lost]) expect(html).not.toMatch(/req_|not_signed_in|route_not_found/);
  });

  test("a refusal shows the route's words, and nothing else", () => {
    const html = clean(
      renderToString(<InlineError error={new TeamError(409, { type: 'conflict', code: 'already_employee', message: 'Jordan Lee is already an employee.', hint: 'Look them up.' }, 'req_xyz789')} />),
    );
    expect(words(html)).toBe('Jordan Lee is already an employee.');
    expect(html).not.toContain('req_xyz789');
    expect(html).not.toContain('already_employee');
    expect(html).not.toContain('Look them up.');
  });

  test('a save the server could not do says so in the deck\'s words', () => {
    const html = clean(renderToString(<InlineError error={new TeamError(503, { type: 'internal', code: 'internal_error', message: 'The Team page is not answering right now.' }, 'req_1')} />));
    expect(words(html)).toBe("That wasn't saved. Try again in a minute.");
  });
});

describe('the gate, for an app that checks pages in the browser', () => {
  const NAV: TeamNav = [
    { label: null, items: [{ label: 'Home', href: '/dashboard', access: 'everyone' }] },
    { label: 'Admin', items: [{ label: 'Email', href: '/dashboard/admin/email', access: 'role', grant: 'email', subpages: true }] },
  ];
  const gate = (view: TeamView | null, pageRef = 'email') => {
    const qc = client();
    if (view) qc.setQueryData(viewKey(BASE), view);
    return draw(
      <TeamPageGate page={pageRef} nav={NAV}>
        <p>The Email page</p>
      </TeamPageGate>,
      qc,
    );
  };

  test('opens the page for someone whose role gives it, by grant or by address', () => {
    const sam: TeamView = { massAccess: false, employee: true, pages: ['email'], actions: [] };
    expect(gate(sam)).toContain('The Email page');
    expect(gate(sam, '/dashboard/admin/email/settings')).toContain('The Email page');
  });

  test('anyone else gets "This page does not exist."; while it loads, a placeholder', () => {
    const nobody: TeamView = { massAccess: false, employee: false, pages: [], actions: [] };
    expect(gate(nobody)).toContain('This page does not exist.');
    expect(gate(nobody)).not.toContain('The Email page');
    expect(gate(null)).toContain('aria-busy="true"');
    expect(gate(null)).not.toContain('The Email page');
  });
});

describe('where the calls go', () => {
  test("the page's default base path is the server's", () => {
    expect(TEAM_CLIENT_BASE_PATH).toBe(TEAM_BASE_PATH);
  });

  test('a basePath prop moves the calls, so the page reads under its own key', () => {
    const qc = client();
    qc.setQueryData(stateKey('/admin/team'), massAccessState());
    expect(draw(<TeamPage basePath="/admin/team/" />, qc)).toContain('aria-label="Manage Jordan Lee"');
    expect(draw(<TeamPage />, qc)).toContain('Still loading');
  });
});

describe('the calls the page makes', () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  let answer: () => Response | Promise<Response> = () => Response.json({ ok: true });
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    sent.length = 0;
    answer = () => Response.json({ ok: true });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return answer();
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const header = (init: RequestInit, name: string) => (init.headers as Record<string, string> | undefined)?.[name];

  test('every write goes as JSON with the site\'s own cookies, to the address the contract names', async () => {
    const routes = teamRoutes('/admin/team');
    await routes.addEmployee({ email: 'jordan@company.test', name: 'Jordan Lee', roleIds: [SUPPORT.id] });
    await routes.manageEmployee({ id: 'user 1', roleIds: [SUPPORT.id], token: 'tok' });
    await routes.removeEmployee({ id: 'user 1', token: 'a&b' });
    await routes.createRole({ name: 'Marketing', pages: ['email'], actions: ['email.settings'] });
    await routes.createRole({ id: MARKETING.id, name: 'Marketing', pages: ['email'], actions: [] });
    await routes.editRole({ id: MARKETING.id, name: 'Marketing', pages: ['email', 'traffic'], actions: [], version: 3 });
    await routes.deleteRole({ id: MARKETING.id, version: 4 });
    expect(sent.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      'POST /admin/team/employees',
      'PATCH /admin/team/employees/user%201',
      'DELETE /admin/team/employees/user%201?token=a%26b',
      'POST /admin/team/roles',
      'POST /admin/team/roles',
      `PATCH /admin/team/roles/${MARKETING.id}`,
      `DELETE /admin/team/roles/${MARKETING.id}?version=4`,
    ]);
    for (const { init } of sent) {
      expect(init.credentials).toBe('same-origin');
      expect(header(init, 'content-type')).toBe('application/json');
    }
    const body = (i: number) => JSON.parse(String(sent[i]!.init.body)) as Record<string, unknown>;
    expect(body(0)).toEqual({ email: 'jordan@company.test', name: 'Jordan Lee', roleIds: [SUPPORT.id] });
    expect(body(1)).toEqual({ roleIds: [SUPPORT.id], token: 'tok' });
    expect(sent[2]!.init.body).toBeUndefined();
    // A new role gets its id in the page, or keeps the one the dialog made.
    expect(String(body(3).id)).toMatch(UUID);
    expect(body(3)).toEqual({ id: body(3).id, name: 'Marketing', pages: ['email'], actions: ['email.settings'] });
    expect(body(4).id).toBe(MARKETING.id);
    expect(body(5)).toEqual({ name: 'Marketing', pages: ['email', 'traffic'], actions: [], version: 3 });
  });

  test('reads: the state, the viewer\'s own view, and history before the last row shown', async () => {
    const routes = teamRoutes('/api/team');
    await routes.state();
    await routes.me();
    await routes.history(null);
    await routes.history('120');
    expect(sent.map(({ url, init }) => `${init.method} ${url}`)).toEqual(['GET /api/team', 'GET /api/team/me', 'GET /api/team/history', 'GET /api/team/history?before=120']);
    for (const { init } of sent) {
      expect(init.credentials).toBe('same-origin');
      expect(header(init, 'content-type')).toBeUndefined();
    }
  });

  test("a refusal is a TeamError with the route's words; no answer at all is offline", async () => {
    answer = () => Response.json({ error: { type: 'conflict', code: 'stale', message: "Someone else changed this while you had it open, so your change wasn't saved." }, requestId: 'req_9' }, { status: 409 });
    const refused = await teamRoutes(BASE).manageEmployee({ id: 'u', roleIds: [], token: 't' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TeamError);
    expect((refused as TeamError).status).toBe(409);
    expect((refused as TeamError).code).toBe('stale');
    expect((refused as TeamError).message).toBe("Someone else changed this while you had it open, so your change wasn't saved.");
    expect((refused as TeamError).requestId).toBe('req_9');

    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    const offline = await teamRoutes(BASE).state().catch((error: unknown) => error);
    expect((offline as TeamError).status).toBe(0);
    expect(words(clean(renderToString(<InlineError error={offline} />)))).toBe(ERROR_WORDS.offline);

    // A page that is not the routes' JSON (a proxy's error page) is a failed call, never data.
    answer = () => new Response('<html>Bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const odd = await teamRoutes(BASE).state().catch((error: unknown) => error);
    expect(odd).toBeInstanceOf(TeamError);
    expect(words(clean(renderToString(<InlineError error={odd} when="load" />)))).toBe(ERROR_WORDS.loadFailed);
  });

  test('a "not found" from a Team route is told apart: GET me says whether they are signed out or lost the page', async () => {
    const notFound = () => Response.json({ error: { type: 'not_found', code: 'route_not_found', message: 'This page does not exist.' }, requestId: 'req_1' }, { status: 404 });
    // Signed out: me is "not found" too.
    answer = notFound;
    const signedOut = await teamRoutes(BASE).removeEmployee({ id: 'u', token: 't' }).catch((error: unknown) => error);
    expect(sent.map(({ url, init }) => `${init.method} ${url}`)).toEqual([`DELETE ${BASE}/employees/u?token=t`, `GET ${BASE}/me`]);
    expect([(signedOut as TeamError).status, (signedOut as TeamError).code]).toEqual([401, 'not_signed_in']);
    expect(words(clean(renderToString(<InlineError error={signedOut} />)))).toBe(ERROR_WORDS.signedOut);

    // Still signed in, so the Team page is not theirs anymore: me answers.
    sent.length = 0;
    answer = () => (sent.length === 1 ? notFound() : Response.json({ massAccess: false, employee: true, pages: [], actions: [] }));
    const lost = await teamRoutes(BASE).state().catch((error: unknown) => error);
    expect(sent.map(({ url }) => url)).toEqual([BASE, `${BASE}/me`]);
    expect((lost as TeamError).code).toBe('route_not_found');
    expect(words(clean(renderToString(<InlineError error={lost} />)))).toBe(ERROR_WORDS.lostPage);

    // me itself is never asked twice.
    sent.length = 0;
    answer = notFound;
    await teamRoutes(BASE).me().catch(() => undefined);
    expect(sent).toHaveLength(1);
  });

  test('a field is 16px on a phone, so an iPhone does not zoom in when it is tapped', () => {
    const html = renderToString(<RoleEditorFields state={massAccessState()} isNew name="" onName={() => {}} pages={[]} actions={[]} onPage={() => {}} onAction={() => {}} />);
    expect(html).toMatch(/<input[^>]*class="[^"]*\btext-base\b[^"]*\bsm:text-sm\b/);
  });
});
