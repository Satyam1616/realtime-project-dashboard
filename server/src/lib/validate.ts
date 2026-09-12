/**
 * Server-side input validation.
 *
 * Frontend validation is a UX affordance, not a control. Every route parses its
 * body / query / params through a Zod schema here, so a handler can only ever
 * see data of the shape it declared. Zod failures are converted into the same
 * structured envelope as every other error, with per-field details.
 */
import { z, type ZodType } from 'zod';
import { badRequest, type FieldIssue } from './errors.js';

const toFieldIssues = (error: z.ZodError): FieldIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));

const parseWith = <T>(schema: ZodType<T>, data: unknown, source: 'body' | 'query' | 'params'): T => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(`Invalid request ${source}.`, toFieldIssues(result.error));
  }
  return result.data;
};

export const parseBody = <T>(schema: ZodType<T>, data: unknown): T => parseWith(schema, data ?? {}, 'body');
export const parseQuery = <T>(schema: ZodType<T>, data: unknown): T => parseWith(schema, data ?? {}, 'query');
export const parseParams = <T>(schema: ZodType<T>, data: unknown): T => parseWith(schema, data ?? {}, 'params');

/* ------------------------------------------------------------------ *
 * Shared primitives
 * ------------------------------------------------------------------ */

/** All primary keys are UUIDs; rejecting non-UUIDs early avoids pointless DB round-trips. */
export const uuid = z.string().uuid('Must be a valid UUID.');

export const idParam = z.object({ id: uuid });

/**
 * Accepts an ISO-8601 date or date-time string and yields a `Date`.
 *
 * Written by hand rather than with `z.iso.datetime()` so that plain `YYYY-MM-DD`
 * values coming from `<input type="date">` and from shareable URL query strings
 * are both accepted.
 */
export const isoDate = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid ISO-8601 date.' })
  .transform((value) => new Date(value));

/** Cursor/limit pagination — stable under concurrent inserts, unlike offset paging. */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

/** Trimmed, length-bounded free text. */
export const text = (max: number, { min = 1 }: { min?: number } = {}) =>
  z.string().trim().min(min, `Must be at least ${min} character(s).`).max(max, `Must be at most ${max} characters.`);

/**
 * `?flag=true` style booleans from query strings. Query values are always
 * strings, so `z.boolean()` would reject them.
 */
export const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
