import type { RequestScope } from '../auth.ts'
import { requireProjectId } from '../auth.ts'
import { competitorCreateSchema, competitorPatchSchema, type CompetitorCreateInput } from '../contracts.ts'
import { failure } from '../errors.ts'
import type { Competitor } from '../spec.ts'
import { ProjectScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when watching a competitor. */
export type CompetitorInput = CompetitorCreateInput

/** What the competitor repository needs from its owner. */
export interface CompetitorRepositoryOptions {
  readonly table: KvLike<Competitor>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<Competitor>
}

/**
 * Accounts the organization watches, scoped to one project.
 *
 * `source` is fixed to `user`: these rows are entered by hand until a platform
 * API exists, and letting a client claim `openapi` would misrepresent how the
 * numbers got there.
 */
export class CompetitorRepository {
  private readonly base: ProjectScopedRepository<Competitor>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: CompetitorRepositoryOptions) {
    this.base = new ProjectScopedRepository<Competitor>({ resource: 'competitor', ...options })
  }

  /**
   * Every watched account in the acting project, newest first.
   * @param scope - The acting scope.
   * @returns the competitors.
   */
  list(scope: RequestScope): Competitor[] {
    return this.base.listInProject(scope, requireProjectId(scope))
  }

  /**
   * One watched account in the acting project.
   * @param scope - The acting scope.
   * @param id - The competitor id.
   * @returns the competitor.
   */
  get(scope: RequestScope, id: string): Competitor {
    return this.base.getInProject(scope, requireProjectId(scope), id)
  }

  /**
   * Watch a new account.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored competitor.
   */
  async create(scope: RequestScope, input: unknown): Promise<Competitor> {
    const projectId = requireProjectId(scope)
    const parsed = competitorCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      projectId,
      accountName: fields.accountName,
      latestWork: fields.latestWork ?? '',
      dataTrend: fields.dataTrend ?? 'flat',
      followers: fields.followers ?? 0,
      source: 'user',
    }))
  }

  /**
   * Update a watched account.
   * @param scope - The acting scope.
   * @param id - The competitor id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored competitor.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<Competitor> {
    const projectId = requireProjectId(scope)
    const parsed = competitorPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    this.base.getInProject(scope, projectId, id)
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as Competitor)
  }

  /**
   * Stop watching an account.
   * @param scope - The acting scope.
   * @param id - The competitor id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    const projectId = requireProjectId(scope)
    this.base.getInProject(scope, projectId, id)
    await this.base.remove(scope, id)
  }
}
