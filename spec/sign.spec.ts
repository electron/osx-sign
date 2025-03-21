import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import extract from 'extract-zip';

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
      });
    });
  });
  afterAll(async () => {
    await fs.promises.rm(WORK_CWD, { recursive: true, force: true });
  });
});
