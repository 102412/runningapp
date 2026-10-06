import type { Db } from '../../platform/db/client';

export interface DevMail {
  id: string;
  to: string;
  subject: string;
  template: string;
  token: string | null;
  text: string;
  createdAt: string;
}

/** Read side of the console mailer's outbox (development only; see routes.ts). */
export class DevOutbox {
  constructor(private readonly db: Db) {}

  async list(args: { to?: string | undefined; limit: number }): Promise<DevMail[]> {
    let q = this.db.selectFrom('devMailOutbox').selectAll().orderBy('id', 'desc').limit(args.limit);
    if (args.to) q = q.where('toEmail', '=', args.to.toLowerCase());
    const rows = await q.execute();
    return rows.map((m) => ({
      id: m.id,
      to: m.toEmail,
      subject: m.subject,
      template: m.template,
      token: m.token,
      text: m.textBody,
      createdAt: m.createdAt.toISOString(),
    }));
  }
}
