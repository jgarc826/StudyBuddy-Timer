/*
  The data access module — the ONLY backend file that talks to DynamoDB
  (mirror of how site/storage.js is the only frontend file that knows
  where data lives).

  The @aws-sdk imports ship inside the Lambda Node.js runtime, so the
  deployment zip contains just our own files, no dependencies. The
  DocumentClient wrapper converts between plain JS objects and DynamoDB's
  typed wire format ({"S": "text"}, {"N": "42"}) so we never see it.

  Unit tests do NOT import this file (they'd need the SDK); they inject a
  fake store into handler.mjs instead. This file stays so thin that the
  AWS integration test in Stage 3's verification covers it.
*/

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { userPK, sessionSK, fromBoundSK, dayPrefixSK, sessionFromItem } from './keys.mjs';

// Hard ceiling on items one GET may read (~1.2 MB of sessions — triple a
// physically-maxed 26-week grid). Together with the handler's 400-day
// window this bounds the worst-case DynamoDB cost of any single request.
const MAX_LIST_ITEMS = 6000;

export class DynamoStore {
  constructor(tableName) {
    this.tableName = tableName;
    // Region etc. come from the Lambda environment automatically.
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  /*
    Write once, never twice: the ConditionExpression tells DynamoDB "only
    write if no item with this key exists". A duplicate write fails the
    condition instead of overwriting — the atomic, server-side version of
    the duplicate check the browser did in Stage 1. Returns true if the
    item was created, false if it already existed.
  */
  async putSession(userId, session) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: userPK(userId),
          SK: sessionSK(session.localDate, session.sessionId),
          ...session, // spread: copy the four payload fields onto the item
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return true;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return false;
      throw err; // anything else is a real failure — let the handler 500
    }
  }

  /*
    The sessionIds already stored for one user on one calendar day —
    the handler's daily-cap check. Keys-only projection, one page: with
    the cap at 30, fifty is more than we ever need to see.
  */
  async listDaySessionIds(userId, localDate) {
    const page = await this.doc.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :day)',
      ExpressionAttributeValues: {
        ':pk': userPK(userId),
        ':day': dayPrefixSK(localDate),
      },
      ProjectionExpression: 'sessionId', // fetch just this attribute
      Limit: 50,
    }));
    return (page.Items ?? []).map(item => item.sessionId);
  }

  /*
    One user's sessions from a date onward: a Query with a key RANGE
    condition (see keys.mjs for why string order makes this correct).
    DynamoDB returns at most 1 MB per call, so we loop over pages —
    LastEvaluatedKey is the "resume from here" bookmark — but never past
    MAX_LIST_ITEMS: a partition someone managed to bloat must not turn
    one GET into an unbounded, billed read of the whole thing.
  */
  async listSessions(userId, fromDate) {
    const items = [];
    let resumeFrom; // undefined on the first page
    do {
      const page = await this.doc.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND SK >= :from',
        ExpressionAttributeValues: {
          ':pk': userPK(userId),
          ':from': fromBoundSK(fromDate),
        },
        Limit: MAX_LIST_ITEMS - items.length, // never read past the ceiling
        ExclusiveStartKey: resumeFrom,
      }));
      items.push(...(page.Items ?? []));
      resumeFrom = page.LastEvaluatedKey;
    } while (resumeFrom && items.length < MAX_LIST_ITEMS);

    if (resumeFrom) {
      // Only reachable on a partition far beyond honest use; say so in
      // the logs instead of silently pretending this was everything.
      console.warn(`listSessions truncated at ${MAX_LIST_ITEMS} items for one caller`);
    }
    return items.map(sessionFromItem);
  }
}
