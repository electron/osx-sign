import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';

import type { PerFileSignOptions, ValidatedSignOptions } from './types.js';
import { debugLog, getAppContentsPath } from './util.js';
import type { Identity } from './util-identities.js';
import type { ProvisioningProfile } from './util-provisioning-profiles.js';

type ComputedOptions = {
  identity: Identity;
  provisioningProfile?: ProvisioningProfile;
};

const preAuthMemo = new Map<string, string>();

/**
 * This function returns a promise completing the entitlements automation: The
 * process includes checking in `Info.plist` for `ElectronTeamID` or setting
 * parsed value from the provisioning profile or identity, and filling in the
 * `com.apple.application-identifier` and `com.apple.developer.team-identifier`
 * entitlements. Sandboxed apps additionally get their app group added to
 * `com.apple.security.application-groups`. Runs for apps that enable the
 * sandbox or supply a provisioning profile; a temporary entitlements file may
 * be created to replace the input for any changes introduced.
 */
export async function preAutoEntitlements(
  opts: ValidatedSignOptions,
  perFileOpts: PerFileSignOptions,
  computed: ComputedOptions,
): Promise<void | string> {
  if (!perFileOpts.entitlements) return;

  const memoKey = [
    opts.app,
    perFileOpts.entitlements,
    computed.provisioningProfile ? 'profile' : 'no-profile',
  ].join('---');
  if (preAuthMemo.has(memoKey)) return preAuthMemo.get(memoKey);

  // If entitlements file not provided, default will be used. Fixes #41
  const appInfoPath = path.join(getAppContentsPath(opts), 'Info.plist');

  debugLog('Automating entitlement app group...', '\n', '> Info.plist:', appInfoPath, '\n');
  let entitlements: Record<string, any>;
  if (typeof perFileOpts.entitlements === 'string') {
    const entitlementsContents = await fs.promises.readFile(perFileOpts.entitlements, 'utf8');
    entitlements = plist.parse(entitlementsContents) as Record<string, any>;
  } else {
    entitlements = perFileOpts.entitlements.reduce<Record<string, any>>(
      (dict, entitlementKey) => ({
        ...dict,
        [entitlementKey]: true,
      }),
      {},
    );
  }
  const sandboxed = Boolean(entitlements['com.apple.security.app-sandbox']);
  if (!sandboxed && !computed.provisioningProfile) {
    // Nothing to automate: application-groups is a sandbox capability, and the
    // application/team identifier entitlements only matter once a provisioning
    // profile is in play (a plain Developer ID app doesn't need them).
    return;
  }
  if (!sandboxed) {
    // A provisioning profile only grants its restricted entitlements to code that
    // also carries matching com.apple.application-identifier and
    // com.apple.developer.team-identifier entitlements, so a Developer ID app that
    // embeds a profile needs those injected just like a sandboxed app does.
    debugLog(
      'Provisioning profile supplied, automating identifier entitlements for a non-sandboxed app',
    );
  }

  const appInfoContents = await fs.promises.readFile(appInfoPath, 'utf8');
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
          appInfo.ElectronTeamID,
      );
    } else {
      const teamID = /^.+\((.+?)\)$/g.exec(computed.identity.name)?.[1];
      if (!teamID) {
        throw new Error(
          `Could not automatically determine ElectronTeamID from identity: ${computed.identity.name}`,
        );
      }
      appInfo.ElectronTeamID = teamID;
      debugLog(
        '`ElectronTeamID` not found in `Info.plist`, use parsed from signing identity: ' +
          appInfo.ElectronTeamID,
      );
    }
    await fs.promises.writeFile(appInfoPath, plist.build(appInfo), 'utf8');

    debugLog('`Info.plist` updated:', '\n', '> Info.plist:', appInfoPath);
  }

  const appIdentifier = appInfo.ElectronTeamID + '.' + appInfo.CFBundleIdentifier;
  // Insert application identifier if not exists
  if (entitlements['com.apple.application-identifier']) {
    debugLog(
      '`com.apple.application-identifier` found in entitlements file: ' +
        entitlements['com.apple.application-identifier'],
    );
  } else {
    debugLog(
      '`com.apple.application-identifier` not found in entitlements file, new inserted: ' +
        appIdentifier,
    );
    entitlements['com.apple.application-identifier'] = appIdentifier;
  }
  // Insert developer team identifier if not exists
  if (entitlements['com.apple.developer.team-identifier']) {
    debugLog(
      '`com.apple.developer.team-identifier` found in entitlements file: ' +
        entitlements['com.apple.developer.team-identifier'],
    );
  } else {
    debugLog(
      '`com.apple.developer.team-identifier` not found in entitlements file, new inserted: ' +
        appInfo.ElectronTeamID,
    );
    entitlements['com.apple.developer.team-identifier'] = appInfo.ElectronTeamID;
  }
  // The app group is what the sandbox automation exists to set up. A non-sandboxed
  // app is only here for the identifiers above, so leave its groups alone.
  if (sandboxed) {
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
          appIdentifier,
      );
      entitlements['com.apple.security.application-groups'].push(appIdentifier);
    } else {
      debugLog(
        '`com.apple.security.application-groups` found in entitlements file: ' + appIdentifier,
      );
    }
  }
  // Create temporary entitlements file
  const dir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'tmp-entitlements-'));
  const entitlementsPath = path.join(dir, 'entitlements.plist');
  await fs.promises.writeFile(entitlementsPath, plist.build(entitlements), 'utf8');
  debugLog('Entitlements file updated:', '\n', '> Entitlements:', entitlementsPath);

  preAuthMemo.set(memoKey, entitlementsPath);
  return entitlementsPath;
}
