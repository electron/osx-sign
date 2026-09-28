import fs from 'node:fs';

import { WalkEntry, cpioOrder } from './walk.js';
import { cksum, cksumFinalize, cksumUpdate } from './cksum.js';
import { machOSliceSizes } from './macho.js';

const MAGIC = '070707';
const TRAILER_NAME = 'TRAILER!!!';
const BLOCK_SIZE = 512;
/** Read large files in slices so peak memory stays bounded. */
const FILE_READ_CHUNK = 8 * 1024 * 1024;

function octal(value: number, width: number): string {
  const str = (value >>> 0).toString(8);
  if (str.length > width) {
    throw new Error(`cpio field overflow: ${value} does not fit in ${width} octal digits`);
  }
  return str.padStart(width, '0');
}

function header(fields: {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  rdev: number;
  mtime: number;
  namesize: number;
  filesize: number;
}): Buffer {
  const str =
    MAGIC +
    octal(fields.dev, 6) +
    octal(fields.ino, 6) +
    octal(fields.mode, 6) +
    octal(fields.uid, 6) +
    octal(fields.gid, 6) +
    octal(fields.nlink, 6) +
    octal(fields.rdev, 6) +
    octal(fields.mtime, 11) +
    octal(fields.namesize, 6) +
    octal(fields.filesize, 11);
  return Buffer.from(str, 'ascii');
}

export interface CpioWriteResult {
  /** Total size of the uncompressed cpio stream. */
  byteLength: number;
  /** cksum CRC of each file's contents / symlink's target, keyed by path. */
  checksums: Map<string, number>;
  /** Summed Mach-O slice sizes per cpu type (for the BomInfo header). */
  archSizes: Map<number, number>;
  /** Total on-disk bytes of files identified as Mach-O. */
  machOFileBytes: number;
}

/**
 * Generate the cpio "odc" (portable ASCII) archive for a walked tree,
 * byte-identical to the payload stream pkgbuild produces. Yields buffers;
 * file contents are read lazily so only one read chunk is in flight at a
 * time. CRC32 checksums (needed for the Bom) are computed during the single
 * pass over file data and stored into `result.checksums`.
 */
export async function* cpioStream(
  root: WalkEntry,
  result: CpioWriteResult,
): AsyncGenerator<Buffer> {
  let ino = 0;
  let written = 0;

  const emit = (buf: Buffer): Buffer => {
    written += buf.length;
    return buf;
  };

  // 6-digit octal fields cap at 0o777777. The inode counter is synthetic and
  // wraps like other cpio writers; uid/gid beyond the field (e.g. directory
  // accounts on LDAP-bound machines) fall back to root, matching the
  // ownership the payload records anyway.
  const wrapIno = (value: number): number => value & 0o777777;
  const clampId = (value: number): number => (value <= 0o777777 ? value : 0);

  for (const entry of cpioOrder(root)) {
    const nameBuf = Buffer.concat([Buffer.from(entry.path, 'utf8'), Buffer.from([0])]);
    const isLink = entry.type === 'symlink';
    const dataSize = entry.type === 'file' ? entry.size : isLink ? entry.size : 0;
    yield emit(
      header({
        dev: 0,
        ino: wrapIno(ino++),
        mode: entry.mode,
        uid: clampId(entry.uid),
        gid: clampId(entry.gid),
        nlink: clampId(entry.nlink),
        rdev: 0,
        mtime: entry.mtime,
        namesize: nameBuf.length,
        filesize: dataSize,
      }),
    );
    yield emit(nameBuf);

    if (isLink) {
      const target = Buffer.from(entry.linkTarget ?? '', 'utf8');
      result.checksums.set(entry.path, cksum(target));
      yield emit(target);
    } else if (entry.type === 'file') {
      if (entry.size === 0) {
        result.checksums.set(entry.path, cksumFinalize(0, 0));
        continue;
      }
      const fh = await fs.promises.open(entry.sourcePath, 'r');
      try {
        let crc = 0;
        let remaining = entry.size;
        let first = true;
        while (remaining > 0) {
          const chunk = Buffer.allocUnsafe(Math.min(remaining, FILE_READ_CHUNK));
          // Partial reads short of EOF are legal (network filesystems); keep
          // reading until the chunk is full or the file truly ends early.
          let filled = 0;
          while (filled < chunk.length) {
            const { bytesRead } = await fh.read(chunk, filled, chunk.length - filled);
            if (bytesRead === 0) {
              throw new Error(
                `File changed while packaging: ${entry.sourcePath} (expected ${entry.size} bytes, hit end of file early)`,
              );
            }
            filled += bytesRead;
          }
          if (first) {
            first = false;
            const slices = machOSliceSizes(chunk, entry.size);
            if (slices) {
              result.machOFileBytes += entry.size;
              for (const [cpuType, size] of slices) {
                result.archSizes.set(cpuType, (result.archSizes.get(cpuType) ?? 0) + size);
              }
            }
          }
          crc = cksumUpdate(crc, chunk);
          remaining -= chunk.length;
          yield emit(chunk);
        }
        result.checksums.set(entry.path, cksumFinalize(crc, entry.size));
      } finally {
        await fh.close();
      }
    }
  }

  // Trailer entry: the inode counter keeps running, everything else is zero.
  const trailerName = Buffer.concat([Buffer.from(TRAILER_NAME, 'ascii'), Buffer.from([0])]);
  yield emit(
    header({
      dev: 0,
      ino: wrapIno(ino++),
      mode: 0,
      uid: 0,
      gid: 0,
      nlink: 1,
      rdev: 0,
      mtime: 0,
      namesize: trailerName.length,
      filesize: 0,
    }),
  );
  yield emit(trailerName);

  const padding = (BLOCK_SIZE - (written % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding > 0) {
    yield emit(Buffer.alloc(padding));
  }
  result.byteLength = written;
}

export function newCpioWriteResult(): CpioWriteResult {
  return { byteLength: 0, checksums: new Map(), archSizes: new Map(), machOFileBytes: 0 };
}
