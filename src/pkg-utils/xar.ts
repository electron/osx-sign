import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { escapeXml, findChild, findChildren, parseXml, XmlElement } from './xml.js';

/**
 * Minimal xar (eXtensible ARchiver) writer/reader covering what flat
 * installer packages use: a zlib-compressed XML table of contents, a SHA-1
 * heap checksum at offset 0, and file entries stored either raw
 * (octet-stream) or zlib-compressed (application/x-gzip in xar parlance).
 */

const HEADER_SIZE = 28;
const CHECKSUM_ALG_SHA1 = 1;

export interface XarWriteFile {
  name: string;
  /** Present for directories. */
  children?: XarWriteFile[];
  /** File contents as one or more buffers (concatenated). */
  parts?: Buffer[];
  /**
   * Compress the contents into the heap with zlib. Skip for data that is
   * already compressed (e.g. gzip payloads), matching the native tools.
   */
  compress?: boolean;
}

interface PreparedFile {
  id: number;
  name: string;
  children: PreparedFile[];
  heap?: {
    offset: number;
    length: number;
    size: number;
    archivedChecksum: string;
    extractedChecksum: string;
    encoding: string;
    parts: Buffer[];
  };
}

function sha1(parts: Buffer[]): string {
  const hash = crypto.createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function deflate(parts: Buffer[]): Buffer {
  return zlib.deflateSync(parts.length === 1 ? parts[0] : Buffer.concat(parts));
}

function tocTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Serialize a xar archive to `outputPath`. Files are laid out in the heap in
 * table-of-contents order, after the 20-byte TOC checksum at offset 0.
 */
export async function writeXar(
  outputPath: string,
  files: XarWriteFile[],
  opts: { creationTime?: Date } = {},
): Promise<void> {
  let nextId = 1;
  let heapOffset = 20; // TOC checksum occupies [0, 20)

  const prepare = (file: XarWriteFile): PreparedFile => {
    const prepared: PreparedFile = { id: nextId++, name: file.name, children: [] };
    if (file.parts) {
      const size = file.parts.reduce((sum, part) => sum + part.length, 0);
      const extractedChecksum = sha1(file.parts);
      let heapParts = file.parts;
      let encoding = 'application/octet-stream';
      let archivedChecksum = extractedChecksum;
      if (file.compress) {
        heapParts = [deflate(file.parts)];
        encoding = 'application/x-gzip';
        archivedChecksum = sha1(heapParts);
      }
      const length = heapParts.reduce((sum, part) => sum + part.length, 0);
      prepared.heap = {
        offset: heapOffset,
        length,
        size,
        archivedChecksum,
        extractedChecksum,
        encoding,
        parts: heapParts,
      };
      heapOffset += length;
    } else {
      prepared.children = (file.children ?? []).map(prepare);
    }
    return prepared;
  };

  const preparedFiles = files.map(prepare);

  const renderFile = (file: PreparedFile, indent: string): string => {
    let xml = `${indent}<file id="${file.id}">\n`;
    xml += `${indent} <name>${escapeXml(file.name)}</name>\n`;
    xml += `${indent} <type>${file.heap ? 'file' : 'directory'}</type>\n`;
    if (file.heap) {
      xml += `${indent} <data>\n`;
      xml += `${indent}  <archived-checksum style="sha1">${file.heap.archivedChecksum}</archived-checksum>\n`;
      xml += `${indent}  <extracted-checksum style="sha1">${file.heap.extractedChecksum}</extracted-checksum>\n`;
      xml += `${indent}  <encoding style="${file.heap.encoding}"/>\n`;
      xml += `${indent}  <size>${file.heap.size}</size>\n`;
      xml += `${indent}  <offset>${file.heap.offset}</offset>\n`;
      xml += `${indent}  <length>${file.heap.length}</length>\n`;
      xml += `${indent} </data>\n`;
    }
    for (const child of file.children) {
      xml += renderFile(child, indent + ' ');
    }
    xml += `${indent}</file>\n`;
    return xml;
  };

  let toc = '<?xml version="1.0" encoding="UTF-8"?>\n<xar>\n <toc>\n';
  toc += '  <checksum style="sha1">\n   <size>20</size>\n   <offset>0</offset>\n  </checksum>\n';
  toc += `  <creation-time>${tocTimestamp(opts.creationTime ?? new Date())}</creation-time>\n`;
  for (const file of preparedFiles) {
    toc += renderFile(file, '  ');
  }
  toc += ' </toc>\n</xar>\n';

  const tocRaw = Buffer.from(toc, 'utf8');
  const tocCompressed = zlib.deflateSync(tocRaw);
  const tocChecksum = crypto.createHash('sha1').update(tocCompressed).digest();

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('xar!', 0, 'ascii');
  header.writeUInt16BE(HEADER_SIZE, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(BigInt(tocCompressed.length), 8);
  header.writeBigUInt64BE(BigInt(tocRaw.length), 16);
  header.writeUInt32BE(CHECKSUM_ALG_SHA1, 24);

  const stream = fs.createWriteStream(outputPath);
  // Capture stream-level errors (ENOENT on the directory, ENOSPC, ...): they
  // are emitted as 'error' events, which would otherwise crash the process.
  let streamError: Error | null = null;
  const errorListener = (err: Error) => {
    streamError = streamError ?? err;
  };
  stream.on('error', errorListener);
  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (streamError) {
        reject(streamError);
        return;
      }
      stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });

  try {
    await write(header);
    await write(tocCompressed);
    await write(tocChecksum);
    const writeHeap = async (file: PreparedFile): Promise<void> => {
      if (file.heap) {
        for (const part of file.heap.parts) {
          await write(part);
        }
      }
      for (const child of file.children) {
        await writeHeap(child);
      }
    };
    for (const file of preparedFiles) {
      await writeHeap(file);
    }
  } finally {
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
  if (streamError) {
    throw streamError;
  }
}

export interface XarReadFile {
  /** Path within the archive, e.g. `component.pkg/PackageInfo`. */
  path: string;
  type: 'file' | 'directory';
  /** Decompressed contents (files only). */
  data?: Buffer;
}

/** Read a xar archive fully into memory, decompressing each member. */
export async function readXar(archivePath: string): Promise<XarReadFile[]> {
  const data = await fs.promises.readFile(archivePath);
  if (data.length < HEADER_SIZE || data.toString('ascii', 0, 4) !== 'xar!') {
    throw new Error(`${archivePath} is not a xar archive`);
  }
  const headerSize = data.readUInt16BE(4);
  const tocCompressedLength = Number(data.readBigUInt64BE(8));
  const heapStart = headerSize + tocCompressedLength;
  const toc = zlib.inflateSync(data.subarray(headerSize, heapStart)).toString('utf8');

  const root = parseXml(toc);
  const tocElement = findChild(root, 'toc');
  if (!tocElement) throw new Error(`${archivePath}: xar TOC is missing <toc>`);

  const results: XarReadFile[] = [];
  const visit = (element: XmlElement, prefix: string): void => {
    for (const file of findChildren(element, 'file')) {
      const name = findChild(file, 'name')?.text ?? '';
      const type = findChild(file, 'type')?.text === 'directory' ? 'directory' : 'file';
      const filePath = prefix ? `${prefix}/${name}` : name;
      if (type === 'directory') {
        results.push({ path: filePath, type });
        visit(file, filePath);
        continue;
      }
      const dataElement = findChild(file, 'data');
      if (!dataElement) {
        results.push({ path: filePath, type, data: Buffer.alloc(0) });
        continue;
      }
      const offset = Number(findChild(dataElement, 'offset')?.text ?? 'NaN');
      const length = Number(findChild(dataElement, 'length')?.text ?? 'NaN');
      if (!Number.isFinite(offset) || !Number.isFinite(length)) {
        throw new Error(`${archivePath}: invalid data offsets for ${filePath}`);
      }
      const raw = data.subarray(heapStart + offset, heapStart + offset + length);
      const encoding =
        findChild(dataElement, 'encoding')?.attributes.style ?? 'application/octet-stream';
      let contents: Buffer;
      if (encoding === 'application/octet-stream') {
        contents = Buffer.from(raw);
      } else if (encoding === 'application/x-gzip') {
        contents = zlib.inflateSync(raw);
      } else if (encoding === 'application/x-bzip2') {
        throw new Error(`${archivePath}: bzip2-encoded xar members are not supported`);
      } else {
        throw new Error(`${archivePath}: unsupported xar encoding ${encoding}`);
      }
      results.push({ path: filePath, type, data: contents });
    }
  };
  visit(tocElement, '');
  return results;
}
