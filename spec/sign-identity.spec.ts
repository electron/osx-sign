import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { sign } from '../src/sign.js';
import { execFileAsync } from '../src/util.js';
import { Identity, resolveUnvalidatedIdentity } from '../src/util-identities.js';

vi.mock('../src/util.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/util.js')>()),
  execFileAsync: vi.fn(),
}));

const NAME = 'Developer ID Application: Example Corp (IDENTTEAM)';
const HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const OTHER_HASH = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';

function findIdentityOutput(...identities: [hash: string, name: string][]) {
  return [
    ...identities.map(([hash, name], i) => `  ${i + 1}) ${hash} "${name}"`),
    `     ${identities.length} valid identities found`,
  ].join('\n');
}

const execFileMock = vi.mocked(execFileAsync);

function mockSecurity(output: string | Error) {
  execFileMock.mockImplementation(async (file) => {
    if (file === 'security') {
      if (output instanceof Error) throw output;
      return output;
    }
    return '';
  });
}

function securityCalls() {
  return execFileMock.mock.calls.filter(([file]) => file === 'security');
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('resolveUnvalidatedIdentity', () => {
  it('resolves a hash to its name and hash', async () => {
    mockSecurity(
      findIdentityOutput([OTHER_HASH, 'Apple Development: Someone (OTHERTEAM)'], [HASH, NAME]),
    );
    await expect(resolveUnvalidatedIdentity(null, HASH)).resolves.toEqual(new Identity(NAME, HASH));
    expect(securityCalls()).toEqual([['security', ['find-identity', '-v']]]);
  });

  it('matches a lowercase hash and searches the given keychain', async () => {
    mockSecurity(findIdentityOutput([HASH, NAME]));
    await expect(
      resolveUnvalidatedIdentity('/tmp/ci.keychain', HASH.toLowerCase()),
    ).resolves.toEqual(new Identity(NAME, HASH));
    expect(securityCalls()).toEqual([['security', ['find-identity', '-v', '/tmp/ci.keychain']]]);
  });

  it('accepts the same certificate listed more than once', async () => {
    mockSecurity(findIdentityOutput([HASH, NAME], [HASH, NAME]));
    await expect(resolveUnvalidatedIdentity(null, HASH)).resolves.toEqual(new Identity(NAME, HASH));
  });

  it('falls back to the raw hash when no certificate matches', async () => {
    mockSecurity(findIdentityOutput([OTHER_HASH, NAME]));
    await expect(resolveUnvalidatedIdentity(null, HASH)).resolves.toEqual(new Identity(HASH));
  });

  it('falls back to the raw hash when the lookup fails', async () => {
    mockSecurity(new Error('security: SecKeychainSearchCopyNext failed'));
    await expect(resolveUnvalidatedIdentity(null, HASH)).resolves.toEqual(new Identity(HASH));
  });

  it('uses a name as-is without looking it up', async () => {
    mockSecurity(findIdentityOutput([HASH, NAME]));
    await expect(resolveUnvalidatedIdentity(null, NAME)).resolves.toEqual(new Identity(NAME));
    expect(securityCalls()).toEqual([]);
  });
});

describe('sign with identityValidation: false', () => {
  let tmp: string;
  let counter = 0;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osx-sign-identity-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * An app with no binaries in it, so the only thing signed is the bundle itself. Each gets
   * its own path because preAutoEntitlements memoizes on it.
   */
  function fixtureApp() {
    const app = path.join(tmp, `case-${counter++}`, 'Fixture.app');
    const infoPlistPath = path.join(app, 'Contents', 'Info.plist');
    fs.mkdirSync(path.dirname(infoPlistPath), { recursive: true });
    fs.writeFileSync(infoPlistPath, plist.build({ CFBundleIdentifier: 'com.example.fixture' }));
    return { app, infoPlistPath };
  }

  function signCall(app: string) {
    const call = execFileMock.mock.calls.find(
      ([file, args]) => file === 'codesign' && args.includes('--sign') && args.at(-1) === app,
    );
    expect(call).toBeDefined();
    return call![1];
  }

  // The mas platform's default entitlements are sandboxed, which is what makes
  // preAutoEntitlements need a team ID.
  const baseOpts = {
    platform: 'mas',
    identityValidation: false,
    preEmbedProvisioningProfile: false,
  } as const;

  it('signs with the hash and takes the team ID from the resolved name', async () => {
    const { app, infoPlistPath } = fixtureApp();
    mockSecurity(findIdentityOutput([HASH, NAME]));
    await sign({ ...baseOpts, app, identity: HASH });

    const args = signCall(app);
    expect(args[args.indexOf('--sign') + 1]).toBe(HASH);
    expect(plist.parse(fs.readFileSync(infoPlistPath, 'utf8'))).toMatchObject({
      ElectronTeamID: 'IDENTTEAM',
    });
    const entitlements = plist.parse(
      fs.readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8'),
    );
    expect(entitlements).toMatchObject({
      'com.apple.developer.team-identifier': 'IDENTTEAM',
      'com.apple.application-identifier': 'IDENTTEAM.com.example.fixture',
    });
  });

  it('still signs with an unknown hash when the team ID is not needed', async () => {
    const { app } = fixtureApp();
    mockSecurity(findIdentityOutput());
    await sign({ ...baseOpts, app, identity: HASH, preAutoEntitlements: false });

    const args = signCall(app);
    expect(args[args.indexOf('--sign') + 1]).toBe(HASH);
  });

  it('keeps reporting the missing team ID when the hash cannot be resolved', async () => {
    const { app } = fixtureApp();
    mockSecurity(new Error('security failed'));
    await expect(sign({ ...baseOpts, app, identity: HASH })).rejects.toThrow(
      `Could not automatically determine ElectronTeamID from identity: ${HASH}`,
    );
  });

  it('signs with a name as given', async () => {
    const { app } = fixtureApp();
    mockSecurity(findIdentityOutput([HASH, NAME]));
    await sign({ ...baseOpts, app, identity: NAME });

    const args = signCall(app);
    expect(args[args.indexOf('--sign') + 1]).toBe(NAME);
    expect(securityCalls()).toEqual([]);
  });
});
