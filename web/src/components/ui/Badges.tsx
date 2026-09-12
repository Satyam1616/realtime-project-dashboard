import type { ProjectStatus, Role, TaskPriority, TaskStatus } from '../../types/api';
import {
  PRIORITY_LABEL,
  PRIORITY_SLUG,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_SLUG,
  ROLE_LABEL,
  STATUS_LABEL,
  STATUS_SLUG,
} from '../../lib/labels';

export const StatusBadge = ({ status }: { status: TaskStatus }): React.JSX.Element => (
  <span className={`badge status-${STATUS_SLUG[status]}`}>{STATUS_LABEL[status]}</span>
);

export const PriorityBadge = ({ priority }: { priority: TaskPriority }): React.JSX.Element => (
  <span className={`badge priority-${PRIORITY_SLUG[priority]}`}>{PRIORITY_LABEL[priority]}</span>
);

export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }): React.JSX.Element => (
  <span className={`badge status-${PROJECT_STATUS_SLUG[status]}`}>{PROJECT_STATUS_LABEL[status]}</span>
);

export const RoleBadge = ({ role }: { role: Role }): React.JSX.Element => (
  <span className="badge badge-plain badge-neutral">{ROLE_LABEL[role]}</span>
);

/**
 * Rendered from the persisted `isOverdue` column, which the scheduled sweep
 * maintains — never recomputed here from the due date. Deriving it in the
 * browser would disagree with the database the moment a clock drifts.
 */
export const OverdueBadge = (): React.JSX.Element => (
  <span className="badge badge-overdue badge-plain">Overdue</span>
);
