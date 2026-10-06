import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { DevMailListSchema, DevMailQuerySchema } from '@runningapp/contracts';
import { errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

/** Development-only helpers. Registered only when DEV_ENDPOINTS_ENABLED (refused in production). */
export async function devRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/dev/outbox',
    schema: {
      tags: ['Dev'],
      operationId: 'devListOutbox',
      summary:
        'DEV ONLY: emails captured by the console mailer (includes raw verification/reset tokens)',
      querystring: DevMailQuerySchema,
      response: { 200: DevMailListSchema, ...errors(422) },
    },
    handler: async (req) => {
      let q = s.platform.db
        .selectFrom('devMailOutbox')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(req.query.limit);
      if (req.query.to) q = q.where('toEmail', '=', req.query.to.toLowerCase());
      const rows = await q.execute();
      return {
        items: rows.map((m) => ({
          id: m.id,
          to: m.toEmail,
          subject: m.subject,
          template: m.template,
          token: m.token,
          text: m.textBody,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    },
  });
}
