import fs from 'node:fs';
import path from 'node:path';

/**
 * A single filesystem node captured during a package tree walk.
 *
 * Metadata mirrors what Apple's `pkgbuild` records: uid/gid are forced to
 * root/wheel, directory `nlink`/`size` are derived from the child count (the
 * values APFS reports) so that output is deterministic on every platform.
 */
export interface WalkEntry {
  /** Archive-relative path, e.g. `.` or `./App.app/Contents` */
  path: string;
  /** Base name of the entry (`.` for the root). */
  name: string;
  type: 'file' | 'directory' | 'symlink';
  /** Full st_mode including file-type bits. */
  mode: number;
  uid: number;
  gid: number;
  /** Whole seconds since the epoch. */
  mtime: number;
  /** File size in bytes; symlink target length; directory pseudo-size. */
  size: number;
  nlink: number;
  /** Absolute path on disk (unset for the synthetic root). */
  sourcePath: string;
  /** Symlink target (symlinks only). */
  linkTarget?: string;
  /** Children in on-disk (readdir) order — the order pkgbuild archives them. */
  children?: WalkEntry[];
}

export interface WalkOptions {
  /**
   * Rewrite ownership/permissions of an entry as it is recorded. Returning
   * `undefined` keeps the entry unchanged. The file-type bits of `mode` are
   * preserved automatically; only the permission bits of the returned mode are
   * applied.
   */
  transformEntry?: (entry: {
    path: string;
    type: WalkEntry['type'];
    mode: number;
    uid: number;
    gid: number;
  }) => { mode?: number; uid?: number; gid?: number } | undefined;
  /**
   * How to derive the metadata of the synthetic root (`.`) entry:
   * - 'parent': from the target directory's parent, like `pkgbuild --component`
   *   records for the payload root.
   * - 'self': from the target directory itself, like `pkgbuild --scripts`
   *   records for the scripts archive root.
   */
  rootStat?: 'parent' | 'self';
  /**
   * Ownership to record: 'root' forces uid/gid to 0/0 like pkgbuild records
   * payloads (--ownership recommended); 'preserve' keeps the on-disk uid/gid,
   * which is what pkgbuild does for scripts archives.
   */
  ownership?: 'root' | 'preserve';
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

function mtimeSeconds(stat: fs.Stats): number {
  return Math.max(0, Math.floor(stat.mtimeMs / 1000));
}

/**
 * Walk `targetDir` and build the deterministic entry tree used to generate the
 * payload cpio archive and the Bom. The traversal never follows symlinks.
 */
export async function walkTree(targetDir: string, opts: WalkOptions = {}): Promise<WalkEntry> {
  const { transformEntry, rootStat = 'parent', ownership = 'root' } = opts;

  const applyTransform = (entry: WalkEntry): WalkEntry => {
    if (!transformEntry) return entry;
    const patch = transformEntry({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
    });
    if (!patch) return entry;
    if (patch.mode !== undefined) {
      entry.mode = (entry.mode & S_IFMT) | (patch.mode & 0o7777);
    }
    if (patch.uid !== undefined) entry.uid = patch.uid;
    if (patch.gid !== undefined) entry.gid = patch.gid;
    return entry;
  };

  const walkInto = async (absDir: string, relPath: string, dirEntry: WalkEntry): Promise<void> => {
    // fs.opendir yields entries in raw filesystem order — the order pkgbuild
    // archives them in. (fs.readdir would sort alphabetically.)
    const dirents: fs.Dirent[] = [];
    const dir = await fs.promises.opendir(absDir);
    for await (const dirent of dir) {
      dirents.push(dirent);
    }
    const children: WalkEntry[] = [];
    for (const dirent of dirents) {
      const abs = path.join(absDir, dirent.name);
      const rel = `${relPath}/${dirent.name}`;
      const stat = await fs.promises.lstat(abs);
      if (stat.isDirectory()) {
        const child = applyTransform({
          path: rel,
          name: dirent.name,
          type: 'directory',
          mode: (stat.mode & 0o7777) | S_IFDIR,
          uid: ownership === 'preserve' ? stat.uid : 0,
          gid: ownership === 'preserve' ? stat.gid : 0,
          mtime: mtimeSeconds(stat),
          size: 0,
          nlink: 0,
          sourcePath: abs,
        });
        await walkInto(abs, rel, child);
        children.push(child);
      } else if (stat.isFile()) {
        children.push(
          applyTransform({
            path: rel,
            name: dirent.name,
            type: 'file',
            mode: (stat.mode & 0o7777) | S_IFREG,
            uid: ownership === 'preserve' ? stat.uid : 0,
            gid: ownership === 'preserve' ? stat.gid : 0,
            mtime: mtimeSeconds(stat),
            size: stat.size,
            nlink: 1,
            sourcePath: abs,
          }),
        );
      } else if (stat.isSymbolicLink()) {
        const target = await fs.promises.readlink(abs);
        children.push(
          applyTransform({
            path: rel,
            name: dirent.name,
            type: 'symlink',
            mode: (stat.mode & 0o7777) | S_IFLNK,
            uid: ownership === 'preserve' ? stat.uid : 0,
            gid: ownership === 'preserve' ? stat.gid : 0,
            mtime: mtimeSeconds(stat),
            size: Buffer.byteLength(target),
            nlink: 1,
            sourcePath: abs,
            linkTarget: target,
          }),
        );
      } else {
        throw new Error(
          `Unsupported file type at ${abs}: only regular files, directories and symbolic links can be packaged`,
        );
      }
    }
    dirEntry.children = children;
    // APFS reports st_nlink of a directory as 2 + number of children, and
    // st_size as 32 bytes per link. Computing them keeps output identical
    // across filesystems and platforms.
    dirEntry.nlink = 2 + children.length;
    dirEntry.size = 32 * dirEntry.nlink;
  };

  const targetStat = await fs.promises.lstat(targetDir);
  if (!targetStat.isDirectory()) {
    throw new Error(`Cannot package ${targetDir}: not a directory`);
  }

  let rootMode: number;
  let rootMtime: number;
  let rootNlinkBase: number;
  if (rootStat === 'parent') {
    // pkgbuild stamps the payload root with the stat of the directory that
    // contains the bundle being packaged.
    const parentDir = path.dirname(path.resolve(targetDir));
    const parentStat = await fs.promises.lstat(parentDir);
    rootMode = (parentStat.mode & 0o7777) | S_IFDIR;
    rootMtime = mtimeSeconds(parentStat);
    rootNlinkBase = 2 + (await fs.promises.readdir(parentDir)).length;
  } else {
    rootMode = (targetStat.mode & 0o7777) | S_IFDIR;
    rootMtime = mtimeSeconds(targetStat);
    rootNlinkBase = 0; // computed from children below
  }

  const root = applyTransform({
    path: '.',
    name: '.',
    type: 'directory',
    mode: rootMode,
    uid: ownership === 'preserve' ? targetStat.uid : 0,
    gid: ownership === 'preserve' ? targetStat.gid : 0,
    mtime: rootMtime,
    size: 0,
    nlink: 0,
    sourcePath: rootStat === 'self' ? targetDir : '',
  });

  if (rootStat === 'parent') {
    root.sourcePath = '';
    root.children = [];
    // The payload root contains exactly the bundle. Walk the bundle itself as
    // the single child of the synthetic root.
    const bundleName = path.basename(path.resolve(targetDir));
    const bundle = applyTransform({
      path: `./${bundleName}`,
      name: bundleName,
      type: 'directory',
      mode: (targetStat.mode & 0o7777) | S_IFDIR,
      uid: ownership === 'preserve' ? targetStat.uid : 0,
      gid: ownership === 'preserve' ? targetStat.gid : 0,
      mtime: mtimeSeconds(targetStat),
      size: 0,
      nlink: 0,
      sourcePath: path.resolve(targetDir),
    });
    await walkInto(path.resolve(targetDir), `./${bundleName}`, bundle);
    root.children = [bundle];
    root.nlink = rootNlinkBase;
    root.size = 32 * root.nlink;
  } else {
    await walkInto(path.resolve(targetDir), '.', root);
  }

  return root;
}

/**
 * Yield entries in the order pkgbuild writes them to the cpio payload:
 * depth-first, directories before their contents, children in on-disk
 * (readdir) order.
 */
export function* cpioOrder(root: WalkEntry): Generator<WalkEntry> {
  function* visit(entry: WalkEntry): Generator<WalkEntry> {
    yield entry;
    if (entry.children) {
      for (const child of entry.children) {
        if (child.type === 'directory') {
          yield* visit(child);
        } else {
          yield child;
        }
      }
    }
  }
  yield* visit(root);
}

/**
 * Name comparator used for Bom ordering: byte order of the NFD-normalized
 * name. Apple's mkbom sorts with HFS+-style decomposed names ("é" orders as
 * "e" + combining acute), while storing the raw name.
 */
export function bomNameCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a.normalize('NFD')), Buffer.from(b.normalize('NFD')));
}

/**
 * Yield entries in Bom id order: depth-first with children visited in
 * decomposed-byte-lexicographic name order, matching Apple's mkbom id
 * assignment.
 */
export function* bomOrder(root: WalkEntry): Generator<WalkEntry> {
  function* visit(entry: WalkEntry): Generator<WalkEntry> {
    yield entry;
    if (entry.children) {
      const sorted = [...entry.children].sort((a, b) => bomNameCompare(a.name, b.name));
      for (const child of sorted) {
        yield* visit(child);
      }
    }
  }
  yield* visit(root);
}
