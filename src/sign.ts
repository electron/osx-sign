import * as os from 'os';
import * as path from 'path';
import compareVersion from 'compare-version';

import {
  debugLog,
  debugWarn,
  getAppContentsPath,
  execFileAsync,
  validateOptsApp,
  validateOptsPlatform,
  walkAsync
} from './util';
import { Identity, findIdentities } from './util-identities';
import {
  preEmbedProvisioningProfile,
  getProvisioningProfile
} from './util-provisioning-profiles';
import { preAutoEntitlements } from './util-entitlements';
import { ElectronMacPlatform, SignOptions, ValidatedSignOptions } from './types';

const pkgVersion: string = require('../../package.json').version;

const osRelease = os.release();

/**
 * This function returns a promise validating opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 */
async function validateOptsBinaries (opts: SignOptions) {
  if (opts.binaries) {
    if (!Array.isArray(opts.binaries)) {
      throw new Error('Additional binaries should be an Array.');
    }
    // TODO: Presence check for binary files, reject if any does not exist
  }
}

function validateOptsIgnore (ignore: SignOptions['ignore']): ValidatedSignOptions['ignore'] {
  if (ignore && !(ignore instanceof Array)) {
    return [ignore];
  }
}

function validateOptsEntitlements (opts: SignOptions, platform: ElectronMacPlatform) {
  const entitlementOptions = {
    entitlements: opts.entitlements,
    'entitlements-inherit': opts['entitlements-inherit']
  };

  const entitlementsFolder = path.resolve(__dirname, '..', 'entitlements');

  if (platform === 'mas') {
    // To sign apps for Mac App Store, an entitlements file is required, especially for app sandboxing (as well some other services).
    // Fallback entitlements for sandboxing by default: Note this may cause troubles while running an signed app due to missing keys special to the project.
    // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
    if (!entitlementOptions.entitlements) {
      const entitlementsPath = path.resolve(entitlementsFolder, 'default.entitlements.mas.plist');
      debugWarn(
        'No `entitlements` passed in arguments:',
        '\n',
        '* Sandbox entitlements are required for Mac App Store distribution, your codesign entitlements file is default to:',
        entitlementsPath
      );
      entitlementOptions.entitlements = entitlementsPath;
    }
    if (!entitlementOptions['entitlements-inherit']) {
      const entitlementsPath = path.join(
        entitlementsFolder,
        'default.entitlements.mas.inherit.plist'
      );
      debugWarn(
        'No `entitlements-inherit` passed in arguments:',
        '\n',
        '* Sandbox entitlements file for enclosed app files is default to:',
        entitlementsPath
      );
      entitlementOptions['entitlements-inherit'] = entitlementsPath;
    }
  } else {
    // Not necessary to have entitlements for non Mac App Store distribution
    if (!opts.entitlements) {
      debugWarn(
        'No `entitlements` passed in arguments:',
        '\n',
        '* Provide `entitlements` to specify entitlements file for codesign.'
      );
    } else {
      // If entitlements is provided as a boolean flag, fallback to default
      if ((entitlementOptions.entitlements as any) === true) {
        const entitlementsPath = path.join(entitlementsFolder, 'default.entitlements.darwin.plist');
        debugWarn(
          '`entitlements` not specified in arguments:',
          '\n',
          '* Provide `entitlements` to specify entitlements file for codesign.',
          '\n',
          '* Entitlements file is default to:',
          entitlementsPath
        );
        entitlementOptions.entitlements = entitlementsPath;
      }
      if (!opts['entitlements-inherit']) {
        const entitlementsPath = path.join(
          entitlementsFolder,
          'default.entitlements.darwin.inherit.plist'
        );
        debugWarn(
          'No `entitlements-inherit` passed in arguments:',
          '\n',
          '* Entitlements file for enclosed app files is default to:',
          entitlementsPath
        );
        entitlementOptions['entitlements-inherit'] = entitlementsPath;
      }
    }
  }

  return entitlementOptions as {
    entitlements: string;
    'entitlements-inherit': string;
  };
}

/**
 * This function returns a promise validating all options passed in opts.
 */
