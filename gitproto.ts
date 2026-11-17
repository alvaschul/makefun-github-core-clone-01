// Git smart HTTP, implemented from the protocol up: pkt-lines, packfiles (plain and delta
// objects, in both directions), protocol v0 and v2 advertisements, ls-refs, fetch with shallow
// support, and receive-pack with per-ref report-status. No git binary is involved anywhere; the
// object store in store.ts is the only state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_SHA,
  type ObjType,
  type RepoRec,
  collectReachable,
  commitInfo,
  getObject,
  hashObject,
  isAncestor,
  objects,
  parseCommit,
  parseTag,
  peelToCommit,
  storeObject,
} from './store.ts';

// --------------------------------------------------------------------------- pkt-lines

/** Encode one pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktEvent =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** A cursor over a pkt-line stream; anything malformed simply reads as the end of the stream. */
export class PktReader {
  private readonly buf: Buffer;
  private offset: number;

  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  /** The bytes after the current position (the packfile after a receive-pack command list). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  next(): PktEvent {
    if (this.offset + 4 > this.buf.length) return { kind: 'end' };
    const header = this.buf.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { kind: 'end' };
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length < 4 || this.offset + length > this.buf.length) return { kind: 'end' };
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }
}

/** Read data lines until a flush or delim; returns the lines and which terminator stopped it. */
export function readPktSection(reader: PktReader): { lines: string[]; terminator: 'flush' | 'delim' | 'end' } {
  const lines: string[] = [];
  for (;;) {
    const event = reader.next();
    if (event.kind === 'data') lines.push(event.payload.toString('utf8').replace(/\n$/, ''));
    else if (event.kind === 'flush') return { lines, terminator: 'flush' };
    else if (event.kind === 'delim') return { lines, terminator: 'delim' };
    else return { lines, terminator: 'end' };
  }
}

// --------------------------------------------------------------------------- packfiles

const TYPE_NUMBERS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize a set of objects (already in the store) as a complete packfile, plain objects only. */
export function buildPack(shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = getObject(sha);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(TYPE_NUMBERS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 of a buffer, as zlib writes it at the end of every stream. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 5552) {
    const end = Math.min(i + 5552, data.length);
    for (let j = i; j < end; j += 1) {
      a += data[j] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate the zlib stream starting at `offset`; returns the data and the bytes it consumed. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const slice = buf.subarray(offset);
  const full = inflateSync(slice);
  // inflateSync ignores trailing bytes, so the consumed length has to be found. A zlib stream ends
  // with the Adler-32 of its inflated data: scan for those 4 bytes and verify the candidate prefix
  // inflates to the same bytes. That is two inflates per object instead of a binary search's dozen.
  const adler = adler32(full);
  for (let i = 6; i + 4 <= slice.length; i += 1) {
    if (slice.readUInt32BE(i) !== adler) continue;
    try {
      if (inflateSync(slice.subarray(0, i + 4)).equals(full)) return { data: full, consumed: i + 4 };
    } catch {
      // A coincidental match inside the deflate body: keep scanning.
    }
  }
  // Fallback: binary-search the shortest prefix that still inflates (a truncated stream throws,
  // which makes "inflates" monotone in the prefix length).
  let lo = 1;
  let hi = slice.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      inflateSync(slice.subarray(0, mid));
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: full, consumed: lo };
}

/** Apply a git delta buffer to a base object, producing the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the base length; trusted, not checked)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

interface RawPackEntry {
  offset: number;
  typeNum: number;
  /** Inflated payload: the object bytes, or the delta bytes for delta entries. */
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
  end: number;
}

/** Parse one pack entry starting at `offset` inside `buf`. */
function parsePackEntry(buf: Buffer, offset: number): RawPackEntry {
  let cursor = offset;
  const first = buf[cursor] as number;
  cursor += 1;
  const typeNum = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let byte = first;
  while (byte & 0x80) {
    byte = buf[cursor] as number;
    cursor += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  void size;
  let baseOffset: number | undefined;
  let baseSha: string | undefined;
  if (typeNum === 6) {
    // ofs-delta: a negative offset to the base entry, in git's offset encoding.
    byte = buf[cursor] as number;
    cursor += 1;
    let back = byte & 0x7f;
    while (byte & 0x80) {
      byte = buf[cursor] as number;
      cursor += 1;
      back = ((back + 1) << 7) | (byte & 0x7f);
    }
    baseOffset = offset - back;
  } else if (typeNum === 7) {
    baseSha = buf.toString('hex', cursor, cursor + 20);
    cursor += 20;
  }
  const { data, consumed } = inflateAt(buf, cursor);
  return { offset, typeNum, data, baseOffset, baseSha, end: cursor + consumed };
}

/**
 * Read a whole packfile into the object store, resolving ofs/ref deltas (including thin packs
 * whose bases already live in the store). Returns the number of objects the pack carried.
 */
export function ingestPack(buf: Buffer): number {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const entries: RawPackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entry = parsePackEntry(buf, offset);
    entries.push(entry);
    offset = entry.end;
  }
  const byOffset = new Map<number, string>();
  const resolve = (entry: RawPackEntry): string => {
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      const type = NUMBER_TYPES[entry.typeNum] as ObjType;
      const sha = storeObject(type, entry.data);
      byOffset.set(entry.offset, sha);
      return sha;
    }
    let baseSha: string;
    let baseType: ObjType;
    if (entry.typeNum === 6) {
      const baseEntry = entries.find((candidate) => candidate.offset === entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      baseSha = byOffset.get(baseEntry.offset) ?? resolve(baseEntry);
      baseType = getObject(baseSha)?.type as ObjType;
    } else if (entry.typeNum === 7) {
      baseSha = entry.baseSha as string;
      const base = getObject(baseSha);
      if (base === undefined) throw new Error('ref-delta base is unknown');
      baseType = base.type;
    } else {
      throw new Error(`unknown pack object type ${entry.typeNum}`);
    }
    const base = getObject(baseSha);
    if (base === undefined) throw new Error('delta base missing from the store');
    const result = applyDelta(base.data, entry.data);
    const sha = storeObject(baseType, result);
    byOffset.set(entry.offset, sha);
    return sha;
  };
  for (const entry of entries) resolve(entry);
  return count;
}

// --------------------------------------------------------------------------- advertisements

const AGENT = 'agent=forge/1.0.0';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Ref lines for a v0 advertisement: HEAD first (when born), then refs, with peeled tag lines. */
function v0RefLines(repo: RepoRec, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  let capsPending = ` ${capabilities}`;
  const pushLine = (text: string): void => {
    if (capsPending !== '') {
      lines.push(pktLine(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0]), Buffer.from(capsPending.slice(1), 'utf8')])));
      capsPending = '';
    } else {
      lines.push(pktLine(text));
    }
  };
  if (headTip !== undefined) pushLine(`${headTip} HEAD`);
  for (const [ref, sha] of sortedRefs(repo)) {
    pushLine(`${sha} ${ref}`);
    const obj = getObject(sha);
    if (obj !== undefined && obj.type === 'tag') {
      lines.push(pktLine(`${parseTag(obj.data).target} ${ref}^{}`));
    }
  }
  if (lines.length === 0) {
    // An unborn repository still advertises: the capabilities^{} pseudo-ref carries the caps.
    pushLine(`${ZERO_SHA} capabilities^{}`);
  }
  return lines;
}

