/*
  Unit tests for the request handler — run with:  node --test backend/test/

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

// A fake store: default happy-path behavior, overridable per test, and it
// records every call so tests can assert what reached the "database".
function fakeStore(overrides = {}) {
  const calls = { put: [], list: [] };
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
    ...overrides.methods,
  };
}

// Build an API Gateway "payload 2.0" event with sensible defaults.
function mkEvent({ method = 'POST', path = '/sessions', userId = USER,
                   body, query } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: userId === undefined ? {} : { 'x-user-id': userId },
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function parse(res) {
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

/* ---- identity --------------------------------------------------------- */

test('rejects a missing X-User-Id header with 400', async () => {
  const handle = makeHandler(fakeStore());
  const { status } = parse(await handle(mkEvent({ userId: undefined })));
  assert.equal(status, 400);
});

test('rejects a non-UUID X-User-Id with 400', async () => {
  const handle = makeHandler(fakeStore());
  const { status } = parse(await handle(mkEvent({ userId: 'alice' })));
  assert.equal(status, 400);
});

/* ---- POST /sessions: the happy path and the duplicate case ------------ */

test('stores a valid session and answers 201', async () => {
  const store = fakeStore();
  const handle = makeHandler(store);
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
  const handle = makeHandler(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 200);
  assert.equal(body.duplicate, true);
});

test('drops fields the client smuggled in beside the valid ones', async () => {
  const store = fakeStore();
  const handle = makeHandler(store);
  await handle(mkEvent({ body: { ...GOOD_SESSION, role: 'admin', pwned: true } }));

  assert.deepEqual(Object.keys(store.calls.put[0].session).sort(),
    ['localDate', 'minutes', 'sessionId', 'startedAt']);
});

/* ---- POST /sessions: validation rejections ---------------------------- */

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
    const handle = makeHandler(store);
    const { status } = parse(await handle(mkEvent({ body })));
    assert.equal(status, 400);
    assert.equal(store.calls.put.length, 0);
  });
}

test('rejects a body that is not JSON with 400', async () => {
  const handle = makeHandler(fakeStore());
  const event = { ...mkEvent({}), body: 'not json {' };
  assert.equal(parse(await handle(event)).status, 400);
});

test('rejects an oversized body with 400', async () => {
  const handle = makeHandler(fakeStore());
  const event = { ...mkEvent({}), body: 'x'.repeat(3000) };
  assert.equal(parse(await handle(event)).status, 400);
});

test('decodes a base64-encoded body before parsing', async () => {
  const store = fakeStore();
  const handle = makeHandler(store);
  const event = {
    ...mkEvent({}),
    body: Buffer.from(JSON.stringify(GOOD_SESSION), 'utf8').toString('base64'),
    isBase64Encoded: true,
  };
  assert.equal(parse(await handle(event)).status, 201);
  assert.equal(store.calls.put.length, 1);
});

/* ---- GET /sessions: the date filter reaches the store ------------------ */

test('lists sessions from the requested date for the right user', async () => {
  const sessions = [GOOD_SESSION];
  const store = fakeStore({ listReturns: sessions });
  const handle = makeHandler(store);
  const { status, body } = parse(
    await handle(mkEvent({ method: 'GET', query: { from: '2026-03-01' } })));

  assert.equal(status, 200);
  assert.deepEqual(body.sessions, sessions);
  assert.deepEqual(store.calls.list, [{ userId: USER, fromDate: '2026-03-01' }]);
});

test("rejects GET without a 'from' date", async () => {
  const handle = makeHandler(fakeStore());
  const { status } = parse(await handle(mkEvent({ method: 'GET' })));
  assert.equal(status, 400);
});

test("rejects GET with a malformed 'from'", async () => {
  const handle = makeHandler(fakeStore());
  const { status } = parse(
    await handle(mkEvent({ method: 'GET', query: { from: 'March 1st' } })));
  assert.equal(status, 400);
});

/* ---- routing and failure behavior -------------------------------------- */

test('answers 404 for unknown paths', async () => {
  const handle = makeHandler(fakeStore());
  const { status } = parse(await handle(mkEvent({ path: '/other' })));
  assert.equal(status, 404);
});

test('a store failure becomes a 500 with no internals leaked', async () => {
  const store = fakeStore({
    methods: { putSession: async () => { throw new Error('socket timeout to 10.0.0.7'); } },
  });
  const handle = makeHandler(store);
  const { status, body } = parse(await handle(mkEvent({ body: GOOD_SESSION })));

  assert.equal(status, 500);
  // The caller learns nothing about our insides.
  assert.equal(JSON.stringify(body).includes('10.0.0.7'), false);
});
