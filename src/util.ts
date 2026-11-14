import type { IncomingMessage, ServerResponse } from 'node:http';

/** A JSON error the handlers raise; the router turns it into a JSON body. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.body = { message };
  }
}

export function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message = 'Bad Request'): HttpError {
  return new HttpError(400, message);
}

export function unauthorized(message = 'Bad credentials'): HttpError {
  return new HttpError(401, message);
}

export function unprocessable(message: string): HttpError {
  return new HttpError(422, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

let requestCounter = 0;

/** A unique, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Read the whole request body as bytes. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON. Empty bodies become {}. Malformed JSON throws 400. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw badRequest('Problems parsing JSON');
  }
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  return parseJsonText(raw.toString('utf8'));
}

export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  };
}

export function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, jsonHeaders(extra));
  res.end(body);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': nextRequestId(), ...extra });
  res.end(body);
}

/** Send an HttpError (or a 500 for anything unexpected) as a JSON body. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, err.body);
    return;
  }
  sendJson(res, 500, { message: 'Internal Server Error' });
}

/** Parse ?page=&per_page= the way GitHub does: page >= 1, per_page 1..100, defaults 1/30. */
export function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) ? Math.min(100, Math.max(1, perRaw)) : 30;
  return { page, perPage };
}

/** Slice a list for one page and build GitHub-style Link headers. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; totalPages: number; total: number } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { pageItems, totalPages, total };
}

/** Build a Link header value for pagination. `base` is the absolute URL without query. */
export function buildLinkHeader(base: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string | null {
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return links.length ? links.join(', ') : null;
}

/** Format an epoch-seconds timestamp as an ISO 8601 string. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** Split a base64 blob body into bytes; throws 422 on bad base64. */
export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string') throw unprocessable('content must be a base64 string');
  const clean = value.replace(/\s+/g, '');
  if (clean !== '' && !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw unprocessable('content is not valid base64');
  return Buffer.from(clean, 'base64');
}

/** The origin (scheme://host) of the incoming request, for absolute pagination links. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
