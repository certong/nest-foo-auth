import { Portal } from '../portal/portal';

/**
 * What auth_event.kind may hold. The table's CHECK constraint lists the same
 * values — change both together.
 *
 *   login_success  a password or PIN sign-in succeeded; starts a session (sid)
 *   portal_entry   a session reached a portal; at most one per (sid, portal)
 *   login_failed   a password sign-in was refused
 *   key_failed     a wrong PIN that did not lock the door
 *   key_locked     a wrong PIN that started a lockout
 *   logout         a session's refresh cookie was cleared
 *   portal_denied  a verified login or refresh at a portal its account type
 *                  may not enter (a client at billing)
 */
export type AuthEventKind =
  | 'login_success'
  | 'portal_entry'
  | 'login_failed'
  | 'key_failed'
  | 'key_locked'
  | 'logout'
  | 'portal_denied';

export type AuthMethod = 'password' | 'pin';

/**
 * Where a request came from, as far as the log is concerned. Built by the
 * controller from the request; the service never touches Express.
 */
export interface RequestMeta {
  portal: Portal;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthEventInput {
  kind: AuthEventKind;
  portal: Portal;
  accountId?: string | null;
  method?: AuthMethod | null;
  sid?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** The pieces of a RequestMeta an event row carries. */
export function fromMeta(meta: RequestMeta): Pick<AuthEventInput, 'portal' | 'ip' | 'userAgent'> {
  return { portal: meta.portal, ip: meta.ip, userAgent: meta.userAgent };
}
