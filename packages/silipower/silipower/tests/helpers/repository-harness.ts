import type { AuditAction } from '../../src/repositories/base.ts'
import type { KvLike } from '../../src/repositories/base.ts'
import type { MaterialSummary } from '../../src/repositories/publish-record-repository.ts'
import { failure } from '../../src/errors.ts'
import type { RequestScope } from '../../src/auth.ts'
import type { AuditEvent, PublishRecord } from '../../src/spec.ts'

/** A recorded audit write, flattened for assertions. */
export interface RecordedWrite {
  readonly action: AuditAction
  readonly resource: string
  readonly id: string
  readonly organizationId: string
  readonly actorId: string
}

/**
 * Deterministic clock, id sequence, and an in-memory audit trail, so a
 * repository test can assert what was written without a Cordis host.
 * @returns the pieces a repository constructor needs, plus the recorded writes.
 */
export function repositoryHarness() {
  let ids = 0
  // The clock does NOT advance on its own: a test that wants two records with
  // the same updatedAt (to exercise the id tiebreak) needs the clock to hold
  // still, while a test that wants distinct timestamps calls tick() explicitly.
  let clock = 0
  const writes: RecordedWrite[] = []
  return {
    writes,
    now: (): string => new Date(Date.UTC(2026, 8, 21, 0, 0, clock)).toISOString(),
    newId: (): string => `id_${++ids}`,
    tick: (): void => {
      clock += 1
    },
    onWrite: async (
      action: AuditAction,
      resource: string,
      record: { id: string; organizationId: string },
      scope: RequestScope,
    ): Promise<void> => {
      writes.push({
        action,
        resource,
        id: record.id,
        organizationId: record.organizationId,
        actorId: scope.actorId,
      })
    },
  }
}

/** An in-memory audit sink that satisfies the `audit_events` table. */
export function auditTable(): KvLike<AuditEvent> {
  const store = new Map<string, AuditEvent>()
  return {
    get: key => store.get(key),
    entries: () => [...store.entries()][Symbol.iterator](),
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async key => store.delete(key),
  }
}

/** A material summary fixture; only the three fields a publish list carries. */
export function materialSummary(id: string, overrides: Partial<MaterialSummary> = {}): MaterialSummary {
  return { id, name: `material ${id}`, type: 'script', ...overrides }
}

/**
 * A material lookup that resolves exactly the given ids and answers `NOT_FOUND`
 * for everything else, which is what the real material repository does.
 * @param known - The materials this lookup can read.
 * @returns the port.
 */
export function materialLookup(known: readonly MaterialSummary[] = []) {
  return {
    get: (_scope: RequestScope, id: string): MaterialSummary => {
      const material = known.find(candidate => candidate.id === id)
      if (material === undefined) throw failure('NOT_FOUND', `material ${id} not found`)
      return material
    },
  }
}

/** Narrow a publish record for assertions that need the optional stamp. */
export type PublishRecordWithStamp = PublishRecord & { readonly publishedAt?: string }
