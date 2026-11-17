// The forge's HTTP surface: git smart HTTP, the REST v3 API, and the dispatch to the GraphQL and
// MCP endpoints. One server, one store (store.ts); every surface authenticates with the same
// bearer token and answers with the same JSON error shape.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  SHA_RE,
  ZERO_SHA,
  type IssueRec,
  type PullRec,
  type RepoRec,
  allRepos,
  ancestorsOf,
  branchTip,
  commitInfo,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  diffTrees,
  findIssue,
  findOpenPull,
  findPull,
  findRepo,
  flattenTree,
  getObject,
  getViewerLogin,
  isoOf,
  lookupPath,
  mergePull,
  parseCommit,
  peelToCommit,
  resolveRef,
  storeObject,
  treeEntries,
  updateTree,
  commitOnBranch,
  addComment,
  isTreeMode,
} from './store.ts';
import {
  PktReader,
  advertisement,
  fetchResponseV0,
  fetchResponseV2,
  lsRefs,
  parseFetchArgs,
  readPktSection,
  receivePack,
} from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { commentJson, issueJson, pullJson, repoJson } from './shapes.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** Every response carries a request id, as GitHub's does; a counter keeps it deterministic. */
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function validationFailed(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message: `Validation Failed: ${message}` });
}

/** Whether the request carries the trial's bearer token. With no token configured, any bearer passes. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  return EXPECTED_TOKEN === '' || token === EXPECTED_TOKEN;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------------- JSON shapes

function commitJson(sha: string): Record<string, unknown> | null {
  const info = commitInfo(sha);
  if (info === null) return null;
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: isoOf(0) };
    return { name: match[1] as string, email: match[2] as string, date: isoOf(parseInt(match[3] as string, 10)) };
  };
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree },
      author: ident(info.author),
      committer: ident(info.committer),
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

// --------------------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

/** Slice a list for the page and write the Link header when further pages exist. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[], page: Page): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const slice = items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
  if (items.length > page.perPage) {
    const host = req.headers.host ?? 'forge.invalid';
    const base = `http://${host}${url.pathname}`;
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('per_page', String(page.perPage));
      params.set('page', String(target));
      return `<${base}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page.page < totalPages) links.push(`${linkFor(page.page + 1)}; rel="next"`, `${linkFor(totalPages)}; rel="last"`);
    if (page.page > 1) links.push(`${linkFor(page.page - 1)}; rel="prev"`, `${linkFor(1)}; rel="first"`);
    if (links.length > 0) res.setHeader('link', links.join(', '));
  }
  return slice;
}

// --------------------------------------------------------------------------- REST helpers

type Json = Record<string, unknown>;

function bodyString(body: Json, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function labelNamesOf(body: Json): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Json).name === 'string') names.push((item as Json).name as string);
  }
  return names;
}

/** The tree sha at a ref-ish in a repo, or null. */
function treeAtRef(repo: RepoRec, ref: string): { commit: string; tree: string } | null {
  const sha = resolveRef(repo, ref);
  if (sha === null) return null;
  const commit = peelToCommit(sha);
  const info = commitInfo(commit);
  if (info === null) return null;
  return { commit, tree: info.tree };
}

