'use strict';
/*
  StudyBuddy timer — the page's behavior.

  'use strict' opts into stricter language rules: silent mistakes (like a
  typo'd variable name quietly creating a global) become real errors.

  A note for C++ eyes before reading on: JavaScript in a browser is
  single-threaded and event-driven. Nothing in this file runs in parallel.
  The browser calls into our functions — a button click, a timer tick — one
  at a time, like a GUI event loop that we never have to write ourselves.
*/

/* ===== 1. Configuration ================================================ */

const FOCUS_MINUTES = 50;
const BREAK_MINUTES = 10;

// Test mode: open the page as index.html?fast=1 and every "minute" lasts one
// second, so a whole focus+break cycle takes one real minute.
// URLSearchParams parses the "?key=value" part of the page's own URL.
const FAST_MODE = new URLSearchParams(window.location.search).get('fast') === '1';

// How many real milliseconds one nominal "minute" lasts.
const MS_PER_MINUTE = FAST_MODE ? 1000 : 60 * 1000;

// localStorage key under which the running timer is mirrored (see section 3).
const TIMER_KEY = 'studybuddy.timer.v1';

/* ===== 2. Timer state ================================================== */
/*
  The whole timer is one plain object — think "a struct". Phases:

    idle   -> nothing running; Start begins a focus block
    focus  -> the 50-minute study countdown (running or paused)
    break  -> the 10-minute break countdown (running or paused)

  The design rule that keeps time accurate: NEVER COUNT TICKS. We store when
  the current block ENDS (endsAt, a millisecond timestamp from Date.now())
  and recompute "remaining = endsAt - now" on every tick. Browsers throttle
  timers in background tabs — a tick can arrive seconds late — but a late
  tick still computes the correct remaining time.
*/

let timer = idleTimer();

function idleTimer() {
  return {
    phase: 'idle',
    running: false,
    endsAt: null,       // ms timestamp when the block ends (while running)
    remainingMs: null,  // ms left in the block (while paused)
    // Details of the focus block in progress, kept so the NEXT commit can
    // save it as a study session when it completes:
    sessionId: null,    // UUID picked at Start (why so early: see NOTES.md)
    startedAt: null,    // ISO 8601 UTC, e.g. "2026-09-18T21:04:05.000Z"
    minutes: null,      // nominal length of the block (50)
    msPerMinute: null,  // remembers fast/normal mode across refreshes
  };
}

/* ===== 3. Refresh survival ============================================= */
/*
  The running timer is mirrored into localStorage — a small per-site
  key/value store of STRINGS that survives reloads and browser restarts.
  JSON.stringify serializes the state object to text; JSON.parse rebuilds
  it. Because endsAt is an absolute timestamp, reloading loses nothing: on
  boot we simply recompute where we are, even if the tab was closed a while.
*/

function saveTimerState() {
  if (timer.phase === 'idle') {
    localStorage.removeItem(TIMER_KEY);
  } else {
    localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
  }
}

function loadTimerState() {
  // Never trust stored data — a devtools user can edit it. Parse defensively
  // and fall back to null. (Same attitude the server takes in Stage 3.)
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    const phaseOk = t.phase === 'focus' || t.phase === 'break';
    const timesOk = t.running ? typeof t.endsAt === 'number'
                              : typeof t.remainingMs === 'number';
    if (!phaseOk || !timesOk || typeof t.msPerMinute !== 'number') return null;
    // "{ ...a, ...b }" copies a's fields then b's over them — so anything
    // missing from storage keeps its default from idleTimer().
    return { ...idleTimer(), ...t };
  } catch {
    return null;
  }
}

/* ===== 4. The engine =================================================== */

function beginFocus(now) {
  timer = {
    phase: 'focus',
    running: true,
    endsAt: now + FOCUS_MINUTES * MS_PER_MINUTE,
    remainingMs: null,
    sessionId: crypto.randomUUID(),  // browser-built-in random UUID
    startedAt: new Date(now).toISOString(),
    minutes: FOCUS_MINUTES,
    msPerMinute: MS_PER_MINUTE,
  };
  saveTimerState();
  announceStudying(); // tell friends (best-effort, see below)
}

function pauseTimer(now) {
  timer.remainingMs = Math.max(0, timer.endsAt - now);
  timer.endsAt = null;
  timer.running = false;
  saveTimerState();
  announceIdle();
}

