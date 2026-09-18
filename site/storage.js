'use strict';
/*
  StudyBuddy storage module — the ONLY file that knows where sessions live.

  Public interface (everything else in here is hidden):

    StudyStorage.saveSession(session) -> Promise of 'created' | 'duplicate'
    StudyStorage.loadSessions()       -> Promise of an array of sessions

  A session object looks like:

    { sessionId: "b57c9e1a-...",             // UUID, chosen when the block STARTED
      startedAt: "2026-09-18T21:04:05.000Z", // ISO 8601 timestamp, UTC
      minutes: 50,                           // integer
      localDate: "2026-09-18" }              // the user's own calendar day

  Today the data lives in localStorage. In Stage 3 the internals of this
  file become HTTP calls to our API — and NOTHING else changes, because
  app.js only ever talks to this interface. That is also why both functions
  are async even though localStorage answers instantly: network calls will
  force callers to await, so callers await from day one. (C++ analogy:
  programming against an abstract base class so the implementation can be
  swapped without touching call sites.)

  The shape below — (function () { ... })() — defines a function and calls
  it immediately (an "IIFE"). Nothing inside is visible from outside; only
  the returned object escapes, and its two functions keep access to
  SESSIONS_KEY and the helpers through their closure. This is the classic
  JavaScript way to get private members: think of a class with a private
  section, where the returned object is the public interface.
*/
const StudyStorage = (function () {

  const SESSIONS_KEY = 'studybuddy.sessions.v1';

  /* ---- private helpers ---- */

  function readAll() {
    // Defensive: storage can be empty, missing, or hand-edited garbage.
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(sessions) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  /* ---- public interface ---- */

  /*
    Saving is IDEMPOTENT: saving the same sessionId twice stores it once
    and reports 'duplicate', so a retried save (or two open tabs finishing
    the same block) can never double-count. The Stage 3 backend enforces
    the very same rule with a conditional write in DynamoDB; its HTTP
    replies will mirror these return values (201 Created / 200 OK).
  */
  async function saveSession(session) {
    const sessions = readAll();
    const exists = sessions.some(s => s.sessionId === session.sessionId);
    if (exists) return 'duplicate';
    sessions.push(session);
    writeAll(sessions);
    return 'created';
  }

  async function loadSessions() {
    return readAll();
  }

  return { saveSession, loadSessions };
})();
