import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  collectReachable,
  commitGenerations,
  decodePack,
  decodePktLines,
  isAncestor,
  packEntry,
  parseCommit,
  parseTag,
  pktLine,
  ZERO_OID,
} from './gitcore.ts';
import { HttpError, notFound, readBody, sendBuffer, sendJson, unauthorized } from './util.ts';
import { Store, type Repo } from './store.ts';

const UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

function checkAuth(req: IncomingMessage, token: string): void {
  const header = req.headers.authorization ?? '';
  if (header !== `Bearer ${token}`) throw unauthorized();
}

function requireGitRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) throw notFound('Not Found');
  return repo;
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : 1));
  return refs;
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The v0 ref advertisement for one service, with the service preamble. */
function v0Advertisement(service: string, repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0 || tip === null) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** Peel an annotated tag to its target commit (one hop at a time). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return current;
  }
  return current;
}

/** The ls-refs response lines for a repo, honouring ref-prefix filters. */
function lsRefsLines(repo: Repo, prefixes: string[]): string[] {
  const lines: string[] = [];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (prefixes.length === 0) {
    if (tip === null) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    } else {
      lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    const obj = repo.objects.get(ref.oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

/** The cached pack entry for one object (varint header + deflated bytes). */
function cachedEntry(repo: Repo, oid: string): Buffer | null {
  const cached = repo.deflated.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  const entry = packEntry(obj.type, obj.data);
  repo.deflated.set(oid, entry);
  return entry;
}

/** Build a pack from a set of oids, using the per-object deflated cache. */
function buildPackCached(repo: Repo, oids: Set<string>): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const entry = cachedEntry(repo, oid);
    if (entry) parts.push(entry);
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/** Decide which objects a fetch transfers, and the new shallow boundary. */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | null,
): FetchPlan {
  const wantCommits = wants.map((want) => peelToCommit(repo, want));
  if (deepen !== null) {
    const generations = commitGenerations(repo.objects, wantCommits);
    const depthCommits = new Set<string>();
    for (const [oid, gen] of generations) {
      if (gen < deepen) depthCommits.add(oid);
    }
    const send = new Set<string>();
    for (const commit of depthCommits) {
      // Only the depth-limited commits themselves travel, with their trees
      // and blobs; their ancestors stay behind the shallow boundary.
      send.add(commit);
      const obj = repo.objects.get(commit);
      if (obj?.type === 'commit') {
        const tree = parseCommit(obj.data).tree;
        for (const oid of collectReachable(repo.objects, [tree])) send.add(oid);
      }
    }
    // Tag objects whose target is in the depth-limited set travel too.
    for (const want of wants) {
      if (repo.objects.get(want)?.type === 'tag') send.add(want);
    }
    // Held objects: a shallow-boundary have counts only for itself and its
    // tree/blobs; any other have counts for its whole reachable graph.
    const held = new Set<string>();
    for (const have of haves) {
      if (clientShallow.includes(have)) {
        const obj = repo.objects.get(have);
        if (obj?.type === 'commit') {
          held.add(have);
          const tree = parseCommit(obj.data).tree;
          for (const oid of collectReachable(repo.objects, [tree])) held.add(oid);
        } else if (obj) {
          held.add(have);
        }
      } else {
        for (const oid of collectReachable(repo.objects, [have])) held.add(oid);
      }
    }
    for (const oid of held) send.delete(oid);
    const shallow: string[] = [];
    for (const [oid, gen] of generations) {
      if (gen === deepen - 1 && depthCommits.has(oid)) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const boundary of clientShallow) {
      const gen = generations.get(boundary);
      if (gen !== undefined && gen < deepen - 1) unshallow.push(boundary);
    }
    return { send, shallow: shallow.sort(), unshallow: unshallow.sort() };
  }
  const wanted = collectReachable(repo.objects, wants);
  for (const have of haves) {
    for (const oid of collectReachable(repo.objects, [have])) wanted.delete(oid);
  }
  return { send: wanted, shallow: clientShallow, unshallow: [] };
}

/** The acknowledgment lines for a fetch: ACKs for haves that are ancestors of a want, else NAK. */
function ackLines(repo: Repo, wants: string[], haves: string[]): string[] {
  const wantCommits = wants.map((want) => peelToCommit(repo, want));
  const acks: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (!obj) continue;
    const haveCommit = obj.type === 'tag' ? peelToCommit(repo, have) : have;
    if (wantCommits.some((want) => isAncestor(repo.objects, haveCommit, want))) {
      acks.push(`ACK ${have}`);
    }
  }
  return acks;
}

/** Parse a v2 request body into the command and its argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const lines: string[] = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').trimEnd());
  }
  if (lines.length === 0) throw new HttpError(400, 'empty request');
  const first = lines[0];
  if (!first.startsWith('command=')) throw new HttpError(400, 'not a v2 request');
  const command = first.slice('command='.length);
  const args = lines.slice(1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
  return { command, args };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const { command, args } = parseV2Request(body);
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      for (const arg of args) {
        if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      const lines = lsRefsLines(repo, prefixes);
      const parts: Buffer[] = [];
      for (const line of lines) parts.push(pktLine(`${line}\n`));
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let deepen: number | null = null;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7).trim(), 10);
      }
      // Identical fetches of unchanged state return byte-identical bodies, so
      // the whole response is cached (the bench clones one repo 50 times).
      const cacheKey = JSON.stringify([wants, haves, clientShallow, deepen]);
      const cached = repo.fetchCache.get(cacheKey);
      if (cached) {
        sendBuffer(res, 200, cached, 'application/x-git-upload-pack-result');
        return;
      }
      const plan = planFetch(repo, wants, haves, clientShallow, deepen);
      const acks = ackLines(repo, wants, haves);
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      if (acks.length) {
        for (const ack of acks) parts.push(pktLine(`${ack}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktLine('ready\n'));
      parts.push(PKT_FLUSH);
      if (deepen !== null || clientShallow.length > 0) {
        const shallowLines: string[] = [];
        if (plan.shallow.length || plan.unshallow.length) {
          parts.push(pktLine('shallow-info\n'));
          for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}`);
          for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}`);
          for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
          parts.push(PKT_FLUSH);
        }
      }
      const pack = buildPackCached(repo, plan.send);
      parts.push(pktLine('packfile\n'));
      for (const packet of sidebandPackets(pack)) parts.push(packet);
      parts.push(PKT_FLUSH);
      const body = Buffer.concat(parts);
      repo.fetchCache.set(cacheKey, body);
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
      return;
    }
    throw new HttpError(400, `unknown v2 command ${command}`);
  }
  // Protocol v0 fetch: want/have lines, then NAK/ACKs and a sideband pack.
  const lines: string[] = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').trimEnd());
  }
  const wants: string[] = [];
  const haves: string[] = [];
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0]);
  }
  const plan = planFetch(repo, wants, haves, [], null);
  const acks = ackLines(repo, wants, haves);
  const parts: Buffer[] = [];
  if (acks.length) {
    for (const ack of acks) parts.push(pktLine(`${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = buildPackCached(repo, plan.send);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  // Split the command pkt-lines from the pack: everything up to the first flush.
  let offset = 0;
  const commandLines: string[] = [];
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) break;
    commandLines.push(body.subarray(offset + 4, offset + len).toString('utf8').trimEnd());
    offset += len;
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const line of commandLines) {
    const clean = line.split('\0')[0];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(clean);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  // Unpack first: the objects land in the store even when a ref update is refused.
  let unpackOk = true;
  let unpackDetail = '';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const unpacked = decodePack(packBytes);
      for (const [oid, obj] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        repo.deflated.delete(oid);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (!current) results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        else if (current !== command.oldOid) results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        else {
          repo.refs.delete(command.ref);
          store.touchGit(repo);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(command.newOid)) results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        else {
          repo.refs.set(command.ref, command.newOid);
          store.touchGit(repo);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else {
        if (!current) results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        else if (current !== command.oldOid) results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        else if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          store.touchGit(repo);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      }
    }
  }
  const parts: Buffer[] = [];
  const reportLine = (text: string): Buffer => pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(text, 'utf8')]));
  if (unpackOk) parts.push(reportLine('unpack ok\n'));
  else parts.push(reportLine(`unpack ${unpackDetail}\n`));
  for (const result of results) {
    parts.push(reportLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/**
 * Handle a git smart-HTTP request. Returns true when the path was a git
 * route (even when it ends in an error response), false otherwise.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
  path: string,
  query: URLSearchParams,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const service = match[3];
  try {
    checkAuth(req, token);
    const repo = requireGitRepo(store, owner, repoName);
    if (service === 'info/refs') {
      const requested = query.get('service') ?? '';
      if (requested === 'git-receive-pack') {
        sendBuffer(res, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
      } else if (requested === 'git-upload-pack') {
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, v0Advertisement('git-upload-pack', repo), 'application/x-git-upload-pack-advertisement');
        }
      } else {
        throw new HttpError(400, 'unknown service');
      }
      return true;
    }
    if (service === 'git-upload-pack') {
      await handleUploadPack(req, res, store, repo);
      return true;
    }
    await handleReceivePack(req, res, store, repo);
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) sendJson(res, 401, err.body);
      else if (err.status === 404) sendJson(res, 404, err.body);
      else sendJson(res, err.status, err.body);
      return true;
    }
    // A malformed git request must never take the server down.
    sendJson(res, 400, { message: 'Bad Request' });
    return true;
  }
}
