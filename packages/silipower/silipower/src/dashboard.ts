import type { Material, OperationAccount, PublishRecord, WorkPlanTask } from './spec.ts'

/** The records a dashboard snapshot is computed from. */
export interface DashboardInput {
  readonly materials: readonly Material[]
  readonly publishRecords: readonly PublishRecord[]
  readonly accounts: readonly OperationAccount[]
  readonly tasks: readonly WorkPlanTask[]
}

/** One project's headline numbers. */
export interface DashboardSnapshot {
  readonly todayGenerated: number
  readonly pendingPublish: number
  readonly accounts: number
  readonly completedLast7Days: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Aggregate one project's headline numbers.
 *
 * Every number is counted from records the caller already scoped, so a snapshot
 * can never include another project's work. "Completed in the last seven days"
 * is measured from `updatedAt`: the domain does not store a separate completion
 * stamp, and `updatedAt` is written by the same status change that completes a
 * task.
 * @param input - The scoped records.
 * @param now - The instant to measure "today" and "last seven days" against.
 * @returns the snapshot.
 */
export function dashboardSnapshot(input: DashboardInput, now: Date): DashboardSnapshot {
  const today = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - 6 * DAY_MS).toISOString()
  return {
    todayGenerated: input.materials.filter(material => material.createdAt.slice(0, 10) === today).length,
    pendingPublish: input.publishRecords.filter(
      record => record.status === 'draft' || record.status === 'scheduled',
    ).length,
    accounts: input.accounts.length,
    completedLast7Days: input.tasks.filter(
      task => task.status === 'completed' && task.updatedAt >= since,
    ).length,
  }
}
