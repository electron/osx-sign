import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { extract } from '@electron-internal/extract-zip';
import { downloadArtifact } from '@electron/get';

import { buildProductArchive } from '../../src/pkg-utils/pkg.js';
import { readXar } from '../../src/pkg-utils/xar.js';
import {
  commandExists,
  lsbomNormalized,
  normalizeCpio,
  normalizeGeneratorVersion,
} from './helpers.js';

/**
 * End-to-end parity against a real Electron.app — the exact artifact this
 * library packages in production. Compares the pure-JS product archive with
 * `productbuild --component` output member by member.
 */

const hasNativeTools =
  process.platform === 'darwin' && ['productbuild', 'lsbom', 'xar'].every(commandExists);

const ELECTRON_VERSION = '43.1.0';
const WORK_CWD = path.join(import.meta.dirname, '..', 'work-pkg-electron');

describe.runIf(hasNativeTools)('pkg parity with a real Electron.app', () => {
  let app: string;
  let nativePkg: string;
  let jsPkg: string;

  beforeAll(async () => {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const artifact = await downloadArtifact({
      version: ELECTRON_VERSION,
      platform: 'darwin',
      arch,
      artifactName: 'electron',
    });
    const dir = path.join(WORK_CWD, `v${ELECTRON_VERSION}-${arch}`);
    await extract(artifact, { dir });
    app = path.join(dir, 'Electron.app');

    const outDir = path.join(WORK_CWD, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    nativePkg = path.join(outDir, 'native.pkg');
    jsPkg = path.join(outDir, 'js.pkg');
    execFileSync('productbuild', ['--component', app, '/Applications', nativePkg], {
      stdio: 'pipe',
    });
    await buildProductArchive({ app, installLocation: '/Applications', output: jsPkg });
  }, 300_000);

  afterAll(async () => {
    await fs.promises.rm(WORK_CWD, { recursive: true, force: true });
  });

  it('expands with pkgutil back to the original app', () => {
    // The Electron payload spans many parallel compression chunks; Apple's
    // extractor must accept the stitched gzip stream and reproduce the tree.
    const expanded = path.join(WORK_CWD, 'expanded');
    execFileSync('pkgutil', ['--expand-full', jsPkg, expanded], { stdio: 'pipe' });
    const payloadDir = fs.readdirSync(expanded).find((d) => d.endsWith('.pkg'))!;
    execFileSync('diff', ['-r', app, path.join(expanded, payloadDir, 'Payload', 'Electron.app')], {
      stdio: 'pipe',
    });
  });

  it('produces a byte-identical uncompressed payload', async () => {
    const nativeDir = fs.mkdtempSync(path.join(WORK_CWD, 'nx-'));
    execFileSync('xar', ['-xf', nativePkg], { cwd: nativeDir });
    const embedded = fs.readdirSync(nativeDir).find((d) => d.endsWith('.pkg'))!;
    const native = normalizeCpio(
      zlib.gunzipSync(fs.readFileSync(path.join(nativeDir, embedded, 'Payload'))),
    );
    const members = await readXar(jsPkg);
    const js = zlib.gunzipSync(members.find((m) => m.path === `${embedded}/Payload`)!.data!);
    expect(js.length).toBe(native.length);
    expect(Buffer.compare(native, js)).toBe(0);
  });

  it('produces identical PackageInfo, Distribution and lsbom output', async () => {
    const nativeDir = fs.mkdtempSync(path.join(WORK_CWD, 'nx2-'));
    execFileSync('xar', ['-xf', nativePkg], { cwd: nativeDir });
    const embedded = fs.readdirSync(nativeDir).find((d) => d.endsWith('.pkg'))!;
    const members = await readXar(jsPkg);
    const memberOf = (p: string) => members.find((m) => m.path === p)!.data!;

    expect(normalizeGeneratorVersion(memberOf(`${embedded}/PackageInfo`).toString('utf8'))).toBe(
      normalizeGeneratorVersion(
        fs.readFileSync(path.join(nativeDir, embedded, 'PackageInfo'), 'utf8'),
      ),
    );
    expect(normalizeGeneratorVersion(memberOf('Distribution').toString('utf8'))).toBe(
      normalizeGeneratorVersion(fs.readFileSync(path.join(nativeDir, 'Distribution'), 'utf8')),
    );

    const jsBomPath = path.join(nativeDir, 'js-Bom');
    fs.writeFileSync(jsBomPath, memberOf(`${embedded}/Bom`));
    expect(lsbomNormalized(jsBomPath)).toEqual(
      lsbomNormalized(path.join(nativeDir, embedded, 'Bom')),
    );
  });
});

describe.runIf(!hasNativeTools)('pkg parity with a real Electron.app (skipped)', () => {
  it('requires macOS with the native packaging tools installed', () => {
    expect(true).toBe(true);
  });
});
