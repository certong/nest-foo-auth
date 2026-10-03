import { AuthenticatedUser } from './authenticated-user';

/**
 * What POST /auth/login returns (CP-37). The user rides along so the frontend
 * can populate its auth context without a follow-up GET /me.
 *
 * The refresh token is deliberately absent: it goes back as an httpOnly cookie
 * and must never reach JavaScript.
 */
export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUser;
}

/** POST /auth/refresh — a new access token, nothing else. */
export interface RefreshResponse {
  accessToken: string;
}
