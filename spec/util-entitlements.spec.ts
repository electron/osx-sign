import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureAppSandboxEntitlement } from '../src/util-entitlements.js';

async function writeEntitlements(entitlements: Record<string, unknown>): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'osx-sign-spec-'));
  const entitlementsPath = path.join(dir, 'entitlements.plist');
  await fs.promises.writeFile(entitlementsPath, plist.build(entitlements), 'utf8');
  return entitlementsPath;
}

describe('ensureAppSandboxEntitlement', () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(
      created
        .splice(0)
        .map((entitlementsPath) =>
          fs.promises.rm(path.dirname(entitlementsPath), { recursive: true, force: true }),
        ),
    );
  });

  it('throws when the app-sandbox entitlement is missing', async () => {
    const entitlementsPath = await writeEntitlements({
      'com.apple.security.network.client': true,
    });
    created.push(entitlementsPath);
    await expect(ensureAppSandboxEntitlement(entitlementsPath)).rejects.toThrow(
      /com\.apple\.security\.app-sandbox/,
    );
  });

  it('throws when the app-sandbox entitlement is disabled', async () => {
    const entitlementsPath = await writeEntitlements({
      'com.apple.security.app-sandbox': false,
    });
    created.push(entitlementsPath);
    await expect(ensureAppSandboxEntitlement(entitlementsPath)).rejects.toThrow(
      /com\.apple\.security\.app-sandbox/,
    );
  });

  it('resolves when the app-sandbox entitlement is enabled', async () => {
    const entitlementsPath = await writeEntitlements({
      'com.apple.security.app-sandbox': true,
    });
    created.push(entitlementsPath);
    await expect(ensureAppSandboxEntitlement(entitlementsPath)).resolves.toBeUndefined();
  });
});
