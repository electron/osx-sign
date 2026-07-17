import { BundleInfo } from './package-info.js';
import { escapeXml } from './xml.js';

// RFC 3986 fragment characters productbuild leaves unencoded in the
// trailing pkg-ref (#<name>): unreserved / sub-delims / ":" / "@" / "/" / "?".
const FRAGMENT_ALLOWED = new Set(
  Buffer.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?",
    'ascii',
  ),
);

/**
 * Percent-encode an embedded package name the way productbuild does:
 * Installer resolves the `#name.pkg` reference as a URL fragment.
 */
export function percentEncodeFragment(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  let out = '';
  for (const byte of bytes) {
    out += FRAGMENT_ALLOWED.has(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export interface DistributionOptions {
  identifier: string;
  /** Normalized package version, used in the trailing pkg-ref. */
  version: string;
  /** Emitted as the choice's customLocation; omitted when undefined. */
  installLocation?: string;
  installKBytes: number;
  /** Name of the embedded component package, e.g. `com.example.app.pkg`. */
  packageRef: string;
  hostArchitectures: string;
  bundle: BundleInfo;
  /**
   * Product style: `productbuild --component` emits `<product>`, `<title>`
   * and titled choices; `productbuild --package` does not.
   */
  productStyle: boolean;
  /** Title from CFBundleDisplayName/CFBundleName; omitted when the bundle has neither. */
  title?: string;
  /** Raw (unnormalized) CFBundleShortVersionString, used for product/versStr. */
  rawShortVersion?: string;
  /**
   * The bundle's LSMinimumSystemVersion. When present productbuild emits a
   * volume-check and bumps minSpecVersion to 2.
   */
  minimumSystemVersion?: string;
}

/**
 * Render a Distribution document identical in shape to productbuild's
 * output for the `--component` (productStyle) and `--package` invocations.
 */
export function renderDistribution(opts: DistributionOptions): string {
  const id = escapeXml(opts.identifier);
  const version = escapeXml(opts.version);
  const bundleAttrs = [];
  if (opts.bundle.shortVersionString !== undefined) {
    bundleAttrs.push(`CFBundleShortVersionString="${escapeXml(opts.bundle.shortVersionString)}"`);
  }
  if (opts.bundle.bundleVersion !== undefined) {
    bundleAttrs.push(`CFBundleVersion="${escapeXml(opts.bundle.bundleVersion)}"`);
  }
  bundleAttrs.push(`id="${escapeXml(opts.bundle.identifier)}"`);
  bundleAttrs.push(`path="${escapeXml(opts.bundle.path)}"`);

  const title = opts.title !== undefined ? escapeXml(opts.title) : undefined;
  const titleAttr = title !== undefined ? ` title="${title}"` : '';
  const versStrAttr =
    opts.productStyle && opts.rawShortVersion !== undefined
      ? ` versStr="${escapeXml(opts.rawShortVersion)}"`
      : '';

  const minimumSystemVersion = opts.productStyle ? opts.minimumSystemVersion : undefined;

  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml += `<installer-gui-script minSpecVersion="${minimumSystemVersion !== undefined ? 2 : 1}">\n`;
  xml += `    <pkg-ref id="${id}">\n`;
  xml += '        <bundle-version>\n';
  xml += `            <bundle ${bundleAttrs.join(' ')}/>\n`;
  xml += '        </bundle-version>\n';
  xml += '    </pkg-ref>\n';
  if (opts.productStyle) {
    xml +=
      opts.rawShortVersion !== undefined
        ? `    <product id="${id}" version="${escapeXml(opts.rawShortVersion)}"/>\n`
        : `    <product id="${id}"/>\n`;
    if (title !== undefined) {
      xml += `    <title>${title}</title>\n`;
    }
  }
  xml += `    <options customize="never" require-scripts="false" hostArchitectures="${escapeXml(opts.hostArchitectures)}"/>\n`;
  if (minimumSystemVersion !== undefined) {
    xml += '    <volume-check>\n';
    xml += '        <allowed-os-versions>\n';
    xml += `            <os-version min="${escapeXml(minimumSystemVersion)}"/>\n`;
    xml += '        </allowed-os-versions>\n';
    xml += '    </volume-check>\n';
  }
  xml += '    <choices-outline>\n';
  xml += '        <line choice="default">\n';
  xml += `            <line choice="${id}"/>\n`;
  xml += '        </line>\n';
  xml += '    </choices-outline>\n';
  xml += `    <choice id="default"${titleAttr}${versStrAttr}/>\n`;
  xml +=
    `    <choice id="${id}"${titleAttr}` +
    ' visible="false"' +
    (opts.installLocation !== undefined
      ? ` customLocation="${escapeXml(opts.installLocation)}"`
      : '') +
    '>\n';
  xml += `        <pkg-ref id="${id}"/>\n`;
  xml += '    </choice>\n';
  xml +=
    `    <pkg-ref id="${id}" version="${version}" onConclusion="none" ` +
    `installKBytes="${opts.installKBytes}" updateKBytes="0">#${escapeXml(percentEncodeFragment(opts.packageRef))}</pkg-ref>\n`;
  xml += '</installer-gui-script>';
  return xml;
}
