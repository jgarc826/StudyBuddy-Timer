# StudyBuddy Timer — build notes

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

### Step 4: the contribution grid

**What was created:** the GitHub-style grid — one square per day for the
last 26 weeks, darker green for more minutes, a native tooltip with the
date and minutes on hover, month labels, and a Less→More legend.

**How the layout works (the part worth understanding):** there is no
positioning math in JavaScript. The container is a CSS grid with **7 fixed
rows** and `grid-auto-flow: column`: children fill a column top-to-bottom
(Sun→Sat), then start the next column (the next week). So the JS just
appends one `<div>` per day in date order — it only has to make sure the
very first square is a Sunday. Weeks-as-columns falls out of CSS.

**How a square gets its color:** JS sets `cell.dataset.level = "3"`, which
becomes the HTML attribute `data-level="3"`, and style.css maps each level
to a green via attribute selectors (`.cell[data-level="3"] { ... }`).
Levels are hour-buckets: 0 none, 1 under an hour, 2/3 one/two hours,
4 three or more.

**Terms that appear in this step:**

- **`Map`** — JS's hash map (`std::unordered_map`). Used to sum minutes
  per `localDate`.
- **`??`** (nullish coalescing) — "if the left side is null/undefined, use
  the right side": `map.get(key) ?? 0` reads "or start from zero".
- **`DocumentFragment`** — an off-page container: build all ~180 squares in
  it, attach once. One relayout instead of one per square. (Same instinct
  as building a string in a buffer before printing.)
- **`toLocaleDateString`** — formats a date in the user's locale; used for
  tooltips ("Apr 1, 2026") and month labels.
- **Date overflow normalization** — `new Date(2026, 8, 40)` quietly becomes
  Oct 10, like `mktime` normalizing a `struct tm`; `addDays` relies on it,
  which also makes the day-walk immune to daylight-saving-time hiccups.

### How to verify Stage 1 yourself

1. Double-click `site/index.html` (or serve the folder and open it) — the
   timer shows 50:00, buttons in the right enabled/disabled states, no
   errors in the console (F12 → Console).
2. Reopen it as `index.html?fast=1` — the yellow test badge appears and
   every "minute" lasts one second.
3. Press **Start**, watch the countdown and progress bar; after 50 fast
   "minutes" (≈50 s) the page flips to teal **Break** by itself, and the
   history card updates: `0.8 hours studied · 1 session`, with today's
   square turning green (hover it for the tooltip).
4. Refresh mid-focus — the countdown continues where it truly is.
5. Press Start again after the break ends, then **Reset** — the abandoned
   block is *not* counted.
6. To wipe test data: open the console (F12) and run `localStorage.clear()`,
   then refresh.

Note: `localStorage` belongs to an *origin* (scheme + host + port), so
sessions recorded on `file://…` and on `http://localhost:8123` are two
separate stores. Don't be surprised if the grid differs between the two —
that's the browser's same-origin rule, and it's also why Stage 3 moves the
data behind an API instead.

### Five interview questions about Stage 1

1. **"Why does the timer compute remaining time from an end timestamp
   instead of decrementing a counter every second?"**
   Browsers throttle timers in background tabs, so ticks arrive late; a
   decrementing counter drifts behind reality. Storing *when the block
   ends* and recomputing `endsAt − now` on every tick makes each tick
   self-correcting — and it makes refresh-survival trivial, since the
   timestamp is also valid after a reload.

2. **"How do you prevent a session from being counted twice?"**
   Each focus block gets a UUID *when it starts*; the id lives in the
   persisted timer state. Saving is idempotent: a save with an id that
   already exists is a no-op reported as `'duplicate'`. So refreshes,
   retries, or two tabs finishing the same block store one session. Stage 3
   keeps the exact same rule server-side with a DynamoDB conditional write.

3. **"Why is the storage interface async when localStorage is synchronous?"**
   The interface is designed for its Stage 3 replacement — network calls to
   an API, which are inherently async. Freezing an async contract now means
   swapping the implementation later changes one file and no call sites.

4. **"Why compute the calendar date (`localDate`) in the browser?"**
   Only the browser knows the user's timezone. `startedAt` is stored in
   UTC for unambiguous ordering, but the grid answers "which day did I
   study?" in the user's *local* calendar — at 9 pm in California the UTC
   date is already tomorrow, so deriving the day server-side (or via
   `toISOString`) would color the wrong square.

