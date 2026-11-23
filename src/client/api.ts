'use client';

// The Team page's reads and writes, against the package's routes under the
// base path in effect (./context). The shapes are the contract in
// ../shared/api.ts. A route that refuses answers { error: { type, code,
// message, hint?, param? }, requestId }, thrown here as TeamError: its
// message is already the words to show, and InlineError and ErrorState pick
// the copy deck's own line for the few a route cannot word (and log the code
// and request id, which never reach the screen).
//
// Every write goes as JSON from this site's own page (content-type
// application/json, same-origin credentials; the routes refuse anything
// else), and when it settles, failed or not, everything the page read is
// read again: the state, the history and the signed-in person's own view,
// since a change to a role they hold changes what they can open.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  newRoleId,
  type AddEmployeeBody,
  type AddResult,
  type EditRoleBody,
  type EmployeeView,
  type HistoryPage,
  type ManageEmployeeBody,
  type NewRoleBody,
  type RoleView,
  type TeamState,
  type TeamView,
} from '../shared/api';
import { errorFromBody, TeamError } from '../ui/ui-deps';
import { useTeamBasePath } from './context';

/** Every query this package keeps is under this key, then the base path. */
export const TEAM_QUERY_KEY = ['arvo-team'] as const;

/** Everything kept for one base path: what a write reads again. */
export function teamKey(basePath: string) {
  return [...TEAM_QUERY_KEY, basePath] as const;
}

/** GET {basePath}: the Team page's state. */
export function stateKey(basePath: string) {
  return [...TEAM_QUERY_KEY, basePath, 'state'] as const;
}

/** GET {basePath}/me: the signed-in person's view. */
export function viewKey(basePath: string) {
  return [...TEAM_QUERY_KEY, basePath, 'me'] as const;
}

/** GET {basePath}/history, page by page. */
export function historyKey(basePath: string) {
  return [...TEAM_QUERY_KEY, basePath, 'history'] as const;
}

/** What a failed call says when no answer came back at all. */
const NO_ANSWER = "You're offline. Check your connection.";
/** What a call says once the session has run out. */
const SIGNED_OUT = "You've been signed out. Sign in again to keep going.";

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function call<T>(url: string, { method = 'GET', body, signal }: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal,
      credentials: 'same-origin',
      headers: method === 'GET' ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new TeamError(0, { message: NO_ANSWER }, null);
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) throw errorFromBody(response.status, parsed);
  // Every route answers a JSON object; anything else (a proxy's page, say) is a failed call, never data.
  if (!parsed || typeof parsed !== 'object') throw errorFromBody(502, null);
  return parsed as T;
}

const segment = (value: string) => encodeURIComponent(value);

/**
 * A Team route answers "not found" both to someone signed out and to someone
 * who can't open the Team page anymore, so the address tells neither of them
 * anything. The page needs to say which it is: GET me answers anyone signed
 * in, so a "not found" from it too means the session ran out.
 */
async function tellingSignedOut<T>(basePath: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TeamError) || error.code !== 'route_not_found') throw error;
    const signedOut = await call<TeamView>(`${basePath}/me`).then(
      () => false,
      (meError: unknown) => meError instanceof TeamError && meError.code === 'route_not_found',
    );
    if (signedOut) throw new TeamError(401, { message: SIGNED_OUT, type: 'authentication', code: 'not_signed_in' }, error.requestId);
    throw error;
  }
}

/** A new role, as the page sends it: the id is made here unless the dialog made one when it opened. */
export type NewRole = Omit<NewRoleBody, 'id'> & { id?: string };

/**
 * The Team routes under one base path, one plain function each (the hooks
 * below are these with react-query around them). Reads ask for JSON; every
 * write also says it sends JSON, and all of them go with the site's own
 * cookies (same-origin credentials).
 */
