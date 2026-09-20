'use strict';
/*
  StudyBuddy storage module — phase 2 edition. The core interface is
  unchanged since Stage 1:

    StudyStorage.saveSession(session) -> Promise of 'created' | 'duplicate' | 'queued'
    StudyStorage.loadSessions()       -> Promise of an array of sessions

  Internals:

  - Data lives in DynamoDB behind our API; this file talks to it with
    fetch(), the browser's built-in HTTP client.
  - Identity (phase 2): every call carries the signed-in account's ID
    token in the standard Authorization header; auth.js owns the tokens.
    The phase-1 anonymous X-User-Id header is gone — migrateLegacy()
    imports that old history into the account, once.
  - Resilience: if a session can't be delivered when it finishes —
    network down OR simply signed out — it is queued in localStorage,
    shown on the grid, and re-sent later. The server treats a repeated
    sessionId as a no-op, so retrying is always safe.

  One consequence of the API swap: opening index.html straight from disk
  (file://) can no longer load history — browsers send "Origin: null"
  from local files and the API's CORS policy rightly refuses it. For
  local development, serve the folder over http://localhost:8123.
*/
const StudyStorage = (function () {

  const API_BASE = STUDYBUDDY_CONFIG.apiBaseUrl; // from config.js
  const PENDING_KEY = 'studybuddy.pendingSessions.v1';

  // How far back to ask for history. The server refuses 'from' older
  // than 400 days; 399 keeps us safely inside even across midnight.
  const HISTORY_DAYS = 399;

  // A valid ID token, or a thrown error shaped like a network failure —
  // which makes the save path below queue the session instead of losing
  // it (signed-out is just another kind of "can't deliver right now").
  async function authHeader() {
    const token = await StudyAuth.idToken();
    if (!token) {
      throw new Error('Signed out — session queued until sign-in');
    }
    return { authorization: `Bearer ${token}` };
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
        ...(await authHeader()),
      },
      body: JSON.stringify(session),
    });
    if (res.status === 201) return 'created';
    if (res.status === 200) return 'duplicate';

    // The server answered but said no. ONLY a 400 (validation) means
    // "re-sending will never succeed" — the review caught the original
    // any-4xx rule here discarding real studying: a 401 is a stale token
    // (retry after refresh/sign-in) and a 429 is throttling (retry
    // later). 5xx = server hiccup; also retry.
    const detail = await res.text();
    const err = new Error(`API refused the session (${res.status}): ${detail}`);
    err.rejected = res.status === 400;
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

  // The oldest date history queries ask for (same window the server allows).
  function historyFrom() {
    return new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
  }

  async function loadSessions() {
    // Signed out: the grid still shows whatever is waiting in the queue —
    // those minutes were studied, delivered or not.
    if (!(await StudyAuth.idToken())) {
      return pendingQueue.read();
    }

    await flushPending(); // deliver stragglers before asking for history

    const res = await fetch(`${API_BASE}/sessions?from=${historyFrom()}`, {
      headers: await authHeader(),
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

  /* ---- Phase 3: the friends & presence API ---- */

  // One little helper for every authenticated JSON call.
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(await authHeader()),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  const friends = () => api('/friends');
  const sendFriendRequest = email =>
    api('/friends/requests', { method: 'POST', body: { email } });
  const acceptFriend = fromUserId =>
    api('/friends/accept', { method: 'POST', body: { fromUserId } });
  const declineFriend = fromUserId =>
    api('/friends/decline', { method: 'POST', body: { fromUserId } });
  const removeFriend = userId =>
    api('/friends/remove', { method: 'POST', body: { userId } });
  const friendSessions = userId =>
    api(`/friends/sessions?userId=${encodeURIComponent(userId)}&from=${historyFrom()}`);

  // Presence is best-effort by design: fire it and forget it. A missed
  // update means a stale dot for a friend, never lost study data.
  const setStudying = untilIso =>
    api('/status', { method: 'POST', body: { until: untilIso } });
  const clearStudying = () => api('/status', { method: 'DELETE' });

  return {
    saveSession, loadSessions,
    friends, sendFriendRequest, acceptFriend, declineFriend, removeFriend,
    friendSessions, setStudying, clearStudying,
  };
})();
