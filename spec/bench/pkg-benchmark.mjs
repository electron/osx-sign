#!/usr/bin/env node
/**
 * Benchmark: pure-JS flat package builder vs Apple's native
 * pkgbuild/productbuild.
 *
 * Usage:
 *   yarn bench                        # downloads Electron and benchmarks it
 *   OSX_SIGN_BENCH_APP=path yarn bench  # benchmark a specific .app
 *   OSX_SIGN_BENCH_RUNS=5 yarn bench    # runs per pipeline (default 3)
 *   OSX_SIGN_BENCH_SYNTHETIC=400 yarn bench  # use a synthetic app of ~400 MB
 *
 * On macOS the native pipelines run for comparison and the JS payload is
 * verified byte-identical against the native one. On other platforms only
 * the JS pipelines run (native tools do not exist there).
 */

import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import { buildProductArchive } from '../../dist/pkg-utils/pkg.js';
import { readXar } from '../../dist/pkg-utils/xar.js';

const RUNS = Number(process.env.OSX_SIGN_BENCH_RUNS ?? 3);
const isDarwin = process.platform === 'darwin';

function hasCommand(cmd) {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const nativeAvailable = isDarwin && hasCommand('pkgbuild') && hasCommand('productbuild');

// ---------------------------------------------------------------------------
// App acquisition
// ---------------------------------------------------------------------------

function generateSyntheticApp(root, totalMB) {
  const app = path.join(root, 'Bench.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  const fwDir = path.join(app, 'Contents', 'Frameworks', 'Bench Framework.framework');
  fs.mkdirSync(path.join(fwDir, 'Versions', 'A'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.bench</string>
<key>CFBundleName</key><string>Bench</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>100</string>
<key>CFBundleExecutable</key><string>Bench</string>
</dict></plist>`,
  );
  const fill = (buf, seed) => {
    let state = seed >>> 0;
    for (let i = 0; i + 4 <= buf.length; i += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      // Half-repetitive content compresses like real binaries/resources do.
      buf.writeUInt32LE((i & 8 ? state : state & 0xff0f0f0f) >>> 0, i);
    }
  };
  let buf = Buffer.alloc(Math.floor(totalMB * 0.55 * 1024 * 1024));
  fill(buf, 42);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4); // arm64 thin Mach-O header
  fs.writeFileSync(path.join(fwDir, 'Versions', 'A', 'Bench Framework'), buf);
  buf = Buffer.alloc(Math.floor(totalMB * 0.15 * 1024 * 1024));
  fill(buf, 7);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(0x0100000c, 4);
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Bench'), buf, { mode: 0o755 });
  const files = 2500;
  const per = Math.floor((totalMB * 0.3 * 1024 * 1024) / files);
  for (let d = 0; d < 50; d++) {
    const dir = path.join(app, 'Contents', 'Resources', `locale-${String(d).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < files / 50; f++) {
      const b = Buffer.alloc(per + ((d * 50 + f) % 1000));
      fill(b, d * 1000 + f);
      fs.writeFileSync(path.join(dir, `res-${String(f).padStart(3, '0')}.pak`), b);
    }
  }
  fs.symlinkSync('Versions/A/Bench Framework', path.join(fwDir, 'Bench Framework'));
  fs.symlinkSync('A', path.join(fwDir, 'Versions', 'Current'));
  return app;
}

async function acquireApp(workDir) {
  if (process.env.OSX_SIGN_BENCH_APP) {
    return { app: path.resolve(process.env.OSX_SIGN_BENCH_APP), label: 'user-provided app' };
  }
  if (process.env.OSX_SIGN_BENCH_SYNTHETIC) {
    const mb = Number(process.env.OSX_SIGN_BENCH_SYNTHETIC);
    console.log(`Generating ~${mb} MB synthetic app...`);
    return { app: generateSyntheticApp(workDir, mb), label: `synthetic ${mb} MB app` };
  }
  const version = process.env.OSX_SIGN_BENCH_ELECTRON ?? '43.1.0';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  console.log(`Downloading Electron v${version} (darwin-${arch})...`);
  const { downloadArtifact } = await import('@electron/get');
  const { extract } = await import('@electron-internal/extract-zip');
  const zip = await downloadArtifact({
    version,
    platform: 'darwin',
    arch,
    artifactName: 'electron',
  });
  const dir = path.join(workDir, 'electron');
  await extract(zip, { dir });
  return { app: path.join(dir, 'Electron.app'), label: `Electron v${version} (darwin-${arch})` };
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function nativePackagePipeline(app, outDir) {
  // Exactly what @electron/osx-sign's flat() runs for non-MAS builds.
  const component = path.join(outDir, 'native-component.pkg');
  const product = path.join(outDir, 'native-product.pkg');
  await execFileAsync('pkgbuild', [
    '--install-location',
    '/Applications',
    '--component',
    app,
    component,
  ]);
  await execFileAsync('productbuild', ['--package', component, '/Applications', product]);
  fs.rmSync(component);
  return product;
}

async function nativeComponentPipeline(app, outDir) {
  // What flat() runs for MAS builds.
  const product = path.join(outDir, 'native-mas.pkg');
  await execFileAsync('productbuild', ['--component', app, '/Applications', product]);
  return product;
}

async function jsPipeline(app, outDir, compression, name) {
  const product = path.join(outDir, name);
  await buildProductArchive({
    app,
    installLocation: '/Applications',
    output: product,
    compression,
  });
  return product;
}

async function timePipeline(label, runs, fn) {
  const times = [];
  let output;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    output = await fn();
    times.push((performance.now() - start) / 1000);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const size = fs.statSync(output).size;
  console.log(
    `  ${label}: median ${median.toFixed(2)}s (runs: ${times.map((t) => t.toFixed(2)).join(', ')})`,
  );
  return { label, median, best: times[0], size, output };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function parseCpioNames(buf) {
  const entries = [];
  let offset = 0;
  while (offset < buf.length) {
    const header = buf.subarray(offset, offset + 76).toString('latin1');
    if (header.slice(0, 6) !== '070707') break;
    const namesize = parseInt(header.slice(59, 65), 8);
    const filesize = parseInt(header.slice(65, 76), 8);
    entries.push({
      name: buf.subarray(offset + 76, offset + 76 + namesize - 1).toString('utf8'),
      header,
      data: buf.subarray(offset + 76 + namesize, offset + 76 + namesize + filesize),
    });
    offset += 76 + namesize + filesize;
  }
  return entries;
}

/** Drop AppleDouble entries and renumber inodes (see pkg-parity.spec.ts). */
function normalizePayload(buf) {
  const entries = parseCpioNames(buf).filter(
    (e) => !(e.name.split('/').pop() ?? '').startsWith('._'),
  );
  const chunks = [];
  let written = 0;
  entries.forEach((entry, ino) => {
    const nameBuf = Buffer.concat([Buffer.from(entry.name, 'utf8'), Buffer.from([0])]);
    const header =
      entry.header.slice(0, 12) + ino.toString(8).padStart(6, '0') + entry.header.slice(18);
    chunks.push(Buffer.from(header, 'latin1'), nameBuf, entry.data);
    written += 76 + nameBuf.length + entry.data.length;
  });
  const pad = (512 - (written % 512)) % 512;
  if (pad > 0) chunks.push(Buffer.alloc(pad));
  return Buffer.concat(chunks);
}

async function payloadOf(pkgPath) {
  const members = await readXar(pkgPath);
  const payload = members.find((m) => m.path.endsWith('/Payload'));
  return zlib.gunzipSync(payload.data);
}

// ---------------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-bench-'));
try {
  const { app, label } = await acquireApp(workDir);
  const stats = execFileSync('du', ['-sh', app], { encoding: 'utf8' }).split('\t')[0].trim();
  const fileCount = fs
    .readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).length;
  console.log(`\nBenchmarking against ${label}: ${stats}, ${fileCount} files`);
  console.log(`Runs per pipeline: ${RUNS}\n`);

  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir);

  const results = [];
  if (nativeAvailable) {
    results.push(
      await timePipeline('native pkgbuild + productbuild --package', RUNS, () =>
        nativePackagePipeline(app, outDir),
      ),
    );
    results.push(
      await timePipeline('native productbuild --component (MAS)', RUNS, () =>
        nativeComponentPipeline(app, outDir),
      ),
    );
  } else {
    console.log('  (native tools unavailable on this platform — JS pipelines only)');
  }
  const jsResult = await timePipeline('js implementation', RUNS, () =>
    jsPipeline(app, outDir, undefined, 'js.pkg'),
  );
  results.push(jsResult);

  if (nativeAvailable) {
    process.stdout.write('\nVerifying JS payload matches the native payload... ');
    const native = normalizePayload(await payloadOf(results[0].output));
    const js = normalizePayload(await payloadOf(jsResult.output));
    if (Buffer.compare(native, js) !== 0) {
      console.log('MISMATCH — benchmark outputs are not equivalent!');
      process.exitCode = 1;
    } else {
      console.log(`ok (${js.length} bytes uncompressed)`);
    }
  }

  const baseline = results[0];
  console.log(`\n| pipeline | median | speedup | output size |`);
  console.log(`| --- | --- | --- | --- |`);
  for (const result of results) {
    console.log(
      `| ${result.label} | ${result.median.toFixed(2)}s | ${(baseline.median / result.median).toFixed(2)}x | ${(result.size / 1e6).toFixed(1)} MB |`,
    );
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
