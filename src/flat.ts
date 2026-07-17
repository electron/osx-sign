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
import { buildProductArchive } from './pkg-utils/pkg.js';

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

  if (
    opts.implementation !== undefined &&
    opts.implementation !== 'native' &&
    opts.implementation !== 'js'
  ) {
    throw new Error(
      `\`implementation\` must be either \`native\` or \`js\`, got \`${String(opts.implementation)}\``,
    );
  }

  return {
    ...opts,
    pkg,
    install,
    platform: await validateOptsPlatform(opts),
  };
}

/**
 * Squirrel.Mac-friendly permissions: files and directories installed as
 * root:admin with group-writable modes so any admin can update the app.
 * Mirrors what {@link setPermissionOnBom} does to native pkgbuild output.
 */
function openPermissionsTransform(entry: { path: string; mode: number }): {
  mode?: number;
  gid: number;
} {
  // The payload root is always forced to 0775, matching the unconditional
  // root rewrite in setPermissionOnBom.
  if (entry.path === '.') return { mode: 0o775, gid: 80 };
  const perms = entry.mode & 0o777;
  const special = entry.mode & 0o7000;
  let mode: number | undefined;
  if (perms === 0o755) mode = special | 0o775;
  else if (perms === 0o644) mode = special | 0o664;
  return { mode, gid: 80 };
}

/**
 * Build the flat package with the pure-JS implementation, then sign it with
 * `productsign` when an identity was resolved.
 */
async function buildApplicationPkgJS(opts: ValidatedFlatOptions, identity: Identity | null) {
  const unsignedPkg = identity ? `${opts.pkg}.unsigned` : opts.pkg;
  debugLog('Flattening package with the JS implementation... ' + opts.app);
  try {
    await buildProductArchive({
      app: opts.app,
      installLocation: opts.install,
      output: unsignedPkg,
      // MAS packages go through `productbuild --component`; everything else
      // historically used `pkgbuild` + `productbuild --package` (which is
      // also the only shape that supports scripts).
      componentStyle: opts.platform === 'mas',
      scripts: opts.platform === 'mas' ? undefined : opts.scripts,
      transformEntry: opts.openPermissionsForSquirrelMac ? openPermissionsTransform : undefined,
    });

    if (identity) {
      debugLog('Signing package with productsign...', opts.pkg);
      // productsign refuses to overwrite an existing destination, unlike
      // `productbuild --sign` which the native path uses.
      await fs.promises.rm(opts.pkg, { force: true });
      const args = ['--sign', identity.name];
      if (opts.keychain) args.unshift('--keychain', opts.keychain);
      await execFileAsync('productsign', [...args, unsignedPkg, opts.pkg]);
    }
  } finally {
    if (unsignedPkg !== opts.pkg) {
      await fs.promises.rm(unsignedPkg, { force: true });
    }
  }
}

/**
 * This function returns a promise flattening the application.
 * @param opts - Options for building the .pkg archive
 */
async function buildApplicationPkg(opts: ValidatedFlatOptions, identity: Identity | null) {
  if (opts.implementation === 'js') {
    return buildApplicationPkgJS(opts, identity);
  }
  if (opts.platform === 'mas') {
    const signArgs = identity ? ['--sign', identity.name] : [];
    const args = ['--component', opts.app, opts.install, ...signArgs, opts.pkg];
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

      const signArgs = identity ? ['--sign', identity.name] : [];
      const args = ['--package', componentPkgPath, opts.install, ...signArgs, opts.pkg];
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

  if (validatedOptions.identity === null) {
    // No identity, skip signing
  } else if (validatedOptions.identity) {
    debugLog('`identity` passed in arguments.');
    if (validatedOptions.identityValidation === false) {
      identityInUse = new Identity(validatedOptions.identity);
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
  } else if (validatedOptions.identity !== null && validatedOptions.identityValidation !== false) {
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
