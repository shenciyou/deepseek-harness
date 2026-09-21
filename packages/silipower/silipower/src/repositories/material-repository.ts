import type { ZodError } from 'zod'
import type { RequestScope } from '../auth.ts'
import {
  materialCreateSchema,
  materialListQuerySchema,
  materialPatchSchema,
  type MaterialCreateInput,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { Material } from '../spec.ts'
import { ScopedRepository, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating a material. */
export type MaterialInput = MaterialCreateInput

/** How many materials one page holds when the caller does not ask for a size. */
export const DEFAULT_MATERIAL_PAGE_SIZE = 20

/** One page of materials, newest first, plus the cursor for the next page. */
export interface MaterialPage {
  readonly items: Material[]
  readonly nextCursor?: string
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
 * The repository is the validation boundary: the write methods take `unknown`
 * on purpose, because their callers hand over a parsed HTTP body whose shape is
 * not trustworthy until these schemas have seen it. The schemas are strict, so
 * `id`, `organizationId` and the timestamps are rejected rather than silently
 * dropped — a client that believes it chose an owner should be told it did not.
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
   * One page of the caller's materials, optionally filtered.
   *
   * The cursor is the base64url of the last id of the previous page. It is
   * resolved against the already organization-filtered list, so a cursor that
   * points at another organization's material simply matches nothing and is
   * rejected — the caller learns only that the cursor is bad.
   * @param scope - The acting scope.
   * @param rawQuery - `projectId`, `type`, `cursor` and `limit`, as received.
   * @returns the page.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a bad query or cursor.
   */
  query(scope: RequestScope, rawQuery: unknown = {}): MaterialPage {
    const parsed = materialListQuerySchema.safeParse(rawQuery)
    if (!parsed.success) throw validationFailure(parsed.error)

    const { projectId, type, cursor } = parsed.data
    let items = this.base.list(scope)
    if (projectId !== undefined) items = items.filter(material => material.projectId === projectId)
    if (type !== undefined) items = items.filter(material => material.type === type)
    if (cursor !== undefined) {
      const cursorId = decodeCursor(cursor)
      const index = items.findIndex(material => material.id === cursorId)
      if (index === -1) throw failure('VALIDATION_ERROR', 'cursor does not point into this list')
      items = items.slice(index + 1)
    }

    const limit = parsed.data.limit ?? DEFAULT_MATERIAL_PAGE_SIZE
    const page = items.slice(0, limit)
    // `limit` is at least 1, so a page shorter than the limit is the last page.
    if (items.length <= limit) return { items: page }
    // The page is full and `limit` is at least 1, so it has a last id; reducing
    // keeps that fact in the type rather than asserting it away.
    const lastOfPage = page.reduce((_previous, material) => material.id, '')
    return { items: page, nextCursor: encodeCursor(lastOfPage) }
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
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored material.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async create(scope: RequestScope, input: unknown): Promise<Material> {
    const parsed = materialCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    return this.base.create(scope, base => ({
      ...base,
      name: fields.name,
      type: fields.type,
      ...(fields.category === undefined ? {} : { category: fields.category }),
      ...(fields.content === undefined ? {} : { content: fields.content }),
      ...(fields.url === undefined ? {} : { url: fields.url }),
      projectId: fields.projectId ?? base.projectId,
    }))
  }

  /**
   * Update a material.
   * @param scope - The acting scope.
   * @param id - The material id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored material.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects,
   * or one that changes nothing.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<Material> {
    const parsed = materialPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    // Zod omits absent optional keys, so a key that is present here is a real
    // value and never `undefined`; the cast just tells TypeScript what the
    // schema already guarantees at runtime.
    return this.base.patch(scope, id, current => ({ ...current, ...changes }) as Material)
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

/**
 * Encode a material id as a cursor.
 * @param id - The last id of the page.
 * @returns the opaque cursor.
 */
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url')
}

/**
 * Decode a cursor back to the id it names.
 *
 * Deliberately does not validate: a cursor that decodes to something no record
 * matches is rejected by the caller's lookup, one code path for every bad input.
 * @param cursor - The cursor from the query string.
 * @returns the id it names, or a value that will match nothing.
 */
function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8')
}

/**
 * Turn a Zod failure into the wire's `VALIDATION_ERROR`.
 * @param error - The failed parse.
 * @returns the failure, ready to throw.
 */
function validationFailure(error: ZodError): ReturnType<typeof failure> {
  return failure(
    'VALIDATION_ERROR',
    error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  )
}
