// GraphQL v4, sized to the documents gh and github-mcp-server actually send: a small lexer and
// parser for operations, fragments, aliases and arguments; a static schema description that also
// answers introspection; and an executor that resolves the forge's store records. Unknown fields
// are validation errors in the GitHub shape (HTTP 200, an errors array naming the field), unknown
// repositories are null data, and batched operations answer as an array in request order.

import type { ServerResponse } from 'node:http';
import {
  type IssueRec,
  type PullRec,
  type RepoRec,
  allRepos,
  branchTip,
  commitInfo,
  createIssue,
  createPull,
  diffTrees,
  findIssue,
  findOpenPull,
  findPull,
  findRepo,
  getViewerLogin,
  isoOf,
  mergePull,
  pullConflicts,
  addComment,
} from './store.ts';
import { ownerLogin } from './shapes.ts';

// --------------------------------------------------------------------------- global ids

/** Global ids are opaque but stable: base64 of "Type:key[:key]", decoded by node(id:). */
export function encodeId(type: string, ...keys: (string | number)[]): string {
  return Buffer.from([type, ...keys.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeId(id: string): { type: string; keys: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [type, ...keys] = text.split(':');
    if (type === undefined || type === '') return null;
    return { type, keys };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- schema

/** Field -> result type (named, without list/non-null wrappers) for validation and introspection. */
const TYPE_FIELDS: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'Viewer', user: 'User', organization: 'Organization', repository: 'Repository',
    node: 'Node', nodes: 'Node', __type: '__Type', __schema: '__Schema', search: 'SearchResultItemConnection',
    rateLimit: 'RateLimit',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'ReopenIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload', updateIssue: 'UpdateIssuePayload', updatePullRequest: 'UpdatePullRequestPayload',
  },
  Viewer: {
    login: 'String', id: 'ID', databaseId: 'Int', name: 'String', email: 'String', url: 'URI',
    avatarUrl: 'URI', isViewer: 'Boolean', createdAt: 'DateTime', updatedAt: 'DateTime',
  },
  User: {
    login: 'String', id: 'ID', databaseId: 'Int', name: 'String', email: 'String', url: 'URI',
    avatarUrl: 'URI', isViewer: 'Boolean', createdAt: 'DateTime', updatedAt: 'DateTime',
  },
  Organization: { login: 'String', id: 'ID', name: 'String', url: 'URI', avatarUrl: 'URI' },
  RepositoryOwner: { login: 'String', id: 'ID', url: 'URI', avatarUrl: 'URI' },
  Actor: { login: 'String', id: 'ID', url: 'URI', avatarUrl: 'URI' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'RepositoryOwner',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean',
    hasPullRequestsEnabled: 'Boolean', isPrivate: 'Boolean', isFork: 'Boolean', description: 'String',
    url: 'URI', createdAt: 'DateTime', updatedAt: 'DateTime', pushedAt: 'DateTime',
    issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
    stargazerCount: 'Int', forkCount: 'Int', watchers: 'UserConnection', labels: 'LabelConnection',
    primaryLanguage: 'Language', isArchived: 'Boolean', isDisabled: 'Boolean', visibility: 'RepositoryVisibility',
  },
  Ref: { name: 'String', prefix: 'String', target: 'Commit', repository: 'Repository' },
  Commit: { oid: 'String', id: 'ID', message: 'String', committedDate: 'DateTime', author: 'GitActor' },
  GitActor: { name: 'String', email: 'String', date: 'DateTime' },
  Language: { name: 'String', id: 'ID', color: 'String' },
  Issue: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'IssueState',
    author: 'Actor', createdAt: 'DateTime', updatedAt: 'DateTime', closedAt: 'DateTime', url: 'URI',
    labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository',
    viewerCanUpdate: 'Boolean', locked: 'Boolean',
  },
  PullRequest: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', mergedAt: 'DateTime', mergeable: 'MergeableState', mergeStateStatus: 'MergeStateStatus',
    headRefName: 'String', baseRefName: 'String', headRefOid: 'String', baseRefOid: 'String',
    author: 'Actor', createdAt: 'DateTime', updatedAt: 'DateTime', closedAt: 'DateTime', url: 'URI',
    files: 'PullRequestChangedFileConnection', additions: 'Int', deletions: 'Int', changedFiles: 'Int',
    repository: 'Repository', mergeCommit: 'Commit', labels: 'LabelConnection', comments: 'IssueCommentConnection',
    isDraft: 'Boolean', viewerCanUpdate: 'Boolean',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'PatchType' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String', url: 'URI' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', author: 'Actor', createdAt: 'DateTime', updatedAt: 'DateTime', url: 'URI' },
  UserConnection: { nodes: 'User', edges: 'UserEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  UserEdge: { node: 'User', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  SearchResultItemConnection: { nodes: 'SearchResultItem', edges: 'SearchResultItemEdge', pageInfo: 'PageInfo', issueCount: 'Int', repositoryCount: 'Int', userCount: 'Int', discussionCount: 'Int' },
  SearchResultItemEdge: { node: 'SearchResultItem', cursor: 'String' },
  RateLimit: { limit: 'Int', cost: 'Int', remaining: 'Int', used: 'Int', nodeCount: 'Int', resetAt: 'DateTime' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  ReopenIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  UpdateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  UpdatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'TypeKind', description: 'String', fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', inputFields: '__InputValue', ofType: '__Type', specifiedByURL: 'String' },
  __Field: { name: 'String', description: 'String', args: '__InputValue', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', directives: '__Directive' },
  __Directive: { name: 'String', description: 'String', locations: 'DirectiveLocation', args: '__InputValue' },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeStateStatus: ['CLEAN', 'DIRTY', 'UNKNOWN', 'BLOCKED', 'BEHIND', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  PatchType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'HTML', 'Base64String']);

// --------------------------------------------------------------------------- lexer and parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", found "${token.value}"`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token "${token.value}"`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    if (!this.atPunct('(')) return;
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0 && this.peek().kind !== 'eof');
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) this.skipVariableDefinitions();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, ValueNode>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'number': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- tagged values

/** A runtime value: its GraphQL type plus the store data the resolvers read. */
interface GValue {
  t: string;
  repo?: RepoRec;
  issue?: IssueRec;
  pull?: PullRec;
  commentId?: number;
  name?: string;
  login?: string;
  items?: GValue[];
  totalCount?: number;
  hasNextPage?: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
  cursor?: string;
  node?: GValue;
  clientMutationId?: string | null;
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
  color?: string;
  labelName?: string;
  sha?: string;
}

const viewerValue = (): GValue => ({ t: 'Viewer', login: getViewerLogin() ?? ownerLogin() });
const repoValue = (repo: RepoRec): GValue => ({ t: 'Repository', repo });
const issueValue = (repo: RepoRec, issue: IssueRec): GValue => ({ t: 'Issue', repo, issue });
const pullValue = (repo: RepoRec, pull: PullRec): GValue => ({ t: 'PullRequest', repo, pull });
const actorValue = (): GValue => ({ t: 'Actor', login: ownerLogin() });

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

/** Slice a full item list into a connection value for (first, after) arguments. */
function connection(t: string, all: GValue[], args: Map<string, unknown>): GValue {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : all.length;
  const after = typeof args.get('after') === 'string' ? (args.get('after') as string) : null;
  const start = after === null ? 0 : indexFromCursor(after) + 1;
  const slice = all.slice(start, start + Math.max(0, first));
  return {
    t,
    items: slice.map((item, i) => ({ ...item, cursor: cursorFor(start + i) })),
    totalCount: all.length,
    hasNextPage: start + slice.length < all.length,
    startCursor: slice.length > 0 ? cursorFor(start) : null,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
  };
}

// --------------------------------------------------------------------------- resolvers

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function argsOf(field: FieldNode, ctx: ExecCtx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [name, value] of field.args) out.set(name, resolveValue(value, ctx.variables));
  return out;
}

