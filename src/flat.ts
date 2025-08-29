import fs from 'node:fs';
import path from 'node:path';
import {
  debugLog,
  debugWarn,
  execFileAsync,
  validateOptsApp,
  validateOptsPlatform,
} from './util.js';

import { Identity, findIdentities } from './util-identities.js';

import type { FlatOptions, ValidatedFlatOptions } from './types.js';
import { modifyPayloadPermissions } from './pkg-utils/cpio.js';
import { setPermissionOnBom } from './pkg-utils/bom.js';

/**
 * This function returns a promise validating all options passed in opts.
 *
 * @param opts - Options.
 */
async function validateFlatOpts(opts: FlatOptions): Promise<ValidatedFlatOptions> {
  await validateOptsApp(opts);

  let pkg = opts.pkg;
  if (pkg) {
    if (typeof pkg !== 'string') throw new Error('`pkg` must be a string.');
    if (path.extname(pkg) !== '.pkg') {
      throw new Error('Extension of output package must be `.pkg`.');
    }
  } else {
    debugWarn(
      'No `pkg` passed in arguments, will fallback to default inferred from the given application.',
    );
    pkg = path.join(path.dirname(opts.app), path.basename(opts.app, '.app') + '.pkg');
  }

  let install = opts.install;
  if (install) {
    if (typeof install !== 'string') {
      return Promise.reject(new Error('`install` must be a string.'));
    }
  } else {
    debugWarn('No `install` passed in arguments, will fallback to default `/Applications`.');
    install = '/Applications';
  }

  if (typeof opts.scripts === 'string' && opts.platform === 'mas') {
    debugWarn('Mac App Store packages cannot have `scripts`, ignoring option.');
  }

  return {
    ...opts,
    pkg,
    install,
    platform: await validateOptsPlatform(opts),
  };
}

/**
 * This function returns a promise flattening the application.
 * @param opts - Options for building the .pkg archive
 */
async function buildApplicationPkg(opts: ValidatedFlatOptions, identity: Identity) {
  if (opts.platform === 'mas') {
    const args = ['--component', opts.app, opts.install, '--sign', identity.name, opts.pkg];
    if (opts.keychain) {
      args.unshift('--keychain', opts.keychain);
    }

    debugLog('Flattening Mac App Store package... ' + opts.app);
    await execFileAsync('productbuild', args);
  } else {
    const targetDir = path.dirname(opts.app);

    const componentPkgPath = path.join(
      targetDir,
      path.basename(opts.app, '.app') + '-component.pkg',
    );
    const componentExtractedPath = path.join(
      targetDir,
      path.basename(opts.app, '.app') + '-component-extracted',
    );

    try {
      const pkgbuildArgs = [
        '--install-location',
        opts.install,
        '--component',
        opts.app,
        componentPkgPath,
      ];
      if (opts.scripts) {
        pkgbuildArgs.unshift('--scripts', opts.scripts);
      }
      debugLog('Building component package... ' + opts.app);
      await execFileAsync('pkgbuild', pkgbuildArgs);

      if (opts.openPermissionsForSquirrelMac) {
        debugLog('Rewriting permissions in component package');
        // Change file permissions to be squirrel compatible
        await fs.promises.mkdir(componentExtractedPath, {
          recursive: true,
        });
        await execFileAsync(
          '/usr/bin/xar',
          ['-xf', path.relative(componentExtractedPath, componentPkgPath)],
          {
            cwd: componentExtractedPath,
          },
        );
        const bomContents = await execFileAsync('/usr/bin/lsbom', ['Bom'], {
          cwd: componentExtractedPath,
        });

        await fs.promises.copyFile(
          path.resolve(componentExtractedPath, 'Bom'),
          path.resolve(targetDir, 'OldBom'),
        );
        const mutatedBomPath = path.resolve(targetDir, 'ModifiedBom');
        debugLog('Writing mutated BOM --> ', mutatedBomPath);

        await fs.promises.writeFile(mutatedBomPath, setPermissionOnBom(bomContents));
        // Overwrite the existing Bom then clean up our temporary file
        await execFileAsync(
          '/usr/bin/mkbom',
          ['-i', mutatedBomPath, path.resolve(componentExtractedPath, 'Bom')],
          {
            cwd: targetDir,
          },
        );
        await fs.promises.copyFile(
          path.resolve(componentExtractedPath, 'Bom'),
          path.resolve(targetDir, 'NewBom'),
        );
        // await fs.promises.rm(mutatedBomPath);
        await fs.promises.rm(componentPkgPath);

        await modifyPayloadPermissions(path.resolve(componentExtractedPath, 'Payload'));

        debugLog('Rebuilding component package after permission modifications');
        await execFileAsync(
          '/usr/bin/xar',
          [
            '--compression',
            'none',
            '-cf',
            path.relative(componentExtractedPath, componentPkgPath),
            ...(await fs.promises.readdir(componentExtractedPath)),
          ],
          {
            cwd: componentExtractedPath,
          },
        );
      }

      const args = ['--package', componentPkgPath, opts.install, '--sign', identity.name, opts.pkg];
      if (opts.keychain) {
        args.unshift('--keychain', opts.keychain);
      }

      debugLog('Flattening OS X Installer package... ' + opts.app);
      await execFileAsync('productbuild', args);
    } finally {
      await fs.promises.rm(componentPkgPath, {
        force: true,
      });
      await fs.promises.rm(componentExtractedPath, {
        force: true,
        recursive: true,
      });
    }
  }
}

/**
 * Generates a flat `.pkg` installer for a packaged Electron `.app` bundle.
 * @returns A void Promise once the flattening operation is complete.
 *
 * @category Flat
 */
export async function flat(_opts: FlatOptions) {
  const validatedOptions = await validateFlatOpts(_opts);
  let identities: Identity[] = [];
  let identityInUse: Identity | null = null;

  if (validatedOptions.identity) {
    debugLog('`identity` passed in arguments.');
    if (validatedOptions.identityValidation === false) {
      // Do nothing
    } else {
      identities = await findIdentities(
        validatedOptions.keychain || null,
        validatedOptions.identity,
      );
    }
  } else {
    debugWarn('No `identity` passed in arguments...');
    if (validatedOptions.platform === 'mas') {
      debugLog(
        'Finding `3rd Party Mac Developer Installer` certificate for flattening app distribution in the Mac App Store...',
      );
      identities = await findIdentities(
        validatedOptions.keychain || null,
        '3rd Party Mac Developer Installer:',
      );
    } else {
      debugLog(
        'Finding `Developer ID Application` certificate for distribution outside the Mac App Store...',
      );
      identities = await findIdentities(
        validatedOptions.keychain || null,
        'Developer ID Installer:',
      );
    }
  }

  if (identities.length > 0) {
    // Provisioning profile(s) found
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

  debugLog(
    'Flattening application...',
    '\n',
    '> Application:',
    validatedOptions.app,
    '\n',
    '> Package output:',
    validatedOptions.pkg,
    '\n',
    '> Install path:',
    validatedOptions.install,
    '\n',
    '> Identity:',
    validatedOptions.identity,
    '\n',
    '> Scripts:',
    validatedOptions.scripts,
  );
  await buildApplicationPkg(validatedOptions, identityInUse);

  debugLog('Application flattened.');
}
