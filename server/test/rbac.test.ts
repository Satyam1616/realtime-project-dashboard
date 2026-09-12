/**
 * Unit tests for the authorisation rules in src/access/rbac.ts.
 *
 * These are the cheapest tests in the project and they cover the most
 * expensive kind of bug. Everything in `rbac.ts` is a pure function of a
 * principal and a row, so each rule can be stated here as a fact rather than
 * demonstrated through six layers of HTTP.
 *
 * The scope functions return Prisma `where` fragments rather than booleans, so
 * the assertions are on the *shape of the query* — that a developer's task
 * filter pins `assigneeId` to their own id, for instance, and not merely that
 * it is non-empty. A scope that accidentally widened to `{}` would still be a
 * truthy object; only comparing the fragment catches it.
 *
 * See test/access.integration.test.ts for the other half of the argument: that
 * the handlers actually apply what is asserted here.
 */
import { describe, expect, it } from 'vitest';
import { Role, TaskStatus } from '../src/db/client.js';
import {
  activityScope,
  assertCanUpdateTask,
  canCreateProject,
  canCreateTaskIn,
  canDeleteProject,
  canDeleteTask,
  canManageClients,
  canManageProject,
  canManageUsers,
  canReadClients,
  canUpdateTask,
  dashboardVariant,
  notificationScope,
  projectScope,
  taskScope,
  writableTaskFields,
  type Principal,
} from '../src/access/rbac.js';
import { isAppError } from '../src/lib/errors.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const principal = (role: Role, id: string): Principal => ({
  id,
  role,
  email: `${id}@velozity.test`,
  name: id,
});

const admin = principal(Role.ADMIN, 'admin-1');
const pmOwner = principal(Role.PROJECT_MANAGER, 'pm-owner');
const pmOther = principal(Role.PROJECT_MANAGER, 'pm-other');
const devOwner = principal(Role.DEVELOPER, 'dev-owner');
const devOther = principal(Role.DEVELOPER, 'dev-other');

const ROLES = [admin, pmOwner, devOwner];

/** A task in `pm-owner`'s project, assigned to `dev-owner`. */
const task = {
  assigneeId: devOwner.id,
  status: TaskStatus.IN_PROGRESS,
  project: { managerId: pmOwner.id },
};

/** Asserts the call throws an `AppError` with the given status. */
const expectRefusal = (fn: () => void, status = 403): void => {
  try {
    fn();
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect(isAppError(error) && error.statusCode).toBe(status);
    return;
  }
  throw new Error('expected the call to be refused, but it returned normally');
};

/* ------------------------------------------------------------------ *
 * Visibility scopes
 * ------------------------------------------------------------------ */

describe('projectScope', () => {
  it('gives an admin an unfiltered query', () => {
    expect(projectScope(admin)).toEqual({});
  });

  it("restricts a manager to projects they own", () => {
    expect(projectScope(pmOwner)).toEqual({ managerId: pmOwner.id });
  });

  it('lets a developer see projects they hold a task in or belong to, and no others', () => {
    expect(projectScope(devOwner)).toEqual({
      OR: [{ tasks: { some: { assigneeId: devOwner.id } } }, { members: { some: { userId: devOwner.id } } }],
    });
  });

  it('never returns an unfiltered query for a non-admin', () => {
    // The failure mode this guards against is a `case` falling through to `{}`
    // — which reads as "no filter" and silently exposes everything.
    for (const p of [pmOwner, devOwner]) {
      expect(projectScope(p)).not.toEqual({});
    }
  });
});

describe('taskScope', () => {
  it('gives an admin an unfiltered query', () => {
    expect(taskScope(admin)).toEqual({});
  });

  it("restricts a manager to tasks inside projects they own", () => {
    expect(taskScope(pmOwner)).toEqual({ project: { managerId: pmOwner.id } });
  });

  it('pins a developer to their own assignments, not to their projects', () => {
    // The distinction is the whole requirement: "a Developer cannot see other
    // developers' tasks". Scoping by project would hand them their teammates'
    // work, since they share a project by definition.
    expect(taskScope(devOwner)).toEqual({ assigneeId: devOwner.id });
    expect(taskScope(devOwner)).not.toHaveProperty('project');
  });

  it('gives two developers disjoint scopes', () => {
    expect(taskScope(devOwner)).not.toEqual(taskScope(devOther));
  });
});