// --------------------------------------------------------------------------- REST routes

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Json | null): void {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { installed_version: '1.0.0', github_developer_program: false });
  }

  if (rest[0] === 'rate_limit' && rest.length === 1) {
    return sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1893456000 } }, rate: { limit: 5000, remaining: 4999, reset: 1893456000 } });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    const login = getViewerLogin();
    if (login === null) return notFound(res);
    return sendJson(res, 200, { login, id: 1, type: 'User', name: login, email: `${login}@example.invalid` });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const page = pageOf(url);
      const items = paginate(req, res, url, allRepos(), page);
      return sendJson(res, 200, items.map((repo) => repoJson(repo)));
    }
    if (method === 'POST') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = bodyString(body, 'name');
      if (name === '') return validationFailed(res, 'name is required');
      const existing = allRepos().find((repo) => repo.name === name);
      if (existing !== undefined) return validationFailed(res, 'name already exists on this account');
      const repo = createRepo(name, body.private === true, bodyString(body, 'description'));
      if (repo === null) return validationFailed(res, 'name already exists on this account');
      if (body.auto_init === true) {
        const tree = storeObject('tree', Buffer.alloc(0));
        commitOnBranch(repo, repo.defaultBranch, tree, 'Initial commit');
      }
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }

  if (rest[0] !== 'repos' || rest.length < 3) return notFound(res);
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const tail = rest.slice(3);
  const repo = findRepo(owner, repoName);

  if (tail.length === 0) {
    if (repo === null) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo.name);
      res.writeHead(204);
      return res.end();
    }
    return notFound(res);
  }

  if (repo === null) return notFound(res);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;
  void repoPath;

  // ---- branches and refs
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return sendJson(res, 200, branches);
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound(res);
      const commit = commitJson(tip);
      return sendJson(res, 200, { name: branch, commit: commit?.commit !== undefined ? { sha: tip, ...(commit as Json).commit as Json } : { sha: tip }, protected: false });
    }
    return notFound(res);
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha');
      if (!ref.startsWith('refs/') || !SHA_RE.test(sha) || getObject(sha) === undefined) {
        return validationFailed(res, 'the ref or object is invalid');
      }
      if (repo.refs.has(ref)) return validationFailed(res, 'reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound(res);
      return sendJson(res, 200, { ref, node_id: `REF_${ref}`, object: { sha, type: getObject(sha)?.type ?? 'commit' } });
    }
    return notFound(res);
  }

  // ---- commits
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return notFound(res);
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    const at = treeAtRef(repo, ref);
    if (at === null) return sendJson(res, 200, []);
    const commits = ancestorsOf(at.commit).map((sha) => commitJson(sha)).filter((entry) => entry !== null);
    return sendJson(res, 200, commits);
  }

  // ---- contents
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).join('/');
    return handleContents(req, res, url, repo, filePath, body);
  }

  // ---- labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: null })));
    }
    if (method === 'POST') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = bodyString(body, 'name');
      if (name === '') return validationFailed(res, 'name is required');
      if (repo.labels.has(name)) return validationFailed(res, 'name has already been taken');
      const color = bodyString(body, 'color') || 'ededed';
      repo.labels.set(name, { name, color });
      return sendJson(res, 201, { name, color, description: null });
    }
    return notFound(res);
  }

  // ---- issues
  if (tail[0] === 'issues') {
    return handleIssues(req, res, url, repo, tail.slice(1), body);
  }

  // ---- pulls
  if (tail[0] === 'pulls') {
    return handlePulls(req, res, url, repo, tail.slice(1), body);
  }

  return notFound(res);
}

