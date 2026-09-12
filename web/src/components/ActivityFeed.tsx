/**
 * The live activity feed.
 *
 * History and live events share one list and one renderer because they share
 * one DTO: `GET /api/activity` and the socket's `activity:new` return byte-for-
 * byte the same shape. Nothing in this component decides *what* the user may
 * see — the server has already filtered by role, both in SQL for the history
 * and in `fanout.ts` for the live events. The component's only judgement is
 * whether an arriving event belongs to the project it is currently scoped to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, toQuery } from '../lib/api';
import { activityIcon, describeActivity } from '../lib/activity';
import { relativeTime, absoluteDateTime } from '../lib/time';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { useRealtimeEvent, useSocket } from '../providers/SocketProvider';
import type { ActivityEventDto, CatchupResponse } from '../types/realtime';
import { EmptyState, ErrorState, LoadingRows } from './ui/Feedback';

interface ActivityFeedProps {
  /** Scope to a single project. Omit for the role-wide feed. */
  projectId?: string;
  /** Show the "you missed N events" banner. Only meaningful unscoped. */
  catchUp?: boolean;
  limit?: number;
  title?: string;
  /** Allow paging back through history. */
  paginate?: boolean;
  maxHeight?: number;
}

const ICON_KIND: Partial<Record<ActivityEventDto['type'], string>> = {
  TASK_STATUS_CHANGED: 'kind-status',
  TASK_OVERDUE: 'kind-overdue',
  TASK_CREATED: 'kind-created',
  PROJECT_CREATED: 'kind-created',
};

const FeedRow = ({
  event,
  now,
  isNew,
  showProject,
}: {
  event: ActivityEventDto;
  now: number;
  isNew: boolean;
  showProject: boolean;
}): React.JSX.Element => {
  const sentence = describeActivity(event);

  return (
    <li className={`feed-item${isNew ? ' is-new' : ''}`}>
      <span className={`feed-icon ${ICON_KIND[event.type] ?? ''}`} aria-hidden="true">
        {activityIcon(event.type)}
      </span>

      <div className="grow">
        <div className="feed-text">
          <span className="feed-actor">{sentence.actor}</span>{' '}
          {sentence.segments.map((segment, index) => (
            <span
              key={index}
              className={
                segment.kind === 'strong'
                  ? 'feed-strong'
                  : segment.kind === 'status'
                    ? 'feed-status'
                    : segment.kind === 'muted'
                      ? 'dim'
                      : undefined
              }
            >
              {segment.text}
            </span>
          ))}
        </div>

        <div className="feed-meta">
          {/* The brief's separator. The timestamp re-renders on the shared
              tick; the sentence above it never changes. */}
          <time dateTime={event.createdAt} title={absoluteDateTime(event.createdAt)}>
            {relativeTime(event.createdAt, now)}
          </time>
          {showProject ? (
            <>
              <span aria-hidden="true">·</span>
              <Link to={`/projects/${event.projectId}`} className="feed-project">
                {event.projectName}
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
};

export const ActivityFeed = ({
  projectId,
  catchUp = !projectId,
  limit = 30,
  title = 'Activity',
  paginate = false,
  maxHeight = 560,
}: ActivityFeedProps): React.JSX.Element => {
  const now = useNow();
  const { markSeen, connected } = useSocket();

  const path = `/activity${toQuery({ limit, projectId: projectId ?? null })}`;
  const { data, error, loading, refetch } = useApiQuery<{ items: ActivityEventDto[]; nextCursor: number | null }>(path);

  const [live, setLive] = useState<ActivityEventDto[]>([]);
  const [older, setOlder] = useState<ActivityEventDto[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missed, setMissed] = useState<number>(0);

  /** Ids that arrived over the socket this session, for the flash animation. */
  const arrived = useRef(new Set<string>());

  // A new history page replaces whatever was appended by "load more".
  useEffect(() => {
    setOlder([]);
    setLive([]);
    setCursor(data?.nextCursor ?? null);
  }, [data]);

  /**
   * "What did I miss?" — answered from the database via the persisted cursor,
   * never from an in-memory buffer, so it survives a redeploy.
   */
  useEffect(() => {
    if (!catchUp) return;
    let cancelled = false;

    void api
      .get<CatchupResponse>('/activity/catchup?limit=20')
      .then((result) => {
        if (!cancelled) setMissed(result.missedCount);
      })
      .catch(() => {
        /* The banner is a nicety; its absence must not break the feed. */
      });

    return () => {
      cancelled = true;
    };
  }, [catchUp]);

  useRealtimeEvent(
    'activity:new',
    useCallback(
      (event: ActivityEventDto) => {
        // The server sent it, so this user is allowed to see it. The only
        // question left is whether this *view* is scoped to another project.
        if (projectId && event.projectId !== projectId) return;

        arrived.current.add(event.id);
        setLive((current) => (current.some((item) => item.id === event.id) ? current : [event, ...current]));
      },
      [projectId],
    ),
  );

  const events = useMemo(() => {
    const seen = new Set<string>();
    const combined: ActivityEventDto[] = [];
    for (const event of [...live, ...(data?.items ?? []), ...older]) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      combined.push(event);
    }
    return combined;
  }, [live, data, older]);

  /**
   * Acknowledge the newest event we have actually rendered. This is what makes
   * the catch-up count meaningful next time: the cursor only advances for
   * events that reached a screen.
   */
  const highestSeq = events[0]?.seq ?? 0;
  useEffect(() => {
    if (!connected || highestSeq <= 0) return;
    const id = window.setTimeout(() => markSeen(highestSeq), 1200);
    return () => window.clearTimeout(id);
  }, [connected, highestSeq, markSeen]);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await api.get<{ items: ActivityEventDto[]; nextCursor: number | null }>(
        `/activity${toQuery({ limit, cursor, projectId: projectId ?? null })}`,
      );
      setOlder((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="card feed">
      <div className="card-header">
        <span className="card-title">{title}</span>
        <span className={`conn ${connected ? 'conn-live' : 'conn-down'}`}>
          <span className="conn-dot" />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
      </div>

      {missed > 0 ? (
        <div className="feed-missed">
          <span aria-hidden="true">↻</span>
          {missed === 1 ? '1 event happened while you were away' : `${missed} events happened while you were away`}
        </div>
      ) : null}

      {loading && events.length === 0 ? (
        <LoadingRows rows={5} height={40} />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : events.length === 0 ? (
        <EmptyState title="Nothing yet" hint="Task and project changes will appear here as they happen." />
      ) : (
        <>
          <ul className="feed-scroll" style={{ maxHeight, listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((event) => (
              <FeedRow
                key={event.id}
                event={event}
                now={now}
                isNew={arrived.current.has(event.id)}
                showProject={!projectId}
              />
            ))}
          </ul>

          {paginate && cursor !== null ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 'var(--space-3)', alignSelf: 'center' }}
              onClick={() => void loadMore()}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load older activity'}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
};
