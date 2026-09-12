/**
 * Client routes.
 *
 * Reads are open to admins and project managers (a PM must pick a client when
 * creating a project); writes are admin-only. As everywhere else, the route
 * guard and the service assertion both hold — the guard so an unauthorised role
 * never reaches a query, the assertion so the rule survives a future caller that
 * bypasses the route.
 */
import type { FastifyPluginAsync } from 'fastify';
import { Role } from '../../db/client.js';
import { idParam, parseBody, parseParams, parseQuery } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import { createClientSchema, listClientsQuerySchema, updateClientSchema } from './clients.schemas.js';
import { createClient, deleteClient, getClient, listClients, updateClient } from './clients.service.js';

export const clientRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const query = parseQuery(listClientsQuerySchema, request.query);
      return reply.send(await listClients(principal, query));
    },
  );

  app.get(
    '/:id',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseParams(idParam, request.params);
      return reply.send({ client: await getClient(principal, id) });
    },
  );

  app.post('/', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parseBody(createClientSchema, request.body);
    return reply.status(201).send({ client: await createClient(principal, input) });
  });

  app.patch('/:id', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    const patch = parseBody(updateClientSchema, request.body);
    return reply.send({ client: await updateClient(principal, id, patch) });
  });

  app.delete('/:id', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    await deleteClient(principal, id);
    return reply.status(204).send();
  });
};
