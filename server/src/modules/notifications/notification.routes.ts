/**
 * Notification routes.
 *
 * There is no `GET /count` endpoint on purpose — the unread badge is pushed over
 * the socket (`notification:count`) and never polled. The count returned
 * alongside the list here is for the initial render only.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { idParam, parseParams, parseQuery } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notification.service.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** ISO timestamp of the oldest row already shown. */
  cursor: z.string().trim().min(1).optional(),
  unreadOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseQuery(listQuerySchema, request.query);

    return reply.send(
      await listNotifications(principal, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.unreadOnly !== undefined ? { unreadOnly: query.unreadOnly } : {}),
      }),
    );
  });

  /**
   * Scoped by recipient inside the `updateMany` filter, so one user cannot mark
   * another's notification read — and gets a 404 rather than a 403, which would
   * confirm the id exists.
   */
  app.post('/:id/read', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    const unread = await markNotificationRead(principal, id);
    return reply.send({ unread });
  });

  app.post('/read-all', async (request, reply) => {
    const principal = requirePrincipal(request);
    const unread = await markAllNotificationsRead(principal);
    return reply.send({ unread });
  });
};
