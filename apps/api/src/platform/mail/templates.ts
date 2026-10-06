import { z } from 'zod';

export const MailTemplate = z.enum([
  'verify_email',
  'password_reset',
  'password_changed',
  'account_deletion_scheduled',
]);
export type MailTemplate = z.infer<typeof MailTemplate>;

export interface RenderedMail {
  subject: string;
  text: string;
}

export interface TemplateVars {
  displayName: string;
  /** Fully-built link containing the raw token (verify/reset). */
  link?: string;
  /** ISO date string (deletion). */
  scheduledFor?: string;
}

/** Plain-text transactional email. Deliberately minimal: product copy/branding is a later concern. */
export function renderMail(template: MailTemplate, vars: TemplateVars): RenderedMail {
  const hi = `Hi ${vars.displayName},`;
  switch (template) {
    case 'verify_email':
      return {
        subject: 'Confirm your email address',
        text: `${hi}\n\nConfirm your email address to finish setting up your account:\n${vars.link ?? ''}\n\nThis link expires soon. If you didn't create an account, ignore this email.`,
      };
    case 'password_reset':
      return {
        subject: 'Reset your password',
        text: `${hi}\n\nUse this link to choose a new password:\n${vars.link ?? ''}\n\nIf you didn't request this, you can ignore this email; your password has not changed.`,
      };
    case 'password_changed':
      return {
        subject: 'Your password was changed',
        text: `${hi}\n\nYour password was just changed and you were signed out of your other devices. If this wasn't you, reset your password immediately.`,
      };
    case 'account_deletion_scheduled':
      return {
        subject: 'Your account is scheduled for deletion',
        text: `${hi}\n\nYour account will be permanently deleted on ${vars.scheduledFor ?? 'the scheduled date'}. Sign in before then and cancel to keep it.`,
      };
  }
}