export function teamRoutes(basePath: string) {
  const team = <T,>(work: () => Promise<T>) => tellingSignedOut(basePath, work);
  return {
    state: (signal?: AbortSignal) => team(() => call<TeamState>(basePath, { signal })),
    me: (signal?: AbortSignal) => call<TeamView>(`${basePath}/me`, { signal }),
    history: (before: string | null, signal?: AbortSignal) =>
      team(() => call<HistoryPage>(`${basePath}/history${before ? `?before=${segment(before)}` : ''}`, { signal })),
    addEmployee: (body: AddEmployeeBody) => team(() => call<AddResult>(`${basePath}/employees`, { method: 'POST', body })),
    manageEmployee: ({ id, roleIds, token }: ManageEmployeeBody & { id: string }) =>
      team(() => call<EmployeeView>(`${basePath}/employees/${segment(id)}`, { method: 'PATCH', body: { roleIds, token } satisfies ManageEmployeeBody })),
    removeEmployee: ({ id, token }: { id: string; token: string }) =>
      team(() => call<{ removed: true }>(`${basePath}/employees/${segment(id)}?token=${segment(token)}`, { method: 'DELETE' })),
    createRole: ({ id, name, pages, actions }: NewRole) =>
      team(() => call<RoleView>(`${basePath}/roles`, { method: 'POST', body: { id: id ?? newRoleId(), name, pages, actions } satisfies NewRoleBody })),
    editRole: ({ id, name, pages, actions, version }: EditRoleBody & { id: string }) =>
      team(() => call<RoleView>(`${basePath}/roles/${segment(id)}`, { method: 'PATCH', body: { name, pages, actions, version } satisfies EditRoleBody })),
    deleteRole: ({ id, version }: { id: string; version: number }) =>
      team(() => call<{ deleted: true }>(`${basePath}/roles/${segment(id)}?version=${segment(String(version))}`, { method: 'DELETE' })),
  };
}

/**
 * react-query holds a read or a save back while the browser says it is
 * offline, and sends it when the connection returns. Here that would leave
 * the page on "Still loading" or "Saving…" with no word, and send a change
 * later that the person had given up on. So every call goes at once and
 * fails at once, with the offline line.
 */
const SEND_NOW = { networkMode: 'always' } as const;

type Routes = ReturnType<typeof teamRoutes>;

/** Everything the Team page shows to the person looking. */
export function useTeamState() {
  const basePath = useTeamBasePath();
  return useQuery<TeamState, TeamError>({
    queryKey: stateKey(basePath),
    queryFn: ({ signal }) => teamRoutes(basePath).state(signal),
    ...SEND_NOW,
  });
}

/**
 * What the signed-in person may open (GET {basePath}/me), for an app whose
 * nav or pages check in the browser: run filterNav or canOpenRef from
 * @arvo/team/nav with it. The server still checks every page's data.
 */
export function useTeamView() {
  const basePath = useTeamBasePath();
  return useQuery<TeamView, TeamError>({
    queryKey: viewKey(basePath),
    queryFn: ({ signal }) => teamRoutes(basePath).me(signal),
    ...SEND_NOW,
  });
}

/** The changes, newest first, 50 at a time: each next page starts before the last row shown. Mass Access only. */
export function useTeamHistory({ enabled = true }: { enabled?: boolean } = {}) {
  const basePath = useTeamBasePath();
  return useInfiniteQuery<HistoryPage, TeamError, InfiniteData<HistoryPage, string | null>, ReturnType<typeof historyKey>, string | null>({
    queryKey: historyKey(basePath),
    queryFn: ({ pageParam, signal }) => teamRoutes(basePath).history(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => (last.more && last.rows.length > 0 ? last.rows[last.rows.length - 1]!.id : undefined),
    enabled,
    ...SEND_NOW,
  });
}

/** One write: sent once, and when it settles, failed or not, everything this base path keeps is read again (the mutation waits for that). */
function useTeamWrite<K extends 'addEmployee' | 'manageEmployee' | 'removeEmployee' | 'createRole' | 'editRole' | 'deleteRole'>(route: K) {
  type Vars = Parameters<Routes[K]>[0];
  type Result = Awaited<ReturnType<Routes[K]>>;
  const qc = useQueryClient();
  const basePath = useTeamBasePath();
  return useMutation<Result, TeamError, Vars>({
    mutationFn: (vars) => (teamRoutes(basePath)[route] as (vars: Vars) => Promise<Result>)(vars),
    onSettled: () => qc.invalidateQueries({ queryKey: teamKey(basePath) }),
    ...SEND_NOW,
  });
}

/** POST {basePath}/employees: add someone by email, with roles (and a full name when the app can make their login). */
export function useAddEmployee() {
  return useTeamWrite('addEmployee');
}

/** PATCH {basePath}/employees/<id>: their roles, with the token they were opened with. */
export function useManageEmployee() {
  return useTeamWrite('manageEmployee');
}

/** DELETE {basePath}/employees/<id>?token=: take them off the team (their account stays). */
export function useRemoveEmployee() {
  return useTeamWrite('removeEmployee');
}

/**
 * POST {basePath}/roles. The role's id is made in the page (newRoleId), so
 * a second click or a retry of the same dialog makes one role: pass the id
 * the dialog made when it opened.
 */
export function useCreateRole() {
  return useTeamWrite('createRole');
}

/** PATCH {basePath}/roles/<id>, with the version it was opened at. */
export function useEditRole() {
  return useTeamWrite('editRole');
}

/** DELETE {basePath}/roles/<id>?version=. */
export function useDeleteRole() {
  return useTeamWrite('deleteRole');
}
