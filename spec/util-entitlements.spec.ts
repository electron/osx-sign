import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { preAutoEntitlements } from '../src/util-entitlements.js';
import { Identity } from '../src/util-identities.js';
import { ProvisioningProfile } from '../src/util-provisioning-profiles.js';
import type { ValidatedSignOptions } from '../src/types.js';

const IDENTITY = new Identity('Developer ID Application: Example Corp (IDENTTEAM)');
const PROFILE = new ProvisioningProfile('/dev/null/example.provisionprofile', {
  Name: 'Example',
  Entitlements: { 'com.apple.developer.team-identifier': 'PROFTEAM00' },
});

let tmp: string;
let counter = 0;

/**
 * Every fixture gets its own app + entitlements path because preAutoEntitlements
 * memoizes on them for the lifetime of the process.
 */
function fixture(entitlements: Record<string, unknown>): {
  opts: ValidatedSignOptions;
  entitlementsPath: string;
  infoPlistPath: string;
} {
  const dir = path.join(tmp, `case-${counter++}`);
  const app = path.join(dir, 'Fixture.app');
  const infoPlistPath = path.join(app, 'Contents', 'Info.plist');
  fs.mkdirSync(path.dirname(infoPlistPath), { recursive: true });
  fs.writeFileSync(infoPlistPath, plist.build({ CFBundleIdentifier: 'com.example.fixture' }));
  const entitlementsPath = path.join(dir, 'entitlements.plist');
  fs.writeFileSync(entitlementsPath, plist.build(entitlements));
  return {
    opts: { app, platform: 'darwin', type: 'distribution' },
    entitlementsPath,
    infoPlistPath,
  };
}

function readPlist(file: string): Record<string, any> {
  return plist.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
}

describe('preAutoEntitlements', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osx-sign-entitlements-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does nothing for a non-sandboxed app without a provisioning profile', async () => {
    const { opts, entitlementsPath, infoPlistPath } = fixture({
      'com.apple.security.cs.allow-jit': true,
    });
    const before = fs.readFileSync(infoPlistPath, 'utf8');
    await expect(
      preAutoEntitlements(opts, { entitlements: entitlementsPath }, { identity: IDENTITY }),
    ).resolves.toBeUndefined();
    expect(fs.readFileSync(infoPlistPath, 'utf8')).toBe(before);
  });

  it('injects the identifier entitlements for a non-sandboxed app with a provisioning profile', async () => {
    const { opts, entitlementsPath, infoPlistPath } = fixture({
      'com.apple.security.cs.allow-jit': true,
      'keychain-access-groups': ['PROFTEAM00.com.example.shared'],
    });
    const result = await preAutoEntitlements(
      opts,
      { entitlements: entitlementsPath },
      { identity: IDENTITY, provisioningProfile: PROFILE },
    );
    expect(result).toBeTypeOf('string');
    const entitlements = readPlist(result as string);
    expect(entitlements).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'keychain-access-groups': ['PROFTEAM00.com.example.shared'],
      'com.apple.application-identifier': 'PROFTEAM00.com.example.fixture',
      'com.apple.developer.team-identifier': 'PROFTEAM00',
    });
    // Specifically: no app group, that is a sandbox thing.
    expect(entitlements).not.toHaveProperty('com.apple.security.application-groups');
    // The team comes from the profile, not the identity.
    expect(readPlist(infoPlistPath).ElectronTeamID).toBe('PROFTEAM00');
  });

  it('keeps identifier entitlements the caller already wrote', async () => {
    const { opts, entitlementsPath } = fixture({
      'com.apple.application-identifier': 'PROFTEAM00.com.example.custom',
      'com.apple.developer.team-identifier': 'PROFTEAM00',
    });
    const result = await preAutoEntitlements(
      opts,
      { entitlements: entitlementsPath },
      { identity: IDENTITY, provisioningProfile: PROFILE },
    );
    expect(readPlist(result as string)).toEqual({
      'com.apple.application-identifier': 'PROFTEAM00.com.example.custom',
      'com.apple.developer.team-identifier': 'PROFTEAM00',
    });
  });

  it('still sets up the app group for a sandboxed app', async () => {
    const { opts, entitlementsPath, infoPlistPath } = fixture({
      'com.apple.security.app-sandbox': true,
    });
    const result = await preAutoEntitlements(
      opts,
      { entitlements: entitlementsPath },
      { identity: IDENTITY },
    );
    expect(readPlist(result as string)).toEqual({
      'com.apple.security.app-sandbox': true,
      'com.apple.application-identifier': 'IDENTTEAM.com.example.fixture',
      'com.apple.developer.team-identifier': 'IDENTTEAM',
      'com.apple.security.application-groups': ['IDENTTEAM.com.example.fixture'],
    });
    expect(readPlist(infoPlistPath).ElectronTeamID).toBe('IDENTTEAM');
  });

  it('does not reuse a profile run for a later run without one', async () => {
    const { opts, entitlementsPath } = fixture({});
    const withProfile = await preAutoEntitlements(
      opts,
      { entitlements: entitlementsPath },
      { identity: IDENTITY, provisioningProfile: PROFILE },
    );
    expect(withProfile).toBeTypeOf('string');
    await expect(
      preAutoEntitlements(opts, { entitlements: entitlementsPath }, { identity: IDENTITY }),
    ).resolves.toBeUndefined();
  });
});