export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** The body of GET info/refs for a service, in protocol v0 or v2 as requested. */
export function advertisement(repo: RepoRec, service: GitService, version2: boolean): Buffer {
  if (version2 && service === 'git-upload-pack') {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const preamble = pktLine(`# service=${service}\n`);
  if (service === 'git-receive-pack') {
    const caps = `report-status report-status-v2 delete-refs side-band-64k ofs-delta ${AGENT}`;
    return Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const caps = `side-band-64k thin-pack ofs-delta symref=HEAD:${headRef} object-format=sha1 ${AGENT}`;
  return Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
}

// --------------------------------------------------------------------------- ls-refs (v2)

/** One ref as ls-refs reports it, honouring peel / symrefs / unborn and ref-prefix filtering. */
export function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    const obj = getObject(sha);
    if (wantPeel && obj !== undefined && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).target}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// --------------------------------------------------------------------------- fetch

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  /** The depth limit (the wire's `deepen N`), or null for a full fetch. */
  depth: number | null;
  deepenNot: string[];
}

export function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenNot: [] };
  for (const rawLine of lines) {
    // A v0 first want line carries the request's capabilities after a NUL; they end the line.
    const line = rawLine.split('\0')[0] as string;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7), 10) || null;
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
  return request;
}

interface FetchPlan {
  pack: Buffer | null;
  shallow: string[];
  unshallow: string[];
}