5. **"Why does the break start automatically but the next focus block
   doesn't?"**
   Product honesty. The break belongs to the block you just finished, so it
   runs itself (timed from the moment focus ended, even if the tab was
   asleep). But auto-starting *focus* would record study time nobody spent
   — an open tab overnight would fabricate hours. Completed-only counting
   plus manual starts keep the stats trustworthy.

### What Stage 2 adds

Terraform in `infra/` for a private S3 bucket (the site files) behind
CloudFront (the CDN that serves them over HTTPS), wired with Origin Access
Control so the bucket itself stays sealed, plus a deploy script. The app's
code won't change — Stage 2 is purely about hosting these same three files
on the internet.

## Stage 2 — putting the site on the internet

### Step 1: the hosting, described in Terraform (`infra/`)

**The mental model:** Terraform is *declarative*. The `.tf` files describe
the end state ("this bucket exists, configured like so"); `terraform plan`
diffs that against reality and shows what it would create/change/destroy;
`terraform apply` executes the diff. The *state file* (`terraform.tfstate`,
gitignored) is Terraform's memory of what it made — like a build cache.
Nothing in these files is ever clicked together in the AWS console, so the
whole system can be rebuilt from source.

**The architecture in one sentence:** visitors hit **CloudFront** (AWS's
network of edge servers — nearby, fast, HTTPS), which serves cached copies
of the site and refetches from a **private S3 bucket** only on cache
misses, authenticated via **Origin Access Control**.

**What each file declares:**

- `versions.tf` — pins Terraform ≥ 1.13 and AWS provider 6.x. The
  `.terraform.lock.hcl` file (committed on purpose) records the provider's
  cryptographic hashes, so every machine builds with the exact same plugin
  — same idea as a package-lock file.
- `providers.tf` — region `us-east-1`, a default tag on everything we
  create, and a lookup of our own account id.
- `s3.tf` — the bucket (name suffixed with the account id, because bucket
  names are globally unique across all AWS customers), a *public access
  block* (refuses any form of public exposure, even future accidental
  ones), and the *bucket policy*: the CloudFront service may `GetObject`
  and `ListBucket`, **only** when the request comes from our specific
  distribution (`AWS:SourceArn` condition). ListBucket exists so missing
  files return an honest 404 instead of a stonewalling 403.
- `cloudfront.tf` — the Origin Access Control (the signing identity that
  matches the bucket policy), and the distribution: HTTPS on the default
  `*.cloudfront.net` certificate, HTTP redirected to HTTPS, GET/HEAD only,
  compression on, AWS's managed "CachingOptimized" cache policy (looked up
  by name via a data block instead of pasting its UUID), cheapest price
  class (edges in North America + Europe).
- `outputs.tf` — the site URL, bucket name, and distribution id, printed
  after apply and read by the deploy script so nothing is hardcoded.

**Decisions made in this step:**

- `force_destroy = true` on the bucket: `terraform destroy` may delete it
  even with files inside — safe because the contents are redeployable
  copies of `site/`, and Stage 4 requires clean destroy→apply rebuilds.
- Local Terraform state for now; Stage 4 moves it to S3 for CI.
- No CloudFront access logs (extra bucket + cost; metrics are free).
- Signed in via `aws login` as the account **root** user for now — works,
  short-lived credentials, but the to-do stands: create an IAM admin user
  for daily work and keep root for account-level tasks only.

**Terms:**

- **IaC (infrastructure as code)** — infrastructure defined in reviewable,
  versioned text instead of console clicks.
- **CDN / edge / cache miss** — servers near users holding copies; a miss
  falls through to the origin (our bucket).
- **Origin Access Control (OAC)** — CloudFront signs its S3 requests
  (SigV4); the bucket accepts only those signatures. Private bucket,
  public site.
