import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Parsed entry of a cpio odc archive. */
export interface ParsedCpioEntry {
  name: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  rdev: number;
  mtime: number;
  data: Buffer;
}

export function parseCpio(buf: Buffer): ParsedCpioEntry[] {
  const entries: ParsedCpioEntry[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const header = buf.subarray(offset, offset + 76).toString('latin1');
    if (header.slice(0, 6) !== '070707') {
      // Trailing zero padding
      const rest = buf.subarray(offset);
      if (!rest.every((b) => b === 0)) {
        throw new Error(`Invalid cpio data at offset ${offset}`);
      }
      break;
    }
    const namesize = parseInt(header.slice(59, 65), 8);
    const filesize = parseInt(header.slice(65, 76), 8);
    const name = buf.subarray(offset + 76, offset + 76 + namesize - 1).toString('utf8');
    const data = buf.subarray(offset + 76 + namesize, offset + 76 + namesize + filesize);
    entries.push({
      name,
      dev: parseInt(header.slice(6, 12), 8),
      ino: parseInt(header.slice(12, 18), 8),
      mode: parseInt(header.slice(18, 24), 8),
      uid: parseInt(header.slice(24, 30), 8),
      gid: parseInt(header.slice(30, 36), 8),
      nlink: parseInt(header.slice(36, 42), 8),
      rdev: parseInt(header.slice(42, 48), 8),
      mtime: parseInt(header.slice(48, 59), 8),
      data: Buffer.from(data),
    });
    offset += 76 + namesize + filesize;
  }
  return entries;
}

function isAppleDouble(name: string): boolean {
  return (name.split('/').pop() ?? '').startsWith('._');
}

/**
 * Serialize parsed entries back to cpio bytes with sequential inodes. Used to
 * normalize native payloads: environments that stamp com.apple.provenance
 * xattrs make pkgbuild emit AppleDouble (`._`) entries which our
 * implementation intentionally does not produce. Dropping them and
 * renumbering inodes yields the byte stream pkgbuild produces on a machine
 * without those xattrs.
 */
export function normalizeCpio(buf: Buffer): Buffer {
  const entries = parseCpio(buf).filter((e) => !isAppleDouble(e.name));
  const chunks: Buffer[] = [];
  let written = 0;
  entries.forEach((entry, ino) => {
    const nameBuf = Buffer.concat([Buffer.from(entry.name, 'utf8'), Buffer.from([0])]);
    const header =
      '070707' +
      entry.dev.toString(8).padStart(6, '0') +
      ino.toString(8).padStart(6, '0') +
      entry.mode.toString(8).padStart(6, '0') +
      entry.uid.toString(8).padStart(6, '0') +
      entry.gid.toString(8).padStart(6, '0') +
      entry.nlink.toString(8).padStart(6, '0') +
      entry.rdev.toString(8).padStart(6, '0') +
      entry.mtime.toString(8).padStart(11, '0') +
      nameBuf.length.toString(8).padStart(6, '0') +
      entry.data.length.toString(8).padStart(11, '0');
    chunks.push(Buffer.from(header, 'latin1'), nameBuf, entry.data);
    written += 76 + nameBuf.length + entry.data.length;
  });
  const padding = (512 - (written % 512)) % 512;
  if (padding > 0) chunks.push(Buffer.alloc(padding));
  return Buffer.concat(chunks);
}

/** Run lsbom and return sorted lines, with AppleDouble entries removed. */
export function lsbomNormalized(bomPath: string, args: string[] = []): string[] {
  const out = execFileSync('lsbom', [...args, bomPath], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.trim().length > 0 && !isAppleDouble(line.split('\t')[0]))
    .sort();
}

/** Strip fields that legitimately differ between the two implementations. */
export function normalizeGeneratorVersion(xml: string): string {
  return xml.replace(/generator-version="[^"]*"/, 'generator-version="NORMALIZED"');
}

export interface FixtureFile {
  path: string;
  content?: Buffer | string;
  mode?: number;
  symlink?: string;
  directory?: boolean;
  /** Seconds since epoch; also applied to files without an explicit value. */
  mtime?: number;
}

export const FIXTURE_EPOCH = 1700000000;

/**
 * Materialize a fixture app under `root`. Directories get deterministic
 * mtimes applied bottom-up so parent timestamps survive child creation.
 */
export function writeFixtureTree(root: string, files: FixtureFile[]): void {
  const dirs = new Set<string>([root]);
  for (const file of files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let dir = path.dirname(target);
    while (dir.length >= root.length) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
    if (file.directory) {
      fs.mkdirSync(target, { recursive: true });
      dirs.add(target);
    } else if (file.symlink !== undefined) {
      fs.symlinkSync(file.symlink, target);
    } else {
      fs.writeFileSync(target, file.content ?? '');
      if (file.mode !== undefined) fs.chmodSync(target, file.mode);
    }
    if (!file.directory && file.symlink === undefined) {
      const when = new Date((file.mtime ?? FIXTURE_EPOCH) * 1000);
      fs.utimesSync(target, when, when);
    }
  }
  // Apply directory mtimes deepest-first so they stick.
  const when = new Date(FIXTURE_EPOCH * 1000);
  [...dirs]
    .sort((a, b) => b.length - a.length)
    .forEach((dir) => {
      fs.utimesSync(dir, when, when);
    });
}

export function commandExists(command: string): boolean {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const INFO_PLIST = (
  identifier: string,
  extra: Record<string, string>,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>${identifier}</string>
${Object.entries(extra)
  .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`)
  .join('\n')}
</dict>
</plist>
`;

export function infoPlist(
  identifier: string,
  extra: Record<string, string> = {
    CFBundleName: 'Fixture',
    CFBundleShortVersionString: '1.2.3',
    CFBundleVersion: '123',
    CFBundleExecutable: 'Fixture',
  },
): string {
  return INFO_PLIST(identifier, extra);
}
