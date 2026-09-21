import type { ZodError } from 'zod'
import type { RequestScope } from '../auth.ts'
import { failure } from '../errors.ts'

/**
 * The subset of the DSH `KvTable` surface the repositories depend on. Narrowing
 * it here keeps the repositories testable without booting a Cordis host.
 */
export interface KvLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Fields every tenant-scoped record carries. */
export interface OwnedRecord {
  readonly id: string
  readonly organizationId: string
  readonly projectId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** What a write did, for the audit trail. */
export type AuditAction = 'create' | 'patch' | 'remove'

/** Called after a durable write so the owner can append an audit event. */
export type WriteObserver<T extends OwnedRecord> = (
  action: AuditAction,
  resource: string,
  record: T,
  scope: RequestScope,
) => Promise<void>

/** What a {@link ScopedRepository} needs from its owner. */
export interface RepositoryOptions<T extends OwnedRecord> {
  readonly resource: string
  readonly table: KvLike<T>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<T>
}

/**
 * CRUD over one table, always scoped to the caller's organization.
 *
 * Two rules are enforced here rather than per resource, because a resource that
 * forgot either one would be a data leak:
 *
 * - Every read filters by `organizationId`, and a record outside the caller's
 *   organization is reported as `NOT_FOUND` — never `FORBIDDEN`. Answering
 *   "forbidden" would confirm that the id exists.
 * - `id`, `organizationId` and `createdAt` are not writable after creation.
 */
export class ScopedRepository<T extends OwnedRecord> {
  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(private readonly options: RepositoryOptions<T>) {}

  /**
   * Every record the caller owns, newest first.
   * @param scope - The acting scope.
   * @returns the records, sorted by `updatedAt` then `id`, both descending.
   */
  list(scope: RequestScope): T[] {
    const owned: T[] = []
    for (const [, record] of this.options.table.entries()) {
      if (record.organizationId === scope.organizationId) owned.push(record)
    }
    return owned.sort(newestFirst)
  }

  /**
   * One owned record.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @returns the record.
   * @throws SilipowerFailure `NOT_FOUND` when absent or owned by another organization.
   */
  get(scope: RequestScope, id: string): T {
    const record = this.options.table.get(id)
    if (record === undefined || record.organizationId !== scope.organizationId) {
      throw failure('NOT_FOUND', `${this.options.resource} ${id} not found`)
    }
    return record
  }

  /**
   * Persist a new record.
   *
   * `build` runs before the write, so a validation failure in it leaves both
   * the table and the audit trail untouched.
   * @param scope - The acting scope.
   * @param build - Called with the ownership fields the caller may not supply.
   * @returns the stored record.
   */
  async create(scope: RequestScope, build: (base: OwnedRecord) => T): Promise<T> {
    if (scope.organizationId === '') {
      throw failure('VALIDATION_ERROR', 'organizationId is required')
    }
    const now = this.options.now()
    const record = build({
      id: this.options.newId(),
      organizationId: scope.organizationId,
      projectId: null,
      createdAt: now,
      updatedAt: now,
    })
    await this.options.table.put(record.id, record)
    await this.options.onWrite('create', this.options.resource, record, scope)
    return record
  }

  /**
   * Replace the mutable part of an owned record.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @param mutate - Produces the next record from the current one.
   * @returns the stored record, with a fresh `updatedAt`.
   * @throws SilipowerFailure `NOT_FOUND`, or `VALIDATION_ERROR` when `mutate`
   * moves the record to another id or organization.
   */
  async patch(scope: RequestScope, id: string, mutate: (current: T) => T): Promise<T> {
    const current = this.get(scope, id)
    const next = mutate(current)
    if (next.id !== current.id || next.organizationId !== current.organizationId) {
      throw failure('VALIDATION_ERROR', 'id, organizationId and createdAt are not patchable')
    }
    const stamped: T = { ...next, updatedAt: this.options.now() }
    await this.options.table.put(stamped.id, stamped)
    await this.options.onWrite('patch', this.options.resource, stamped, scope)
    return stamped
  }

  /**
   * Delete an owned record.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @throws SilipowerFailure `NOT_FOUND` when absent or owned by another organization.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    const current = this.get(scope, id)
    await this.options.table.delete(id)
    await this.options.onWrite('remove', this.options.resource, current, scope)
  }
}

/**
 * Turn a Zod failure into the wire's `VALIDATION_ERROR`.
 *
 * Shared by every repository so the message format cannot drift between
 * resources; the `path: message` join is what a client shows for a bad field.
 * @param error - The failed parse.
 * @returns the failure, ready to throw.
 */
export function validationFailure(error: ZodError): ReturnType<typeof failure> {
  return failure(
    'VALIDATION_ERROR',
    error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  )
}

/**
 * Order owned records newest first, breaking ties by descending id.
 *
 * Exported because the `left.id === right.id` arm cannot be reached through a
 * table — ids are the key, so a table never yields two records with the same
 * id — and an unexercised comparator arm is exactly the kind of thing that
 * silently inverts an order later.
 * @param left - First record.
 * @param right - Second record.
 * @returns negative when `left` sorts first.
 */
export function newestFirst<T extends OwnedRecord>(left: T, right: T): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
  if (left.id === right.id) return 0
  return left.id < right.id ? 1 : -1
}
