/**
 * Global error handling.
 *
 * Every failure leaves the API in one shape:
 *
 *   {
 *     "error": { "code": "FORBIDDEN", "message": "...", "details": [ { "path": "...", "message": "..." } ] },
 *     "requestId": "req-14"
 *   }
 *
 * Two rules, both non-negotiable:
 *
 *   - **No stack traces, ORM messages or SQL ever reach the client.** Unexpected
 *     errors are logged in full server-side and returned as a generic 500
 *     carrying only the request id, which is the handle support needs to find
 *     the real error in the logs.
 *   - **Known database failures get meaningful status codes.** A unique-constraint
 *     violation is a 409 with a readable message, not a 500.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '../db/client.js';
import { AppError, ErrorCode, type ErrorCodeValue, type FieldIssue } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

interface ErrorBody {
  error: { code: ErrorCodeValue; message: string; details?: FieldIssue[] };
  requestId: string;
}

const body = (
  code: ErrorCodeValue,
  message: string,
  requestId: string,
  details?: FieldIssue[],
): ErrorBody => ({
  error: { code, message, ...(details && details.length > 0 ? { details } : {}) },
  requestId,
});

/** Maps the Prisma error codes we can act on; anything else stays a 500. */
const fromPrisma = (
  error: Prisma.PrismaClientKnownRequestError,
  requestId: string,
): { status: number; payload: ErrorBody } | null => {
  switch (error.code) {
    case 'P2002': {
      // Unique constraint. `target` names the column(s), which is safe to
      // surface — it is our own schema, not user data.
      const target = (error.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target.join(', ') : String(target);
      return {
        status: 409,
        payload: body(
          ErrorCode.CONFLICT,
          fields ? `A record with that ${fields} already exists.` : 'That record already exists.',
          requestId,
        ),
      };
    }
    case 'P2025':
      return { status: 404, payload: body(ErrorCode.NOT_FOUND, 'Resource not found.', requestId) };
    case 'P2003':
      return {
        status: 409,
        payload: body(
          ErrorCode.CONFLICT,
          'That change would break a reference to another record.',
          requestId,
        ),
      };
    case 'P2014':
      return {
        status: 409,
        payload: body(ErrorCode.CONFLICT, 'That change would violate a required relation.', requestId),
      };
    default:
      return null;
  }
};

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .send(body(ErrorCode.NOT_FOUND, `Route ${request.method} ${request.url} does not exist.`, request.id));
  });

  // Fastify types the handler's error as `unknown` unless it is annotated, and
  // every branch below inspects Fastify-specific fields (`validation`,
  // `statusCode`), so the annotation is load-bearing rather than decorative.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    // 1. Errors we raised deliberately.
    if (error instanceof AppError) {
      request.log.info(
        { code: error.code, status: error.statusCode, path: request.url, userId: request.principal?.id },
        error.message,
      );
      return reply.status(error.statusCode).send(body(error.code, error.message, requestId, error.details));
    }

    // 2. Fastify's own schema validation and body parsing.
    if (error.validation) {
      const details: FieldIssue[] = error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, '') || '(root)',
        message: issue.message ?? 'Invalid value.',
      }));
      return reply
        .status(400)
        .send(body(ErrorCode.VALIDATION_ERROR, 'Request validation failed.', requestId, details));
    }

    // 3. Rate limiting, and anything else that arrives with a 4xx already set.
    if (error.statusCode === 429) {
      return reply
        .status(429)
        .send(body(ErrorCode.RATE_LIMITED, 'Too many requests. Please slow down.', requestId));
    }

    // 4. Database errors with a sensible HTTP equivalent.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = fromPrisma(error, requestId);
      if (mapped) {
        request.log.warn({ prismaCode: error.code, path: request.url }, 'database constraint violation');
        return reply.status(mapped.status).send(mapped.payload);
      }
    }

    if (error instanceof Prisma.PrismaClientValidationError) {
      // A malformed query is our bug, not the caller's — log it, but do not
      // leak the query shape.
      request.log.error({ err: error, path: request.url }, 'invalid database query');
      return reply
        .status(500)
        .send(body(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred.', requestId));
    }

    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send(body(ErrorCode.VALIDATION_ERROR, error.message || 'Bad request.', requestId));
    }

    // 5. Anything left is a bug. Full detail to the log, nothing to the client.
    request.log.error(
      { err: error, path: request.url, method: request.method, userId: request.principal?.id },
      'unhandled error',
    );

    return reply.status(500).send(
      body(
        ErrorCode.INTERNAL_ERROR,
        // Outside production, echoing the message makes local debugging far
        // quicker. The stack is still never sent.
        isProduction ? 'An unexpected error occurred.' : `Unexpected error: ${error.message}`,
        requestId,
      ),
    );
  });
};
