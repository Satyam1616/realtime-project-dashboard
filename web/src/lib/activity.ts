/**
 * Activity event → sentence.
 *
 * The brief specifies the feed reads
 *
 *     Ravi moved Task #12 from In Progress → In Review · 2 mins ago
 *
 * so the renderer returns the sentence in parts: the actor, then a list of
 * text/emphasis segments. The feed component needs the seams to style the task
 * reference and the status names differently, and the "· 2 mins ago" suffix is
 * appended there because it has to re-render on a timer while the sentence
 * itself never changes.
 *
 * Every branch falls through to a generic sentence rather than throwing — an
 * activity type added on the server must degrade to something readable, not
 * blank out a user's feed.
 */
import type { ActivityEventDto } from '../types/realtime';
import type { TaskPriority } from '../types/api';
import { PRIORITY_LABEL, STATUS_LABEL } from './labels';
import { absoluteDate } from './time';

export interface Segment {
  text: string;
  /** `strong` for task references, `status` for a status name, else plain. */
  kind?: 'strong' | 'status' | 'muted';
}

export interface ActivitySentence {
  actor: string;
  segments: Segment[];
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const priorityLabel = (value: unknown): string => {
  const raw = str(value);
  return raw && raw in PRIORITY_LABEL ? PRIORITY_LABEL[raw as TaskPriority] : (raw ?? 'unset');
};

/** "Task #12" — or just the title when the event predates task numbering. */
const taskRef = (event: ActivityEventDto): Segment =>
  event.taskNumber !== null
    ? { text: `Task #${event.taskNumber}`, kind: 'strong' }
    : { text: event.taskTitle ?? 'a task', kind: 'strong' };

export const describeActivity = (event: ActivityEventDto): ActivitySentence => {
  const meta = event.metadata ?? {};
  const task = taskRef(event);

  switch (event.type) {
    case 'TASK_STATUS_CHANGED': {
      // The only branch the brief spells out verbatim. `fromStatus` is null for
      // the very first transition of a task created before the column existed.
      const to: Segment = { text: event.toStatus ? STATUS_LABEL[event.toStatus] : 'a new status', kind: 'status' };
      if (!event.fromStatus) {
        return { actor: event.actorName, segments: [{ text: 'set ' }, task, { text: ' to ' }, to] };
      }
      return {
        actor: event.actorName,
        segments: [
          { text: 'moved ' },
          task,
          { text: ' from ' },
          { text: STATUS_LABEL[event.fromStatus], kind: 'status' },
          { text: ' → ' },
          to,
        ],
      };
    }

    case 'TASK_CREATED':
      return {
        actor: event.actorName,
        segments: [
          { text: 'created ' },
          task,
          { text: ' — ' },
          { text: event.taskTitle ?? '', kind: 'muted' },
        ],
      };

    case 'TASK_ASSIGNED': {
      const name = str(meta.assigneeName) ?? 'someone';
      return {
        actor: event.actorName,
        segments: [{ text: 'assigned ' }, task, { text: ' to ' }, { text: name, kind: 'strong' }],
      };
    }

    case 'TASK_UNASSIGNED': {
      const name = str(meta.previousAssigneeName);
      return {
        actor: event.actorName,
        segments: name
          ? [{ text: 'unassigned ' }, { text: name, kind: 'strong' }, { text: ' from ' }, task]
          : [{ text: 'unassigned ' }, task],
      };
    }

    case 'TASK_PRIORITY_CHANGED':
      return {
        actor: event.actorName,
        segments: [
          { text: 'changed priority of ' },
          task,
          { text: ' from ' },
          { text: priorityLabel(meta.from), kind: 'status' },
          { text: ' → ' },
          { text: priorityLabel(meta.to), kind: 'status' },
        ],
      };

    case 'TASK_DUE_DATE_CHANGED': {
      const to = str(meta.to);
      return {
        actor: event.actorName,
        segments: to
          ? [{ text: 'moved the due date of ' }, task, { text: ' to ' }, { text: absoluteDate(to), kind: 'strong' }]
          : [{ text: 'cleared the due date on ' }, task],
      };
    }

    case 'TASK_UPDATED': {
      const changed = asStringList(meta.changed);
      const what = changed.length > 0 ? changed.join(' and ') : 'details';
      return { actor: event.actorName, segments: [{ text: `updated the ${what} of ` }, task] };
    }

    case 'TASK_OVERDUE':
      // Written by the scheduled sweep, whose actor name is the system.
      return {
        actor: event.actorName,
        segments: [{ text: 'flagged ' }, task, { text: ' as ' }, { text: 'Overdue', kind: 'status' }],
      };

    case 'TASK_DELETED':
      return { actor: event.actorName, segments: [{ text: 'deleted ' }, task] };

    case 'PROJECT_CREATED': {
      const client = str(meta.clientName);
      return {
        actor: event.actorName,
        segments: [
          { text: 'created project ' },
          { text: event.projectName, kind: 'strong' },
          ...(client ? [{ text: ' for ' }, { text: client, kind: 'strong' as const }] : []),
        ],
      };
    }

    case 'PROJECT_UPDATED': {
      const changed = asStringList(meta.changed);
      const what = changed.length > 0 ? ` (${changed.join(', ')})` : '';
      return {
        actor: event.actorName,
        segments: [{ text: 'updated project ' }, { text: event.projectName, kind: 'strong' }, { text: what, kind: 'muted' }],
      };
    }

    case 'PROJECT_MEMBER_ADDED':
      return {
        actor: event.actorName,
        segments: [
          { text: 'added ' },
          { text: str(meta.memberName) ?? 'a member', kind: 'strong' },
          { text: ' to ' },
          { text: event.projectName, kind: 'strong' },
        ],
      };

    case 'PROJECT_MEMBER_REMOVED':
      return {
        actor: event.actorName,
        segments: [
          { text: 'removed ' },
          { text: str(meta.memberName) ?? 'a member', kind: 'strong' },
          { text: ' from ' },
          { text: event.projectName, kind: 'strong' },
        ],
      };

    default:
      return {
        actor: event.actorName,
        segments: [{ text: 'updated ' }, { text: event.projectName, kind: 'strong' }],
      };
  }
};

/** Flattened form, for `aria-label` and tooltips. */
export const activityText = (event: ActivityEventDto): string => {
  const { actor, segments } = describeActivity(event);
  return `${actor} ${segments.map((segment) => segment.text).join('')}`.replace(/\s+/g, ' ').trim();
};

/** Which icon the feed row shows. Grouped, so 13 types map to 6 glyphs. */
export const activityIcon = (type: ActivityEventDto['type']): string => {
  switch (type) {
    case 'TASK_STATUS_CHANGED':
      return '→';
    case 'TASK_CREATED':
      return '+';
    case 'TASK_ASSIGNED':
    case 'TASK_UNASSIGNED':
    case 'PROJECT_MEMBER_ADDED':
    case 'PROJECT_MEMBER_REMOVED':
      return '@';
    case 'TASK_OVERDUE':
      return '!';
    case 'TASK_DELETED':
      return '×';
    default:
      return '·';
  }
};
