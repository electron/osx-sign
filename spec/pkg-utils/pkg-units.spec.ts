import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { cksum } from '../../src/pkg-utils/cksum.js';
import { walkTree, cpioOrder, bomOrder } from '../../src/pkg-utils/walk.js';
import { cpioStream, newCpioWriteResult } from '../../src/pkg-utils/cpio-writer.js';
import { writeBom } from '../../src/pkg-utils/bom-writer.js';
import { readBom } from '../../src/pkg-utils/bom-reader.js';
import { gzipStream } from '../../src/pkg-utils/gzip.js';
import { writeXar, readXar } from '../../src/pkg-utils/xar.js';
import { parseXml, escapeXml } from '../../src/pkg-utils/xml.js';
import {
  machOSliceSizes,
  readHostArchitectures,
  DEFAULT_HOST_ARCHITECTURES,
} from '../../src/pkg-utils/macho.js';
import { renderPackageInfo } from '../../src/pkg-utils/package-info.js';
import { percentEncodeFragment, renderDistribution } from '../../src/pkg-utils/distribution.js';
import { buildComponentPackage, normalizePackageVersion } from '../../src/pkg-utils/pkg.js';
import { parseCpio, writeFixtureTree, infoPlist, FIXTURE_EPOCH } from './helpers.js';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

describe('cksum', () => {
  it('matches macOS cksum(1) reference values', () => {
    // Reference values produced by /usr/bin/cksum on macOS.
    expect(cksum(Buffer.from('hello'))).toBe(3287646509);
    expect(cksum(Buffer.from('#!/bin/sh\necho hi\n'))).toBe(3783648674);
    expect(cksum(Buffer.from('data.txt'))).toBe(4247533825);
    expect(cksum(Buffer.alloc(0))).toBe(4294967295);
  });
});

describe('version normalization', () => {
  it('pads dotted numeric versions to three components like pkgbuild', () => {
    expect(normalizePackageVersion('1.0')).toBe('1.0.0');
    expect(normalizePackageVersion('2')).toBe('2.0.0');
    expect(normalizePackageVersion('1.2.3')).toBe('1.2.3');
    expect(normalizePackageVersion('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizePackageVersion('1.0-beta')).toBe('1.0-beta');
  });
});

describe('xml', () => {
  it('escapes attribute characters', () => {
    expect(escapeXml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
  });

  it('parses and unescapes documents', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><root a="1 &amp; 2"><child>x &lt; y</child><empty/></root>',
    );
    expect(doc.name).toBe('root');
    expect(doc.attributes.a).toBe('1 & 2');
    expect(doc.children[0].text).toBe('x < y');
    expect(doc.children[1].name).toBe('empty');
  });
});

describe('macho', () => {
  function thinMachO(cpuType: number): Buffer {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(cpuType, 4);
    return buf;
  }

  it('reads thin binaries', () => {
    const sizes = machOSliceSizes(
      Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), thinMachO(0x0100000c).subarray(4)]),
      1000,
    );
    expect(sizes).toEqual(new Map([[0x0100000c, 1000]]));
  });

  it('reads fat binaries per-slice', () => {
    const fat = Buffer.alloc(8 + 2 * 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8); // x86_64
    fat.writeUInt32BE(4096, 8 + 8); // offset
    fat.writeUInt32BE(300, 8 + 12); // size
    fat.writeUInt32BE(0x0100000c, 28); // arm64
    fat.writeUInt32BE(8192, 28 + 8);
    fat.writeUInt32BE(500, 28 + 12);
    const sizes = machOSliceSizes(fat, 9000);
    expect(sizes).toEqual(
      new Map([
        [0x01000007, 300],
        [0x0100000c, 500],
      ]),
    );
  });

  it('rejects non-Mach-O data', () => {
    expect(machOSliceSizes(Buffer.from('#!/bin/sh\n'), 10)).toBeNull();
  });

  it('rejects Java .class files that share the fat magic', () => {
    // Regression: 0xCAFEBABE + minor/major version (e.g. 52) parses as a
    // plausible fat arch count; the slice bounds check must reject it.
    const javaClass = Buffer.alloc(64);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt16BE(0, 4); // minor_version
    javaClass.writeUInt16BE(52, 6); // major_version (Java 8)
    javaClass.fill(0x2a, 8); // constant pool garbage
    expect(machOSliceSizes(javaClass, 5000)).toBeNull();
  });

  it('rejects fat headers whose slices fall outside the file', () => {
    const fat = Buffer.alloc(8 + 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(1, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(4096, 16); // offset
    fat.writeUInt32BE(10_000, 20); // size beyond the file
    expect(machOSliceSizes(fat, 5000)).toBeNull();
  });

  it('falls back to the default architecture list', async () => {
    expect(await readHostArchitectures('/nonexistent/binary')).toBe(DEFAULT_HOST_ARCHITECTURES);
  });
});

