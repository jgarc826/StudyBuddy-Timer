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
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand,
  QueryCommand, BatchGetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  userPK, sessionSK, fromBoundSK, dayPrefixSK, sessionFromItem,
  friendSK, requestSK, NOW_SK, SESSION_UPPER_BOUND_SK,
} from './keys.mjs';

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
        // Bounded on BOTH ends since phase 3: partitions now hold friend,
        // request, and presence items too, and this range can never
        // touch them (see SESSION_UPPER_BOUND_SK in keys.mjs).
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :upper',
        ExpressionAttributeValues: {
          ':pk': userPK(userId),
          ':from': fromBoundSK(fromDate),
          ':upper': SESSION_UPPER_BOUND_SK,
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

  /* ---- Phase 3: friendships, requests, presence ------------------------ */

  // The friendship item under MY partition, or null. This one GetItem is
  // the authorization check guarding every look at a friend's data.
  async getFriendship(userId, otherUserId) {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: userPK(userId), SK: friendSK(otherUserId) },
    }));
    return out.Item ?? null;
  }

  // A pending request lives under its RECIPIENT, keyed by sender — one
  // item per pair ever, so repeated requests overwrite, never accumulate.
  async putRequest(toUserId, fromUserId, fromEmail, createdAt) {
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: userPK(toUserId), SK: requestSK(fromUserId),
        fromUserId, fromEmail, createdAt,
      },
    }));
  }

  async getRequest(toUserId, fromUserId) {
    const out = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: userPK(toUserId), SK: requestSK(fromUserId) },
    }));
    return out.Item ?? null;
  }

  async deleteRequest(toUserId, fromUserId) {
    await this.doc.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: userPK(toUserId), SK: requestSK(fromUserId) },
    }));
  }

  /*
    Accepting = one ATOMIC transaction: write the friendship under both
    people and delete the request. All three happen or none do — no state
    where A lists B as a friend but B doesn't list A. (A transaction is
    the only new DynamoDB idea here; IAM-wise it just needs the same
    put/delete permissions as its parts.)
  */
  async acceptRequest(meId, meEmail, fromUserId, fromEmail, since) {
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.tableName, Item: {
          PK: userPK(meId), SK: friendSK(fromUserId),
          friendUserId: fromUserId, friendEmail: fromEmail, since,
        } } },
        { Put: { TableName: this.tableName, Item: {
          PK: userPK(fromUserId), SK: friendSK(meId),
          friendUserId: meId, friendEmail: meEmail, since,
        } } },
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(meId), SK: requestSK(fromUserId),
        } } },
        // The REVERSE pending request too, if we'd both asked each other
        // (deleting a nonexistent item is a no-op). Review-caught: a
        // stale reverse request left behind here could later be
        // "accepted" to silently re-create an unfriended friendship.
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(fromUserId), SK: requestSK(meId),
        } } },
      ],
    }));
  }

  // Unfriending removes both mirrored friendship items AND any pending
  // requests in either direction, atomically — revoking access must not
  // leave behind a stale invitation that could quietly restore it.
  async removeFriendship(userId, otherUserId) {
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(userId), SK: friendSK(otherUserId),
        } } },
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(otherUserId), SK: friendSK(userId),
        } } },
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(userId), SK: requestSK(otherUserId),
        } } },
        { Delete: { TableName: this.tableName, Key: {
          PK: userPK(otherUserId), SK: requestSK(userId),
        } } },
      ],
    }));
  }

  // Everything the Friends panel needs: two begins_with queries. A single
  // page of 200 each — beyond that isn't a study group, it's a botnet.
  async listFriendsAndRequests(userId) {
    const query = prefix => this.doc.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': userPK(userId), ':p': prefix },
      Limit: 200,
    }));
    const [friendsOut, requestsOut] = await Promise.all([
      query('FRIEND#'), query('REQUEST#'),
    ]);
    return {
      friends: (friendsOut.Items ?? []).map(i => ({
        userId: i.friendUserId, email: i.friendEmail, since: i.since,
      })),
      requests: (requestsOut.Items ?? []).map(i => ({
        fromUserId: i.fromUserId, fromEmail: i.fromEmail,
      })),
    };
  }

  /*
    Presence for a set of users in one round trip (BatchGetItem takes up
    to 100 keys per call). Returns a Map of userId -> `until` timestamp
    for users whose NOW item exists.
  */
  async getPresence(userIds) {
    const found = new Map();
    for (let i = 0; i < userIds.length; i += 100) {
      let keys = userIds.slice(i, i + 100).map(id =>
        ({ PK: userPK(id), SK: NOW_SK }));
      // BatchGetItem may answer with only PART of a batch (UnprocessedKeys)
      // under momentary pressure — ignoring that would quietly mislabel
      // studying friends as idle. Retry the leftovers a few times.
      let attempt = 0;
      while (keys.length > 0 && attempt < 4) {
        const out = await this.doc.send(new BatchGetCommand({
          RequestItems: { [this.tableName]: { Keys: keys } },
        }));
        for (const item of out.Responses?.[this.tableName] ?? []) {
          found.set(item.PK.slice('USER#'.length), item.until);
        }
        keys = out.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        attempt += 1;
        if (keys.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 50 * attempt));
        }
      }
      if (keys.length > 0) {
        console.warn(`getPresence gave up on ${keys.length} unprocessed key(s)`);
      }
    }
    return found;
  }

  // "I'm studying until <until>." expiresAt is DynamoDB's TTL attribute
  // (epoch SECONDS): the table deletes the item itself after the block
  // ends, so a closed laptop can never look studious forever.
  async setPresence(userId, untilIso) {
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: userPK(userId), SK: NOW_SK,
        until: untilIso,
        expiresAt: Math.floor(Date.parse(untilIso) / 1000),
      },
    }));
  }

  async clearPresence(userId) {
    await this.doc.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: userPK(userId), SK: NOW_SK },
    }));
  }
}
