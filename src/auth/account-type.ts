import { ForbiddenException } from '@nestjs/common';
import { Portal } from '../portal/portal';

/**
 * What kind of login an account is. auth.account.account_type holds the same
 * two values, enforced by a CHECK — change both together.
 *
 *   staff   runs the business. Every portal.
 *   client  a login belonging to one billing client (client_id). Studio only,
 *           and studio shows them only that client's data.
 */
export const ACCOUNT_TYPES = ['staff', 'client'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === 'string' && (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * Which portals each account type may enter. The one place this rule lives.
 *
 * Checked at sign-in, at PIN sign-in and — the check that matters — at refresh.
 * There is one refresh cookie for every portal, so without the refresh check a
 * client who signed in at studio could have the billing frontend refresh into
 * a billing token.
 */
export const PORTAL_ACCESS: Record<AccountType, readonly Portal[]> = {
  staff: ['billing', 'studio'],
  client: ['studio'],
};

export function canEnter(accountType: AccountType, portal: Portal): boolean {
  return PORTAL_ACCESS[accountType].includes(portal);
}

export const PORTAL_DENIED = 'This account cannot sign in to this portal';

/**
 * 403, not 401: the credentials were right, and the frontend reads 401 as
 * "wrong password" or "signed out". Only ever thrown after the password, PIN or
 * refresh token has been verified, so it says nothing about whether an email
 * exists.
 */
export function portalDenied(): ForbiddenException {
  return new ForbiddenException(PORTAL_DENIED);
}
