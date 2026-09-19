# The sessions table. Single-table design (see CLAUDE.md's data model and
# backend/src/keys.mjs): every item belongs to a user via the partition
# key, and sort keys order that user's items chronologically.

resource "aws_dynamodb_table" "sessions" {
  name = "studybuddy-timer-sessions"

  # On-demand: pay per request instead of renting capacity by the hour.
  # At our traffic this rounds to zero; there is nothing to keep warm.
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK" # partition key: "USER#<userId>"
  range_key = "SK" # sort key:      "SESSION#<localDate>#<sessionId>"

  # Only KEY attributes are declared — DynamoDB is schemaless beyond the
  # key, so startedAt/minutes/localDate need no declaration here.
  attribute {
    name = "PK"
    type = "S" # S = string
  }

  attribute {
    name = "SK"
    type = "S"
  }
}
