import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, type Repo } from './store.ts';
import { HttpError, readBody, sendJson, unauthorized } from './util.ts';

// Model Context Protocol over streamable HTTP (JSON-RPC 2.0). initialize,
// tools/list and tools/call; the tools act on the same store as REST, so
// their effects are visible through the REST view.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        description: { type: 'string', description: 'A short description of the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name, or by full_name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        full_name: { type: 'string', description: 'The owner/name of the repository.' },
      },
      required: [],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        description: { type: 'string', description: 'Alias for body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        number: { type: 'integer', description: 'The issue number.' },
        issue_number: { type: 'integer', description: 'Alias for number.' },
      },
      required: [],
    },
  },
  {
    name: 'close_issue',
    description: 'Close one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        number: { type: 'integer', description: 'The issue number.' },
        issue_number: { type: 'integer', description: 'Alias for number.' },
      },
      required: [],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        number: { type: 'integer', description: 'The issue number.' },
        issue_number: { type: 'integer', description: 'Alias for number.' },
        body: { type: 'string', description: 'The comment text.' },
        comment: { type: 'string', description: 'Alias for body.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        description: { type: 'string', description: 'Alias for body.' },
        head: { type: 'string', description: 'The head branch name.' },
        head_ref: { type: 'string', description: 'Alias for head.' },
        base: { type: 'string', description: 'The base branch name.' },
        base_ref: { type: 'string', description: 'Alias for base.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        number: { type: 'integer', description: 'The pull request number.' },
        pull_number: { type: 'integer', description: 'Alias for number.' },
      },
      required: [],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        owner_login: { type: 'string', description: 'Alias for owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        repository: { type: 'string', description: 'Alias for repo.' },
        number: { type: 'integer', description: 'The pull request number.' },
        pull_number: { type: 'integer', description: 'Alias for number.' },
        merge_method: { type: 'string', description: 'squash, merge or rebase.' },
      },
      required: [],
    },
  },
];

type Args = Record<string, unknown>;

