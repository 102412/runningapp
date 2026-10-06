export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Template id, for logging and the dev outbox. */
  template: string;
  /** Single-use token embedded in the message (dev outbox only; never logged). */
  token?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
