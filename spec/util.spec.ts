import child from 'node:child_process';
import debug from 'debug';
import { execFileAsync, debugLog } from '../src/util.js';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

describe('execFileAsync()', () => {
  beforeAll(() => {
    debug.enable('electron-osx-sign');
  });

  beforeEach(() => {
    vi.spyOn(debugLog, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves stdout and logs the redacted args', async () => {
    const logSpy = debugLog.log as unknown as { mock: { calls: any[][] } };
    const fakeStdout = 'all good\n';

    vi.spyOn(child, 'execFile').mockImplementation((file, args, options, cb: any) => {
      cb(null, fakeStdout, '');
      return {} as any;
    });

    const result = await execFileAsync('foobar', ['--password', 'hunter2', '--foo=bar']);
    expect(result).toBe(fakeStdout);

    const [firstArg, cmdArg, redactedArg] = logSpy.mock.calls[0];

    expect(firstArg).toMatch(/Executing\.\.\.$/);
    expect(cmdArg).toBe('foobar');
    expect(redactedArg).toBe('--password *** --foo=bar');
  });

  it('redacts multiple secret flags (including space-containing values)', async () => {
    const logSpy = debugLog.log as unknown as { mock: { calls: any[][] } };

    vi.spyOn(child, 'execFile').mockImplementation((file, args, options, cb: any) => {
      cb(null, 'done', '');
      return {} as any;
    });

    const args = [
      'mytool',
      '--password=complex pass here',
      '-P',
      'secret PW',
      '-pass',
      'another secret',
      '/p',
      'pw1',
      'pass:',
      'pw2',
      '--other=ok',
    ];

    await execFileAsync('mytool', args);

    const [firstArg, cmdArg, redactedArg] = logSpy.mock.calls[0];

    expect(firstArg).toMatch(/Executing\.\.\.$/);
    expect(cmdArg).toBe('mytool');
    expect(redactedArg).toBe('mytool --password=*** -P *** -pass *** /p *** pass: *** --other=ok');
  });
});
