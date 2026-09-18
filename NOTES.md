# StudyBuddy — build notes

A plain-language log of what was built and why, written for a C++ programmer
who is new to web development. One section per step. Each stage ends with a
glossary, verification steps, and five interview-style questions. Read this
alongside `git log` — the commits follow the same order as these sections.

## Stage 1 — the timer, on this computer only

### Step 1: repository + page skeleton

**What was created:**

- A git repository, with `.gitignore` set up before there is anything to
  ignore. It already covers Terraform state and `node_modules/` so that a
  later mistake can't accidentally commit secrets or thousands of files.
- `site/index.html` — the page's *structure*: a timer card (phase label,
  clock, progress bar, three buttons) and a history card. Everything is
  visible but dead; no JavaScript exists yet.
- `site/style.css` — the page's *looks*.

**Why the split into .html / .css / .js files:** the browser world separates
structure (HTML), presentation (CSS), and behavior (JavaScript). The browser
reads `index.html` top to bottom, fetches the files it links to, and renders
as it goes. There is no compile step — the source files *are* the program.

**Terms that appear in this step:**

- **`<!DOCTYPE html>`** — tells the browser "modern HTML rules." Without it,
  browsers emulate 1990s quirks.
- **Elements and `id`s** — `<button id="start-btn">` is a widget in the page.
  The `id` is a unique handle; JavaScript will later grab the element by id,
  much like looking up a widget pointer in a GUI toolkit.
- **CSS custom properties** — the `--accent: #4f46e5;` lines in `:root` are
  named constants, and `var(--accent)` reads one. They can be *overridden per
  scope*: the `body.phase-break` block redefines the same names, so when
  JavaScript later adds the class `phase-break` to `<body>`, every color on
  the page flips from indigo (focus) to teal (break) at once. That is the
  entire mechanism behind the "clear visual difference" requirement.
- **`hidden` attribute** — a built-in HTML boolean attribute; the element
  takes part in the page but isn't rendered. The test-mode badge starts
  hidden and JavaScript will un-hide it when the page runs in `?fast=1` mode.

### Step 2: the timer engine (`site/app.js`)

**What was created:** all timer behavior — Start/Pause/Resume/Reset, the
50-minute focus block flowing automatically into a 10-minute break, a
progress bar, the countdown mirrored into the tab title, `?fast=1` test
mode, and a running timer that survives a page refresh.

**The one idea that matters most — never count ticks.** The naive timer
does `remaining--` once per second. That breaks in browsers: background
tabs get their timers throttled (a "1 second" tick can arrive 60 seconds
late), so a naive countdown falls behind reality. Instead we store *when
the block ends* (`endsAt`, a millisecond timestamp) and recompute
`remaining = endsAt - now` on every tick. A late tick still computes the
truth. Ticks only *refresh the display*; the wall clock is the timekeeper.

**How state is organized:** one plain object `timer` with a `phase` field
(`idle` → `focus` → `break` → back to `idle`) — a small state machine, the
same way you'd model it in C++. Every UI update goes through one `render()`
function that redraws everything from that object. No scattered "update
this label here, that button there" — the page is a pure function of the
state, so it can't drift out of sync.

**Decisions made in this step (worth remembering):**

- *Focus flows into break automatically, but the next focus block never
  starts itself.* Otherwise a tab left open overnight would rack up fake
  study hours. Honest stats beat convenient ones.
- *The break starts when focus ended, not when you look at the tab.* Come
  back 3 minutes late and 3 minutes of break are gone. Falls straight out
  of the `endsAt` arithmetic — `advance()` even handles "focus AND break
  both ended while the laptop was closed" with the same loop.
- *Reset abandons the block, saving nothing.* Only completed focus blocks
  will count as sessions.
- *The running timer is mirrored into localStorage* and restored on load,
  so a refresh (or accidental tab close) doesn't lose a block in progress.

**Terms that appear in this step:**

