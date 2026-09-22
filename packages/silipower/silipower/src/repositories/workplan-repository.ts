import type { RequestScope } from '../auth.ts'
import { requireProjectId } from '../auth.ts'
import {
  workplanListQuerySchema,
  workplanTaskCreateSchema,
  workplanTaskPatchSchema,
  type WorkplanTaskCreateInput,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { WorkPlanTask } from '../spec.ts'
import { ProjectScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when adding a work-plan task. */
export type WorkplanTaskInput = WorkplanTaskCreateInput

/** What the work-plan repository needs from its owner. */
export interface WorkplanRepositoryOptions {
  readonly table: KvLike<WorkPlanTask>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<WorkPlanTask>
}

/**
 * ISO weekday of a calendar date: 1 = Monday … 7 = Sunday.
 *
 * `getUTCDay` numbers Sunday as 0, which would make the stored weekday disagree
 * with the schema's 1–7 range every Sunday.
 * @param date - A `YYYY-MM-DD` date.
 * @returns the ISO weekday.
 */
export function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * The inclusive Sunday that ends the week a Monday starts.
 * @param weekStart - A Monday, `YYYY-MM-DD`.
 * @returns the inclusive range.
 */
export function weekRange(weekStart: string): { start: string; end: string } {
  const end = new Date(`${weekStart}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return { start: weekStart, end: end.toISOString().slice(0, 10) }
}

/**
 * Work-plan tasks, scoped to one project and read one week at a time.
 *
 * A week is addressed by its Monday and answered as Monday…Sunday only: the
 * caller asks for a week, not a range, so a task from the following Monday must
 * never appear in this week's grid.
 */
export class WorkplanRepository {
  private readonly base: ProjectScopedRepository<WorkPlanTask>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: WorkplanRepositoryOptions) {
    this.base = new ProjectScopedRepository<WorkPlanTask>({ resource: 'workplan_task', ...options })
  }

  /**
   * Every task in the acting project, newest first.
   * @param scope - The acting scope.
   * @returns the tasks.
   */
  all(scope: RequestScope): WorkPlanTask[] {
    return this.base.listInProject(scope, requireProjectId(scope))
  }

  /**
   * One week's tasks, Monday to Sunday inclusive.
   * @param scope - The acting scope.
   * @param rawQuery - `weekStart`, as received.
   * @returns the tasks in that week.
   * @throws SilipowerFailure `VALIDATION_ERROR` when `weekStart` is missing,
   * malformed, or not a Monday.
   */
  listWeek(scope: RequestScope, rawQuery: unknown): WorkPlanTask[] {
    const projectId = requireProjectId(scope)
    const parsed = workplanListQuerySchema.safeParse(rawQuery)
    if (!parsed.success) throw validationFailure(parsed.error)
    if (weekdayOf(parsed.data.weekStart) !== 1) {
      throw failure('VALIDATION_ERROR', 'weekStart must be a Monday')
    }
    const { start, end } = weekRange(parsed.data.weekStart)
    return this.base
      .listInProject(scope, projectId)
      .filter(task => task.date >= start && task.date <= end)
  }

  /**
   * One task in the acting project.
   * @param scope - The acting scope.
   * @param id - The task id.
   * @returns the task.
   */
  get(scope: RequestScope, id: string): WorkPlanTask {
    return this.base.getInProject(scope, requireProjectId(scope), id)
  }

  /**
   * Add a task; its weekday is derived from its date rather than trusted.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored task.
   */
  async create(scope: RequestScope, input: unknown): Promise<WorkPlanTask> {
    const projectId = requireProjectId(scope)
    const parsed = workplanTaskCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      projectId,
      name: fields.name,
      date: fields.date,
      weekday: weekdayOf(fields.date),
      status: 'pending',
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.relatedTopic === undefined ? {} : { relatedTopic: fields.relatedTopic }),
      ...(fields.platform === undefined ? {} : { platform: fields.platform }),
    }))
  }

  /**
   * Update a task, including its status.
   * @param scope - The acting scope.
   * @param id - The task id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored task.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<WorkPlanTask> {
    const projectId = requireProjectId(scope)
    const parsed = workplanTaskPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    this.base.getInProject(scope, projectId, id)
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as WorkPlanTask)
  }

  /**
   * Delete a task.
   * @param scope - The acting scope.
   * @param id - The task id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    const projectId = requireProjectId(scope)
    this.base.getInProject(scope, projectId, id)
    await this.base.remove(scope, id)
  }
}
