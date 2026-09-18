/*
  Tests for the pure validators — the tightest loop in the test suite:
  a value goes in, a boolean comes out.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUuid, isLocalDate, isIsoTimestamp, isMinutes } from '../src/validation.mjs';

test('isUuid accepts real UUIDs, either case', () => {
  assert.ok(isUuid('b57c9e1a-8c3f-4b0e-9d21-0f6a2f9c1e77'));
  assert.ok(isUuid('B57C9E1A-8C3F-4B0E-9D21-0F6A2F9C1E77'));
});

test('isUuid rejects non-strings and wrong shapes', () => {
  for (const bad of [null, undefined, 42, {}, '', 'abc',
    'b57c9e1a8c3f4b0e9d210f6a2f9c1e77',      // no dashes
    'b57c9e1a-8c3f-4b0e-9d21-0f6a2f9c1e7']) { // one char short
    assert.equal(isUuid(bad), false, String(bad));
  }
});

test('isLocalDate accepts real calendar dates', () => {
  assert.ok(isLocalDate('2026-09-18'));
  assert.ok(isLocalDate('2024-02-29')); // leap day in a leap year
});

test('isLocalDate rejects impossible or malformed dates', () => {
  for (const bad of ['2026-02-31',   // February 31st
    '2023-02-29',                     // leap day in a non-leap year
    '2026-13-01', '2026-00-10', '18-09-2026',
    '2026-9-8',                       // missing zero padding
    '', null, 20260918]) {
    assert.equal(isLocalDate(bad), false, String(bad));
  }
});

test('isIsoTimestamp accepts full ISO 8601 timestamps', () => {
  assert.ok(isIsoTimestamp('2026-09-18T20:52:22.330Z'));
  assert.ok(isIsoTimestamp('2026-09-18T20:52:22Z'));
  assert.ok(isIsoTimestamp('2026-09-18T13:52:22-07:00'));
});

test('isIsoTimestamp rejects loose or partial strings', () => {
  for (const bad of ['2026', '2026-09-18', 'yesterday',
    '2026-09-18 20:52:22',            // space instead of T
    '2026-09-18T20:52:22',            // no timezone
    '2026-13-40T99:99:99Z',           // shape ok-ish but not a real moment
    null, 1758228742000]) {
    assert.equal(isIsoTimestamp(bad), false, String(bad));
  }
});

test('isMinutes accepts integers 1..180 only', () => {
  assert.ok(isMinutes(1));
  assert.ok(isMinutes(50));
  assert.ok(isMinutes(180));
  for (const bad of [0, -5, 181, 12.5, '50', NaN, Infinity, null]) {
    assert.equal(isMinutes(bad), false, String(bad));
  }
});
