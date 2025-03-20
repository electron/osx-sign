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
  },
  allowPositionals: true,
});

const app = positionals.shift();

if (!app || values.help || positionals.length > 0) {
  const usage = fs.readFileSync(path.join(__dirname, 'electron-osx-flat-usage.txt')).toString();
  console.log(usage);
  process.exit(0);
}

try {
  await flat({ app });
  // This is the default value inferred in the `flat` function.
  console.log(
    `Application flattened, saved to: ${path.join(path.dirname(app), path.basename(app, '.app') + '.pkg')}`,
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
