import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildComponentPackageFile, buildProductArchive } from '../../src/pkg-utils/pkg.js';
import { readXar } from '../../src/pkg-utils/xar.js';
import { readBom } from '../../src/pkg-utils/bom-reader.js';
import {
  commandExists,
  FixtureFile,
  infoPlist,
  lsbomNormalized,
  normalizeCpio,
  normalizeGeneratorVersion,
  writeFixtureTree,
} from './helpers.js';

/**
 * Byte/semantic parity between the pure-JS packager and Apple's native
 * pkgbuild/productbuild:
 *
 * - Payload/Scripts: byte-identical uncompressed cpio streams.
 * - PackageInfo/Distribution: byte-identical modulo the generator-version
 *   attribute (which encodes the tool version on both sides).
 * - Bom: identical lsbom output for every printable field, identical BomInfo
 *   size accounting, and identical B-tree entry ordering.
 * - The JS-built package must be readable by Apple's own tooling
 *   (xar, pkgutil --expand-full) and expand to the original app tree.
 *
 * AppleDouble (`._*`) entries are filtered from the native output before
 * comparison: on hosts where the sandbox stamps com.apple.provenance xattrs
 * onto fixture files, pkgbuild archives those as AppleDouble entries, which
 * the JS implementation intentionally does not reproduce (xattr preservation
 * is out of scope). On xattr-free hosts the filter is a no-op and the
 * comparison is a straight byte-for-byte check.
 */

const isDarwin = process.platform === 'darwin';
const hasNativeTools =
  isDarwin && ['pkgbuild', 'productbuild', 'lsbom', 'xar', 'pkgutil'].every(commandExists);

interface Fixture {
  name: string;
  bundleName: string;
  files: FixtureFile[];
  scripts?: FixtureFile[];
}

function pseudoRandom(bytes: number, seed: number): Buffer {
  // Deterministic filler that does not compress trivially.
  const buf = Buffer.allocUnsafe(bytes);
  let state = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buf[i] = state >>> 24;
  }
  return buf;
}

