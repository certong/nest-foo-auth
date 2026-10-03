import { AccountType } from './account-type';

/**
 * The shape GET /api/me and the login response's `user` carry, and the
 * frontends are typed against.
 *
 * `id` and `email` are the original contract and must not be renamed.
 * `accountType` and `clientId` were added for staff and client logins; they are
 * additive, so a frontend typed against { id, email } keeps working. `clientId`
 * is present only for a client login.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
  accountType?: AccountType;
  clientId?: number;
}

/** The public view of a session: never the sid, and clientId only for a client. */
export function toAuthenticatedUser(claims: {
  id: string;
  email: string;
  accountType: AccountType;
  clientId: number | null;
}): AuthenticatedUser {
  const user: AuthenticatedUser = { id: claims.id, email: claims.email, accountType: claims.accountType };
  if (claims.accountType === 'client' && claims.clientId !== null) {
    user.clientId = claims.clientId;
  }
  return user;
}