describe('gzip', () => {
  it('parallel output is a single-member gzip stream that decompresses to the input', async () => {
    const input = Buffer.concat([
      Buffer.from('a'.repeat(3 * 1024 * 1024)),
      Buffer.from('b'.repeat(2 * 1024 * 1024)),
    ]);
    async function* source() {
      for (let i = 0; i < input.length; i += 700_000) {
        yield input.subarray(i, i + 700_000);
      }
    }
    const parts = await gzipStream(source(), { chunkSize: 1024 * 1024 });
    expect(parts.length).toBeGreaterThan(2); // header + >1 compressed chunk + trailer
    const stream = Buffer.concat(parts);
    // Standard single-member gzip: fixed header, exactly one member. macOS
    // Installer's payload extractor rejects multi-member streams, so this is
    // a hard requirement, not a style choice.
    expect([...stream.subarray(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00]);
    expect(Buffer.compare(zlib.gunzipSync(stream), input)).toBe(0);
    // The ISIZE trailer must reflect the full stream (it would only cover the
    // last member if this were multi-member).
    expect(stream.readUInt32LE(stream.length - 4)).toBe(input.length);
    expect(stream.readUInt32LE(stream.length - 8)).toBe(zlib.crc32(input) >>> 0);
  });

  it('rejects with the source error and leaves no unhandled rejections', async () => {
    // Regression: compression jobs queued before a source failure must not
    // fire Node's unhandled-rejection handler while the stream unwinds.
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      async function* failingSource() {
        yield Buffer.alloc(3 * 1024 * 1024, 1);
        yield Buffer.alloc(3 * 1024 * 1024, 2);
        throw new Error('source blew up');
      }
      await expect(gzipStream(failingSource(), { chunkSize: 1024 * 1024 })).rejects.toThrow(
        'source blew up',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('handles inputs smaller than one chunk', async () => {
    async function* source() {
      yield Buffer.from('hello world');
    }
    const parts = await gzipStream(source());
    const out = Buffer.concat(parts);
    expect(zlib.gunzipSync(out).toString()).toBe('hello world');
  });
});

describe('walk + cpio + bom', () => {
  let tmp: string;
  let app: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-'));
    app = path.join(tmp, 'parent', 'Unit.app');
    writeFixtureTree(path.join(tmp, 'parent'), [
      { path: 'Unit.app/Contents/Info.plist', content: infoPlist('com.example.unit') },
      { path: 'Unit.app/Contents/MacOS/Fixture', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      { path: 'Unit.app/Contents/Resources/data.txt', content: 'hello' },
      { path: 'Unit.app/Contents/Resources/link', symlink: 'data.txt' },
      { path: 'Unit.app/Contents/Resources/empty', directory: true },
    ]);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('walks with pkgbuild metadata semantics', async () => {
    const root = await walkTree(app);
    expect(root.path).toBe('.');
    expect(root.nlink).toBe(3); // parent dir contains only Unit.app
    const entries = [...cpioOrder(root)];
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('./Unit.app/Contents')!.nlink).toBe(5); // 3 children + 2
    expect(byPath.get('./Unit.app/Contents')!.size).toBe(160);
    expect(byPath.get('./Unit.app/Contents/Resources/link')!.linkTarget).toBe('data.txt');
    expect(byPath.get('./Unit.app/Contents/Resources/link')!.size).toBe(8);
    for (const entry of entries) {
      expect(entry.uid).toBe(0);
      expect(entry.gid).toBe(0);
    }
  });

  it('bom order sorts children byte-lexicographically', async () => {
    const root = await walkTree(app);
    const contents = [...bomOrder(root)]
      .filter((e) => e.path.startsWith('./Unit.app/Contents/') && e.path.split('/').length === 4)
      .map((e) => e.name);
    expect(contents).toEqual(['Info.plist', 'MacOS', 'Resources']);
  });

  it('writes a parseable cpio stream padded to 512 bytes', async () => {
    const root = await walkTree(app);
    const result = newCpioWriteResult();
    const raw = await collect(cpioStream(root, result));
    expect(raw.length % 512).toBe(0);
    const entries = parseCpio(raw);
    expect(entries[0].name).toBe('.');
    expect(entries.at(-1)!.name).toBe('TRAILER!!!');
    // inodes are sequential including the trailer
    entries.forEach((entry, i) => expect(entry.ino).toBe(i));
    const file = entries.find((e) => e.name === './Unit.app/Contents/Resources/data.txt')!;
    expect(file.data.toString()).toBe('hello');
    expect(file.mtime).toBe(FIXTURE_EPOCH);
    expect(result.checksums.get('./Unit.app/Contents/Resources/data.txt')).toBe(3287646509);
    expect(result.checksums.get('./Unit.app/Contents/Resources/link')).toBe(4247533825);
  });

  it('bom writer output round-trips through the reader', async () => {
    const root = await walkTree(app);
    const result = newCpioWriteResult();
    await collect(cpioStream(root, result));
    const bom = readBom(writeBom(root, result.checksums));
    expect(bom.numberOfPaths).toBe(11); // 10 entries + trailer
    const byPath = new Map(bom.paths.map((p) => [p.path, p]));
    expect(byPath.get('.')!.mode).toBe(0); // Apple stores 0 for the root
    expect(byPath.get('./Unit.app/Contents/Resources/data.txt')!.checksum).toBe(3287646509);
    expect(byPath.get('./Unit.app/Contents/Resources/link')!.linkTarget).toBe('data.txt');
    expect(byPath.get('./Unit.app/Contents/Resources/link')!.mode & 0o170000).toBe(0o120000);
    expect(bom.sizeSum).toBe(
      [...cpioOrder(root)].filter((e) => e.path !== '.').reduce((sum, e) => sum + e.size, 0),
    );
    // Tree entries are sorted by (parent id, byte-lexicographic name)
    for (let i = 1; i < bom.paths.length; i++) {
      const prev = bom.paths[i - 1];
      const curr = bom.paths[i];
      expect(
        prev.parentId < curr.parentId ||
          (prev.parentId === curr.parentId &&
            Buffer.compare(Buffer.from(prev.name), Buffer.from(curr.name)) < 0),
      ).toBe(true);
    }
  });

  it('splits large path sets across multiple bom tree leaves', async () => {
    const bigTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-big-'));
    const bigApp = path.join(bigTmp, 'parent', 'Big.app');
    const files = [{ path: 'Big.app/Contents/Info.plist', content: infoPlist('com.example.big') }];
    for (let i = 0; i < 600; i++) {
      files.push({
        path: `Big.app/Contents/Resources/f${String(i).padStart(4, '0')}.txt`,
        content: `content ${i}`,
      });
    }
    writeFixtureTree(path.join(bigTmp, 'parent'), files);
    const root = await walkTree(bigApp);
    const result = newCpioWriteResult();
    await collect(cpioStream(root, result));
    const bom = readBom(writeBom(root, result.checksums));
    expect(bom.paths.length).toBe(605);
    expect(new Set(bom.paths.map((p) => p.id)).size).toBe(605);
    fs.rmSync(bigTmp, { recursive: true, force: true });
  });

  it('packages NFC-named files that native pkgbuild silently drops', async () => {
    // Regression guard for a deliberate behavioral improvement: Apple's
    // pkgbuild omits files whose names are NFC-normalized (e.g. "é" as a
    // single code point) from the payload while still listing them in the
    // Bom. We package them.
    const nfcTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-nfc-'));
    const nfcApp = path.join(nfcTmp, 'parent', 'NFC.app');
    writeFixtureTree(path.join(nfcTmp, 'parent'), [
      { path: 'NFC.app/Contents/Info.plist', content: infoPlist('com.example.nfc') },
      { path: 'NFC.app/Contents/Resources/émoji.txt', content: 'included' },
    ]);
    const root = await walkTree(nfcApp);
    const result = newCpioWriteResult();
    const raw = await collect(cpioStream(root, result));
    const names = parseCpio(raw).map((e) => e.name);
    expect(names).toContain('./NFC.app/Contents/Resources/émoji.txt');
    const bom = readBom(writeBom(root, result.checksums));
    expect(bom.paths.map((p) => p.name)).toContain('émoji.txt');
    fs.rmSync(nfcTmp, { recursive: true, force: true });
  });

  it('rejects unsupported file types', async () => {
    if (process.platform === 'win32') return;
    const fifoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-fifo-'));
    const fifoApp = path.join(fifoTmp, 'parent', 'F.app');
    writeFixtureTree(path.join(fifoTmp, 'parent'), [
      { path: 'F.app/Contents/Info.plist', content: infoPlist('com.example.f') },
    ]);
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [path.join(fifoApp, 'Contents', 'pipe')]);
    await expect(walkTree(fifoApp)).rejects.toThrow(/Unsupported file type/);
    fs.rmSync(fifoTmp, { recursive: true, force: true });
  });
});

describe('cpio field limits', () => {
  function syntheticTree(childCount: number, uid = 0): Parameters<typeof cpioStream>[0] {
    const children = Array.from({ length: childCount }, (_, i) => ({
      path: `./d${i}`,
      name: `d${i}`,
      type: 'directory' as const,
      mode: 0o040755,
      uid,
      gid: 0,
      mtime: FIXTURE_EPOCH,
      size: 64,
      nlink: 2,
      sourcePath: '',
      children: [],
    }));
    return {
      path: '.',
      name: '.',
      type: 'directory',
      mode: 0o040755,
      uid,
      gid: 0,
      mtime: FIXTURE_EPOCH,
      size: 32 * (childCount + 2),
      nlink: childCount + 2,
      sourcePath: '',
      children,
    };
  }

  it('wraps the synthetic inode counter past 262,143 instead of failing', async () => {
    // Regression: the 6-digit octal ino field overflows at 0o1000000 entries;
    // packaging must keep going (the inode is meaningless to Installer).
    const root = syntheticTree(0o1000000 + 5);
    const result = newCpioWriteResult();
    let count = 0;
    let sawWrapped = false;
    for await (const buf of cpioStream(root, result)) {
      if (count === 0) {
        // First buffer is the root header.
        expect(buf.subarray(12, 18).toString()).toBe('000000');
      }
      if (buf.length === 76 && buf.subarray(0, 6).toString() === '070707') {
        const ino = parseInt(buf.subarray(12, 18).toString(), 8);
        expect(ino).toBeLessThanOrEqual(0o777777);
        if (count > 0o777777) sawWrapped = true;
      }
      count++;
    }
    expect(sawWrapped).toBe(true);
  }, 60_000);

  it('clamps uids that do not fit the 6-digit octal field to root', async () => {
    // Regression: LDAP/AD accounts commonly have uids > 262,143; a scripts
    // directory owned by one must not abort packaging.
    const root = syntheticTree(1, 1128796696);
    const result = newCpioWriteResult();
    const parts: Buffer[] = [];
    for await (const buf of cpioStream(root, result)) parts.push(buf);
    const entries = parseCpio(Buffer.concat(parts));
    expect(entries[0].uid).toBe(0);
    expect(entries[1].uid).toBe(0);
  });
});

describe('xar', () => {
  it('rejects cleanly when the output path cannot be written', async () => {
    // Regression: stream 'error' events must reject writeXar, not crash the
    // process with an uncaught exception.
    await expect(
      writeXar('/nonexistent-dir-for-sure/out.xar', [{ name: 'f', parts: [Buffer.from('x')] }]),
    ).rejects.toThrow();
  });

  it('round-trips files and directories', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-xar-'));
    const out = path.join(tmp, 'test.xar');
    const payload = Buffer.from('payload data'.repeat(100));
    await writeXar(out, [
      {
        name: 'com.example & test.pkg',
        children: [
          { name: 'Bom', parts: [Buffer.from('bom-bytes')], compress: true },
          { name: 'Payload', parts: [payload.subarray(0, 500), payload.subarray(500)] },
        ],
      },
      { name: 'Distribution', parts: [Buffer.from('<installer-gui-script/>')], compress: true },
    ]);
    const members = await readXar(out);
    const paths = members.map((m) => m.path);
    expect(paths).toEqual([
      'com.example & test.pkg',
      'com.example & test.pkg/Bom',
      'com.example & test.pkg/Payload',
      'Distribution',
    ]);
    expect(members[1].data!.toString()).toBe('bom-bytes');
    expect(Buffer.compare(members[2].data!, payload)).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('percentEncodeFragment', () => {
  it('matches productbuild fragment encoding (verified against native output)', () => {
    // Every expected value below was produced by the real productbuild.
    expect(percentEncodeFragment('My App-component.pkg')).toBe('My%20App-component.pkg');
    expect(percentEncodeFragment("Wéird & 'q' +p.pkg")).toBe("We%CC%81ird%20&%20'q'%20+p.pkg");
    expect(percentEncodeFragment('pct%25.pkg')).toBe('pct%2525.pkg');
    expect(percentEncodeFragment('hash#f.pkg')).toBe('hash%23f.pkg');
    expect(percentEncodeFragment('q?ue.pkg')).toBe('q?ue.pkg');
    expect(percentEncodeFragment('com.example.app.pkg')).toBe('com.example.app.pkg');
  });

  it('is applied to the trailing pkg-ref', () => {
    const xml = renderDistribution({
      identifier: 'com.example.app',
      version: '1.0.0',
      installLocation: '/Applications',
      installKBytes: 1,
      packageRef: 'My App-component.pkg',
      hostArchitectures: 'arm64',
      bundle: { path: 'My App.app', identifier: 'com.example.app' },
      productStyle: false,
    });
    expect(xml).toContain('>#My%20App-component.pkg</pkg-ref>');
  });
});

describe('scripts registration', () => {
  it('registers symlinked preinstall/postinstall scripts like pkgbuild does', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-symscripts-'));
    const app = path.join(tmp, 'parent', 'Sym.app');
    writeFixtureTree(path.join(tmp, 'parent'), [
      { path: 'Sym.app/Contents/Info.plist', content: infoPlist('com.example.sym') },
    ]);
    const scripts = path.join(tmp, 'scripts');
    writeFixtureTree(scripts, [
      { path: 'real/actual.sh', content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
      { path: 'preinstall', content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
      { path: 'postinstall', symlink: 'real/actual.sh' },
    ]);
    const component = await buildComponentPackage({ app, scripts });
    const packageInfo = component.packageInfo.toString('utf8');
    expect(packageInfo).toContain('<preinstall file="./preinstall" timeout="600"/>');
    expect(packageInfo).toContain('<postinstall file="./postinstall" timeout="600"/>');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('document rendering', () => {
  it('renders PackageInfo in pkgbuild shape', () => {
    const xml = renderPackageInfo({
      identifier: 'com.example.app',
      version: '1.2.3',
      installLocation: '/Applications',
      numberOfFiles: 8,
      installKBytes: 42,
      bundle: {
        path: 'App.app',
        identifier: 'com.example.app',
        shortVersionString: '1.2.3',
        bundleVersion: '123',
      },
    });
    expect(xml).toContain('<payload numberOfFiles="8" installKBytes="42"/>');
    expect(xml).toContain(
      '<bundle path="./App.app" id="com.example.app" CFBundleShortVersionString="1.2.3" CFBundleVersion="123"/>',
    );
    expect(xml.endsWith('</pkg-info>')).toBe(true);
    expect(parseXml(xml).name).toBe('pkg-info');
  });

  it('escapes XML-significant characters from bundle metadata', () => {
    const xml = renderDistribution({
      identifier: 'com.example."quoted"&<app>',
      version: '1.0.0',
      installLocation: '/Applications',
      installKBytes: 1,
      packageRef: 'x.pkg',
      hostArchitectures: 'arm64',
      bundle: { path: 'App.app', identifier: 'com.example.app' },
      productStyle: true,
      title: 'Title & <Friends>',
    });
    expect(xml).toContain('<title>Title &amp; &lt;Friends&gt;</title>');
    expect(parseXml(xml).name).toBe('installer-gui-script');
  });
});

describe('buildComponentPackage', () => {
  it('builds deterministic metadata from a fixture app', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-units-bcp-'));
    const app = path.join(tmp, 'parent', 'Meta.app');
    writeFixtureTree(path.join(tmp, 'parent'), [
      {
        path: 'Meta.app/Contents/Info.plist',
        content: infoPlist('com.example.meta', {
          CFBundleName: 'Meta',
          CFBundleShortVersionString: '2.1',
          CFBundleVersion: '77',
        }),
      },
      { path: 'Meta.app/Contents/Resources/blob.bin', content: Buffer.alloc(4000, 7) },
    ]);
    const component = await buildComponentPackage({ app });
    expect(component.identifier).toBe('com.example.meta');
    expect(component.version).toBe('2.1.0');
    expect(component.title).toBe('Meta');
    expect(component.numberOfFiles).toBe(5);
    // sizeSum: plist + blob + dirs (Meta.app 96, Contents 128, Resources 64+32)
    const plistSize = fs.statSync(path.join(app, 'Contents', 'Info.plist')).size;
    expect(component.installKBytes).toBe(Math.floor((plistSize + 4000 + 96 + 128 + 96) / 1024));
    expect(zlib.gunzipSync(Buffer.concat(component.payload)).length % 512).toBe(0);
    expect(component.packageInfo.toString()).toContain('identifier="com.example.meta"');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