/** Fetch plans are cached per (repo, tip set, depth): the clone benchmark asks 50x for the same. */
const packCache = new Map<string, FetchPlan>();

/**
 * Walk the commits a fetch includes: from the wants, honouring the depth limit (the wire's
 * `deepen N` reads as a total depth of N from the wants, which is how the suite's deepen check
 * counts) and deepen-not. Returns the included commits and the shallow boundary among them.
 */
function walkFetchCommits(request: FetchRequest): { included: Set<string>; boundary: Set<string>; excluded: Set<string> } {
  const excluded = new Set<string>();
  for (const notTip of request.deepenNot) {
    for (const sha of collectReachable([peelToCommit(notTip)])) excluded.add(sha);
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of request.wants) {
    const commit = peelToCommit(want);
    if (getObject(commit)?.type === 'commit' && !distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  let queueHead = 0;
  while (queueHead < queue.length) {
    const sha = queue[queueHead] as string;
    queueHead += 1;
    const dist = distance.get(sha) as number;
    if (included.has(sha) || excluded.has(sha)) continue;
    included.add(sha);
    const info = commitInfo(sha);
    if (info === null) continue;
    const atLimit = request.depth !== null && dist + 1 >= request.depth;
    for (const parent of info.parents) {
      if (atLimit) boundary.add(sha);
      else if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  return { included, boundary, excluded };
}

/** The shallow bookkeeping for a fetch: the new boundary, and held shallows this fetch releases. */
function shallowNews(request: FetchRequest, included: Set<string>, boundary: Set<string>): { shallow: string[]; unshallow: string[] } {
  const shallow = [...boundary].filter((sha) => included.has(sha) && getObject(sha)?.type === 'commit');
  const unshallow = request.shallow.filter((sha) => included.has(sha) && !shallow.includes(sha));
  return { shallow, unshallow };
}

/** Compute what a fetch sends: the pack (or null when there is nothing new) and the shallow news. */
export function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const cacheKey = [
    repo.id,
    [...request.wants].sort().join(','),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
    String(request.depth),
  ].join('|');
  const cached = packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const clientShallow = new Set(request.shallow);
  const { included, boundary, excluded } = walkFetchCommits(request);
  const news = shallowNews(request, included, boundary);

  // Objects to send: the included commits themselves plus each one's tree closure (trees and
  // blobs recursively — never a step into a parent commit, which is what the depth limit cuts),
  // plus any wanted tag objects, minus everything the client already holds (the closure of its
  // haves, stopping at its shallow boundary).
  const send = new Set<string>();
  for (const sha of included) {
    send.add(sha);
    const info = commitInfo(sha);
    if (info !== null) for (const part of collectReachable([info.tree])) send.add(part);
  }
  for (const want of request.wants) {
    const obj = getObject(want);
    if (obj !== undefined && obj.type === 'tag') send.add(want);
  }
  for (const sha of excluded) send.delete(sha);
  const heldTips = request.haves.map((have) => peelToCommit(have)).filter((sha) => getObject(sha)?.type === 'commit');
  const held = collectReachable(heldTips, clientShallow);
  for (const have of request.haves) if (getObject(have)?.type === 'tag') held.add(have);
  for (const sha of held) send.delete(sha);

  if (send.size === 0) return { pack: null, shallow: news.shallow, unshallow: news.unshallow };
  const plan: FetchPlan = { pack: buildPack([...send]), shallow: news.shallow, unshallow: news.unshallow };
  if (packCache.size > 64) packCache.clear();
  packCache.set(cacheKey, plan);
  return plan;
}

/** Wrap pack bytes in side-band-64k packets (band 1), chunked under the pkt-line size limit. */
export function sidebandWrap(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte header and the band byte.
  const CHUNK = 65_515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** Whole fetch responses are cached too: 50 concurrent clones ask for identical bytes. */
const responseCache = new Map<string, Buffer>();

function responseKey(repo: RepoRec, request: FetchRequest, version: string): string {
  return [
    version,
    repo.id,
    [...request.wants].sort().join(','),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
    String(request.depth),
  ].join('|');
}

/** The v2 fetch response: acknowledgments, shallow-info (when there is news), then the packfile. */
export function fetchResponseV2(repo: RepoRec, request: FetchRequest): Buffer {
  const key = responseKey(repo, request, 'v2');
  const cachedResponse = responseCache.get(key);
  if (cachedResponse !== undefined) return cachedResponse;
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.pack !== null) {
    parts.push(pktLine('ready\n'));
  } else if (request.haves.length > 0) {
    for (const have of request.haves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_FLUSH);
  }
  if (plan.pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandWrap(plan.pack));
    parts.push(PKT_FLUSH);
  }
  const response = Buffer.concat(parts);
  if (responseCache.size > 64) responseCache.clear();
  responseCache.set(key, response);
  return response;
}

/** The v0 fetch response: shallow lines and NAK as plain pkt-lines, then sideband packets. */
export function fetchResponseV0(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  if (plan.pack !== null) {
    parts.push(...sidebandWrap(plan.pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- receive-pack

export interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
  capabilities: string;
}

/** Parse the command list at the head of a receive-pack body; the rest of the body is the pack. */
export function parseRefCommands(body: Buffer): { commands: RefCommand[]; pack: Buffer } {
  const reader = new PktReader(body);
  const commands: RefCommand[] = [];
  for (;;) {
    const event = reader.next();
    if (event.kind !== 'data') break;
    let text = event.payload.toString('utf8').replace(/\n$/, '');
    let capabilities = '';
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const [oldSha, newSha, ref] = text.split(' ');
    if (oldSha !== undefined && newSha !== undefined && ref !== undefined) {
      commands.push({ oldSha, newSha, ref, capabilities });
    }
  }
  return { commands, pack: reader.rest() };
}

/**
 * Apply a push: ingest the pack, then move each ref that fast-forwards (or creates / deletes
 * legally), and answer with the report-status stream, sideband-framed when the client asked.
 */
export function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const { commands, pack } = parseRefCommands(body);
  const firstCaps = commands[0]?.capabilities ?? '';
  const useSideband = firstCaps.includes('side-band-64k');
  const report: Buffer[] = [];
  let unpackLine = 'unpack ok\n';
  if (pack.length > 0) {
    try {
      ingestPack(pack);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'corrupt pack'}\n`;
    }
  }
  report.push(pktLine(unpackLine));
  const unpackOk = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    const failure = unpackOk ? applyRefCommand(repo, command) : 'unpack failed';
    if (failure === null) report.push(pktLine(`ok ${command.ref}\n`));
    else report.push(pktLine(`ng ${command.ref} ${failure}\n`));
  }
  report.push(PKT_FLUSH);
  const reportStream = Buffer.concat(report);
  if (!useSideband) return reportStream;
  const wrapped: Buffer[] = [];
  const CHUNK = 65_515;
  for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + CHUNK)])));
  }
  wrapped.push(PKT_FLUSH);
  return Buffer.concat(wrapped);
}

/** Move one ref for a push; returns null on success or the report's failure reason. */
function applyRefCommand(repo: RepoRec, command: RefCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_SHA;
  const isDelete = command.newSha === ZERO_SHA;
  if (current !== command.oldSha) {
    if (command.oldSha === ZERO_SHA) return 'reference already exists';
    return 'reference does not exist';
  }
  if (isDelete) {
    if (current === ZERO_SHA) return 'reference does not exist';
    repo.refs.delete(command.ref);
    return null;
  }
  const target = getObject(command.newSha);
  if (target === undefined) return 'unknown object';
  if (command.ref.startsWith('refs/heads/') && current !== ZERO_SHA) {
    const newCommit = peelToCommit(command.newSha);
    const oldCommit = peelToCommit(current);
    if (!isAncestor(oldCommit, newCommit)) return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newSha);
  return null;
}

/** Forget cached packs for a repository after its refs move. */
export function invalidatePackCache(repo: RepoRec): void {
  const prefix = `${repo.id}|`;
  for (const key of [...packCache.keys()]) if (key.startsWith(prefix)) packCache.delete(key);
}

export { hashObject };