function resumeTimer(now) {
  timer.endsAt = now + timer.remainingMs;
  timer.remainingMs = null;
  timer.running = true;
  saveTimerState();
  if (timer.phase === 'focus') announceStudying();
}

/*
  Presence, fire-and-forget: the "studying now" dot friends see. Never
  awaited and never allowed to throw — a missed update means a stale dot
  somewhere, not lost study data. Signed out? The call fails quietly.
  The server stores an expiry alongside, so even a laptop slammed shut
  mid-block stops looking studious when the block would have ended.
*/
function announceStudying() {
  if (timer.phase !== 'focus' || !timer.running) return;
  StudyStorage.setStudying(new Date(timer.endsAt).toISOString()).catch(() => {});
}

function announceIdle() {
  StudyStorage.clearStudying().catch(() => {});
}

function resetTimer() {
  // Abandons the current block. An unfinished focus block is NOT saved —
  // only completed ones count, so the stats stay honest. During a break,
  // Reset doubles as "skip the rest of the break".
  timer = idleTimer();
  saveTimerState();  // phase is idle, so this clears the stored state
  announceIdle();
}

/*
  advance() applies every phase change that is due by time `now`. Usually
  that is one change (focus ended -> break begins). But after a long absence
  — laptop lid closed, tab reopened hours later — it can be two: the focus
  block completed AND the break is long over, so we land back on idle. The
  while-loop handles any number of due changes with the same code.

  Policy decided here: focus flows into break automatically, but the NEXT
  focus block never starts by itself — otherwise leaving the tab open
  overnight would rack up fake study hours.
*/
function advance(now) {
  let changed = false;
  while (timer.running && now >= timer.endsAt) {
    if (timer.phase === 'focus') {
      // Focus block completed -> record it as a study session. Built BEFORE
      // the timer object is mutated below. recordSession is async and is
      // deliberately not awaited: advance() stays a plain synchronous
      // function, and the save finishes on its own a moment later.
      recordSession({
        sessionId: timer.sessionId,
        startedAt: timer.startedAt,
        minutes: timer.minutes,
        localDate: toLocalDateString(new Date(timer.startedAt)),
      });
      // The break starts when focus ENDED, not at `now` — come back three
      // minutes late and three minutes of your break are already gone.
      timer.phase = 'break';
      timer.endsAt = timer.endsAt + BREAK_MINUTES * timer.msPerMinute;
      announceIdle(); // a break is not studying
    } else {
      // Break over -> idle. The human starts the next block.
      timer = idleTimer();
    }
    changed = true;
  }
  if (changed) saveTimerState();
}

/* ===== 5. Study sessions & the history panel =========================== */

// "2026-09-18" in the USER'S OWN timezone, built by hand on purpose:
// date.toISOString() would give the UTC date, which in the evening in
// California is already tomorrow — sessions would land on the wrong grid
// square. (Two JS surprises: getMonth() is 0-based, getDate() is 1-based.)
function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/*
  async / await in one breath: an `async function` returns immediately with
  a Promise — a handle to a result that isn't ready yet, like a std::future.
  Inside one, `await x` parks THIS function until x resolves while the rest
  of the page keeps running; no blocked thread, no callback pyramid.
  StudyStorage's functions are async because in Stage 3 they become network
  calls. Today they happen to resolve instantly.
*/
async function recordSession(session) {
  try {
    await StudyStorage.saveSession(session);  // 'created' or 'duplicate' — both fine
    await refreshStats();
  } catch (err) {
    // Log it and carry on: a storage hiccup should never kill the timer.
    console.error('Could not save the session:', err);
  }
}

/*
  Whose history the panel shows: null = mine, or {userId, email} for a
  friend I'm peeking at (phase 3). One flag, and refreshStats() draws
  whichever is current — the total and grid renderers don't know or care
  whose sessions they're given.
*/
let viewing = null;

// Guards against STALE responses: each refresh takes a ticket, and a
// response only paints the panel if no newer refresh started meanwhile.
// (Review-caught race: click a friend on slow WiFi, click "back", and
// without this the late friend data would repaint over your own.)
let refreshTicket = 0;

