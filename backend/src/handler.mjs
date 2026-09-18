/*
  The API's request handling: routing, validation, and responses.

  This file knows NOTHING about DynamoDB. It receives a `store` object
  (anything with putSession/listSessions/listDaySessionIds) through
  makeHandler — dependency injection, exactly like taking an abstract
  interface in a C++ constructor. In production index.mjs passes the real
  DynamoDB store; in unit tests we pass a fake — which is how all of this
  logic gets tested without AWS.

  The clock is injected the same way (`now`, defaulting to Date.now) so
  tests can pin "today" and stay deterministic forever.

  The `event` parameter is API Gateway's "payload format 2.0": a plain
  object describing the HTTP request (method, path, headers with
  lowercased names, query parameters, body).
*/

import { isUuid, isLocalDate, isIsoTimestamp, isMinutes } from './validation.mjs';

// Real requests are ~200 bytes; anything bigger is not our client.
const MAX_BODY_BYTES = 2048;

/*
  Abuse limits (added after security review — see NOTES.md). The API is
  public and the caller is anonymous, so every request must carry a
  bounded worst-case cost, or a stranger with curl could grow one user's
  data forever and then make each read bill thousands of DynamoDB read
  units against the fixed credit pool.
*/
// A day has 1440 minutes = at most ~29 fifty-minute blocks. 30 is
// "physically impossible to exceed honestly".
const MAX_SESSIONS_PER_DAY = 30;
// POSTed localDates must be near today: wide enough for every timezone
// and a tab reopened days later, far too narrow to scatter junk across
// decades of invisible dates.
const POST_PAST_DAYS = 7;
const POST_FUTURE_DAYS = 2;
// GETs may look back far enough for any grid (26 weeks = 182 days) with
// room to grow, but not back to year 0100.
const GET_MAX_AGE_DAYS = 400;

export function makeHandler(store, now = Date.now) {
  return async function handle(event) {
    try {
      const method = event.requestContext?.http?.method;
      const path = event.rawPath;
      // ?. is optional chaining: "if the left side is null/undefined,
      // give undefined instead of crashing" — a null-safe arrow operator.

      // Every route requires a caller identity (phase 1: an anonymous
      // UUID the browser invented — see CLAUDE.md on its limits).
      const userId = event.headers?.['x-user-id'];
      if (!isUuid(userId)) {
        return reply(400, { message: 'X-User-Id header must be a UUID' });
      }

      if (method === 'POST' && path === '/sessions') {
        return await postSession(store, userId, event, now);
      }
      if (method === 'GET' && path === '/sessions') {
        return await getSessions(store, userId, event, now);
      }
      return reply(404, { message: 'Not found' });
    } catch (err) {
      // Anything unexpected: log the details for CloudWatch, tell the
      // caller only that something failed (no internals in responses).
      console.error('Unhandled error:', err);
      return reply(500, { message: 'Internal error' });
    }
  };
}

// "YYYY-MM-DD" (UTC) for `deltaDays` days after the given moment;
// negative deltas go into the past. Used for the date-window checks —
// zero-padded date strings compare correctly as plain strings.
function dateStringPlusDays(nowMs, deltaDays) {
  return new Date(nowMs + deltaDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/*
  POST /sessions — body { sessionId, startedAt, minutes, localDate }.
  Returns 201 when stored, 200 when that sessionId already existed
  (a retried request must not double count — same rule the browser's
  storage module has enforced since Stage 1).
*/
async function postSession(store, userId, event, now) {
  // API Gateway may hand us the body base64-encoded (a flag says so).
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;

  // Buffer.byteLength counts actual UTF-8 bytes; string .length counts
  // UTF-16 code units, which can be 3x smaller for non-ASCII text.
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return reply(400, { message: 'Body too large' });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { message: 'Body must be valid JSON' });
  }
  if (typeof body !== 'object' || body === null) {
    return reply(400, { message: 'Body must be a JSON object' });
  }

  // Validate every field, with a message that names the offender —
  // "400 Bad Request: your fault, and here's why".
  if (!isUuid(body.sessionId))         return reply(400, { message: 'sessionId must be a UUID' });
  if (!isIsoTimestamp(body.startedAt)) return reply(400, { message: 'startedAt must be an ISO 8601 timestamp' });
  if (!isMinutes(body.minutes))        return reply(400, { message: 'minutes must be an integer from 1 to 180' });
  if (!isLocalDate(body.localDate))    return reply(400, { message: 'localDate must be a real YYYY-MM-DD date' });

  // The date must be near today (see the constants above for why).
  const nowMs = now();
  if (body.localDate < dateStringPlusDays(nowMs, -POST_PAST_DAYS)
    || body.localDate > dateStringPlusDays(nowMs, POST_FUTURE_DAYS)) {
    return reply(400, { message: 'localDate must be within a few days of today' });
  }

  // Rebuild the object from validated fields only — anything extra a
  // caller smuggled into the JSON is dropped here, never stored.
  const session = {
    sessionId: body.sessionId,
    startedAt: body.startedAt,
    minutes: body.minutes,
    localDate: body.localDate,
  };

  /*
    The daily cap. One cheap keys-only query tells us what that day
    already holds; a RETRY of an already-stored session must still fall
    through to the conditional put so it can answer 200, so the cap only
    blocks ids we have not seen. (Two simultaneous first-time posts could
    in theory both pass the check — the cap is approximate by one or two,
    which is fine: its job is stopping thousands, not the 31st.)
  */
  const existingIds = await store.listDaySessionIds(userId, session.localDate);
  if (existingIds.length >= MAX_SESSIONS_PER_DAY && !existingIds.includes(session.sessionId)) {
    return reply(400, { message: 'Daily session limit reached' });
  }

  const created = await store.putSession(userId, session);
  return reply(created ? 201 : 200, { sessionId: session.sessionId, duplicate: !created });
}

/*
  GET /sessions?from=YYYY-MM-DD — that user's sessions from the date on.
  `from` is required and must be recent-ish: the client always knows what
  window it wants, and an unbounded "everything forever" query is exactly
  the read-amplification the security review flagged.
*/
async function getSessions(store, userId, event, now) {
  const from = event.queryStringParameters?.from;
  if (!isLocalDate(from)) {
    return reply(400, { message: "Query parameter 'from' must be a real YYYY-MM-DD date" });
  }
  if (from < dateStringPlusDays(now(), -GET_MAX_AGE_DAYS)) {
    return reply(400, { message: `'from' must be within the last ${GET_MAX_AGE_DAYS} days` });
  }
  const sessions = await store.listSessions(userId, from);
  return reply(200, { sessions });
}

// One place builds every response, so the shape is always the same.
function reply(statusCode, bodyObject) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObject),
  };
}
