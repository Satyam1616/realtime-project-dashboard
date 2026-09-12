/**
 * Task routes.
 *
 * `GET /` is open to all three roles because the *scope*, not the route guard,
 * is what decides whose tasks come back — a developer hitting this endpoint with
 * any combination of query parameters still only ever sees their own
 * assignments. Write routes carry an additional `requireRole` so a developer is
 * turned away before a query runs, except `PATCH /:id`, which a developer is
 * legitimately allowed to call to move their own task along the board (the
 * per-role field allowlist in rbac.ts is what stops them changing anything
 * else).
 */
import type { FastifyPluginAsync } from 'fastify';
import { Role } from '../../db/client.js';
import { idParam, parseBody, parseParams, parseQuery } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import { createTaskSchema, listTasksQuerySchema, updateTaskSchema } from './tasks.schemas.js';
import { createTask, deleteTask, getTask, listTasks, updateTask } from './tasks.service.js';
import { listTaskActivity } from '../activity/activity.service.js';

export const taskRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseQuery(listTasksQuerySchema, request.query);
    return reply.send(await listTasks(principal, query));
  });

  app.get('/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    return reply.send({ task: await getTask(principal, id) });
  });

  /** The task's own history — the durable status-change log, not a derivation. */
  app.get('/:id/activity', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    // 404s first if the task is out of scope, so the history cannot be read
    // for a task the caller cannot see.
    await getTask(principal, id);
    return reply.send({ items: await listTaskActivity(principal, id) });
  });

  app.post(
    '/',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const input = parseBody(createTaskSchema, request.body);
      return reply.status(201).send({ task: await createTask(principal, input) });
    },
  );

  /** All roles may call this; what each may *change* is decided in rbac.ts. */
  app.patch('/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    const patch = parseBody(updateTaskSchema, request.body);
    return reply.send({ task: await updateTask(principal, id, patch) });
  });

  app.delete(
    '/:id',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseParams(idParam, request.params);
      await deleteTask(principal, id);
      return reply.status(204).send();
    },
  );
};