async function validateSignOpts (opts: SignOptions): Promise<Readonly<ValidatedSignOptions>> {
  await validateOptsBinaries(opts);
  await validateOptsApp(opts);

  if (opts['provisioning-profile'] && typeof opts['provisioning-profile'] !== 'string') {
    throw new Error('Path to provisioning profile should be a string.');
  }

  if (opts.type && opts.type !== 'development' && opts.type !== 'distribution') {
    throw new Error('Type must be either `development` or `distribution`.');
  }

  const platform = await validateOptsPlatform(opts);
  const cloned: ValidatedSignOptions = {
    ...opts,
    ...validateOptsEntitlements(opts, platform),
    ignore: validateOptsIgnore(opts.ignore),
    type: opts.type || 'distribution',
    platform
  };
  return cloned;
}

/**
 * This function returns a promise verifying the code sign of application bundle.
 */
async function verifySignApplication (opts: ValidatedSignOptions) {
  // Verify with codesign
  debugLog('Verifying application bundle with codesign...');

  await execFileAsync(
    'codesign',
    ['--verify', '--deep'].concat(
      opts['strict-verify'] !== false && compareVersion(osRelease, '15.0.0') >= 0 // Strict flag since darwin 15.0.0 --> OS X 10.11.0 El Capitan
        ? [
            '--strict' +
              (opts['strict-verify']
                ? '=' + opts['strict-verify'] // Array should be converted to a comma separated string
                : '')
          ]
        : [],
      ['--verbose=2', opts.app]
    )
  );

  // Additionally test Gatekeeper acceptance for darwin platform
  if (opts.platform === 'darwin' && opts['gatekeeper-assess'] !== false) {
    debugLog('Verifying Gatekeeper acceptance for darwin platform...');
    await execFileAsync('spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose',
      '--ignore-cache',
      '--no-cache',
      opts.app
    ]);
  }
}

/**
 * This function returns a promise codesigning only.
 */
