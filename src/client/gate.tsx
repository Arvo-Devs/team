'use client';

// TeamPageGate, for an app whose pages check who may open them in the
// browser (Framework Part 3 allows that when the server guards the data
// behind them). It asks the Team routes what the signed-in person may open
// (GET {basePath}/me) and draws its children only when the nav's one rule,
// canOpenRef, opens the page for them. It is for the screen only: the
// server still checks every call for the page's data, and an app that
// builds its pages on the server uses team.requirePage there instead.
import type { ReactNode } from 'react';
import { canOpenRef, type TeamNav } from '../nav';
import { ErrorState, Skeleton } from '../ui/ui-deps';
import { useTeamView } from './api';

export type TeamPageGateProps = {
  /** The page: its grant ("email") or its address ("/dashboard/admin/email"; a sub-page counts as its page's). */
  page: string;
  /** The app's nav list, the same one the server was given. */
  nav: TeamNav;
  children: ReactNode;
  /** What someone who may not open the page sees. Default: "This page does not exist." */
  fallback?: ReactNode;
};

/** What the gate shows someone who may not open the page: the same words as a page that is not there. */
export function TeamPageMissing() {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <p className="text-sm font-semibold text-foreground">This page does not exist.</p>
    </div>
  );
}

export function TeamPageGate({ page, nav, children, fallback }: TeamPageGateProps) {
  const view = useTeamView();
  if (view.data) return canOpenRef(view.data, nav, page) ? <>{children}</> : <>{fallback ?? <TeamPageMissing />}</>;
  if (view.isPending) {
    return (
      <div aria-busy="true" className="space-y-3">
        <Skeleton className="h-7 w-48 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  // Not signed in answers like a page that is not there.
  if (view.error?.status === 404) return <>{fallback ?? <TeamPageMissing />}</>;
  return <ErrorState error={view.error} onRetry={() => void view.refetch()} retrying={view.isFetching} failed="This page didn't load. Try again in a minute." />;
}
