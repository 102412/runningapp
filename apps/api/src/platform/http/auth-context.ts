import type { UserRole } from '@runningapp/contracts';

/** The authenticated principal for a request (identity only — authorization lives in policies). */
export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
  emailVerified: boolean;
}
