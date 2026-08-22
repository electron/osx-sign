import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

/**
 * `walk` opens a FD on every single file, recursively, in the directory it walks.
 * this makes it really easy to hit EMFILE for very large folders.
 * This test asserts that we never hold more files than a fixed limit.
 */
const binaryCheck = vi.hoisted(() => ({
  openFiles: 0,
  peakOpenFiles: 0,
  calls: 0,
}));

vi.mock('isbinaryfile', () => ({
  isBinaryFile: async (filePath: string) => {
    binaryCheck.openFiles += 1;
    binaryCheck.calls += 1;
    binaryCheck.peakOpenFiles = Math.max(binaryCheck.peakOpenFiles, binaryCheck.openFiles);

    // Hold the FD for at least one tick of the event loop
    await new Promise((resolve) => setTimeout(resolve, 1));
    binaryCheck.openFiles -= 1;
    return path.extname(filePath) === '.bin';
  },
}));

const {
  PromiseParallelismLimiter: ConcurrencyLimiter,
  walk,
  MAX_OPEN_FILE_DESCRIPTORS,
} = await import('../src/util.js');

let testWorkingDir: string;

beforeEach(async () => {
  binaryCheck.openFiles = 0;
  binaryCheck.peakOpenFiles = 0;
  binaryCheck.calls = 0;
  testWorkingDir = await mkdtemp(path.join(os.tmpdir(), 'util-walk-test-workdir-'));
});

// cleanup tmp working dirs after each test is done
afterEach(async () => {
  await rm(testWorkingDir, { recursive: true, force: true });
});

async function writeFiles(dirPath: string, names: string[]) {
  await mkdir(dirPath, { recursive: true });
  for (const name of names) {
    await writeFile(path.join(dirPath, name), 'x');
  }
}

describe('ConcurrencyLimiter', () => {
  it('limits promise parallelism to its passed limit', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let runningPromises = 0;
    let peakRunningPromises = 0;

    await Promise.all(
      Array.from({ length: 50 }, () =>
        limiter.run(async () => {
          runningPromises += 1;
          peakRunningPromises = Math.max(peakRunningPromises, runningPromises);
          await new Promise((resolve) => setTimeout(resolve, 1));
          runningPromises -= 1;
        }),
      ),
    );

    expect(peakRunningPromises).toBe(3);
    expect(runningPromises).toBe(0);
  });

  it('relases a parallelism slot if as running promises rejects', async () => {
    const limiter = new ConcurrencyLimiter(1);

    const rejectMessage = 'promise rejected';
    await expect(limiter.run(() => Promise.reject(new Error(rejectMessage)))).rejects.toThrow(
      rejectMessage,
    );

    const result = 'continues to run after one promise in the queue rejected';

    await expect(limiter.run(async () => result)).resolves.toBe(result);
  });
});

describe('walk', () => {
  it('has no more than 100 files open at the same time', async () => {
    const fileCount = 750;
    await writeFiles(
      path.join(testWorkingDir, 'Resources'),
      Array.from({ length: fileCount }, (_unused, index) => `file-${index}.bin`),
    );

    const result = await walk(testWorkingDir);

    expect(binaryCheck.calls).toBe(fileCount);
    expect(binaryCheck.peakOpenFiles).toBeLessThanOrEqual(fileCount);
    expect(result).toHaveLength(fileCount);
  });

  it('parallelizes reads up to the limit', async () => {
    await writeFiles(
      path.join(testWorkingDir, 'Resources'),
      Array.from({ length: 750 }, (_unused, index) => `file-${index}.bin`),
    );

    await walk(testWorkingDir);

    expect(binaryCheck.peakOpenFiles).toBe(750);
  });

  it("doesn't deadlock on deep tree", async () => {
    // since walking each directory awaits Promise.all(walk([its children])
    // make sure going deep doesn't deadlock
    const treeCDepth = MAX_OPEN_FILE_DESCRIPTORS + 50;
    let deepPath = testWorkingDir;
    for (let level = 0; level < treeCDepth; level += 1) {
      deepPath = path.join(deepPath, `level-${level}`);
    }
    await writeFiles(deepPath, ['deep.bin']);

    const result = await walk(testWorkingDir);

    expect(result).toEqual([path.join(deepPath, 'deep.bin')]);
  });

  it("doesn't mess with result values or order", async () => {
    const contents = path.join(testWorkingDir, 'Contents');
    await writeFiles(path.join(contents, 'MacOS'), ['Foo.bin', 'readme.txt']);
    await writeFiles(path.join(contents, 'Frameworks', 'Foo.framework'), ['Foo.bin']);
    await writeFiles(path.join(contents, 'Frameworks', 'Foo Helper.app'), ['Helper.bin']);
    await writeFiles(path.join(contents, 'Resources'), ['icon.icns.cstemp']);

    const result = await walk(testWorkingDir);

    expect(new Set(result)).toEqual(
      new Set([
        path.join(contents, 'MacOS', 'Foo.bin'),
        path.join(contents, 'Frameworks', 'Foo.framework', 'Foo.bin'),
        path.join(contents, 'Frameworks', 'Foo.framework'),
        path.join(contents, 'Frameworks', 'Foo Helper.app', 'Helper.bin'),
        path.join(contents, 'Frameworks', 'Foo Helper.app'),
      ]),
    );

    expect(existsSync(path.join(contents, 'Resources', 'icon.icns.cstemp'))).toBe(false);
  });
});