async function refreshStats() {
  const ticket = ++refreshTicket;
  if (viewing) {
    const data = await StudyStorage.friendSessions(viewing.userId);
    if (ticket !== refreshTicket) return; // superseded while we waited
    renderTotal(data.sessions);
    renderGrid(data.sessions);
    if (data.sessions.length === 0) {
      els.totalLine.textContent = 'No sessions in the last year.';
    }
    els.historyTitle.textContent = data.studyingUntil
      ? `${data.email} — studying right now`
      : `${data.email}'s history`;
    els.historyBack.hidden = false;
    return;
  }
  const sessions = await StudyStorage.loadSessions();
  if (ticket !== refreshTicket) return; // superseded while we waited
  renderTotal(sessions);
  renderGrid(sessions);
  els.historyTitle.textContent = 'Your history';
  els.historyBack.hidden = true;
}

function renderTotal(sessions) {
  // reduce is std::accumulate: fold the array into one running value.
  const totalMinutes = sessions.reduce((sum, s) => sum + s.minutes, 0);
  if (totalMinutes === 0) {
    els.totalLine.textContent = 'No sessions yet — press Start!';
    return;
  }
  const hours = (totalMinutes / 60).toFixed(1);  // e.g. "12.5"
  const n = sessions.length;
  els.totalLine.textContent =
    `${hours} hours studied · ${n} session${n === 1 ? '' : 's'}`;
}

/*
  The contribution grid: one square per day, last 26 weeks, GitHub-style.
  The layout trick lives in style.css — the container has 7 fixed rows and
  grid-auto-flow: column, so appending squares in date order fills a week
  top-to-bottom then moves one column right. All this code has to do is
  append one <div> per day, starting on a Sunday.
*/

// A new Date shifted by n days. JS normalizes overflow ("Sept 40th" becomes
// Oct 10) the same way mktime() normalizes a struct tm.
function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// Bucket a day's minutes into a shade 0-4 (hour steps).
function levelForMinutes(minutes) {
  if (minutes === 0) return 0;
  if (minutes < 60) return 1;
  if (minutes < 120) return 2;
  if (minutes < 180) return 3;
  return 4;
}

function renderGrid(sessions) {
  // Sum minutes per local day. Map is JS's hash map (std::unordered_map);
  // `?? 0` means "and if there's no entry yet, start from 0".
  const minutesByDate = new Map();
  for (const s of sessions) {
    minutesByDate.set(s.localDate, (minutesByDate.get(s.localDate) ?? 0) + s.minutes);
  }

  const today = new Date();
  // Back to the Sunday of the current week (getDay(): Sun=0..Sat=6), then
  // 25 more weeks -> 26 columns, current partial week included.
  const gridStart = addDays(today, -(today.getDay() + 25 * 7));

  // Build every square off-page in a DocumentFragment, attach once — one
  // relayout instead of ~180.
  const cells = document.createDocumentFragment();
  for (let day = gridStart; day <= today; day = addDays(day, 1)) {
    const minutes = minutesByDate.get(toLocalDateString(day)) ?? 0;
    const cell = document.createElement('div');
    cell.className = 'cell';
    // dataset.level = "2" becomes the attribute data-level="2" -> colored by CSS.
    cell.dataset.level = String(levelForMinutes(minutes));
    // `title` is the browser's built-in hover tooltip.
    const pretty = day.toLocaleDateString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric' });
    cell.title = minutes > 0 ? `${pretty} — ${minutes} min studied`
                             : `${pretty} — no study`;
    cells.appendChild(cell);
  }
  els.grid.replaceChildren(cells);

  // Month labels: one slot per week column; text only where a month begins.
  const labels = document.createDocumentFragment();
  let lastMonth = -1;
  for (let week = 0; week < 26; week++) {
    const weekStart = addDays(gridStart, week * 7);
    const slot = document.createElement('div');
    if (weekStart.getMonth() !== lastMonth) {
      slot.textContent = weekStart.toLocaleDateString(undefined, { month: 'short' });
      lastMonth = weekStart.getMonth();
    }
    labels.appendChild(slot);
  }
  els.gridMonths.replaceChildren(labels);
}

/* ===== 6. Rendering ==================================================== */

