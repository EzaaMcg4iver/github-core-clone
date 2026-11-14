import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, decodeNodeId, nodeId, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { HttpError, readJson, requestOrigin, sendJson, unauthorized } from './util.ts';

// A small GraphQL executor for the documents gh and github-mcp-server send:
// queries, mutations, variables, aliases, fragments, connections and the
// __type introspection those documents touch. Unknown fields are reported
// in an `errors` array with data null, the way GitHub reports them.

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'fragment';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDef>;
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // String (block strings """...""" included, treated the same).
      let triple = false;
      if (source.slice(i, i + 3) === '"""') triple = true;
      i += triple ? 3 : 1;
      let value = '';
      while (i < source.length) {
        if (triple) {
          if (source.slice(i, i + 3) === '"""') {
            i += 3;
            break;
          }
          value += source[i];
          i += 1;
          continue;
        }
        const c = source[i];
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < source.length) {
          const next = source[i + 1];
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (next === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += escapes[next] ?? next;
            i += 2;
          }
          continue;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentDef> = {};
    while (this.peek() !== null) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.expectName();
        const variables = this.parseVariableDefinitions();
        operations.push({ operation, name, variables, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName("'on'");
        if (on !== 'on') throw new Error('expected on');
        const typeCondition = this.expectName('type condition');
        fragments[name] = { name, typeCondition, selection: this.parseSelectionSet() };
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue: ValueNode | null }[] {
    const defs: { name: string; defaultValue: ValueNode | null }[] = [];
    if (!this.matchPunct('(')) return defs;
    while (true) {
      if (this.matchPunct(')')) break;
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type');
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      if (this.matchPunct('}')) break;
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value !== 'on') {
        return { kind: 'fragment', name: this.expectName('fragment name') };
      }
      let typeCondition: string | null = null;
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName('type condition');
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
    }
    const name = this.expectName('field name');
    let alias: string | null = null;
    let fieldName = name;
    if (this.matchPunct(':')) {
      alias = name;
      fieldName = this.expectName('field name');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name: fieldName, args, selection };
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName('directive');
      this.parseArguments();
    }
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.matchPunct('(')) return args;
    while (true) {
      if (this.matchPunct(')')) break;
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName('object field');
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- execution

class GraphQLError extends Error {}

interface Ctx {
  store: Store;
  origin: string;
}

type AnyObj = Record<string, unknown> & { __typename?: string };

function isPlainObject(value: unknown): value is AnyObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldError(name: string, typeName: string): GraphQLError {
  return new GraphQLError(`Cannot query field "${name}" on type "${typeName}".`);
}

function resolveField(source: AnyObj, field: FieldNode, ctx: Ctx, variables: Record<string, unknown>): unknown {
  const typeName = source.__typename ?? 'Unknown';
  if (field.name === '__typename') return typeName;
  if (field.name === '__type') {
    const args = resolveArgs(field.args, variables);
    return introspectType(String(args['name'] ?? ''));
  }
  if (field.name === '__schema') {
    return { __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] };
  }
  if (!(field.name in source)) throw fieldError(field.name, typeName);
  const raw = source[field.name];
  const args = resolveArgs(field.args, variables);
  if (typeof raw === 'function') return (raw as (args: Record<string, unknown>, ctx: Ctx) => unknown)(args, ctx);
  return raw;
}

function resolveSelection(
  source: AnyObj,
  selections: SelectionNode[],
  ctx: Ctx,
  variables: Record<string, unknown>,
  fragments: Record<string, FragmentDef>,
): AnyObj {
  const out: AnyObj = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const value = resolveField(source, selection, ctx, variables);
      const key = selection.alias ?? selection.name;
      out[key] = completeValue(value, selection.selection, ctx, variables, fragments);
    } else if (selection.kind === 'fragment') {
      const def = fragments[selection.name];
      if (!def) throw new GraphQLError(`Unknown fragment "${selection.name}".`);
      if (def.typeCondition !== source.__typename) continue;
      Object.assign(out, resolveSelection(source, def.selection, ctx, variables, fragments));
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== source.__typename) continue;
      Object.assign(out, resolveSelection(source, selection.selection, ctx, variables, fragments));
    }
  }
  return out;
}

