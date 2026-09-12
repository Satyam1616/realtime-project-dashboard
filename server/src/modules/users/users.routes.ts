/**
 * User routes.
 *
 * `/assignable` is the only one a project manager can reach: they need a picker
 * to assign work, and nothing more. Everything else is admin-only, enforced both
 * by `requireRole` here and by `assertAdmin` in the service — so a future caller
 * that skips the route guard still cannot read account state.
 */
import type { FastifyPluginAsync } from 'fastify';
import { Role } from '../../db/client.js';
import { idParam, parseBody, parseParams, parseQuery } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import {
  assignableQuerySchema,
  createUserSchema,
  listUsersQuerySchema,
  updateUserSchema,
} from './users.schemas.js';
import { createUser, getUser, listAssignableUsers, listUsers, updateUser } from './users.service.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /** Assignee picker — admins and project managers. */
  app.get(
    '/assignable',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const query = parseQuery(assignableQuerySchema, request.query);
      return reply.send({ users: await listAssignableUsers(principal, query) });
    },
  );

  app.get('/', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseQuery(listUsersQuerySchema, request.query);
    return reply.send(await listUsers(principal, query));
  });

  app.get('/:id', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    return reply.send({ user: await getUser(principal, id) });
  });

  app.post('/', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parseBody(createUserSchema, request.body);
    return reply.status(201).send({ user: await createUser(principal, input) });
  });

  app.patch('/:id', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    const patch = parseBody(updateUserSchema, request.body);
    return reply.send({ user: await updateUser(principal, id, patch) });
  });
};
