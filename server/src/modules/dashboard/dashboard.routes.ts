/**
 * One dashboard endpoint, three payloads.
 *
 * The client does not ask for a variant — the server picks it from the
 * authenticated principal's role, so there is no parameter to tamper with and a
 * developer cannot request the admin shape.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import { getDashboard } from './dashboard.service.js';

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.send(await getDashboard(principal));
  });
};
