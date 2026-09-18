/*
  Tests for the key scheme — this is where the DATE FILTER's correctness
  actually lives. The API's "sessions from date X on" works only if
  string comparison on sort keys equals date comparison; these tests pin
  that property down, including the edge cases.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userPK, sessionSK, fromBoundSK, dayPrefixSK, sessionFromItem } from '../src/keys.mjs';

const ID = '11111111-2222-4333-8444-555555555555';

test('keys have the documented shapes', () => {
  assert.equal(userPK('u1'), 'USER#u1');
  assert.equal(sessionSK('2026-09-18', ID), `SESSION#2026-09-18#${ID}`);
  assert.equal(fromBoundSK('2026-09-18'), 'SESSION#2026-09-18');
  assert.equal(dayPrefixSK('2026-09-18'), 'SESSION#2026-09-18#');
});

test('a day prefix matches exactly its own day', () => {
  // The trailing "#" matters: without it, prefix "SESSION#2026-09-1"
  // would also match the 10th through the 19th.
  assert.ok(sessionSK('2026-09-18', ID).startsWith(dayPrefixSK('2026-09-18')));
  assert.ok(!sessionSK('2026-09-19', ID).startsWith(dayPrefixSK('2026-09-18')));
  assert.ok(!sessionSK('2026-09-18', ID).startsWith(dayPrefixSK('2026-09-1')));
});

test('a session ON the from-date is included (bound is inclusive)', () => {
  // String order: "SESSION#2026-09-18#..." >= "SESSION#2026-09-18",
  // because a string always sorts at-or-after its own prefix.
  assert.ok(sessionSK('2026-09-18', ID) >= fromBoundSK('2026-09-18'));
});

test('a session AFTER the from-date is included', () => {
  assert.ok(sessionSK('2026-09-19', ID) >= fromBoundSK('2026-09-18'));
});

test('a session BEFORE the from-date is excluded', () => {
  assert.ok(sessionSK('2026-09-17', ID) < fromBoundSK('2026-09-18'));
});

test('string order equals date order across month and year boundaries', () => {
  // The zero-padding in YYYY-MM-DD is what makes this hold:
  // "2026-10-01" > "2026-09-30" and "2027-01-01" > "2026-12-31" as strings.
  assert.ok(sessionSK('2026-10-01', ID) >= fromBoundSK('2026-09-30'));
  assert.ok(sessionSK('2027-01-01', ID) >= fromBoundSK('2026-12-31'));
  assert.ok(sessionSK('2026-09-30', ID) < fromBoundSK('2026-10-01'));
});

test('sessionFromItem returns payload fields only, never PK/SK', () => {
  const item = {
    PK: 'USER#u1', SK: `SESSION#2026-09-18#${ID}`,
    sessionId: ID, startedAt: '2026-09-18T20:00:00.000Z',
    minutes: 50, localDate: '2026-09-18',
  };
  assert.deepEqual(sessionFromItem(item), {
    sessionId: ID, startedAt: '2026-09-18T20:00:00.000Z',
    minutes: 50, localDate: '2026-09-18',
  });
});
