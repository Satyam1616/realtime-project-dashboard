/**
 * Task rules that must be identical everywhere they are applied.
 *
 * The overdue predicate lives here rather than inside the cron job because two
 * separate callers need the same answer:
 *
 *   - the scheduled sweep (src/jobs/overdue.job.ts), which is what *discovers*
 *     newly-overdue work without anybody loading a page;
 *   - the task write paths, which keep the flag consistent with a row they are
 *     already updating (completing a task should not leave it flagged overdue
 *     for up to five minutes).
 *
 * Duplicating the predicate in both places is how the two would eventually
 * disagree, so there is exactly one copy.
 */
import { TaskStatus } from '../../db/client.js';

/** A finished task is never overdue, however far past its due date it is. */
export const isOverdueNow = (
  task: { status: TaskStatus; dueDate: Date | null },
  now: Date = new Date(),
): boolean => task.dueDate !== null && task.status !== TaskStatus.DONE && task.dueDate.getTime() < now.getTime();

/** Statuses the sweep considers; DONE is excluded by the predicate above. */
export const OPEN_STATUSES: readonly TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
];