async function signApplication (opts: ValidatedSignOptions, identity: Identity) {
  function shouldIgnoreFilePath (filePath: string) {
    if (opts.ignore) {
      return opts.ignore.some(function (ignore) {
        if (typeof ignore === 'function') {
          return ignore(filePath);
        }
        return filePath.match(ignore);
      });
    }
    return false;
  }

  const children = await walkAsync(getAppContentsPath(opts));

  if (opts.binaries) children.push(...opts.binaries);

  const args = ['--sign', identity.hash || identity.name, '--force'];
  if (opts.keychain) {
    args.push('--keychain', opts.keychain);
  }
  if (opts.requirements) {
    args.push('--requirements', opts.requirements);
  }
  if (opts.timestamp) {
    args.push('--timestamp=' + opts.timestamp);
  } else {
    args.push('--timestamp');
  }
  if (opts['signature-size']) {
    if (Number.isInteger(opts['signature-size']) && opts['signature-size'] > 0) {
      args.push('--signature-size', `${opts['signature-size']}`);
    } else {
      debugWarn(
        `Invalid value provided for --signature-size (${opts['signature-size']}). Must be a positive integer.`
      );
    }
  }

  /**
   * Sort the child paths by how deep they are in the file tree.  Some arcane apple
   * logic expects the deeper files to be signed first otherwise strange errors get
   * thrown our way
   */
  children.sort((a, b) => {
    const aDepth = a.split(path.sep).length;
    const bDepth = b.split(path.sep).length;
    return bDepth - aDepth;
  });
  if (opts.entitlements) {
    // Sign with entitlements
    // promise = Promise.mapSeries(childPaths, function (filePath) {
    for (const filePath of children) {
      if (shouldIgnoreFilePath(filePath)) {
        debugLog('Skipped... ' + filePath);
        continue;
      }

      debugLog('Signing... ' + filePath);

      let optionsArguments: string[] = [];

      if (opts['signature-flags']) {
        if (Array.isArray(opts['signature-flags'])) {
          optionsArguments.push(...opts['signature-flags']);
        } else if (typeof opts['signature-flags'] === 'function') {
          const flags = opts['signature-flags'](filePath);
          optionsArguments.push(...flags);
        } else {
          const flags = opts['signature-flags'].split(',').map(function (flag) {
            return flag.trim();
          });
          optionsArguments.push(...flags);
        }
      }

      if (
        opts.hardenedRuntime ||
        opts['hardened-runtime'] ||
        optionsArguments.includes('runtime')
      ) {
        // Hardened runtime since darwin 17.7.0 --> macOS 10.13.6
        if (compareVersion(osRelease, '17.7.0') >= 0) {
          optionsArguments.push('runtime');
        } else {
          // Remove runtime if passed in with --signature-flags
          debugLog(
            'Not enabling hardened runtime, current macOS version too low, requires 10.13.6 and higher'
          );
          optionsArguments = optionsArguments.filter((arg) => {
            return arg !== 'runtime';
          });
        }
      }

      if (opts.restrict) {
        optionsArguments.push('restrict');
        debugWarn(
          'This flag is to be deprecated, consider using --signature-flags=restrict instead'
        );
      }

      if (optionsArguments.length) {
        args.push('--options', [...new Set(optionsArguments)].join(','));
      }

      let entitlementsFile = opts['entitlements-inherit'];
      if (filePath.includes('Library/LoginItems')) {
        entitlementsFile = opts['entitlements-loginhelper']!;
      }

      const clonedArgs = args.concat([]);
      if (opts.entitlementsForFile) {
        entitlementsFile = opts.entitlementsForFile(filePath, clonedArgs) || entitlementsFile;
      }

      await execFileAsync(
        'codesign',
        clonedArgs.concat('--entitlements', entitlementsFile, filePath)
      );
    }

    // Sign the actual app now
    debugLog('Signing... ' + opts.app);

    const clonedArgs = args.concat([]);
    let entitlementsFile = opts.entitlements;
    if (opts.entitlementsForFile) {
      entitlementsFile = opts.entitlementsForFile(opts.app, clonedArgs) || entitlementsFile;
    }

    await execFileAsync(
      'codesign',
      clonedArgs.concat('--entitlements', entitlementsFile, opts.app)
    );
  } else {
    // Otherwise normally
    for (const filePath of children) {
      if (shouldIgnoreFilePath(filePath)) {
        debugLog('Skipped... ' + filePath);
        continue;
      }

      await execFileAsync('codesign', args.concat(filePath));
    }

    debugLog('Signing... ' + opts.app);
    await execFileAsync('codesign', args.concat(opts.app));
  }

  // Verify code sign
  debugLog('Verifying...');
  await verifySignApplication(opts);
  debugLog('Verified.');

  // Check entitlements if applicable
  if (opts.entitlements) {
    debugLog('Displaying entitlements...');
    const result = await execFileAsync('codesign', [
      '--display',
      '--entitlements',
      ':-', // Write to standard output and strip off the blob header
      opts.app
    ]);

    debugLog('Entitlements:', '\n', result);
  }
}

/**
 * This function returns a promise signing the application.
 */