function findRepoByDbId(id: number): RepoRec | null {
  return allRepos().find((repo) => repo.id === id) ?? null;
}

function findCommentLocation(commentId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of allRepos()) {
    for (const issue of repo.issues) {
      if (issue.comments.some((comment) => comment.id === commentId)) return { repo, issue };
    }
  }
  return null;
}

function nodeById(id: string): GValue | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  const [first, second] = decoded.keys;
  if (decoded.type === 'Repository') {
    const repo = findRepoByDbId(parseInt(first ?? '', 10));
    return repo === null ? null : repoValue(repo);
  }
  if (decoded.type === 'Issue') {
    const repo = findRepoByDbId(parseInt(first ?? '', 10));
    const issue = repo === null ? null : findIssue(repo, parseInt(second ?? '', 10));
    return repo === null || issue === null ? null : issueValue(repo, issue);
  }
  if (decoded.type === 'PullRequest') {
    const repo = findRepoByDbId(parseInt(first ?? '', 10));
    const pull = repo === null ? null : findPull(repo, parseInt(second ?? '', 10));
    return repo === null || pull === null ? null : pullValue(repo, pull);
  }
  if (decoded.type === 'IssueComment') {
    const location = findCommentLocation(parseInt(first ?? '', 10));
    if (location === null) return null;
    return { t: 'IssueComment', repo: location.repo, issue: location.issue, commentId: parseInt(first ?? '', 10) };
  }
  if (decoded.type === 'User' || decoded.type === 'Viewer') return viewerValue();
  return null;
}

