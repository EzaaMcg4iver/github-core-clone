import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

// Git object model, pack files and pkt-lines. Standard library only.
// Packs are written with plain (undeltified) zlib objects; the suite's
// client writes plain packs too, so the decoder only accepts types 1-4.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: SHA-1 over `<type> <len>\0` + bytes. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(objects: Map<string, StoredObject>, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  isDir: boolean;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.isDir ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries in git order (directories compare as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: no space');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul === -1) throw new Error('malformed tree: no NUL');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, isDir: mode === '40000' });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(text, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(object: string, type: ObjType, tag: string, tagger: string, message: string): Buffer {
  const text = `object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a pkt-line stream. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new Error(`pkt-line bad length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line overruns buffer');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}

/** The data payloads of a pkt-line stream, in order, ignoring flush/delim. */
export function pktDataLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buf)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- packs

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** One pack entry: varint header + zlib-deflated object bytes. */
export function packEntry(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([writePackObjectHeader(type, data.length), zlibDeflate(data)]);
}

/** Build a whole pack (version 2) from a list of objects, with a SHA-1 trailer. */
export function buildPack(entries: { type: ObjType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) parts.push(packEntry(entry.type, entry.data));
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Find the length of the zlib stream starting at `start`: the smallest length that inflates cleanly. */
function deflatedLength(buf: Buffer, start: number): number {
  let low = 1;
  let high = buf.length - start;
  // inflateSync ignores trailing bytes, so success is monotone in length.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      zlibInflate(buf.subarray(start, start + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  // Verify the candidate really inflates.
  zlibInflate(buf.subarray(start, start + low));
  return low;
}

/** Decode a pack into objects keyed by oid. Only plain object types (1-4) are accepted. */
export function decodePack(buf: Buffer): Map<string, StoredObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, StoredObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length - 20) throw new Error('pack truncated');
    const first = buf[offset];
    const code = (first >> 4) & 0x07;
    const type = CODE_TYPES[code];
    if (!type) throw new Error(`unsupported pack object type ${code}`);
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (buf[offset - 1] & 0x80) {
      size |= (buf[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    const deflatedLen = deflatedLength(buf, offset);
    const data = zlibInflate(buf.subarray(offset, offset + deflatedLen));
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
    offset += deflatedLen;
    const oid = objectId(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
  }
  return objects;
}

// ---------------------------------------------------------------- reachability

/** All objects reachable from `tips` (commits, their trees/blobs, tag targets). */
export function collectReachable(objects: Map<string, StoredObject>, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(objects: Map<string, StoredObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return collectReachable(objects, [descendant]).has(ancestor);
}

/** The merge base of two commits: the newest commit reachable from both. */
export function mergeBase(objects: Map<string, StoredObject>, a: string, b: string): string | null {
  const fromA = collectReachable(objects, [a]);
  // Walk from b newest-first (parents are older); the first commit also in fromA is a base.
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) {
      const obj = objects.get(oid);
      if (obj?.type === 'commit') return oid;
    }
    const obj = objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** The file map of a commit's tree: path -> {oid, mode}. */
export function flattenTree(objects: Map<string, StoredObject>, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDir) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a tree object from a flat file map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeFromFiles(
  objects: Map<string, StoredObject>,
  files: Map<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      let child = node.dirs.get(segment);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], file);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid, isDir: false });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child), isDir: true });
    return storeObject(objects, 'tree', buildTree(entries));
  };
  return writeNode(root);
}

/** The commit-generation distance from a set of tip commits (0 = the tips). */
export function commitGenerations(
  objects: Map<string, StoredObject>,
  tips: Iterable<string>,
): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [...tips].map((oid) => ({ oid, gen: 0 }));
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const known = generations.get(oid);
    if (known !== undefined && known <= gen) continue;
    generations.set(oid, gen);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return generations;
}
