import * as fs from 'fs';
import * as zlib from 'zlib';
import { debugLog } from '../util.js';

/**
 * Entry in a CPIO ODC archive
 */
interface CpioEntry {
  offset: number;
  magic: string;
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  gid: string;
  nlink: string;
  rdev: string;
  mtime: string;
  namesize: number;
  filesize: number;
  filename: string;
  dataOffset: number;
  data: Buffer;
}

/**
 * File type enumeration for cpio entries
 */
enum FileType {
  Socket = 0o14,
  Symlink = 0o12,
  Regular = 0o10,
  Block = 0o06,
  Directory = 0o04,
  Character = 0o02,
  FIFO = 0o01,
}

/**
 * Parse and modify permissions in a cpio (SVR4/ASCII) archive
 * This handles the 'odc' format (old portable ASCII format)
 */
class CpioModifier {
  private entries: CpioEntry[] = [];
  private static readonly MAGIC_NUMBER = '070707';
  private static readonly HEADER_SIZE = 76;
  private static readonly TRAILER_NAME = 'TRAILER!!!';

  /**
   * Parse cpio archive from buffer
   */
  public parseCpio(buffer: Buffer): CpioEntry[] {
    let offset = 0;
    this.entries = [];

    while (offset < buffer.length) {
      // Check for trailer
      if (buffer.length - offset < CpioModifier.HEADER_SIZE) break;

      // cpio odc format has 76-byte ASCII header
      const header = buffer.slice(offset, offset + CpioModifier.HEADER_SIZE).toString('ascii');

      // Check magic number (070707 for odc format)
      const magic = header.substr(0, 6);
      if (magic !== CpioModifier.MAGIC_NUMBER) {
        debugLog('Warning: Invalid magic number at offset in CPIO archive', offset);
        break;
      }

      // Parse header fields (all in octal ASCII)
      const entry: CpioEntry = {
        offset: offset,
        magic: magic,
        dev: header.substr(6, 6),
        ino: header.substr(12, 6),
        mode: header.substr(18, 6),
        uid: header.substr(24, 6),
        gid: header.substr(30, 6),
        nlink: header.substr(36, 6),
        rdev: header.substr(42, 6),
        mtime: header.substr(48, 11),
        namesize: parseInt(header.substr(59, 6), 8),
        filesize: parseInt(header.substr(65, 11), 8),
        filename: '',
        dataOffset: 0,
        data: Buffer.alloc(0),
      };

      offset += CpioModifier.HEADER_SIZE;

      // Read filename
      entry.filename = buffer.slice(offset, offset + entry.namesize - 1).toString('ascii');
      offset += entry.namesize;

      // Check for trailer entry
      if (entry.filename === CpioModifier.TRAILER_NAME) {
        this.entries.push(entry);
        break;
      }

      // Store file data offset and length
      entry.dataOffset = offset;
      entry.data = buffer.slice(offset, offset + entry.filesize);
      offset += entry.filesize;

      this.entries.push(entry);

      debugLog(
        `CPIO Found: ${entry.filename} (mode: ${entry.mode} = ${this.parseMode(entry.mode)}, uid = ${entry.uid}, gid = ${entry.gid})`,
      );
    }

    return this.entries;
  }

  /**
   * Parse mode string to human-readable format
   */
  private parseMode(modeStr: string): string {
    const mode = parseInt(modeStr, 8);
    const perms = (mode & 0o777).toString(8).padStart(3, '0');
    const type = (mode & 0o170000) >> 12;

    const typeMap: { [key: number]: string } = {
      [FileType.Socket]: 'socket',
      [FileType.Symlink]: 'symlink',
      [FileType.Regular]: 'file',
      [FileType.Block]: 'block',
      [FileType.Directory]: 'dir',
      [FileType.Character]: 'char',
      [FileType.FIFO]: 'fifo',
    };

    const typeStr = typeMap[type] || 'unknown';
    return `${typeStr}:${perms}`;
  }

  /**
   * Modify permissions for all files to match modified Bom
   * - Changes 755 to 775
   * - Changes 644 to 664
   * - Sets owner/group to root:admin (0/80 on macOS)
   */
  public modifyPermissions(): void {
    for (const entry of this.entries) {
      const mode = parseInt(entry.mode, 8);
      const originalType = mode & 0o170000; // Preserve file type bits
      const type = originalType >> 12;
      const perms = mode & 0o777;
      let newMode = mode;

      if (type === FileType.Regular || type === FileType.Directory || type === FileType.Symlink) {
        if (perms === 0o755) {
          newMode = originalType | 0o775;
        } else if (perms === 0o644) {
          newMode = originalType | 0o664;
        }

        if (entry.uid === '000000' && entry.gid === '000000') {
          // Set gid to 80 === admin
          // Leave uid at 0 === root
          entry.gid = (80).toString(8).padStart(6, '0');
        }
        debugLog(
          'CPIO rewriting permissions for',
          entry.filename,
          `from oldMode=${this.parseMode(mode.toString(8))}, newMode=${this.parseMode(newMode.toString(8))}`,
        );
      }

      // Convert back to 6-digit octal string
      entry.mode = newMode.toString(8).padStart(6, '0');
    }
  }

  /**
   * Rebuild cpio archive with modified permissions
   */
  public rebuildCpio(): Buffer {
    const chunks: Buffer[] = [];

    for (const entry of this.entries) {
      // Rebuild header
      const header = Buffer.from(
        entry.magic +
          entry.dev +
          entry.ino +
          entry.mode + // This now contains our modified permissions
          entry.uid +
          entry.gid +
          entry.nlink +
          entry.rdev +
          entry.mtime +
          entry.namesize.toString(8).padStart(6, '0') +
          entry.filesize.toString(8).padStart(11, '0'),
        'ascii',
      );

      chunks.push(header);

      // Add filename (with null terminator)
      const filenameBuffer = Buffer.alloc(entry.namesize);
      filenameBuffer.write(entry.filename, 0, 'ascii');
      chunks.push(filenameBuffer);

      // Add file data if not trailer
      if (entry.filename !== CpioModifier.TRAILER_NAME && entry.filesize > 0) {
        chunks.push(entry.data);
      }
    }

    return Buffer.concat(chunks);
  }

  /**
   * Get the list of entries for inspection
   */
  public getEntries(): CpioEntry[] {
    return this.entries;
  }
}

export async function modifyPayloadPermissions(payloadFile: string): Promise<void> {
  debugLog('Reading Payload for permissions modification...');
  const gzippedData = await fs.promises.readFile(payloadFile);

  debugLog('Ungzipping payload in memory...');
  const cpioData = zlib.gunzipSync(gzippedData);
  debugLog(` -- Uncompressed size: ${cpioData.length} bytes`);

  debugLog('Parsing cpio archive...');
  const modifier = new CpioModifier();
  modifier.parseCpio(cpioData);

  modifier.modifyPermissions();

  debugLog('Rebuilding cpio archive...');
  const newCpioData = modifier.rebuildCpio();

  debugLog('Gzipping modified archive...');
  const newGzippedData = zlib.gzipSync(newCpioData, { level: 9 });

  debugLog(`Writing Pyload back to disk...`);
  fs.writeFileSync(payloadFile, newGzippedData);
}