const FIXTURES: Fixture[] = [
  {
    name: 'simple app',
    bundleName: 'Simple.app',
    files: [
      {
        path: 'Simple.app/Contents/Info.plist',
        content: infoPlist('com.example.simple', {
          CFBundleName: 'Simple',
          CFBundleShortVersionString: '1.2.3',
          CFBundleVersion: '123',
          CFBundleExecutable: 'Fixture',
          LSMinimumSystemVersion: '11.0',
        }),
      },
      { path: 'Simple.app/Contents/MacOS/Fixture', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      { path: 'Simple.app/Contents/Resources/data.txt', content: 'hello resource' },
    ],
  },
  {
    name: 'symlinks, empty dirs and odd modes',
    bundleName: 'Odd.app',
    files: [
      {
        path: 'Odd.app/Contents/Info.plist',
        content: infoPlist('com.example.odd', { CFBundleShortVersionString: '1.0' }),
      },
      { path: 'Odd.app/Contents/Resources/secret.txt', content: 'shh', mode: 0o600 },
      { path: 'Odd.app/Contents/Resources/exec-only', content: 'x', mode: 0o711 },
      { path: 'Odd.app/Contents/Resources/rel-link', symlink: '../Info.plist' },
      { path: 'Odd.app/Contents/Resources/abs-link', symlink: '/usr/lib/libz.dylib' },
      { path: 'Odd.app/Contents/Resources/empty-dir', directory: true },
      { path: 'Odd.app/Contents/Resources/empty-file', content: '' },
      { path: 'Odd.app/Contents/Frameworks/Deep/Nested/Tree/leaf.txt', content: 'leaf' },
    ],
  },
  (() => {
    // Unicode names are written in NFD (decomposed) form: native pkgbuild
    // *silently drops* NFC-named files from the payload (while still listing
    // them in the Bom), so NFC names cannot be byte-compared against it. Our
    // implementation packages NFC names correctly — see the data-loss
    // regression test in pkg-units.spec.ts. An em dash in the bundle name is
    // avoided for the same reason: pkgbuild emits an empty payload for those.
    // normalize('NFD') guards against editors/formatters recomposing the literal
    const bundle = 'Ünicode “app”.app'.normalize('NFD');
    return {
      name: 'unicode and sort-hostile names',
      bundleName: bundle,
      files: [
        { path: `${bundle}/Contents/Info.plist`, content: infoPlist('com.example.unicode') },
        { path: `${bundle}/Contents/Resources/Z-upper.txt`, content: 'Z' },
        { path: `${bundle}/Contents/Resources/a-lower.txt`, content: 'a' },
        { path: `${bundle}/Contents/Resources/émoji 🎁.txt`.normalize('NFD'), content: 'gift' },
        { path: `${bundle}/Contents/Resources/foo`, directory: true },
        { path: `${bundle}/Contents/Resources/foo/x.txt`, content: 'x' },
        { path: `${bundle}/Contents/Resources/foo.txt`, content: 'prefix-hostile' },
        { path: `${bundle}/Contents/Resources/名前.txt`.normalize('NFD'), content: 'nihongo' },
      ],
    };
  })(),
  {
    // Large enough that the payload spans multiple parallel compression
    // chunks (> 2 MB), so the expand test exercises the stitched single-member
    // gzip stream against Apple's extractor.
    name: 'larger tree spanning multiple bom leaves',
    bundleName: 'Grande.app',
    files: [
      { path: 'Grande.app/Contents/Info.plist', content: infoPlist('com.example.grande') },
      ...Array.from({ length: 40 }, (_, d) =>
        Array.from({ length: 20 }, (_, f) => ({
          path: `Grande.app/Contents/Resources/d${String(d).padStart(2, '0')}/f${String(f).padStart(2, '0')}.bin`,
          content: pseudoRandom(((d * 20 + f) % 7) * 2048 + 1024, d * 1000 + f),
        })),
      ).flat(),
    ],
  },
  {
    name: 'scripts',
    bundleName: 'Scripted.app',
    files: [
      { path: 'Scripted.app/Contents/Info.plist', content: infoPlist('com.example.scripted') },
      { path: 'Scripted.app/Contents/MacOS/Fixture', content: '#!/bin/sh\n', mode: 0o755 },
    ],
    scripts: [
      { path: 'preinstall', content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
      { path: 'postinstall', content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
      { path: 'extras/helper.sh', content: 'echo helper\n' },
    ],
  },
];

interface BuiltFixture {
  fixture: Fixture;
  appPath: string;
  scriptsPath?: string;
  nativeComponentPkg: string;
  nativeProductPkg: string;
  jsComponentPkg: string;
  jsProductPkg: string;
}

describe.runIf(hasNativeTools)('pkg parity with native pkgbuild/productbuild', () => {
  let tmp: string;
  const built: BuiltFixture[] = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-parity-'));
    for (const [index, fixture] of FIXTURES.entries()) {
      // Each app lives alone in its own parent directory: pkgbuild derives the
      // payload root metadata from the app's parent, so nothing else may live
      // (or be written) there.
      const parent = path.join(tmp, `fixture-${index}`, 'app-parent');
      writeFixtureTree(parent, fixture.files);
      const appPath = path.join(parent, fixture.bundleName);
      let scriptsPath: string | undefined;
      if (fixture.scripts) {
        scriptsPath = path.join(tmp, `fixture-${index}`, 'scripts');
        writeFixtureTree(scriptsPath, fixture.scripts);
      }

      const outDir = path.join(tmp, `fixture-${index}`, 'out');
      fs.mkdirSync(outDir, { recursive: true });
      const nativeComponentPkg = path.join(outDir, 'native-component.pkg');
      const nativeProductPkg = path.join(outDir, 'native-product.pkg');
      const jsComponentPkg = path.join(outDir, 'js-component.pkg');
      const jsProductPkg = path.join(outDir, 'js-product.pkg');

      const pkgbuildArgs = ['--install-location', '/Applications'];
      if (scriptsPath) pkgbuildArgs.push('--scripts', scriptsPath);
      execFileSync('pkgbuild', [...pkgbuildArgs, '--component', appPath, nativeComponentPkg], {
        stdio: 'pipe',
      });
      execFileSync('productbuild', ['--component', appPath, '/Applications', nativeProductPkg], {
        stdio: 'pipe',
      });

      await buildComponentPackageFile(jsComponentPkg, {
        app: appPath,
        installLocation: '/Applications',
        scripts: scriptsPath,
      });
      await buildProductArchive({
        app: appPath,
        installLocation: '/Applications',
        output: jsProductPkg,
      });

      built.push({
        fixture,
        appPath,
        scriptsPath,
        nativeComponentPkg,
        nativeProductPkg,
        jsComponentPkg,
        jsProductPkg,
      });
    }
  }, 300_000);

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function membersOf(pkg: string): Promise<Map<string, Buffer>> {
    const members = await readXar(pkg);
    return new Map(
      members.filter((m) => m.type === 'file').map((m) => [m.path, m.data ?? Buffer.alloc(0)]),
    );
  }

  function extractNative(pkg: string): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'native-x-'));
    execFileSync('xar', ['-xf', pkg], { cwd: dir });
    return dir;
  }

  it('produces byte-identical payload cpio streams', async () => {
    for (const b of built) {
      const nativeDir = extractNative(b.nativeComponentPkg);
      const native = normalizeCpio(
        zlib.gunzipSync(fs.readFileSync(path.join(nativeDir, 'Payload'))),
      );
      const js = zlib.gunzipSync((await membersOf(b.jsComponentPkg)).get('Payload')!);
      expect(Buffer.compare(native, js), b.fixture.name).toBe(0);
    }
  });

  it('produces byte-identical scripts archives', async () => {
    for (const b of built.filter((f) => f.scriptsPath)) {
      const nativeDir = extractNative(b.nativeComponentPkg);
      const native = normalizeCpio(
        zlib.gunzipSync(fs.readFileSync(path.join(nativeDir, 'Scripts'))),
      );
      const js = zlib.gunzipSync((await membersOf(b.jsComponentPkg)).get('Scripts')!);
      expect(Buffer.compare(native, js), b.fixture.name).toBe(0);
    }
  });

  it('produces identical PackageInfo documents (modulo generator-version)', async () => {
    for (const b of built) {
      const nativeDir = extractNative(b.nativeComponentPkg);
      const native = normalizeGeneratorVersion(
        fs.readFileSync(path.join(nativeDir, 'PackageInfo'), 'utf8'),
      );
      const js = normalizeGeneratorVersion(
        (await membersOf(b.jsComponentPkg)).get('PackageInfo')!.toString('utf8'),
      );
      expect(js, b.fixture.name).toBe(native);
    }
  });

  it('produces Boms with identical lsbom output', async () => {
    for (const b of built) {
      const nativeDir = extractNative(b.nativeComponentPkg);
      const jsBomPath = path.join(nativeDir, 'js-Bom');
      fs.writeFileSync(jsBomPath, (await membersOf(b.jsComponentPkg)).get('Bom')!);
      for (const args of [[], ['-p', 'fMUGsc'], ['-m', '-p', 'fmugtsc']]) {
        const native = lsbomNormalized(path.join(nativeDir, 'Bom'), args);
        const js = lsbomNormalized(jsBomPath, args);
        expect(js, `${b.fixture.name} lsbom ${args.join(' ')}`).toEqual(native);
      }
    }
  });

  it('produces Boms with identical BomInfo size accounting and tree order', async () => {
    for (const b of built) {
      const nativeDir = extractNative(b.nativeComponentPkg);
      const native = readBom(fs.readFileSync(path.join(nativeDir, 'Bom')));
      const js = readBom((await membersOf(b.jsComponentPkg)).get('Bom')!);
      expect(js.sizeSum, b.fixture.name).toBe(native.sizeSum);
      const isAppleDouble = (p: string) => (p.split('/').pop() ?? '').startsWith('._');
      const nativePaths = native.paths.map((p) => p.path).filter((p) => !isAppleDouble(p));
      const jsPaths = js.paths.map((p) => p.path);
      // Same B-tree traversal order (leaf order), not merely the same set.
      expect(jsPaths, b.fixture.name).toEqual(nativePaths);
      expect(js.numberOfPaths, b.fixture.name).toBe(jsPaths.length + 1);
    }
  });

  it('produces identical Distribution documents (modulo generator-version)', async () => {
    for (const b of built) {
      const nativeDir = extractNative(b.nativeProductPkg);
      const native = normalizeGeneratorVersion(
        fs.readFileSync(path.join(nativeDir, 'Distribution'), 'utf8'),
      );
      const js = normalizeGeneratorVersion(
        (await membersOf(b.jsProductPkg)).get('Distribution')!.toString('utf8'),
      );
      expect(js, b.fixture.name).toBe(native);
    }
  });

  it('wraps an existing component package identically to productbuild --package', async () => {
    const b = built[0];
    const outDir = fs.mkdtempSync(path.join(tmp, 'pkgmode-'));
    const nativeOut = path.join(outDir, 'native.pkg');
    const jsOut = path.join(outDir, 'js.pkg');
    execFileSync('productbuild', ['--package', b.nativeComponentPkg, nativeOut], {
      stdio: 'pipe',
    });
    await buildProductArchive({ package: b.nativeComponentPkg, output: jsOut });

    const nativeDir = extractNative(nativeOut);
    const jsMembers = await membersOf(jsOut);
    const embedded = path.basename(b.nativeComponentPkg);
    expect(normalizeGeneratorVersion(jsMembers.get('Distribution')!.toString('utf8'))).toBe(
      normalizeGeneratorVersion(fs.readFileSync(path.join(nativeDir, 'Distribution'), 'utf8')),
    );
    // The embedded component's members must survive the round-trip
    // byte-identically once decompressed.
    for (const member of ['Payload', 'PackageInfo', 'Bom']) {
      const native = fs.readFileSync(path.join(nativeDir, embedded, member));
      expect(Buffer.compare(native, jsMembers.get(`${embedded}/${member}`)!), member).toBe(0);
    }
  });

  it('percent-encodes embedded package references like productbuild', async () => {
    // Regression: Installer resolves `#name.pkg` as a URL fragment, so names
    // with spaces (or any non-fragment character) must be percent-encoded.
    const b = built[0];
    const outDir = fs.mkdtempSync(path.join(tmp, 'encode-'));
    const spacey = path.join(outDir, 'My App-component.pkg');
    fs.copyFileSync(b.nativeComponentPkg, spacey);
    const nativeOut = path.join(outDir, 'native.pkg');
    const jsOut = path.join(outDir, 'js.pkg');
    execFileSync('productbuild', ['--package', spacey, nativeOut], { stdio: 'pipe' });
    await buildProductArchive({ package: spacey, output: jsOut });
    const nativeDir = extractNative(nativeOut);
    const jsMembers = await membersOf(jsOut);
    expect(normalizeGeneratorVersion(jsMembers.get('Distribution')!.toString('utf8'))).toBe(
      normalizeGeneratorVersion(fs.readFileSync(path.join(nativeDir, 'Distribution'), 'utf8')),
    );
    expect(jsMembers.get('Distribution')!.toString('utf8')).toContain('#My%20App-component.pkg');
  });

  it('builds packages Apple tooling can expand back to the original app', async () => {
    for (const b of built) {
      const expanded = path.join(path.dirname(b.jsProductPkg), 'expanded');
      execFileSync('pkgutil', ['--expand-full', b.jsProductPkg, expanded], { stdio: 'pipe' });
      const payloadDir = fs.readdirSync(expanded).find((entry) => entry.endsWith('.pkg'));
      expect(payloadDir, b.fixture.name).toBeDefined();
      const extractedApp = path.join(expanded, payloadDir!, 'Payload', path.basename(b.appPath));
      // diff -r follows symlink targets; --no-dereference compares the links
      execFileSync('diff', ['-r', '--no-dereference', b.appPath, extractedApp], {
        stdio: 'pipe',
      });
      fs.rmSync(expanded, { recursive: true, force: true });
    }
  });

  it('builds component packages xar itself can list and extract', async () => {
    for (const b of built) {
      const listing = execFileSync('xar', ['-tf', b.jsComponentPkg], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .sort();
      const expected = ['Bom', 'PackageInfo', 'Payload'];
      if (b.scriptsPath) expected.push('Scripts');
      expect(listing, b.fixture.name).toEqual(expected.sort());
    }
  });
});

describe.runIf(!hasNativeTools)('pkg parity (skipped)', () => {
  it('requires macOS with the native packaging tools installed', () => {
    expect(true).toBe(true);
  });
});
