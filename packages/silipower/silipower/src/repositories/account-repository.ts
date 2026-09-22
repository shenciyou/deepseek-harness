import type { RequestScope } from '../auth.ts'
import { requireProjectId } from '../auth.ts'
import { accountCreateSchema, accountPatchSchema, type AccountCreateInput } from '../contracts.ts'
import { failure } from '../errors.ts'
import type { OperationAccount } from '../spec.ts'
import { ProjectScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating an operated account. */
export type AccountInput = AccountCreateInput

/** What the account repository needs from its owner. */
export interface AccountRepositoryOptions {
  readonly table: KvLike<OperationAccount>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<OperationAccount>
}

/**
 * Accounts the organization operates, scoped to one project.
 *
 * Accounts are what an account-startup plan is written for, so they live inside
 * a project: switching projects must not show the previous project's accounts.
 * Every method therefore requires the acting project, and reads answer
 * `NOT_FOUND` for a record that lives in another one.
 */
export class AccountRepository {
  private readonly base: ProjectScopedRepository<OperationAccount>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: AccountRepositoryOptions) {
    this.base = new ProjectScopedRepository<OperationAccount>({ resource: 'account', ...options })
  }

  /**
   * Every account in the acting project, newest first.
   * @param scope - The acting scope, including the project.
   * @returns the accounts.
   */
  list(scope: RequestScope): OperationAccount[] {
    return this.base.listInProject(scope, requireProjectId(scope))
  }

  /**
   * One account in the acting project.
   * @param scope - The acting scope.
   * @param id - The account id.
   * @returns the account.
   */
  get(scope: RequestScope, id: string): OperationAccount {
    return this.base.getInProject(scope, requireProjectId(scope), id)
  }

  /**
   * Create an account in the acting project.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored account.
   */
  async create(scope: RequestScope, input: unknown): Promise<OperationAccount> {
    const projectId = requireProjectId(scope)
    const parsed = accountCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      projectId,
      accountName: fields.accountName,
      platform: fields.platform,
      ...(fields.accountUrl === undefined ? {} : { accountUrl: fields.accountUrl }),
    }))
  }

  /**
   * Update an account in the acting project.
   * @param scope - The acting scope.
   * @param id - The account id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored account.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<OperationAccount> {
    const projectId = requireProjectId(scope)
    const parsed = accountPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    // Check the project boundary before writing, not after.
    this.base.getInProject(scope, projectId, id)
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as OperationAccount)
  }

  /**
   * Delete an account in the acting project.
   * @param scope - The acting scope.
   * @param id - The account id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    const projectId = requireProjectId(scope)
    this.base.getInProject(scope, projectId, id)
    await this.base.remove(scope, id)
  }
}
