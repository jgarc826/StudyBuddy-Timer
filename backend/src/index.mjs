/*
  The Lambda entry point — the only file AWS calls directly (the function's
  configured handler is "index.handler").

  It does exactly one thing: wire the REAL DynamoDB store into the request
  handler. All logic lives in handler.mjs, all AWS access in store.mjs;
  keeping this seam thin is what makes the rest unit-testable.

  TABLE_NAME arrives as an environment variable, set by Terraform — the
  code never hardcodes which table it talks to.

  This top-level code runs once per "cold start", not once per request:
  Lambda keeps the process warm between invocations, so the store (and its
  HTTPS connection to DynamoDB) is reused across requests.
*/

import { makeHandler } from './handler.mjs';
import { DynamoStore } from './store.mjs';

export const handler = makeHandler(new DynamoStore(process.env.TABLE_NAME));