// Grab every element once, by id — a handle to the live page element, much
// like holding a widget pointer in a GUI toolkit.
const els = {
  phaseLabel: document.getElementById('phase-label'),
  clock: document.getElementById('clock'),
  progressFill: document.getElementById('progress-fill'),
  startBtn: document.getElementById('start-btn'),
  pauseBtn: document.getElementById('pause-btn'),
  resetBtn: document.getElementById('reset-btn'),
  testBadge: document.getElementById('test-badge'),
  totalLine: document.getElementById('total-line'),
  grid: document.getElementById('grid'),
  gridMonths: document.getElementById('grid-months'),
  // Account UI (phase 2)
  authCard: document.getElementById('auth-card'),
  authTitle: document.getElementById('auth-title'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  authCode: document.getElementById('auth-code'),
  authSubmit: document.getElementById('auth-submit'),
  authMessage: document.getElementById('auth-message'),
  authToggle: document.getElementById('auth-toggle'),
  accountRow: document.getElementById('account-row'),
  accountEmail: document.getElementById('account-email'),
  signoutBtn: document.getElementById('signout-btn'),
  // Friends (phase 3)
  friendsCard: document.getElementById('friends-card'),
  friendForm: document.getElementById('friend-form'),
  friendEmail: document.getElementById('friend-email'),
  friendNote: document.getElementById('friend-note'),
  requestList: document.getElementById('request-list'),
  friendList: document.getElementById('friend-list'),
  friendsEmpty: document.getElementById('friends-empty'),
  historyTitle: document.getElementById('history-title'),
  historyBack: document.getElementById('history-back'),
};

// 3,000,000 ms at 60,000 ms/minute -> "50:00". In fast mode one nominal
// second is msPerMinute/60 real ms, so the same math still reads mm:ss.
function formatClock(ms, msPerMinute) {
  const totalSeconds = Math.max(0, Math.ceil(ms / (msPerMinute / 60)));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  // A `backtick` string splices values in with ${...} — like std::format.
  return `${mm}:${ss}`;
}

/*
  render() redraws EVERYTHING about the timer from the state object, every
  time. No "update just this bit" bookkeeping to get wrong — the state is
  the single source of truth and the page is a pure function of it.
*/
function render() {
  const now = Date.now();

  let unit, blockMinutes, remainingMs;
  if (timer.phase === 'idle') {
    unit = MS_PER_MINUTE;
    blockMinutes = FOCUS_MINUTES;
    remainingMs = blockMinutes * unit;      // show a full "50:00", ready to go
  } else {
    unit = timer.msPerMinute;
    blockMinutes = timer.phase === 'focus' ? timer.minutes : BREAK_MINUTES;
    remainingMs = timer.running ? Math.max(0, timer.endsAt - now)
                                : timer.remainingMs;
  }
  const clockText = formatClock(remainingMs, unit);

  // Setting .textContent replaces the text inside an element.
  els.clock.textContent = clockText;
  els.phaseLabel.textContent =
    timer.phase === 'idle' ? 'Ready to focus'
      : (timer.phase === 'focus' ? 'Focus' : 'Break') +
        (timer.running ? '' : ' — paused');

  // One class flip recolors the whole page — see body.phase-break in style.css.
  document.body.classList.toggle('phase-break', timer.phase === 'break');

  const totalMs = blockMinutes * unit;
  els.progressFill.style.width =
    timer.phase === 'idle' ? '0%' : `${(100 * (totalMs - remainingMs)) / totalMs}%`;

  // Buttons: what's pressable depends on the phase; Start doubles as Resume.
  els.startBtn.textContent =
    timer.phase !== 'idle' && !timer.running ? 'Resume' : 'Start';
  els.startBtn.disabled = timer.running;
  els.pauseBtn.disabled = !timer.running;
  els.resetBtn.disabled = timer.phase === 'idle';

  // Mirror the countdown into the tab's title so it's visible while the
  // tab is in the background.
  document.title = timer.phase === 'idle'
    ? 'StudyBuddy Timer'
    : `${clockText} · ${timer.phase === 'focus' ? 'Focus' : 'Break'} — StudyBuddy Timer`;
}

/* ===== 7. Account UI (phase 2) ========================================= */
/*
  A tiny state machine, same pattern as the timer: `authMode` is the
  state, authUi() redraws everything from it. Three modes:

    signin  -> email + password, submit calls StudyAuth.signIn
    signup  -> same fields, submit calls StudyAuth.signUp
    confirm -> the 6-digit emailed code, submit confirms then signs in

  The password is held in a variable only between sign-up and the
  confirm step (so the user needn't retype it), never stored anywhere.
*/

let authMode = 'signin';
let pendingEmail = null;
let pendingPassword = null;

function authUi() {
  const email = StudyAuth.currentEmail();
  els.authCard.hidden = email !== null;
  els.accountRow.hidden = email === null;
  els.friendsCard.hidden = email === null;
  if (email) els.accountEmail.textContent = email;

  els.authTitle.textContent =
    { signin: 'Sign in', signup: 'Create account', confirm: 'Check your email' }[authMode];
  els.authSubmit.textContent =
    { signin: 'Sign in', signup: 'Sign up', confirm: 'Confirm' }[authMode];
  els.authToggle.textContent = authMode === 'signin'
    ? 'Need an account? Sign up' : 'Have an account? Sign in';
  els.authCode.hidden = authMode !== 'confirm';
  els.authEmail.hidden = authMode === 'confirm';
  els.authPassword.hidden = authMode === 'confirm';
}

function authNote(text, isError) {
  els.authMessage.textContent = text;
  els.authMessage.hidden = !text;
  els.authMessage.classList.toggle('error', Boolean(isError));
}

async function afterSignIn() {
  authNote('');
  await refreshStats(); // also delivers any sessions queued while signed out
  loadFriends().catch(err => console.error('Could not load friends:', err));
  authUi();
}

async function onAuthSubmit(submitEvent) {
  // Forms normally RELOAD the page on submit (their 1990s default);
  // preventDefault() says "we handle this in JavaScript instead".
  submitEvent.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;

  els.authSubmit.disabled = true; // no double-submits while we wait
  try {
    if (authMode === 'signup') {
      await StudyAuth.signUp(email, password);
      pendingEmail = email;
      pendingPassword = password;
      authMode = 'confirm';
      authNote(`We emailed a 6-digit code to ${email}.`);
    } else if (authMode === 'confirm') {
      try {
        await StudyAuth.confirm(pendingEmail, els.authCode.value.trim());
      } catch (err) {
        // If a previous submit confirmed the account but the follow-up
        // sign-in failed (flaky network), a re-submit re-confirms an
        // already-confirmed user and Cognito objects — treat that
        // specific objection as "fine, carry on to sign-in".
        const alreadyConfirmed = err.code === 'NotAuthorizedException'
          && /confirmed/i.test(err.message);
        if (!alreadyConfirmed) throw err;
      }
      await StudyAuth.signIn(pendingEmail, pendingPassword);
      pendingPassword = null;
      await afterSignIn();
    } else {
      await StudyAuth.signIn(email, password);
      await afterSignIn();
    }
  } catch (err) {
    if (err.code === 'UserNotConfirmedException') {
      // They signed up earlier but never entered the code.
      pendingEmail = email;
      pendingPassword = password;
      authMode = 'confirm';
      StudyAuth.resendCode(email).catch(() => {});
      authNote('Your email was never confirmed — we sent a fresh code.');
    } else {
      authNote(err.message, true);
    }
  } finally {
    els.authSubmit.disabled = false;
  }
  authUi();
}

/* ===== 8. Friends (phase 3) ============================================ */

function friendNote(text, isError) {
  els.friendNote.textContent = text;
  els.friendNote.hidden = !text;
  els.friendNote.classList.toggle('error', Boolean(isError));
}

// One list row. document.createElement instead of innerHTML on purpose:
// emails are user-controlled text, and textContent can't be tricked into
// becoming markup the way string-built HTML can.
function friendRow({ dotClass, label, buttons }) {
  const li = document.createElement('li');
  if (dotClass !== null) {
    const dot = document.createElement('span');
    dot.className = dotClass;
    li.appendChild(dot);
  }
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = label;
  li.appendChild(who);
  for (const { text, primary, onClick } of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'btn btn-small btn-primary' : 'btn btn-small';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    li.appendChild(btn);
  }
  return li;
}

let friendsLoadedAt = 0; // for the freshness reload below

async function loadFriends() {
  friendsLoadedAt = Date.now();
  const { friends, requests } = await StudyStorage.friends();

  els.requestList.replaceChildren(...requests.map(r => friendRow({
    dotClass: null,
    label: `${r.fromEmail} wants to be friends`,
    buttons: [
      { text: 'Accept', primary: true, onClick: () => answerRequest(StudyStorage.acceptFriend, r.fromUserId) },
      { text: 'Decline', primary: false, onClick: () => answerRequest(StudyStorage.declineFriend, r.fromUserId) },
    ],
  })));

  els.friendList.replaceChildren(...friends.map(f => friendRow({
    dotClass: f.studying ? 'dot studying' : 'dot',
    label: f.studying ? `${f.email} — studying now` : f.email,
    buttons: [
      { text: 'View', primary: false, onClick: () => viewFriend(f) },
      { text: 'Remove', primary: false, onClick: () => unfriend(f) },
    ],
  })));

  els.friendsEmpty.hidden = friends.length > 0 || requests.length > 0;
}

async function answerRequest(action, fromUserId) {
  try {
    await action(fromUserId);
    await loadFriends();
  } catch (err) {
    friendNote(err.message, true);
  }
}

function viewFriend(friend) {
  viewing = { userId: friend.userId, email: friend.email };
  refreshStats().catch(err => {
    viewing = null;
    friendNote(err.message, true);
  });
}

async function unfriend(friend) {
  // confirm() is the browser's built-in blocking OK/Cancel dialog —
  // crude, but honest, and plenty for a rare destructive action.
  if (!confirm(`Remove ${friend.email} from your friends?`)) return;
  try {
    await StudyStorage.removeFriend(friend.userId);
    if (viewing?.userId === friend.userId) viewing = null;
    await loadFriends();
    await refreshStats();
  } catch (err) {
    friendNote(err.message, true);
  }
}

function clearFriendsUi() {
  els.requestList.replaceChildren();
  els.friendList.replaceChildren();
  els.friendsEmpty.hidden = false;
  friendNote('');
}

/* ===== 9. Wiring & startup ============================================= */

// The heartbeat, ~4x per second. Advancing BEFORE rendering means the tick
// that crosses the finish line already draws the next phase.
function tick() {
  if (timer.running) advance(Date.now());
  render();
}

/*
  addEventListener registers a callback: "when this element fires this
  event, call this function." The `() => { ... }` syntax is an arrow
  function — an unnamed function value, close to a C++ lambda. It can read
  the variables around it (here `timer`); that's a closure, and unlike a
  C++ lambda capture, the variable stays alive as long as the function does.
*/
els.startBtn.addEventListener('click', () => {
  const now = Date.now();
  if (timer.phase === 'idle') beginFocus(now);
  else if (!timer.running) resumeTimer(now);
  render();
});

els.pauseBtn.addEventListener('click', () => {
  if (timer.running) pauseTimer(Date.now());
  render();
});

els.resetBtn.addEventListener('click', () => {
  resetTimer();
  render();
});

// When the tab becomes visible again, catch up right away instead of
// waiting for the next (possibly throttled) tick.
document.addEventListener('visibilitychange', tick);

// ...and refresh the friends panel too (at most once a minute), so the
// "studying now" dots reflect the present, not whenever the tab was
// last opened. No polling while the tab sits hidden — free-tier manners.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && StudyAuth.currentEmail()
      && Date.now() - friendsLoadedAt > 60 * 1000) {
    loadFriends().catch(() => {});
  }
});

