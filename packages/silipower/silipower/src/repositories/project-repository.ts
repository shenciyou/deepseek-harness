import type { RequestScope } from '../auth.ts'
import { failure } from '../errors.ts'
import { projectSchema, type Project } from '../spec.ts'
import { ScopedRepository, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating a project. */
export interface ProjectInput {
  readonly name: string
  readonly description: string
  readonly category: string
}

/** What the project repository needs from its owner. */
export interface ProjectRepositoryOptions {
  readonly table: KvLike<Project>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<Project>
}

/**
 * Projects, scoped to the acting organization.
 *
 * A project is the boundary the rest of the domain hangs off, so it is
 * deliberately organization-wide: `projectId` is null on a project record
 * itself, and everything else points at it.
 */
export class ProjectRepository {
  private readonly base: ScopedRepository<Project>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: ProjectRepositoryOptions) {
    this.base = new ScopedRepository<Project>({ resource: 'project', ...options })
  }

  /**
   * Every project the caller owns, newest first.
   * @param scope - The acting scope.
   * @returns the projects.
   */
  list(scope: RequestScope): Project[] {
    return this.base.list(scope)
  }

  /**
   * One owned project.
   * @param scope - The acting scope.
   * @param id - The project id.
   * @returns the project.
   */
  get(scope: RequestScope, id: string): Project {
    return this.base.get(scope, id)
  }

  /**
   * Create an active project.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields.
   * @returns the stored project.
   */
  async create(scope: RequestScope, input: ProjectInput): Promise<Project> {
    return this.base.create(scope, base =>
      parseProject({ ...base, ...input, status: 'active' }),
    )
  }

  /**
   * Update a project.
   * @param scope - The acting scope.
   * @param id - The project id.
   * @param input - The fields to change.
   * @returns the stored project.
   */
  async patch(
    scope: RequestScope,
    id: string,
    input: Partial<ProjectInput> & { status?: Project['status'] },
  ): Promise<Project> {
    return this.base.patch(scope, id, current => parseProject({ ...current, ...input }))
  }

  /**
   * Delete a project.
   * @param scope - The acting scope.
   * @param id - The project id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    await this.base.remove(scope, id)
  }
}

function parseProject(candidate: unknown): Project {
  const parsed = projectSchema.safeParse(candidate)
  if (!parsed.success) {
    throw failure(
      'VALIDATION_ERROR',
      parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  }
  return parsed.data
}
