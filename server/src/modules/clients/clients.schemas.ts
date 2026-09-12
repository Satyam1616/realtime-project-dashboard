import { z } from 'zod';
import { text } from '../../lib/validate.js';
import { emailSchema } from '../auth/auth.schemas.js';

export const createClientSchema = z.object({
  name: text(140),
  company: text(140).nullable().optional(),
  contactName: text(120).nullable().optional(),
  /** Reuses the auth email rules so one address format is valid system-wide. */
  contactEmail: emailSchema.nullable().optional(),
});

export const updateClientSchema = z
  .object({
    name: text(140).optional(),
    company: text(140).nullable().optional(),
    contactName: text(120).nullable().optional(),
    contactEmail: emailSchema.nullable().optional(),
    /**
     * Archiving is how a client leaves the picker. Deleting is reserved for a
     * client that never had a project, because `Project.clientId` is
     * `onDelete: Restrict` — history stays intact.
     */
    isArchived: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one field must be provided.');

export const listClientsQuerySchema = z.object({
  q: text(120).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