// Account events.
els.authForm.addEventListener('submit', onAuthSubmit);

els.authToggle.addEventListener('click', clickEvent => {
  clickEvent.preventDefault(); // it's an <a>, but it navigates nowhere
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  authNote('');
  authUi();
});

els.signoutBtn.addEventListener('click', () => {
  // signOut is async (it revokes the token at Cognito) but the UI must
  // not wait on the network — local sign-out already happened.
  StudyAuth.signOut().catch(() => {});
  authMode = 'signin';
  viewing = null;
  clearFriendsUi();
  refreshStats().catch(err => console.error('Could not refresh history:', err));
  authUi();
});

els.friendForm.addEventListener('submit', async submitEvent => {
  submitEvent.preventDefault();
  const email = els.friendEmail.value.trim();
  if (!email) return;
  try {
    const out = await StudyStorage.sendFriendRequest(email);
    els.friendEmail.value = '';
    friendNote(out.message); // "If that account exists, they have your request."
  } catch (err) {
    friendNote(err.message, true);
  }
});

els.historyBack.addEventListener('click', clickEvent => {
  clickEvent.preventDefault();
  viewing = null;
  refreshStats().catch(err => console.error('Could not refresh history:', err));
});

// ---- Startup. Runs once: the <script> tag sits at the END of <body>, so
// every element referenced above already exists. ----

els.testBadge.hidden = !FAST_MODE;

const restored = loadTimerState();
if (restored) {
  timer = restored;
  if (timer.running) advance(Date.now());  // apply whatever happened while closed
}

render();
authUi(); // show the sign-in card or the account row, depending
// Draw the history panel from whatever is already stored. The .catch is the
// safety net for a rejected Promise (an exception in async clothing).
refreshStats().catch(err => console.error('Could not load history:', err));
if (StudyAuth.currentEmail()) {
  loadFriends().catch(err => console.error('Could not load friends:', err));
}
setInterval(tick, 250);  // "call tick() every 250 ms", forever
