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
import { userPK, sessionSK, fromBoundSK, sessionFromItem } from './keys.mjs';

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
    One user's sessions from a date onward: a Query with a key RANGE
    condition (see keys.mjs for why string order makes this correct).
    DynamoDB returns at most 1 MB per call, so we loop over pages —
    LastEvaluatedKey is the "resume from here" bookmark.
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
        ExclusiveStartKey: resumeFrom,
      }));
      items.push(...(page.Items ?? []));
      resumeFrom = page.LastEvaluatedKey;
    } while (resumeFrom);
    return items.map(sessionFromItem);
  }
}
