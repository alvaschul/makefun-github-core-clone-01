// The forge's store: git objects in memory, repositories, issues, pull requests, labels and
// comments. Everything the four surfaces (git smart HTTP, REST, GraphQL, MCP) share lives here so
// an object created through one surface reads back identically through the others.
//
// Determinism matters: the trial replays the same request stream and compares the exported state,
// so nothing below reads a wall clock or a random source. Timestamps come from a logical clock that
// ticks once per created entity, and ids are plain sequences.

import { createHash } from 'node:crypto';

// --------------------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** Every git object the forge knows, content-addressed by sha1, shared across repositories. */
export const objects = new Map<string, GitObject>();

export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const SHA_RE = /^[0-9a-f]{40}$/;

/** The git object id: sha1 of "<type> <byte length>\0" followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotent: the same bytes always land under the same id) and return its id. */
export function storeObject(type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function getObject(sha: string): GitObject | undefined {
  return objects.get(sha);
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  /** '100644' / '100755' for blobs, '40000' for subtrees, as written in the tree bytes. */
  mode: string;
  name: string;
  sha: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, with subtrees sorting as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree object and store it; returns the tree sha. */
export function buildTree(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

/** The well-known empty tree, stored on first use. */
export function emptyTreeSha(): string {
  return storeObject('tree', Buffer.alloc(0));
}

/** Read a tree's entries by sha; a missing or non-tree sha reads as an empty tree. */
export function treeEntries(treeSha: string | null): TreeEntry[] {
  if (treeSha === null) return [];
  const obj = objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/** Walk a tree path; returns the entry at the end of the path, or null when any step is absent. */
export function lookupPath(treeSha: string | null, parts: readonly string[]): TreeEntry | null {
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = treeEntries(current).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return null;
    current = entry.sha;
  }
  return null;
}

/**
 * Return a new tree sha with the leaf at `parts` set to `leaf` (or removed when leaf is null).
 * Intermediate subtrees are created as needed; a subtree emptied by a removal disappears, and a
 * fully emptied root becomes the empty tree.
 */
export function updateTree(treeSha: string | null, parts: readonly string[], leaf: { sha: string; mode: string } | null): string {
  const [head, ...rest] = parts as [string, ...string[]];
  const entries = treeEntries(treeSha).filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (leaf !== null) entries.push({ mode: leaf.mode, name: head, sha: leaf.sha });
  } else {
    const existing = treeEntries(treeSha).find((entry) => entry.name === head);
    const childBefore = existing !== undefined && isTreeMode(existing.mode) ? existing.sha : null;
    const childAfter = updateTree(childBefore, rest, leaf);
    if (childAfter !== emptyTreeSha() || leaf === null) {
      if (childAfter !== emptyTreeSha()) entries.push({ mode: '40000', name: head, sha: childAfter });
    }
  }
  return buildTree(entries);
}

/** Flatten a tree into path -> blob entry, recursively. Directories themselves are not listed. */
export function flattenTree(treeSha: string | null, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  for (const entry of treeEntries(treeSha)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(entry.sha, path, out);
    else out.set(path, entry);
  }
  return out;
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  /** The raw "Name <email> ts +0000" author line. */
  author: string;
  committer: string;
}

/** Parse a commit object's bytes. Extra headers (gpgsig, encoding, ...) are skipped over. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function commitInfo(sha: string): CommitInfo | null {
  const obj = objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** Serialize and store a commit; `ident` is "Name <email>", the timestamp is supplied by the caller. */
export function buildCommit(tree: string, parents: readonly string[], message: string, ident: string, tsSec: number): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident} ${tsSec} +0000`);
  lines.push(`committer ${ident} ${tsSec} +0000`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject('commit', Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8'));
}

/** Parse a tag object: the sha it points at and the type of that object. */
export function parseTag(data: Buffer): { target: string; targetType: string } {
  const text = data.toString('utf8');
  let target = '';
  let targetType = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
    else if (line === '') break;
  }
  return { target, targetType };
}

/** Peel a sha through annotated tags until a non-tag object; returns the final sha. */
export function peelToCommit(sha: string): string {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).target;
  }
  return current;
}

/** All commits reachable from `tip`, newest first (parents after their children), tip included. */
export function ancestorsOf(tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    const info = commitInfo(sha);
    if (info === null) continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of info.parents) queue.push(parent);
  }
  return order;
}

/** Whether `ancestor` is reachable from `descendant` by walking parents (equality counts). */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(sha);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * The set of objects reachable from the given tips: commits and their trees/blobs recursively, and
 * tags peeled to their targets. When `stopAtShallow` names commits the caller already holds as
 * shallow, those commits themselves are included but their parents are not walked.
 */
export function collectReachable(tips: readonly string[], stopAtShallow?: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (found.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined) continue;
    found.add(sha);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (stopAtShallow === undefined || !stopAtShallow.has(sha)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).target);
    }
  }
  return found;
}

// --------------------------------------------------------------------------- logical clock

/** 2025-01-01T00:00:00Z: where the forge's logical clock starts. */
const LOGICAL_EPOCH_SEC = 1_735_689_600;
let logicalTick = 0;

/** The next logical timestamp, in epoch seconds: strictly increasing, never wall-clock based. */
export function nextTimestamp(): number {
  logicalTick += 1;
  return LOGICAL_EPOCH_SEC + logicalTick * 61;
}

export function isoOf(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString();
}

// --------------------------------------------------------------------------- repositories

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  /** Global, stable comment id. */
  id: number;
  body: string;
  createdTs: number;
}

export interface IssueRec {
  /** Global database id, stable across surfaces. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdTs: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** The base branch tip when the pull request was opened: the anchor for conflict detection. */
  baseShaAtCreate: string;
  /** The head branch tip when the pull request was opened (the fallback head sha if it moves). */
  headShaAtCreate: string;
  mergeCommitSha: string | null;
  mergedTs: number | null;
  createdTs: number;
}

export interface RepoRec {
  /** Sequential database id, in creation order. */
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main") -> object sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: IssueRec[];
  pulls: PullRec[];
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdTs: number;
}

const reposByName = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;

/**
 * The login the bearer token names. The forge cannot know it in advance: it is learned from the
 * first owner segment the suite uses for a repository that exists, which is exactly how the suite
 * itself resolves the owner (it asks, then falls back on the name it already uses). Once learned it
 * never changes, and repositories addressed under any other owner read as absent.
 */
let viewerLogin: string | null = null;

export function getViewerLogin(): string | null {
  return viewerLogin;
}

export function bindViewerLogin(login: string): void {
  if (viewerLogin === null && login !== '') viewerLogin = login;
}

/** Create a repository; returns null when the name is already taken. */
export function createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
  if (reposByName.has(name)) return null;
  const repo: RepoRec = {
    id: nextRepoId,
    name,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    createdTs: nextTimestamp(),
  };
  nextRepoId += 1;
  reposByName.set(name, repo);
  return repo;
}

/**
 * Find a repository by owner + name. The name is the key; the owner must match the token's login
 * once that login is known (a name under another owner is a 404, never a 403). A successful lookup
 * under a not-yet-known owner teaches the forge the login.
 */
export function findRepo(owner: string, name: string): RepoRec | null {
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (viewerLogin === null) bindViewerLogin(owner);
  else if (owner !== viewerLogin) return null;
  return repo;
}

/** Find a repository by name alone (surfaces that carry no owner: POST /user/repos follow-ups). */
export function findRepoByName(name: string): RepoRec | null {
  return reposByName.get(name) ?? null;
}

export function deleteRepo(name: string): boolean {
  return reposByName.delete(name);
}

/** All repositories, in creation order. */
export function allRepos(): RepoRec[] {
  return [...reposByName.values()].sort((a, b) => a.id - b.id);
}

/** The sha a branch name resolves to in a repo, or null when the branch does not exist. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The sha a ref-ish (branch name, full ref, or raw sha) resolves to, or null. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const asBranch = branchTip(repo, ref);
  if (asBranch !== null) return asBranch;
  if (SHA_RE.test(ref) && objects.has(ref)) return ref;
  return null;
}

/** The commit ident API-created commits carry. */
export function forgeIdent(): string {
  const login = viewerLogin ?? 'forge';
  return `${login} <${login}@example.invalid>`;
}

/** Create a commit on a branch through the object store and move the branch; returns the commit sha. */
export function commitOnBranch(repo: RepoRec, branch: string, tree: string, message: string): string {
  const parent = branchTip(repo, branch);
  const sha = buildCommit(tree, parent === null ? [] : [parent], message, forgeIdent(), nextTimestamp());
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

// --------------------------------------------------------------------------- issues and pulls

export function createIssue(repo: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec {
  const issue: IssueRec = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdTs: nextTimestamp(),
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

export function findIssue(repo: RepoRec, number: number): IssueRec | null {
  return repo.issues.find((issue) => issue.number === number) ?? null;
}

export function addComment(issue: IssueRec, body: string): CommentRec {
  const comment: CommentRec = { id: nextCommentId, body, createdTs: nextTimestamp() };
  nextCommentId += 1;
  issue.comments.push(comment);
  return comment;
}

export function createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec | null {
  const baseSha = branchTip(repo, baseRef);
  const headSha = branchTip(repo, headRef);
  if (baseSha === null || headSha === null) return null;
  const pull: PullRec = {
    id: nextPullId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    baseShaAtCreate: baseSha,
    headShaAtCreate: headSha,
    mergeCommitSha: null,
    mergedTs: null,
    createdTs: nextTimestamp(),
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

export function findPull(repo: RepoRec, number: number): PullRec | null {
  return repo.pulls.find((pull) => pull.number === number) ?? null;
}

export function findOpenPull(repo: RepoRec, headRef: string, baseRef: string): PullRec | null {
  return repo.pulls.find((pull) => pull.state === 'open' && !pull.merged && pull.headRef === headRef && pull.baseRef === baseRef) ?? null;
}

// --------------------------------------------------------------------------- tree diffs and merging

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCount(sha: string | null): number {
  if (sha === null) return 0;
  const obj = objects.get(sha);
  if (obj === undefined || obj.type !== 'blob' || obj.data.length === 0) return 0;
  let lines = 0;
  for (const byte of obj.data) if (byte === 0x0a) lines += 1;
  return obj.data[obj.data.length - 1] === 0x0a ? lines : lines + 1;
}

/** The file-level diff between two trees: every path whose blob differs, with line counts. */
export function diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
  const base = flattenTree(baseTree);
  const head = flattenTree(headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path)?.sha ?? null;
    const after = head.get(path)?.sha ?? null;
    if (before === after) continue;
    if (before === null) changes.push({ path, status: 'added', additions: lineCount(after), deletions: 0 });
    else if (after === null) changes.push({ path, status: 'removed', additions: 0, deletions: lineCount(before) });
    else changes.push({ path, status: 'modified', additions: lineCount(after), deletions: lineCount(before) });
  }
  return changes;
}

function treeOfCommit(sha: string | null): string | null {
  if (sha === null) return null;
  return commitInfo(peelToCommit(sha))?.tree ?? null;
}

/**
 * Whether merging `pull` now would conflict: some path the head changed since the pull was opened
 * has also changed on the base since then, to something different from both. Mirrors the REST rule
 * the suite exercises: two branches editing the same file from one base conflict once one merges.
 */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return true;
  if (pull.baseShaAtCreate === baseTip) return false;
  const atCreate = flattenTree(treeOfCommit(pull.baseShaAtCreate));
  const onBase = flattenTree(treeOfCommit(baseTip));
  const onHead = flattenTree(treeOfCommit(headTip));
  const paths = new Set<string>([...atCreate.keys(), ...onBase.keys(), ...onHead.keys()]);
  for (const path of paths) {
    const was = atCreate.get(path)?.sha ?? null;
    const baseNow = onBase.get(path)?.sha ?? null;
    const headNow = onHead.get(path)?.sha ?? null;
    const headChanged = headNow !== was;
    const baseChanged = baseNow !== was;
    if (headChanged && baseChanged && headNow !== baseNow) return true;
  }
  return false;
}

export type MergeOutcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'conflict' }
  | { kind: 'already' };

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the head branch's
 * tree. The pull closes as merged and remembers the merge commit.
 */
export function mergePull(repo: RepoRec, pull: PullRec): MergeOutcome {
  if (pull.merged) return { kind: 'already' };
  if (pull.state !== 'open') return { kind: 'conflict' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { kind: 'conflict' };
  if (pullConflicts(repo, pull)) return { kind: 'conflict' };
  const headTree = treeOfCommit(headTip);
  if (headTree === null) return { kind: 'conflict' };
  const sha = buildCommit(headTree, [baseTip], pull.title, forgeIdent(), nextTimestamp());
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedTs = nextTimestamp();
  return { kind: 'merged', sha };
}
