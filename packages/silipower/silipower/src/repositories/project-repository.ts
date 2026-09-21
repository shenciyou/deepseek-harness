import type { RequestScope } from '../auth.ts'
import {
  projectCreateSchema,
  projectPatchSchema,
  type ProjectCreateInput,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { Project } from '../spec.ts'
import { ScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating a project. */
export type ProjectInput = ProjectCreateInput

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
 * itself, and everything else points at it. As with the other resource
 * repositories, the write bodies are strict and validated here.
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
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored project.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async create(scope: RequestScope, input: unknown): Promise<Project> {
    const parsed = projectCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      name: fields.name,
      description: fields.description ?? '',
      category: fields.category ?? '',
      status: 'active',
    }))
  }

  /**
   * Update a project.
   * @param scope - The acting scope.
   * @param id - The project id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored project.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<Project> {
    const parsed = projectPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    // Zod omits absent optional keys, so a present key is a real value.
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as Project)
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
