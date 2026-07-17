import { WalkEntry, bomNameCompare, bomOrder } from './walk.js';

/**
 * Writer for Apple's Bill-of-Materials (BOMStore) binary format, as produced
 * by mkbom/pkgbuild and consumed by Installer, lsbom and ditto.
 *
 * Layout: a 512-byte header, a heap of variable-size blocks, a block index
 * table (u32 count, then {u32 address, u32 length} per block; block 0 is the
 * null block), and a variables area naming the top-level blocks (BomInfo,
 * Paths, HLIndex, VIndex, Size64).
 *
 * The Paths variable is a B+tree ("tree" block) keyed by (parent id, name)
 * whose leaves point at BOMPathInfo1 {id, info2 block} / BOMFile
 * {parent id, NUL-terminated name} pairs. Ids are assigned depth-first with
 * children in byte-lexicographic order, matching Apple's tools.
 */

const HEADER_SIZE = 512;
const TREE_BLOCK_SIZE = 4096;
const TREE_ENTRIES_PER_LEAF = 256;
const PATH_TYPE: Record<WalkEntry['type'], number> = {
  file: 1,
  directory: 2,
  symlink: 3,
};

interface BomEntryRecord {
  id: number;
  parentId: number;
  name: string;
  entry: WalkEntry;
}

class BlockStore {
  /** Block 0 is the null block. */
  private blocks: Buffer[] = [Buffer.alloc(0)];

  add(buf: Buffer): number {
    this.blocks.push(buf);
    return this.blocks.length - 1;
  }

  /** Reserve an id whose contents are provided later. */
  reserve(): number {
    this.blocks.push(Buffer.alloc(0));
    return this.blocks.length - 1;
  }

  set(id: number, buf: Buffer): void {
    this.blocks[id] = buf;
  }

  assemble(vars: { name: string; blockId: number }[]): Buffer {
    // Header | blocks | index | vars
    let offset = HEADER_SIZE;
    const addresses: number[] = Array.from({ length: this.blocks.length }, () => 0);
    for (let i = 0; i < this.blocks.length; i++) {
      addresses[i] = this.blocks[i].length === 0 ? 0 : offset;
      offset += this.blocks[i].length;
    }
    const indexOffset = offset;
    // The pointer table is followed by a free-space list that BOMStore always
    // parses: an entry count plus zero-terminated {address, length} pairs. We
    // never leave holes, so it is empty (count 0 + terminator pair).
    const freeListLength = 12;
    const indexLength = 4 + this.blocks.length * 8 + freeListLength;
    offset += indexLength;
    const varsOffset = offset;
    let varsLength = 4;
    for (const v of vars) varsLength += 5 + Buffer.byteLength(v.name);

    const total = varsOffset + varsLength;
    const out = Buffer.alloc(total);

    out.write('BOMStore', 0, 'ascii');
    out.writeUInt32BE(1, 8); // version
    out.writeUInt32BE(this.blocks.length - 1, 12); // number of non-null blocks
    out.writeUInt32BE(indexOffset, 16);
    out.writeUInt32BE(indexLength, 20);
    out.writeUInt32BE(varsOffset, 24);
    out.writeUInt32BE(varsLength, 28);

    let pos = HEADER_SIZE;
    for (let i = 0; i < this.blocks.length; i++) {
      this.blocks[i].copy(out, pos);
      pos += this.blocks[i].length;
    }

    out.writeUInt32BE(this.blocks.length, pos);
    pos += 4;
    for (let i = 0; i < this.blocks.length; i++) {
      out.writeUInt32BE(addresses[i], pos);
      out.writeUInt32BE(this.blocks[i].length, pos + 4);
      pos += 8;
    }
    pos += freeListLength; // empty free list: all zeroes

    out.writeUInt32BE(vars.length, pos);
    pos += 4;
    for (const v of vars) {
      out.writeUInt32BE(v.blockId, pos);
      pos += 4;
      out.writeUInt8(Buffer.byteLength(v.name), pos);
      pos += 1;
      out.write(v.name, pos, 'ascii');
      pos += Buffer.byteLength(v.name);
    }

    return out;
  }
}

function pathInfo2(entry: WalkEntry, checksum: number): Buffer {
  const isRoot = entry.path === '.';
  const linkTarget = entry.type === 'symlink' ? Buffer.from(entry.linkTarget ?? '', 'utf8') : null;
  // Apple appends per-type trailing reserved zero bytes: 4 for regular files,
  // 8 for symlinks, none for directories.
  const trailing = entry.type === 'file' ? 4 : entry.type === 'symlink' ? 8 : 0;
  const linkNameLength = linkTarget ? linkTarget.length + 1 : 0;
  // Base record is 31 bytes: type, unknown, architecture, mode, user, group,
  // modtime, size, unknown, checksum, linkNameLength.
  const buf = Buffer.alloc(31 + linkNameLength + trailing);
  buf.writeUInt8(PATH_TYPE[entry.type], 0);
  buf.writeUInt8(1, 1); // unknown, always 1
  buf.writeUInt16BE(isRoot ? 0x01 : 0x0f, 2); // "architecture"
  buf.writeUInt16BE(isRoot ? 0 : entry.mode & 0xffff, 4);
  buf.writeUInt32BE(entry.uid, 6);
  buf.writeUInt32BE(entry.gid, 10);
  buf.writeUInt32BE(isRoot ? 0 : entry.mtime, 14);
  buf.writeUInt32BE(isRoot ? 0 : entry.size >>> 0, 18);
  buf.writeUInt8(1, 22); // unknown, always 1
  buf.writeUInt32BE(isRoot ? 0 : checksum >>> 0, 23);
  buf.writeUInt32BE(linkNameLength, 27);
  if (linkTarget) {
    linkTarget.copy(buf, 31);
    // NUL terminator is already zero from Buffer.alloc
  }
  return buf;
}

