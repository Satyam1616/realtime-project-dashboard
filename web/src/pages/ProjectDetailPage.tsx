/**
 * Project detail.
 *
 * This is the page the brief's "visible in real time to all users viewing that
 * project" sentence is about, and it is where the two live mechanisms meet:
 *
 *   - `useProjectRoom(id)` joins the project's socket room for as long as this
 *     page is mounted, which is what makes `task:changed` arrive. The server
 *     re-checks permission before admitting the socket, so joining a room is a
 *     request, not a claim.
 *   - `<ActivityFeed projectId={id}>` renders the project's slice of the same
 *     role-filtered feed used everywhere else.
 *
 * The board's cards are patched in place from `task:changed`; the header
 * counters come from the project payload and are re-read on activity, because
 * `overdue` is a persisted column the scheduler maintains rather than something
 * this page may recompute.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, toQuery } from '../lib/api';
import { PROJECT_STATUS_LABEL, ROLE_SHORT, plural } from '../lib/labels';
import { absoluteDate, dueLabel } from '../lib/time';
import { canCreateTaskIn, canManageProject } from '../lib/permissions';
import { useApiQuery } from '../hooks/useApiQuery';
import { useLiveTaskPatch, useRefetchOnActivity } from '../hooks/useLiveTasks';
import { useAssignableUsers } from '../hooks/usePickers';
import { useProjectRoom } from '../providers/SocketProvider';
import { useCurrentUser } from '../providers/AuthProvider';
import type { Paged, ProjectDto, ProjectMemberDto, TaskDto } from '../types/api';
import { ActivityFeed } from '../components/ActivityFeed';
import { ProjectDialog } from '../components/ProjectDialog';
import { TaskBoard } from '../components/TaskBoard';
import { TaskDialog } from '../components/TaskDialog';
import { TaskTable } from '../components/TaskTable';
import { Avatar } from '../components/ui/Avatar';
import { ProjectStatusBadge } from '../components/ui/Badges';
import { EmptyState, ErrorState, InlineError, LoadingRows } from '../components/ui/Feedback';

type View = 'board' | 'list';

/* ------------------------------------------------------------------ *
 * Members
 * ------------------------------------------------------------------ */

