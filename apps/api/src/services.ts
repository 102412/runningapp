import { ActivityFlows } from './flows/log-activity';
import { ActivityService } from './modules/activities/service';
import { AccessTokenService } from './modules/auth/access-token';
import { AuthService } from './modules/auth/service';
import { IntegrationService } from './modules/integrations/service';
import { ProfileService } from './modules/profiles/service';
import { DbNotifier, type Notifier } from './modules/notifier';
import { SocialService } from './modules/social/service';
import { SportService } from './modules/sports/service';
import { AgePolicy } from './modules/users/age-policy';
import { UserDirectory } from './modules/users/directory';
import { UserRepository } from './modules/users/repository';
import type { PlatformContext } from './platform/context';
import { ConsoleMailer } from './platform/mail/console';
import { MailService } from './platform/mail/service';
import { SmtpMailer } from './platform/mail/smtp';
import type { Mailer } from './platform/mail/types';

/**
 * Composition root. Every module's service is constructed here, in dependency order, so the
 * whole dependency graph is visible in one file. Modules never import each other's internals;
 * they receive what they need through their factory's parameters.
 *
 * Layering (a module may only depend on those above it):
 *   platform -> notifier, users -> auth, sports, social -> profiles -> (content modules ...)
 */
export interface Services {
  readonly platform: PlatformContext;
  readonly accessTokens: AccessTokenService;
  readonly mail: MailService;
  readonly notifier: Notifier;
  readonly users: UserRepository;
  readonly directory: UserDirectory;
  readonly auth: AuthService;
  readonly sports: SportService;
  readonly social: SocialService;
  readonly profiles: ProfileService;
  readonly agePolicy: AgePolicy;
  readonly activities: ActivityService;
  readonly integrations: IntegrationService;
  readonly flows: ActivityFlows;
}

export interface ServiceOverrides {
  mailer?: Mailer;
}

export function createServices(
  platform: PlatformContext,
  overrides: ServiceOverrides = {},
): Services {
  const { config, db, clock, logger, jobs, metrics } = platform;

  const mailer: Mailer =
    overrides.mailer ??
    (config.MAIL_DRIVER === 'smtp' && config.SMTP_URL
      ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM)
      : new ConsoleMailer(db, logger));
  const mail = new MailService(config, jobs, mailer);

  const notifier = new DbNotifier(db);
  const users = new UserRepository(db);
  const directory = new UserDirectory(db);
  const accessTokens = new AccessTokenService(config, clock);
  const auth = new AuthService(config, db, clock, users, accessTokens, mail, metrics);
  const sports = new SportService(db, clock);
  const social = new SocialService(db, directory, notifier);
  const profiles = new ProfileService(config, db, clock, directory, social);
  const agePolicy = new AgePolicy(config, db, clock);
  const activities = new ActivityService(db, clock, sports, directory, agePolicy);
  const integrations = new IntegrationService(db);
  const flows = new ActivityFlows(db, activities);

  return {
    platform,
    accessTokens,
    mail,
    notifier,
    users,
    directory,
    auth,
    sports,
    social,
    profiles,
    agePolicy,
    activities,
    integrations,
    flows,
  };
}
