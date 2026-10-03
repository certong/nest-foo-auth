import { SignJWT, jwtVerify } from 'jose';
import { Portal } from '../portal/portal';
import { AccountType, isAccountType } from './account-type';
import { ALGORITHM, TokenKeys } from './token-keys';

/**
 * Fifteen minutes (CP-37). Short on purpose: a bearer token has to be readable
 * by the script that sends it, so this is the window in which a stolen one is
 * worth anything. It is the whole reason the refresh token exists.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Twelve hours — how long a session survives without the password being typed
 * again. Unchanged from billing, and still absolute: refreshing mints access
 * tokens, never a longer-lived refresh token.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * Which kind of token this is. Signed into every token and checked on the way
 * back in, so a refresh token cannot be presented as a bearer credential: it
 * lives longer, and without this claim it would be a longer-lived access token
 * that happens to be stored more carefully.
 */
export type TokenType = 'access' | 'refresh';

/**
 * What a session carries. `sid` is minted at sign-in, rides in the refresh
 * token, and is copied into every access token renewed from it — so a login,
 * the portals it reached and its logout can be tied together in auth_event,
 * and so revocation can be added later without changing the token format.
 */
export interface SessionClaims {
  id: string;
  email: string;
  sid: string;
  /** staff or client. Decides which portals the session may enter. */
  accountType: AccountType;
  /** The billing client a client login belongs to; null for staff. */
  clientId: number | null;
}

/**
 * id, email, sid, account_type, and client_id for a client login — nothing
 * else. A JWT is signed, not encrypted — anyone
 * holding it can read every claim — so nothing goes in here that would matter
 * if read.
 *
 * `aud` is the portal for an access token, and this service itself for a
 * refresh token. The refresh token is deliberately not bound to a portal: the
 * same cookie, sent from the studio origin, has to mint a studio token — that
 * is single sign-on — and addressing it to this service is what keeps every
 * product backend from accepting it.
 */
function sign(
  claims: SessionClaims,
  keys: TokenKeys,
  typ: TokenType,
  audience: string,
  ttlSeconds: number,
): Promise<string> {
  // Spelled out in full, unlike typ: account_type and client_id are what a
  // product backend filters data by, and should read plainly in a decoded token.
  const accountClaims =
    claims.accountType === 'client'
      ? { account_type: claims.accountType, client_id: claims.clientId }
      : { account_type: claims.accountType };
  return new SignJWT({ email: claims.email, sid: claims.sid, typ, ...accountClaims })
    .setProtectedHeader({ alg: ALGORITHM, kid: keys.kid })
    .setSubject(claims.id)
    .setIssuer(keys.issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keys.privateKey);
}

export function signAccessToken(claims: SessionClaims, portal: Portal, keys: TokenKeys): Promise<string> {
  return sign(claims, keys, 'access', portal, ACCESS_TOKEN_TTL_SECONDS);
}

export function signRefreshToken(claims: SessionClaims, keys: TokenKeys): Promise<string> {
  return sign(claims, keys, 'refresh', keys.issuer, REFRESH_TOKEN_TTL_SECONDS);
}

/**
 * Null for every failure — bad signature, unknown kid, expiry, wrong algorithm,
 * wrong issuer or audience, wrong token type, missing claims. One return value
 * for all of them on purpose: which check failed tells an attacker which half
 * to work on, and this module is the only place that knows. Callers turn null
 * into a 401 without ever learning why.
 *
 * An access token must name the portal it is being used at; a refresh token is
 * always addressed to this service, so it takes no audience.
 */
export function verifyToken(
  token: string,
  keys: TokenKeys,
  expected: 'access',
  audience: Portal,
): Promise<SessionClaims | null>;
export function verifyToken(token: string, keys: TokenKeys, expected: 'refresh'): Promise<SessionClaims | null>;
export async function verifyToken(
  token: string,
  keys: TokenKeys,
  expected: TokenType,
  audience?: Portal,
): Promise<SessionClaims | null> {
  const requiredAudience = expected === 'refresh' ? keys.issuer : audience;
  if (requiredAudience === undefined) {
    return null;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys.keySet, {
      algorithms: [ALGORITHM],
      issuer: keys.issuer,
      audience: requiredAudience,
    }));
  } catch {
    return null;
  }

  if (payload.typ !== expected) {
    return null;
  }

  const { sub, email, sid, account_type: accountType, client_id: clientId } = payload;
  if (!nonEmpty(sub) || !nonEmpty(email) || !nonEmpty(sid) || !isAccountType(accountType)) {
    return null;
  }
  // A client token must say which client; a staff token must not claim one.
  // Either mismatch is a token we did not mint.
  if (accountType === 'client') {
    if (typeof clientId !== 'number' || !Number.isInteger(clientId) || clientId <= 0) {
      return null;
    }
    return { id: sub, email, sid, accountType, clientId };
  }
  if (clientId !== undefined) {
    return null;
  }
  return { id: sub, email, sid, accountType, clientId: null };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
