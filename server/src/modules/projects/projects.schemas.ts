import { z } from 'zod';
import { isoDate, text, uuid } from '../../lib/validate.js';

/** `ProjectStatus` values, listed literally so query strings validate cleanly. */
export const projectStatusEnum = z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']);

export const createProjectSchema = z.object({
  name: text(140),
  description: text(2000, { min: 0 }).optional(),
  clientId: uuid,
  /**
   * Admin-only field: lets an admin create a project on another manager's
   * behalf. A project manager who sends it is rejected in the service layer, so
   * they cannot hand their project to someone else (or take one).
   */
  managerId: uuid.optional(),
  status: projectStatusEnum.optional(),
  startDate: isoDate.optional(),
  dueDate: isoDate.optional(),
});

export const updateProjectSchema = z
  .object({
    name: text(140).optional(),
    description: text(2000, { min: 0 }).nullable().optional(),
    clientId: uuid.optional(),
    status: projectStatusEnum.optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field must be provided.');

/**
 * List filters. Every one is a query parameter so a filtered view is a
 * shareable URL — `/projects?status=ACTIVE&q=redesign` round-trips exactly.
 */
export const listProjectsQuerySchema = z.object({
  status: projectStatusEnum.optional(),
  clientId: uuid.optional(),
  /** Admin-only; ignored for other roles, whose scope already pins the manager. */
  managerId: uuid.optional(),
  q: text(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['name', 'dueDate', 'createdAt', 'updatedAt']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const addMemberSchema = z.object({ userId: uuid });

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
