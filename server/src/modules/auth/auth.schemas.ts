import { z } from 'zod';
import { text } from '../../lib/validate.js';

/**
 * Auth request schemas.
 *
 * The password rule is enforced on *registration* (admin creating a user), not
 * on login — applying a complexity rule to a login attempt tells an attacker
 * which guesses are worth making.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(255).email('Must be a valid email address.'),
  password: z.string().min(1, 'Password is required.').max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(200, 'Password must be at most 200 characters.')
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter.')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter.')
  .refine((value) => /[0-9]/.test(value), 'Password must contain a digit.');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const emailSchema = z.string().trim().toLowerCase().min(3).max(255).email('Must be a valid email address.');

export const nameSchema = text(120);

/**
 * Self-service registration.
 *
 * Note what is deliberately **absent**: `role`. A caller does not get to say
 * what they are. Every account created through this route is a `DEVELOPER`,
 * decided server-side in `auth.service.ts`; promotion is an admin action through
 * `PATCH /api/users/:id`.
 *
 * This is not a detail. `createUserSchema` (the admin path) *does* take a role,
 * and reusing it here would let anyone on the internet mint themselves an admin
 * account — the exact privilege escalation the rest of this codebase exists to
 * prevent. Zod strips unknown keys, so a `role` smuggled into the body is
 * discarded before the service ever sees it; `test/access.integration.test.ts`
 * asserts that.
 */
export const registerSchema = z.object({
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
  jobTitle: text(80).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
