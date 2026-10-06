import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './types';

/** Delivers through any SMTP server (Postmark/SES/SendGrid SMTP relay, Mailpit locally). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
