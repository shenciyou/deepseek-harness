import type { RequestScope } from '../auth.ts'
import { failure } from '../errors.ts'
import { publishRecordSchema, type PublishRecord } from '../spec.ts'
import { ScopedRepository, type KvLike, type WriteObserver } from './base.ts'

/** Fields a caller may supply when creating a publish record. */
export interface PublishRecordInput {
  readonly platform: string
  readonly materialId: string
  readonly accountId?: string
  readonly projectId?: string | null
}

/** Fields a caller may change on a publish record. */
export interface PublishRecordPatch {
  readonly status?: PublishRecord['status']
  readonly accountId?: string
}

/** What the publish repository needs from its owner. */
export interface PublishRecordRepositoryOptions {
  readonly table: KvLike<PublishRecord>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<PublishRecord>
}

/**
 * Publish records, scoped to the acting organization.
 *
 * A record starts as a draft and only carries `publishedAt` while its status is
 * `published`; leaving that status clears the stamp rather than leaving a
 * timestamp that contradicts the status. Nothing here talks to a platform, so
 * "published" means the operator recorded the publication, not that the app
 * performed it.
 */
export class PublishRecordRepository {
  private readonly base: ScopedRepository<PublishRecord>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(private readonly options: PublishRecordRepositoryOptions) {
    this.base = new ScopedRepository<PublishRecord>({ resource: 'publish_record', ...options })
  }

  /**
   * Every publish record the caller owns, newest first.
   * @param scope - The acting scope.
   * @returns the records.
   */
  list(scope: RequestScope): PublishRecord[] {
    return this.base.list(scope)
  }

  /**
   * One owned publish record.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @returns the record.
   */
  get(scope: RequestScope, id: string): PublishRecord {
    return this.base.get(scope, id)
  }

  /**
   * Create a draft publish record.
   * @param scope - The acting scope.
   * @param input - The caller-supplied fields.
   * @returns the stored record.
   */
  async create(scope: RequestScope, input: PublishRecordInput): Promise<PublishRecord> {
    return this.base.create(scope, base =>
      parsePublishRecord({
        ...base,
        platform: input.platform,
        materialId: input.materialId,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        projectId: input.projectId ?? base.projectId,
        status: 'draft',
      }),
    )
  }

  /**
   * Update a publish record, keeping `publishedAt` consistent with `status`.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @param input - The fields to change.
   * @returns the stored record.
   */
  async patch(scope: RequestScope, id: string, input: PublishRecordPatch): Promise<PublishRecord> {
    return this.base.patch(scope, id, (current) => {
      const status = input.status ?? current.status
      const published = status === 'published'
      const publishedAt = published ? (current.publishedAt ?? this.options.now()) : undefined
      return parsePublishRecord({
        ...current,
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        status,
        publishedAt,
      })
    })
  }

  /**
   * Delete a publish record.
   * @param scope - The acting scope.
   * @param id - The record id.
   */
  async remove(scope: RequestScope, id: string): Promise<void> {
    await this.base.remove(scope, id)
  }
}

function parsePublishRecord(candidate: unknown): PublishRecord {
  const parsed = publishRecordSchema.safeParse(candidate)
  if (!parsed.success) {
    throw failure(
      'VALIDATION_ERROR',
      parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    )
  }
  return parsed.data
}
