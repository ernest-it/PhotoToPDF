'use strict';

// Generate build/license.txt (the text the Windows installer shows) from LICENSE.
//
// NSIS renders plain text only — it can't display Markdown, so headings and link
// syntax would show up as literal `##` and `[...](...)` noise. This strips the
// formatting and wraps to fit the installer's license box. It runs as part of
// `npm run dist`, so the installer text can never drift from the real LICENSE.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const WRAP = 78;

function wrap(line) {
  if (line.length <= WRAP) return [line];
  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && (current + ' ' + word).length > WRAP) { out.push(current); current = word; }
    else current = current ? current + ' ' + word : word;
  }
  if (current) out.push(current);
  return out;
}

// NSIS's license control is not reliably UTF-8, so fold typographic punctuation
// down to ASCII rather than risk mojibake in the one text people must agree to.
function toAscii(s) {
  return s
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
}

const source = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');

const lines = [];
for (const raw of toAscii(source).split('\n')) {
  const text = raw
    .replace(/^#{1,6}\s+/, '')            // headings -> plain lines
    .replace(/^>\s?/, '    ')             // blockquote -> indent
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic markers
    .replace(/`([^`]*)`/g, '$1')          // code ticks
    .replace(/^<(https?:[^>]+)>$/, '$1'); // <url> -> url
  lines.push(...wrap(text.trimEnd()));
}

// CRLF: NSIS's license control expects Windows line endings.
const outPath = path.join(root, 'build', 'license.txt');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\r\n').replace(/(\r\n){3,}/g, '\r\n\r\n') + '\r\n');
console.log(`wrote ${path.relative(root, outPath)} (${lines.length} lines)`);
