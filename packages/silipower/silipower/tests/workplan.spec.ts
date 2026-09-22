import { describe, expect, it } from 'vitest'
import { dashboardSnapshot } from '../src/dashboard.ts'
import { WorkplanRepository, weekRange, weekdayOf } from '../src/repositories/workplan-repository.ts'
import type { Material, OperationAccount, PublishRecord, WorkPlanTask } from '../src/spec.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { repositoryHarness } from './helpers/repository-harness.ts'

const scopeA = { organizationId: 'org_a', actorId: 'actor_a', projectId: 'prj_1' }
const otherProject = { ...scopeA, projectId: 'prj_2' }
const noProject = { organizationId: 'org_a', actorId: 'actor_a', projectId: null }

const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR' })
const notFound = expect.objectContaining({ code: 'NOT_FOUND' })

function workplan() {
  const h = repositoryHarness()
  return {
    h,
    repository: new WorkplanRepository({ table: memoryTable(), now: h.now, newId: h.newId, onWrite: h.onWrite }),
  }
}

describe('calendar helpers', () => {
  it('numbers Sunday as 7, not 0', () => {
    expect(weekdayOf('2026-09-21')).toBe(1)
    expect(weekdayOf('2026-09-27')).toBe(7)
  })

  it('ends the week on the following Sunday', () => {
    expect(weekRange('2026-09-21')).toEqual({ start: '2026-09-21', end: '2026-09-27' })
  })
})

describe('WorkplanRepository week reads', () => {
  it('returns Monday to Sunday only, never the next week', async () => {
    const { repository } = workplan()
    const monday = await repository.create(scopeA, { name: '周一', date: '2026-09-21' })
    const sunday = await repository.create(scopeA, { name: '周日', date: '2026-09-27' })
    const nextMonday = await repository.create(scopeA, { name: '下周一', date: '2026-09-28' })
    const before = await repository.create(scopeA, { name: '上周日', date: '2026-09-20' })

    const week = repository.listWeek(scopeA, { weekStart: '2026-09-21' })
    expect(week.map(task => task.id).sort()).toEqual([monday.id, sunday.id].sort())
    expect(week.map(task => task.id)).not.toContain(nextMonday.id)
    expect(week.map(task => task.id)).not.toContain(before.id)
    // Derived from the date, not trusted from the caller.
    expect(sunday.weekday).toBe(7)
  })

  it('refuses a week start that is not a Monday', async () => {
    const { repository } = workplan()
    expect(() => repository.listWeek(scopeA, { weekStart: '2026-09-22' })).toThrowError(validationError)
    expect(() => repository.listWeek(scopeA, { weekStart: '2026-09-20' })).toThrowError(validationError)
    expect(() => repository.listWeek(scopeA, {})).toThrowError(validationError)
    expect(() => repository.listWeek(scopeA, { weekStart: '2026/09/21' })).toThrowError(validationError)
  })

  it('never returns another project’s tasks', async () => {
    const { repository } = workplan()
    const created = await repository.create(scopeA, { name: '周一', date: '2026-09-21' })

    expect(repository.listWeek(otherProject, { weekStart: '2026-09-21' })).toHaveLength(0)
    expect(() => repository.get(otherProject, created.id)).toThrowError(notFound)
    await expect(repository.patch(otherProject, created.id, { status: 'completed' })).rejects.toThrowError(notFound)
    await expect(repository.remove(otherProject, created.id)).rejects.toThrowError(notFound)
    expect(repository.listWeek(scopeA, { weekStart: '2026-09-21' })).toHaveLength(1)
  })

  it('requires the acting project', async () => {
    const { repository } = workplan()
    expect(() => repository.all(noProject)).toThrowError(validationError)
    await expect(repository.create(noProject, { name: 'x', date: '2026-09-21' })).rejects.toThrowError(
      validationError,
    )
  })
})

describe('WorkplanRepository writes', () => {
  it('stores optional fields and starts pending', async () => {
    const { repository } = workplan()
    const created = await repository.create(scopeA, {
      name: '选题会',
      date: '2026-09-21',
      description: '确定方向',
      relatedTopic: '起号',
      platform: '抖音',
    })
    expect(created).toMatchObject({
      status: 'pending',
      weekday: 1,
      description: '确定方向',
      relatedTopic: '起号',
      platform: '抖音',
      projectId: 'prj_1',
    })

    const bare = await repository.create(scopeA, { name: '只有名字', date: '2026-09-22' })
    expect(bare.description).toBeUndefined()
    expect(bare.weekday).toBe(2)
  })

  it('flips a status and rejects malformed bodies', async () => {
    const { repository } = workplan()
    const created = await repository.create(scopeA, { name: 't', date: '2026-09-21' })

    const done = await repository.patch(scopeA, created.id, { status: 'completed' })
    expect(done.status).toBe('completed')

    await expect(repository.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { id: 'other' })).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { status: 'nope' })).rejects.toThrowError(validationError)
    await expect(repository.create(scopeA, { id: 't_1', name: 'x', date: '2026-09-21' })).rejects.toThrowError(
      validationError,
    )
    await expect(repository.create(scopeA, { name: 'x', date: '2026-9-1' })).rejects.toThrowError(validationError)

    await repository.remove(scopeA, created.id)
    expect(repository.all(scopeA)).toHaveLength(0)
  })
})

describe('dashboardSnapshot', () => {
  const base = { organizationId: 'org_a', projectId: 'prj_1', createdAt: '', updatedAt: '' }
  const now = new Date('2026-09-21T12:00:00.000Z')

  function material(createdAt: string): Material {
    return { ...base, id: createdAt, name: 'm', type: 'script', createdAt }
  }
  function record(status: PublishRecord['status']): PublishRecord {
    return { ...base, id: status, platform: 'douyin', materialId: 'mat_1', status }
  }
  function account(id: string): OperationAccount {
    return { ...base, id, accountName: 'a', platform: 'douyin' }
  }
  function task(id: string, status: WorkPlanTask['status'], updatedAt: string): WorkPlanTask {
    return { ...base, id, name: 't', date: '2026-09-21', weekday: 1, status, updatedAt }
  }

  it('counts only what belongs to the snapshot', () => {
    const snapshot = dashboardSnapshot(
      {
        materials: [material('2026-09-21T08:00:00.000Z'), material('2026-09-20T08:00:00.000Z')],
        publishRecords: [record('draft'), record('scheduled'), record('published'), record('failed')],
        accounts: [account('a1'), account('a2')],
        tasks: [
          task('t1', 'completed', '2026-09-21T09:00:00.000Z'),
          task('t2', 'completed', '2026-09-14T09:00:00.000Z'),
          task('t3', 'pending', '2026-09-21T09:00:00.000Z'),
        ],
      },
      now,
    )

    expect(snapshot).toEqual({
      todayGenerated: 1,
      pendingPublish: 2,
      accounts: 2,
      completedLast7Days: 1,
    })
  })

  it('answers zeros for an empty project', () => {
    expect(dashboardSnapshot({ materials: [], publishRecords: [], accounts: [], tasks: [] }, now)).toEqual({
      todayGenerated: 0,
      pendingPublish: 0,
      accounts: 0,
      completedLast7Days: 0,
    })
  })
})