function typeDescription(name: string): GValue {
  const isEnum = name in ENUM_VALUES;
  return { t: '__Type', name };
}

function resolveRoot(field: FieldNode, ctx: ExecCtx, isMutation: boolean): unknown {
  const args = argsOf(field, ctx);
  if (!isMutation) {
    switch (field.name) {
      case 'viewer': return viewerValue();
      case 'user': return viewerValue();
      case 'repository': {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        const repo = findRepo(owner, name);
        return repo === null ? null : repoValue(repo);
      }
      case 'node': return nodeById(String(args.get('id') ?? ''));
      case 'nodes': return null;
      case '__type': return typeDescription(String(args.get('name') ?? ''));
      case '__schema': return { t: '__Schema' };
      case 'search': return connection('SearchResultItemConnection', [], args);
      case 'rateLimit': return { t: 'RateLimit' };
      default: return null;
    }
  }
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded === null ? null : findRepoByDbId(parseInt(decoded.keys[0] ?? '', 10));
      if (repo === null) throw new Error('repository not found');
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { t: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    case 'closeIssue':
    case 'reopenIssue':
    case 'updateIssue': {
      const target = nodeById(String(input.issueId ?? input.id ?? ''));
      if (target === null || target.issue === undefined || target.repo === undefined) throw new Error('issue not found');
      if (field.name === 'closeIssue') target.issue.state = 'closed';
      if (field.name === 'reopenIssue') target.issue.state = 'open';
      if (field.name === 'updateIssue') {
        if (typeof input.title === 'string') target.issue.title = input.title;
        if (typeof input.body === 'string') target.issue.body = input.body;
      }
      const payloadType = field.name === 'closeIssue' ? 'CloseIssuePayload' : field.name === 'reopenIssue' ? 'ReopenIssuePayload' : 'UpdateIssuePayload';
      return { t: payloadType, issue: target, clientMutationId: (input.clientMutationId as string) ?? null };
    }
    case 'createPullRequest': {
      const decoded = decodeId(String(input.repositoryId ?? ''));
      const repo = decoded === null ? null : findRepoByDbId(parseInt(decoded.keys[0] ?? '', 10));
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const existing = findOpenPull(repo, head, base);
      const pull = existing ?? createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if (pull === null) throw new Error('could not create the pull request');
      return { t: 'CreatePullRequestPayload', pull: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null };
    }
    case 'mergePullRequest': {
      const target = nodeById(String(input.pullRequestId ?? ''));
      if (target === null || target.pull === undefined || target.repo === undefined) throw new Error('pull request not found');
      const outcome = mergePull(target.repo, target.pull);
      if (outcome.kind === 'conflict') throw new Error('Pull Request is not mergeable');
      return { t: 'MergePullRequestPayload', pull: target, clientMutationId: (input.clientMutationId as string) ?? null };
    }
    case 'addComment': {
      const target = nodeById(String(input.subjectId ?? ''));
      if (target === null || target.issue === undefined || target.repo === undefined) throw new Error('subject not found');
      const comment = addComment(target.issue, String(input.body ?? ''));
      const node: GValue = { t: 'IssueComment', repo: target.repo, issue: target.issue, commentId: comment.id };
      return {
        t: 'AddCommentPayload',
        node: { t: 'IssueCommentEdge', node, cursor: cursorFor(0) },
        issue: target,
        clientMutationId: (input.clientMutationId as string) ?? null,
      };
    }
    case 'updatePullRequest': {
      const target = nodeById(String(input.pullRequestId ?? ''));
      if (target === null || target.pull === undefined) throw new Error('pull request not found');
      if (typeof input.title === 'string') target.pull.title = input.title;
      if (typeof input.body === 'string') target.pull.body = input.body;
      return { t: 'UpdatePullRequestPayload', pull: target, clientMutationId: (input.clientMutationId as string) ?? null };
    }
    default: return null;
  }
}

