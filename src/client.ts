// The client entry of @arvo/team: the Team page and its skeleton, the gate
// for apps that check pages in the browser, the provider that says where the
// routes are mounted, and the signed-in person's view for a browser nav (run
// filterNav from @arvo/team/nav with it). Mount everything inside the app's
// own QueryClientProvider. The calls go to /api/team unless TeamPage's
// basePath prop, or a TeamProvider around it, says otherwise.

export { TeamPage, TeamPageSkeleton } from './client/team-page';
export type { TeamPageHeader, TeamPageProps, TeamTab } from './client/team-page';
export { TeamPageGate, TeamPageMissing } from './client/gate';
export type { TeamPageGateProps } from './client/gate';
export { TeamProvider } from './client/context';
export type { TeamProviderProps } from './client/context';
export { TEAM_QUERY_KEY, useTeamView } from './client/api';
export type { TeamAccessKind, TeamNav, TeamNavAction, TeamNavItem, TeamNavSection, TeamView } from './nav';
export type { CatalogPage, CatalogSection, EmployeeView, HistoryPage, HistoryRow, MassAccessView, RoleView, TeamState } from './shared/api';