function emptyTree(store: BlockStore, blockSize: number): number {
  const leaf = Buffer.alloc(blockSize);
  leaf.writeUInt16BE(1, 0); // isLeaf
  const leafId = store.add(leaf);
  const tree = Buffer.alloc(21);
  tree.write('tree', 0, 'ascii');
  tree.writeUInt32BE(1, 4); // version
  tree.writeUInt32BE(leafId, 8);
  tree.writeUInt32BE(blockSize, 12);
  tree.writeUInt32BE(0, 16); // path count
  return store.add(tree);
}

/**
 * Build a B+tree from ordered (value, key) block-id pairs. Returns the block
 * id of the root node. Interior entries carry the last key of each child,
 * mirroring Apple's mkbom.
 */
function buildTree(store: BlockStore, pairs: { value: number; key: number }[]): number {
  if (pairs.length === 0) {
    const leaf = Buffer.alloc(TREE_BLOCK_SIZE);
    leaf.writeUInt16BE(1, 0);
    return store.add(leaf);
  }

  // Split into leaves.
  const leafChunks: { value: number; key: number }[][] = [];
  for (let i = 0; i < pairs.length; i += TREE_ENTRIES_PER_LEAF) {
    leafChunks.push(pairs.slice(i, i + TREE_ENTRIES_PER_LEAF));
  }
  const leafIds = leafChunks.map(() => store.reserve());
  leafChunks.forEach((chunk, i) => {
    const buf = Buffer.alloc(TREE_BLOCK_SIZE);
    buf.writeUInt16BE(1, 0);
    buf.writeUInt16BE(chunk.length, 2);
    buf.writeUInt32BE(i + 1 < leafIds.length ? leafIds[i + 1] : 0, 4); // forward
    buf.writeUInt32BE(i > 0 ? leafIds[i - 1] : 0, 8); // backward
    let pos = 12;
    for (const pair of chunk) {
      buf.writeUInt32BE(pair.value, pos);
      buf.writeUInt32BE(pair.key, pos + 4);
      pos += 8;
    }
    store.set(leafIds[i], buf);
  });

  // Build interior levels until a single node remains.
  let level: { nodeId: number; lastKey: number }[] = leafChunks.map((chunk, i) => ({
    nodeId: leafIds[i],
    lastKey: chunk[chunk.length - 1].key,
  }));
  while (level.length > 1) {
    const next: { nodeId: number; lastKey: number }[] = [];
    for (let i = 0; i < level.length; i += TREE_ENTRIES_PER_LEAF) {
      const group = level.slice(i, i + TREE_ENTRIES_PER_LEAF);
      const buf = Buffer.alloc(TREE_BLOCK_SIZE);
      buf.writeUInt16BE(0, 0); // interior
      buf.writeUInt16BE(group.length, 2);
      let pos = 12;
      for (const child of group) {
        buf.writeUInt32BE(child.nodeId, pos);
        buf.writeUInt32BE(child.lastKey, pos + 4);
        pos += 8;
      }
      next.push({ nodeId: store.add(buf), lastKey: group[group.length - 1].lastKey });
    }
    level = next;
  }
  return level[0].nodeId;
}

/**
 * Generate a Bom for a walked tree. `checksums` maps entry path to the CRC32
 * of the file contents (or symlink target), as computed while writing the
 * payload.
 */
export interface BomArchInfo {
  /** Summed Mach-O slice sizes per cpu type. */
  archSizes: Map<number, number>;
  /** Total bytes of files identified as Mach-O (excluded from the cpu-type-0 sum). */
  machOFileBytes: number;
}

