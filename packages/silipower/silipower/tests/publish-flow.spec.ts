import { describe, expect, it } from 'vitest'
import type { RequestScope } from '../src/auth.ts'
import { failure } from '../src/errors.ts'
import type { MaterialLookup, MaterialSummary } from '../src/repositories/publish-record-repository.ts'
import { PublishRecordRepository } from '../src/repositories/publish-record-repository.ts'
import { TASK_TRANSITIONS, TaskRepository } from '../src/repositories/task-repository.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { materialLookup, materialSummary, repositoryHarness } from './helpers/repository-harness.ts'

const scopeA = { organizationId: 'org_a', actorId: 'actor_a' }
const scopeB = { organizationId: 'org_b', actorId: 'actor_b' }

const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR' })
const invalidTransition = expect.objectContaining({ code: 'INVALID_TRANSITION' })
const notFound = expect.objectContaining({ code: 'NOT_FOUND' })

function tasks() {
  const h = repositoryHarness()
  return {
    h,
    repository: new TaskRepository({
      table: memoryTable(),
      now: h.now,
      newId: h.newId,
      onWrite: h.onWrite,
    }),
  }
}

function publish(materials = materialLookup([materialSummary('mat_1')])) {
  const h = repositoryHarness()
  return {
    h,
    repository: new PublishRecordRepository({
      table: memoryTable(),
      now: h.now,
      newId: h.newId,
      onWrite: h.onWrite,
      materials,
    }),
  }
}

/** A material lookup whose contents can change test-by-test, to model a delete. */
function mutableMaterials(ids: readonly string[]): { known: Set<string>; lookup: MaterialLookup } {
  const known = new Set(ids)
  return {
    known,
    lookup: {
      get: (_scope: RequestScope, id: string): MaterialSummary => {
        if (!known.has(id)) throw failure('NOT_FOUND', `material ${id} not found`)
        return materialSummary(id)
      },
    },
  }
}

describe('publish record requires a material the caller can read', () => {
  it('refuses to point at a material that does not exist', async () => {
    const { repository } = publish(materialLookup([]))
    await expect(
      repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_missing', projectId: null }),
    ).rejects.toThrowError(notFound)
    // The refused write must leave no record and no audit event behind.
    expect(repository.list(scopeA)).toHaveLength(0)
  })

  it('refuses a material that belongs to another organization', async () => {
    // The lookup answers by scope, so org_b cannot resolve org_a's material and
    // the failure is the same NOT_FOUND an absent id gets — no existence probe.
    const scoped: MaterialLookup = {
      get: (scope: RequestScope, id: string): MaterialSummary => {
        if (scope.organizationId !== 'org_a' || id !== 'mat_1') throw failure('NOT_FOUND', 'no such material')
        return materialSummary('mat_1')
      },
    }
    const { repository } = publish(scoped)

    await expect(
      repository.create(scopeB, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null }),
    ).rejects.toThrowError(notFound)
    await expect(
      repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null }),
    ).resolves.toMatchObject({ status: 'draft' })
  })

  it('rejects a create body that carries ownership fields', async () => {
    const { repository } = publish()
    await expect(
      repository.create(scopeA, { id: 'pr_1', platform: 'x', materialId: 'mat_1' }),
    ).rejects.toThrowError(validationError)
    await expect(
      repository.create(scopeA, { platform: 'x', materialId: 'mat_1', createdAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toThrowError(validationError)
  })
})

describe('publish record publishedAt follows status', () => {
  it('stamps on the first publication, keeps it, and drops it when leaving published', async () => {
    const { repository, h } = publish()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })
    expect(created).toMatchObject({ status: 'draft' })
    expect(created.publishedAt).toBeUndefined()

    const scheduled = await repository.patch(scopeA, created.id, { status: 'scheduled' })
    expect(scheduled.publishedAt).toBeUndefined()

    h.tick()
    const published = await repository.patch(scopeA, created.id, { status: 'published' })
    const stamp = published.publishedAt
    expect(stamp).toBeTruthy()

    // Re-pointing the account while still published must not restamp: the first
    // publication is the fact worth keeping.
    const again = await repository.patch(scopeA, created.id, { status: 'published', accountId: 'acct_2' })
    expect(again.accountId).toBe('acct_2')
    expect(again.publishedAt).toBe(stamp)

    const failed = await repository.patch(scopeA, created.id, { status: 'failed' })
    expect(failed.publishedAt).toBeUndefined()
  })

  it('keeps the current status when a patch does not name one', async () => {
    const { repository } = publish()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    const patched = await repository.patch(scopeA, created.id, { accountId: 'acct_1' })
    expect(patched).toMatchObject({ status: 'draft', accountId: 'acct_1' })
  })

  it('refuses a patch that changes nothing or carries an unknown field', async () => {
    const { repository } = publish()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    await expect(repository.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { materialId: 'mat_2' })).rejects.toThrowError(validationError)
  })
})