const MemberList = ({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}): React.JSX.Element => {
  const { data, error, loading, refetch, setData } = useApiQuery<{ members: ProjectMemberDto[] }>(
    `/projects/${projectId}/members`,
  );
  const { users } = useAssignableUsers(canManage);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const members = data?.members ?? [];
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = users.filter((candidate) => !memberIds.has(candidate.id));

  // Both mutations return the new member list, so the response replaces local
  // state outright — no reconstructing what the server just computed.
  const mutate = async (run: () => Promise<{ members: ProjectMemberDto[] }>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await run();
      setData(() => result);
      setAdding('');
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'Could not update the team.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">Team</h2>
        <span className="small dim">{plural(members.length, 'member')}</span>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingRows rows={3} height={30} />
      ) : members.length === 0 ? (
        <p className="small dim">Nobody has been added yet.</p>
      ) : (
        <ul className="presence-list">
          {members.map((member) => (
            <li className="presence-row" key={member.id}>
              <Avatar name={member.name} color={member.avatarColor} size="sm" />
              <span className="grow truncate">
                {member.name}
                <span className="tiny dim"> · {member.jobTitle ?? ROLE_SHORT[member.role]}</span>
              </span>
              {canManage ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  aria-label={`Remove ${member.name}`}
                  onClick={() =>
                    void mutate(() =>
                      api.delete<{ members: ProjectMemberDto[] }>(
                        `/projects/${projectId}/members/${member.id}`,
                      ),
                    )
                  }
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {failure ? <InlineError message={failure} /> : null}

      {canManage && candidates.length > 0 ? (
        <div className="row gap-2" style={{ marginTop: 'var(--space-3)' }}>
          <select
            className="select grow"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            aria-label="Add a team member"
          >
            <option value="">Add someone…</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} · {ROLE_SHORT[candidate.role]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!adding || busy}
            onClick={() =>
              void mutate(() =>
                api.post<{ members: ProjectMemberDto[] }>(`/projects/${projectId}/members`, {
                  userId: adding,
                }),
              )
            }
          >
            Add
          </button>
        </div>
      ) : null}
    </section>
  );
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export const ProjectDetailPage = (): React.JSX.Element => {
  const { id = '' } = useParams<{ id: string }>();
  const user = useCurrentUser();

  const [view, setView] = useState<View>('board');
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // "I am looking at this project." Held for the lifetime of the page and
  // re-sent after a reconnect.
  useProjectRoom(id || null);

  const project = useApiQuery<{ project: ProjectDto }>(id ? `/projects/${id}` : null);
  // `priority` descending is CRITICAL-first: the Prisma enum is declared
  // ascending (LOW → CRITICAL) and Postgres orders enums by declaration order.
  // The API applies nearest deadline as the secondary key.
  const tasks = useApiQuery<Paged<TaskDto>>(
    id ? `/tasks${toQuery({ projectId: id, limit: 100, sort: 'priority', order: 'desc' })}` : null,
  );

  // Rows already on screen are patched from the new field values. Anything the
  // patch cannot do — a task that became newly visible, or the header's
  // aggregate counters — is a re-read, scoped to this project's events.
  const flashing = useLiveTaskPatch(
    (updater) => tasks.setData((current) => (current ? { ...current, items: updater(current.items) } : current)),
    id,
  );
  useRefetchOnActivity(
    () => {
      project.refetch();
      tasks.refetch();
    },
    { projectId: id },
  );

  if (project.error) {
    return (
      <div className="page">
        <ErrorState error={project.error} onRetry={project.refetch} />
      </div>
    );
  }
  if (!project.data) {
    return (
      <div className="page">
        <LoadingRows rows={5} height={72} />
      </div>
    );
  }

  const current = project.data.project;
  const canManage = canManageProject(user, current);
  const items = tasks.data?.items ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ minWidth: 0 }}>
          <div className="row gap-3 wrap">
            <h1 className="truncate">{current.name}</h1>
            <ProjectStatusBadge status={current.status} />
          </div>
          <p className="page-subtitle">
            <Link to={`/projects${toQuery({ clientId: current.client.id })}`} className="muted">
              {current.client.name}
            </Link>
            {current.client.company ? <span className="dim"> · {current.client.company}</span> : null}
          </p>
        </div>

        <div className="row gap-2">
          {canCreateTaskIn(user, current) ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreatingTask(true)}>
              New task
            </button>
          ) : null}
          {canManage ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit project
            </button>
          ) : null}
        </div>
      </header>

      {actionError ? <InlineError message={actionError} /> : null}

      <div className="split">
        <div className="col gap-5">
          <section className="card">
            <div className="detail-grid">
              <span className="detail-key">Status</span>
              <span>{PROJECT_STATUS_LABEL[current.status]}</span>

              <span className="detail-key">Manager</span>
              <span className="row gap-2">
                <Avatar name={current.manager.name} color={current.manager.avatarColor} size="sm" />
                {current.manager.name}
              </span>

              <span className="detail-key">Starts</span>
              <span className={current.startDate ? '' : 'dim'}>
                {current.startDate ? absoluteDate(current.startDate) : 'Not set'}
              </span>

              <span className="detail-key">Due</span>
              <span className={current.dueDate ? '' : 'dim'}>
                {current.dueDate ? `${absoluteDate(current.dueDate)} · ${dueLabel(current.dueDate)}` : 'Not set'}
              </span>

              <span className="detail-key">Tasks</span>
              <span>
                {current.taskCounts.total === 0
                  ? 'None yet'
                  : `${current.taskCounts.done} of ${current.taskCounts.total} done`}
                {current.taskCounts.overdue > 0 ? (
                  <span className="danger-text strong"> · {current.taskCounts.overdue} overdue</span>
                ) : null}
              </span>

              {current.description ? (
                <>
                  <span className="detail-key">About</span>
                  <span className="muted">{current.description}</span>
                </>
              ) : null}
            </div>
          </section>

          <section className="card card-flush">
            <header className="card-header">
              <h2 className="card-title">
                {user.role === 'DEVELOPER' ? 'My tasks in this project' : 'Tasks'}
              </h2>
              <div className="segmented" role="group" aria-label="Task layout">
                <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
                  Board
                </button>
                <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                  List
                </button>
              </div>
            </header>

            {tasks.error ? (
              <ErrorState error={tasks.error} onRetry={tasks.refetch} />
            ) : tasks.loading && items.length === 0 ? (
              <LoadingRows rows={4} height={44} />
            ) : items.length === 0 ? (
              <EmptyState
                title="No tasks yet"
                hint={
                  user.role === 'DEVELOPER'
                    ? 'You can see this project, but nothing in it is assigned to you.'
                    : 'Create the first task to start tracking work.'
                }
              />
            ) : view === 'board' ? (
              <TaskBoard tasks={items} highlighted={flashing} onError={setActionError} />
            ) : (
              <TaskTable tasks={items} hideProject highlighted={flashing} onError={setActionError} />
            )}
          </section>
        </div>

        <div className="col gap-5">
          {/* Scoped feed. Unscoped elsewhere; here every row belongs to this
              project, so the project name is dropped from each line. */}
          <ActivityFeed
            projectId={id}
            title="Project activity"
            limit={30}
            paginate
            maxHeight={420}
          />
          <MemberList projectId={id} canManage={canManage} />
        </div>
      </div>

      {editing ? (
        <ProjectDialog
          project={current}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            project.refetch();
          }}
        />
      ) : null}

      {creatingTask ? (
        <TaskDialog
          projects={[{ id: current.id, name: current.name }]}
          projectId={current.id}
          onClose={() => setCreatingTask(false)}
          onSaved={() => {
            setCreatingTask(false);
            tasks.refetch();
            project.refetch();
          }}
        />
      ) : null}
    </div>
  );
};
