import type { RequestScope } from '../auth.ts'
import { failure } from '../errors.ts'
import { materialSchema, type Material } from '../spec.ts'
import { ScopedRepository, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating a material. */
export interface MaterialInput {
  readonly name: string
  readonly type: Material['type']
  readonly category?: string
  readonly content?: string
  readonly url?: string
  readonly projectId?: string | null
}

/** What the material repository needs from its owner. */
export interface MaterialRepositoryOptions {
  readonly table: KvLike<Material>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<Material>
}

/**
 * Materials, scoped to the acting organization.
 *
 * The repository owns validation, so a rejected input never reaches the table
 * and never produces an audit event.
 */
export class MaterialRepository {
  private readonly base: ScopedRepository<Material>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: MaterialRepositoryOptions) {
    this.base = new ScopedRepository<Material>({ resource: 'material', ...options })
  }

  /**
   * Every material the caller owns, newest first.
   * @param scope - The acting scope.
   * @returns the materials.
   */
  list(scope: RequestScope): Material[] {
    return this.base.list(scope)
  }

  /**
   * One owned material.
   * @param scope - The acting scope.
   * @param id - The material id.
   * @returns the material.
   */
  get(scope: RequestScope, id: string): Material {
    return this.base.get(scope, id)
  }

  /**
   * Create a material.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields.
   * @returns the stored material.
   */
  async create(scope: RequestScope, input: MaterialInput): Promise<Material> {
    return this.base.create(scope, base =>
      parseMaterial({
        ...base,
        name: input.name,
        type: input.type,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.url === undefined ? {} : { url: input.url }),
        projectId: input.projectId ?? base.projectId,
      }),
    )
  }

  /**
   * Update a material.
   * @param scope - The acting scope.
   * @param id - The material id.
   * @param input - The fields to change.
   * @returns the stored material.
   */
  async patch(scope: RequestScope, id: string, input: Partial<MaterialInput>): Promise<Material> {
    return this.base.patch(scope, id, current => parseMaterial({ ...current, ...input }))
  }

  /**
   * Delete a material.
   * @param scope - The acting scope.
   * @param id - The material id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    await this.base.remove(scope, id)
  }
}

function parseMaterial(candidate: unknown): Material {
  const parsed = materialSchema.safeParse(candidate)
  if (!parsed.success) {
    throw failure(
      'VALIDATION_ERROR',
      parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  }
  return parsed.data
}