export function writeBom(
  root: WalkEntry,
  checksums: Map<string, number>,
  archInfo?: BomArchInfo,
): Buffer {
  const store = new BlockStore();

  // Assign ids depth-first with byte-lexicographically sorted children.
  const records: BomEntryRecord[] = [];
  const idByPath = new Map<string, number>();
  let nextId = 1;
  for (const entry of bomOrder(root)) {
    const id = nextId++;
    idByPath.set(entry.path, id);
    const parentPath = entry.path === '.' ? null : entry.path.slice(0, entry.path.lastIndexOf('/'));
    const parentId =
      parentPath === null ? 0 : (idByPath.get(parentPath === '' ? '.' : parentPath) ?? 0);
    records.push({ id, parentId, name: entry.name, entry });
  }

  // Tree entries sorted by (parent id, decomposed-byte-lexicographic name).
  const sorted = [...records].sort((a, b) => {
    if (a.parentId !== b.parentId) return a.parentId - b.parentId;
    return bomNameCompare(a.name, b.name);
  });

  // BomInfo: version, path count (+1 for the archive trailer), then one size
  // entry per cpu type. Entry 0 sums every non-Mach-O byte; Mach-O files
  // contribute their slice sizes to their cpu types instead.
  let sizeSum = 0;
  for (const record of records) {
    if (record.entry.path !== '.') sizeSum += record.entry.size;
  }
  const archEntries: { cpuType: number; size: number }[] = [
    { cpuType: 0, size: sizeSum - (archInfo?.machOFileBytes ?? 0) },
  ];
  if (archInfo) {
    for (const cpuType of [...archInfo.archSizes.keys()].sort((a, b) => a - b)) {
      archEntries.push({ cpuType, size: archInfo.archSizes.get(cpuType)! });
    }
  }
  const bomInfo = Buffer.alloc(12 + archEntries.length * 16);
  bomInfo.writeUInt32BE(1, 0);
  bomInfo.writeUInt32BE(records.length + 1, 4);
  bomInfo.writeUInt32BE(archEntries.length, 8);
  archEntries.forEach((entry, i) => {
    bomInfo.writeUInt32BE(entry.cpuType >>> 0, 12 + i * 16);
    bomInfo.writeUInt32BE(entry.size >>> 0, 20 + i * 16);
  });
  const bomInfoId = store.add(bomInfo);

  const info2Ids: number[] = [];
  const pairs = sorted.map((record) => {
    const info2Id = store.add(pathInfo2(record.entry, checksums.get(record.entry.path) ?? 0));
    info2Ids.push(info2Id);
    const info1 = Buffer.alloc(8);
    info1.writeUInt32BE(record.id, 0);
    info1.writeUInt32BE(info2Id, 4);
    const value = store.add(info1);
    const nameBuf = Buffer.from(record.name, 'utf8');
    const file = Buffer.alloc(4 + nameBuf.length + 1);
    file.writeUInt32BE(record.parentId, 0);
    nameBuf.copy(file, 4);
    const key = store.add(file);
    return { value, key };
  });

  const pathsRootId = buildTree(store, pairs);
  const pathsTree = Buffer.alloc(21);
  pathsTree.write('tree', 0, 'ascii');
  pathsTree.writeUInt32BE(1, 4);
  pathsTree.writeUInt32BE(pathsRootId, 8);
  pathsTree.writeUInt32BE(TREE_BLOCK_SIZE, 12);
  pathsTree.writeUInt32BE(records.length, 16);
  const pathsId = store.add(pathsTree);

  // HLIndex: hardlink index. Every path gets an entry mapping a pointer to
  // its BOMPathInfo2 block to a (here always empty) subtree of hardlinked
  // paths, keyed in ascending info2 block order — exactly what mkbom emits
  // for a tree without hardlinks.
  const hlPairs = info2Ids.map((info2Id) => {
    const subLeaf = Buffer.alloc(64);
    subLeaf.writeUInt16BE(1, 0);
    const subLeafId = store.add(subLeaf);
    const subTree = Buffer.alloc(21);
    subTree.write('tree', 0, 'ascii');
    subTree.writeUInt32BE(1, 4);
    subTree.writeUInt32BE(subLeafId, 8);
    subTree.writeUInt32BE(64, 12);
    const subTreeId = store.add(subTree);
    const keyPtr = Buffer.alloc(4);
    keyPtr.writeUInt32BE(info2Id, 0);
    const valuePtr = Buffer.alloc(4);
    valuePtr.writeUInt32BE(subTreeId, 0);
    return { value: store.add(valuePtr), key: store.add(keyPtr) };
  });
  const hlRootId = buildTree(store, hlPairs);
  const hlTree = Buffer.alloc(21);
  hlTree.write('tree', 0, 'ascii');
  hlTree.writeUInt32BE(1, 4);
  hlTree.writeUInt32BE(hlRootId, 8);
  hlTree.writeUInt32BE(TREE_BLOCK_SIZE, 12);
  hlTree.writeUInt32BE(records.length, 16);
  const hlIndexId = store.add(hlTree);

  // VIndex: an indirection struct pointing at an empty tree with 128-byte blocks.
  const vTreeId = emptyTree(store, 128);
  const vIndex = Buffer.alloc(13);
  vIndex.writeUInt32BE(1, 0);
  vIndex.writeUInt32BE(vTreeId, 4);
  const vIndexId = store.add(vIndex);

  // Size64: tree of 64-bit sizes for files over 4 GB. Empty; files that large
  // are rejected upstream to match the 32-bit fields used elsewhere.
  const size64Id = emptyTree(store, TREE_BLOCK_SIZE);

  return store.assemble([
    { name: 'BomInfo', blockId: bomInfoId },
    { name: 'Paths', blockId: pathsId },
    { name: 'HLIndex', blockId: hlIndexId },
    { name: 'VIndex', blockId: vIndexId },
    { name: 'Size64', blockId: size64Id },
  ]);
}
