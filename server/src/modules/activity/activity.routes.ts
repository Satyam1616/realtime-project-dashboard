/**
 * Activity feed routes.
 *
 * These are the REST half of the real-time feed. The `/catchup` endpoint is the
 * answer to "an offline user must see the last 20 events they missed": it is
 * served from Postgres via the user's persisted `ActivityCursor`, so it is
 * correct after a server restart, a redeploy, or a week away — nothing is held
 * in memory.
 *
 * `GET /` and the socket's `activity:new` return the identical DTO, so the
 * client renders live and replayed events with one code path.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseBody, parseQuery, uuid } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import { advanceActivityCursor, catchUpActivity, listActivity } from './activity.service.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** `seq` of the oldest row already shown — exclusive upper bound. */
  cursor: z.coerce.number().int().positive().optional(),
  projectId: uuid.optional(),
});

const catchUpQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const seenSchema = z.object({ seq: z.coerce.number().int().min(0) });

export const activityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * The role-scoped feed, newest first. Admin gets everything, a PM their own
   * projects, a developer only events on tasks assigned to them — all applied in
   * SQL by `activityScope()`, the same fragment the socket fanout mirrors.
   */
  app.get('/', async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseQuery(listQuerySchema, request.query);

    return reply.send(
      await listActivity(principal, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
      }),
    );
  });

  /** "What did I miss?" — called once on connect, before the socket takes over. */
  app.get('/catchup', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { limit } = parseQuery(catchUpQuerySchema, request.query);
    return reply.send(await catchUpActivity(principal, limit));
  });

  /**
   * Advances the user's high-water mark. Also available over the socket as
   * `activity:seen`; both go through the same monotonic update, so a late
   * acknowledgement cannot rewind the cursor and re-show read events.
   */
  app.post('/seen', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { seq } = parseBody(seenSchema, request.body);
    await advanceActivityCursor(principal.id, seq);
    return reply.status(204).send();
  });
};
