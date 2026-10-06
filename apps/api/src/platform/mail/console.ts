import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/client';
import type { Mailer, MailMessage } from './types';

/**
 * Development/test mailer: persists messages to `dev_mail_outbox` so UI developers and tests can
 * read verification/reset links via GET /v1/dev/outbox. Production config refuses this driver.
 */
export class ConsoleMailer implements Mailer {
  constructor(
    private readonly db: Db,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await this.db
      .insertInto('devMailOutbox')
      .values({
        toEmail: message.to,
        subject: message.subject,
        textBody: message.text,
        template: message.template,
        token: message.token ?? null,
      })
      .execute();
    this.logger.info(
      { template: message.template, to: message.to },
      'dev mail captured (see /v1/dev/outbox)',
    );
  }
}