function textArg(args: Args, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numberArg(args: Args, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function boolArg(args: Args, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

/** Resolve owner + repo from any of the accepted spellings. */
function resolveRepoRef(store: Store, args: Args): { owner: string; name: string } {
  let owner = textArg(args, 'owner', 'owner_login');
  let name = textArg(args, 'repo', 'repository', 'name');
  const fullName = textArg(args, 'full_name');
  if (fullName && fullName.includes('/')) {
    const [ownerPart, namePart] = fullName.split('/');
    owner = owner ?? ownerPart;
    name = name ?? namePart;
  }
  return { owner: owner ?? VIEWER.login, name: name ?? '' };
}

function requireToolRepo(store: Store, args: Args): Repo {
  const { owner, name } = resolveRepoRef(store, args);
  if (!name) throw new Error('repo is required');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new Error(`repository not found: ${owner}/${name}`);
  return repo;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolOk(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function callTool(store: Store, origin: string, name: string, args: Args): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new HttpError(-32601, `Unknown tool: ${name}`);
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = textArg(args, 'name', 'repo', 'repository');
        if (!repoName) return toolError('name is required');
        const repo = store.createRepo(repoName, boolArg(args, 'private') ?? false, textArg(args, 'description') ?? '', 'main');
        return toolOk({ ...store.repoJson(repo, origin), full_name: `${repo.owner}/${repo.name}` });
      }
      case 'get_repo': {
        const repo = requireToolRepo(store, args);
        return toolOk({ ...store.repoJson(repo, origin), full_name: `${repo.owner}/${repo.name}` });
      }
      case 'list_repos': {
        const repos = store.listRepos();
        return toolOk({ repositories: repos.map((repo) => store.repoJson(repo, origin)) });
      }
      case 'create_issue': {
        const repo = requireToolRepo(store, args);
        const title = textArg(args, 'title');
        if (!title) return toolError('title is required');
        const rawLabels = args['labels'];
        const labelNames: string[] = [];
        if (Array.isArray(rawLabels)) {
          for (const entry of rawLabels) if (typeof entry === 'string') labelNames.push(entry);
        }
        const issue = store.createIssue(repo, title, textArg(args, 'body', 'description') ?? '', labelNames);
        return toolOk(store.issueJson(repo, issue, origin));
      }
      case 'list_issues': {
        const repo = requireToolRepo(store, args);
        const state = textArg(args, 'state') ?? 'open';
        let issues = repo.issues;
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        return toolOk({ issues: issues.map((issue) => store.issueJson(repo, issue, origin)) });
      }
      case 'get_issue': {
        const repo = requireToolRepo(store, args);
        const number = numberArg(args, 'number', 'issue_number');
        if (number === undefined) return toolError('number is required');
        const issue = store.getIssue(repo, number);
        if (!issue) return toolError(`issue not found: ${number}`);
        return toolOk(store.issueJson(repo, issue, origin));
      }
      case 'close_issue': {
        const repo = requireToolRepo(store, args);
        const number = numberArg(args, 'number', 'issue_number');
        if (number === undefined) return toolError('number is required');
        const issue = store.getIssue(repo, number);
        if (!issue) return toolError(`issue not found: ${number}`);
        store.patchIssue(repo, issue, { state: 'closed' });
        return toolOk(store.issueJson(repo, issue, origin));
      }
      case 'add_comment': {
        const repo = requireToolRepo(store, args);
        const number = numberArg(args, 'number', 'issue_number');
        if (number === undefined) return toolError('number is required');
        const issue = store.getIssue(repo, number);
        if (!issue) return toolError(`issue not found: ${number}`);
        const body = textArg(args, 'body', 'comment');
        if (!body) return toolError('body is required');
        const comment = store.addComment(repo, issue, body);
        return toolOk(store.commentJson(repo, issue, comment, origin));
      }
      case 'create_pull_request': {
        const repo = requireToolRepo(store, args);
        const title = textArg(args, 'title');
        if (!title) return toolError('title is required');
        const head = textArg(args, 'head', 'head_ref');
        if (!head) return toolError('head is required');
        const base = textArg(args, 'base', 'base_ref') ?? repo.defaultBranch;
        const pull = store.createPull(repo, title, head, base, textArg(args, 'body', 'description') ?? '');
        return toolOk(store.pullJson(repo, pull, origin));
      }
      case 'list_pull_requests': {
        const repo = requireToolRepo(store, args);
        const state = textArg(args, 'state') ?? 'open';
        let pulls = repo.pulls;
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        return toolOk({ pull_requests: pulls.map((pull) => store.pullJson(repo, pull, origin)) });
      }
      case 'get_pull_request': {
        const repo = requireToolRepo(store, args);
        const number = numberArg(args, 'number', 'pull_number');
        if (number === undefined) return toolError('number is required');
        const pull = store.getPull(repo, number);
        if (!pull) return toolError(`pull request not found: ${number}`);
        return toolOk(store.pullJson(repo, pull, origin));
      }
      case 'merge_pull_request': {
        const repo = requireToolRepo(store, args);
        const number = numberArg(args, 'number', 'pull_number');
        if (number === undefined) return toolError('number is required');
        const pull = store.getPull(repo, number);
        if (!pull) return toolError(`pull request not found: ${number}`);
        const sha = store.mergePull(repo, pull);
        return toolOk({ sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      }
      default:
        return toolError(`tool not implemented: ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message);
    if (err instanceof Error) return toolError(err.message);
    return toolError('tool call failed');
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
  path: string,
): Promise<boolean> {
  if (path !== '/mcp') return false;
  try {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return true;
    }
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return true;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
      return true;
    }
    const record = body as Record<string, unknown>;
    const id = record['id'];
    const method = record['method'];
    // Notifications carry no id and get an empty 202.
    if (id === undefined || id === null) {
      res.writeHead(202);
      res.end();
      return true;
    }
    if (typeof method !== 'string') {
      sendJson(res, 400, rpcError(id, -32600, 'Invalid Request'));
      return true;
    }
    const params = (record['params'] as Record<string, unknown> | undefined) ?? {};
    if (method === 'initialize') {
      const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forge', version: '1.0.0' },
      }));
      return true;
    }
    if (method === 'ping') {
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    }
    if (method === 'tools/list') {
      // Built from the frozen table, so two calls are byte-identical.
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    if (method === 'tools/call') {
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      const args = (params['arguments'] as Args | undefined) ?? {};
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      try {
        const result = callTool(store, origin, name, args);
        sendJson(res, 200, rpcResult(id, result));
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, 200, rpcError(id, err.status, err.message));
        } else {
          sendJson(res, 200, rpcError(id, -32603, 'Internal error'));
        }
      }
      return true;
    }
    sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
    return true;
  } catch {
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