export async function signApp (_opts: SignOptions) {
  debugLog('electron-osx-sign@%s', pkgVersion);
  let validatedOpts = await validateSignOpts(_opts);
  let identities: Identity[] = [];
  let identityInUse: Identity | null = null;

  // Determine identity for signing
  if (validatedOpts.identity) {
    debugLog('`identity` passed in arguments.');
    if (validatedOpts['identity-validation'] === false) {
      identityInUse = new Identity(validatedOpts.identity);
    } else {
      identities = await findIdentities(validatedOpts.keychain || null, validatedOpts.identity);
    }
  } else {
    debugWarn('No `identity` passed in arguments...');
    if (validatedOpts.platform === 'mas') {
      if (validatedOpts.type === 'distribution') {
        debugLog(
          'Finding `3rd Party Mac Developer Application` certificate for signing app distribution in the Mac App Store...'
        );
        identities = await findIdentities(
          validatedOpts.keychain || null,
          '3rd Party Mac Developer Application:'
        );
      } else {
        debugLog(
          'Finding `Mac Developer` certificate for signing app in development for the Mac App Store signing...'
        );
        identities = await findIdentities(validatedOpts.keychain || null, 'Mac Developer:');
      }
    } else {
      debugLog(
        'Finding `Developer ID Application` certificate for distribution outside the Mac App Store...'
      );
      identities = await findIdentities(
        validatedOpts.keychain || null,
        'Developer ID Application:'
      );
    }
  }

  if (!identityInUse) {
    if (identities.length > 0) {
      // Identity(/ies) found
      if (identities.length > 1) {
        debugWarn('Multiple identities found, will use the first discovered.');
      } else {
        debugLog('Found 1 identity.');
      }
      identityInUse = identities[0];
    } else {
      // No identity found
      throw new Error('No identity found for signing.');
    }
  }

  // Pre-sign operations
  if (validatedOpts['pre-embed-provisioning-profile'] === false) {
    debugWarn(
      'Pre-sign operation disabled for provisioning profile embedding:',
      '\n',
      '* Enable by setting `pre-embed-provisioning-profile` to `true`.'
    );
  } else {
    debugLog(
      'Pre-sign operation enabled for provisioning profile:',
      '\n',
      '* Disable by setting `pre-embed-provisioning-profile` to `false`.'
    );
    await preEmbedProvisioningProfile(
      validatedOpts,
      validatedOpts['provisioning-profile']
        ? await getProvisioningProfile(
          validatedOpts['provisioning-profile'],
          validatedOpts.keychain
        )
        : null
    );
  }

  if (validatedOpts['pre-auto-entitlements'] === false) {
    debugWarn('Pre-sign operation disabled for entitlements automation.');
  } else {
    debugLog(
      'Pre-sign operation enabled for entitlements automation with versions >= `1.1.1`:',
      '\n',
      '* Disable by setting `pre-auto-entitlements` to `false`.'
    );
    if (
      validatedOpts.entitlements &&
      (!validatedOpts.version || compareVersion(validatedOpts.version, '1.1.1') >= 0)
    ) {
      // Enable Mac App Store sandboxing without using temporary-exception, introduced in Electron v1.1.1. Relates to electron#5601
      const newEntitlements = await preAutoEntitlements(validatedOpts, {
        identity: identityInUse,
        provisioningProfile: validatedOpts['provisioning-profile']
          ? await getProvisioningProfile(
            validatedOpts['provisioning-profile'],
            validatedOpts.keychain
          )
          : undefined
      });

      // preAutoEntitlements may provide us new entitlements, if so we update our options
      // and ensure that entitlements-loginhelper has a correct default value
      if (newEntitlements) {
        validatedOpts = {
          ...validatedOpts,
          entitlements: newEntitlements,
          'entitlements-loginhelper': validatedOpts['entitlements-loginhelper'] || newEntitlements
        };
      }
    }
  }

  debugLog(
    'Signing application...',
    '\n',
    '> Application:',
    validatedOpts.app,
    '\n',
    '> Platform:',
    validatedOpts.platform,
    '\n',
    '> Entitlements:',
    validatedOpts.entitlements,
    '\n',
    '> Child entitlements:',
    validatedOpts['entitlements-inherit'],
    '\n',
    '> Login helper entitlements:',
    validatedOpts['entitlements-loginhelper'],
    '\n',
    '> Additional binaries:',
    validatedOpts.binaries,
    '\n',
    '> Identity:',
    validatedOpts.identity
  );
  await signApplication(validatedOpts, identityInUse);

  // Post-sign operations
  debugLog('Application signed.');
}

/**
 * This function is a legacy callback implementation.
 *
 * @deprecated Please use the promise based "signApp" method
 */
export const sign = (opts: SignOptions, cb?: (error?: Error) => void) => {
  signApp(opts)
    .then(() => {
      debugLog('Application signed: ' + opts.app);
      if (cb) cb();
    })
    .catch((err) => {
      if (err.message) debugLog(err.message);
      else if (err.stack) debugLog(err.stack);
      else debugLog(err);
      if (cb) cb(err);
    });
};
