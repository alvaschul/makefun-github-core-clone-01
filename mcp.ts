// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp. It speaks both discovery eras the
// suite probes (server/discover with supportedVersions, and the legacy initialize handshake),
// lists a fixed tool set byte-identically on every call, and routes tools/call into the same store
// the REST surface uses, so anything created here reads back over REST unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  branchTip,
  bindViewerLogin,
  createIssue,
  createPull,
  createRepo,
  findOpenPull,
  findPull,
  findRepo,
  findRepoByName,
  mergePull,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './shapes.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const num = (description: string): { type: string; description: string } => ({ type: 'number', description });

/** The tool list is a constant: two tools/list calls must answer byte-identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: bool('Whether the repository is private.'),
        owner: str('The repository owner login (defaults to the authenticated user).'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The head branch (the branch with the changes).'),
        base: str('The base branch (the branch to merge into).'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: num('The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

type Json = Record<string, unknown>;

function argString(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function normalizeRefName(raw: string): string {
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
}

interface ToolOutcome {
  result: unknown;
  isError?: boolean;
}

function toolResult(value: unknown): ToolOutcome {
  return { result: value };
}

function toolError(message: string): ToolOutcome {
  return { result: message, isError: true };
}

/** Run one tool against the store; the return value is what the caller sees as structured content. */
function callTool(name: string, args: Json): ToolOutcome | 'unknown' {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === '') return toolError('missing required argument: name');
      const owner = argString(args, 'owner');
      if (owner !== '') bindViewerLogin(owner);
      const existing = findRepoByName(repoName);
      if (existing !== null) return toolResult(repoJson(existing));
      const repo = createRepo(repoName, args.private === true, argString(args, 'description'));
      if (repo === null) return toolError('could not create the repository');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const title = argString(args, 'title');
      if (title === '') return toolError('missing required argument: title');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      for (const label of labels) if (!repo.labels.has(label)) return toolError(`label "${label}" does not exist`);
      const issue = createIssue(repo, title, argString(args, 'body'), labels);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const state = argString(args, 'state') || 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = findRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const head = normalizeRefName(argString(args, 'head'));
      const base = normalizeRefName(argString(args, 'base')) || repo.defaultBranch;
      if (branchTip(repo, head) === null) return toolError('head branch does not exist');
      if (branchTip(repo, base) === null) return toolError('base branch does not exist');
      const existing = findOpenPull(repo, head, base);
      if (existing !== null) return toolResult(pullJson(repo, existing));
      const pull = createPull(repo, argString(args, 'title'), argString(args, 'body'), head, base);
      if (pull === null) return toolError('could not create the pull request');
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(argString(args, 'pull_number'), 10);
      const pull = Number.isFinite(number) ? findPull(repo, number) : null;
      if (pull === null) return toolError('pull request not found');
      const outcome = mergePull(repo, pull);
      if (outcome.kind === 'conflict') return toolError('Pull Request is not mergeable');
      const sha = outcome.kind === 'merged' ? outcome.sha : pull.mergeCommitSha;
      return toolResult({ ...pullJson(repo, pull), merged: true, sha });
    }
    default:
      return 'unknown';
  }
}

function missingRequired(tool: ToolDef, args: Json): string | null {
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

// --------------------------------------------------------------------------- JSON-RPC

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle one JSON-RPC request object; returns null for notifications (no answer owed). */
function handleRpc(message: Json): RpcResponse | null {
  const isNotification = !('id' in message) || message.id === undefined;
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Json;

  if (isNotification) return null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      const missing = missingRequired(tool, args);
      if (missing !== null) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `missing required argument: ${missing}` }],
          isError: true,
        });
      }
      const outcome = callTool(toolName, args);
      if (outcome === 'unknown') return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const text = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result);
      const result: Json = { content: [{ type: 'text', text }] };
      if (typeof outcome.result !== 'string') result.structuredContent = outcome.result;
      if (outcome.isError === true) result.isError = true;
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Answer one POST /mcp request (auth has already been checked by the dispatcher). */
export function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const method = req.method ?? 'POST';
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } })}\n`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const send = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleRpc((entry ?? {}) as Json))
      .filter((entry) => entry !== null);
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    send(200, responses);
    return;
  }
  const response = handleRpc((parsed ?? {}) as Json);
  if (response === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  send(200, response);
}
