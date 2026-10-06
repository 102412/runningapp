import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  MarkReadRequestSchema,
  MarkReadResultSchema,
  NotificationListQuerySchema,
  NotificationPageSchema,
  NotificationPreferencesSchema,
  RegisterPushTokenRequestSchema,
  UnreadCountSchema,
  UpdateNotificationPreferencesRequestSchema,
} from '@runningapp/contracts';
import { actor } from '../../platform/http/auth-context';
import { RATE_LIMITS, rateLimitConfig } from '../../platform/http/rate-limits';
import { BEARER_SECURITY, NoContent, errors } from '../../platform/http/route-helpers';
import type { Services } from '../../services';

export async function notificationRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.route({
    method: 'GET',
    url: '/notifications',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Notifications'],
      operationId: 'listNotifications',
      summary: 'Your notifications, newest first',
      description:
        'Notifications about people you blocked, or posts/comments that were deleted, hidden or left your audience, are omitted. Each item carries enough (actor, post preview, comment excerpt) to render without extra requests.',
      security: BEARER_SECURITY,
      querystring: NotificationListQuerySchema,
      response: { 200: NotificationPageSchema, ...errors(400, 401, 422) },
    },
    handler: async (req) => s.notifications.list(actor(req).userId, req.query),
  });

  r.route({
    method: 'GET',
    url: '/notifications/unread-count',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Notifications'],
      operationId: 'getUnreadNotificationCount',
      summary: 'Badge count (capped at 100)',
      security: BEARER_SECURITY,
      response: { 200: UnreadCountSchema, ...errors(401) },
    },
    handler: async (req) => ({ count: await s.notifications.unreadCount(actor(req).userId) }),
  });

  r.route({
    method: 'POST',
    url: '/notifications/read',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Notifications'],
      operationId: 'markNotificationsRead',
      summary: 'Mark notifications read: specific ids, or `all: true`',
      security: BEARER_SECURITY,
      body: MarkReadRequestSchema,
      response: { 200: MarkReadResultSchema, ...errors(401, 422, 429) },
    },
    handler: async (req) => ({
      updated: await s.notifications.markRead(actor(req).userId, req.body),
    }),
  });

  r.route({
    method: 'GET',
    url: '/me/notification-preferences',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Notifications'],
      operationId: 'getNotificationPreferences',
      summary: 'Which notification types you receive in-app and as push',
      security: BEARER_SECURITY,
      response: { 200: NotificationPreferencesSchema, ...errors(401) },
    },
    handler: async (req) => ({ items: await s.notifications.getPreferences(actor(req).userId) }),
  });

  r.route({
    method: 'PUT',
    url: '/me/notification-preferences',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Notifications'],
      operationId: 'updateNotificationPreferences',
      summary: 'Update preferences for the given types (others unchanged)',
      description: 'Turning `inApp` off suppresses the notification entirely, including its push.',
      security: BEARER_SECURITY,
      body: UpdateNotificationPreferencesRequestSchema,
      response: { 200: NotificationPreferencesSchema, ...errors(401, 422, 429) },
    },
    handler: async (req) => ({
      items: await s.notifications.setPreferences(actor(req).userId, req.body.items),
    }),
  });

  r.route({
    method: 'PUT',
    url: '/me/device/push-token',
    onRequest: app.requireAuth,
    config: rateLimitConfig(RATE_LIMITS.write),
    schema: {
      tags: ['Notifications'],
      operationId: 'registerPushToken',
      summary: "Register this device's push token (APNs/FCM/Expo)",
      description:
        'Attaches the token to the device behind the current session. If you signed in without `device` info, also send `installId` and `platform`. Delivery requires a push provider to be configured server-side (see HANDOFF.md); until then registration works but nothing is sent.',
      security: BEARER_SECURITY,
      body: RegisterPushTokenRequestSchema,
      response: { 204: NoContent, ...errors(401, 422, 429) },
    },
    handler: async (req, reply) => {
      await s.notifications.registerPushToken(actor(req).userId, actor(req).sessionId, req.body);
      return reply.status(204).send();
    },
  });

  r.route({
    method: 'DELETE',
    url: '/me/device/push-token',
    onRequest: app.requireAuth,
    schema: {
      tags: ['Notifications'],
      operationId: 'removePushToken',
      summary: 'Stop push notifications on this device',
      security: BEARER_SECURITY,
      response: { 204: NoContent, ...errors(401) },
    },
    handler: async (req, reply) => {
      await s.notifications.removePushToken(actor(req).userId, actor(req).sessionId);
      return reply.status(204).send();
    },
  });
}
