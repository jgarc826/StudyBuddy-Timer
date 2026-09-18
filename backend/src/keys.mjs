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
