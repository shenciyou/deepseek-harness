import type { RequestScope } from '../auth.ts'
import {
  contentTaskCreateSchema,
  contentTaskListQuerySchema,
  contentTaskPatchSchema,
  type ContentTaskCreateInput,
  type TaskStatus,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { ContentTask } from '../spec.ts'
import { ScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/**
 * The legal task status steps.
 *
 * `completed` and `cancelled` are terminal: a finished task is a record of what
 * happened, so re-opening it would quietly discard that record. Cancelling is
 * allowed from either live state because work can be abandoned at any point
 * before it finishes.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Fields a caller may supply when creating a content task. */
export type TaskInput = ContentTaskCreateInput

/** One page of content tasks, newest first. */
export interface TaskPage {
  readonly items: ContentTask[]
}

/** What the task repository needs from its owner. */
export interface TaskRepositoryOptions {
  readonly table: KvLike<ContentTask>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<ContentTask>
}

/**
 * Content tasks, scoped to the acting organization.
 *
 * As with materials, the repository is the validation boundary and the write
 * bodies are strict, so `id`, `organizationId` and the timestamps cannot be
 * supplied by a client. The extra rule here is the status machine: a task moves
 * only along {@link TASK_TRANSITIONS}, and anything else is a controlled
 * `INVALID_TRANSITION` rather than a silently accepted write.
 */
export class TaskRepository {
  private readonly base: ScopedRepository<ContentTask>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: TaskRepositoryOptions) {
    this.base = new ScopedRepository<ContentTask>({ resource: 'content_task', ...options })
  }

  /**
   * Every task the caller owns, newest first.
   * @param scope - The acting scope.
   * @returns the tasks.
   */
  list(scope: RequestScope): ContentTask[] {
    return this.base.list(scope)
  }

  /**
   * The caller's tasks, optionally filtered.
   * @param scope - The acting scope.
   * @param rawQuery - `projectId` and `status`, as received.
   * @returns the page.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a bad filter.
   */
  query(scope: RequestScope, rawQuery: unknown = {}): TaskPage {
    const parsed = contentTaskListQuerySchema.safeParse(rawQuery)
    if (!parsed.success) throw validationFailure(parsed.error)

    const { projectId, status } = parsed.data
    let items = this.base.list(scope)
    if (projectId !== undefined) items = items.filter(task => task.projectId === projectId)
    if (status !== undefined) items = items.filter(task => task.status === status)
    return { items }
  }

  /**
   * One owned task.
   * @param scope - The acting scope.
   * @param id - The task id.
   * @returns the task.
   */
  get(scope: RequestScope, id: string): ContentTask {
    return this.base.get(scope, id)
  }

  /**
   * Create a task in `pending`.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored task.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async create(scope: RequestScope, input: unknown): Promise<ContentTask> {
    const parsed = contentTaskCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      name: fields.name,
      status: 'pending',
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.relatedTopic === undefined ? {} : { relatedTopic: fields.relatedTopic }),
      ...(fields.materialId === undefined ? {} : { materialId: fields.materialId }),
      projectId: fields.projectId ?? base.projectId,
    }))
  }

  /**
   * Update a task, refusing a status step the machine does not allow.
   * @param scope - The acting scope.
   * @param id - The task id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored task.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a bad body or a no-op patch,
   * `INVALID_TRANSITION` for a step the task's current status forbids.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<ContentTask> {
    const parsed = contentTaskPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    return this.base.patch(scope, id, (current) => {
      const status = changes.status ?? current.status
      if (status !== current.status) assertTaskTransition(current.status, status)
      return { ...current, ...changes, status } as ContentTask
    })
  }

  /**
   * Delete a task.
   * @param scope - The acting scope.
   * @param id - The task id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    await this.base.remove(scope, id)
  }
}

/**
 * Refuse a task status step the machine does not allow.
 * @param from - The task's current status.
 * @param to - The requested status.
 * @throws SilipowerFailure `INVALID_TRANSITION`.
 */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw failure('INVALID_TRANSITION', `a ${from} task cannot become ${to}`)
  }
}
