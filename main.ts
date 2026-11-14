import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';
import { sendError, sendJson } from './src/util.ts';

const token = process.env['MAKEFUN_SHOP_TOKEN'] ?? 'test-token';
const envUrl = (process.env['MAKEFUN_ENV_URL'] ?? '').replace(/\/$/, '');

const store = new Store();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const query = url.searchParams;

    if (path === '/healthz' && (req.method ?? 'GET') === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (await handleGit(req, res, store, token, path, query)) return;
    if (await handleRest(req, res, store, token, path, query)) return;
    if (await handleGraphql(req, res, store, token, path)) return;
    if (await handleMcp(req, res, store, token, path)) return;
    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
}

async function register(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) {
        console.error(`registered at ${envUrl} on port ${port}`);
        return true;
      }
      if (response.status === 409) {
        console.error('register got 409: another entry already registered');
        return false;
      }
      console.error(`register got HTTP ${response.status}, retrying`);
    } catch (err) {
      console.error(`register failed (${err instanceof Error ? err.message : 'error'}), retrying`);
    }
    await sleep(500);
  }
  console.error('register never succeeded');
  return false;
}

async function pollDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // The env may not be up yet; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<number> {
  const server = createServer((req, res) => {
    void dispatch(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    console.error('could not read the listen address');
    return 1;
  }
  const port = address.port;
  console.error(`forge listening on 127.0.0.1:${port}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  if (envUrl === '') {
    console.error('MAKEFUN_ENV_URL is unset; serving without registering (local mode)');
    await new Promise<void>(() => undefined);
    return 0;
  }
  await register(port);
  await pollDone();
  console.error('trial done; exiting 0');
  server.close();
  server.closeAllConnections();
  return 0;
}

process.exitCode = await main();
