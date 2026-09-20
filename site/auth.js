'use strict';
/*
  StudyBuddy auth module — sign-up, sign-in, and token care, talking to
  Amazon Cognito's public API with plain fetch(). No SDK, no libraries,
  no redirects to hosted pages: every step is visible in this file.

  Vocabulary for the rest of the project:

  - JWT (JSON Web Token): a signed statement from Cognito — "this is
    account <uuid>, valid until <time>" — that servers can verify by
    signature without calling Cognito. Our API's gateway does exactly
    that on every request.
  - ID token: the JWT we attach to API calls (Authorization header).
    Expires after an hour.
  - Refresh token: a long-lived (30 days) credential whose only power is
    minting fresh ID tokens, letting the browser stay signed in without
    ever storing the password.

  Storage trade-off, stated honestly: tokens live in localStorage, which
  any script running on this page could read. Acceptable here because
  the page runs no third-party scripts at all; sites that do usually
  keep tokens in memory and pay for it with more complex refresh logic.

  Passwords pass through this file on their way to Cognito over HTTPS
  and are never stored anywhere — Cognito keeps only a hash.
*/
const StudyAuth = (function () {

  const ENDPOINT = 'https://cognito-idp.us-east-1.amazonaws.com/';
  const CLIENT_ID = STUDYBUDDY_CONFIG.cognitoClientId; // from config.js
  const TOKENS_KEY = 'studybuddy.auth.v1';

  /*
    One tiny transport for every Cognito operation: the operation name
    travels in a header, the payload as JSON. (Cognito's classic wire
    format — these calls need no AWS signature, which is exactly what
    makes password-less-SDK browsers possible.)
  */
  async function cognito(action, payload) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Failures arrive as {__type: "...#NotAuthorizedException", message}.
      const err = new Error(data.message || 'Sign-in service error');
      err.code = (data.__type || '').split('#').pop();
      throw err;
    }
    return data;
  }

  /* ---- token storage ---- */

  function readTokens() {
    try {
      return JSON.parse(localStorage.getItem(TOKENS_KEY));
    } catch {
      return null;
    }
  }

  function writeTokens(tokens) {
    if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(TOKENS_KEY);
  }

  /* ---- the public operations ---- */

  async function signUp(email, password) {
    await cognito('SignUp', {
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    });
    // Cognito now emails a 6-digit code; confirm() completes the story.
  }

  async function confirm(email, code) {
    await cognito('ConfirmSignUp', {
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    });
  }

  async function resendCode(email) {
    await cognito('ResendConfirmationCode', { ClientId: CLIENT_ID, Username: email });
  }

  async function signIn(email, password) {
    const out = await cognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const r = out.AuthenticationResult;
    writeTokens({
      email,
      idToken: r.IdToken,
      refreshToken: r.RefreshToken,
      expiresAt: Date.now() + r.ExpiresIn * 1000,
    });
  }

  async function refreshTokens(current) {
    const out = await cognito('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: current.refreshToken },
    });
    const r = out.AuthenticationResult; // note: no new refresh token here
    const updated = {
      ...current,
      idToken: r.IdToken,
      expiresAt: Date.now() + r.ExpiresIn * 1000,
    };
    writeTokens(updated);
    return updated;
  }

  /*
    The one function the rest of the app calls before any API request:
    a currently-valid ID token, refreshed silently when it's within five
    minutes of expiring — or null when signed out (or the 30-day refresh
    window finally lapsed, which signs the user out for real).
  */
  async function idToken() {
    let t = readTokens();
    if (!t) return null;

    if (Date.now() > t.expiresAt - 5 * 60 * 1000) {
      try {
        t = await refreshTokens(t);
      } catch (err) {
        if (err.code === 'NotAuthorizedException') {
          // The refresh token itself is dead — a real sign-out.
          writeTokens(null);
          return null;
        }
        // Network hiccup: the old token may still be inside its final
        // five minutes — use it if so, otherwise report signed-out-ish.
        if (Date.now() >= t.expiresAt) return null;
      }
    }
    return t.idToken;
  }

  /*
    Sign-out severs access in two places. Locally: forget the tokens
    (instant, works offline). At Cognito: revoke the refresh token, so a
    copy stolen from this browser can't keep minting fresh tokens for
    the next 30 days — the review caught the local-only version leaving
    that door open. One honest residue: an already-issued ID token stays
    technically valid until it expires (up to an hour); the API gateway
    checks signatures, not a revocation list.
  */
  async function signOut() {
    const t = readTokens();
    writeTokens(null); // local sign-out first — never blocked by network
    if (t?.refreshToken) {
      try {
        await cognito('RevokeToken', { ClientId: CLIENT_ID, Token: t.refreshToken });
      } catch {
        // Offline? The 30-day token dies of old age instead; acceptable.
      }
    }
  }

  function currentEmail() {
    return readTokens()?.email ?? null;
  }

  return { signUp, confirm, resendCode, signIn, signOut, idToken, currentEmail };
})();
