/**
 * Socket.IO server: handshake authentication, room membership, presence.
 *
 * Why Socket.IO rather than a bare `ws` server (justified at length in
 * README.md): this feature needs rooms, reconnection with backoff, heartbeats
 * for presence, and acknowledgements. All four are hand-rolled boilerplate with
 * native WebSocket and all four are load-bearing here.
 *
 * The transport is pinned to `['websocket']` on both ends, so there is no HTTP
 * long-polling fallback — connections are real WebSockets or they fail.
 */
import { Server as IOServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { Role } from '../db/client.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { logger } from '../lib/logger.js';
import { projectScope, type Principal } from '../access/rbac.js';
import { advanceActivityCursor } from '../modules/activity/activity.service.js';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from './types.js';
import { roomForProject, roomForRole, roomForUser } from './types.js';
import { emitPresence, type AppIOServer } from './fanout.js';
import { presenceSnapshot, trackConnection, trackDisconnection } from './presence.js';

let io: AppIOServer | null = null;

/** Accessor so services can emit without importing the bootstrap module. */
export const getIO = (): AppIOServer | null => io;

export const setIO = (instance: AppIOServer | null): void => {
  io = instance;
};

const principalFromSocketData = (data: SocketData): Principal => ({
  id: data.userId,
  email: data.email,
  name: data.name,
  role: data.role,
});

export const createSocketServer = (httpServer: HttpServer): AppIOServer => {
  const server: AppIOServer = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    // No long-polling: WebSocket only, as required.
    transports: ['websocket'],
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    // Presence depends on prompt detection of dead connections.
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  /**
   * Handshake authentication.
   *
   * The access token is verified for signature/expiry, then the user is
   * re-read from the database. Trusting the `role` claim alone would keep a
   * demoted or deactivated user at their old privilege level for the life of
   * the token; this way authorisation always reflects current state.
   */
  server.use(async (socket, next) => {
    try {
      const raw =
        (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
        socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

      if (typeof raw !== 'string' || raw.length === 0) {
        return next(new Error('UNAUTHENTICATED'));
      }

      const claims = verifyAccessToken(raw);
      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, name: true, role: true, avatarColor: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return next(new Error('UNAUTHENTICATED'));
      }

      socket.data = {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarColor: user.avatarColor,
      };
      return next();
    } catch {
      // Deliberately opaque: the client only needs to know to re-authenticate.
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  server.on('connection', (socket) => {
    const data = socket.data;

    // Every socket joins its own user room (the unit of addressed delivery) and
    // its role room (used for the global admin feed and the presence tile).
    void socket.join(roomForUser(data.userId));
    void socket.join(roomForRole(data.role));

    const becameOnline = trackConnection(
      { userId: data.userId, name: data.name, role: data.role, avatarColor: data.avatarColor },
      socket.id,
    );

    if (becameOnline) {
      // The set of online users changed — every admin's tile is now stale.
      emitPresence(server, presenceSnapshot());
    } else if (data.role === Role.ADMIN) {
      // A second tab for someone already online changes nothing globally, but
      // this new socket still needs the current snapshot to render its tile.
      socket.emit('presence:update', presenceSnapshot());
    }

    // Push the authoritative unread count on connect so the badge is correct
    // immediately, without the client issuing a request for it.
    void prisma.notification
      .count({ where: { recipientId: data.userId, readAt: null } })
      .then((unread) => socket.emit('notification:count', { unread }))
      .catch((error: unknown) => logger.warn({ err: error }, 'failed to send initial unread count'));

    /**
     * "I am viewing this project." Authorised server-side against the caller's
     * project scope — a developer cannot subscribe to a project they have no
     * task in, so they can never end up in a room whose updates they would
     * then have to be filtered out of.
     */
    socket.on('project:subscribe', async (payload, ack) => {
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
      if (!projectId) {
        ack?.({ ok: false, error: 'projectId is required' });
        return;
      }

      try {
        const visible = await prisma.project.findFirst({
          where: { AND: [{ id: projectId }, projectScope(principalFromSocketData(data))] },
          select: { id: true },
        });

        if (!visible) {
          ack?.({ ok: false, error: 'FORBIDDEN' });
          return;
        }

        await socket.join(roomForProject(projectId));
        ack?.({ ok: true });
      } catch (error) {
        logger.error({ err: error, projectId }, 'project:subscribe failed');
        ack?.({ ok: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('project:unsubscribe', (payload) => {
      if (typeof payload?.projectId === 'string') {
        void socket.leave(roomForProject(payload.projectId));
      }
    });

    /**
     * Advance the persisted high-water mark. This is what makes the "last 20
     * events you missed" query answerable from the database after a
     * disconnection — see modules/activity/activity.service.ts.
     */
    socket.on('activity:seen', (payload) => {
      const seq = Number(payload?.seq);
      if (!Number.isInteger(seq) || seq < 0) return;

      void advanceActivityCursor(data.userId, seq).catch((error: unknown) =>
        logger.warn({ err: error }, 'failed to persist activity cursor'),
      );
    });

    socket.on('disconnect', (reason) => {
      if (trackDisconnection(data.userId, socket.id)) {
        emitPresence(server, presenceSnapshot());
      }
      logger.debug({ userId: data.userId, reason }, 'socket disconnected');
    });
  });

  setIO(server);
  return server;
};