/** Resolve one field on a tagged value; `undefined` means "no value here" (reads as null). */
function resolveField(source: GValue, field: FieldNode, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  const repo = source.repo as RepoRec;
  switch (source.t) {
    case 'Viewer':
    case 'User': {
      const login = getViewerLogin() ?? source.login ?? 'forge';
      switch (field.name) {
        case 'login': return login;
        case 'id': return encodeId('User', 1);
        case 'databaseId': return 1;
        case 'name': return login;
        case 'email': return `${login}@example.invalid`;
        case 'url': return `https://forge.invalid/${login}`;
        case 'avatarUrl': return 'https://forge.invalid/avatar.png';
        case 'isViewer': return true;
        case 'createdAt': case 'updatedAt': return isoOf(1_735_689_600);
        default: return undefined;
      }
    }
    case 'Actor':
    case 'RepositoryOwner': {
      const login = source.login ?? ownerLogin();
      switch (field.name) {
        case 'login': return login;
        case 'id': return encodeId('User', 1);
        case 'url': return `https://forge.invalid/${login}`;
        case 'avatarUrl': return 'https://forge.invalid/avatar.png';
        default: return undefined;
      }
    }
    case 'Repository': {
      switch (field.name) {
        case 'id': return encodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${ownerLogin()}/${repo.name}`;
        case 'owner': return { t: 'RepositoryOwner', login: ownerLogin() };
        case 'defaultBranchRef': return { t: 'Ref', repo, name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': case 'hasPullRequestsEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': case 'isArchived': case 'isDisabled': return false;
        case 'visibility': return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
        case 'description': return repo.description;
        case 'url': return `https://forge.invalid/${ownerLogin()}/${repo.name}`;
        case 'createdAt': case 'updatedAt': case 'pushedAt': return isoOf(repo.createdTs);
        case 'stargazerCount': case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'issue': {
          const issue = findIssue(repo, Number(args.get('number') ?? 0));
          return issue === null ? null : issueValue(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toLowerCase());
            issues = issues.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          if (orderBy?.direction === 'DESC') issues.sort((a, b) => b.number - a.number);
          else if (orderBy?.direction === 'ASC') issues.sort((a, b) => a.number - b.number);
          return connection('IssueConnection', issues.map((issue) => issueValue(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = findPull(repo, Number(args.get('number') ?? 0));
          return pull === null ? null : pullValue(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls];
          const states = args.get('states');
          if (Array.isArray(states)) {
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
              return states.map(String).includes(state);
            });
          }
          const orderBy = args.get('orderBy') as { direction?: string } | undefined;
          if (orderBy?.direction === 'DESC') pulls.sort((a, b) => b.number - a.number);
          return connection('PullRequestConnection', pulls.map((pull) => pullValue(repo, pull)), args);
        }
        case 'labels': {
          const labels: GValue[] = [...repo.labels.values()].map((label) => ({ t: 'Label', repo, labelName: label.name, color: label.color }));
          return connection('LabelConnection', labels, args);
        }
        case 'watchers': return connection('UserConnection', [], args);
        default: return undefined;
      }
    }
    case 'Ref': {
      switch (field.name) {
        case 'name': return source.name ?? '';
        case 'prefix': return 'refs/heads/';
        case 'repository': return repoValue(repo);
        case 'target': {
          const tip = branchTip(repo, source.name ?? '');
          return tip === null ? null : { t: 'Commit', repo, sha: tip };
        }
        default: return undefined;
      }
    }
    case 'Commit': {
      const info = source.sha === undefined ? null : commitInfo(source.sha);
      switch (field.name) {
        case 'oid': return source.sha ?? '';
        case 'id': return encodeId('Commit', source.sha ?? '');
        case 'message': return info?.message.replace(/\n$/, '') ?? '';
        case 'committedDate': return isoOf(repo?.createdTs ?? 1_735_689_600);
        case 'author': return { t: 'GitActor', name: info?.author ?? '' };
        default: return undefined;
      }
    }
    case 'GitActor': {
      const match = /^(.*) <(.*)>/.exec(source.name ?? '');
      switch (field.name) {
        case 'name': return match?.[1] ?? source.name ?? '';
        case 'email': return match?.[2] ?? '';
        case 'date': return isoOf(1_735_689_600);
        default: return undefined;
      }
    }
    case 'Issue': {
      const issue = source.issue as IssueRec;
      switch (field.name) {
        case 'id': return encodeId('Issue', repo.id, issue.number);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author': return actorValue();
        case 'createdAt': case 'updatedAt': return isoOf(issue.createdTs);
        case 'closedAt': return issue.state === 'closed' ? isoOf(issue.createdTs) : null;
        case 'url': return `https://forge.invalid/${ownerLogin()}/${repo.name}/issues/${issue.number}`;
        case 'repository': return repoValue(repo);
        case 'viewerCanUpdate': return true;
        case 'locked': return false;
        case 'labels': {
          const labels: GValue[] = issue.labels.map((name) => ({ t: 'Label', repo, labelName: name, color: repo.labels.get(name)?.color ?? 'ededed' }));
          return connection('LabelConnection', labels, args);
        }
        case 'comments': {
          const comments: GValue[] = issue.comments.map((comment) => ({ t: 'IssueComment', repo, issue, commentId: comment.id }));
          return connection('IssueCommentConnection', comments, args);
        }
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const pull = source.pull as PullRec;
      switch (field.name) {
        case 'id': return encodeId('PullRequest', repo.id, pull.number);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedTs === null ? null : isoOf(pull.mergedTs);
        case 'mergeable': return pull.merged ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'mergeStateStatus': return pull.merged ? 'CLEAN' : pullConflicts(repo, pull) ? 'DIRTY' : 'CLEAN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
        case 'baseRefOid': return branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
        case 'author': return actorValue();
        case 'createdAt': case 'updatedAt': return isoOf(pull.createdTs);
        case 'closedAt': return pull.state === 'closed' ? isoOf(pull.createdTs) : null;
        case 'url': return `https://forge.invalid/${ownerLogin()}/${repo.name}/pull/${pull.number}`;
        case 'repository': return repoValue(repo);
        case 'isDraft': return false;
        case 'viewerCanUpdate': return true;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { t: 'Commit', repo, sha: pull.mergeCommitSha };
        case 'files': {
          const baseTree = commitInfo(pull.baseShaAtCreate)?.tree ?? null;
          const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
          const headTree = commitInfo(headTip)?.tree ?? null;
          const files: GValue[] = diffTrees(baseTree, headTree).map((change) => ({
            t: 'PullRequestChangedFile',
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return connection('PullRequestChangedFileConnection', files, args);
        }
        case 'additions': case 'deletions': case 'changedFiles': {
          const baseTree = commitInfo(pull.baseShaAtCreate)?.tree ?? null;
          const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
          const headTree = commitInfo(headTip)?.tree ?? null;
          const changes = diffTrees(baseTree, headTree);
          if (field.name === 'additions') return changes.reduce((sum, change) => sum + change.additions, 0);
          if (field.name === 'deletions') return changes.reduce((sum, change) => sum + change.deletions, 0);
          return changes.length;
        }
        case 'labels': return connection('LabelConnection', [], args);
        case 'comments': return connection('IssueCommentConnection', [], args);
        default: return undefined;
      }
    }
    case 'Label': {
      switch (field.name) {
        case 'id': return encodeId('Label', repo?.id ?? 0, source.labelName ?? '');
        case 'name': return source.labelName ?? '';
        case 'color': return source.color ?? 'ededed';
        case 'description': return null;
        case 'url': return `https://forge.invalid/labels/${source.labelName ?? ''}`;
        default: return undefined;
      }
    }
    case 'IssueComment': {
      const issue = source.issue as IssueRec;
      const comment = issue.comments.find((candidate) => candidate.id === source.commentId);
      switch (field.name) {
        case 'id': return encodeId('IssueComment', source.commentId ?? 0);
        case 'databaseId': return source.commentId ?? 0;
        case 'body': return comment?.body ?? '';
        case 'author': return actorValue();
        case 'createdAt': case 'updatedAt': return isoOf(comment?.createdTs ?? issue.createdTs);
        case 'url': return `https://forge.invalid/${ownerLogin()}/${repo.name}/issues/${issue.number}`;
        default: return undefined;
      }
    }
    case 'PullRequestChangedFile': {
      switch (field.name) {
        case 'path': return source.path ?? '';
        case 'additions': return source.additions ?? 0;
        case 'deletions': return source.deletions ?? 0;
        case 'changeType': return source.changeType ?? 'MODIFIED';
        default: return undefined;
      }
    }
    case 'PageInfo': {
      switch (field.name) {
        case 'hasNextPage': return source.hasNextPage ?? false;
        case 'hasPreviousPage': return false;
        case 'startCursor': return source.startCursor ?? null;
        case 'endCursor': return source.endCursor ?? null;
        default: return undefined;
      }
    }
    case 'RateLimit': {
      switch (field.name) {
        case 'limit': return 5000;
        case 'cost': return 1;
        case 'remaining': return 4999;
        case 'used': return 1;
        case 'nodeCount': return 0;
        case 'resetAt': return isoOf(1_893_456_000);
        default: return undefined;
      }
    }
    case '__Type': {
      const typeName = source.name ?? '';
      switch (field.name) {
        case 'name': return typeName;
        case 'kind': return typeName in ENUM_VALUES ? 'ENUM' : SCALAR_TYPES.has(typeName) ? 'SCALAR' : 'OBJECT';
        case 'description': return null;
        case 'fields': {
          const fields = TYPE_FIELDS[typeName];
          if (fields === undefined) return null;
          return Object.keys(fields).map((name) => ({ t: '__Field', name, path: fields[name] }));
        }
        case 'enumValues': {
          const values = ENUM_VALUES[typeName];
          if (values === undefined) return null;
          return values.map((name) => ({ t: '__EnumValue', name }));
        }
        case 'possibleTypes': case 'inputFields': case 'ofType': return null;
        case 'specifiedByURL': return null;
        default: return undefined;
      }
    }
    case '__Field': {
      switch (field.name) {
        case 'name': return source.name ?? '';
        case 'description': return null;
        case 'type': return { t: '__Type', name: source.path ?? 'String' };
        case 'args': return [];
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: return undefined;
      }
    }
    case '__EnumValue': {
      switch (field.name) {
        case 'name': return source.name ?? '';
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
        default: return undefined;
      }
    }
    case '__Schema': {
      switch (field.name) {
        case 'queryType': return { t: '__Type', name: 'Query' };
        case 'mutationType': return { t: '__Type', name: 'Mutation' };
        case 'subscriptionType': return null;
        case 'types': return Object.keys(TYPE_FIELDS).map((name) => ({ t: '__Type', name }));
        case 'directives': return [];
        default: return undefined;
      }
    }
    default: break;
  }

  // Connections and edges and mutation payloads share a generic shape.
  if (source.t.endsWith('Connection')) {
    switch (field.name) {
      case 'nodes': return source.items ?? [];
      case 'edges': return (source.items ?? []).map((item) => ({ t: edgeTypeOf(source.t), node: item, cursor: item.cursor ?? cursorFor(0) }));
      case 'pageInfo': return { t: 'PageInfo', hasNextPage: source.hasNextPage, startCursor: source.startCursor, endCursor: source.endCursor };
      case 'totalCount': return source.totalCount ?? 0;
      case 'issueCount': case 'repositoryCount': case 'userCount': case 'discussionCount': return source.totalCount ?? 0;
      default: return undefined;
    }
  }
  if (source.t.endsWith('Edge')) {
    if (field.name === 'node') return source.node ?? null;
    if (field.name === 'cursor') return source.cursor ?? cursorFor(0);
    return undefined;
  }
  if (source.t.endsWith('Payload')) {
    if (field.name === 'clientMutationId') return source.clientMutationId ?? null;
    if (field.name === 'issue') return source.issue ?? null;
    if (field.name === 'pullRequest') return source.pull ?? null;
    if (field.name === 'commentEdge') return source.node ?? null;
    if (field.name === 'subject') return source.issue ?? null;
    return undefined;
  }
  return undefined;
}

function edgeTypeOf(connectionType: string): string {
  return connectionType.replace(/Connection$/, 'Edge');
}

// --------------------------------------------------------------------------- executor

function executeSelectionSet(typeName: string, source: GValue | null, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (source !== null && (selection.typeCondition === null || selection.typeCondition === source.t || selection.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(source.t, source, selection.selection, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && source !== null && fragment.typeCondition === source.t) {
        Object.assign(out, executeSelectionSet(source.t, source, fragment.selection, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source?.t ?? typeName;
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    if (fields === undefined || !(field.name in fields)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    const resultType = fields[field.name] as string;
    let value: unknown;
    try {
      value = typeName === 'Query' || typeName === 'Mutation'
        ? resolveRoot(field, ctx, typeName === 'Mutation')
        : source === null ? null : resolveField(source, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'execution failed' });
      out[key] = null;
      continue;
    }
    out[key] = projectValue(resultType, value, field, ctx);
  }
  return out;
}

function projectValue(resultType: string, value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => projectValue(resultType, item, field, ctx));
  if (SCALAR_TYPES.has(resultType) || resultType in ENUM_VALUES) return value;
  if (typeof value === 'object') {
    const gvalue = value as GValue;
    if (field.selection === null) return null;
    return executeSelectionSet(gvalue.t, gvalue, field.selection, ctx);
  }
  return value;
}

function executeOperation(operation: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: ExecCtx = { variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { t: rootType }, operation.selection, ctx);
  const result: { data?: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// --------------------------------------------------------------------------- HTTP entry

interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeRequest(request: GraphQLRequest): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'a query document is required' }] };
  }
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = (operationName === null
    ? document.operations[0]
    : document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]);
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  return executeOperation(operation, document.fragments, variables);
}

/** Answer one POST /api/graphql body: a single operation or a batch array, in order. */
export async function handleGraphQL(res: ServerResponse, raw: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n`);
    return;
  }
  const respond = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (Array.isArray(parsed)) {
    respond(200, parsed.map((entry) => executeRequest((entry ?? {}) as GraphQLRequest)));
    return;
  }
  respond(200, executeRequest((parsed ?? {}) as GraphQLRequest));
}
