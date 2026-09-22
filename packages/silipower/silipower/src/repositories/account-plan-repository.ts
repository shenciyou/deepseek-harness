import type { RequestScope } from '../auth.ts'
import { requireProjectId } from '../auth.ts'
import {
  accountPlanCreateSchema,
  accountPlanPatchSchema,
  type AccountPlanCreateInput,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { AccountPlan } from '../spec.ts'
import { ProjectScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when saving an account-startup plan. */
export type AccountPlanInput = AccountPlanCreateInput

/** What the account-plan repository needs from its owner. */
export interface AccountPlanRepositoryOptions {
  readonly table: KvLike<AccountPlan>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<AccountPlan>
}

/**
 * Saved account-startup plans, scoped to one project.
 *
 * A plan is the durable result of one generation, so `generationRunId` rides
 * along when the caller has it: it is what lets a later reader trace the text
 * back to the model call that produced it. It is set at creation and not
 * patchable, because re-pointing it would make that trace a lie.
 */
export class AccountPlanRepository {
  private readonly base: ProjectScopedRepository<AccountPlan>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: AccountPlanRepositoryOptions) {
    this.base = new ProjectScopedRepository<AccountPlan>({ resource: 'account_plan', ...options })
  }

  /**
   * Every plan in the acting project, newest first.
   * @param scope - The acting scope.
   * @returns the plans.
   */
  list(scope: RequestScope): AccountPlan[] {
    return this.base.listInProject(scope, requireProjectId(scope))
  }

  /**
   * One plan in the acting project.
   * @param scope - The acting scope.
   * @param id - The plan id.
   * @returns the plan.
   */
  get(scope: RequestScope, id: string): AccountPlan {
    return this.base.getInProject(scope, requireProjectId(scope), id)
  }

  /**
   * Save a plan.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored plan.
   */
  async create(scope: RequestScope, input: unknown): Promise<AccountPlan> {
    const projectId = requireProjectId(scope)
    const parsed = accountPlanCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      projectId,
      name: fields.name,
      track: fields.track,
      platforms: fields.platforms,
      audience: fields.audience ?? '',
      accountType: fields.accountType,
      content: fields.content,
      ...(fields.generationRunId === undefined ? {} : { generationRunId: fields.generationRunId }),
    }))
  }

  /**
   * Update a saved plan.
   * @param scope - The acting scope.
   * @param id - The plan id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored plan.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<AccountPlan> {
    const projectId = requireProjectId(scope)
    const parsed = accountPlanPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    this.base.getInProject(scope, projectId, id)
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as AccountPlan)
  }

  /**
   * Delete a saved plan.
   * @param scope - The acting scope.
   * @param id - The plan id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    const projectId = requireProjectId(scope)
    this.base.getInProject(scope, projectId, id)
    await this.base.remove(scope, id)
  }
}
