import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../clock';
import type { Db } from '../db/client';
import { AppError } from '../errors';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TTL_MS = 24 * 3600_000;
/** An IN_PROGRESS record older than this belongs to a crashed request and may be taken over. */
const STALE_MS = 2 * 60_000;

/**
 * `Idempotency-Key` support for non-idempotent POSTs (create post / activity / comment).
 *
 * A client that retries after a lost response sends the same key and gets the ORIGINAL response
 * replayed instead of a duplicate resource. Keys are scoped per user and bound to the exact
 * request (method + path + body hash): reusing a key with a different request is an error.
 * Requests without the header behave normally.
 */
export class IdempotencyService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    work: () => Promise<{ status: number; body: unknown }>,
  ): Promise<FastifyReply> {
    const header = request.headers['idempotency-key'];
    if (header === undefined) {
      const out = await work();
      return reply.status(out.status).send(out.body);
    }
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new AppError('VALIDATION_FAILED', {
        details: [
          {
            path: 'headers.idempotency-key',
            message: '8-128 characters: letters, digits, "_" or "-".',
          },
        ],
      });
    }

    const hash = createHash('sha256')
      .update(
        `${request.method}\n${request.url.split('?')[0] ?? ''}\n${JSON.stringify(request.body ?? null)}`,
      )
      .digest('hex');
    const now = this.clock.now();

    const claimed = await this.db
      .insertInto('idempotencyKeys')
      .values({
        userId,
        key: header,
        requestHash: hash,
        state: 'IN_PROGRESS',
        expiresAt: new Date(now.getTime() + TTL_MS),
        createdAt: now,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('key')
      .executeTakeFirst();

    if (!claimed) {
      const existing = await this.db
        .selectFrom('idempotencyKeys')
        .selectAll()
        .where('userId', '=', userId)
        .where('key', '=', header)
        .executeTakeFirst();
      if (existing) {
        if (existing.requestHash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
        if (existing.state === 'COMPLETED' && existing.responseStatus !== null) {
          void reply.header('idempotent-replayed', 'true');
          return reply.status(existing.responseStatus).send(existing.responseBody);
        }
        if (now.getTime() - existing.createdAt.getTime() < STALE_MS)
          throw new AppError('IDEMPOTENCY_IN_PROGRESS', { headers: { 'retry-after': '2' } });
        // Abandoned by a crashed request: take it over.
        await this.db
          .deleteFrom('idempotencyKeys')
          .where('userId', '=', userId)
          .where('key', '=', header)
          .execute();
        return this.handle(request, reply, userId, work);
      }
      return this.handle(request, reply, userId, work); // raced with an expiry sweep: retry once more
    }

    try {
      const out = await work();
      await this.db
        .updateTable('idempotencyKeys')
        .set({
          state: 'COMPLETED',
          responseStatus: out.status,
          responseBody: JSON.stringify(out.body),
        })
        .where('userId', '=', userId)
        .where('key', '=', header)
        .execute();
      return reply.status(out.status).send(out.body);
    } catch (err) {
      // A failed attempt must not poison the key: the client may retry with the same one.
      await this.db
        .deleteFrom('idempotencyKeys')
        .where('userId', '=', userId)
        .where('key', '=', header)
        .execute();
      throw err;
    }
  }
}