- **`Date.now()`** — milliseconds since the Unix epoch, as a plain number.
  Like `time(nullptr)` but in ms.
- **`setInterval(fn, 250)`** — "call `fn` every 250 ms." The browser's event
  loop does the calling; there is no thread to manage (and no thread-safety
  to worry about — everything here runs on one thread).
- **`addEventListener('click', fn)`** — registers a callback for an event on
  an element. The `() => {...}` values passed in are **arrow functions** —
  like C++ lambdas — and they are **closures**: they can read the variables
  around them (`timer`, `els`), and those variables stay alive as long as
  the function does, unlike a dangling C++ reference capture.
- **`localStorage`** — a tiny per-site key→string store that survives
  reloads. Objects go in and out via **JSON** (`JSON.stringify` /
  `JSON.parse`), the universal "struct as text" format of the web world.
- **`document.getElementById` / `.textContent` / `classList`** — the **DOM**
  (Document Object Model): the page as a live object tree. Get a handle to
  an element, assign to its properties, and the browser re-renders.
- **`crypto.randomUUID()`** — browser-built-in random UUID, later used to
  identify each session.
- **`URLSearchParams`** — parser for the `?key=value` part of a URL; how the
  page notices `?fast=1`.

### Step 3: saving sessions (`site/storage.js`) and total hours

**What was created:** a completed focus block is now saved as a session,
and the history card shows total hours + session count. All storage goes
through a new module, `site/storage.js`, which exposes exactly two
functions: `StudyStorage.saveSession(session)` and
`StudyStorage.loadSessions()`. Nothing else in the app knows where the
data lives.

**Why a separate file:** Stage 3 replaces localStorage with our real API.
Because app.js only talks to this two-function interface, that swap will
change one file and nothing else — like programming against an abstract
base class and swapping the implementation.

**Why the functions are `async` when localStorage is instant:** network
calls are coming in Stage 3, and callers of a network call must `await`.
Freezing the async contract *now* means call sites never change later.

**What a session looks like** (deliberately the exact JSON the Stage 3
API will accept — the shape is already frozen):

```json
{ "sessionId": "ba19ff37-...", "startedAt": "2026-09-18T20:52:22.330Z",
  "minutes": 50, "localDate": "2026-09-18" }
```

**Decisions made in this step:**

- *The `sessionId` is chosen when the block STARTS, not when it ends.* The
  id travels with the timer state, so a refresh, a retry, or two open tabs
  finishing the same block all present the SAME id — and `saveSession` is
  idempotent: a duplicate id is stored once and reported as `'duplicate'`.
  This is the browser-side twin of the Stage 3 rule "write only if this
  item doesn't already exist" (a DynamoDB conditional write), and the
  return values already mirror the API's future replies (201/200).
- *`localDate` comes from when the block started*, in the user's own
  timezone. A block started at 11:40 pm belongs to the day you sat down.
  It's computed by hand from `getFullYear/getMonth/getDate` because the
  tempting `toISOString().slice(0, 10)` gives the **UTC** date — wrong for
  an evening study session in California.
- *In fast mode a completed block still records `minutes: 50`* — the point
  of test mode is to see real numbers appear quickly. Test data can be
  wiped with `localStorage.clear()` in the browser console (F12).

**Terms that appear in this step:**

- **Promise** — a handle to a result that isn't ready yet; close cousin of
  `std::future`. `await` parks the current async function until the result
  arrives, while the rest of the page keeps running. There is still only
  ONE thread — `async` is cooperative scheduling, not threading.
- **IIFE** — `(function () { ... })()`: define a function, call it
  immediately. Variables inside are private; the returned object is the
  public interface, and its methods reach the private variables through
  their closure. The pre-modules way to build a module — used in
  storage.js and worth being able to explain in an interview.
- **`Array.prototype.reduce` / `some`** — `std::accumulate` and
  `std::any_of` for JS arrays.
