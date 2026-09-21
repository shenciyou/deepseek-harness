import type { RequestScope } from '../auth.ts'
import {
  publishRecordCreateSchema,
  publishRecordListQuerySchema,
  publishRecordPatchSchema,
  type PublishRecordCreateInput,
  type PublishRecordPatchInput,
} from '../contracts.ts'
import { failure } from '../errors.ts'
import type { Material, PublishRecord } from '../spec.ts'
import { ScopedRepository, validationFailure, type KvLike, type WriteObserver } from './base.ts'

/** The material facts a publish list needs, so a client never has to N+1. */
export interface MaterialSummary {
  readonly id: string
  readonly name: string
  readonly type: Material['type']
}

/** Reads a material in the caller's organization, or throws `NOT_FOUND`. */
export interface MaterialLookup {
  get(scope: RequestScope, id: string): MaterialSummary
}

/** A publish record together with the material it points at. */
export type PublishRecordWithMaterial = PublishRecord & { readonly material: MaterialSummary | null }

/** Fields a caller may supply when creating a publish record. */
export type PublishRecordInput = PublishRecordCreateInput

/** Fields a caller may change on a publish record. */
export type PublishRecordPatch = PublishRecordPatchInput

/** One page of publish records, newest first. */
export interface PublishRecordPage {
  readonly items: PublishRecordWithMaterial[]
}

/** What the publish repository needs from its owner. */
export interface PublishRecordRepositoryOptions {
  readonly table: KvLike<PublishRecord>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<PublishRecord>
  /** Confirms and describes the material a record points at. */
  readonly materials: MaterialLookup
}

/**
 * Publish records, scoped to the acting organization.
 *
 * A record starts as a draft and only carries `publishedAt` while its status is
 * `published`; leaving that status clears the stamp rather than leaving a
 * timestamp that contradicts the status. Nothing here talks to a platform, so
 * "published" means the operator recorded the publication, not that the app
 * performed it.
 *
 * Creating a record requires the material to exist in the caller's
 * organization. Without that check a record could point at a material the
 * organization cannot read — a dangling reference that only surfaces later, in
 * the list.
 */
export class PublishRecordRepository {
  private readonly base: ScopedRepository<PublishRecord>

  /**
   * @param options - Table, clock, id source, audit hook, and material lookup.
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
   * The caller's publish records with their material summaries, filtered.
   *
   * The summary rides on the page instead of a second request per row, which is
   * what would otherwise make the publish page an N+1 query.
   * @param scope - The acting scope.
   * @param rawQuery - `projectId` and `status`, as received.
   * @returns the page.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a bad filter.
   */
  query(scope: RequestScope, rawQuery: unknown = {}): PublishRecordPage {
    const parsed = publishRecordListQuerySchema.safeParse(rawQuery)
    if (!parsed.success) throw validationFailure(parsed.error)

    const { projectId, status } = parsed.data
    let records = this.base.list(scope)
    if (projectId !== undefined) records = records.filter(record => record.projectId === projectId)
    if (status !== undefined) records = records.filter(record => record.status === status)
    return {
      items: records.map(record => ({
        ...record,
        material: summarize(this.materialFor(scope, record.materialId)),
      })),
    }
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
   * @param input - The caller-supplied fields, unvalidated.
   * @returns the stored record.
   * @throws SilipowerFailure `NOT_FOUND` when the material is not the caller's,
   * or `VALIDATION_ERROR` for a body the contract rejects.
   */
  async create(scope: RequestScope, input: unknown): Promise<PublishRecord> {
    const parsed = publishRecordCreateSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const fields = parsed.data
    if (this.materialFor(scope, fields.materialId) === undefined) {
      // Also the cross-organization answer: a material the caller cannot read is
      // indistinguishable from one that does not exist.
      throw failure('NOT_FOUND', `material ${fields.materialId} not found`)
    }
    return this.base.create(scope, base => ({
      ...base,
      platform: fields.platform,
      materialId: fields.materialId,
      status: 'draft',
      ...(fields.accountId === undefined ? {} : { accountId: fields.accountId }),
      projectId: fields.projectId ?? base.projectId,
    }))
  }

  /**
   * Update a publish record, keeping `publishedAt` consistent with `status`.
   * @param scope - The acting scope.
   * @param id - The record id.
   * @param input - The fields to change, unvalidated.
   * @returns the stored record.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a bad body or a no-op patch.
   */
  async patch(scope: RequestScope, id: string, input: unknown): Promise<PublishRecord> {
    const parsed = publishRecordPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const changes = parsed.data
    if (Object.keys(changes).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    return this.base.patch(scope, id, (current) => {
      const status = changes.status ?? current.status
      const published = status === 'published'
      // The first publication is the fact worth keeping, so an existing stamp is
      // never restamped; leaving `published` drops it entirely.
      const publishedAt = published ? (current.publishedAt ?? this.options.now()) : undefined
      return {
        ...current,
        ...(changes.accountId === undefined ? {} : { accountId: changes.accountId }),
        status,
        publishedAt,
      }
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

  /**
   * Read a material for this record, treating "not mine" as "not there".
   * @param scope - The acting scope.
   * @param materialId - The material the record points at.
   * @returns the material, or `undefined` when it is missing or another organization's.
   */
  private materialFor(scope: RequestScope, materialId: string): MaterialSummary | undefined {
    try {
      return this.options.materials.get(scope, materialId)
    } catch {
      return undefined
    }
  }
}

/**
 * Reduce a material to the summary a publish list carries.
 * @param material - The material, or `undefined` when it could not be read.
 * @returns the summary, or `null` for a reference that no longer resolves.
 */
function summarize(material: MaterialSummary | undefined): MaterialSummary | null {
  if (material === undefined) return null
  return { id: material.id, name: material.name, type: material.type }
}
