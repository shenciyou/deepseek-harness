import type { AuditEvent } from './spec.ts'
import type { KvLike } from './repositories/base.ts'

/** What an audit entry describes. */
export interface AuditInput {
  readonly organizationId: string
  readonly actorId: string
  readonly resource: string
  readonly resourceId?: string
  readonly action: string
}

/** Sources the audit log needs from its owner. */
export interface AuditDeps {
  /** Monotonic id source. */
  readonly newId: () => string
  /** Current instant as an ISO timestamp. */
  readonly now: () => string
}

/**
 * Build one audit event.
 *
 * The event names the resource and the action and deliberately carries no
 * record body: an audit trail that duplicates user content into a second store
 * both leaks it and doubles the cost of a delete.
 * @param input - What happened.
 * @param deps - Id and clock sources.
 * @returns the event to persist.
 */
export function buildAuditEvent(input: AuditInput, deps: AuditDeps): AuditEvent {
  return {
    id: deps.newId(),
    organizationId: input.organizationId,
    actorId: input.actorId,
    resource: input.resource,
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    action: input.action,
    createdAt: deps.now(),
  }
}

/** Append-only writer for the `audit_events` table. */
export class AuditLog {
  /**
   * @param table - The `audit_events` table.
   * @param deps - Id and clock sources.
   */
  constructor(
    private readonly table: KvLike<AuditEvent>,
    private readonly deps: AuditDeps,
  ) {}

  /**
   * Append one event.
   * @param input - What happened.
   * @returns resolution after durability.
   */
  async write(input: AuditInput): Promise<void> {
    const event = buildAuditEvent(input, this.deps)
    await this.table.put(event.id, event)
  }
}