- **Bucket policy / principal / condition** — *who* (principal:
  `cloudfront.amazonaws.com`) may do *what* (actions) *when* (condition:
  request originates from our distribution's ARN).
- **ARN** — Amazon Resource Name, the globally unique id every AWS
  resource has.

### Step 2: the deploy script (`scripts/deploy.sh`)

**What it does:** two commands, glued together. `aws s3 sync site/ s3://…
--delete` uploads changed files and removes remote ones that no longer
exist locally, so the bucket exactly mirrors `site/`. Then `aws cloudfront
create-invalidation --paths "/*"` tells every edge server to forget its
cached copies, so the new version is visible immediately instead of
"within a day, whenever caches expire". Both names come from `terraform
output` — the script has zero hardcoded values, so a rebuilt bucket or
distribution changes nothing here.

**Shell-script terms worth knowing (they come up in interviews too):**

- **`set -euo pipefail`** — the standard bash safety trio: stop on the
  first error, treat unset variables as errors, and let a failure anywhere
  in a pipeline fail the pipeline.
- **`$(...)`** — command substitution: run the command, paste its output
  into place (like capturing a subprocess's stdout).
- **`cd "$(dirname "$0")/.."`** — "go to the repo root relative to where
  this script file lives", so the script works no matter which directory
  you call it from.

### How to verify Stage 2 yourself

1. `terraform -chdir=infra output site_url` prints the site's address —
   open it: the timer loads over HTTPS and works exactly like the local
   copy (try `?fast=1`). Note this is a *different origin* than your local
   file, so it starts with fresh, empty localStorage.
2. Try to bypass CloudFront: open
   `https://studybuddy-timer-site-719857072816.s3.us-east-1.amazonaws.com/index.html`
   — S3 answers **403 Access Denied**. The bucket refuses everyone except
   our distribution; the *only* door to the files is CloudFront.
3. Change one visible thing in `site/`, run `./scripts/deploy.sh`, refresh
   the site: the change appears within a few seconds (that's the
   invalidation doing its job).
4. `terraform plan` again prints "No changes" — reality matches the code.

### Five interview questions about Stage 2

1. **"The bucket is private — so how is the site public?"**
   The public surface is CloudFront, not S3. CloudFront cryptographically
   signs its fetches to the bucket (Origin Access Control, SigV4), and the
   bucket policy admits only requests signed by *our specific
   distribution* (`AWS:SourceArn` condition — which also stops another AWS
   customer from pointing *their* CloudFront at our bucket, the classic
   "confused deputy" trick). Plus a Public Access Block refuses any future
   attempt to make the bucket public by mistake.

2. **"You deployed a new version but users still see the old one. Why,
   and what do you do?"**
   Edge servers cache files (up to 24 h under our cache policy). The
   deploy script therefore ends with a `/*` invalidation — an order to
   every edge to refetch. The industry alternative is *versioned
   filenames* (`app.3f9c.js`): a new name is never cached stale, and big
   sites prefer it because invalidations aren't instant and only 1,000
   paths/month are free. At our scale, invalidation is simpler and fine.

3. **"Why Terraform instead of clicking in the AWS console?"**
   The console is fast once and irreproducible forever: no history, no
   review, no rebuild. As code, the infrastructure is versioned, diffable
   (`terraform plan` before every change), and rebuildable from scratch —
   Stage 4 literally tests `destroy` → `apply`. Clicked infra also drifts:
   nobody remembers why a setting is what it is. Here the files *are* the
   documentation.

4. **"What is the Terraform state file, and why isn't it in git?"**
   It's Terraform's memory: a JSON map from resource names in code to real
   AWS resource ids, refreshed on each run to detect drift. It's not
   committed because it can embed secrets in plain text and because two
   people applying from different copies would corrupt each other's view —
   Stage 4 moves it to S3 with locking so CI and I share one copy safely.

5. **"Why does the bucket name end with your account id?"**
   S3 bucket names are unique across *all AWS customers worldwide* (they
   become DNS hostnames), so `studybuddy-timer-site` alone could collide
   with anyone. Suffixing the account id makes it unique yet
   *deterministic* — a destroy/rebuild gets the same name back, unlike a
   random suffix.

### What Stage 3 adds

The backend: a DynamoDB table for sessions, a Lambda function (Node.js)
behind an API Gateway HTTP API with CORS and throttling — all in
Terraform — plus unit tests, and `site/storage.js` swaps its internals
from localStorage to `fetch()` calls against that API. The interface
stays identical, so app.js doesn't change: that was the point of freezing
the async contract in Stage 1.

## Stage 3 — the backend

### Step 1: the Lambda code (`backend/`) and its unit tests

**Runtime choice, checked not assumed:** AWS's runtime table lists
`nodejs24.x` as the newest generally-available Node.js runtime (26 exists
only as a "not for production" preview), so the function targets
`nodejs24.x` and the Mac got a matching Node 24 (userland install, no
admin). One caveat noted from the same page: AWS *recommends* bundling
the SDK rather than relying on the runtime's copy; the brief deliberately
chooses the runtime copy to keep the zip dependency-free, and that
trade-off (simplicity now, version drift risk later) is worth being able
to defend in an interview.

**The architecture of `backend/src/` — a seam for testability:**

- `index.mjs` — the only file Lambda calls. One job: plug the *real*
  DynamoDB store into the handler. Runs once per cold start.
- `handler.mjs` — routing, validation, responses. Knows nothing about
  DynamoDB; it receives "a store" through `makeHandler(store)` —
  dependency injection, like a C++ constructor taking an abstract
  interface. Unit tests inject a fake store; production injects the real
  one. This is the split the brief demanded ("request handling separate
  from DynamoDB calls").
- `store.mjs` — the only file that imports the AWS SDK. Two operations:
  a conditional put and a range query.
- `validation.mjs` / `keys.mjs` — pure functions, no I/O: validators and
  the single-table key scheme.

**Server-side rules worth remembering:**

- *Never trust the browser.* Every field is validated (UUID shapes, real
  calendar dates — `2026-02-31` is refused, ISO timestamps, integer
  minutes 1–180), bodies over 2 KB are refused, and the stored object is
  **rebuilt from validated fields only**, so extra JSON fields a caller
  smuggles in are dropped, never stored.
- *Idempotent writes, now atomic.* `attribute_not_exists(PK)` makes
  DynamoDB itself refuse a second write of the same session — the
  server-grade version of the duplicate check the browser has had since
  Stage 1. Handler answers 201 on create, 200 on duplicate — the same
  contract `storage.js` has spoken all along.
- *The date filter is a string trick with a proof.* Sort keys embed the
  date first (`SESSION#2026-09-18#<uuid>`), and zero-padded dates sort
  alphabetically in date order, so "sessions since X" is a sorted-range
  walk (`SK >= "SESSION#X"`), not a scan-and-filter. `keys.test.mjs`
  pins the property down across month/year boundaries.
- *Errors leak nothing.* Unexpected failures log details to CloudWatch
  and answer only `500 {"message":"Internal error"}`.

**Tests: 43, in Node's built-in runner** (`node --test
backend/test/*.test.mjs` — no framework installed; note the glob, because
passing the bare directory runs zero tests on Node 24). They cover the
brief's three required areas — validation (every field, both directions),
the duplicate-session case, and the date filter — plus routing, size
limits, base64-encoded bodies, field smuggling, the abuse limits below,
and the 500 path.

### Step 2: the adversarial review, and what it caught

Before deploying, the new code went through a multi-agent review: three
independent reviewers (correctness, security, AWS configuration), and
every finding then handed to a skeptic agent instructed to *refute* it
against the real files. Five findings survived; one was refuted. All five
were fixed and are worth knowing about:

1. **(Blocker) Unbounded read amplification.** `GET /sessions` accepted
   any `from` date back to year 0100 and paginated the whole partition.
   An attacker could cheaply write ~85 MB into one user's partition, then
   make every GET bill ~10,000 DynamoDB read units — the request throttle
   counts *requests*, not the reads hiding behind one. Fix: `from` must
   be within 400 days, and the store never reads past 6,000 items.
2. **(Important) Unbounded storage growth.** Any real date across ten
   millennia was storable, invisibly to the UI. Fix: a POSTed `localDate`
   must be within [today−7, today+2] (slack for timezones and reopened
   tabs), and each user-day holds at most 30 sessions — more than 24
   hours of studying. The cap check must not break idempotency: a retry
   of an already-stored session still answers 200 even on a full day
   (there's a test for exactly that). Residual risk, accepted and
   documented: an anonymous API can't stop invented user IDs; the
   throttle bounds the write rate, and phase 2's real accounts are the
   actual fix.
3. **(Important) The identity tests tested nothing.** A JavaScript trap:
   a destructuring default (`userId = USER`) also replaces an
   *explicitly passed* `undefined` — so the "missing header" test was
   silently sending a valid header, and both identity tests passed for
   the wrong reason (their bodies were empty, so *any* 400 satisfied
   them). The review proved the whole suite stayed green with the header
   check deleted. Fix: `null` as the "omit the header" sentinel, plus
   valid bodies so only the header check can produce the asserted 400.
   Lesson: a test that has never failed has never proven anything.
4. **(Minor) `.length` counts UTF-16 code units, not bytes** — the "2 KB"
   body guard admitted ~6 KB of CJK text. `Buffer.byteLength` measures
   real bytes.
5. **(Minor) The documented test command ran zero tests** — `node --test
   backend/test/` treats the directory as a test file on Node 24 and
   fails; only the glob form works. Would have broken Stage 4's CI on
   its first run.

The refuted finding claimed the range query needed an upper bound to
exclude hypothetical future non-session items; the skeptic showed no such
items can exist under the current writer and IAM, and that plausible
future key layouts sort *before* the range anyway. Good instinct, not a
defect — which is precisely why findings get cross-examined before
anyone acts on them.
