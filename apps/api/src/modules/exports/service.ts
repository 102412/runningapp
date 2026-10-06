import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { DataExport } from '@runningapp/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from '../../platform/clock';
import type { Db } from '../../platform/db/client';
import { isUniqueViolation } from '../../platform/db/errors';
import { AppError } from '../../platform/errors';
import { verifyPassword } from '../../platform/crypto/password';
import { jobSpec, type JobQueue } from '../../platform/jobs/queue';
import type { ObjectStorage } from '../../platform/storage/types';
import type { UserRepository } from '../users/repository';
import { writeExport } from './builder';

export const ExportBuildJob = jobSpec('exports.build', z.object({ exportId: z.uuid() }), {
  maxAttempts: 2,
});
export const ExportExpireJob = jobSpec('exports.expire', z.object({}), { maxAttempts: 3 });

const DAY_MS = 86_400_000;
/** One new export per user per day: building one reads their entire history. */
const MIN_INTERVAL_MS = DAY_MS;
const RETENTION_MS = 7 * DAY_MS;
const DOWNLOAD_URL_TTL_MS = 15 * 60_000;
const KEEP_LISTED = 10;

/**
 * Personal data export. Requesting one needs the account password (so a stolen session cannot
 * quietly pull someone's entire history), is rate-limited, runs as a background job, and produces
 * a private JSON file in object storage that is deleted after seven days. Downloads are
 * short-lived signed URLs that are generated on demand and never stored.
 */
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobQueue,
    private readonly storage: ObjectStorage,
    private readonly users: UserRepository,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async request(userId: string, password: string): Promise<DataExport> {
    const user = await this.users.findById(userId);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new AppError('PASSWORD_INCORRECT');
    }

    const now = this.clock.now();
    // Already building one? Hand it back instead of queueing another.
    const active = await this.db
      .selectFrom('dataExports')
      .selectAll()
      .where('userId', '=', userId)
      .where('status', 'in', ['PENDING', 'PROCESSING'])
      .executeTakeFirst();
    if (active) return this.toDto(active);

    const recent = await this.db
      .selectFrom('dataExports')
      .select('requestedAt')
      .where('userId', '=', userId)
      .where('status', '!=', 'FAILED')
      .where('requestedAt', '>', new Date(now.getTime() - MIN_INTERVAL_MS))
      .executeTakeFirst();
    if (recent) {
      throw new AppError('RATE_LIMITED', {
        message: 'You can request one data export per day. Download your latest export instead.',
      });
    }

    try {
      const created = await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('dataExports')
          .values({ userId, requestedAt: now })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.jobs.enqueue(ExportBuildJob, { exportId: row.id }, { db: trx });
        return row;
      });
      return this.toDto(created);
    } catch (err) {
      // Two simultaneous requests: the unique index admits only one active export.
      if (isUniqueViolation(err)) {
        const winner = await this.db
          .selectFrom('dataExports')
          .selectAll()
          .where('userId', '=', userId)
          .where('status', 'in', ['PENDING', 'PROCESSING'])
          .executeTakeFirstOrThrow();
        return this.toDto(winner);
      }
      throw err;
    }
  }

  async list(userId: string): Promise<DataExport[]> {
    const rows = await this.db
      .selectFrom('dataExports')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('requestedAt', 'desc')
      .limit(KEEP_LISTED)
      .execute();
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  async get(userId: string, id: string): Promise<DataExport> {
    const row = await this.db
      .selectFrom('dataExports')
      .selectAll()
      .where('id', '=', id)
      .where('userId', '=', userId) // someone else's export is indistinguishable from a missing one
      .executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND');
    return this.toDto(row);
  }

  // ------------------------------------------------------------------ background jobs

  readonly handleBuild = async (payload: { exportId: string }): Promise<void> => {
    const claimed = await this.db
      .updateTable('dataExports')
      .set({ status: 'PROCESSING' })
      .where('id', '=', payload.exportId)
      .where('status', 'in', ['PENDING', 'PROCESSING'])
      .returning(['id', 'userId'])
      .executeTakeFirst();
    if (!claimed) return; // already finished, expired, or the account is gone

    const work = await mkdtemp(path.join(os.tmpdir(), 'runningapp-export-'));
    const file = path.join(work, 'export.json');
    const key = `exports/${claimed.userId}/${claimed.id}.json`;
    try {
      await writeExport(this.db, claimed.userId, file, this.clock.now());
      const { size } = await stat(file);
      await this.storage.uploadFile(key, file, 'application/json');
      const now = this.clock.now();
      await this.db
        .updateTable('dataExports')
        .set({
          status: 'READY',
          storageKey: key,
          sizeBytes: size,
          completedAt: now,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
          error: null,
        })
        .where('id', '=', claimed.id)
        .execute();
    } catch (err) {
      // A failed export is final (the user can ask again); no retry loop over their whole history.
      this.logger.error({ err, exportId: claimed.id }, 'data export failed');
      await this.storage.delete(key).catch(() => undefined);
      await this.db
        .updateTable('dataExports')
        .set({
          status: 'FAILED',
          error: 'The export could not be generated.',
          completedAt: this.clock.now(),
        })
        .where('id', '=', claimed.id)
        .execute();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  /** Deletes expired export files. */
  readonly handleExpire = async (): Promise<void> => {
    const due = await this.db
      .selectFrom('dataExports')
      .select(['id', 'storageKey'])
      .where('status', '=', 'READY')
      .where('expiresAt', '<=', this.clock.now())
      .limit(200)
      .execute();
    for (const row of due) {
      if (row.storageKey) await this.storage.delete(row.storageKey);
      await this.db
        .updateTable('dataExports')
        .set({ status: 'EXPIRED', storageKey: null })
        .where('id', '=', row.id)
        .execute();
    }
  };

  // ------------------------------------------------------------------ DTO

  private async toDto(row: {
    id: string;
    status: DataExport['status'];
    storageKey: string | null;
    sizeBytes: number | null;
    requestedAt: Date;
    completedAt: Date | null;
    expiresAt: Date | null;
  }): Promise<DataExport> {
    const now = this.clock.now();
    const downloadable =
      row.status === 'READY' && row.storageKey && row.expiresAt && row.expiresAt > now;
    return {
      id: row.id,
      status: row.status,
      requestedAt: row.requestedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      sizeBytes: row.sizeBytes,
      downloadUrl: downloadable
        ? await this.storage.signedReadUrl(
            row.storageKey as string,
            new Date(now.getTime() + DOWNLOAD_URL_TTL_MS),
          )
        : null,
    };
  }
}
