import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { flat } from '../src/index.js';
import { readXar } from '../src/pkg-utils/xar.js';
import { readBom } from '../src/pkg-utils/bom-reader.js';
import { commandExists, infoPlist, parseCpio, writeFixtureTree } from './pkg-utils/helpers.js';

const hasPkgutil = process.platform === 'darwin' && commandExists('pkgutil');

describe('flat (js implementation)', () => {
  let tmp: string;
  let app: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-js-'));
    const parent = path.join(tmp, 'parent');
    writeFixtureTree(parent, [
      { path: 'Flat.app/Contents/Info.plist', content: infoPlist('com.example.flat') },
      { path: 'Flat.app/Contents/MacOS/Fixture', content: '#!/bin/sh\n', mode: 0o755 },
      { path: 'Flat.app/Contents/Resources/data.txt', content: 'data' },
    ]);
    app = path.join(parent, 'Flat.app');
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('builds an unsigned pkg on any platform', async () => {
    const pkg = path.join(tmp, 'out', 'flat.pkg');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    await flat({ app, pkg, identity: null, platform: 'darwin', implementation: 'js' });
    const members = await readXar(pkg);
    const paths = members.map((m) => m.path);
    expect(paths).toContain('Distribution');
    expect(paths).toContain('Flat-component.pkg/Payload');
    expect(paths).toContain('Flat-component.pkg/PackageInfo');
    expect(paths).toContain('Flat-component.pkg/Bom');

    if (hasPkgutil) {
      const expanded = path.join(tmp, 'out', 'expanded');
      execFileSync('pkgutil', ['--expand-full', pkg, expanded], { stdio: 'pipe' });
      expect(
        fs.readFileSync(
          path.join(
            expanded,
            'Flat-component.pkg',
            'Payload',
            'Flat.app',
            'Contents',
            'Resources',
            'data.txt',
          ),
          'utf8',
        ),
      ).toBe('data');
    }
  });

  it('builds a mas-style pkg with the identifier as the embedded name', async () => {
    const pkg = path.join(tmp, 'out-mas', 'flat.pkg');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    await flat({ app, pkg, identity: null, platform: 'mas', implementation: 'js' });
    const members = await readXar(pkg);
    expect(members.map((m) => m.path)).toContain('com.example.flat.pkg/Payload');
    const packageInfo = members
      .find((m) => m.path === 'com.example.flat.pkg/PackageInfo')!
      .data!.toString('utf8');
    expect(packageInfo).toContain('preserve-xattr="true"');
  });

  it('overwrites an existing output package', async () => {
    // Regression guard for rebuild loops: the second build must replace the
    // first (productsign also refuses existing destinations; the js path
    // removes the output before signing).
    const pkg = path.join(tmp, 'out-twice', 'flat.pkg');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    await flat({ app, pkg, identity: null, platform: 'darwin', implementation: 'js' });
    const firstSize = fs.statSync(pkg).size;
    await flat({ app, pkg, identity: null, platform: 'darwin', implementation: 'js' });
    expect(fs.statSync(pkg).size).toBeGreaterThan(0);
    expect(Math.abs(fs.statSync(pkg).size - firstSize)).toBeLessThan(1024);
  });

  it('applies squirrel-friendly permissions when requested', async () => {
    // The app's parent directory mode feeds the payload root entry; make it
    // something other than 755 to prove the root is forced to 0775 like the
    // legacy setPermissionOnBom rewrite guarantees.
    fs.chmodSync(path.dirname(app), 0o700);
    const pkg = path.join(tmp, 'out-squirrel', 'flat.pkg');
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    await flat({
      app,
      pkg,
      identity: null,
      platform: 'darwin',
      implementation: 'js',
      openPermissionsForSquirrelMac: true,
    });
    const members = await readXar(pkg);
    const payload = zlib.gunzipSync(members.find((m) => m.path.endsWith('/Payload'))!.data!);
    const entries = parseCpio(payload).filter((e) => e.name !== 'TRAILER!!!');
    const byName = new Map(entries.map((e) => [e.name, e]));
    // The payload root is forced to 0775 regardless of the staging
    // directory's permissions (here 0700).
    expect(byName.get('.')!.mode & 0o7777).toBe(0o775);
    expect(byName.get('./Flat.app')!.mode & 0o7777).toBe(0o775);
    expect(byName.get('./Flat.app/Contents/MacOS/Fixture')!.mode & 0o7777).toBe(0o775);
    expect(byName.get('./Flat.app/Contents/Resources/data.txt')!.mode & 0o7777).toBe(0o664);
    for (const entry of entries) {
      expect(entry.gid, entry.name).toBe(80);
      expect(entry.uid, entry.name).toBe(0);
    }
    const bom = readBom(members.find((m) => m.path.endsWith('/Bom'))!.data!);
    for (const bomPath of bom.paths) {
      if (bomPath.path === '.') continue;
      expect(bomPath.gid, bomPath.path).toBe(80);
    }
  });
});
