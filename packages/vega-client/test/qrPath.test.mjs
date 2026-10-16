// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrToPath, QUIET_ZONE } from '../src/qrPath.ts';

test('produces a single path of unit squares inside a quiet zone', () => {
  const { path, count } = qrToPath('http://192.168.1.20:8787/p/ABCD');
  assert.ok(count > 2 * QUIET_ZONE + 20, 'module count plus border');
  assert.match(path, /^(M\d+ \d+h1v1h-1z)+$/);
  const coords = [...path.matchAll(/M(\d+) (\d+)h/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(coords.length > 100);
  for (const [x, y] of coords) {
    assert.ok(x >= QUIET_ZONE && x < count - QUIET_ZONE);
    assert.ok(y >= QUIET_ZONE && y < count - QUIET_ZONE);
  }
});

test('different values give different codes; same value is deterministic', () => {
  assert.equal(qrToPath('a').path, qrToPath('a').path);
  assert.notEqual(qrToPath('http://x/p/AAAA').path, qrToPath('http://x/p/BBBB').path);
});

test('finder pattern sits in the top-left corner', () => {
  const { path } = qrToPath('hello');
  // the 7-wide finder pattern has dark modules in its first row
  for (let c = 0; c < 7; c++) assert.ok(path.includes(`M${c + QUIET_ZONE} ${QUIET_ZONE}h`));
});
