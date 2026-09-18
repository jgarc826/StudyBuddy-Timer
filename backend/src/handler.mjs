/*
  The API's request handling: routing, validation, and responses.

  This file knows NOTHING about DynamoDB. It receives a `store` object
  (anything with putSession/listSessions) through makeHandler — dependency
  injection, exactly like taking an abstract interface in a C++
  constructor. In production index.mjs passes the real DynamoDB store; in
  unit tests we pass a fake — which is how all of this logic gets tested
  without AWS.

  The `event` parameter is API Gateway's "payload format 2.0": a plain
  object describing the HTTP request (method, path, headers with
  lowercased names, query parameters, body).
*/

import { isUuid, isLocalDate, isIsoTimestamp, isMinutes } from './validation.mjs';

// Real requests are ~200 bytes; anything bigger is not our client.
const MAX_BODY_BYTES = 2048;

export function makeHandler(store) {
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
        return await postSession(store, userId, event);
      }
      if (method === 'GET' && path === '/sessions') {
        return await getSessions(store, userId, event);
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

/*
  POST /sessions — body { sessionId, startedAt, minutes, localDate }.
  Returns 201 when stored, 200 when that sessionId already existed
  (a retried request must not double count — same rule the browser's
  storage module has enforced since Stage 1).
*/
async function postSession(store, userId, event) {
  // API Gateway may hand us the body base64-encoded (a flag says so).
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;

  if (text.length > MAX_BODY_BYTES) {
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
  if (!isUuid(body.sessionId))        return reply(400, { message: 'sessionId must be a UUID' });
  if (!isIsoTimestamp(body.startedAt)) return reply(400, { message: 'startedAt must be an ISO 8601 timestamp' });
  if (!isMinutes(body.minutes))        return reply(400, { message: 'minutes must be an integer from 1 to 180' });
  if (!isLocalDate(body.localDate))    return reply(400, { message: 'localDate must be a real YYYY-MM-DD date' });

  // Rebuild the object from validated fields only — anything extra a
  // caller smuggled into the JSON is dropped here, never stored.
  const session = {
    sessionId: body.sessionId,
    startedAt: body.startedAt,
    minutes: body.minutes,
    localDate: body.localDate,
  };

  const created = await store.putSession(userId, session);
  return reply(created ? 201 : 200, { sessionId: session.sessionId, duplicate: !created });
}

/*
  GET /sessions?from=YYYY-MM-DD — that user's sessions from the date on.
  `from` is required: the client always knows what window it wants, and
  an unbounded "give me everything forever" default invites huge reads.
*/
async function getSessions(store, userId, event) {
  const from = event.queryStringParameters?.from;
  if (!isLocalDate(from)) {
    return reply(400, { message: "Query parameter 'from' must be a real YYYY-MM-DD date" });
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