function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, filePath: string, body: Json | null): void {
  const method = req.method ?? 'GET';
  const parts = filePath === '' ? [] : filePath.split('/').filter((part) => part !== '');

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? url.searchParams.get('branch') ?? repo.defaultBranch;
    const at = treeAtRef(repo, ref);
    if (at === null) return notFound(res);
    if (parts.length === 0) {
      return sendJson(res, 200, treeEntries(at.tree).map((entry) => dirEntryJson(entry, entry.name)));
    }
    const entry = lookupPath(at.tree, parts);
    if (entry === null) return notFound(res);
    if (isTreeMode(entry.mode)) {
      const prefix = parts.join('/');
      return sendJson(res, 200, treeEntries(entry.sha).map((child) => dirEntryJson(child, `${prefix}/${child.name}`)));
    }
    const blob = getObject(entry.sha);
    if (blob === undefined) return notFound(res);
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.sha,
      size: blob.data.length,
      name: parts[parts.length - 1],
      path: parts.join('/'),
    });
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    if (parts.length === 0) return validationFailed(res, 'a file path is required');
    const branch = bodyString(body, 'branch') || repo.defaultBranch;
    let tip = branchTip(repo, branch);
    if (tip === null) {
      const defaultTip = branchTip(repo, repo.defaultBranch);
      if (defaultTip !== null) {
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const currentTree = tip === null ? null : (commitInfo(tip)?.tree ?? null);
    const existing = currentTree === null ? null : lookupPath(currentTree, parts);
    const message = bodyString(body, 'message') || (method === 'PUT' ? `Update ${filePath}` : `Delete ${filePath}`);

    if (method === 'DELETE') {
      if (existing === null || isTreeMode(existing.mode)) return notFound(res);
      const sha = bodyString(body, 'sha');
      if (sha !== '' && sha !== existing.sha) return sendJson(res, 409, { message: 'sha does not match the current file' });
      const newTree = updateTree(currentTree, parts, null);
      const commitSha = commitOnBranch(repo, branch, newTree, message);
      return sendJson(res, 200, { content: null, commit: { sha: commitSha } });
    }

    // PUT
    const contentB64 = bodyString(body, 'content');
    const blobSha = storeObject('blob', Buffer.from(contentB64, 'base64'));
    const existed = existing !== null && !isTreeMode(existing.mode);
    if (existed) {
      const sha = bodyString(body, 'sha');
      if (sha === '') return validationFailed(res, '"sha" wasn\'t supplied');
      if (sha !== (existing as { sha: string }).sha) {
        return sendJson(res, 409, { message: 'sha does not match the current file' });
      }
    }
    const newTree = updateTree(currentTree, parts, { sha: blobSha, mode: '100644' });
    const commitSha = commitOnBranch(repo, branch, newTree, message);
    const blob = getObject(blobSha);
    return sendJson(res, existed ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        sha: blobSha,
        size: blob?.data.length ?? 0,
        name: parts[parts.length - 1],
        path: parts.join('/'),
      },
      commit: { sha: commitSha },
    });
  }

  return notFound(res);
}

function dirEntryJson(entry: { mode: string; name: string; sha: string }, path: string): Record<string, unknown> {
  const isDir = isTreeMode(entry.mode);
  const blob = isDir ? undefined : getObject(entry.sha);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.sha,
    size: blob?.data.length ?? 0,
  };
}

function handleIssues(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, tail: string[], body: Json | null): void {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const items = paginate(req, res, url, issues, page);
      return sendJson(res, 200, items.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = bodyString(body, 'title');
      if (title === '') return validationFailed(res, 'title is required');
      const labels = labelNamesOf(body);
      for (const label of labels) {
        if (!repo.labels.has(label)) return validationFailed(res, `label "${label}" does not exist`);
      }
      const issue = createIssue(repo, title, bodyString(body, 'body'), labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return notFound(res);
  }

  const number = parseInt(tail[0] as string, 10);
  const issue = Number.isFinite(number) ? findIssue(repo, number) : null;

  if (tail.length === 1) {
    if (issue === null) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = labelNamesOf(body);
        for (const label of labels) if (!repo.labels.has(label)) return validationFailed(res, `label "${label}" does not exist`);
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === null) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issue.comments.map((comment) => commentJson(issue, comment.id)));
    if (method === 'POST') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const comment = addComment(issue, bodyString(body, 'body'));
      return sendJson(res, 201, commentJson(issue, comment.id));
    }
    return notFound(res);
  }

  return notFound(res);
}

function normalizeRefName(raw: string): string {
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
}

