/*
  Unit tests for the request handler — run from the repo root with:

      node --test backend/test/*.test.mjs

  (Passing the directory itself, `node --test backend/test/`, runs ZERO
  tests on Node 24 — the runner treats the path as a test file. The
  review caught that the hard way; use the glob.)

  node:test and node:assert are BUILT INTO Node (like having a test
  framework in the standard library) — no packages to install.

  Note what's imported: handler.mjs only. Never store.mjs (that would pull
  in the AWS SDK); instead each test injects a FAKE store that records how
  it was called. That's the payoff of the dependency-injection seam.
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/handler.mjs';

/* ---- test scaffolding ------------------------------------------------- */

const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const GOOD_SESSION = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  startedAt: '2026-09-18T20:52:22.330Z',
  minutes: 50,
  localDate: '2026-09-18',
};

// The handler takes an injected clock, so tests pin "today" forever —
// they must not start failing when the real date drifts past the
// handler's date windows.
const NOW = () => Date.parse('2026-09-18T12:00:00.000Z');

// A fake store: default happy-path behavior, overridable per test, and it
// records every call so tests can assert what reached the "database".
function fakeStore(overrides = {}) {
  const calls = { put: [], list: [], dayIds: [] };
  return {
    calls,
    async putSession(userId, session) {
      calls.put.push({ userId, session });
      return overrides.putReturns ?? true;
    },
    async listSessions(userId, fromDate) {
      calls.list.push({ userId, fromDate });
      return overrides.listReturns ?? [];
    },
    async listDaySessionIds(userId, localDate) {
      calls.dayIds.push({ userId, localDate });
      return overrides.dayIdsReturns ?? [];
    },
    ...overrides.methods,
  };
}

function handlerWith(store) {
  return makeHandler(store, NOW);
}

/*
  Build an API Gateway "payload 2.0" event with sensible defaults. In
  phase 2 identity arrives as the verified JWT's claims, which the
  gateway attaches under requestContext.authorizer — that's what we fake.
  CAREFUL LESSON (a reviewer caught this): a destructuring default like
  `userId = USER` also replaces an EXPLICITLY passed undefined, so the
  sentinel for "no verified identity" is null, which defaults leave alone.
*/
function mkEvent({ method = 'POST', path = '/sessions', userId = USER,
                   body, query } = {}) {
  return {
    rawPath: path,
    requestContext: {
      http: { method },
      ...(userId === null ? {} : { authorizer: { jwt: { claims: { sub: userId } } } }),
    },
    headers: {},
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function parse(res) {
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/* ---- identity ---------------------------------------------------------- */
// The gateway's JWT authorizer normally guarantees a verified identity;
// these tests cover the defensive check for a misconfigured route. Both
// carry a fully VALID body, so only the identity check can cause the
// asserted status — delete that check from handler.mjs and these fail.

test('rejects a request with no verified identity: 401, stores nothing', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status, body } = parse(
    await handle(mkEvent({ userId: null, body: GOOD_SESSION })));
  assert.equal(status, 401);
  assert.match(body.message, /authenticated/i);
  assert.equal(store.calls.put.length, 0);
});

test('rejects a non-UUID sub claim: 401, stores nothing', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status, body } = parse(
    await handle(mkEvent({ userId: 'alice', body: GOOD_SESSION })));
  assert.equal(status, 401);
  assert.match(body.message, /authenticated/i);
  assert.equal(store.calls.put.length, 0);
});

/* ---- POST /sessions: the happy path and the duplicate case ------------- */

test('stores a valid session and answers 201', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 201);
  assert.equal(body.duplicate, false);
  // Exactly one write, for the right user, with exactly the four fields.
  assert.equal(store.calls.put.length, 1);
  assert.equal(store.calls.put[0].userId, USER);
  assert.deepEqual(store.calls.put[0].session, GOOD_SESSION);
});

