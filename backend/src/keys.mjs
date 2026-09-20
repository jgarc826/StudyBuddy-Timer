/*
  The single-table key scheme, in one tiny pure module (see the data model
  in CLAUDE.md):

    PK = "USER#<userId>"                      partition key: whose data
    SK = "SESSION#<localDate>#<sessionId>"    sort key: which item

  Why the date sits at the FRONT of the sort key: DynamoDB stores items of
  one partition sorted by SK as a STRING. Zero-padded dates (YYYY-MM-DD)
  sort alphabetically in exactly chronological order, so "every session
  since Aug 15" becomes the range condition  SK >= "SESSION#2026-08-15" —
  the database walks a sorted range instead of scanning and filtering
  everything. Same idea as choosing a good sort order for std::map keys.
*/

export function userPK(userId) {
  return `USER#${userId}`;
}

export function sessionSK(localDate, sessionId) {
  return `SESSION#${localDate}#${sessionId}`;
}

// The lower bound for "from this date on". A bare "SESSION#<date>" is a
// string-prefix of every real SK on that date, and strings sort after
// their prefixes — so the bound includes the whole 'from' day.
export function fromBoundSK(fromDate) {
  return `SESSION#${fromDate}`;
}

// Prefix shared by every session of one calendar day — used with
// begins_with() to count a day's sessions when enforcing the daily cap.
export function dayPrefixSK(localDate) {
  return `SESSION#${localDate}#`;
}

/* ---- Phase 3: friends & presence ----------------------------------------
   Three more item types under the same USER# partitions. Their prefixes
   are chosen to sort BEFORE "SESSION#" (F < N < R < S), and the session
   range query is bounded on both ends anyway — see SESSION_UPPER_BOUND_SK.

     SK = "FRIEND#<userId>"   an accepted friendship. Stored MIRRORED —
                              one item under each person — so "my friends"
                              is a single cheap begins_with query.
     SK = "REQUEST#<userId>"  a pending request, stored under the
                              RECIPIENT (it's their inbox), keyed by the
                              sender — so one item per sender+recipient
                              pair, ever: request spam cannot grow data.
     SK = "NOW"               presence: this user is mid-focus-block.
                              Carries a TTL so it self-destructs.
*/

export function friendSK(friendUserId) {
  return `FRIEND#${friendUserId}`;
}

export function requestSK(fromUserId) {
  return `REQUEST#${fromUserId}`;
}

export const NOW_SK = 'NOW';

// Upper bound for session range queries. '$' is the character after '#',
// so every "SESSION#..." sorts below "SESSION$" and nothing else can ever
// land inside the range. (A Stage-3 reviewer proposed this bound; it was
// refuted as speculative back when sessions were the only item type.
// Phase 3 added more types, and speculation became a requirement.)
export const SESSION_UPPER_BOUND_SK = 'SESSION$';

// A stored item carries PK/SK plus the payload fields; callers only get
// the payload back, never our internal key layout.
export function sessionFromItem(item) {
  return {
    sessionId: item.sessionId,
    startedAt: item.startedAt,
    minutes: item.minutes,
    localDate: item.localDate,
  };
}
