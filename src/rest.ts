import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitcore.ts';
import { Store, VIEWER, nodeId, type Repo } from './store.ts';
import {
  HttpError,
  badRequest,
  buildLinkHeader,
  decodeBase64,
  nextRequestId,
  notFound,
  paginate,
  pagination,
  readJson,
  requestOrigin,
  sendJson,
  unauthorized,
  unprocessable,
} from './util.ts';

function checkAuth(req: IncomingMessage, token: string): void {
  const header = req.headers.authorization ?? '';
  if (header !== `Bearer ${token}`) throw unauthorized();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function sortIssues<T extends { createdSeq: number; updatedSeq: number; number: number }>(
  items: T[],
  sort: string,
  direction: string,
): T[] {
  const dir = direction === 'asc' ? 1 : -1;
  const key = (item: T): number => (sort === 'updated' ? item.updatedSeq : item.createdSeq);
  return [...items].sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return diff * dir;
    return (a.number - b.number) * dir;
  });
}

/**
 * Handle a REST v3 request. Returns true when the path was a REST route
 * (even when it ends in an error response), false otherwise.
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  const rest = path.slice('/api/v3'.length) || '/';
  try {
    checkAuth(req, token);
    const origin = requestOrigin(req);
    const method = req.method ?? 'GET';

    // ---- API root and meta -------------------------------------------------
    if (rest === '/' && method === 'GET') {
      sendJson(res, 200, {
        current_user_url: `${origin}/api/v3/user`,
        current_user_authorizations_html_url: `${origin}/settings/tokens`,
        authorizations_url: `${origin}/api/v3/authorizations`,
        code_search_url: `${origin}/api/v3/search/code?q={query}`,
        commit_search_url: `${origin}/api/v3/search/commits?q={query}`,
        emails_url: `${origin}/api/v3/user/emails`,
        emojis_url: `${origin}/api/v3/emojis`,
        events_url: `${origin}/api/v3/events`,
        feeds_url: `${origin}/api/v3/feeds`,
        followers_url: `${origin}/api/v3/user/followers`,
        following_url: `${origin}/api/v3/user/following{/target}`,
        gists_url: `${origin}/api/v3/gists{/gist_id}`,
        hub_url: `${origin}/api/v3/hub`,
        issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
        issues_url: `${origin}/api/v3/issues`,
        keys_url: `${origin}/api/v3/user/keys`,
        label_search_url: `${origin}/api/v3/search/labels?q={query}`,
        notifications_url: `${origin}/api/v3/notifications`,
        organization_url: `${origin}/api/v3/orgs/{org}`,
        public_gists_url: `${origin}/api/v3/gists/public`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${origin}/api/v3/search/repositories?q={query}`,
        current_user_repositories_url: `${origin}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${origin}/api/v3/gists/starred`,
        topic_search_url: `${origin}/api/v3/search/topics?q={query}`,
        user_url: `${origin}/api/v3/users/{user}`,
        user_organizations_url: `${origin}/api/v3/users/{user}/orgs`,
        user_repositories_url: `${origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${origin}/api/v3/search/users?q={query}`,
      });
      return true;
    }
    if (rest === '/meta' && method === 'GET') {
      sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
      return true;
    }
    if (rest === '/user' && method === 'GET') {
      sendJson(res, 200, userJson());
      return true;
    }

    // ---- /user/repos -------------------------------------------------------
    if (rest === '/user/repos') {
      if (method === 'GET') {
        const { page, perPage } = pagination(query);
        const repos = store.listRepos();
        const { pageItems, totalPages } = paginate(repos, page, perPage);
        const link = buildLinkHeader(`${origin}/api/v3/user/repos`, query, page, perPage, totalPages);
        sendJson(
          res,
          200,
          pageItems.map((repo) => store.repoJson(repo, origin)),
          link ? { link } : {},
        );
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (!isRecord(body)) throw badRequest('Invalid request body');
        const name = stringField(body, 'name');
        if (!name) throw unprocessable('name is required');
        const repo = store.createRepo(
          name,
          boolField(body, 'private') ?? false,
          stringField(body, 'description') ?? '',
          stringField(body, 'default_branch') ?? 'main',
        );
        sendJson(res, 201, store.repoJson(repo, origin));
        return true;
      }
    }

    // ---- /repos/:owner/:name/... ------------------------------------------
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
    if (repoMatch) {
      const owner = decodeURIComponent(repoMatch[1]);
      const name = decodeURIComponent(repoMatch[2]);
      const tail = repoMatch[3] ?? '';
      const repo = store.requireRepo(owner, name);

      if (tail === '' || tail === '/') {
        if (method === 'GET') {
          sendJson(res, 200, store.repoJson(repo, origin));
          return true;
        }
        if (method === 'PATCH') {
          const body = await readJson(req);
          if (!isRecord(body)) throw badRequest('Invalid request body');
          store.updateRepo(repo, {
            description: stringField(body, 'description'),
            isPrivate: boolField(body, 'private'),
            defaultBranch: stringField(body, 'default_branch'),
          });
          sendJson(res, 200, store.repoJson(repo, origin));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(repo);
          sendNoContent(res);
          return true;
        }
        throw new HttpError(405, 'Method Not Allowed');
      }

      if (await handleRepoSub(req, res, store, repo, origin, tail, method, query)) return true;
      return true;
    }

    throw notFound();
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, err.body);
      return true;
    }
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}

async function handleRepoSub(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  origin: string,
  tail: string,
  method: string,
  query: URLSearchParams,
): Promise<boolean> {
  const segments = tail.split('/').filter((segment) => segment !== '');

  // ---- branches ------------------------------------------------------------
  if (segments[0] === 'branches') {
    if (segments.length === 1 && method === 'GET') {
      const branches = store.listBranches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha },
        protected: false,
      }));
      sendJson(res, 200, branches);
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      const branchName = decodeURIComponent(segments[1]);
      const found = store.listBranches(repo).find((branch) => branch.name === branchName);
      if (!found) throw notFound('Branch not found');
      sendJson(res, 200, { name: found.name, commit: { sha: found.sha }, protected: false });
      return true;
    }
    throw notFound();
  }

  // ---- commits -------------------------------------------------------------
  if (segments[0] === 'commits') {
    if (segments.length === 1 && method === 'GET') {
      const { page, perPage } = pagination(query);
      const commits = store.listCommits(repo, query.get('sha') ?? undefined);
      const { pageItems, totalPages } = paginate(commits, page, perPage);
      const link = buildLinkHeader(`${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits`, query, page, perPage, totalPages);
      sendJson(
        res,
        200,
        pageItems.map((commit) => store.commitJson(repo, commit.sha, origin)),
        link ? { link } : {},
      );
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      const sha = decodeURIComponent(segments[1]);
      const found = store.commitJson(repo, sha, origin);
      if (!found) throw notFound('Not Found');
      sendJson(res, 200, found);
      return true;
    }
    throw notFound();
  }

  // ---- contents ------------------------------------------------------------
  if (segments[0] === 'contents') {
    const contentPath = segments.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    const ref = query.get('ref') ?? undefined;
    if (method === 'GET') {
      return getContent(req, res, store, repo, origin, contentPath, ref);
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      if (contentPath === '') throw unprocessable('path is required');
      const content = body['content'];
      if (content === undefined) throw unprocessable('content is required');
      const data = decodeBase64(content);
      const message = stringField(body, 'message') ?? `Update ${contentPath}`;
      const branch = stringField(body, 'branch') ?? ref;
      const sha = stringField(body, 'sha');
      const result = store.putContent(repo, contentPath, data, message, branch, sha);
      sendJson(res, result.created ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: result.blobSha,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
        },
        commit: { sha: result.commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      if (contentPath === '') throw unprocessable('path is required');
      const message = stringField(body, 'message') ?? `Delete ${contentPath}`;
      const branch = stringField(body, 'branch') ?? ref;
      const sha = stringField(body, 'sha');
      const result = store.deleteContent(repo, contentPath, message, branch, sha);
      sendJson(res, 200, { commit: { sha: result.commitSha, message } });
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  // ---- labels --------------------------------------------------------------
  if (segments[0] === 'labels') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, repo.labels.map((label) => store.labelJson(label)));
      return true;
    }
    if (segments.length === 1 && method === 'POST') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      const name = stringField(body, 'name');
      if (!name) throw unprocessable('name is required');
      const label = store.createLabel(
        repo,
        name,
        stringField(body, 'color') ?? 'ededed',
        stringField(body, 'description') ?? '',
      );
      sendJson(res, 201, store.labelJson(label));
      return true;
    }
    if (segments.length === 2 && method === 'GET') {
      const label = store.findLabel(repo, decodeURIComponent(segments[1]));
      if (!label) throw notFound('Not Found');
      sendJson(res, 200, store.labelJson(label));
      return true;
    }
    throw notFound();
  }

  // ---- issues --------------------------------------------------------------
  if (segments[0] === 'issues') {
    return handleIssues(req, res, store, repo, origin, segments.slice(1), method, query);
  }

  // ---- pulls ---------------------------------------------------------------
  if (segments[0] === 'pulls') {
    return handlePulls(req, res, store, repo, origin, segments.slice(1), method, query);
  }

  // ---- git refs ------------------------------------------------------------
  if (segments[0] === 'git') {
    if (segments[1] === 'refs' && method === 'POST' && segments.length === 2) {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref || !sha) throw unprocessable('ref and sha are required');
      store.createRef(repo, ref, sha);
      const obj = repo.objects.get(sha);
      sendJson(res, 201, {
        ref,
        node_id: nodeId('Ref', repo.id, ref),
        url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: obj?.type ?? 'commit', url: '' },
      });
      return true;
    }
    if ((segments[1] === 'refs' || segments[1] === 'ref') && method === 'GET' && segments.length >= 3) {
      const refName = `refs/${segments.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
      const sha = repo.refs.get(refName);
      if (!sha) throw notFound('Not Found');
      const obj = repo.objects.get(sha);
      sendJson(res, 200, {
        ref: refName,
        node_id: nodeId('Ref', repo.id, refName),
        url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName.replace(/^refs\//, '')}`,
        object: { sha, type: obj?.type ?? 'commit', url: '' },
      });
      return true;
    }
    if (segments[1] === 'matching-refs' && method === 'GET' && segments.length >= 3) {
      const prefix = `refs/${segments.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
      const matches: Record<string, unknown>[] = [];
      for (const [refName, sha] of repo.refs) {
        if (!refName.startsWith(prefix)) continue;
        const obj = repo.objects.get(sha);
        matches.push({ ref: refName, object: { sha, type: obj?.type ?? 'commit', url: '' } });
      }
      sendJson(res, 200, matches);
      return true;
    }
    throw notFound();
  }

  throw notFound();
}

function getContent(
  _req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  origin: string,
  contentPath: string,
  ref: string | undefined,
): boolean {
  const tip = store.resolveRef(repo, ref);
  if (!tip) throw notFound('Not Found');
  const tipObj = repo.objects.get(tip);
  if (!tipObj || tipObj.type !== 'commit') throw notFound('Not Found');
  const treeOid = parseCommit(tipObj.data).tree;
  if (contentPath === '') {
    sendJson(res, 200, listDirectory(store, repo, treeOid, ''));
    return true;
  }
  const found = store.lookupPath(repo, treeOid, contentPath);
  if (!found) throw notFound('Not Found');
  if (found.isDir) {
    sendJson(res, 200, listDirectory(store, repo, found.oid, contentPath));
    return true;
  }
  const obj = repo.objects.get(found.oid);
  if (!obj || obj.type !== 'blob') throw notFound('Not Found');
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    size: obj.data.length,
    name: contentPath.split('/').pop(),
    path: contentPath,
    content: obj.data.toString('base64'),
    sha: found.oid,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${contentPath}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${contentPath}`,
  });
  return true;
}

function listDirectory(store: Store, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const entries = parseTree(obj.data);
  return entries.map((entry) => {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const blob = entry.isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: entry.isDir ? 'dir' : 'file',
      size: entry.isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
    };
  });
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  origin: string,
  segments: string[],
  method: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = repo.issues;
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues = sortIssues(issues, sort, direction);
      const { page, perPage } = pagination(query);
      const { pageItems, totalPages } = paginate(issues, page, perPage);
      const link = buildLinkHeader(`${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, page, perPage, totalPages);
      sendJson(
        res,
        200,
        pageItems.map((issue) => store.issueJson(repo, issue, origin)),
        link ? { link } : {},
      );
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      const title = stringField(body, 'title');
      if (!title) throw unprocessable('title is required');
      const rawLabels = body['labels'];
      const labelNames: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isRecord(entry) && typeof entry['name'] === 'string') labelNames.push(entry['name'] as string);
        }
      }
      const issue = store.createIssue(repo, title, stringField(body, 'body') ?? '', labelNames);
      sendJson(res, 201, store.issueJson(repo, issue, origin));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(segments[0], 10);
  if (!Number.isFinite(number)) throw notFound('Not Found');
  const issue = store.requireIssue(repo, number);

  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, store.issueJson(repo, issue, origin));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      store.patchIssue(repo, issue, {
        title: stringField(body, 'title'),
        body: stringField(body, 'body'),
        state: stringField(body, 'state'),
      });
      sendJson(res, 200, store.issueJson(repo, issue, origin));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  if (segments[1] === 'comments') {
    if (segments.length === 2) {
      if (method === 'GET') {
        const { page, perPage } = pagination(query);
        const { pageItems, totalPages } = paginate(issue.comments, page, perPage);
        const link = buildLinkHeader(
          `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`,
          query,
          page,
          perPage,
          totalPages,
        );
        sendJson(
          res,
          200,
          pageItems.map((comment) => store.commentJson(repo, issue, comment, origin)),
          link ? { link } : {},
        );
        return true;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        if (!isRecord(body)) throw badRequest('Invalid request body');
        const commentBody = stringField(body, 'body');
        if (!commentBody) throw unprocessable('body is required');
        const comment = store.addComment(repo, issue, commentBody);
        sendJson(res, 201, store.commentJson(repo, issue, comment, origin));
        return true;
      }
      throw new HttpError(405, 'Method Not Allowed');
    }
    if (segments.length === 3 && method === 'GET') {
      const commentId = Number.parseInt(segments[2], 10);
      const comment = issue.comments.find((candidate) => candidate.id === commentId);
      if (!comment) throw notFound('Not Found');
      sendJson(res, 200, store.commentJson(repo, issue, comment, origin));
      return true;
    }
  }

  throw notFound();
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  origin: string,
  segments: string[],
  method: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let pulls = repo.pulls;
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls = sortIssues(pulls, sort, direction);
      const { page, perPage } = pagination(query);
      const { pageItems, totalPages } = paginate(pulls, page, perPage);
      const link = buildLinkHeader(`${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, page, perPage, totalPages);
      sendJson(
        res,
        200,
        pageItems.map((pull) => store.pullJson(repo, pull, origin)),
        link ? { link } : {},
      );
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const base = stringField(body, 'base');
      if (!title || !head || !base) throw unprocessable('title, head and base are required');
      const pull = store.createPull(repo, title, head, base, stringField(body, 'body') ?? '');
      sendJson(res, 201, store.pullJson(repo, pull, origin));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  const number = Number.parseInt(segments[0], 10);
  if (!Number.isFinite(number)) throw notFound('Not Found');
  const pull = store.requirePull(repo, number);

  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, store.pullJson(repo, pull, origin));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (!isRecord(body)) throw badRequest('Invalid request body');
      const title = stringField(body, 'title');
      const bodyText = stringField(body, 'body');
      const state = stringField(body, 'state');
      if (title !== undefined) pull.title = title;
      if (bodyText !== undefined) pull.body = bodyText;
      if (state === 'open' || state === 'closed') pull.state = state;
      pull.updatedSeq = store.tick();
      sendJson(res, 200, store.pullJson(repo, pull, origin));
      return true;
    }
    throw new HttpError(405, 'Method Not Allowed');
  }

  if (segments[1] === 'files' && segments.length === 2 && method === 'GET') {
    sendJson(res, 200, store.pullFiles(repo, pull));
    return true;
  }

  if (segments[1] === 'merge' && segments.length === 2 && method === 'PUT') {
    const body = await readJson(req);
    if (!isRecord(body)) throw badRequest('Invalid request body');
    const methodName = stringField(body, 'merge_method') ?? 'squash';
    if (methodName !== 'squash' && methodName !== 'merge' && methodName !== 'rebase') {
      throw unprocessable('merge_method must be merge, squash or rebase');
    }
    const sha = store.mergePull(repo, pull);
    sendJson(res, 200, {
      sha,
      merged: true,
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
    return true;
  }

  throw notFound();
}
