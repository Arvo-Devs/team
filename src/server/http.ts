// Answers for the Team routes, in the error body the other imports and
// BetterFans Link's dashboard use ({ error: { type, code, message, hint?,
// param? }, requestId }), so a page that shows those errors shows these the
// same way. Every answer is no-store.
import { randomUUID } from 'node:crypto';

type ErrorType = 'invalid_request' | 'authentication' | 'permission' | 'not_found' | 'conflict' | 'rate_limited' | 'internal';

const STATUS: Record<ErrorType, number> = {
  invalid_request: 400,
  authentication: 401,
  permission: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 503,
};

export const NO_STORE = { 'cache-control': 'no-store' } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function apiError(type: ErrorType, code: string, message: string, extra: { hint?: string; param?: string } = {}): Response {
  const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  return Response.json({ error: { type, code, message, ...extra }, requestId }, { status: STATUS[type], headers: NO_STORE });
}

/** The app's sign-in, its accounts or the database could not be reached. */
export function unavailable(): Response {
  return apiError('internal', 'internal_error', 'The Team page is not answering right now.', { hint: 'Try again in a minute.' });
}

/**
 * The same answer for a route that does not exist and for someone who may
 * not open the Team page, so the address says nothing to them.
 */
export function notFound(): Response {
  return apiError('not_found', 'route_not_found', 'This page does not exist.');
}

/**
 * True when a write came from one of the site's own pages. A browser always
 * names the origin on a cross-site POST, PATCH or DELETE; a request with no
 * origin at all is let through only when it does not say it is cross-site.
 * `siteHosts` are host names; the port is not compared.
 */
export function fromOwnPage(headers: Headers, siteHosts: readonly string[]): boolean {
  if (headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = headers.get('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return siteHosts.includes(host);
}

/** Reads the body up to `max` bytes; null when it is longer. */
export async function readTextUpTo(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON object in the body, or a Response that says what is wrong with it. */
export async function readJsonObject(request: Request, max = 16 * 1024): Promise<Record<string, unknown> | Response> {
  const text = await readTextUpTo(request, max);
  if (text === null) return apiError('invalid_request', 'body_too_large', 'The request is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return apiError('invalid_request', 'invalid_json', 'The request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return apiError('invalid_request', 'invalid_json', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}
