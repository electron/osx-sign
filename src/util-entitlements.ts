import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as plist from 'plist';
import { PerFileSignOptions, ValidatedSignOptions } from './types';
import { debugLog, getAppContentsPath } from './util';
import { Identity } from './util-identities';
import { ProvisioningProfile } from './util-provisioning-profiles';

type ComputedOptions = {
  identity: Identity;
  provisioningProfile?: ProvisioningProfile;
};

const preAuthMemo = new Map<string, string>();

/**
 * This function returns a promise completing the entitlements automation: The
 * process includes checking in `Info.plist` for `ElectronTeamID` or setting
 * parsed value from identity, and checking in entitlements file for
 * `com.apple.security.application-groups` or inserting new into array. A
 * temporary entitlements file may be created to replace the input for any
 * changes introduced.
 */
export async function preAutoEntitlements (
  opts: ValidatedSignOptions,
  perFileOpts: PerFileSignOptions,
  computed: ComputedOptions
): Promise<void | string> {
  if (!perFileOpts.entitlements) return;

  const memoKey = [opts.app, perFileOpts.entitlements].join('---');
  if (preAuthMemo.has(memoKey)) return preAuthMemo.get(memoKey);

  // If entitlements file not provided, default will be used. Fixes #41
  const appInfoPath = path.join(getAppContentsPath(opts), 'Info.plist');

  debugLog(
    'Automating entitlement app group...',
    '\n',
    '> Info.plist:',
    appInfoPath,
    '\n'
  );
  let entitlements: Record<string, any>;
  if (typeof perFileOpts.entitlements === 'string') {
    const entitlementsContents = await fs.readFile(perFileOpts.entitlements, 'utf8');
    entitlements = plist.parse(entitlementsContents) as Record<string, any>;
  } else {
    entitlements = perFileOpts.entitlements.reduce<Record<string, any>>((dict, entitlementKey) => ({
      ...dict,
      [entitlementKey]: true
    }), {});
  }
  if (!entitlements['com.apple.security.app-sandbox']) {
    // Only automate when app sandbox enabled by user
    return;
  }

  const appInfoContents = await fs.readFile(appInfoPath, 'utf8');
  const appInfo = plist.parse(appInfoContents) as Record<string, any>;
  // Use ElectronTeamID in Info.plist if already specified
  if (appInfo.ElectronTeamID) {
    debugLog('`ElectronTeamID` found in `Info.plist`: ' + appInfo.ElectronTeamID);
  } else {
    // The team identifier in signing identity should not be trusted
    if (computed.provisioningProfile) {
      appInfo.ElectronTeamID =
        computed.provisioningProfile.message.Entitlements['com.apple.developer.team-identifier'];
      debugLog(
        '`ElectronTeamID` not found in `Info.plist`, use parsed from provisioning profile: ' +
          appInfo.ElectronTeamID
      );
    } else {
      appInfo.ElectronTeamID = computed.identity.name.substring(
        computed.identity.name.indexOf('(') + 1,
        computed.identity.name.lastIndexOf(')')
      );
      debugLog(
        '`ElectronTeamID` not found in `Info.plist`, use parsed from signing identity: ' +
          appInfo.ElectronTeamID
      );
    }
    await fs.writeFile(appInfoPath, plist.build(appInfo), 'utf8');

    debugLog('`Info.plist` updated:', '\n', '> Info.plist:', appInfoPath);
  }

  const appIdentifier = appInfo.ElectronTeamID + '.' + appInfo.CFBundleIdentifier;
  // Insert application identifier if not exists
  if (entitlements['com.apple.application-identifier']) {
    debugLog(
      '`com.apple.application-identifier` found in entitlements file: ' +
        entitlements['com.apple.application-identifier']
    );
  } else {
    debugLog(
      '`com.apple.application-identifier` not found in entitlements file, new inserted: ' +
        appIdentifier
    );
    entitlements['com.apple.application-identifier'] = appIdentifier;
  }
  // Insert developer team identifier if not exists
  if (entitlements['com.apple.developer.team-identifier']) {
    debugLog(
      '`com.apple.developer.team-identifier` found in entitlements file: ' +
        entitlements['com.apple.developer.team-identifier']
    );
  } else {
    debugLog(
      '`com.apple.developer.team-identifier` not found in entitlements file, new inserted: ' +
        appInfo.ElectronTeamID
    );
    entitlements['com.apple.developer.team-identifier'] = appInfo.ElectronTeamID;
  }
  // Init entitlements app group key to array if not exists
  if (!entitlements['com.apple.security.application-groups']) {
    entitlements['com.apple.security.application-groups'] = [];
  }
  // Insert app group if not exists
  if (
    Array.isArray(entitlements['com.apple.security.application-groups']) &&
    entitlements['com.apple.security.application-groups'].indexOf(appIdentifier) === -1
  ) {
    debugLog(
      '`com.apple.security.application-groups` not found in entitlements file, new inserted: ' +
        appIdentifier
    );
    entitlements['com.apple.security.application-groups'].push(appIdentifier);
  } else {
    debugLog(
      '`com.apple.security.application-groups` found in entitlements file: ' + appIdentifier
    );
  }
  // Create temporary entitlements file
  const dir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'tmp-entitlements-'));
  const entitlementsPath = path.join(dir, 'entitlements.plist');
  await fs.writeFile(entitlementsPath, plist.build(entitlements), 'utf8');
  debugLog('Entitlements file updated:', '\n', '> Entitlements:', entitlementsPath);

  preAuthMemo.set(memoKey, entitlementsPath);
  return entitlementsPath;
}