test('answers 200 (not 201) when the session already exists', async () => {
  const store = fakeStore({ putReturns: false }); // store says "was already there"
  const handle = handlerWith(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 200);
  assert.equal(body.duplicate, true);
});

test('drops fields the client smuggled in beside the valid ones', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  await handle(mkEvent({ body: { ...GOOD_SESSION, role: 'admin', pwned: true } }));

  assert.deepEqual(Object.keys(store.calls.put[0].session).sort(),
    ['localDate', 'minutes', 'sessionId', 'startedAt']);
});

/* ---- POST /sessions: validation rejections ------------------------------ */

const BAD_BODIES = [
  ['sessionId not a UUID',      { ...GOOD_SESSION, sessionId: '123' }],
  ['startedAt not ISO 8601',    { ...GOOD_SESSION, startedAt: 'yesterday' }],
  ['startedAt bare year',       { ...GOOD_SESSION, startedAt: '2026' }],
  ['minutes zero',              { ...GOOD_SESSION, minutes: 0 }],
  ['minutes above the 180 cap', { ...GOOD_SESSION, minutes: 181 }],
  ['minutes fractional',        { ...GOOD_SESSION, minutes: 12.5 }],
  ['minutes as a string',       { ...GOOD_SESSION, minutes: '50' }],
  ['localDate malformed',       { ...GOOD_SESSION, localDate: '18-09-2026' }],
  ['localDate impossible',      { ...GOOD_SESSION, localDate: '2026-02-31' }],
];

for (const [name, body] of BAD_BODIES) {
  test(`rejects ${name} with 400 and stores nothing`, async () => {
    const store = fakeStore();
    const handle = handlerWith(store);
    const { status } = parse(await handle(mkEvent({ body })));
    assert.equal(status, 400);
    assert.equal(store.calls.put.length, 0);
  });
}

test('rejects a body that is not JSON with 400', async () => {
  const handle = handlerWith(fakeStore());
  const event = { ...mkEvent({}), body: 'not json {' };
  assert.equal(parse(await handle(event)).status, 400);
});

// Both size tests use VALID JSON (the review caught earlier versions
// using garbage strings, which passed via the JSON-parse 400 and proved
// nothing about the size guard itself).

test('rejects an oversized body with 400 before storing anything', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const event = { ...mkEvent({}), body: JSON.stringify({ sessionId: 'x'.repeat(3000) }) };
  assert.equal(parse(await handle(event)).status, 400);
  assert.equal(store.calls.put.length, 0);
});

test('measures the body limit in bytes, not string length', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  // Valid JSON whose UTF-16 length (~920) is under the 2048 cap but whose
  // UTF-8 size (~2,700 bytes) is over it: a .length guard would wrongly
  // accept this; the byte-counting guard must refuse it.
  const event = { ...mkEvent({}), body: JSON.stringify({ sessionId: '見'.repeat(900) }) };
  assert.equal(parse(await handle(event)).status, 400);
  assert.equal(store.calls.put.length, 0);
});

test('decodes a base64-encoded body before parsing', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const event = {
    ...mkEvent({}),
    body: Buffer.from(JSON.stringify(GOOD_SESSION), 'utf8').toString('base64'),
    isBase64Encoded: true,
  };
  assert.equal(parse(await handle(event)).status, 201);
  assert.equal(store.calls.put.length, 1);
});

/* ---- POST /sessions: abuse limits (from the security review) ------------ */

test('accepts a localDate from weeks ago (signed-out study is delivered late)', async () => {
  const handle = handlerWith(fakeStore());
  const { status } = parse(await handle(
    mkEvent({ body: { ...GOOD_SESSION, localDate: '2026-08-01' } })));
  assert.equal(status, 201);
});

test('rejects a localDate beyond the 400-day window', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status } = parse(await handle(
    mkEvent({ body: { ...GOOD_SESSION, localDate: '2025-01-01' } })));
  assert.equal(status, 400);
  assert.equal(store.calls.put.length, 0);
});

