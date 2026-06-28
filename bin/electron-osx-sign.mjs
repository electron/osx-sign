#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sign } from '../dist/sign.js';

const { values, positionals } = parseArgs({
  options: {
    'signature-flags': { type: 'string' },
    ignore: { type: 'string', multiple: true },
    help: { type: 'boolean' },
    'pre-auto-entitlements': { type: 'boolean', default: true },
    'pre-embed-provisioning-profile': { type: 'boolean', default: true },
    'hardened-runtime': { type: 'boolean' },
    restrict: { type: 'boolean' },
  },
  allowPositionals: true,
});

const app = positionals.shift();
const binaries = positionals;

if (!app || values.help) {
  const usage = fs
    .readFileSync(path.join(import.meta.dirname, 'electron-osx-sign-usage.txt'))
    .toString();
  console.log(usage);
  process.exit(0);
} else {
  try {
    /** @type {import('../dist/types.js').SignOptions} */
    const opts = { app, binaries };
    if (values.ignore) opts.ignore = values.ignore;
    if (values['signature-flags']) {
      const signatureFlags = values['signature-flags'];
      opts.optionsForFile = () => ({ signatureFlags });
    }
    await sign(opts);
    console.log(`Application signed: ${app}`);
    process.exit(0);
  } catch (err) {
    console.error('Sign failed:');
    if (err.message) console.error(err.message);
    else if (err.stack) console.error(err.stack);
    else console.log(err);
    process.exit(1);
  }
}
