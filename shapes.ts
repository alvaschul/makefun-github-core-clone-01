// The REST JSON shapes for repositories, issues, comments and pull requests, shared by the REST,
// GraphQL and MCP surfaces so an object created through one reads back identically through the
// others (the suite checks exactly that parity).

import {
  type IssueRec,
  type PullRec,
  type RepoRec,
  branchTip,
  getViewerLogin,
  isoOf,
} from './store.ts';

/** The login API payloads name as the owner: the token's login once the forge has learned it. */
export function ownerLogin(): string {
  return getViewerLogin() ?? 'forge';
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = ownerLogin();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdTs),
    updated_at: isoOf(repo.createdTs),
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${owner}/${repo.name}.git`,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = ownerLogin();
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: null };
    }),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOf(issue.createdTs),
    updated_at: isoOf(issue.createdTs),
    html_url: `https://forge.invalid/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(issue: IssueRec, commentId: number): Record<string, unknown> {
  const comment = issue.comments.find((candidate) => candidate.id === commentId);
  const owner = ownerLogin();
  return {
    id: commentId,
    node_id: `C_${commentId}`,
    body: comment?.body ?? '',
    user: { login: owner, id: 1, type: 'User' },
    created_at: isoOf(comment?.createdTs ?? issue.createdTs),
    updated_at: isoOf(comment?.createdTs ?? issue.createdTs),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = ownerLogin();
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headShaAtCreate, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedTs === null ? null : isoOf(pull.mergedTs),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: isoOf(pull.createdTs),
    updated_at: isoOf(pull.createdTs),
    html_url: `https://forge.invalid/${owner}/${repo.name}/pull/${pull.number}`,
  };
}
