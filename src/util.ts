import * as child from 'child_process';
import * as fs from 'fs-extra';
import { isBinaryFile } from 'isbinaryfile';
import * as path from 'path';

import debug from 'debug';
import { BaseSignOptions, ElectronMacPlatform } from './types';

export const debugLog = debug('electron-osx-sign');
debugLog.log = console.log.bind(console);

export const debugWarn = debug('electron-osx-sign:warn');
debugWarn.log = console.warn.bind(console);

const removePassword = function (input: string): string {
  return input.replace(/(-P |pass:|\/p|-pass )([^ ]+)/, function (_, p1) {
    return `${p1}***`;
  });
};

export async function execFileAsync (
  file: string,
  args: string[],
  options: child.ExecFileOptions = {}
): Promise<string> {
  if (debugLog.enabled) {
    debugLog(
      'Executing...',
      file,
      args && Array.isArray(args) ? removePassword(args.join(' ')) : ''
    );
  }

  return new Promise(function (resolve, reject) {
    child.execFile(file, args, options, function (err, stdout, stderr) {
      if (err) {
        debugLog('Error executing file:', '\n', '> Stdout:', stdout, '\n', '> Stderr:', stderr);
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

type DeepListItem<T> = null | T | DeepListItem<T>[];
type DeepList<T> = DeepListItem<T>[];

export function compactFlattenedList<T> (list: DeepList<T>): T[] {
  const result: T[] = [];

  function populateResult (list: DeepListItem<T>) {
    if (!Array.isArray(list)) {
      if (list) result.push(list);
    } else if (list.length > 0) {
      for (const item of list) if (item) populateResult(item);
    }
  }

  populateResult(list);
  return result;
}

/**
 * Returns the path to the "Contents" folder inside the application bundle
 */
export function getAppContentsPath (opts: BaseSignOptions): string {
  return path.join(opts.app, 'Contents');
}

/**
 * Returns the path to app "Frameworks" within contents.
 */
export function getAppFrameworksPath (opts: BaseSignOptions): string {
  return path.join(getAppContentsPath(opts), 'Frameworks');
}

export async function detectElectronPlatform (opts: BaseSignOptions): Promise<ElectronMacPlatform> {
  const appFrameworksPath = getAppFrameworksPath(opts);
  if (await fs.pathExists(path.resolve(appFrameworksPath, 'Squirrel.framework'))) {
    return 'darwin';
  } else {
    return 'mas';
  }
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened.
 */
export async function validateOptsApp (opts: BaseSignOptions): Promise<void> {
  if (!opts.app) {
    throw new Error('Path to application must be specified.');
  }
  if (path.extname(opts.app) !== '.app') {
    throw new Error('Extension of application must be `.app`.');
  }
  if (!(await fs.pathExists(opts.app))) {
    throw new Error(`Application at path "${opts.app}" could not be found`);
  }
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 */
export async function validateOptsPlatform (opts: BaseSignOptions): Promise<ElectronMacPlatform> {
  if (opts.platform) {
    if (opts.platform === 'mas' || opts.platform === 'darwin') {
      return opts.platform;
    } else {
      debugWarn('`platform` passed in arguments not supported, checking Electron platform...');
    }
  } else {
    debugWarn('No `platform` passed in arguments, checking Electron platform...');
  }

  return await detectElectronPlatform(opts);
}

/**
 * This function returns a promise resolving all child paths within the directory specified.
 * @function
 * @param {string} dirPath - Path to directory.
 * @returns {Promise} Promise resolving child paths needing signing in order.
 * @internal
 */
export async function walkAsync (dirPath: string): Promise<string[]> {
  debugLog('Walking... ' + dirPath);

  async function _walkAsync (dirPath: string): Promise<string[]> {
    const children = await fs.readdir(dirPath);

    const binaryFiles: string[] = [];
    const filesToCheck: string[] = [];
    const filesToRemove: string[] = [];
    const foldersToCheck: string[] = [];

    await Promise.all(
      children.map(async (child) => {
        const filePath = path.resolve(dirPath, child);

        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          switch (path.extname(filePath)) {
            case '.cstemp': // Temporary file generated from past codesign
              filesToRemove.push(filePath);
              break;
            default:
              filesToCheck.push(filePath);
          }
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
          foldersToCheck.push(filePath);

          switch (path.extname(filePath)) {
            case '.app': // Application
            case '.framework': // Framework
              binaryFiles.push(filePath);
          }
        }
      })
    );

    // Remove all old tmp files -> should be not much per folder recursion
    await Promise.all(filesToRemove.map(async (filePath) => {
      debugLog(`Removing... ${filePath}`);
      await fs.remove(filePath);
    }));

    // Only binaries need to be signed
    // isBinaryFile method opens file, calls stat and alloc 1KB memory and reads in file
    // build chunks of 10 files to avoid reaching memory or open file handle limits
    const chunkSize = 10;
    for (let index = 0; index < filesToCheck.length; index += chunkSize) {
      await Promise.all(filesToCheck.slice(index, index + chunkSize).map(
        async (filePath) => await isBinaryFile(filePath) && binaryFiles.push(filePath))
      );
    }

    // Do avoid fast and easy memory or open file handle bail outs trigger recursion not in parallel
    for (const folderPath of foldersToCheck) {
      binaryFiles.push(...(await _walkAsync(folderPath)));
    }

    return binaryFiles;
  }

  return await _walkAsync(dirPath);
}
