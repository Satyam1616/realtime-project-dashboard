/**
 * Enum → human text.
 *
 * The API speaks `IN_PROGRESS`; people read "In Progress". Every place that
 * renders an enum goes through here so the wording is identical in the board,
 * the filters, the feed sentence and the notification body.
 */
import type { ProjectStatus, Role, TaskPriority, TaskStatus } from '../types/api';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On Hold',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'Project Manager',
  DEVELOPER: 'Developer',
};

/** Short form for chips where "Project Manager" would wrap. */
export const ROLE_SHORT: Record<Role, string> = {
  ADMIN: 'Admin',
  PROJECT_MANAGER: 'PM',
  DEVELOPER: 'Dev',
};

/**
 * CSS modifier suffixes. Kept as an explicit map rather than lowercasing the
 * enum so a renamed enum member fails to compile instead of silently losing
 * its colour.
 */
export const STATUS_SLUG: Record<TaskStatus, string> = {
  TODO: 'todo',
  IN_PROGRESS: 'progress',
  IN_REVIEW: 'review',
  DONE: 'done',
};

export const PRIORITY_SLUG: Record<TaskPriority, string> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const PROJECT_STATUS_SLUG: Record<ProjectStatus, string> = {
  ACTIVE: 'active',
  ON_HOLD: 'hold',
  COMPLETED: 'done',
  ARCHIVED: 'archived',
};

/** Declared in the order a status board would read, not the enum's order. */
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];

/** Two-letter monogram for the avatar circles. */
export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
};

/** "3 tasks" / "1 task" — pluralisation without pulling in a library. */
export const plural = (count: number, singular: string, pluralForm?: string): string =>
  `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
