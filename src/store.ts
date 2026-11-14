import {
  buildCommit,
  buildTag,
  buildTreeFromFiles,
  collectReachable,
  flattenTree,
  isAncestor,
  mergeBase,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  storeObject,
  ZERO_OID,
  type ObjType,
  type StoredObject,
} from './gitcore.ts';
import { HttpError, conflict, isoOf, notFound, unprocessable } from './util.ts';

// The authenticated user. The suite's scenario is drawn once from a fixed
// seed, so the viewer is the same in every trial: login adaiversen.
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const BASE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, the scenario epoch.

const DEFAULT_LABELS: { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  isDefault: boolean;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAtEpoch: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  refs: Map<string, string>;
  objects: Map<string, StoredObject>;
  deflated: Map<string, Buffer>;
  /** Whole v2 fetch responses, keyed by the fetch inputs. Cleared on any git mutation. */
  fetchCache: Map<string, Buffer>;
  labels: Label[];
  nextLabelId: number;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export function nodeId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeNodeId(value: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function identityLine(epoch: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;
  seq = 0;

  /** Advance the logical clock once and return the new epoch second. */
  tick(): number {
    this.seq += 1;
    return BASE_EPOCH + this.seq;
  }

  epochOf(seq: number): number {
    return BASE_EPOCH + seq;
  }

  isoOfSeq(seq: number): string {
    return isoOf(this.epochOf(seq));
  }

  // ---------------------------------------------------------------- repos

  createRepo(name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) throw unprocessable('Repository already exists');
    const createdSeq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch,
      createdSeq,
      updatedSeq: createdSeq,
      refs: new Map(),
      objects: new Map(),
      deflated: new Map(),
      fetchCache: new Map(),
      labels: DEFAULT_LABELS.map((label, i) => ({ id: i + 1, ...label, isDefault: true })),
      nextLabelId: DEFAULT_LABELS.length + 1,
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.getRepo(owner, name);
    if (!repo) throw notFound('Not Found');
    return repo;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  updateRepo(repo: Repo, patch: { description?: string; isPrivate?: boolean; defaultBranch?: string }): void {
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.isPrivate !== undefined) repo.isPrivate = patch.isPrivate;
    if (patch.defaultBranch !== undefined) repo.defaultBranch = patch.defaultBranch;
    repo.updatedSeq = this.tick();
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  /** Drop cached fetch responses after any change to refs or objects. */
  touchGit(repo: Repo): void {
    repo.fetchCache.clear();
  }

  // ---------------------------------------------------------------- refs

  /** Resolve a branch name, full ref, tag name or commit SHA to a commit oid (tags are peeled). */
  resolveRef(repo: Repo, ref: string | undefined | null): string | null {
    let oid: string | null = null;
    if (ref === undefined || ref === null || ref === '') {
      oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    } else if (/^[0-9a-f]{40}$/.test(ref)) {
      oid = repo.objects.has(ref) ? ref : null;
    } else if (ref.startsWith('refs/')) {
      oid = repo.refs.get(ref) ?? null;
    } else {
      oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
    }
    // Peel annotated tags down to the commit they point at.
    for (let hops = 0; hops < 8 && oid !== null; hops += 1) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') {
        if (obj?.type === 'tag') {
          oid = parseTag(obj.data).object;
          continue;
        }
        return null;
      }
      return oid;
    }
    return oid;
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (!ref.startsWith('refs/')) throw unprocessable('Invalid ref name');
    if (!repo.objects.has(sha)) throw unprocessable('Object does not exist');
    if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    this.touchGit(repo);
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** Commits reachable from `ref`, newest first. */
  listCommits(repo: Repo, ref: string | undefined | null): { sha: string; info: ReturnType<typeof parseCommit> }[] {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: { sha: string; info: ReturnType<typeof parseCommit> }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      out.push({ sha: oid, info });
      for (const parent of info.parents) queue.push(parent);
    }
    return out;
  }

  // ---------------------------------------------------------------- git writes

  /** Create a commit object in the repo and store it. Returns the commit oid. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const epoch = this.tick();
    const line = identityLine(epoch);
    const data = buildCommit(treeOid, parents, line, line, message);
    return storeObject(repo.objects, 'commit', data);
  }

  /** The file map at a commit, or an empty map for an unborn branch. */
  filesAt(repo: Repo, tip: string | null): Map<string, { oid: string; mode: string }> {
    if (!tip) return new Map();
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(obj.data).tree);
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    // Creating a label that already exists returns the existing label (with
    // the posted colour/description applied), the way the suite drives it.
    const existing = repo.labels.find((label) => label.name === name);
    if (existing) {
      existing.color = color;
      existing.description = description;
      return existing;
    }
    const label: Label = { id: repo.nextLabelId, name, color, description, isDefault: false };
    repo.nextLabelId += 1;
    repo.labels.push(label);
    return label;
  }

  findLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.find((label) => label.name === name);
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = this.findLabel(repo, name);
      if (!label) throw unprocessable(`Label does not exist: ${name}`);
      labels.push(label);
    }
    const createdSeq = this.tick();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels,
      createdSeq,
      updatedSeq: createdSeq,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = this.getIssue(repo, number);
    if (!issue) throw notFound('Not Found');
    return issue;
  }

  patchIssue(repo: Repo, issue: Issue, patch: { title?: string; body?: string; state?: string }): void {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    issue.updatedSeq = this.tick();
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const createdSeq = this.tick();
    const comment: Comment = { id: repo.nextCommentId, body, createdSeq, updatedSeq: createdSeq };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  private stripOwnerPrefix(ref: string): string {
    const colon = ref.indexOf(':');
    if (colon !== -1) {
      const owner = ref.slice(0, colon);
      if (owner === VIEWER.login) return ref.slice(colon + 1);
    }
    return ref;
  }

  createPull(repo: Repo, title: string, head: string, base: string, body: string): Pull {
    const headRef = this.stripOwnerPrefix(head);
    const baseRef = this.stripOwnerPrefix(base);
    if (!repo.refs.has(`refs/heads/${headRef}`)) throw unprocessable(`Head branch does not exist: ${headRef}`);
    if (!repo.refs.has(`refs/heads/${baseRef}`)) throw unprocessable(`Base branch does not exist: ${baseRef}`);
    const createdSeq = this.tick();
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAtEpoch: null,
      mergeCommitSha: null,
      createdSeq,
      updatedSeq: createdSeq,
    };
    this.nextGlobalId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  requirePull(repo: Repo, number: number): Pull {
    const pull = this.getPull(repo, number);
    if (!pull) throw notFound('Not Found');
    return pull;
  }

  headSha(repo: Repo, pull: Pull): string | null {
    return repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  }

  baseSha(repo: Repo, pull: Pull): string | null {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  }

  /** The files changed between the base tip tree and the head tip tree. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const head = this.headSha(repo, pull);
    const base = this.baseSha(repo, pull);
    if (!head || !base) return [];
    const headFiles = this.filesAt(repo, head);
    const baseFiles = this.filesAt(repo, base);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const oldFile = baseFiles.get(path);
      const newFile = headFiles.get(path);
      if (!oldFile && newFile) {
        const lines = countLines(repo, newFile.oid);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (oldFile && !newFile) {
        const lines = countLines(repo, oldFile.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (oldFile && newFile && oldFile.oid !== newFile.oid) {
        const { additions, deletions } = diffLines(repo, oldFile.oid, newFile.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Three-way conflict check: both sides changed the same path differently from the merge base. */
  pullConflicts(repo: Repo, pull: Pull): string[] {
    const head = this.headSha(repo, pull);
    const base = this.baseSha(repo, pull);
    if (!head || !base) return [];
    const baseCommit = mergeBase(repo.objects, head, base);
    const baseFiles = baseCommit ? this.filesAt(repo, baseCommit) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.filesAt(repo, head);
    const baseTipFiles = this.filesAt(repo, base);
    const conflicts: string[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path)?.oid ?? null;
      const headOid = headFiles.get(path)?.oid ?? null;
      const baseOid = baseTipFiles.get(path)?.oid ?? null;
      const headChanged = headOid !== ancestor;
      const baseChanged = baseOid !== ancestor;
      if (headChanged && baseChanged && headOid !== baseOid) conflicts.push(path);
    }
    return conflicts;
  }

  isMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open' || pull.merged) return false;
    return this.pullConflicts(repo, pull).length === 0;
  }

  /** Squash-merge the pull onto its base branch. Returns the squash commit oid. */
  mergePull(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') throw new HttpError(405, 'Pull request is already closed');
    if (pull.merged) throw new HttpError(405, 'Pull request is already merged');
    const conflicts = this.pullConflicts(repo, pull);
    if (conflicts.length) throw new HttpError(405, 'Merge conflict');
    const head = this.headSha(repo, pull);
    const base = this.baseSha(repo, pull);
    if (!head || !base) throw new HttpError(405, 'Merge conflict');
    const headFiles = this.filesAt(repo, head);
    const treeOid = buildTreeFromFiles(repo.objects, headFiles);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const squash = this.makeCommit(repo, treeOid, [base], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, squash);
    this.touchGit(repo);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = squash;
    pull.mergedAtEpoch = this.epochOf(this.seq);
    pull.updatedSeq = this.tick();
    return squash;
  }

  // ---------------------------------------------------------------- contents

  /** Look up one path inside a tree: returns the blob or subtree oid, or null. */
  lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string; isDir: boolean } | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode, isDir: entry.isDir };
      if (!entry.isDir) return null;
      current = entry.oid;
    }
    return { oid: current, mode: '40000', isDir: true };
  }

  putContent(
    repo: Repo,
    path: string,
    contentBase64: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { blobSha: string; commitSha: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName) ?? null;
    const files = this.filesAt(repo, tip);
    const existing = files.get(path);
    if (existing) {
      if (sha === undefined || sha !== existing.oid) throw conflict('sha does not match');
    } else if (sha !== undefined) {
      throw unprocessable('sha does not match a file that does not exist');
    }
    const blobSha = storeObject(repo.objects, 'blob', contentBase64);
    files.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const commitSha = this.makeCommit(repo, treeOid, tip ? [tip] : [], message);
    repo.refs.set(refName, commitSha);
    this.touchGit(repo);
    return { blobSha, commitSha, created: !existing };
  }

  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName) ?? null;
    const files = this.filesAt(repo, tip);
    const existing = files.get(path);
    if (!existing) throw notFound('Not Found');
    if (sha !== undefined && sha !== existing.oid) throw conflict('sha does not match');
    files.delete(path);
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const commitSha = this.makeCommit(repo, treeOid, tip ? [tip] : [], message);
    repo.refs.set(refName, commitSha);
    this.touchGit(repo);
    return { commitSha };
  }

  // ---------------------------------------------------------------- view builders

  repoJson(repo: Repo, origin: string): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: nodeId('Repository', repo.id),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      fork: false,
      created_at: this.isoOfSeq(repo.createdSeq),
      updated_at: this.isoOfSeq(repo.updatedSeq),
      pushed_at: this.isoOfSeq(repo.updatedSeq),
      homepage: null,
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      forks_count: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
      default_branch: repo.defaultBranch,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
      html_url: `${origin}/${repo.owner}/${repo.name}`,
      clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
      git_url: `${origin}/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${repo.owner}/${repo.name}.git`,
    };
  }

  labelJson(label: Label): Record<string, unknown> {
    return {
      id: label.id,
      node_id: nodeId('Label', label.id),
      name: label.name,
      color: label.color,
      description: label.description,
      default: label.isDefault,
    };
  }

  issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: nodeId('Issue', repo.id, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: { login: VIEWER.login, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), type: 'User' },
      labels: issue.labels.map((label) => this.labelJson(label)),
      assignee: null,
      locked: false,
      comments: issue.comments.length,
      created_at: this.isoOfSeq(issue.createdSeq),
      updated_at: this.isoOfSeq(issue.updatedSeq),
      closed_at: issue.state === 'closed' ? this.isoOfSeq(issue.updatedSeq) : null,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  commentJson(repo: Repo, issue: Issue, comment: Comment, origin: string): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: nodeId('IssueComment', repo.id, issue.number, comment.id),
      body: comment.body,
      user: { login: VIEWER.login, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), type: 'User' },
      created_at: this.isoOfSeq(comment.createdSeq),
      updated_at: this.isoOfSeq(comment.updatedSeq),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    };
  }

  pullJson(repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
    const headSha = this.headSha(repo, pull);
    const baseSha = this.baseSha(repo, pull);
    return {
      id: pull.id,
      node_id: nodeId('PullRequest', repo.id, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      user: { login: VIEWER.login, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), type: 'User' },
      head: {
        label: `${repo.owner}:${pull.headRef}`,
        ref: pull.headRef,
        sha: headSha,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        repo: this.repoJson(repo, origin),
      },
      base: {
        label: `${repo.owner}:${pull.baseRef}`,
        ref: pull.baseRef,
        sha: baseSha,
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        repo: this.repoJson(repo, origin),
      },
      merged: pull.merged,
      mergeable: this.isMergeable(repo, pull),
      merged_at: pull.mergedAtEpoch === null ? null : isoOf(pull.mergedAtEpoch),
      merge_commit_sha: pull.mergeCommitSha,
      created_at: this.isoOfSeq(pull.createdSeq),
      updated_at: this.isoOfSeq(pull.updatedSeq),
      closed_at: pull.state === 'closed' ? this.isoOfSeq(pull.updatedSeq) : null,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    };
  }

  commitJson(repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    const authorEpoch = parseIdentityEpoch(info.author);
    const committerEpoch = parseIdentityEpoch(info.committer);
    return {
      sha,
      node_id: nodeId('Commit', repo.id, sha),
      commit: {
        // The stored object ends its message with a newline (git convention);
        // the REST view reports the message without it.
        message: info.message.replace(/\n+$/, ''),
        author: {
          name: parseIdentityName(info.author),
          email: parseIdentityEmail(info.author),
          date: authorEpoch === null ? null : isoOf(authorEpoch),
        },
        committer: {
          name: parseIdentityName(info.committer),
          email: parseIdentityEmail(info.committer),
          date: committerEpoch === null ? null : isoOf(committerEpoch),
        },
        tree: { sha: info.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      parents: info.parents.map((parent) => ({ sha: parent })),
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    };
  }
}

function countLines(repo: Repo, blobOid: string): number {
  const obj = repo.objects.get(blobOid);
  if (!obj || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A simple multiset line diff: lines only in the new blob count as added, only in the old as deleted. */
function diffLines(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const oldObj = repo.objects.get(oldOid);
  const newObj = repo.objects.get(newOid);
  const oldText = oldObj?.type === 'blob' ? oldObj.data.toString('utf8') : '';
  const newText = newObj?.type === 'blob' ? newObj.data.toString('utf8') : '';
  const split = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

export function parseIdentityEpoch(line: string): number | null {
  const match = line.match(/ (\d+) [+-]\d{4}$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parseIdentityName(line: string): string {
  const lt = line.indexOf('<');
  return lt === -1 ? line : line.slice(0, lt).trim();
}

function parseIdentityEmail(line: string): string {
  const match = line.match(/<([^>]*)>/);
  return match ? match[1] : '';
}

export { ZERO_OID, parseTag };
export type { ObjType, StoredObject };
