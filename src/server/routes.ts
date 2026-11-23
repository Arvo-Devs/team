/**
 * The Team routes, mounted under basePath (default /api/team) by one
 * catch-all route file in the app:
 *
 *   GET    ''                 the Team page's state         (anyone who can open the Team page)
 *   GET    'me'               the signed-in person's view   (anyone signed in; for browser navs)
 *   GET    'history'          50 changes, ?before=<id>      (Mass Access)
 *   POST   'employees'        add someone                   (Team page, from the site's own pages)
 *   PATCH  'employees/<id>'   change someone's roles
 *   DELETE 'employees/<id>'   remove someone (?token=)
 *   POST   'roles'            make a role
 *   PATCH  'roles/<id>'       change a role
 *   DELETE 'roles/<id>'       delete a role (?version=)
 *
 * Anyone who may not open the Team page, anyone signed out and anyone
 * viewing as someone else gets the same "not found" as an unknown route,
 * whatever they sent. A change that doesn't name one of the site's own
 * hosts as its origin, or isn't sent as JSON, is refused before its body or
 * the database is read. Every answer is no-store.
 */
import type { ResolvedTeamConfig, TeamUser } from '../config';
import type { TeamView } from '../nav';
import { apiError, fromOwnPage, json, notFound, readJsonObject, unavailable } from './http';
import { Refused, type Me, type TeamCore } from './team';

export type RouteHandler = (request: Request) => Promise<Response>;
export type TeamRouteHandlers = Readonly<{ GET: RouteHandler; POST: RouteHandler; PATCH: RouteHandler; DELETE: RouteHandler }>;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The route under basePath with no slashes at either end ('' is the page), split in parts. Null outside basePath. */
function partsOf(request: Request, basePath: string): string[] | null {
  const { pathname } = new URL(request.url);
  if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return null;
  const rest = pathname.slice(basePath.length).replace(/^\/+|\/+$/g, '');
  if (!rest) return [];
  try {
    return rest.split('/').map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function refusal(error: Refused): Response {
  return apiError(error.type, error.code, error.message, { ...(error.hint ? { hint: error.hint } : {}), ...(error.param ? { param: error.param } : {}) });
}

export function createRouteHandlers<User extends TeamUser>(config: ResolvedTeamConfig<User>, core: TeamCore<User>): TeamRouteHandlers {
  /** The person, if they may open the Team page right now; else the answer to send. */
  async function manager(request: Request, fresh: boolean): Promise<{ me: Me; massAccess: boolean; view: TeamView } | Response> {
    let user: User | null;
    try {
      user = await config.signedInUser(request, { fresh });
    } catch (error) {
      core.logOnce('session', '[Team] could not check the session', error);
      return unavailable();
    }
    if (!user || typeof user.id !== 'string' || !user.id || user.viewedAs) return notFound();
    const view = await core.view(user);
    if (!core.managesTeam(view)) return notFound();
    return { me: { id: user.id, name: typeof user.name === 'string' ? user.name : null, massAccess: view.massAccess }, massAccess: view.massAccess, view };
  }

  async function run(work: () => Promise<Response>): Promise<Response> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Refused) return refusal(error);
      config.log('[Team] a request was not answered', error);
      return unavailable();
    }
  }

  async function handleGet(request: Request, parts: string[]): Promise<Response> {
    if (parts.length === 1 && parts[0] === 'me') {
      let user: User | null;
      try {
        user = await config.signedInUser(request, { fresh: false });
      } catch (error) {
        core.logOnce('session', '[Team] could not check the session', error);
        return unavailable();
      }
      if (!user || typeof user.id !== 'string' || !user.id) return notFound();
      return json(await core.view(user));
    }
    if (parts.length === 0) {
      const who = await manager(request, false);
      if (who instanceof Response) return who;
      return run(async () => json(await core.state(who.me, who.view)));
    }
    if (parts.length === 1 && parts[0] === 'history') {
      const who = await manager(request, false);
      if (who instanceof Response) return who;
      if (!who.massAccess) return notFound();
      const before = new URL(request.url).searchParams.get('before');
      if (before !== null && !/^\d{1,18}$/.test(before)) return apiError('invalid_request', 'invalid_parameter', 'Reload the page and try again.', { param: 'before' });
      return run(async () => json(await core.history(before)));
    }
    return notFound();
  }

  /** A change: from the site's own pages, as JSON, by someone who can open the Team page right now. */
  async function handleWrite(method: Exclude<Method, 'GET'>, request: Request, parts: string[]): Promise<Response> {
    const [kind, id, ...extra] = parts;
    const known =
      extra.length === 0 &&
      ((kind === 'employees' && (method === 'POST' ? id === undefined : id !== undefined)) ||
        (kind === 'roles' && (method === 'POST' ? id === undefined : id !== undefined)));
    if (!known) return notFound();
    // Who is asking comes first: someone who may not open the Team page gets
    // the unknown-route answer whatever they sent, so a refusal below never
    // tells them a route is here.
    const who = await manager(request, true);
    if (who instanceof Response) return who;
    const me = who.me;
    if (!fromOwnPage(request.headers, config.siteHosts)) {
      return apiError('permission', 'cross_site', "This change came from a page we don't trust, so it wasn't made.");
    }
    // The page sends every change as JSON, a DELETE too. Another site's form
    // can't: a browser asks this site first before it sends that header.
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
      return apiError('permission', 'not_json', "This change wasn't sent the way the Team page sends it, so it wasn't made.");
    }

    let body: Record<string, unknown> = {};
    if (method !== 'DELETE') {
      const parsed = await readJsonObject(request);
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    const query = new URL(request.url).searchParams;

    return run(async () => {
      if (kind === 'employees') {
        if (method === 'POST') return json(await core.addEmployee(me, body), 201);
        if (method === 'PATCH') return json(await core.manageEmployee(me, id!, body));
        await core.removeEmployee(me, id!, query.get('token') ?? '');
        return json({ removed: true });
      }
      if (method === 'POST') return json(await core.createRole(me, body), 201);
      if (method === 'PATCH') return json(await core.editRole(me, id!, body));
      await core.deleteRole(me, id!, Number(query.get('version')));
      return json({ deleted: true });
    });
  }

  function handler(method: Method): RouteHandler {
    return async (request: Request) => {
      try {
        const parts = partsOf(request, config.basePath);
        if (!parts) return notFound();
        return method === 'GET' ? await handleGet(request, parts) : await handleWrite(method, request, parts);
      } catch (error) {
        // An app hook threw where nothing else caught it: still a plain answer, never a crash.
        config.log('[Team] a request was not answered', error);
        return unavailable();
      }
    };
  }

  return { GET: handler('GET'), POST: handler('POST'), PATCH: handler('PATCH'), DELETE: handler('DELETE') };
}
