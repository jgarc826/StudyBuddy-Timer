/*
  Pure validation helpers — no I/O, no AWS, no state. Everything the API
  accepts from a browser passes through here first, because the server
  NEVER trusts the browser: anyone can send anything to a public URL with
  curl; the real client is just one possible caller.

  (.mjs = JavaScript module file. `export` marks what other files may
  import — everything else stays private to this file, like internal
  linkage in C++.)
*/

// UUID v4 shape, e.g. "b57c9e1a-8c3f-4b0e-9d21-0f6a2f9c1e77".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// "YYYY-MM-DD". The regex alone would accept "2026-02-31", so we rebuild
// the date and compare: JS quietly rolls invalid dates over (Feb 31 ->
// Mar 3), and the mismatch exposes the fake.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number); // destructuring, like structured bindings
  const dt = new Date(Date.UTC(y, m - 1, d));     // month is 0-based (JS quirk)
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Full ISO 8601 timestamp, e.g. "2026-09-18T20:52:22.330Z". The regex
// pins the shape (Date.parse alone would accept loose strings like
// "2026"); Date.parse then confirms it's a real moment in time.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(value) {
  return typeof value === 'string'
    && ISO_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

// An integer between 1 and 180 (3 hours) — the server-side cap from the
// project brief. Number.isInteger also rejects strings: "50" !== 50 here,
// unlike loose == comparison.
export function isMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= 180;
}
