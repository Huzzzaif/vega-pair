// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineBuffer } from '../src/lineBuffer.ts';

test('a complete message yields one line', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"a":1}\n'), ['{"a":1}']);
});

test('a message split across several chunks is reassembled', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"type":"mess'), []);
  assert.deepEqual(b.push('age","data":"abc'), []);
  assert.deepEqual(b.push('"}\n'), ['{"type":"message","data":"abc"}']);
});

test('several messages in one chunk are all returned, in order', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"n":1}\n{"n":2}\n{"n":3}\n'), ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test('a chunk ending mid-message keeps the remainder for the next push', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"n":1}\n{"n":'), ['{"n":1}']);
  assert.deepEqual(b.push('2}\n'), ['{"n":2}']);
});

test('split exactly on the newline works', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"n":1}'), []);
  assert.deepEqual(b.push('\n'), ['{"n":1}']);
});

test('blank lines and whitespace-only lines are dropped', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('\n  \n{"n":1}\n\n'), ['{"n":1}']);
});

test('messages without a trailing newline are held back', () => {
  const b = createLineBuffer();
  assert.deepEqual(b.push('{"n":1}'), []);
});

test('reset drops a partial line', () => {
  const b = createLineBuffer();
  b.push('{"half');
  b.reset();
  assert.deepEqual(b.push('{"n":1}\n'), ['{"n":1}']);
});

test('byte-by-byte delivery of a large message still parses', () => {
  const b = createLineBuffer();
  const payload = JSON.stringify({ type: 'message', data: { text: 'é'.repeat(3000) } }) + '\n';
  const out = [];
  for (const ch of payload) out.push(...b.push(ch));
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).data.text.length, 3000);
});
