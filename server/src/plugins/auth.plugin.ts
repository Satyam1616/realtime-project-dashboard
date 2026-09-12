/**
 * Authentication plugin: turns a bearer token into a `request.principal`.
 *
 * The access token's `role` claim is **not** trusted as the authorisation input.
 * After verifying the signature we re-read the user row and use the role stored
 * there. The reason is that a JWT is a snapshot: if an admin demotes someone or
 * deactivates their account, a token minted a minute earlier would otherwise
 * keep working at the old privilege level until it expired. One indexed
 * primary-key lookup per authenticated request buys correct, immediately
 * revocable authorisation — the right trade at this scale.
 *
 * Note what this means for the spec's "a Developer must not reach a PM's data
 * even by hitting the API with a modified token": a *tampered* token fails the
 * HMAC check outright, and a *validly issued* developer token cannot be
 * upgraded because the role is read from the database, not from the token.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { prisma, type Role } from '../db/client.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { ErrorCode, forbidden, unauthenticated } from '../lib/errors.js';
import type { Principal } from '../access/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after the `authenticate` preHandler has run. */
    principal?: Principal;
  }
  interface FastifyInstance {
    /** preHandler: requires a valid access token; populates `request.principal`. */
    authenticate: preHandlerHookHandler;
    /** preHandler factory: requires authentication *and* one of `roles`. */
    requireRole: (...roles: Role[]) => preHandlerHookHandler;
  }
}

const bearerFrom = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
};

/** Exported for reuse by the WebSocket handshake and by tests. */
export const resolvePrincipal = async (accessToken: string): Promise<Principal> => {
  const claims = verifyAccessToken(accessToken);

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  if (!user) {
    throw unauthenticated('Account no longer exists.', ErrorCode.TOKEN_INVALID);
  }
  if (!user.isActive) {
    throw unauthenticated('This account has been deactivated.', ErrorCode.TOKEN_INVALID);
  }

  return { id: user.id, email: user.email, name: user.name, role: user.role };
};

/** The single authentication step, shared by both decorators below. */
const authenticateRequest = async (request: FastifyRequest): Promise<Principal> => {
  const token = bearerFrom(request);
  if (!token) {
    throw unauthenticated('Missing bearer token.');
  }
  const principal = await resolvePrincipal(token);
  request.principal = principal;
  return principal;
};

const authPlugin = async (app: FastifyInstance): Promise<void> => {
  // Declared up front so Fastify can optimise the request object's shape.
  app.decorateRequest('principal', undefined);

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    await authenticateRequest(request);
  });

  app.decorate('requireRole', (...roles: Role[]): preHandlerHookHandler => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      // Self-sufficient: a route can use `requireRole` alone and still be
      // authenticated, so it is impossible to register a role gate that
      // silently runs without an auth gate.
      const principal = request.principal ?? (await authenticateRequest(request));

      if (!roles.includes(principal.role)) {
        throw forbidden(`This endpoint requires one of: ${roles.join(', ')}.`);
      }
    };
  });
};

/**
 * `fastify-plugin` strips the encapsulation context so the decorators are
 * visible to sibling route plugins registered afterwards.
 */
export default fp(authPlugin, { name: 'auth-plugin' });

/**
 * Reads `request.principal` or throws. Handlers use this instead of `!` so a
 * route registered without the `authenticate` preHandler fails loudly rather
 * than dereferencing undefined.
 */
export const requirePrincipal = (request: FastifyRequest): Principal => {
  if (!request.principal) {
    throw unauthenticated();
  }
  return request.principal;
};