test('rejects a localDate in the far future', async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status } = parse(await handle(
    mkEvent({ body: { ...GOOD_SESSION, localDate: '2026-10-15' } })));
  assert.equal(status, 400);
  assert.equal(store.calls.put.length, 0);
});

test('accepts yesterday and tomorrow (timezone slack around today)', async () => {
  const handle = handlerWith(fakeStore());
  for (const localDate of ['2026-09-17', '2026-09-19']) {
    const { status } = parse(await handle(
      mkEvent({ body: { ...GOOD_SESSION, localDate } })));
    assert.equal(status, 201, localDate);
  }
});

function manyIds(n) {
  // Valid, distinct UUIDs: vary the last block.
  return Array.from({ length: n }, (_, i) =>
    `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`);
}

test('rejects the 31st distinct session of one day (daily cap)', async () => {
  const store = fakeStore({ dayIdsReturns: manyIds(30) });
  const handle = handlerWith(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 400);
  assert.match(body.message, /limit/i);
  assert.equal(store.calls.put.length, 0);
});

test('a RETRY of an already-stored session still answers 200 at the cap', async () => {
  // The day is full AND this very sessionId is among the stored ones:
  // idempotency must win over the cap.
  const store = fakeStore({
    dayIdsReturns: [...manyIds(29), GOOD_SESSION.sessionId],
    putReturns: false,
  });
  const handle = handlerWith(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 200);
  assert.equal(body.duplicate, true);
});

/* ---- GET /sessions: the date filter reaches the store ------------------- */

test('lists sessions from the requested date for the right user', async () => {
  const sessions = [GOOD_SESSION];
  const store = fakeStore({ listReturns: sessions });
  const handle = handlerWith(store);
  const { status, body } = parse(
    await handle(mkEvent({ method: 'GET', query: { from: '2026-03-01' } })));

  assert.equal(status, 200);
  assert.deepEqual(body.sessions, sessions);
  assert.deepEqual(store.calls.list, [{ userId: USER, fromDate: '2026-03-01' }]);
});

test("rejects GET without a 'from' date", async () => {
  const handle = handlerWith(fakeStore());
  const { status } = parse(await handle(mkEvent({ method: 'GET' })));
  assert.equal(status, 400);
});

test("rejects GET with a malformed 'from'", async () => {
  const handle = handlerWith(fakeStore());
  const { status } = parse(
    await handle(mkEvent({ method: 'GET', query: { from: 'March 1st' } })));
  assert.equal(status, 400);
});

test("rejects GET with a 'from' older than the allowed window", async () => {
  const store = fakeStore();
  const handle = handlerWith(store);
  const { status } = parse(
    await handle(mkEvent({ method: 'GET', query: { from: '2020-01-01' } })));
  assert.equal(status, 400);
  assert.equal(store.calls.list.length, 0);
});

/* ---- routing and failure behavior --------------------------------------- */

test('the removed /migrate endpoint answers 404 like any unknown path', async () => {
  // The migration endpoint was cut after security review (see
  // handler.mjs); this pins that it stays gone.
  const handle = handlerWith(fakeStore());
  const { status } = parse(await handle(
    mkEvent({ path: '/migrate', body: { fromUserId: USER } })));
  assert.equal(status, 404);
});

test('answers 404 for unknown paths', async () => {
  const handle = handlerWith(fakeStore());
  const { status } = parse(await handle(mkEvent({ path: '/other' })));
  assert.equal(status, 404);
});

test('a store failure becomes a 500 with no internals leaked', async () => {
  const store = fakeStore({
    methods: { putSession: async () => { throw new Error('socket timeout to 10.0.0.7'); } },
  });
  const handle = handlerWith(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 500);
  // The caller learns nothing about our insides.
  assert.equal(JSON.stringify(body).includes('10.0.0.7'), false);
});
