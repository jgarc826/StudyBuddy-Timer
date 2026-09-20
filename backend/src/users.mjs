/*
  The user directory — the ONLY backend file that talks to Cognito.
  One question answered: "which account, if any, owns this email?"
  Used when sending a friend request, since people know each other by
  email, not by account uuid.

  Injected into the handler like the store is (and faked in tests the
  same way). The Lambda's role gets exactly one Cognito permission for
  this: ListUsers, read-only, on our one pool.
*/

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

export class CognitoDirectory {
  constructor(userPoolId) {
    this.userPoolId = userPoolId;
    this.client = new CognitoIdentityProviderClient({});
  }

  /*
    Returns { userId, email } for a confirmed account, or null. Null for
    unconfirmed accounts too — an address that never proved it exists
    can't receive friend requests.
  */
  async findByEmail(email) {
    // Belt and suspenders: isEmail() upstream already rejects quotes and
    // backslashes (the filter grammar's escape characters); strip them
    // here anyway so this file is safe even if a future caller forgets.
    const safe = email.replace(/["\\]/g, '');
    const out = await this.client.send(new ListUsersCommand({
      UserPoolId: this.userPoolId,
      Filter: `email = "${safe}"`, // exact-match filter
      Limit: 1,
    }));
    const user = (out.Users ?? [])[0];
    if (!user || user.UserStatus !== 'CONFIRMED') return null;

    const sub = (user.Attributes ?? []).find(a => a.Name === 'sub')?.Value;
    return sub ? { userId: sub, email } : null;
  }
}
