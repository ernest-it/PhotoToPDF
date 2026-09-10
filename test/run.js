'use strict';

// `npm test`: run every *.test.js in this folder, each in its own child
// process, so one suite crashing (a WASM decoder running out of memory, say)
// doesn't take the rest down with it. The end-to-end build suite runs last —
// when a decoder is broken you want to read that failure first.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const suites = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort((a, b) => (a === 'build.test.js') - (b === 'build.test.js') || a.localeCompare(b));

const failed = [];
for (const suite of suites) {
  console.log(`\n──── ${suite} ${'─'.repeat(Math.max(0, 40 - suite.length))}`);
  const run = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (run.status !== 0) failed.push(suite);
}

console.log('');
if (failed.length) {
  console.error(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`all ${suites.length} suite(s) passed`);
