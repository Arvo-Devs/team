'use client';

// Where the Team routes are mounted, for every call the page, the gate and
// useTeamView make. The default is /api/team (the server's default too); a
// TeamProvider moves it for everything inside, and TeamPage's basePath prop
// moves it for the page alone. Kept here, not read from ../config, so the
// browser bundle carries none of the server's config code.
import { createContext, use, type ReactNode } from 'react';

/** The routes' address when nothing says otherwise. Equal to the server's TEAM_BASE_PATH (a test checks). */
export const TEAM_CLIENT_BASE_PATH = '/api/team';

const BasePathContext = createContext<string>(TEAM_CLIENT_BASE_PATH);

export type TeamProviderProps = {
  /** Where the app mounted the Team routes. Leave it out to keep the one from an outer provider, or /api/team. */
  basePath?: string;
  children: ReactNode;
};

export function TeamProvider({ basePath, children }: TeamProviderProps) {
  const outer = use(BasePathContext);
  // No slash at the end, so the calls can add theirs: /api/team/employees.
  const value = basePath === undefined ? outer : basePath.trim().replace(/\/+$/, '') || TEAM_CLIENT_BASE_PATH;
  return <BasePathContext value={value}>{children}</BasePathContext>;
}

/** The base path in effect: the nearest provider's, or /api/team. */
export function useTeamBasePath(): string {
  return use(BasePathContext);
}
