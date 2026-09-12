/**
 * Keeping lists fresh from the live channel.
 *
 * There are two delivery shapes on the server and therefore two hooks here:
 *
 * - `activity:new` is **addressed** — the server computes the exact recipient
 *   set and sends to `user:<id>` rooms. Every user gets every event they are
 *   entitled to, whatever page they are on. That makes it a reliable trigger
 *   for "something you can see has changed, re-read the list".
 *
 * - `task:changed` goes to the **project room**, so it only arrives while the
 *   client is subscribed to that project (`useProjectRoom`). Where it does
 *   arrive it carries the new field values, so a board can move a card without
 *   a round trip.
 *
 * Using the wrong one is a silent bug: a task list that waits for
 * `task:changed` without joining a project room simply never updates.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeEvent } from '../providers/SocketProvider';
import type { ActivityEventDto, TaskChangedDto } from '../types/realtime';
import type { TaskDto } from '../types/api';

/** Activity types that imply a task list or count is now stale. */
const TASK_EVENTS: ReadonlySet<ActivityEventDto['type']> = new Set([
  'TASK_CREATED',
  'TASK_STATUS_CHANGED',
  'TASK_ASSIGNED',
  'TASK_UNASSIGNED',
  'TASK_PRIORITY_CHANGED',
  'TASK_DUE_DATE_CHANGED',
  'TASK_UPDATED',
  'TASK_OVERDUE',
  'TASK_DELETED',
]);

/**
 * Re-read a query when a relevant event arrives.
 *
 * Coalesced on a short timer: a manager reassigning six tasks produces six
 * events in a second, and this turns them into one request. The refetch is the
 * honest option for aggregate endpoints — a dashboard's `overdueTasks` count
 * cannot be recomputed from a single task event without re-deriving server
 * logic in the browser.
 */
export const useRefetchOnActivity = (
  refetch: () => void,
  options: { projectId?: string | undefined; types?: ReadonlySet<ActivityEventDto['type']>; delayMs?: number } = {},
): void => {
  const { projectId, types = TASK_EVENTS, delayMs = 350 } = options;
  const timer = useRef<number | null>(null);
  const latest = useRef(refetch);

  useEffect(() => {
    latest.current = refetch;
  }, [refetch]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useRealtimeEvent(
    'activity:new',
    useCallback(
      (event: ActivityEventDto) => {
        if (!types.has(event.type)) return;
        if (projectId && event.projectId !== projectId) return;

        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => latest.current(), delayMs);
      },
      [types, projectId, delayMs],
    ),
  );
};

/**
 * Apply `task:changed` to an already-loaded list of tasks, and report which
 * ids moved so the UI can flash them.
 *
 * Only patches rows already present. A task that becomes newly visible (a
 * fresh assignment, say) needs the full DTO, which this event does not carry —
 * that case is handled by the accompanying `activity:new` refetch.
 */
export const useLiveTaskPatch = (
  setTasks: (updater: (current: TaskDto[]) => TaskDto[]) => void,
  projectId?: string,
): ReadonlySet<string> => {
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());

  useRealtimeEvent(
    'task:changed',
    useCallback(
      (event: TaskChangedDto) => {
        if (projectId && event.projectId !== projectId) return;

        if (event.changeKind === 'deleted') {
          setTasks((current) => current.filter((task) => task.id !== event.id));
          return;
        }

        setTasks((current) =>
          current.map((task) =>
            task.id === event.id
              ? {
                  ...task,
                  title: event.title,
                  status: event.status,
                  priority: event.priority,
                  dueDate: event.dueDate,
                  isOverdue: event.isOverdue,
                  updatedAt: event.updatedAt,
                  assignee:
                    event.assigneeId === null
                      ? null
                      : task.assignee?.id === event.assigneeId
                        ? task.assignee
                        : // The event carries a name but not an email or colour;
                          // the row keeps rendering until the refetch fills it in.
                          {
                            id: event.assigneeId,
                            name: event.assigneeName ?? 'Unknown',
                            email: task.assignee?.email ?? '',
                            avatarColor: task.assignee?.avatarColor ?? '#64748b',
                          },
                }
              : task,
          ),
        );

        setChanged((current) => new Set(current).add(event.id));
        window.setTimeout(
          () =>
            setChanged((current) => {
              const next = new Set(current);
              next.delete(event.id);
              return next;
            }),
          1200,
        );
      },
      [projectId, setTasks],
    ),
  );

  return changed;
};
