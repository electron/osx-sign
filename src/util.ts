import child from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isBinaryFile } from 'isbinaryfile';

import debug from 'debug';
import type { BaseSignOptions, ElectronMacPlatform } from './types.js';

export const debugLog = debug('electron-osx-sign');
debugLog.log = console.log.bind(console);

export const debugWarn = debug('electron-osx-sign:warn');
debugWarn.log = console.warn.bind(console);

const removePassword = function (input: string): string {
  return input.replace(/(-P |pass:|\/p|-pass )([^ ]+)/, function (_, p1) {
    return `${p1}***`;
  });
};

export async function execFileAsync(
  file: string,
  args: string[],
  options: child.ExecFileOptions = {},
): Promise<string> {
  if (debugLog.enabled) {
    debugLog(
      'Executing...',
      file,
      args && Array.isArray(args) ? removePassword(args.join(' ')) : '',
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

/**
 * A queue of promises, never running more than `limit` at the same time.
 * @internal
 */
export class PromiseParallelismLimiter {
  private numRunningPromsies = 0;
  private readonly waitingPromises: (() => void)[] = [];

  constructor(private maxRunningPromises: number) {
    if (maxRunningPromises < 1) {
      throw new Error('parallelism limit < 1 would never run anything.');
    }
  }

  async run<T>(promise: () => Promise<T>): Promise<T> {
      if(this.numRunningPromsies > this.maxRunningPromises) {
      await new Promise<void>((resolve) => {
        this.waitingPromises.push(resolve);
      });
    }

    try {
      // we have to await, lest the finally fire instantly
      return await promise();
    } finally {
      this.numRunningPromsies--
      
      // grab the next promise in line.
      // if we have space, run it right now.
      const next = this.waitingPromises.shift();
      if (next) {
        next();
      }
    }
  }
}

export function compactFlattenedList<T>(list: DeepList<T>): T[] {
  const result: T[] = [];

  function populateResult(list: DeepListItem<T>) {
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
export function getAppContentsPath(opts: BaseSignOptions): string {
  return path.join(opts.app, 'Contents');
}

/**
 * Returns the path to app "Frameworks" within contents.
 */
export function getAppFrameworksPath(opts: BaseSignOptions): string {
  return path.join(getAppContentsPath(opts), 'Frameworks');
}

export async function detectElectronPlatform(opts: BaseSignOptions): Promise<ElectronMacPlatform> {
  const appFrameworksPath = getAppFrameworksPath(opts);
  if (fs.existsSync(path.resolve(appFrameworksPath, 'Squirrel.framework'))) {
    return 'darwin';
  } else {
    return 'mas';
  }
}

/**
 * This function returns a promise resolving the file path if file binary.
 */
async function getFilePathIfBinary(filePath: string) {
  if (await isBinaryFile(filePath)) {
    return filePath;
  }
  return null;
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened.
 */
export async function validateOptsApp(opts: BaseSignOptions): Promise<void> {
  if (!opts.app) {
    throw new Error('Path to application must be specified.');
  }
  if (path.extname(opts.app) !== '.app') {
    throw new Error('Extension of application must be `.app`.');
  }
  if (!fs.existsSync(opts.app)) {
    throw new Error(`Application at path "${opts.app}" could not be found`);
  }
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 */
export async function validateOptsPlatform(opts: BaseSignOptions): Promise<ElectronMacPlatform> {
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

// The max number of file handles we're allowed to hold open at once
// `walk` opens every file in we want to sign to check if it's a binary.
// Every single open call holds a file descriptor. and we quickly hit ulimit,
// thus throwing an EMFILE, if you have a very lakge set of files to sign.
// 100 is a very safe number of files to hold open concurrently.
// It's higher than basically every ulimit.
export const MAX_OPEN_FILE_DESCRIPTORS = 100;

/**
 * This function returns a promise resolving all child paths within the directory specified.
 *
 * @param dirPath - Path to directory.
 * @returns Promise resolving child paths needing signing in order.
 * @internal
 */
export async function walk(dirPath: string): Promise<string[]> {
  debugLog('Walking... ' + dirPath);

  // A directory waits for its children, so  we make the limiter limit by
  // file system operations, instead of redccursive _walkAsync calls,
  // beacuse those could deadlock on deep directory trees.
  const limiter = new PromiseParallelismLimiter(MAX_OPEN_FILE_DESCRIPTORS);

  async function _walkAsync(dirPath: string): Promise<DeepList<string>> {
    const children = await limiter.run(() => fs.promises.readdir(dirPath));
    return await Promise.all(
      children.map(async (child) => {
        const filePath = path.resolve(dirPath, child);

        const stat = await limiter.run(() => fs.promises.lstat(filePath));
        if (stat.isFile()) {
          switch (path.extname(filePath)) {
            case '.cstemp': // Temporary file generated from past codesign
              debugLog('Removing... ' + filePath);
              await limiter.run(() => fs.promises.rm(filePath, { recursive: true, force: true }));
              return null;
            default:
              return await limiter.run(() => getFilePathIfBinary(filePath));
          }
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const walkResult = await _walkAsync(filePath);
          switch (path.extname(filePath)) {
            case '.app': // Application
            case '.framework': // Framework
              walkResult.push(filePath);
          }
          return walkResult;
        }
        return null;
      }),
    );
  }

  const allPaths = await _walkAsync(dirPath);
  return compactFlattenedList(allPaths);
}
