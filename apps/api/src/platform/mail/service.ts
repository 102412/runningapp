import { z } from 'zod';
import type { Config } from '../../config';
import { seal, unseal } from '../crypto/seal';
import type { Db } from '../db/client';
import { jobSpec, type JobQueue } from '../jobs/queue';
import type { Mailer } from './types';
import { MailTemplate, renderMail, type TemplateVars } from './templates';

export const SendEmailJob = jobSpec(
  'email.send',
  z.object({
    to: z.string(),
    template: MailTemplate,
    displayName: z.string(),
    /** Link path+query WITHOUT the token, e.g. "verify-email?token=". */
    linkPrefix: z.string().optional(),
    /** The raw token, AES-GCM sealed so the database never holds a usable capability. */
    sealedToken: z.string().optional(),
    scheduledFor: z.string().optional(),
  }),
  { maxAttempts: 8 },
);

export interface EmailRequest {
  to: string;
  template: MailTemplate;
  displayName: string;
  /** e.g. "verify-email?token=". The raw token is appended when the email is rendered. */
  linkPrefix?: string;
  token?: string;
  scheduledFor?: string;
}

/** Queues transactional email (retries, off the request path) and renders it in the worker. */
export class MailService {
  constructor(
    private readonly config: Config,
    private readonly jobs: JobQueue,
    private readonly mailer: Mailer,
  ) {}

  /** Enqueue inside the caller's transaction so the email is sent iff the change commits. */
  async enqueue(request: EmailRequest, db?: Db): Promise<void> {
    await this.jobs.enqueue(
      SendEmailJob,
      {
        to: request.to,
        template: request.template,
        displayName: request.displayName,
        linkPrefix: request.linkPrefix,
        sealedToken: request.token ? seal(this.config.JWT_SECRET, request.token) : undefined,
        scheduledFor: request.scheduledFor,
      },
      { db },
    );
  }

  /** Job handler. */
  readonly handleSendEmail = async (
    payload: z.output<typeof SendEmailJob.schema>,
  ): Promise<void> => {
    const secrets = [
      this.config.JWT_SECRET,
      ...(this.config.JWT_SECRET_PREVIOUS ? [this.config.JWT_SECRET_PREVIOUS] : []),
    ];
    const token = payload.sealedToken ? unseal(secrets, payload.sealedToken) : undefined;
    const vars: TemplateVars = {
      displayName: payload.displayName,
      scheduledFor: payload.scheduledFor,
      link:
        token && payload.linkPrefix
          ? `${this.config.EMAIL_LINK_BASE_URL}${payload.linkPrefix}${encodeURIComponent(token)}`
          : undefined,
    };
    const rendered = renderMail(payload.template, vars);
    await this.mailer.send({ to: payload.to, template: payload.template, token, ...rendered });
  };
}