describe('publish list carries the material summary', () => {
  it('embeds the summary so the page needs no second request', async () => {
    const { repository } = publish()
    const created = await repository.create(scopeA, {
      platform: 'xiaohongshu',
      materialId: 'mat_1',
      accountId: 'acct_1',
      projectId: 'prj_1',
    })

    const page = repository.query(scopeA)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: created.id,
      accountId: 'acct_1',
      material: { id: 'mat_1', name: 'material mat_1', type: 'script' },
    })
  })

  it('answers null for a reference that no longer resolves', async () => {
    const materials = mutableMaterials(['mat_1'])
    const { repository } = publish(materials.lookup)
    await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    // The material is deleted after the record was written; the list must still
    // render, with an explicit null rather than a missing key or a crash.
    materials.known.delete('mat_1')
    expect(repository.query(scopeA).items[0]?.material).toBeNull()
  })

  it('filters by project and status', async () => {
    const { repository } = publish()
    const first = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: 'prj_1' })
    await repository.create(scopeA, { platform: 'douyin', materialId: 'mat_1', projectId: 'prj_2' })
    await repository.patch(scopeA, first.id, { status: 'published' })

    expect(repository.query(scopeA, { projectId: 'prj_1' }).items.map(record => record.id)).toEqual([first.id])
    expect(repository.query(scopeA, { status: 'published' }).items.map(record => record.id)).toEqual([first.id])
    expect(repository.query(scopeA, { projectId: 'prj_missing' }).items).toHaveLength(0)
    expect(repository.query(scopeA, { status: 'failed' }).items).toHaveLength(0)
  })

  it('refuses an unknown status filter instead of returning everything', async () => {
    const { repository } = publish()
    expect(() => repository.query(scopeA, { status: 'archived' })).toThrowError(validationError)
  })

  it('never lists another organization’s records', async () => {
    const { repository } = publish()
    await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })
    expect(repository.query(scopeB).items).toHaveLength(0)
  })
})

