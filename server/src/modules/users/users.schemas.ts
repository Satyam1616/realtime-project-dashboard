import { z } from 'zod';
import { text, uuid } from '../../lib/validate.js';
import { emailSchema, nameSchema, passwordSchema } from '../auth/auth.schemas.js';

export const roleEnum = z.enum(['ADMIN', 'PROJECT_MANAGER', 'DEVELOPER']);

/** `#rrggbb` — used for avatar initials, so it must be a real CSS colour. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour such as #6366f1');

export const createUserSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
  role: roleEnum,
  jobTitle: text(80).optional(),
  avatarColor: hexColor.optional(),
});

export const updateUserSchema = z
  .object({
    name: nameSchema.optional(),
    role: roleEnum.optional(),
    jobTitle: text(80).nullable().optional(),
    avatarColor: hexColor.optional(),
    /**
     * Soft disable rather than delete: a user row is referenced by tasks they
     * created and activity they performed, and destroying that history to
     * offboard somebody would be the wrong trade.
     */
    isActive: z.boolean().optional(),
    /** Admin-initiated reset. Revokes every session the user holds. */
    password: passwordSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field must be provided.');

export const listUsersQuerySchema = z.object({
  role: roleEnum.optional(),
  q: text(120).optional(),
  includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const assignableQuerySchema = z.object({
  /** Narrows to people already on a project, for a PM filling its board. */
  projectId: uuid.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type AssignableQuery = z.infer<typeof assignableQuerySchema>;
