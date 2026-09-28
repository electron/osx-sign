import fs from 'node:fs';
import path from 'node:path';

import plist from 'plist';

import { walkTree, WalkOptions, cpioOrder, WalkEntry } from './walk.js';
import { cpioStream, newCpioWriteResult } from './cpio-writer.js';
import { gzipStream, GzipOptions } from './gzip.js';
import { writeBom } from './bom-writer.js';
import { BundleInfo, renderPackageInfo } from './package-info.js';
import { renderDistribution } from './distribution.js';
import { DEFAULT_HOST_ARCHITECTURES, readHostArchitectures } from './macho.js';
import { readXar, writeXar, XarWriteFile } from './xar.js';
import { findChild, parseXml } from './xml.js';
import { debugLog } from '../util.js';

const MAX_FILE_SIZE = 0xffffffff; // Bom stores 32-bit sizes; Size64 support is not implemented

export interface ComponentPackageOptions {
  /** Path to the bundle (.app) to package. */
  app: string;
  /** Install destination recorded in the package. Defaults to /Applications. */
  installLocation?: string;
  /** Package identifier. Defaults to the bundle's CFBundleIdentifier. */
  identifier?: string;
  /** Package version. Defaults to the bundle's CFBundleShortVersionString. */
  version?: string;
  /** Directory containing preinstall/postinstall scripts (pkgbuild --scripts). */
  scripts?: string;
  /** Compression settings for the payload. */
  compression?: GzipOptions;
  /** Rewrite entry ownership/permissions while packaging. */
  transformEntry?: WalkOptions['transformEntry'];
  /** Set the preserve-xattr PackageInfo attribute (productbuild --component). */
  preserveXattr?: boolean;
}

export interface ComponentPackage {
  identifier: string;
  version: string;
  installLocation: string;
  numberOfFiles: number;
  installKBytes: number;
  hostArchitectures: string;
  title?: string;
  rawShortVersion?: string;
  minimumSystemVersion?: string;
  bundle: BundleInfo;
  packageInfo: Buffer;
  bom: Buffer;
  payload: Buffer[];
  scripts?: Buffer[];
}

interface AppMetadata {
  identifier?: string;
  shortVersionString?: string;
  bundleVersion?: string;
  name?: string;
  displayName?: string;
  executable?: string;
  minimumSystemVersion?: string;
}

async function readAppMetadata(appPath: string): Promise<AppMetadata> {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(plistPath);
  } catch {
    return {};
  }
  if (raw.subarray(0, 6).toString('ascii') === 'bplist') {
    throw new Error(
      `${plistPath} is a binary property list; only XML Info.plist files are supported`,
    );
  }
  const parsed = plist.parse(raw.toString('utf8')) as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof parsed[key] === 'string' ? (parsed[key] as string) : undefined;
  return {
    identifier: str('CFBundleIdentifier'),
    shortVersionString: str('CFBundleShortVersionString'),
    bundleVersion: str('CFBundleVersion'),
    name: str('CFBundleName'),
    displayName: str('CFBundleDisplayName'),
    executable: str('CFBundleExecutable'),
    minimumSystemVersion: str('LSMinimumSystemVersion'),
  };
}

/**
 * pkgbuild normalizes dotted numeric versions to at least three components
 * ("1.0" becomes "1.0.0"); anything else passes through unchanged.
 */
