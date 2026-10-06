import type { AccountVisibility, UserRole, UserStatus } from '@runningapp/contracts';
import type { Db } from '../../platform/db/client';
import { isUniqueViolation } from '../../platform/db/errors';
import { AppError } from '../../platform/errors';

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  status: UserStatus;
  role: UserRole;
  birthDate: string;
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
  createdAt: Date;
}

export interface NewAccount {
  email: string;
  passwordHash: string | null;
  birthDate: string;
  username: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  accountVisibility: AccountVisibility;
  /** Stricter defaults for minors. */
  settings: {
    defaultActivityVisibility: 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';
    defaultPostVisibility: 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';
    defaultCommentPermission: 'EVERYONE' | 'FOLLOWERS' | 'NOBODY';
    defaultRoutePrivacy: 'FULL' | 'TRIMMED' | 'APPROXIMATE' | 'HIDDEN';
  };
}

const USER_COLUMNS = [
  'id',
  'email',
  'emailVerifiedAt',
  'passwordHash',
  'status',
  'role',
  'birthDate',
  'deletionRequestedAt',
  'deletionScheduledFor',
  'createdAt',
] as const;

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string, db: Db = this.db): Promise<UserRecord | undefined> {
    return db
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async findById(id: string, db: Db = this.db): Promise<UserRecord | undefined> {
    return db.selectFrom('users').select(USER_COLUMNS).where('id', '=', id).executeTakeFirst();
  }

  async usernameExists(username: string, db: Db = this.db): Promise<boolean> {
    const row = await db
      .selectFrom('profiles')
      .select('userId')
      .where('username', '=', username)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Creates users + profiles + user_settings atomically. Uniqueness is enforced by the database
   * (not a check-then-insert), so concurrent signups cannot both win.
   */
  async createAccount(account: NewAccount, db: Db = this.db): Promise<string> {
    try {
      const user = await db
        .insertInto('users')
        .values({
          email: account.email,
          passwordHash: account.passwordHash,
          birthDate: account.birthDate,
          emailVerifiedAt: account.emailVerifiedAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('profiles')
        .values({
          userId: user.id,
          username: account.username,
          displayName: account.displayName,
          accountVisibility: account.accountVisibility,
        })
        .execute();
      await db
        .insertInto('userSettings')
        .values({ userId: user.id, ...account.settings })
        .execute();
      return user.id;
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) throw new AppError('EMAIL_TAKEN');
      if (isUniqueViolation(err, 'profiles_username_key')) throw new AppError('USERNAME_TAKEN');
      throw err;
    }
  }
}
