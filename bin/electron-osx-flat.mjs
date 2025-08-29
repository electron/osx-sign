#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { flat } from '../dist/flat.js';

const { values, positionals } = parseArgs({
  options: {
    help: {
      type: 'boolean',
      default: false,
    },
    identity: {
      type: 'string',
    },
    identityValidation: {
      type: 'boolean',
      default: false,
    },
    keychain: {
      type: 'string',
    },
    platform: {
      type: 'string',
    },
    pkg: {
      type: 'string',
    },
    scripts: {
      type: 'string',
    },
    openPermissionsForSquirrelMac: {
      type: 'boolean',
      default: false,
    },
  },
  allowPositionals: true,
});

const app = positionals.shift();

const { help, ...opts } = values;

if (!app || help || positionals.length > 0) {
  const usage = fs
    .readFileSync(path.join(import.meta.dirname, 'electron-osx-flat-usage.txt'))
    .toString();
  console.log(usage);
  process.exit(0);
}

try {
  // @ts-ignore
  await flat({ app, ...opts });
  // This is the default value inferred in the `flat` function.
  console.log(
    `Application flattened, saved to: ${path.join(path.dirname(app), opts.pkg || (path.basename(app, '.app') + '.pkg'))}`,
  );
  process.exit(0);
} catch (err) {
  if (err) {
    console.error('Flat failed:');
    if (err.message) console.error(err.message);
    else if (err.stack) console.error(err.stack);
    else console.log(err);
    process.exit(1);
  }
}
