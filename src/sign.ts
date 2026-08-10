import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';
import semver from 'semver';

import {
  debugLog,
  debugWarn,
  getAppContentsPath,
  execFileAsync,
  validateOptsApp,
  validateOptsPlatform,
  walk,
} from './util.js';
import { Identity, findIdentities } from './util-identities.js';
import {
  preEmbedProvisioningProfile,
  getProvisioningProfile,
} from './util-provisioning-profiles.js';
import { preAutoEntitlements } from './util-entitlements.js';
import type {
  ElectronMacPlatform,
  PerFileSignOptions,
  SignOptions,
  ValidatedSignOptions,
} from './types.js';

const osRelease = os.release();

/**
 * This function returns a promise validating opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 */
async function validateOptsBinaries(opts: SignOptions) {
  if (opts.binaries) {
    if (!Array.isArray(opts.binaries)) {
      throw new Error('Additional binaries should be an Array.');
    }
    // TODO: Presence check for binary files, reject if any does not exist
  }
}

export function validateOptsIgnore(ignore: SignOptions['ignore']): ValidatedSignOptions['ignore'] {
  if (ignore) {
    return Array.isArray(ignore) ? ignore : [ignore];
  }
}

/**
 * Maps parsed command-line values from the `electron-osx-sign` CLI onto a {@link SignOptions} object.
 * This keeps the CLI argument forwarding logic in one testable place.
 */
export function cliOptionsToSignOptions(values: {
  ignore?: string[];
  'signature-flags'?: string;
}): {
  ignore?: SignOptions['ignore'];
  optionsForFile?: SignOptions['optionsForFile'];
} {
  const opts: {
    ignore?: SignOptions['ignore'];
    optionsForFile?: SignOptions['optionsForFile'];
  } = {};
  if (values.ignore) opts.ignore = values.ignore;
  if (values['signature-flags']) {
    const signatureFlags = values['signature-flags'];
    opts.optionsForFile = () => ({ signatureFlags });
  }
  return opts;
}

/**
 * Whether `filePath` is a binary inside a `.app` bundle's `Contents/MacOS/` directory.
 *
 * `codesign` treats a bundle's main executable as the bundle itself: signing
 * `Foo.app/Contents/MacOS/Foo` seals `Foo.app`, which requires every nested code object
 * under `Foo.app/Contents/` to already be signed, otherwise `codesign` fails with
 * `code object is not signed at all` for the first unsigned subcomponent it finds.
 */
export function isBundleMainExecutable(filePath: string): boolean {
  return /\.app\/Contents\/MacOS\/[^/]+$/.test(filePath);
}

/**
 * Rank of a file in the signing order. Higher ranks are signed first.
 *
 * Files are signed from the inside out (deeper paths first). Within a depth, binaries in a
 * bundle's `Contents/MacOS/` come after everything else: nested code that lives directly under
 * `Contents/<dir>/` (a flat helper in `Contents/Helpers/`, for example) sits at the same depth
 * as the main executable, and signing the main executable seals the bundle (see
 * {@link isBundleMainExecutable}), so depth alone doesn't guarantee that helper is signed first.
 * Ranking is what both the one-file-per-`codesign` path and `batchCodesignCalls` order by, so
 * the two produce the same sequence of seals.
 */
export function signingRank(filePath: string): number {
  const depth = filePath.split(path.sep).length;
  return depth * 2 + (isBundleMainExecutable(filePath) ? 0 : 1);
}

/**
 * Sorts paths into the order they must be signed in. Stable, so files with the same rank keep
 * their discovery order.
 */
export function sortForSigning(filePaths: readonly string[]): string[] {
  return [...filePaths].sort((a, b) => signingRank(b) - signingRank(a));
}

/**
 * This function returns a promise validating all options passed in opts.
 */
async function validateSignOpts(opts: SignOptions): Promise<Readonly<ValidatedSignOptions>> {
  await validateOptsBinaries(opts);
  await validateOptsApp(opts);

  if (opts.provisioningProfile && typeof opts.provisioningProfile !== 'string') {
    throw new Error('Path to provisioning profile should be a string.');
  }

  if (opts.type && opts.type !== 'development' && opts.type !== 'distribution') {
    throw new Error('Type must be either `development` or `distribution`.');
  }

  const platform = await validateOptsPlatform(opts);
  const cloned: ValidatedSignOptions = {
    ...opts,
    ignore: validateOptsIgnore(opts.ignore),
    type: opts.type || 'distribution',
    platform,
  };
  return cloned;
}

