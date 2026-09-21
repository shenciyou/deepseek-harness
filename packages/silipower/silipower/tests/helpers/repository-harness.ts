import type { AuditAction } from '../../src/repositories/base.ts'
import type { KvLike } from '../../src/repositories/base.ts'
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

/** Narrow a publish record for assertions that need the optional stamp. */
export type PublishRecordWithStamp = PublishRecord & { readonly publishedAt?: string }
