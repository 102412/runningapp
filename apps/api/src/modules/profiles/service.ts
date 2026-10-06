import type {
  Me,
  Profile,
  Settings,
  UpdateProfileRequest,
  UpdateSettingsRequest,
} from '@runningapp/contracts';
import type { Config } from '../../config';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { isUniqueViolation } from '../../platform/db/errors';
import { AppError } from '../../platform/errors';
import { loadRelations } from '../social/relations';
import type { SocialService } from '../social/service';
import { accountVisibleTo } from '../social/visibility';
import type { CreatorService } from '../creators/service';
import type { MediaService } from '../media/service';
import { ageOn } from '../users/age';
import type { UserDirectory } from '../users/directory';
import { checkUsername } from '../users/username-policy';

const USERNAME_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export type ProfileRef = { id: string } | { username: string };

export class ProfileService {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly directory: UserDirectory,
    private readonly social: SocialService,
    private readonly media: MediaService,
    private readonly creators: CreatorService,
  ) {}

  // ------------------------------------------------------------------ reads

  async getMe(userId: string): Promise<Me> {
    const user = await this.db
      .selectFrom('users')
      .select([
        'id',
        'email',
        'emailVerifiedAt',
        'status',
        'role',
        'birthDate',
        'deletionRequestedAt',
        'deletionScheduledFor',
      ])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new AppError('USER_NOT_FOUND');
    const [profile, settings] = await Promise.all([
      this.getProfile(userId, { id: userId }),
      this.getSettings(userId),
    ]);
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      status: user.status,
      role: user.role,
      birthDate: user.birthDate,
      isMinor: ageOn(user.birthDate, this.clock.now()) < this.config.ADULT_AGE,
      profile,
      settings,
      deletion:
        user.deletionRequestedAt && user.deletionScheduledFor
          ? {
              requestedAt: user.deletionRequestedAt.toISOString(),
              scheduledFor: user.deletionScheduledFor.toISOString(),
            }
          : null,
    };
  }

  /**
   * Profile as seen by `viewerId` (null = anonymous). Blocked pairs, suspended and
   * pending-deletion accounts are all indistinguishable from "does not exist".
   */
  async getProfile(viewerId: string | null, ref: ProfileRef): Promise<Profile> {
    let q = this.db
      .selectFrom('profiles as p')
      .innerJoin('users as u', 'u.id', 'p.userId')
      .select([
        'p.userId',
        'p.bio',
        'p.locationLabel',
        'p.primarySportKey',
        'p.followerCount',
        'p.followingCount',
        'p.postCount',
        'p.createdAt',
      ])
      .where(accountVisibleTo(viewerId, { authorId: 'p.user_id', authorStatus: 'u.status' }));
    q = 'id' in ref ? q.where('p.userId', '=', ref.id) : q.where('p.username', '=', ref.username);
    const row = await q.executeTakeFirst();
    if (!row) throw new AppError('USER_NOT_FOUND');

    const [summaries, relations, creatorProfile] = await Promise.all([
      this.directory.summaries([row.userId]),
      loadRelations(this.db, viewerId, [row.userId]),
      this.creators.get(row.userId),
    ]);
    const summary = summaries.get(row.userId);
    if (!summary) throw new AppError('USER_NOT_FOUND');
    return {
      ...summary,
      bio: row.bio,
      locationLabel: row.locationLabel,
      primarySport: row.primarySportKey as Profile['primarySport'],
      counts: { followers: row.followerCount, following: row.followingCount, posts: row.postCount },
      viewer: viewerId === null ? null : (relations.get(row.userId) ?? null),
      creatorProfile,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getSettings(userId: string): Promise<Settings> {
    const row = await this.db
      .selectFrom('userSettings as s')
      .innerJoin('profiles as p', 'p.userId', 's.userId')
      .select([
        'p.accountVisibility',
        'p.discoverable',
        's.unitSystem',
        's.defaultActivityVisibility',
        's.defaultPostVisibility',
        's.defaultCommentPermission',
        's.defaultRoutePrivacy',
        's.routeTrimMeters',
        's.autoCreateActivityPost',
        's.personalizationEnabled',
      ])
      .where('s.userId', '=', userId)
      .executeTakeFirst();
    if (!row) throw new AppError('USER_NOT_FOUND');
    return row;
  }

  async usernameAvailability(username: string): Promise<{
    username: string;
    available: boolean;
    reason: 'TAKEN' | 'INVALID' | 'RESERVED' | null;
  }> {
    const problem = checkUsername(username);
    if (problem) return { username, available: false, reason: problem };
    const taken = await this.db
      .selectFrom('profiles')
      .select('userId')
      .where('username', '=', username)
      .executeTakeFirst();
    return { username, available: taken === undefined, reason: taken ? 'TAKEN' : null };
  }

  // ------------------------------------------------------------------ writes

  async updateProfile(userId: string, patch: UpdateProfileRequest): Promise<Profile> {
    const now = this.clock.now();
    const set: Record<string, unknown> = {};

    if (patch.username !== undefined) {
      const current = await this.db
        .selectFrom('profiles')
        .select(['username', 'usernameChangedAt'])
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow();
      if (
        current.username.toLowerCase() !== patch.username.toLowerCase() ||
        current.username !== patch.username
      ) {
        const problem = checkUsername(patch.username);
        if (problem) {
          throw new AppError(problem === 'RESERVED' ? 'USERNAME_TAKEN' : 'VALIDATION_FAILED', {
            details: [
              {
                path: 'username',
                message: problem === 'RESERVED' ? 'Reserved.' : 'Invalid username.',
              },
            ],
          });
        }
        // Changing only the *case* of your own handle is free; a different handle is rate-limited
        // so identities cannot be churned to evade blocks and reports.
        const caseOnly = current.username.toLowerCase() === patch.username.toLowerCase();
        if (
          !caseOnly &&
          current.usernameChangedAt &&
          now.getTime() - current.usernameChangedAt.getTime() < USERNAME_COOLDOWN_MS
        ) {
          throw new AppError('USERNAME_CHANGE_COOLDOWN');
        }
        set.username = patch.username;
        if (!caseOnly) set.usernameChangedAt = now;
      }
    }
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.locationLabel !== undefined)
      set.locationLabel = patch.locationLabel === '' ? null : patch.locationLabel;
    if (patch.primarySport !== undefined) set.primarySportKey = patch.primarySport;

    if (Object.keys(set).length > 0) {
      try {
        await this.db.updateTable('profiles').set(set).where('userId', '=', userId).execute();
      } catch (err) {
        if (isUniqueViolation(err, 'profiles_username_key')) throw new AppError('USERNAME_TAKEN');
        throw err;
      }
    }
    return this.getProfile(userId, { id: userId });
  }

  /** Sets (or clears, with null) the avatar. The media must be a READY avatar-purpose image you own. */
  async setAvatar(userId: string, mediaId: string | null): Promise<Profile> {
    if (mediaId !== null) await this.media.assertReadyOwned(userId, mediaId, 'AVATAR');
    const previous = await this.db
      .selectFrom('profiles')
      .select('avatarMediaId')
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    await this.db
      .updateTable('profiles')
      .set({ avatarMediaId: mediaId })
      .where('userId', '=', userId)
      .execute();
    // The replaced avatar image is no longer referenced anywhere: reclaim its storage.
    if (previous.avatarMediaId && previous.avatarMediaId !== mediaId) {
      await this.media.delete(userId, previous.avatarMediaId).catch(() => undefined);
    }
    return this.getProfile(userId, { id: userId });
  }

  async updateSettings(userId: string, patch: UpdateSettingsRequest): Promise<Settings> {
    const user = await this.db
      .selectFrom('users')
      .select('birthDate')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    const age = ageOn(user.birthDate, this.clock.now());

    // Age policy: younger teens cannot run a PUBLIC account or publish PUBLIC content.
    if (age < this.config.MINOR_PUBLIC_MIN_AGE) {
      if (patch.accountVisibility === 'PUBLIC') throw new AppError('PUBLIC_ACCOUNT_NOT_ALLOWED');
      if (
        patch.defaultPostVisibility === 'PUBLIC' ||
        patch.defaultActivityVisibility === 'PUBLIC'
      ) {
        throw new AppError('PUBLIC_ACCOUNT_NOT_ALLOWED');
      }
    }

    await this.db.transaction().execute(async (trx) => {
      const profileSet: Record<string, unknown> = {};
      if (patch.discoverable !== undefined) profileSet.discoverable = patch.discoverable;

      if (patch.accountVisibility !== undefined) {
        const before = await trx
          .selectFrom('profiles')
          .select('accountVisibility')
          .where('userId', '=', userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (before.accountVisibility !== patch.accountVisibility) {
          profileSet.accountVisibility = patch.accountVisibility;
          // Going public: nobody should stay stuck in a queue for an account that no longer needs approval.
          if (patch.accountVisibility === 'PUBLIC') await this.social.acceptAllPending(userId, trx);
        }
      }
      if (Object.keys(profileSet).length > 0) {
        await trx.updateTable('profiles').set(profileSet).where('userId', '=', userId).execute();
      }

      const settingsSet: Record<string, unknown> = {};
      const direct = [
        'unitSystem',
        'defaultActivityVisibility',
        'defaultPostVisibility',
        'defaultCommentPermission',
        'defaultRoutePrivacy',
        'routeTrimMeters',
        'autoCreateActivityPost',
        'personalizationEnabled',
      ] as const;
      for (const key of direct) {
        if (patch[key] !== undefined) settingsSet[key] = patch[key];
      }
      if (Object.keys(settingsSet).length > 0) {
        await trx
          .updateTable('userSettings')
          .set(settingsSet)
          .where('userId', '=', userId)
          .execute();
      }
    });
    return this.getSettings(userId);
  }
}
