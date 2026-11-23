'use client';

// The Team page (design §9, copy deck §10): one page, three tabs. Employees
// and Roles for whoever can open it; History for Mass Access only. The tab
// is kept in the address as ?tab=roles, so a link opens it and a reload
// stays on it. The top is the app's usual one, through renderHeader: the
// title is the Team page's nav label (from the server, so it is "Staff"
// where the nav says Staff), one line under it, and the current tab's main
// button. Without renderHeader the page draws a plain top of its own.
//
// Mount it inside the app's QueryClientProvider. Reading the address needs a
// Suspense boundary when the page is prerendered; the page brings its own.
import { Plus, TriangleAlert, UserPlus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EmployeeView, RoleView } from '../shared/api';
import { Button, Card, errorKind, ErrorState, InlineError, Spinner, Tab, TabList, Tabs } from '../ui/ui-deps';
import { AddEmployeeDialog } from './add-employee';
import { useTeamState } from './api';
import { TeamProvider } from './context';
import { EmployeesTab, teamMembers } from './employees';
import { HistoryTab } from './history';
import { ManageEmployeeDialog } from './manage-employee';
import { SkeletonRows, TextSkeleton } from './parts';
import { RoleEditorDialog } from './role-editor';
import { RolesTab } from './roles';

/** What the app's own page top is given. While the page loads, the title and the line are placeholder bars. */
export type TeamPageHeader = Readonly<{
  /** The Team page's nav label ("Team"; "Staff" where the nav says so). */
  title: ReactNode;
  /** "Add the people who work here, and choose which pages each role opens." */
  description: ReactNode;
  /** The current tab's main button ("Add employee", "New role"); null on History. */
  actions: ReactNode;
}>;

export type TeamPageProps = {
  /** Where the app mounted the Team routes. Default /api/team. */
  basePath?: string;
  /**
   * Draws the page's top with the app's own header component. Without it, a
   * plain title, line and button. A function can't cross from a server
   * component to a client one, so an app that passes it renders TeamPage
   * from one of its own 'use client' files.
   */
  renderHeader?: (header: TeamPageHeader) => ReactNode;
};

export type TeamTab = 'employees' | 'roles' | 'history';

export function TeamPage({ basePath, renderHeader }: TeamPageProps = {}) {
  return (
    <TeamProvider basePath={basePath}>
      <Suspense fallback={<TeamPageSkeleton renderHeader={renderHeader} />}>
        <Page renderHeader={renderHeader} />
      </Suspense>
    </TeamProvider>
  );
}

/** The page while it loads: the top with "Still loading", the tabs, and four rows. The app can show it in its own gate or loading file. */
export function TeamPageSkeleton({ renderHeader }: Pick<TeamPageProps, 'renderHeader'> = {}) {
  return <Loading renderHeader={renderHeader} tab="employees" onTab={() => undefined} />;
}

/** The tab the address names (?tab=roles), or Employees. */
function useAddressTab(): TeamTab {
  const params = useSearchParams();
  const value = params?.get('tab');
  return value === 'roles' || value === 'history' ? value : 'employees';
}

/**
 * Puts the tab in the address without a new history entry. Next follows the
 * browser's own history calls, so useSearchParams sees it; the state must be
 * null, since Next ignores a call that passes its own history state back.
 * Employees, the first tab, is left out of the address.
 */
function showTab(tab: TeamTab) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (tab === 'employees') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  window.history.replaceState(null, '', url);
}

type Opened =
  | { kind: 'add'; key: number; open: boolean }
  | { kind: 'manage'; key: number; open: boolean; employee: EmployeeView; gone: boolean }
  | { kind: 'role'; key: number; open: boolean; role: RoleView | null; gone: boolean };

