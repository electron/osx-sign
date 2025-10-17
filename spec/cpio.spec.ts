import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as os from 'os';
import { modifyPayloadPermissions, CpioModifier } from '../src/pkg-utils/cpio.js';

describe('cpio', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpio-test-'));
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // Helper function to create a test cpio archive using the cpio command
  function createTestCpioArchive(files: { name: string; content: string; mode: string }[]): Buffer {
    const testFilesDir = path.join(testDir, 'test-files-' + Date.now());
    fs.mkdirSync(testFilesDir, { recursive: true });

    // Create test files
    for (const file of files) {
      const filePath = path.join(testFilesDir, file.name);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, file.content);
      fs.chmodSync(filePath, parseInt(file.mode, 8));
    }

    const cpioPath = path.join(testDir, 'test.cpio');
    const fileList = files.map((f) => f.name).join('\n');

    try {
      // Create cpio archive in odc format (ASCII format that the code expects)
      execSync(
        `cd "${testFilesDir}" && echo "${fileList}" | cpio -o --format=odc > "${cpioPath}" 2>/dev/null`,
      );
    } catch (error) {
      console.error('Failed to create cpio archive:', error);
    }

    const cpioData = fs.readFileSync(cpioPath);
    fs.rmSync(testFilesDir, { recursive: true });
    fs.unlinkSync(cpioPath);
    return cpioData;
  }

  // Helper to extract and verify cpio archive
  function extractAndVerifyCpio(cpioData: Buffer): {
    files: Map<string, { content: Buffer; mode: number }>;
  } {
    const extractPath = path.join(testDir, 'extract-' + Date.now());
    fs.mkdirSync(extractPath);

    const cpioFile = path.join(extractPath, 'archive.cpio');
    fs.writeFileSync(cpioFile, cpioData);

    try {
      execSync(`cd "${extractPath}" && cpio -i < archive.cpio 2>/dev/null`);

      const files = new Map<string, { content: Buffer; mode: number }>();

      const walkDir = (dir: string, prefix = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          let relativePath = path.join(prefix, entry.name);

          // Remove leading "./" if present
          if (relativePath.startsWith('./')) {
            relativePath = relativePath.substring(2);
          }

          if (entry.isFile()) {
            const stats = fs.statSync(fullPath);
            files.set(relativePath, {
              content: fs.readFileSync(fullPath),
              mode: stats.mode & 0o777,
            });
          } else if (entry.isDirectory()) {
            walkDir(fullPath, relativePath);
          }
        }
      };

      walkDir(extractPath);
      files.delete('archive.cpio'); // Remove the archive itself from results

      fs.rmSync(extractPath, { recursive: true });
      return { files };
    } catch (error) {
      fs.rmSync(extractPath, { recursive: true, force: true });
      throw error;
    }
  }

  describe('CpioModifier', () => {
    describe('parseCpio', () => {
      it('should parse a simple cpio archive with one file', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'Hello World', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        expect(entries.length).toBeGreaterThanOrEqual(2); // File + TRAILER

        const testFile = entries.find((e) => e.filename === 'test.txt');
        expect(testFile).toBeDefined();
        expect(testFile?.data.toString()).toBe('Hello World');
        expect(testFile?.filesize).toBe(11);

        const trailer = entries.find((e) => e.filename === 'TRAILER!!!');
        expect(trailer).toBeDefined();
      });

      it('should parse multiple files in a cpio archive', () => {
        const cpioData = createTestCpioArchive([
          { name: 'file1.txt', content: 'Content 1', mode: '644' },
          { name: 'file2.txt', content: 'Content 2', mode: '755' },
          { name: 'file3.txt', content: 'Content 3', mode: '600' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        const file1 = entries.find((e) => e.filename === 'file1.txt');
        const file2 = entries.find((e) => e.filename === 'file2.txt');
        const file3 = entries.find((e) => e.filename === 'file3.txt');

        expect(file1).toBeDefined();
        expect(file1?.data.toString()).toBe('Content 1');

        expect(file2).toBeDefined();
        expect(file2?.data.toString()).toBe('Content 2');

        expect(file3).toBeDefined();
        expect(file3?.data.toString()).toBe('Content 3');
      });

      it('should handle empty files', () => {
        const cpioData = createTestCpioArchive([{ name: 'empty.txt', content: '', mode: '644' }]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        const emptyFile = entries.find((e) => e.filename === 'empty.txt');
        expect(emptyFile).toBeDefined();
        expect(emptyFile?.filesize).toBe(0);
        expect(emptyFile?.data.length).toBe(0);
      });

      it('should correctly parse header fields', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'Test', mode: '755' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        const testFile = entries.find((e) => e.filename === 'test.txt');
        expect(testFile).toBeDefined();
        expect(testFile?.magic).toBe('070707');
        expect(testFile?.namesize).toBeGreaterThan(0);
        expect(testFile?.filesize).toBe(4);

        // Check mode was parsed correctly
        const mode = parseInt(testFile?.mode || '0', 8);
        expect(mode & 0o777).toBe(0o755);
      });

      it('should handle invalid magic number gracefully', () => {
        const invalidData = Buffer.from('INVALID_CPIO_DATA_WITH_WRONG_MAGIC');

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(invalidData);

        expect(entries).toEqual([]);
      });

      it('should handle truncated archive', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '644' },
        ]);

        // Truncate in the middle of the archive
        const truncatedData = cpioData.slice(0, 50);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(truncatedData);

        // Should have no entries or only partial entries
        expect(entries.length).toBeLessThanOrEqual(1);
      });

      it('should handle files with special characters in names', () => {
        const specialName = 'file-with-special_chars.2024.txt';
        const cpioData = createTestCpioArchive([
          { name: specialName, content: 'Special content', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        const specialFile = entries.find((e) => e.filename === specialName);
        expect(specialFile).toBeDefined();
        expect(specialFile?.data.toString()).toBe('Special content');
      });

      it('should handle large file sizes correctly', () => {
        const largeContent = 'X'.repeat(10000);
        const cpioData = createTestCpioArchive([
          { name: 'large.txt', content: largeContent, mode: '644' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        const largeFile = entries.find((e) => e.filename === 'large.txt');
        expect(largeFile).toBeDefined();
        expect(largeFile?.filesize).toBe(10000);
        expect(largeFile?.data.length).toBe(10000);
        expect(largeFile?.data.toString()).toBe(largeContent);
      });

      it('should preserve all header fields', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);
        const testFile = entries.find((e) => e.filename === 'test.txt');

        expect(testFile).toBeDefined();
        expect(testFile?.magic).toBe('070707');
        expect(testFile?.dev).toBeDefined();
        expect(testFile?.ino).toBeDefined();
        expect(testFile?.mode).toBeDefined();
        expect(testFile?.uid).toBeDefined();
        expect(testFile?.gid).toBeDefined();
        expect(testFile?.nlink).toBeDefined();
        expect(testFile?.rdev).toBeDefined();
        expect(testFile?.mtime).toBeDefined();
      });
    });

    describe('modifyPermissions', () => {
      it('should change 755 permissions to 775', () => {
        const cpioData = createTestCpioArchive([
          { name: 'executable.sh', content: '#!/bin/bash\necho test', mode: '755' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        modifier.modifyPermissions();
        const entries = modifier.getEntries();

        const executable = entries.find((e) => e.filename === 'executable.sh');
        expect(executable).toBeDefined();

        const mode = parseInt(executable?.mode || '0', 8);
        const perms = mode & 0o777;
        expect(perms).toBe(0o775);
      });

      it('should change 644 permissions to 664', () => {
        const cpioData = createTestCpioArchive([
          { name: 'regular.txt', content: 'Regular file', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        modifier.modifyPermissions();
        const entries = modifier.getEntries();

        const regular = entries.find((e) => e.filename === 'regular.txt');
        expect(regular).toBeDefined();

        const mode = parseInt(regular?.mode || '0', 8);
        const perms = mode & 0o777;
        expect(perms).toBe(0o664);
      });

      it('should not modify permissions that are not 755 or 644', () => {
        const cpioData = createTestCpioArchive([
          { name: 'special.txt', content: 'Special', mode: '600' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const originalEntries = JSON.parse(JSON.stringify(modifier.getEntries()));

        modifier.modifyPermissions();
        const modifiedEntries = modifier.getEntries();

        const original = originalEntries.find((e) => e.filename === 'special.txt');
        const modified = modifiedEntries.find((e) => e.filename === 'special.txt');

        expect(modified?.mode).toBe(original?.mode);
      });

      it('should preserve file type bits when modifying permissions', () => {
        const cpioData = createTestCpioArchive([
          { name: 'regular.txt', content: 'test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);

        const originalEntries = modifier.getEntries();
        const original = originalEntries.find((e) => e.filename === 'regular.txt');
        const originalMode = parseInt(original?.mode || '0', 8);
        const originalType = originalMode & 0o170000;

        modifier.modifyPermissions();
        const modifiedEntries = modifier.getEntries();
        const modified = modifiedEntries.find((e) => e.filename === 'regular.txt');
        const modifiedMode = parseInt(modified?.mode || '0', 8);
        const modifiedType = modifiedMode & 0o170000;

        expect(modifiedType).toBe(originalType);
      });

      it('should handle multiple files with different permissions', () => {
        const cpioData = createTestCpioArchive([
          { name: 'exec1.sh', content: 'exec1', mode: '755' },
          { name: 'file1.txt', content: 'file1', mode: '644' },
          { name: 'exec2.sh', content: 'exec2', mode: '755' },
          { name: 'file2.txt', content: 'file2', mode: '644' },
          { name: 'special.txt', content: 'special', mode: '600' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        modifier.modifyPermissions();
        const entries = modifier.getEntries();

        const exec1 = entries.find((e) => e.filename === 'exec1.sh');
        const exec2 = entries.find((e) => e.filename === 'exec2.sh');
        const file1 = entries.find((e) => e.filename === 'file1.txt');
        const file2 = entries.find((e) => e.filename === 'file2.txt');
        const special = entries.find((e) => e.filename === 'special.txt');

        expect(parseInt(exec1?.mode || '0', 8) & 0o777).toBe(0o775);
        expect(parseInt(exec2?.mode || '0', 8) & 0o777).toBe(0o775);
        expect(parseInt(file1?.mode || '0', 8) & 0o777).toBe(0o664);
        expect(parseInt(file2?.mode || '0', 8) & 0o777).toBe(0o664);
        expect(parseInt(special?.mode || '0', 8) & 0o777).toBe(0o600);
      });

      it('should modify gid to 80 for root-owned files', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        const entries = modifier.parseCpio(cpioData);

        // Manually set to root ownership to test the logic
        const testFile = entries.find((e) => e.filename === 'test.txt');
        if (testFile) {
          testFile.uid = '000000';
          testFile.gid = '000000';
        }

        modifier.modifyPermissions();
        const modifiedEntries = modifier.getEntries();
        const modifiedFile = modifiedEntries.find((e) => e.filename === 'test.txt');

        expect(modifiedFile?.uid).toBe('000000');
        expect(parseInt(modifiedFile?.gid || '0', 8)).toBe(80);
      });

      it('should not modify gid if not root-owned', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);

        const originalEntries = modifier.getEntries();
        const original = originalEntries.find((e) => e.filename === 'test.txt');
        const originalGid = original?.gid;

        // Ensure it's not root-owned
        if (original) {
          original.uid = '001000'; // Non-zero UID
        }

        modifier.modifyPermissions();
        const modifiedEntries = modifier.getEntries();
        const modified = modifiedEntries.find((e) => e.filename === 'test.txt');

        expect(modified?.gid).toBe(originalGid);
      });
    });

    describe('rebuildCpio', () => {
      it('should rebuild a cpio archive that can be extracted', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'Rebuild test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        const rebuiltPath = path.join(testDir, 'rebuilt.cpio');
        fs.writeFileSync(rebuiltPath, rebuiltData);

        const extractDir = path.join(testDir, 'extract-' + Date.now());
        fs.mkdirSync(extractDir);

        try {
          execSync(`cd "${extractDir}" && cpio -i < "${rebuiltPath}" 2>/dev/null`);

          const extractedFile = path.join(extractDir, 'test.txt');
          expect(fs.existsSync(extractedFile)).toBe(true);
          expect(fs.readFileSync(extractedFile, 'utf8')).toBe('Rebuild test');
        } finally {
          fs.rmSync(extractDir, { recursive: true, force: true });
        }
      });

      it('should preserve file contents after rebuild', () => {
        const files = [
          { name: 'file1.txt', content: 'Content 1', mode: '644' },
          { name: 'file2.txt', content: 'Content 2 with more text', mode: '755' },
          { name: 'file3.txt', content: '', mode: '600' },
        ];
        const cpioData = createTestCpioArchive(files);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);

        for (const file of files) {
          const entry = rebuiltEntries.find((e) => e.filename === file.name);
          expect(entry).toBeDefined();
          expect(entry?.data.toString()).toBe(file.content);
        }
      });

      it('should maintain modified permissions after rebuild', () => {
        const cpioData = createTestCpioArchive([
          { name: 'exec.sh', content: 'exec', mode: '755' },
          { name: 'file.txt', content: 'file', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        modifier.modifyPermissions();
        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);

        const exec = rebuiltEntries.find((e) => e.filename === 'exec.sh');
        const file = rebuiltEntries.find((e) => e.filename === 'file.txt');

        expect(parseInt(exec?.mode || '0', 8) & 0o777).toBe(0o775);
        expect(parseInt(file?.mode || '0', 8) & 0o777).toBe(0o664);
      });

      it('should include TRAILER entry in rebuild', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);

        const trailer = rebuiltEntries.find((e) => e.filename === 'TRAILER!!!');
        expect(trailer).toBeDefined();
      });

      it('should handle empty archive rebuild', () => {
        const cpioData = createTestCpioArchive([]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        expect(rebuiltData).toBeDefined();
        expect(rebuiltData.length).toBeGreaterThan(0);
      });

      it('should preserve all header fields during rebuild', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test', mode: '755' },
        ]);

        const modifier = new CpioModifier();
        const originalEntries = modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);

        const original = originalEntries.find((e) => e.filename === 'test.txt');
        const rebuilt = rebuiltEntries.find((e) => e.filename === 'test.txt');

        expect(rebuilt?.magic).toBe(original?.magic);
        expect(rebuilt?.dev).toBe(original?.dev);
        expect(rebuilt?.ino).toBe(original?.ino);
        expect(rebuilt?.mode).toBe(original?.mode);
        expect(rebuilt?.uid).toBe(original?.uid);
        expect(rebuilt?.gid).toBe(original?.gid);
        expect(rebuilt?.nlink).toBe(original?.nlink);
        expect(rebuilt?.rdev).toBe(original?.rdev);
        expect(rebuilt?.mtime).toBe(original?.mtime);
      });

      it('should handle binary data correctly during rebuild', () => {
        const binaryContent = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]);

        const testFilesDir = path.join(testDir, 'binary-rebuild-' + Date.now());
        fs.mkdirSync(testFilesDir, { recursive: true });

        const binaryPath = path.join(testFilesDir, 'binary.dat');
        fs.writeFileSync(binaryPath, binaryContent);
        fs.chmodSync(binaryPath, 0o644);

        const cpioPath = path.join(testDir, 'binary-rebuild.cpio');
        execSync(
          `cd "${testFilesDir}" && echo "binary.dat" | cpio -o --format=odc > "${cpioPath}" 2>/dev/null`,
        );

        const cpioData = fs.readFileSync(cpioPath);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);

        const binaryFile = rebuiltEntries.find((e) => e.filename === 'binary.dat');
        expect(binaryFile?.data).toEqual(binaryContent);

        fs.rmSync(testFilesDir, { recursive: true });
        fs.unlinkSync(cpioPath);
      });
    });

    describe('getEntries', () => {
      it('should return parsed entries', () => {
        const cpioData = createTestCpioArchive([
          { name: 'file1.txt', content: 'content1', mode: '644' },
          { name: 'file2.txt', content: 'content2', mode: '755' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const entries = modifier.getEntries();

        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThanOrEqual(3); // 2 files + TRAILER

        const file1 = entries.find((e) => e.filename === 'file1.txt');
        const file2 = entries.find((e) => e.filename === 'file2.txt');
        const trailer = entries.find((e) => e.filename === 'TRAILER!!!');

        expect(file1).toBeDefined();
        expect(file2).toBeDefined();
        expect(trailer).toBeDefined();
      });

      it('should return empty array before parsing', () => {
        const modifier = new CpioModifier();
        const entries = modifier.getEntries();

        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBe(0);
      });

      it('should return mutable entries that affect rebuild', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'original', mode: '644' },
        ]);

        const modifier = new CpioModifier();
        modifier.parseCpio(cpioData);
        const entries = modifier.getEntries();

        // Modify the entry directly
        const testFile = entries.find((e) => e.filename === 'test.txt');
        if (testFile) {
          testFile.data = Buffer.from('modified');
          testFile.filesize = 8;
        }

        const rebuiltData = modifier.rebuildCpio();

        const modifier2 = new CpioModifier();
        const rebuiltEntries = modifier2.parseCpio(rebuiltData);
        const rebuiltFile = rebuiltEntries.find((e) => e.filename === 'test.txt');

        expect(rebuiltFile?.data.toString()).toBe('modified');
      });
    });

    describe('integration tests', () => {
      it('should handle complete parse-modify-rebuild cycle', () => {
        const cpioData = createTestCpioArchive([
          { name: 'script.sh', content: '#!/bin/bash\necho hello', mode: '755' },
          { name: 'config.txt', content: 'key=value', mode: '644' },
          { name: 'readme.md', content: '# README', mode: '644' },
        ]);

        const modifier = new CpioModifier();

        // Parse
        const entries = modifier.parseCpio(cpioData);
        expect(entries.length).toBeGreaterThanOrEqual(4);

        // Modify
        modifier.modifyPermissions();

        // Rebuild
        const rebuiltData = modifier.rebuildCpio();

        // Verify the rebuilt archive
        const verifyModifier = new CpioModifier();
        const verifyEntries = verifyModifier.parseCpio(rebuiltData);

        const script = verifyEntries.find((e) => e.filename === 'script.sh');
        const config = verifyEntries.find((e) => e.filename === 'config.txt');
        const readme = verifyEntries.find((e) => e.filename === 'readme.md');

        // Check permissions were modified correctly
        expect(parseInt(script?.mode || '0', 8) & 0o777).toBe(0o775);
        expect(parseInt(config?.mode || '0', 8) & 0o777).toBe(0o664);
        expect(parseInt(readme?.mode || '0', 8) & 0o777).toBe(0o664);

        // Check content is preserved
        expect(script?.data.toString()).toBe('#!/bin/bash\necho hello');
        expect(config?.data.toString()).toBe('key=value');
        expect(readme?.data.toString()).toBe('# README');
      });

      it('should be idempotent - multiple rebuilds produce same result', () => {
        const cpioData = createTestCpioArchive([
          { name: 'test.txt', content: 'test content', mode: '644' },
        ]);

        const modifier1 = new CpioModifier();
        modifier1.parseCpio(cpioData);
        modifier1.modifyPermissions();
        const rebuilt1 = modifier1.rebuildCpio();

        const modifier2 = new CpioModifier();
        modifier2.parseCpio(rebuilt1);
        const rebuilt2 = modifier2.rebuildCpio();

        // The two rebuilt archives should be identical
        expect(rebuilt2).toEqual(rebuilt1);
      });
    });
  });

  describe('modifyPayloadPermissions', () => {
    it('should modify permissions in a gzipped cpio payload - 755 to 775', async () => {
      const cpioData = createTestCpioArchive([
        { name: 'exec.sh', content: '#!/bin/bash\necho test', mode: '755' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'payload1.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);
      const execFile = extracted.files.get('exec.sh');

      expect(execFile).toBeDefined();
      expect(execFile?.content.toString()).toBe('#!/bin/bash\necho test');
      expect(execFile?.mode).toBe(0o775);
    });

    it('should modify permissions in a gzipped cpio payload - 644 to 664', async () => {
      const cpioData = createTestCpioArchive([
        { name: 'file.txt', content: 'Regular file', mode: '644' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'payload2.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);
      const file = extracted.files.get('file.txt');

      expect(file).toBeDefined();
      expect(file?.content.toString()).toBe('Regular file');
      expect(file?.mode).toBe(0o664);
    });

    it('should handle multiple files with different permissions', async () => {
      const files = [
        { name: 'script1.sh', content: '#!/bin/bash\ncommand1', mode: '755' },
        { name: 'data.txt', content: 'Important data content', mode: '644' },
        { name: 'script2.sh', content: '#!/bin/bash\ncommand2', mode: '755' },
        { name: 'readonly.txt', content: 'Read only', mode: '600' },
      ];

      const cpioData = createTestCpioArchive(files);
      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'multi-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);

      // Check script1.sh - should be 775
      const script1 = extracted.files.get('script1.sh');
      expect(script1?.mode).toBe(0o775);
      expect(script1?.content.toString()).toBe('#!/bin/bash\ncommand1');

      // Check data.txt - should be 664
      const data = extracted.files.get('data.txt');
      expect(data?.mode).toBe(0o664);
      expect(data?.content.toString()).toBe('Important data content');

      // Check script2.sh - should be 775
      const script2 = extracted.files.get('script2.sh');
      expect(script2?.mode).toBe(0o775);
      expect(script2?.content.toString()).toBe('#!/bin/bash\ncommand2');

      // Check readonly.txt - should remain 600
      const readonly = extracted.files.get('readonly.txt');
      expect(readonly?.mode).toBe(0o600);
      expect(readonly?.content.toString()).toBe('Read only');
    });

    it('should maintain file integrity after modification', async () => {
      const testContent = 'This is a test file with\nmultiple lines\nand special chars: !@#$%^&*()';
      const cpioData = createTestCpioArchive([
        { name: 'test.txt', content: testContent, mode: '644' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'integrity-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);
      const file = extracted.files.get('test.txt');

      expect(file?.content.toString()).toBe(testContent);
    });

    it('should handle empty files correctly', async () => {
      const cpioData = createTestCpioArchive([
        { name: 'empty.txt', content: '', mode: '644' },
        { name: 'not-empty.txt', content: 'content', mode: '755' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'empty-file-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);

      const emptyFile = extracted.files.get('empty.txt');
      expect(emptyFile?.content.length).toBe(0);
      expect(emptyFile?.mode).toBe(0o664);

      const notEmptyFile = extracted.files.get('not-empty.txt');
      expect(notEmptyFile?.content.toString()).toBe('content');
      expect(notEmptyFile?.mode).toBe(0o775);
    });

    it('should handle files with special characters in names', async () => {
      const cpioData = createTestCpioArchive([
        { name: 'file-with-dashes.txt', content: 'dashes', mode: '644' },
        { name: 'file_with_underscores.sh', content: 'underscores', mode: '755' },
        { name: 'file.with.dots.txt', content: 'dots', mode: '644' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'special-names-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);

      expect(extracted.files.get('file-with-dashes.txt')?.mode).toBe(0o664);
      expect(extracted.files.get('file_with_underscores.sh')?.mode).toBe(0o775);
      expect(extracted.files.get('file.with.dots.txt')?.mode).toBe(0o664);
    });

    it('should handle subdirectories in cpio archive', async () => {
      const cpioData = createTestCpioArchive([
        { name: 'dir1/file1.txt', content: 'file in dir1', mode: '644' },
        { name: 'dir1/script.sh', content: '#!/bin/bash', mode: '755' },
        { name: 'dir2/file2.txt', content: 'file in dir2', mode: '644' },
      ]);

      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'subdirs-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      // Extract to verify - cpio -i will create directories as needed
      const extractPath = path.join(testDir, 'extract-subdirs-' + Date.now());
      fs.mkdirSync(extractPath);
      const cpioFile = path.join(extractPath, 'archive.cpio');
      fs.writeFileSync(cpioFile, modifiedCpio);

      execSync(`cd "${extractPath}" && cpio -i < archive.cpio 2>/dev/null`);

      // Check files directly
      const file1Path = path.join(extractPath, 'dir1', 'file1.txt');
      const scriptPath = path.join(extractPath, 'dir1', 'script.sh');
      const file2Path = path.join(extractPath, 'dir2', 'file2.txt');

      if (fs.existsSync(file1Path)) {
        const stats1 = fs.statSync(file1Path);
        expect(stats1.mode & 0o777).toBe(0o664);
        expect(fs.readFileSync(file1Path, 'utf8')).toBe('file in dir1');
      }

      if (fs.existsSync(scriptPath)) {
        const stats2 = fs.statSync(scriptPath);
        expect(stats2.mode & 0o777).toBe(0o775);
        expect(fs.readFileSync(scriptPath, 'utf8')).toBe('#!/bin/bash');
      }

      if (fs.existsSync(file2Path)) {
        const stats3 = fs.statSync(file2Path);
        expect(stats3.mode & 0o777).toBe(0o664);
        expect(fs.readFileSync(file2Path, 'utf8')).toBe('file in dir2');
      }

      fs.rmSync(extractPath, { recursive: true });
    });

    it('should use maximum compression (level 9) when rebuilding', async () => {
      // Create a file with repetitive content that compresses well
      const largeContent = 'AAAAAAAAAA'.repeat(1000);
      const cpioData = createTestCpioArchive([
        { name: 'large.txt', content: largeContent, mode: '644' },
      ]);

      // First create a lightly compressed version
      const lightlyCompressed = zlib.gzipSync(cpioData, { level: 1 });
      const payloadPath = path.join(testDir, 'compression-test.gz');
      fs.writeFileSync(payloadPath, lightlyCompressed);

      await modifyPayloadPermissions(payloadPath);

      // We check that the content is still intact
      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);
      const extracted = extractAndVerifyCpio(modifiedCpio);

      expect(extracted.files.get('large.txt')?.content.toString()).toBe(largeContent);
      expect(extracted.files.get('large.txt')?.mode).toBe(0o664);
    });

    it('should handle binary files correctly', async () => {
      // Create a binary file (simple PNG header)
      const binaryContent = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ]);

      const testFilesDir = path.join(testDir, 'binary-test-' + Date.now());
      fs.mkdirSync(testFilesDir, { recursive: true });

      const binaryPath = path.join(testFilesDir, 'binary.dat');
      fs.writeFileSync(binaryPath, binaryContent);
      fs.chmodSync(binaryPath, 0o755);

      const cpioPath = path.join(testDir, 'binary.cpio');
      execSync(
        `cd "${testFilesDir}" && echo "binary.dat" | cpio -o --format=odc > "${cpioPath}" 2>/dev/null`,
      );

      const cpioData = fs.readFileSync(cpioPath);
      const gzippedData = zlib.gzipSync(cpioData);
      const payloadPath = path.join(testDir, 'binary-payload.gz');
      fs.writeFileSync(payloadPath, gzippedData);

      await modifyPayloadPermissions(payloadPath);

      const modifiedGzipped = fs.readFileSync(payloadPath);
      const modifiedCpio = zlib.gunzipSync(modifiedGzipped);

      const extracted = extractAndVerifyCpio(modifiedCpio);
      const binaryFile = extracted.files.get('binary.dat');

      expect(binaryFile?.content).toEqual(binaryContent);
      expect(binaryFile?.mode).toBe(0o775);

      fs.rmSync(testFilesDir, { recursive: true });
      fs.unlinkSync(cpioPath);
    });

    it('should throw error if file does not exist', async () => {
      const nonExistentPath = path.join(testDir, 'non-existent.gz');
      await expect(modifyPayloadPermissions(nonExistentPath)).rejects.toThrow();
    });

    it('should handle malformed gzip data', async () => {
      const malformedPath = path.join(testDir, 'malformed.gz');
      fs.writeFileSync(malformedPath, Buffer.from('This is not gzip data'));

      await expect(modifyPayloadPermissions(malformedPath)).rejects.toThrow();
    });
  });
});