function handlePulls(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, tail: string[], body: Json | null): void {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => {
        if (state === 'all') return true;
        if (state === 'closed') return pull.state === 'closed';
        return pull.state === 'open';
      });
      const page = pageOf(url);
      const items = paginate(req, res, url, pulls, page);
      return sendJson(res, 200, items.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const head = normalizeRefName(bodyString(body, 'head'));
      const base = normalizeRefName(bodyString(body, 'base')) || repo.defaultBranch;
      const title = bodyString(body, 'title');
      if (head === '' || branchTip(repo, head) === null) return validationFailed(res, 'head branch does not exist');
      if (branchTip(repo, base) === null) return validationFailed(res, 'base branch does not exist');
      if (findOpenPull(repo, head, base) !== null) return validationFailed(res, 'a pull request already exists for this branch combination');
      const pull = createPull(repo, title, bodyString(body, 'body'), head, base);
      if (pull === null) return validationFailed(res, 'could not create the pull request');
      return sendJson(res, 201, pullJson(repo, pull));
    }
    return notFound(res);
  }

  const number = parseInt(tail[0] as string, 10);
  const pull = Number.isFinite(number) ? findPull(repo, number) : null;

  if (tail.length === 1) {
    if (pull === null) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (body.state === 'closed' && !pull.merged) pull.state = 'closed';
      if (body.state === 'open' && !pull.merged) pull.state = 'open';
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      return sendJson(res, 200, pullJson(repo, pull));
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === null) return notFound(res);
    const baseTree = commitInfo(pull.baseShaAtCreate)?.tree ?? null;
    const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
    const headTree = commitInfo(peelToCommit(headTip))?.tree ?? null;
    const changes = diffTrees(baseTree, headTree);
    return sendJson(res, 200, changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: flattenTree(headTree).get(change.path)?.sha ?? flattenTree(baseTree).get(change.path)?.sha ?? ZERO_SHA,
    })));
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === null) return notFound(res);
    const outcome = mergePull(repo, pull);
    if (outcome.kind === 'conflict') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    const sha = outcome.kind === 'merged' ? outcome.sha : (pull.mergeCommitSha ?? ZERO_SHA);
    return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// --------------------------------------------------------------------------- git smart HTTP

function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string, action: string, rawBody: Buffer): void {
  const method = req.method ?? 'GET';
  const repo = findRepo(owner, repoName);
  if (repo === null) return notFound(res);

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound(res);
    const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    return sendRaw(res, 200, advertisement(repo, service, version2), `application/x-${service}-advertisement`);
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    try {
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const reader = new PktReader(rawBody);
      if (version2) {
        const head = readPktSection(reader);
        const commandLine = head.lines.find((line) => line.startsWith('command='));
        const command = commandLine?.slice('command='.length) ?? '';
        if (command === 'ls-refs') {
          const args = readPktSection(reader);
          return sendRaw(res, 200, lsRefs(repo, args.lines), 'application/x-git-upload-pack-result');
        }
        if (command === 'fetch') {
          const args = readPktSection(reader);
          const request = parseFetchArgs(args.lines);
          return sendRaw(res, 200, fetchResponseV2(repo, request), 'application/x-git-upload-pack-result');
        }
        return sendRaw(res, 400, Buffer.from('unknown command\n'), 'text/plain');
      }
      // v0: a wants section, a flush, then a haves section ending in `done`.
      const first = readPktSection(reader);
      const second = readPktSection(reader);
      const request = parseFetchArgs([...first.lines, ...second.lines]);
      return sendRaw(res, 200, fetchResponseV0(repo, request), 'application/x-git-upload-pack-result');
    } catch {
      return sendRaw(res, 400, Buffer.from('malformed upload-pack request\n'), 'text/plain');
    }
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    try {
      return sendRaw(res, 200, receivePack(repo, rawBody), 'application/x-git-receive-pack-result');
    } catch {
      return sendRaw(res, 400, Buffer.from('malformed receive-pack request\n'), 'text/plain');
    }
  }

  return notFound(res);
}

// --------------------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', nextRequestId());
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          const raw = await readBody(req);
          await handleGraphQL(res, raw);
          return;
        }

        if (path === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
          const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          handleMcp(req, res, raw);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          let body: Json | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
                body = parsed as Json;
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            } else {
              body = {};
            }
          }
          handleRest(req, res, url, body);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          handleGit(req, res, url, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string), gitMatch[3] as string, raw);
          return;
        }

        notFound(res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