function Page({ renderHeader }: Pick<TeamPageProps, 'renderHeader'>) {
  const fromAddress = useAddressTab();
  // The tab just picked, until the address says the same (or for good, where nothing follows the address).
  const [picked, setPicked] = useState<TeamTab | null>(null);
  useEffect(() => setPicked(null), [fromAddress]);
  const query = useTeamState();
  const state = query.data;
  const [opened, setOpened] = useState<Opened | null>(null);
  // Each dialog opens fresh, with its own request: a new key every time.
  const keys = useRef(0);
  const nextKey = () => (keys.current += 1);

  const wanted = picked ?? fromAddress;
  // History is Mass Access only: anyone else who asks for it gets Employees.
  const tab: TeamTab = wanted === 'history' && state && !state.viewer.massAccess ? 'employees' : wanted;
  const pickTab = (next: TeamTab) => {
    setPicked(next);
    showTab(next);
  };

  if (!state) {
    if (query.isPending) return <Loading renderHeader={renderHeader} tab={tab} onTab={pickTab} />;
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </Card>
    );
  }
  // Read again and the answer is that they are signed out, or can't open the page anymore: say so instead of what they could see before.
  const kind = query.error ? errorKind(query.error) : null;
  if (kind === 'signed_out' || kind === 'lost_page') {
    return (
      <Card>
        <ErrorState error={query.error} />
      </Card>
    );
  }

  const openAdd = () => setOpened({ kind: 'add', key: nextKey(), open: true });
  const openManage = (employee: EmployeeView) => setOpened({ kind: 'manage', key: nextKey(), open: true, employee, gone: false });
  const openRole = (role: RoleView | null) => setOpened({ kind: 'role', key: nextKey(), open: true, role, gone: false });
  const setOpen = (key: number, open: boolean) => setOpened((now) => (now && now.key === key ? { ...now, open } : now));

  /** Start over: read the team again, then open the same person afresh, or say they are gone. */
  const startOverEmployee = async (id: string) => {
    const fresh = await query.refetch();
    const employee = fresh.data?.employees.find((candidate) => candidate.id === id);
    const key = nextKey();
    setOpened((now) => (now?.kind === 'manage' && now.employee.id === id ? (employee ? { kind: 'manage', key, open: true, employee, gone: false } : { ...now, gone: true }) : now));
  };
  const startOverRole = async (id: string) => {
    const fresh = await query.refetch();
    const role = fresh.data?.roles.find((candidate) => candidate.id === id);
    const key = nextKey();
    setOpened((now) => (now?.kind === 'role' && now.role?.id === id ? (role ? { kind: 'role', key, open: true, role, gone: false } : { ...now, gone: true }) : now));
  };

  const actions =
    tab === 'employees' ? (
      <Button variant="primary" onClick={openAdd}>
        <UserPlus aria-hidden />
        Add employee
      </Button>
    ) : tab === 'roles' ? (
      <Button variant="primary" onClick={() => openRole(null)}>
        <Plus aria-hidden />
        New role
      </Button>
    ) : null;

  return (
    <div className="min-w-0 space-y-4">
      <Header renderHeader={renderHeader} title={state.title} description={state.description} actions={actions} />
      {state.problem ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2.5 text-sm leading-relaxed text-warning-strong">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">{state.problem}</span>
        </p>
      ) : null}
      {query.error ? (
        <InlineError
          error={query.error}
          when="load"
          action={
            <Button size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? <Spinner /> : null}
              Try again
            </Button>
          }
        />
      ) : null}
      <Tabs.Root value={tab} onValueChange={(next) => pickTab(next as TeamTab)}>
        <TeamTabs counts={{ employees: teamMembers(state).length, roles: state.roles.length }} history={state.viewer.massAccess} />
        <Tabs.Panel value="employees" className="outline-none">
          <Card className="@container mt-4">
            <EmployeesTab state={state} onAdd={openAdd} onNewRole={() => openRole(null)} onManage={openManage} />
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="roles" className="outline-none">
          <Card className="@container mt-4">
            <RolesTab state={state} onNew={() => openRole(null)} onEdit={openRole} />
          </Card>
        </Tabs.Panel>
        {state.viewer.massAccess ? (
          <Tabs.Panel value="history" className="outline-none">
            <Card className="@container mt-4">
              <HistoryTab />
            </Card>
          </Tabs.Panel>
        ) : null}
      </Tabs.Root>

      {opened?.kind === 'add' ? (
        <AddEmployeeDialog key={opened.key} open={opened.open} onOpenChange={(open) => setOpen(opened.key, open)} state={state} onNewRole={() => openRole(null)} />
      ) : null}
      {opened?.kind === 'manage' ? (
        <ManageEmployeeDialog
          key={opened.key}
          open={opened.open}
          onOpenChange={(open) => setOpen(opened.key, open)}
          employee={opened.employee}
          gone={opened.gone}
          state={state}
          onStartOver={() => void startOverEmployee(opened.employee.id)}
          onNewRole={() => openRole(null)}
        />
      ) : null}
      {opened?.kind === 'role' ? (
        <RoleEditorDialog
          key={opened.key}
          open={opened.open}
          onOpenChange={(open) => setOpen(opened.key, open)}
          role={opened.role}
          gone={opened.gone}
          state={state}
          onStartOver={() => (opened.role ? void startOverRole(opened.role.id) : undefined)}
        />
      ) : null}
    </div>
  );
}

/** The page while its state loads: the top with a placeholder title and "Still loading", the tabs without counts, four rows. */
function Loading({ renderHeader, tab, onTab }: Pick<TeamPageProps, 'renderHeader'> & { tab: TeamTab; onTab: (tab: TeamTab) => void }) {
  return (
    <div className="min-w-0 space-y-4" aria-busy="true">
      <Header
        renderHeader={renderHeader}
        title={
          <>
            <TextSkeleton className="w-28" />
            <span className="sr-only">Loading</span>
          </>
        }
        description={<TextSkeleton className="w-72" />}
        actions={
          tab === 'history' ? null : (
            <Button variant="primary" disabled>
              <Spinner />
              Still loading
            </Button>
          )
        }
      />
      <Tabs.Root value={tab} onValueChange={(next) => onTab(next as TeamTab)}>
        {/* Nobody knows yet whether this viewer has History: it shows only when the address asked for it. */}
        <TeamTabs counts={null} history={tab === 'history'} />
      </Tabs.Root>
      {/* The page's own spacing puts it as far under the tabs as the loaded page's card. */}
      <Card>
        <SkeletonRows />
      </Card>
    </div>
  );
}

function TeamTabs({ counts, history }: { counts: { employees: number; roles: number } | null; history: boolean }) {
  // The row scrolls inside the page's own width: no reaching past it on a phone, so nothing scrolls the page sideways whatever the app's padding.
  return (
    <TabList className="mx-0 px-0">
      <Tab value="employees">
        Employees
        {counts ? <Count n={counts.employees} /> : null}
      </Tab>
      <Tab value="roles">
        Roles
        {counts ? <Count n={counts.roles} /> : null}
      </Tab>
      {history ? <Tab value="history">History</Tab> : null}
    </TabList>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground tabular-nums">{n}</span>;
}

/** The page's top: the app's own through renderHeader, else a plain one (title and line at the left, the main button at the right). */
function Header({ renderHeader, title, description, actions }: TeamPageHeader & Pick<TeamPageProps, 'renderHeader'>) {
  if (renderHeader) return <>{renderHeader({ title, description, actions })}</>;
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] text-foreground sm:text-2xl">{title}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