describe('activityScope', () => {
  it('matches the shape of taskScope for each role, so the feed cannot out-reveal the API', () => {
    expect(activityScope(admin)).toEqual({});
    expect(activityScope(pmOwner)).toEqual({ project: { managerId: pmOwner.id } });
    expect(activityScope(devOwner)).toEqual({ task: { assigneeId: devOwner.id } });
  });

  it("filters a developer's feed through the task relation, which excludes project-level events", () => {
    // Project-level events have `taskId IS NULL`, so requiring a matching
    // related task removes them by construction rather than by a second check.
    expect(activityScope(devOwner)).toEqual({ task: { assigneeId: devOwner.id } });
  });
});

describe('notificationScope', () => {
  it('is always the recipient, for every role including admin', () => {
    for (const p of ROLES) {
      expect(notificationScope(p)).toEqual({ recipientId: p.id });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

describe('administrative capabilities', () => {
  it('limits user and client management to admins', () => {
    expect(canManageUsers(admin)).toBe(true);
    expect(canManageUsers(pmOwner)).toBe(false);
    expect(canManageUsers(devOwner)).toBe(false);

    expect(canManageClients(admin)).toBe(true);
    expect(canManageClients(pmOwner)).toBe(false);
    expect(canManageClients(devOwner)).toBe(false);
  });

  it('lets a manager read clients — they need the list to attach a project', () => {
    expect(canReadClients(admin)).toBe(true);
    expect(canReadClients(pmOwner)).toBe(true);
    expect(canReadClients(devOwner)).toBe(false);
  });

  it('lets admins and managers create projects, but not developers', () => {
    expect(canCreateProject(admin)).toBe(true);
    expect(canCreateProject(pmOwner)).toBe(true);
    expect(canCreateProject(devOwner)).toBe(false);
  });

  it('keeps project deletion admin-only, because it destroys the audit trail', () => {
    expect(canDeleteProject(admin)).toBe(true);
    expect(canDeleteProject(pmOwner)).toBe(false);
    expect(canDeleteProject(devOwner)).toBe(false);
  });
});

describe('canManageProject', () => {
  const project = { managerId: pmOwner.id };

  it('admits an admin anywhere', () => {
    expect(canManageProject(admin, project)).toBe(true);
  });

  it('admits the owning manager', () => {
    expect(canManageProject(pmOwner, project)).toBe(true);
  });

  it('refuses a different manager — the PM-vs-PM boundary', () => {
    expect(canManageProject(pmOther, project)).toBe(false);
  });

  it('refuses a developer even on a project holding their own tasks', () => {
    expect(canManageProject(devOwner, project)).toBe(false);
  });
});

describe('canCreateTaskIn', () => {
  it('follows project ownership exactly', () => {
    const project = { managerId: pmOwner.id };
    expect(canCreateTaskIn(admin, project)).toBe(true);
    expect(canCreateTaskIn(pmOwner, project)).toBe(true);
    expect(canCreateTaskIn(pmOther, project)).toBe(false);
    expect(canCreateTaskIn(devOwner, project)).toBe(false);
  });
});

describe('canUpdateTask', () => {
  it('admits an admin', () => {
    expect(canUpdateTask(admin, task)).toBe(true);
  });

  it("admits the owning project's manager", () => {
    expect(canUpdateTask(pmOwner, task)).toBe(true);
  });

  it('refuses the other manager', () => {
    expect(canUpdateTask(pmOther, task)).toBe(false);
  });

  it('admits the assignee', () => {
    expect(canUpdateTask(devOwner, task)).toBe(true);
  });

  it('refuses a developer who is not the assignee', () => {
    expect(canUpdateTask(devOther, task)).toBe(false);
  });

  it('refuses every developer on an unassigned task', () => {
    const unassigned = { ...task, assigneeId: null };
    expect(canUpdateTask(devOwner, unassigned)).toBe(false);
    expect(canUpdateTask(devOther, unassigned)).toBe(false);
    // …but an admin or the owning PM still needs to be able to triage it.
    expect(canUpdateTask(admin, unassigned)).toBe(true);
    expect(canUpdateTask(pmOwner, unassigned)).toBe(true);
  });
});

describe('writableTaskFields', () => {
  it('allows a developer status and nothing else', () => {
    expect([...writableTaskFields(devOwner)]).toEqual(['status']);
  });

  it('gives admins and managers the full set', () => {
    for (const p of [admin, pmOwner]) {
      expect([...writableTaskFields(p)]).toEqual([
        'title',
        'description',
        'status',
        'priority',
        'dueDate',
        'assigneeId',
      ]);
    }
  });
});

describe('assertCanUpdateTask', () => {
  it('permits the assignee to move the task along the board', () => {
    expect(() => assertCanUpdateTask(devOwner, task, { status: TaskStatus.IN_REVIEW })).not.toThrow();
  });

  it('refuses a non-assignee developer outright', () => {
    expectRefusal(() => assertCanUpdateTask(devOther, task, { status: TaskStatus.IN_REVIEW }));
  });

  it('refuses a developer who tries to reassign the task to themselves', () => {
    // Identity passes — they *are* the assignee — so this is caught by the
    // field allowlist rather than by the ownership check.
    expectRefusal(() => assertCanUpdateTask(devOwner, task, { assigneeId: devOther.id }));
  });

  it('refuses a developer changing priority or due date', () => {
    expectRefusal(() => assertCanUpdateTask(devOwner, task, { priority: 'CRITICAL' }));
    expectRefusal(() => assertCanUpdateTask(devOwner, task, { dueDate: '2030-01-01' }));
  });

  it('names the offending field in the refusal, so the client can say why', () => {
    try {
      assertCanUpdateTask(devOwner, task, { priority: 'CRITICAL' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isAppError(error) && error.message).toContain('priority');
    }
  });

  it('refuses a developer marking their own work Done — the review gate', () => {
    // Without this, the "moved to In Review" notification to the PM would be
    // decorative: a developer could self-approve.
    expectRefusal(() => assertCanUpdateTask(devOwner, task, { status: TaskStatus.DONE }));
  });

  it('lets the owning manager and an admin sign work off as Done', () => {
    expect(() => assertCanUpdateTask(pmOwner, task, { status: TaskStatus.DONE })).not.toThrow();
    expect(() => assertCanUpdateTask(admin, task, { status: TaskStatus.DONE })).not.toThrow();
  });

  it('ignores keys explicitly set to undefined rather than refusing them', () => {
    // A PATCH body deserialised with optional keys present-but-undefined is not
    // an attempt to write those fields.
    expect(() =>
      assertCanUpdateTask(devOwner, task, { status: TaskStatus.IN_REVIEW, priority: undefined }),
    ).not.toThrow();
  });

  it('refuses the whole patch when any one field is out of bounds', () => {
    // Partial application would be worse than refusal: the caller would get a
    // 200 and a silently different result from the one they asked for.
    expectRefusal(() =>
      assertCanUpdateTask(devOwner, task, { status: TaskStatus.IN_REVIEW, priority: 'LOW' }),
    );
  });
});

describe('canDeleteTask', () => {
  it('follows project ownership, not assignment', () => {
    expect(canDeleteTask(admin, task)).toBe(true);
    expect(canDeleteTask(pmOwner, task)).toBe(true);
    expect(canDeleteTask(pmOther, task)).toBe(false);
    // The assignee can move it, but not destroy it and its history.
    expect(canDeleteTask(devOwner, task)).toBe(false);
  });
});

describe('dashboardVariant', () => {
  it('is derived from the principal, so there is no request parameter to tamper with', () => {
    expect(dashboardVariant(admin)).toBe('admin');
    expect(dashboardVariant(pmOwner)).toBe('manager');
    expect(dashboardVariant(devOwner)).toBe('developer');
  });
});