/**
 * This function returns a promise verifying the code sign of application bundle.
 */
async function verifySignApplication(opts: ValidatedSignOptions) {
  // Verify with codesign
  debugLog('Verifying application bundle with codesign...');

  const strictVerify = opts.strictVerify !== undefined ? opts.strictVerify : true;
  await execFileAsync(
    'codesign',
    ['--verify', '--deep'].concat(
      strictVerify !== false && semver.gte(osRelease, '15.0.0') // Strict flag since darwin 15.0.0 --> OS X 10.11.0 El Capitan
        ? ['--strict' + (strictVerify !== true ? '=' + strictVerify : '')]
        : [],
      ['--verbose=2', opts.app],
    ),
  );
}

function defaultOptionsForFile(filePath: string, platform: ElectronMacPlatform) {
  const entitlementsFolder = path.resolve(import.meta.dirname, '..', 'entitlements');

  let entitlementsFile: string;
  if (platform === 'darwin') {
    // Default Entitlements
    // c.f. https://source.chromium.org/chromium/chromium/src/+/main:chrome/app/app-entitlements.plist
    // Also include JIT for main process V8
    entitlementsFile = path.resolve(entitlementsFolder, 'default.darwin.plist');
    // Plugin helper
    // c.f. https://source.chromium.org/chromium/chromium/src/+/main:chrome/app/helper-plugin-entitlements.plist
    if (filePath.includes('(Plugin).app')) {
      entitlementsFile = path.resolve(entitlementsFolder, 'default.darwin.plugin.plist');
      // GPU Helper
      // c.f. https://source.chromium.org/chromium/chromium/src/+/main:chrome/app/helper-gpu-entitlements.plist
    } else if (filePath.includes('(GPU).app')) {
      entitlementsFile = path.resolve(entitlementsFolder, 'default.darwin.gpu.plist');
      // Renderer Helper
      // c.f. https://source.chromium.org/chromium/chromium/src/+/main:chrome/app/helper-renderer-entitlements.plist
    } else if (filePath.includes('(Renderer).app')) {
      entitlementsFile = path.resolve(entitlementsFolder, 'default.darwin.renderer.plist');
    }
  } else {
    // Default entitlements
    // TODO: Can these be more scoped like the non-mas variant?
    entitlementsFile = path.resolve(entitlementsFolder, 'default.mas.plist');

    // If it is not the top level app bundle, we sign with inherit
    if (filePath.includes('.app/')) {
      entitlementsFile = path.resolve(entitlementsFolder, 'default.mas.child.plist');
    }
  }

  return {
    entitlements: entitlementsFile,
    hardenedRuntime: true,
    requirements: undefined as string | undefined,
    signatureFlags: undefined as string | string[] | undefined,
    timestamp: undefined as string | undefined,
    additionalArguments: [] as string[] | undefined,
  };
}

async function mergeOptionsForFile(
  opts: PerFileSignOptions | null,
  defaults: ReturnType<typeof defaultOptionsForFile>,
) {
  const mergedPerFileOptions = { ...defaults };
  if (opts) {
    if (opts.entitlements !== undefined) {
      if (Array.isArray(opts.entitlements)) {
        const entitlements = opts.entitlements.reduce<Record<string, any>>(
          (dict, entitlementKey) => ({
            ...dict,
            [entitlementKey]: true,
          }),
          {},
        );
        const dir = await fs.promises.mkdtemp(path.resolve(os.tmpdir(), 'tmp-entitlements-'));
        const entitlementsPath = path.join(dir, 'entitlements.plist');
        await fs.promises.writeFile(entitlementsPath, plist.build(entitlements), 'utf8');
        opts.entitlements = entitlementsPath;
      }
      mergedPerFileOptions.entitlements = opts.entitlements;
    }
    if (opts.hardenedRuntime !== undefined) {
      mergedPerFileOptions.hardenedRuntime = opts.hardenedRuntime;
    }
    if (opts.requirements !== undefined) mergedPerFileOptions.requirements = opts.requirements;
    if (opts.signatureFlags !== undefined) {
      mergedPerFileOptions.signatureFlags = opts.signatureFlags;
    }
    if (opts.timestamp !== undefined) mergedPerFileOptions.timestamp = opts.timestamp;
    if (opts.additionalArguments !== undefined)
      mergedPerFileOptions.additionalArguments = opts.additionalArguments;
  }
  return mergedPerFileOptions;
}