describe('task status machine', () => {
  it('moves pending to processing to completed', async () => {
    const { repository } = tasks()
    const created = await repository.create(scopeA, { name: '写一条口播稿', projectId: 'prj_1' })
    expect(created.status).toBe('pending')

    const processing = await repository.patch(scopeA, created.id, { status: 'processing' })
    expect(processing.status).toBe('processing')

    const completed = await repository.patch(scopeA, created.id, { status: 'completed' })
    expect(completed.status).toBe('completed')
  })

  it('refuses to move a completed task back to processing', async () => {
    const { repository } = tasks()
    const created = await repository.create(scopeA, { name: 't' })
    await repository.patch(scopeA, created.id, { status: 'processing' })
    await repository.patch(scopeA, created.id, { status: 'completed' })

    await expect(repository.patch(scopeA, created.id, { status: 'processing' })).rejects.toThrowError(invalidTransition)
    await expect(repository.patch(scopeA, created.id, { status: 'cancelled' })).rejects.toThrowError(invalidTransition)
    // The refused patch must not have moved it.
    expect(repository.get(scopeA, created.id).status).toBe('completed')
  })

  it('allows cancelling from either live state, and refuses skipping a step', async () => {
    const { repository } = tasks()
    const a = await repository.create(scopeA, { name: 'a' })
    const b = await repository.create(scopeA, { name: 'b' })
    await repository.patch(scopeA, b.id, { status: 'processing' })

    expect((await repository.patch(scopeA, a.id, { status: 'cancelled' })).status).toBe('cancelled')
    expect((await repository.patch(scopeA, b.id, { status: 'cancelled' })).status).toBe('cancelled')

    const skipped = await repository.create(scopeA, { name: 'c' })
    await expect(repository.patch(scopeA, skipped.id, { status: 'completed' })).rejects.toThrowError(invalidTransition)
  })

  it('treats completed and cancelled as terminal', async () => {
    expect(TASK_TRANSITIONS.completed).toEqual([])
    expect(TASK_TRANSITIONS.cancelled).toEqual([])

    const { repository } = tasks()
    const cancelled = await repository.create(scopeA, { name: 'x' })
    await repository.patch(scopeA, cancelled.id, { status: 'cancelled' })
    await expect(repository.patch(scopeA, cancelled.id, { status: 'processing' })).rejects.toThrowError(
      invalidTransition,
    )
  })

  it('keeps the status when a patch does not name one', async () => {
    const { repository } = tasks()
    const created = await repository.create(scopeA, { name: 't' })
    const patched = await repository.patch(scopeA, created.id, { name: 'renamed', relatedTopic: '选题' })
    expect(patched).toMatchObject({ name: 'renamed', relatedTopic: '选题', status: 'pending' })
  })

  it('rejects a body that carries ownership fields or changes nothing', async () => {
    const { repository } = tasks()
    await expect(repository.create(scopeA, { id: 'task_1', name: 'x' })).rejects.toThrowError(validationError)
    await expect(repository.create(scopeA, { name: '' })).rejects.toThrowError(validationError)

    const created = await repository.create(scopeA, { name: 't' })
    await expect(repository.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { id: 'task_other' })).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { status: 'archived' })).rejects.toThrowError(validationError)
  })

  it('stores the optional description, topic and material link', async () => {
    const { repository } = tasks()
    const created = await repository.create(scopeA, {
      name: 't',
      description: 'd',
      relatedTopic: '话题',
      materialId: 'mat_1',
      projectId: null,
    })
    expect(created).toMatchObject({ description: 'd', relatedTopic: '话题', materialId: 'mat_1', projectId: null })
  })

  it('filters by project and status', async () => {
    const { repository } = tasks()
    const inProject = await repository.create(scopeA, { name: 'a', projectId: 'prj_1' })
    const cancelled = await repository.create(scopeA, { name: 'b', projectId: 'prj_2' })
    await repository.patch(scopeA, cancelled.id, { status: 'cancelled' })

    expect(repository.query(scopeA, { projectId: 'prj_1' }).items.map(task => task.id)).toEqual([inProject.id])
    expect(repository.query(scopeA, { status: 'cancelled' }).items.map(task => task.id)).toEqual([cancelled.id])
    expect(repository.query(scopeA, { projectId: 'prj_missing' }).items).toHaveLength(0)
    expect(repository.query(scopeA, { status: 'processing' }).items).toHaveLength(0)
    expect(() => repository.query(scopeA, { status: 'archived' })).toThrowError(validationError)
  })

  it('answers 404 for another organization and deletes only what it owns', async () => {
    const { repository } = tasks()
    const created = await repository.create(scopeA, { name: 'a' })

    expect(() => repository.get(scopeB, created.id)).toThrowError(notFound)
    await expect(repository.patch(scopeB, created.id, { name: 'x' })).rejects.toThrowError(notFound)
    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(notFound)
    expect(repository.list(scopeB)).toHaveLength(0)

    await repository.remove(scopeA, created.id)
    expect(repository.list(scopeA)).toHaveLength(0)
  })
})

describe('publish record scoping', () => {
  it('answers 404 for another organization and deletes only what it owns', async () => {
    const { repository } = publish()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    expect(() => repository.get(scopeB, created.id)).toThrowError(notFound)
    await expect(repository.patch(scopeB, created.id, { status: 'published' })).rejects.toThrowError(notFound)
    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(notFound)

    await repository.remove(scopeA, created.id)
    expect(repository.list(scopeA)).toHaveLength(0)
  })
})
