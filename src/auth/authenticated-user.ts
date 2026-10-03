/**
 * The shape GET /api/me returns verbatim and the frontend is typed against.
 * Do not widen or rename these fields without changing both sides.
 */
export interface AuthenticatedUser {
  id: string;
  email?: string;
}
