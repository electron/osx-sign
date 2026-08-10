import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extract } from '@electron-internal/extract-zip';

import { downloadArtifact } from '@electron/get';
import { sign } from '../src';

const versions = ['35.0.3', 'v36.0.0-alpha.4'];
const platforms = ['darwin', 'mas'];
const arches = ['x64', 'arm64'];
const WORK_CWD = path.join(import.meta.dirname, 'work');

describe.runIf(process.platform === 'darwin')('sign', () => {
  describe.each(versions)('v%s', { timeout: 60_000 }, (version) => {
    describe.each(platforms)('on %s', (platform) => {
      describe.each(arches)('on %s', (arch) => {
        const dir = path.join(WORK_CWD, `v${version}-${platform}-${arch}`);
        beforeAll(async () => {
          const artifact = await downloadArtifact({
            version,
            platform,
            arch,
            artifactName: 'electron',
          });
          await extract(artifact, { dir });
        });

        it('can sign the app', async () => {
          /**
           * This test uses a self-signed certificate generated with `/spec/ci/generate-identity.sh`
           */
          const opts = {
            app: path.join(dir, 'Electron.app'),
            identity: 'codesign.electronjs.org (T123456)',
          }; // test with no other options for self discovery
          await expect(sign(opts)).resolves.not.toThrow();
        });

        it('signs same-depth nested code before the main executable seals the bundle', async () => {
          const app = path.join(dir, 'Electron.app');
          // A flat helper directly under Contents/Helpers/ is nested code at the same depth
          // as Contents/MacOS/Electron. Give it different signing arguments so that, under
          // batchCodesignCalls, it lands in a different codesign batch from the main
          // executable. Signing the main executable seals the bundle, so if its batch runs
          // first codesign fails with "code object is not signed at all" for the helper.
          const helpersDir = path.join(app, 'Contents', 'Helpers');
          await fs.promises.mkdir(helpersDir, { recursive: true });
          await fs.promises.copyFile(
            path.join(app, 'Contents', 'MacOS', 'Electron'),
            path.join(helpersDir, 'helper'),
          );

          const opts = {
            app,
            identity: 'codesign.electronjs.org (T123456)',
            batchCodesignCalls: true,
            optionsForFile: (filePath: string) =>
              filePath.startsWith(helpersDir + path.sep) ? { hardenedRuntime: false } : {},
          };
          await expect(sign(opts)).resolves.not.toThrow();
        });
      });
    });
  });
  afterAll(async () => {
    await fs.promises.rm(WORK_CWD, { recursive: true, force: true });
  });
});