/**
 * This function returns a promise codesigning only.
 */
async function signApplication(opts: ValidatedSignOptions, identity: Identity) {
  function shouldIgnoreFilePath(filePath: string) {
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

  const discovered = await walk(getAppContentsPath(opts));

  if (opts.binaries) discovered.push(...opts.binaries);

  const args = ['--sign', identity.hash || identity.name, '--force'];
  if (opts.keychain) {
    args.push('--keychain', opts.keychain);
  }

  /**
   * Sign from the inside out: codesign requires nested code to be signed before the code
   * that contains it is sealed. See {@link signingRank} for the exact order.
   */
  const children = sortForSigning(discovered);

  /**
   * If `opts.batchCodesignCalls` is `true`, for each signing rank (see {@link signingRank}),
   * we'll group together all files that use the same signing arguments so we can sign all of
   * them with a single call to `codesign`, while still ensuring that the app files are signed
   * from the inside out. Grouping happens per rank rather than per depth so that a bundle's
   * main executable can't be pulled into a batch that runs before a same-depth helper whose
   * arguments differ (e.g. because it has its own entitlements).
   */
  const filesWithSameArgsByRank = new Map<number, Map<string, string[]>>();

  for (const filePath of [...children, opts.app]) {
    if (shouldIgnoreFilePath(filePath)) {
      debugLog('Skipped... ' + filePath);
      continue;
    }

    const perFileOptions = await mergeOptionsForFile(
      opts.optionsForFile ? opts.optionsForFile(filePath, { platform: opts.platform }) : null,
      defaultOptionsForFile(filePath, opts.platform),
    );

    // preAutoEntitlements should only be applied to the top level app bundle.
    // Applying it other files will cause the app to crash and be rejected by Apple.
    if (!filePath.includes('.app/')) {
      if (opts.preAutoEntitlements === false) {
        debugWarn('Pre-sign operation disabled for entitlements automation.');
      } else {
        debugLog(
          'Pre-sign operation enabled for entitlements automation with versions >= `1.1.1`:',
          '\n',
          '* Disable by setting `pre-auto-entitlements` to `false`.',
        );
        if (!opts.version || semver.gte(opts.version, '1.1.1')) {
          // Enable Mac App Store sandboxing without using temporary-exception, introduced in Electron v1.1.1. Relates to electron#5601
          const newEntitlements = await preAutoEntitlements(opts, perFileOptions, {
            identity,
            provisioningProfile: opts.provisioningProfile
              ? await getProvisioningProfile(opts.provisioningProfile, opts.keychain)
              : undefined,
          });

          // preAutoEntitlements may provide us new entitlements, if so we update our options
          // and ensure that entitlements-loginhelper has a correct default value
          if (newEntitlements) {
            perFileOptions.entitlements = newEntitlements;
          }
        }
      }
    }

    if (!opts.batchCodesignCalls) {
      debugLog('Signing... ' + filePath);
    }

    const perFileArgs = [...args];

    if (perFileOptions.requirements) {
      if (perFileOptions.requirements.charAt(0) === '=') {
        perFileArgs.push(`-r${perFileOptions.requirements}`);
      } else {
        perFileArgs.push('--requirements', perFileOptions.requirements);
      }
    }
    if (perFileOptions.timestamp) {
      perFileArgs.push('--timestamp=' + perFileOptions.timestamp);
    } else {
      perFileArgs.push('--timestamp');
    }

    let optionsArguments: string[] = [];

    if (perFileOptions.signatureFlags) {
      if (Array.isArray(perFileOptions.signatureFlags)) {
        optionsArguments.push(...perFileOptions.signatureFlags);
      } else {
        const flags = perFileOptions.signatureFlags.split(',').map(function (flag) {
          return flag.trim();
        });
        optionsArguments.push(...flags);
      }
    }

    if (perFileOptions.hardenedRuntime || optionsArguments.includes('runtime')) {
      // Hardened runtime since darwin 17.7.0 --> macOS 10.13.6
      if (semver.gte(osRelease, '17.7.0')) {
        optionsArguments.push('runtime');
      } else {
        // Remove runtime if passed in with --signature-flags
        debugLog(
          'Not enabling hardened runtime, current macOS version too low, requires 10.13.6 and higher',
        );
        optionsArguments = optionsArguments.filter((arg) => {
          return arg !== 'runtime';
        });
      }
    }

    if (optionsArguments.length) {
      perFileArgs.push('--options', [...new Set(optionsArguments)].join(','));
    }

    if (perFileOptions.additionalArguments) {
      perFileArgs.push(...perFileOptions.additionalArguments);
    }

    if (opts.batchCodesignCalls) {
      perFileArgs.push('--entitlements', perFileOptions.entitlements);

      const rank = signingRank(filePath);
      const filesWithSameArgsMap = filesWithSameArgsByRank.get(rank) ?? new Map<string, string[]>();

      const fileWithSameArgsMapKey = JSON.stringify(perFileArgs);
      filesWithSameArgsMap.set(
        fileWithSameArgsMapKey,
        (filesWithSameArgsMap.get(fileWithSameArgsMapKey) ?? ([] as string[])).concat(filePath),
      );

      filesWithSameArgsByRank.set(rank, filesWithSameArgsMap);
    } else {
      await execFileAsync(
        'codesign',
        perFileArgs.concat('--entitlements', perFileOptions.entitlements, filePath),
      );
    }
  }

  if (opts.batchCodesignCalls) {
    // Map iteration follows insertion order, and files were inserted in signing order
    // (`children` is sorted, `opts.app` comes last), so this signs in the same sequence
    // as the one-file-per-call path above, just with fewer `codesign` invocations.
    for (const filesWithSameArgsMap of filesWithSameArgsByRank.values()) {
      for (const [stringifiedArgs, filePaths] of filesWithSameArgsMap.entries()) {
        debugLog('Signing... ' + JSON.stringify(filePaths, null, 2));

        const args: string[] = JSON.parse(stringifiedArgs);

        await execFileAsync('codesign', [...args, ...filePaths]);
      }
    }
  }

  // Verify code sign
  debugLog('Verifying...');
  await verifySignApplication(opts);
  debugLog('Verified.');

  // Check entitlements if applicable
  debugLog('Displaying entitlements...');
  const result = await execFileAsync('codesign', [
    '--display',
    '--entitlements',
    ':-', // Write to standard output and strip off the blob header
    opts.app,
  ]);

  debugLog('Entitlements:', '\n', result);
}

/**
 * Signs a macOS application.
 * @returns A void Promise once the signing operation is complete.
 *
 * @category Codesign
 */
export async function sign(_opts: SignOptions) {
  const validatedOpts = await validateSignOpts(_opts);
  let identities: Identity[] = [];
  let identityInUse: Identity | null = null;

  // Determine identity for signing
  if (validatedOpts.identity) {
    debugLog('`identity` passed in arguments.');
    if (validatedOpts.identityValidation === false) {
      identityInUse = new Identity(validatedOpts.identity);
    } else {
      identities = await findIdentities(validatedOpts.keychain || null, validatedOpts.identity);
    }
  } else {
    debugWarn('No `identity` passed in arguments...');
    if (validatedOpts.platform === 'mas') {
      if (validatedOpts.type === 'distribution') {
        debugLog(
          'Finding `3rd Party Mac Developer Application` certificate for signing app distribution in the Mac App Store...',
        );
        identities = await findIdentities(
          validatedOpts.keychain || null,
          '3rd Party Mac Developer Application:',
        );
      } else {
        debugLog(
          'Finding `Mac Developer` certificate for signing app in development for the Mac App Store signing...',
        );
        identities = await findIdentities(validatedOpts.keychain || null, 'Mac Developer:');
      }
    } else {
      debugLog(
        'Finding `Developer ID Application` certificate for distribution outside the Mac App Store...',
      );
      identities = await findIdentities(
        validatedOpts.keychain || null,
        'Developer ID Application:',
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
  if (validatedOpts.preEmbedProvisioningProfile === false) {
    debugWarn(
      'Pre-sign operation disabled for provisioning profile embedding:',
      '\n',
      '* Enable by setting `pre-embed-provisioning-profile` to `true`.',
    );
  } else {
    debugLog(
      'Pre-sign operation enabled for provisioning profile:',
      '\n',
      '* Disable by setting `pre-embed-provisioning-profile` to `false`.',
    );
    await preEmbedProvisioningProfile(
      validatedOpts,
      validatedOpts.provisioningProfile
        ? await getProvisioningProfile(validatedOpts.provisioningProfile, validatedOpts.keychain)
        : null,
    );
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
    '> Additional binaries:',
    validatedOpts.binaries,
    '\n',
    '> Identity:',
    validatedOpts.identity,
  );
  await signApplication(validatedOpts, identityInUse);

  // Post-sign operations
  debugLog('Application signed.');
}
