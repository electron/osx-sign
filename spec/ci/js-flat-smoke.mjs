#!/usr/bin/env node
/**
 * Cross-platform smoke test for the JS packaging implementation via the
 * shipped CLI: builds a fixture app into a .pkg with `electron-osx-flat
 * --implementation=js`, then reads the archive back and checks the payload.
 * Run after `yarn build`; exits non-zero on any mismatch.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { readXar } from '../../dist/pkg-utils/xar.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'js-flat-smoke-'));
try {
  const app = path.join(tmp, 'parent', 'Smoke.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.smoke</string>
<key>CFBundleName</key><string>Smoke</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>100</string>
</dict></plist>`,
  );
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Smoke'), '#!/bin/sh\necho hi\n', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'data.txt'), 'smoke test payload');
  fs.symlinkSync('data.txt', path.join(app, 'Contents', 'Resources', 'link'));

  const pkg = path.join(tmp, 'Smoke.pkg');
  const cli = path.join(import.meta.dirname, '..', '..', 'bin', 'electron-osx-flat.mjs');
  execFileSync(
    process.execPath,
    [cli, app, '--implementation=js', '--noIdentity', '--platform=darwin', `--pkg=${pkg}`],
    { stdio: 'inherit' },
  );

  const members = await readXar(pkg);
  const memberOf = (p) => members.find((m) => m.path === p)?.data;
  assert.ok(memberOf('Distribution'), 'Distribution missing');
  assert.ok(memberOf('Smoke-component.pkg/Bom'), 'Bom missing');
  const packageInfo = memberOf('Smoke-component.pkg/PackageInfo').toString('utf8');
  assert.match(packageInfo, /identifier="com\.example\.smoke"/);
  assert.match(packageInfo, /numberOfFiles="8"/);

  const payload = zlib.gunzipSync(memberOf('Smoke-component.pkg/Payload'));
  const text = payload.toString('latin1');
  for (const expected of [
    './Smoke.app/Contents/MacOS/Smoke',
    './Smoke.app/Contents/Resources/data.txt',
    './Smoke.app/Contents/Resources/link',
    'smoke test payload',
    'TRAILER!!!',
  ]) {
    assert.ok(text.includes(expected), `payload missing: ${expected}`);
  }
  assert.strictEqual(payload.length % 512, 0, 'payload not block-padded');

  console.log(`ok: built and validated ${pkg} on ${process.platform}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
