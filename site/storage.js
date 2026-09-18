'use strict';
/*
  StudyBuddy storage module — Stage 3 edition: the SAME two-function
  interface as Stage 1, with completely different insides. app.js has not
  changed by a single character, which was the whole point of freezing an
  async contract on day one.

  Interface (unchanged since Stage 1):

    StudyStorage.saveSession(session) -> Promise of 'created' | 'duplicate' | 'queued'
    StudyStorage.loadSessions()       -> Promise of an array of sessions

  New internals:

  - Data lives in DynamoDB behind our API; this file talks to it with
    fetch(), the browser's built-in HTTP client.
  - Identity: on first visit we invent a UUID, keep it in localStorage,
    and send it on every call in an X-User-Id header. (Phase-1 identity —
    anyone holding this ID can read/write that history; real accounts
    come in phase 2. See the README notes.)
  - Resilience: if the network is down when a session finishes, the
    session is queued in localStorage and re-sent later. The server
    treats a repeated sessionId as a no-op, so retrying is always safe.

  One consequence of the API swap: opening index.html straight from disk
  (file://) can no longer load history — browsers send "Origin: null"
  from local files and the API's CORS policy rightly refuses it. For
  local development, serve the folder over http://localhost:8123.
*/
const StudyStorage = (function () {

  const API_BASE = STUDYBUDDY_CONFIG.apiBaseUrl; // from config.js
  const USER_ID_KEY = 'studybuddy.userId.v1';
  const PENDING_KEY = 'studybuddy.pendingSessions.v1';

  // How far back to ask for history. The server refuses 'from' older
  // than 400 days; 399 keeps us safely inside even across midnight.
  const HISTORY_DAYS = 399;

  /* ---- identity ---- */

  function getUserId() {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  }

  /* ---- talking to the API ---- */

  /*
    fetch() sends an HTTP request and resolves once the response HEADERS
    arrive; reading the body is a second await (res.json() / res.text()),
    because the body may still be streaming in. Compare Stage 1: the same
    saveSession call, but now there's a real network underneath — which
    is exactly why this interface was async from the start.
  */
  async function postSession(session) {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': getUserId(),
      },
      body: JSON.stringify(session),
    });
    if (res.status === 201) return 'created';
    if (res.status === 200) return 'duplicate';

    // The server answered but said no. Mark 4xx errors as `rejected`:
    // re-sending an invalid session will never succeed, so the retry
    // queue must not keep it. (5xx = server hiccup -> retrying is fine.)
    const detail = await res.text();
    const err = new Error(`API refused the session (${res.status}): ${detail}`);
    err.rejected = res.status >= 400 && res.status < 500;
    throw err;
    // A network failure (offline, DNS, ...) never reaches this line —
    // fetch itself throws, and that error has no `rejected` flag.
  }

  /* ---- the offline queue ---- */

  const pendingQueue = {
    read() {
      try {
        const parsed = JSON.parse(localStorage.getItem(PENDING_KEY));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    write(list) {
      if (list.length === 0) localStorage.removeItem(PENDING_KEY);
      else localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    },
  };

  // Try to deliver whatever is queued. Server-rejected sessions are
  // dropped (they will never become valid); a network failure stops the
  // attempt — we're still offline, try again next time.
  async function flushPending() {
    const queue = pendingQueue.read();
    let changed = false;
    while (queue.length > 0) {
      try {
        await postSession(queue[0]);
        queue.shift(); // delivered — remove from the front
        changed = true;
      } catch (err) {
        if (err.rejected) {
          console.warn('Dropping a queued session the server refused:', err.message);
          queue.shift();
          changed = true;
          continue;
        }
        break; // still offline; keep the rest for later
      }
    }
    if (changed) pendingQueue.write(queue);
  }

  /* ---- public interface ---- */

  async function saveSession(session) {
    try {
      const result = await postSession(session);
      flushPending().catch(() => {}); // opportunistic; outcome doesn't matter here
      return result;
    } catch (err) {
      if (err.rejected) throw err; // the server said no — that's a bug, surface it
      // Network trouble: queue the session instead of losing 50 minutes
      // of studying to a WiFi blip.
      const queue = pendingQueue.read();
      if (!queue.some(s => s.sessionId === session.sessionId)) {
        queue.push(session);
        pendingQueue.write(queue);
      }
      return 'queued';
    }
  }

  async function loadSessions() {
    await flushPending(); // deliver stragglers before asking for history

    const from = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const res = await fetch(`${API_BASE}/sessions?from=${from}`, {
      headers: { 'x-user-id': getUserId() },
    });
    if (!res.ok) {
      throw new Error(`Could not load history (${res.status})`);
    }
    const data = await res.json();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    // Anything still stuck in the queue belongs on the grid too — the
    // user did study those minutes, delivered or not.
    const seen = new Set(sessions.map(s => s.sessionId));
    for (const p of pendingQueue.read()) {
      if (!seen.has(p.sessionId)) sessions.push(p);
    }
    return sessions;
  }

  return { saveSession, loadSessions };
})();
