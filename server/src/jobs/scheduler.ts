/**
 * Cron scheduling.
 *
 * **Why node-cron and not Bull:** Bull (or BullMQ) is a Redis-backed *queue* —
 * the right tool when jobs are produced by request handlers, need retries with
 * backoff, or must be handed to a separate worker fleet. Nothing here is like
 * that. The only recurring work is one idempotent sweep on a fixed schedule, and
 * adding Redis to run it would introduce a second stateful dependency, a second
 * failure mode, and a deployment story with more moving parts than the feature
 * justifies. node-cron keeps it in-process with no infrastructure at all.
 *
 * The trade-off is stated rather than hidden: node-cron has no cross-process
 * lock, so every instance runs the schedule. That is safe here because the sweep
 * claims its work atomically in the database (see `overdue.job.ts`) — not
 * because we assume a single instance. The point at which this stops being the
 * right answer is when a job needs retry semantics or a dead-letter path; that
 * is in the README's limitations.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { pruneRefreshTokens } from '../modules/auth/auth.service.js';
import { sweepOverdueTasks } from './overdue.job.js';

const tasks: ScheduledTask[] = [];

/**
 * Wraps a job so it can never throw into the timer.
 *
 * An unhandled rejection inside a cron callback takes the process down in
 * Node 20+, which would turn a transient database blip into an outage.
 */
const guard = (name: string, job: () => Promise<unknown>): (() => Promise<void>) => {
  return async () => {
    const startedAt = Date.now();
    try {
      await job();
      logger.debug({ job: name, ms: Date.now() - startedAt }, 'scheduled job finished');
    } catch (error) {
      logger.error({ job: name, err: error }, 'scheduled job failed');
    }
  };
};

/**
 * `noOverlap` is node-cron's own guard: a run that is still in flight when the
 * next tick arrives causes that tick to be skipped rather than to start a second
 * concurrent sweep.
 */
const OPTIONS = { noOverlap: true } as const;

/**
 * Starts the schedule.
 *
 * Guarded by `ENABLE_SCHEDULER` so tests and one-off scripts can build the app
 * without background timers keeping the process alive.
 */
export const startScheduler = (): void => {
  if (!env.ENABLE_SCHEDULER) {
    logger.info('scheduler disabled (ENABLE_SCHEDULER=false)');
    return;
  }

  if (!cron.validate(env.OVERDUE_CRON)) {
    throw new Error(`OVERDUE_CRON is not a valid cron expression: "${env.OVERDUE_CRON}"`);
  }

  tasks.push(
    cron.schedule(env.OVERDUE_CRON, guard('overdue-sweep', () => sweepOverdueTasks()), {
      ...OPTIONS,
      name: 'overdue-sweep',
    }),
  );

  // Expired and revoked refresh tokens are dead rows; a daily prune keeps the
  // reuse-detection lookup on a small table. 03:20 rather than midnight so it
  // does not land alongside every other system's daily job.
  tasks.push(
    cron.schedule('20 3 * * *', guard('refresh-token-prune', pruneRefreshTokens), {
      ...OPTIONS,
      name: 'refresh-token-prune',
    }),
  );

  logger.info({ overdueCron: env.OVERDUE_CRON, jobs: tasks.length }, 'scheduler started');

  // One sweep at boot, so a server that was down over a deadline does not wait a
  // full interval before the board tells the truth.
  void guard('overdue-sweep:boot', () => sweepOverdueTasks())();
};

export const stopScheduler = async (): Promise<void> => {
  await Promise.all(tasks.map((task) => task.stop()));
  tasks.length = 0;
};
