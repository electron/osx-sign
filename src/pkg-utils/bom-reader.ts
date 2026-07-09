/**
 * Minimal reader for Apple's BOMStore format — enough to reconstruct the
 * information lsbom prints, used by the test-suite to verify parity between
 * our Bom writer and Apple's mkbom/pkgbuild.
 */

export interface BomPath {
  id: number;
  parentId: number;
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'device';
  architecture: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  size: number;
  checksum: number;
  linkTarget?: string;
}

export interface BomFile {
  numberOfPaths: number;
  sizeSum: number;
  /** Paths in tree (leaf traversal) order. */
  paths: BomPath[];
}

const TYPE_NAMES: Record<number, BomPath['type']> = {
  1: 'file',
  2: 'directory',
  3: 'symlink',
  4: 'device',
};

export function readBom(data: Buffer): BomFile {
  if (data.toString('ascii', 0, 8) !== 'BOMStore') {
    throw new Error('Not a BOMStore file');
  }
  const indexOffset = data.readUInt32BE(16);
  const varsOffset = data.readUInt32BE(24);

  const blockCount = data.readUInt32BE(indexOffset);
  const blockAt = (id: number): Buffer => {
    if (id < 0 || id >= blockCount) throw new Error(`Bom block ${id} out of range`);
    const addr = data.readUInt32BE(indexOffset + 4 + id * 8);
    const len = data.readUInt32BE(indexOffset + 8 + id * 8);
    return data.subarray(addr, addr + len);
  };

  const vars = new Map<string, number>();
  let pos = varsOffset;
  const varCount = data.readUInt32BE(pos);
  pos += 4;
  for (let i = 0; i < varCount; i++) {
    const blockId = data.readUInt32BE(pos);
    pos += 4;
    const nameLen = data.readUInt8(pos);
    pos += 1;
    const name = data.toString('ascii', pos, pos + nameLen);
    pos += nameLen;
    vars.set(name, blockId);
  }

  const bomInfoId = vars.get('BomInfo');
  const pathsId = vars.get('Paths');
  if (bomInfoId === undefined || pathsId === undefined) {
    throw new Error('Bom is missing BomInfo/Paths variables');
  }
  const bomInfo = blockAt(bomInfoId);
  const numberOfPaths = bomInfo.readUInt32BE(4);
  const infoEntries = bomInfo.readUInt32BE(8);
  const sizeSum = infoEntries > 0 ? bomInfo.readUInt32BE(20) : 0;

  const tree = blockAt(pathsId);
  if (tree.toString('ascii', 0, 4) !== 'tree') {
    throw new Error('Bom Paths variable is not a tree');
  }
  const rootNodeId = tree.readUInt32BE(8);

  // Find the leftmost leaf, then follow forward pointers.
  let node = blockAt(rootNodeId);
  while (node.readUInt16BE(0) === 0) {
    const count = node.readUInt16BE(2);
    if (count === 0) break;
    node = blockAt(node.readUInt32BE(12));
  }

  const paths: BomPath[] = [];
  const nameById = new Map<number, { parentId: number; name: string }>();
  for (;;) {
    const count = node.readUInt16BE(2);
    const forward = node.readUInt32BE(4);
    for (let i = 0; i < count; i++) {
      const valueId = node.readUInt32BE(12 + i * 8);
      const keyId = node.readUInt32BE(16 + i * 8);
      const key = blockAt(keyId);
      const parentId = key.readUInt32BE(0);
      let nameEnd = 4;
      while (nameEnd < key.length && key[nameEnd] !== 0) nameEnd++;
      const name = key.toString('utf8', 4, nameEnd);
      const value = blockAt(valueId);
      const id = value.readUInt32BE(0);
      const info = blockAt(value.readUInt32BE(4));
      const type = TYPE_NAMES[info.readUInt8(0)];
      if (!type) throw new Error(`Unknown Bom path type ${info.readUInt8(0)} for ${name}`);
      const linkNameLength = info.readUInt32BE(27);
      const record: BomPath = {
        id,
        parentId,
        name,
        path: '',
        type,
        architecture: info.readUInt16BE(2),
        mode: info.readUInt16BE(4),
        uid: info.readUInt32BE(6),
        gid: info.readUInt32BE(10),
        mtime: info.readUInt32BE(14),
        size: info.readUInt32BE(18),
        checksum: info.readUInt32BE(23),
      };
      if (linkNameLength > 0) {
        record.linkTarget = info.toString('utf8', 31, 31 + linkNameLength - 1);
      }
      nameById.set(id, { parentId, name });
      paths.push(record);
    }
    if (!forward) break;
    node = blockAt(forward);
  }

  for (const record of paths) {
    const segments: string[] = [];
    let cursor: { parentId: number; name: string } | undefined = {
      parentId: record.parentId,
      name: record.name,
    };
    while (cursor) {
      segments.unshift(cursor.name);
      cursor = cursor.parentId === 0 ? undefined : nameById.get(cursor.parentId);
    }
    record.path = segments.join('/');
  }

  return { numberOfPaths, sizeSum, paths };
}

/**
 * Render the same text lsbom prints by default (tab-separated path, mode,
 * uid/gid, size, checksum, link target), sorted by path like lsbom output.
 */
export function lsbomLines(bom: BomFile): string[] {
  const lines = bom.paths.map((p) => {
    const fields = [p.path, p.mode.toString(8), `${p.uid}/${p.gid}`];
    if (p.type === 'file' || p.type === 'symlink') {
      fields.push(String(p.size), String(p.checksum));
      if (p.linkTarget !== undefined) fields.push(p.linkTarget);
    }
    return fields.join('\t');
  });
  return lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