export function normalizePackageVersion(version: string): string {
  if (!/^[0-9]+(\.[0-9]+)*$/.test(version)) return version;
  const parts = version.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

function assertSizes(root: WalkEntry): void {
  for (const entry of cpioOrder(root)) {
    if (entry.type === 'file' && entry.size > MAX_FILE_SIZE) {
      throw new Error(
        `${entry.sourcePath} is larger than 4 GB, which flat packages cannot represent without Size64 support`,
      );
    }
  }
}

/**
 * Build a component package (the moral equivalent of `pkgbuild --component`)
 * entirely in memory: payload cpio+gzip, Bom, and PackageInfo.
 */
export async function buildComponentPackage(
  opts: ComponentPackageOptions,
): Promise<ComponentPackage> {
  const appPath = path.resolve(opts.app);
  const installLocation = opts.installLocation ?? '/Applications';
  const metadata = await readAppMetadata(appPath);

  const identifier = opts.identifier ?? metadata.identifier;
  if (!identifier) {
    throw new Error(
      `Cannot determine a package identifier: ${opts.app} has no CFBundleIdentifier and no identifier override was provided`,
    );
  }
  const version = normalizePackageVersion(opts.version ?? metadata.shortVersionString ?? '0');

  debugLog('pkg-utils: walking bundle...', appPath);
  const root = await walkTree(appPath, {
    transformEntry: opts.transformEntry,
    rootStat: 'parent',
    ownership: 'root',
  });
  assertSizes(root);

  debugLog('pkg-utils: writing payload...');
  const cpioResult = newCpioWriteResult();
  const payload = await gzipStream(cpioStream(root, cpioResult), opts.compression);

  debugLog('pkg-utils: writing Bom...');
  const bom = writeBom(root, cpioResult.checksums, {
    archSizes: cpioResult.archSizes,
    machOFileBytes: cpioResult.machOFileBytes,
  });

  // numberOfFiles counts every node except the synthetic root; installKBytes
  // is the Bom size total (root 0, directories 32 bytes per link) in KB.
  let numberOfFiles = 0;
  let sizeSum = 0;
  for (const entry of cpioOrder(root)) {
    if (entry.path === '.') continue;
    numberOfFiles++;
    sizeSum += entry.size;
  }
  const installKBytes = Math.floor(sizeSum / 1024);

  let scripts: Buffer[] | undefined;
  let scriptNames: { preinstall?: boolean; postinstall?: boolean } | undefined;
  if (opts.scripts) {
    debugLog('pkg-utils: writing scripts archive...', opts.scripts);
    const scriptsRoot = await walkTree(path.resolve(opts.scripts), {
      rootStat: 'self',
      ownership: 'preserve',
    });
    const scriptsResult = newCpioWriteResult();
    scripts = await gzipStream(cpioStream(scriptsRoot, scriptsResult), opts.compression);
    // pkgbuild registers preinstall/postinstall whether they are regular
    // files or symlinks to the real script.
    const isScript = (c: { type: string }) => c.type === 'file' || c.type === 'symlink';
    scriptNames = {
      preinstall: scriptsRoot.children?.some((c) => c.name === 'preinstall' && isScript(c)),
      postinstall: scriptsRoot.children?.some((c) => c.name === 'postinstall' && isScript(c)),
    };
  }

  const bundleName = path.basename(appPath);
  const bundle: BundleInfo = {
    path: bundleName,
    identifier,
    shortVersionString: metadata.shortVersionString,
    bundleVersion: metadata.bundleVersion,
  };

  let hostArchitectures = DEFAULT_HOST_ARCHITECTURES;
  if (metadata.executable) {
    hostArchitectures = await readHostArchitectures(
      path.join(appPath, 'Contents', 'MacOS', metadata.executable),
    );
  }

  const packageInfo = Buffer.from(
    renderPackageInfo({
      identifier,
      version,
      installLocation,
      numberOfFiles,
      installKBytes,
      bundle,
      scripts: scriptNames,
      preserveXattr: opts.preserveXattr,
    }),
    'utf8',
  );

  return {
    identifier,
    version,
    installLocation,
    numberOfFiles,
    installKBytes,
    hostArchitectures,
    title: metadata.displayName ?? metadata.name,
    rawShortVersion: metadata.shortVersionString,
    minimumSystemVersion: metadata.minimumSystemVersion,
    bundle,
    packageInfo,
    bom,
    payload,
    scripts,
  };
}

function componentXarFiles(component: ComponentPackage): XarWriteFile[] {
  const files: XarWriteFile[] = [
    { name: 'Bom', parts: [component.bom], compress: true },
    { name: 'Payload', parts: component.payload },
  ];
  if (component.scripts) {
    files.push({ name: 'Scripts', parts: component.scripts });
  }
  files.push({ name: 'PackageInfo', parts: [component.packageInfo], compress: true });
  return files;
}

/**
 * Write a standalone component package (.pkg), like `pkgbuild` does.
 */
export async function writeComponentPackage(
  outputPath: string,
  component: ComponentPackage,
  opts: { creationTime?: Date } = {},
): Promise<void> {
  await writeXar(outputPath, componentXarFiles(component), opts);
}

export interface ProductArchiveOptions {
  /** Output path for the product archive (.pkg). */
  output: string;
  /**
   * Build the product from a bundle (`productbuild --component` semantics).
   * Mutually exclusive with `package`.
   */
  app?: string;
  /**
   * Wrap an existing component package (`productbuild --package` semantics).
   * Mutually exclusive with `app`.
   */
  package?: string;
  installLocation?: string;
  identifier?: string;
  version?: string;
  scripts?: string;
  compression?: GzipOptions;
  transformEntry?: WalkOptions['transformEntry'];
  creationTime?: Date;
  /**
   * Only meaningful with `app`. When true (default) the archive matches
   * `productbuild --component <app>`: preserve-xattr PackageInfo attribute,
   * `<identifier>.pkg` embedded package name and a product-style Distribution
   * with title/product elements. When false it matches the two-step
   * `pkgbuild --component` + `productbuild --package` pipeline instead:
   * plain PackageInfo, `<AppName>-component.pkg` embedded name and a
   * package-style Distribution.
   */
  componentStyle?: boolean;
}

interface EmbeddedComponent {
  /** Directory name of the embedded package inside the archive. */
  name: string;
  files: XarWriteFile[];
  identifier: string;
  version: string;
  installLocation?: string;
  installKBytes: number;
  hostArchitectures: string;
  bundle: BundleInfo;
  productStyle: boolean;
  title?: string;
  rawShortVersion?: string;
  minimumSystemVersion?: string;
}

async function embeddedFromPackageFile(packagePath: string): Promise<EmbeddedComponent> {
  const members = await readXar(packagePath);
  const packageInfoMember = members.find((m) => m.path === 'PackageInfo');
  if (!packageInfoMember?.data) {
    throw new Error(`${packagePath} is not a component package: missing PackageInfo`);
  }
  const info = parseXml(packageInfoMember.data.toString('utf8'));
  if (info.name !== 'pkg-info') {
    throw new Error(`${packagePath} has an invalid PackageInfo`);
  }
  const identifier = info.attributes.identifier;
  const version = info.attributes.version ?? '0';
  if (!identifier) {
    throw new Error(`${packagePath}: PackageInfo has no identifier`);
  }
  const payloadElement = findChild(info, 'payload');
  const installKBytes = Number(payloadElement?.attributes.installKBytes ?? '0');
  const bundleElement = findChild(info, 'bundle');
  const bundle: BundleInfo = bundleElement
    ? {
        path: (bundleElement.attributes.path ?? '').replace(/^\.\//, ''),
        identifier: bundleElement.attributes.id ?? identifier,
        shortVersionString: bundleElement.attributes.CFBundleShortVersionString,
        bundleVersion: bundleElement.attributes.CFBundleVersion,
      }
    : { path: '', identifier };

  const files: XarWriteFile[] = [];
  for (const member of members) {
    if (member.type !== 'file' || !member.data) continue;
    // Re-encode the way the native tools store each member: Payload/Scripts
    // are already gzip streams and stay raw, the rest are zlib-compressed.
    const compress = member.path !== 'Payload' && member.path !== 'Scripts';
    files.push({ name: member.path, parts: [member.data], compress });
  }

  return {
    name: path.basename(packagePath),
    files,
    identifier,
    version,
    installKBytes,
    // productbuild --package does not inspect the payload; it always
    // advertises the default architecture list.
    hostArchitectures: DEFAULT_HOST_ARCHITECTURES,
    bundle,
    productStyle: false,
  };
}

/**
 * Build a product archive — the JS equivalent of `productbuild --component`
 * (pass `app`) or `productbuild --package` (pass `package`). The archive is
 * unsigned; sign it afterwards with `productsign` if needed.
 */
export async function buildProductArchive(opts: ProductArchiveOptions): Promise<void> {
  if ((opts.app ? 1 : 0) + (opts.package ? 1 : 0) !== 1) {
    throw new Error('Specify exactly one of `app` or `package`');
  }

  let embedded: EmbeddedComponent;
  if (opts.app) {
    const componentStyle = opts.componentStyle ?? true;
    const component = await buildComponentPackage({
      app: opts.app,
      installLocation: opts.installLocation,
      identifier: opts.identifier,
      version: opts.version,
      scripts: opts.scripts,
      compression: opts.compression,
      transformEntry: opts.transformEntry,
      preserveXattr: componentStyle,
    });
    embedded = {
      name: componentStyle
        ? `${component.identifier}.pkg`
        : `${path.basename(path.resolve(opts.app), '.app')}-component.pkg`,
      files: componentXarFiles(component),
      identifier: component.identifier,
      version: component.version,
      installLocation: component.installLocation,
      installKBytes: component.installKBytes,
      // The two-step pipeline's productbuild step never sees the app, so it
      // advertises the default architectures.
      hostArchitectures: componentStyle ? component.hostArchitectures : DEFAULT_HOST_ARCHITECTURES,
      bundle: component.bundle,
      productStyle: componentStyle,
      title: componentStyle ? component.title : undefined,
      rawShortVersion: componentStyle ? component.rawShortVersion : undefined,
      minimumSystemVersion: componentStyle ? component.minimumSystemVersion : undefined,
    };
  } else {
    embedded = await embeddedFromPackageFile(opts.package!);
    // In --package mode productbuild only records a customLocation when an
    // install path is passed on the command line; the component's own
    // install-location is not consulted.
    embedded.installLocation = opts.installLocation;
  }

  const distribution = renderDistribution({
    identifier: embedded.identifier,
    version: embedded.version,
    installLocation: embedded.installLocation,
    installKBytes: embedded.installKBytes,
    packageRef: embedded.name,
    hostArchitectures: embedded.hostArchitectures,
    bundle: embedded.bundle,
    productStyle: embedded.productStyle,
    title: embedded.title,
    rawShortVersion: embedded.rawShortVersion,
    minimumSystemVersion: embedded.minimumSystemVersion,
  });

  await writeXar(
    opts.output,
    [
      { name: embedded.name, children: embedded.files },
      { name: 'Distribution', parts: [Buffer.from(distribution, 'utf8')], compress: true },
    ],
    { creationTime: opts.creationTime },
  );
}

/**
 * Build a standalone component package on disk — the JS equivalent of
 * `pkgbuild --component <app> [--scripts dir] [--install-location loc] out.pkg`.
 */
export async function buildComponentPackageFile(
  outputPath: string,
  opts: ComponentPackageOptions & { creationTime?: Date },
): Promise<ComponentPackage> {
  const component = await buildComponentPackage(opts);
  await writeComponentPackage(outputPath, component, { creationTime: opts.creationTime });
  return component;
}