function completeValue(
  value: unknown,
  selection: SelectionNode[] | null,
  ctx: Ctx,
  variables: Record<string, unknown>,
  fragments: Record<string, FragmentDef>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selection, ctx, variables, fragments));
  }
  if (isPlainObject(value)) {
    return resolveSelection(value, selection, ctx, variables, fragments);
  }
  return value;
}

function executeOperation(
  doc: Document,
  operation: Operation,
  variables: Record<string, unknown>,
  ctx: Ctx,
): { data: unknown; errors?: { message: string }[] } {
  const merged: Record<string, unknown> = {};
  for (const def of operation.variables) {
    if (def.name in variables) merged[def.name] = variables[def.name];
    else if (def.defaultValue !== null) merged[def.name] = resolveValue(def.defaultValue, variables);
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!(key in merged)) merged[key] = value;
  }
  const root: AnyObj =
    operation.operation === 'mutation' ? mutationRoot(ctx) : queryRoot(ctx);
  try {
    const data = resolveSelection(root, operation.selection, ctx, merged, doc.fragments);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

function executeRequest(body: unknown, ctx: Ctx): { data: unknown; errors?: { message: string }[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request must be an object with a query string.' }] };
  }
  const record = body as Record<string, unknown>;
  const queryText = record['query'];
  if (typeof queryText !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(tokenize(queryText)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const variables = (record['variables'] as Record<string, unknown> | undefined) ?? {};
  const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : null;
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    if (doc.operations.length !== 1) {
      return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    operation = doc.operations[0];
  }
  return executeOperation(doc, operation, variables, ctx);
}

// ---------------------------------------------------------------- views

function userView(ctx: Ctx): AnyObj {
  return {
    __typename: 'User',
    id: nodeId('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: '',
    url: `${ctx.origin}/${VIEWER.login}`,
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  view: (item: T) => AnyObj,
  typeName: string,
): AnyObj {
  const after = decodeCursor(args['after']);
  const before = decodeCursor(args['before']);
  let start = after === null ? 0 : after + 1;
  let end = before === null ? items.length : before;
  const first = typeof args['first'] === 'number' ? args['first'] : null;
  const last = typeof args['last'] === 'number' ? args['last'] : null;
  if (first !== null) end = Math.min(end, start + first);
  if (last !== null) start = Math.max(start, end - last);
  start = Math.max(0, Math.min(start, items.length));
  end = Math.max(start, Math.min(end, items.length));
  const slice = items.slice(start, end);
  return {
    __typename: typeName,
    nodes: slice.map(view),
    edges: slice.map((item, i) => ({ __typename: 'Edge', node: view(item), cursor: encodeCursor(start + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? encodeCursor(start) : null,
      endCursor: slice.length ? encodeCursor(end - 1) : null,
    },
    totalCount: items.length,
  };
}

function labelView(label: Label): AnyObj {
  return {
    __typename: 'Label',
    id: nodeId('Label', label.id),
    databaseId: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
  };
}

function issueView(ctx: Ctx, repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    id: nodeId('Issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: ctx.store.isoOfSeq(issue.createdSeq),
    updatedAt: ctx.store.isoOfSeq(issue.updatedSeq),
    closedAt: issue.state === 'closed' ? ctx.store.isoOfSeq(issue.updatedSeq) : null,
    author: userView(ctx),
    repository: repoView(ctx, repo),
    labels: (args: Record<string, unknown>) => connection(issue.labels, args, labelView, 'LabelConnection'),
    comments: (args: Record<string, unknown>) =>
      connection(issue.comments, args, (comment) => commentView(ctx, repo, issue, comment), 'IssueCommentConnection'),
    url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
  };
}

function commentView(ctx: Ctx, repo: Repo, issue: Issue, comment: { id: number; body: string; createdSeq: number; updatedSeq: number }): AnyObj {
  return {
    __typename: 'IssueComment',
    id: nodeId('IssueComment', repo.id, issue.number, comment.id),
    databaseId: comment.id,
    body: comment.body,
    createdAt: ctx.store.isoOfSeq(comment.createdSeq),
    updatedAt: ctx.store.isoOfSeq(comment.updatedSeq),
    author: userView(ctx),
    url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function pullView(ctx: Ctx, repo: Repo, pull: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    id: nodeId('PullRequest', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state.toUpperCase(),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: ctx.store.headSha(repo, pull),
    baseRefOid: ctx.store.baseSha(repo, pull),
    merged: pull.merged,
    mergeable: ctx.store.isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    isDraft: false,
    createdAt: ctx.store.isoOfSeq(pull.createdSeq),
    updatedAt: ctx.store.isoOfSeq(pull.updatedSeq),
    author: userView(ctx),
    repository: repoView(ctx, repo),
    files: (args: Record<string, unknown>) => {
      const files = ctx.store.pullFiles(repo, pull).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return connection(files, args, (file) => file, 'PullRequestChangedFileConnection');
    },
    url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function sortForConnection<T extends { createdSeq: number; updatedSeq: number; number: number }>(
  items: T[],
  orderBy: unknown,
): T[] {
  const order = (orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const field = order.field ?? 'CREATED_AT';
  const dir = (order.direction ?? 'DESC') === 'ASC' ? 1 : -1;
  const key = (item: T): number => (field === 'UPDATED_AT' ? item.updatedSeq : item.createdSeq);
  return [...items].sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return diff * dir;
    return (a.number - b.number) * dir;
  });
}

function repoView(ctx: Ctx, repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userView(ctx),
    description: repo.description,
    isPrivate: repo.isPrivate,
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    createdAt: ctx.store.isoOfSeq(repo.createdSeq),
    updatedAt: ctx.store.isoOfSeq(repo.updatedSeq),
    forkCount: 0,
    stargazerCount: 0,
    labels: (args: Record<string, unknown>) => connection(repo.labels, args, labelView, 'LabelConnection'),
    issue: (args: Record<string, unknown>) => {
      const found = ctx.store.getIssue(repo, Number(args['number']));
      return found ? issueView(ctx, repo, found) : null;
    },
    issues: (args: Record<string, unknown>) => {
      let list = [...repo.issues];
      const states = args['states'];
      if (Array.isArray(states)) {
        list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      return connection(sortForConnection(list, args['orderBy']), args, (issue) => issueView(ctx, repo, issue), 'IssueConnection');
    },
    pullRequest: (args: Record<string, unknown>) => {
      const found = ctx.store.getPull(repo, Number(args['number']));
      return found ? pullView(ctx, repo, found) : null;
    },
    pullRequests: (args: Record<string, unknown>) => {
      let list = [...repo.pulls];
      const states = args['states'];
      if (Array.isArray(states)) {
        list = list.filter((pull) => states.includes(pull.state.toUpperCase()));
      }
      return connection(sortForConnection(list, args['orderBy']), args, (pull) => pullView(ctx, repo, pull), 'PullRequestConnection');
    },
  };
}

function findByNodeId(ctx: Ctx, id: unknown): AnyObj | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  const [first, ...rest] = decoded.parts;
  if (decoded.kind === 'Repository') {
    const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(first));
    return repo ? repoView(ctx, repo) : null;
  }
  if (decoded.kind === 'User') return userView(ctx);
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(first));
    if (!repo) return null;
    const number = Number(rest[0]);
    if (decoded.kind === 'Issue') {
      const issue = ctx.store.getIssue(repo, number);
      return issue ? issueView(ctx, repo, issue) : null;
    }
    const pull = ctx.store.getPull(repo, number);
    return pull ? pullView(ctx, repo, pull) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(first));
    if (!repo) return null;
    const issue = ctx.store.getIssue(repo, Number(rest[0]));
    if (!issue) return null;
    const comment = issue.comments.find((candidate) => candidate.id === Number(rest[1]));
    return comment ? commentView(ctx, repo, issue, comment) : null;
  }
  return null;
}

function queryRoot(ctx: Ctx): AnyObj {
  return {
    __typename: 'Query',
    viewer: () => userView(ctx),
    repository: (args: Record<string, unknown>) => {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
      return repo ? repoView(ctx, repo) : null;
    },
    node: (args: Record<string, unknown>) => findByNodeId(ctx, args['id']),
  };
}

function mutationRoot(ctx: Ctx): AnyObj {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
      const target = findByNodeId(ctx, input['repositoryId']);
      if (!target || target.__typename !== 'Repository') throw new GraphQLError('Could not resolve to a Repository.');
      const repo = ctx.store.requireRepo(VIEWER.login, String(target['name']));
      const issue = ctx.store.createIssue(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueView(ctx, repo, issue),
        clientMutationId: (input['clientMutationId'] as string | undefined) ?? null,
      };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
      const target = findByNodeId(ctx, input['issueId']);
      if (!target || target.__typename !== 'Issue') throw new GraphQLError('Could not resolve to an Issue.');
      const repoId = Number(decodeNodeId(String(input['issueId']))?.parts[0]);
      const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === repoId);
      if (!repo) throw new GraphQLError('Could not resolve to an Issue.');
      const issue = ctx.store.requireIssue(repo, Number(target['number']));
      ctx.store.patchIssue(repo, issue, { state: 'closed' });
      return {
        __typename: 'CloseIssuePayload',
        issue: issueView(ctx, repo, issue),
        clientMutationId: (input['clientMutationId'] as string | undefined) ?? null,
      };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
      const target = findByNodeId(ctx, input['repositoryId']);
      if (!target || target.__typename !== 'Repository') throw new GraphQLError('Could not resolve to a Repository.');
      const repo = ctx.store.requireRepo(VIEWER.login, String(target['name']));
      const pull = ctx.store.createPull(
        repo,
        String(input['title'] ?? ''),
        String(input['headRefName'] ?? ''),
        String(input['baseRefName'] ?? ''),
        String(input['body'] ?? ''),
      );
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullView(ctx, repo, pull),
        clientMutationId: (input['clientMutationId'] as string | undefined) ?? null,
      };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
      const target = findByNodeId(ctx, input['pullRequestId']);
      if (!target || target.__typename !== 'PullRequest') throw new GraphQLError('Could not resolve to a PullRequest.');
      const repoId = Number(decodeNodeId(String(input['pullRequestId']))?.parts[0]);
      const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === repoId);
      if (!repo) throw new GraphQLError('Could not resolve to a PullRequest.');
      const pull = ctx.store.requirePull(repo, Number(target['number']));
      ctx.store.mergePull(repo, pull);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullView(ctx, repo, pull),
        clientMutationId: (input['clientMutationId'] as string | undefined) ?? null,
      };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
      const target = findByNodeId(ctx, input['subjectId']);
      if (!target || target.__typename !== 'Issue') throw new GraphQLError('Could not resolve to an Issue.');
      const repoId = Number(decodeNodeId(String(input['subjectId']))?.parts[0]);
      const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === repoId);
      if (!repo) throw new GraphQLError('Could not resolve to an Issue.');
      const issue = ctx.store.requireIssue(repo, Number(target['number']));
      const comment = ctx.store.addComment(repo, issue, String(input['body'] ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentView(ctx, repo, issue, comment), cursor: encodeCursor(issue.comments.length - 1) },
        clientMutationId: (input['clientMutationId'] as string | undefined) ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'repository', 'labels', 'comments', 'url', 'locked'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'merged', 'mergeable', 'isDraft', 'createdAt', 'updatedAt', 'author', 'repository', 'files', 'url', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'url', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Label: ['id', 'databaseId', 'name', 'color', 'description'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

function introspectType(name: string): AnyObj | null {
  if (name in TYPE_FIELDS) {
    return {
      __typename: '__Type',
      kind: 'OBJECT',
      name,
      description: null,
      fields: (TYPE_FIELDS[name] ?? []).map((field) => ({
        __typename: '__Field',
        name: field,
        description: null,
        args: [],
        type: { __typename: '__Type', kind: 'SCALAR', name: 'String', description: null },
      })),
      enumValues: null,
    };
  }
  if (name in ENUM_VALUES) {
    return {
      __typename: '__Type',
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      enumValues: (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- HTTP handler

function checkAuth(req: IncomingMessage, token: string): void {
  const header = req.headers.authorization ?? '';
  if (header !== `Bearer ${token}`) throw unauthorized();
}

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
  path: string,
): Promise<boolean> {
  if (path !== '/api/graphql') return false;
  try {
    checkAuth(req, token);
    if ((req.method ?? 'GET') !== 'POST') throw new HttpError(405, 'Method Not Allowed');
    const body = await readJson(req);
    const ctx: Ctx = { store, origin: requestOrigin(req) };
    if (Array.isArray(body)) {
      sendJson(res, 200, body.map((item) => executeRequest(item, ctx)));
    } else {
      sendJson(res, 200, executeRequest(body, ctx));
    }
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, err.body);
      return true;
    }
    sendJson(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}
