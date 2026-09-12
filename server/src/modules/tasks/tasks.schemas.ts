import { z } from 'zod';
import { isoDate, text, uuid } from '../../lib/validate.js';

export const taskStatusEnum = z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);
export const taskPriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * Accepts either `?status=TODO` or `?status=TODO,IN_PROGRESS`.
 *
 * Query strings are the only filter mechanism in this API precisely so a
 * filtered view is a URL someone can paste into Slack, so multi-select has to
 * survive the round trip through the address bar.
 *
 * Takes the already-declared enum schema rather than its `.options` tuple, so
 * the element type is preserved exactly — `z.infer` yields `TaskStatus[]`, which
 * is what Prisma's `{ status: { in: … } }` filter requires.
 */
const csvOf = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : value,
    z.array(schema).min(1),
  );

export const createTaskSchema = z.object({
  projectId: uuid,
  title: text(180),
  description: text(5000, { min: 0 }).optional(),
  /** Optional: a task can be created unassigned and picked up later. */
  assigneeId: uuid.nullable().optional(),
  status: taskStatusEnum.optional(),
  priority: taskPriorityEnum.optional(),
  dueDate: isoDate.nullable().optional(),
});

/**
 * Every field is optional, but which ones a caller may actually send is decided
 * by role, not by this schema — see `assertCanUpdateTask` in src/access/rbac.ts.
 * A developer sending `priority` is rejected with a 403 naming the field rather
 * than having it silently dropped, so the API never lies about what it did.
 */
export const updateTaskSchema = z
  .object({
    title: text(180).optional(),
    description: text(5000, { min: 0 }).nullable().optional(),
    assigneeId: uuid.nullable().optional(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field must be provided.');

/**
 * Task list filters. All of them are query parameters, so
 * `/tasks?status=IN_PROGRESS,IN_REVIEW&priority=HIGH,CRITICAL&dueTo=2026-09-30`
 * is a shareable link that reconstructs the exact view.
 *
 * Note `assigneeId` is accepted from every role but is *narrowed* by
 * `taskScope()` — a developer passing another developer's id gets an empty list,
 * not someone else's work.
 */
export const listTasksQuerySchema = z.object({
  projectId: uuid.optional(),
  status: csvOf(taskStatusEnum).optional(),
  priority: csvOf(taskPriorityEnum).optional(),
  assigneeId: uuid.optional(),
  /** `?unassigned=true` — useful for a PM triaging a backlog. */
  unassigned: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: text(120).optional(),
  /**
   * `priority` sorts CRITICAL-first because the Prisma enum is declared
   * ascending (LOW → CRITICAL) and Postgres orders enums by declaration
   * order, so a descending sort is the useful one. `dueDate` is applied as a
   * secondary key for the developer dashboard's "priority, then deadline".
   */
  sort: z.enum(['priority', 'dueDate', 'createdAt', 'updatedAt', 'status', 'number', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
