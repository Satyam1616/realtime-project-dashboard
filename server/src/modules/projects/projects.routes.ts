/**
 * Project routes.
 *
 * Two layers of enforcement, on purpose:
 *
 *   - `requireRole` on the route rejects a role that has no business here at
 *     all, before any query runs.
 *   - the service applies `projectScope()` in SQL, which is what stops a *valid*
 *     project manager from reaching another manager's project.
 *
 * The route guard alone would not be enough (every PM passes it) and the scope
 * alone would run needless queries for a developer hitting a write endpoint, so
 * both are present.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Role } from '../../db/client.js';
import { idParam, parseBody, parseParams, parseQuery, uuid } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import {
  addMemberSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  updateProjectSchema,
} from './projects.schemas.js';
import {
  addProjectMember,
  createProject,
  deleteProject,
  getProject,
  listProjectMembers,
  listProjects,
  removeProjectMember,
  updateProject,
} from './projects.service.js';
import { listActivity } from '../activity/activity.service.js';

const memberParams = z.object({ id: uuid, userId: uuid });

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // Every route below requires a valid access token whose subject still exists
  // and is still active in the database.
  app.addHook('preHandler', app.authenticate);

  /** All three roles may list projects; the scope decides what "all" means. */
  app.get('/', async (request, reply) => {
    const principal = requirePrincipal(request);
    const query = parseQuery(listProjectsQuerySchema, request.query);
    return reply.send(await listProjects(principal, query));
  });

  app.get('/:id', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    return reply.send({ project: await getProject(principal, id) });
  });

  /** The project's own activity slice, reusing the role-scoped feed query. */
  app.get('/:id/activity', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    const query = parseQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.coerce.number().int().positive().optional(),
      }),
      request.query,
    );

    // 404s before any activity is read if the project is out of scope.
    await getProject(principal, id);

    return reply.send(
      await listActivity(principal, {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        projectId: id,
      }),
    );
  });

  app.get('/:id/members', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    return reply.send({ members: await listProjectMembers(principal, id) });
  });

  app.post(
    '/',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const input = parseBody(createProjectSchema, request.body);
      const project = await createProject(principal, input);
      return reply.status(201).send({ project });
    },
  );

  app.patch(
    '/:id',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseParams(idParam, request.params);
      const patch = parseBody(updateProjectSchema, request.body);
      return reply.send({ project: await updateProject(principal, id, patch) });
    },
  );

  app.delete('/:id', { preHandler: app.requireRole(Role.ADMIN) }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseParams(idParam, request.params);
    await deleteProject(principal, id);
    return reply.status(204).send();
  });

  app.post(
    '/:id/members',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseParams(idParam, request.params);
      const { userId } = parseBody(addMemberSchema, request.body);
      return reply.status(201).send({ members: await addProjectMember(principal, id, userId) });
    },
  );

  app.delete(
    '/:id/members/:userId',
    { preHandler: app.requireRole(Role.ADMIN, Role.PROJECT_MANAGER) },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id, userId } = parseParams(memberParams, request.params);
      return reply.send({ members: await removeProjectMember(principal, id, userId) });
    },
  );
};
