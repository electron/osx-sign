import { escapeXml } from './xml.js';

export interface BundleInfo {
  /** Bundle directory name, e.g. `App.app`. */
  path: string;
  identifier: string;
  shortVersionString?: string;
  bundleVersion?: string;
}

export interface PackageInfoOptions {
  identifier: string;
  version: string;
  installLocation: string;
  numberOfFiles: number;
  installKBytes: number;
  bundle: BundleInfo;
  /** Names of scripts present in the Scripts archive. */
  scripts?: { preinstall?: boolean; postinstall?: boolean };
  /** Emitted by `productbuild --component`, absent from `pkgbuild` output. */
  preserveXattr?: boolean;
  /** Reported tool version, mirrors pkgbuild's generator-version attribute. */
  generatorVersion?: string;
}

export const GENERATOR_VERSION = '@electron/osx-sign pkg-utils';

/**
 * Render a PackageInfo document identical in shape to the one pkgbuild
 * emits (element order, attribute order, 4-space indent, no trailing
 * newline).
 */
export function renderPackageInfo(opts: PackageInfoOptions): string {
  const id = escapeXml(opts.identifier);
  // Attribute-order quirk of pkgbuild: with a CFBundleVersion the path leads,
  // without one it trails.
  const bundleAttrs: string[] = [];
  if (opts.bundle.bundleVersion !== undefined) {
    bundleAttrs.push(`path="./${escapeXml(opts.bundle.path)}"`);
    bundleAttrs.push(`id="${escapeXml(opts.bundle.identifier)}"`);
    if (opts.bundle.shortVersionString !== undefined) {
      bundleAttrs.push(`CFBundleShortVersionString="${escapeXml(opts.bundle.shortVersionString)}"`);
    }
    bundleAttrs.push(`CFBundleVersion="${escapeXml(opts.bundle.bundleVersion)}"`);
  } else {
    bundleAttrs.push(`id="${escapeXml(opts.bundle.identifier)}"`);
    if (opts.bundle.shortVersionString !== undefined) {
      bundleAttrs.push(`CFBundleShortVersionString="${escapeXml(opts.bundle.shortVersionString)}"`);
    }
    bundleAttrs.push(`path="./${escapeXml(opts.bundle.path)}"`);
  }

  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml +=
    `<pkg-info overwrite-permissions="true" relocatable="false" identifier="${id}" ` +
    `postinstall-action="none" version="${escapeXml(opts.version)}" format-version="2" ` +
    `generator-version="${escapeXml(opts.generatorVersion ?? GENERATOR_VERSION)}" ` +
    `install-location="${escapeXml(opts.installLocation)}" auth="root"` +
    (opts.preserveXattr ? ' preserve-xattr="true"' : '') +
    '>\n';
  xml += `    <payload numberOfFiles="${opts.numberOfFiles}" installKBytes="${opts.installKBytes}"/>\n`;
  xml += `    <bundle ${bundleAttrs.join(' ')}/>\n`;
  xml += '    <bundle-version>\n';
  xml += `        <bundle id="${id}"/>\n`;
  xml += '    </bundle-version>\n';
  xml += '    <upgrade-bundle>\n';
  xml += `        <bundle id="${id}"/>\n`;
  xml += '    </upgrade-bundle>\n';
  xml += '    <update-bundle/>\n';
  xml += '    <atomic-update-bundle/>\n';
  xml += '    <strict-identifier>\n';
  xml += `        <bundle id="${id}"/>\n`;
  xml += '    </strict-identifier>\n';
  xml += '    <relocate>\n';
  xml += `        <bundle id="${id}"/>\n`;
  xml += '    </relocate>\n';
  if (opts.scripts && (opts.scripts.preinstall || opts.scripts.postinstall)) {
    xml += '    <scripts>\n';
    if (opts.scripts.preinstall) {
      xml += '        <preinstall file="./preinstall" timeout="600"/>\n';
    }
    if (opts.scripts.postinstall) {
      xml += '        <postinstall file="./postinstall" timeout="600"/>\n';
    }
    xml += '    </scripts>\n';
  }
  xml += '</pkg-info>';
  return xml;
}
