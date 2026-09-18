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
