import { describe, expect, it } from 'vitest'
import { AuditLog } from '../src/audit.ts'
import { MaterialRepository } from '../src/repositories/material-repository.ts'
import { ProjectRepository } from '../src/repositories/project-repository.ts'
import { PublishRecordRepository } from '../src/repositories/publish-record-repository.ts'
import { ScopedRepository, newestFirst, type OwnedRecord } from '../src/repositories/base.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { auditTable, repositoryHarness } from './helpers/repository-harness.ts'

const ORG_A = 'org_a'
const ORG_B = 'org_b'
const scopeA = { organizationId: ORG_A, actorId: 'actor_a' }
const scopeB = { organizationId: ORG_B, actorId: 'actor_b' }

function projectRepository() {
  const h = repositoryHarness()
  return {
    h,
    repository: new ProjectRepository({ table: memoryTable(), now: h.now, newId: h.newId, onWrite: h.onWrite }),
  }
}

function publishRepository() {
  const h = repositoryHarness()
  return {
    h,
    repository: new PublishRecordRepository({ table: memoryTable(), now: h.now, newId: h.newId, onWrite: h.onWrite }),
  }
}

function materialRepository() {
  const h = repositoryHarness()
  return {
    h,
    repository: new MaterialRepository({ table: memoryTable(), now: h.now, newId: h.newId, onWrite: h.onWrite }),
  }
}

function stub(id: string, updatedAt: string): OwnedRecord {
  return { id, organizationId: ORG_A, projectId: null, createdAt: updatedAt, updatedAt }
}

describe('newestFirst', () => {
  it('treats the same record as equal', () => {
    // Unreachable through a table, since the id is the key.
    expect(newestFirst(stub('a', 't1'), stub('a', 't1'))).toBe(0)
  })

  it('sorts a newer updatedAt first, in both argument orders', () => {
    expect(newestFirst(stub('a', 't2'), stub('a', 't1'))).toBe(-1)
    expect(newestFirst(stub('a', 't1'), stub('a', 't2'))).toBe(1)
  })

  it('breaks an updatedAt tie by descending id, in both argument orders', () => {
    expect(newestFirst(stub('b', 't1'), stub('a', 't1'))).toBe(-1)
    expect(newestFirst(stub('a', 't1'), stub('b', 't1'))).toBe(1)
  })
})

describe('ScopedRepository identity guard', () => {
  // The resource repositories validate their own inputs, so this guard can no
  // longer be reached through one of them. It is still the last line of defence
  // for the base class, so it gets pinned directly rather than left untested.
  function base() {
    const h = repositoryHarness()
    return {
      h,
      repository: new ScopedRepository<OwnedRecord>({
        resource: 'thing',
        table: memoryTable(),
        now: h.now,
        newId: h.newId,
        onWrite: h.onWrite,
      }),
    }
  }

  it('refuses a mutation that moves the record to another id', async () => {
    const { repository } = base()
    const created = await repository.create(scopeA, record => record)

    await expect(repository.patch(scopeA, created.id, current => ({ ...current, id: 'other' }))).rejects.toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
    expect(repository.get(scopeA, created.id).id).toBe(created.id)
  })

  it('refuses a mutation that moves the record to another organization', async () => {
    const { repository } = base()
    const created = await repository.create(scopeA, record => record)

    await expect(
      repository.patch(scopeA, created.id, current => ({ ...current, organizationId: ORG_B })),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
    expect(repository.get(scopeA, created.id).organizationId).toBe(ORG_A)
  })
})

describe('ProjectRepository CRUD', () => {
  it('reads, updates and deletes an owned project', async () => {
    const { repository } = projectRepository()
    const created = await repository.create(scopeA, { name: 'p', description: 'd', category: 'c' })

    expect(repository.get(scopeA, created.id).name).toBe('p')

    const patched = await repository.patch(scopeA, created.id, { name: 'renamed', status: 'archived' })
    expect(patched.name).toBe('renamed')
    expect(patched.status).toBe('archived')

    await repository.remove(scopeA, created.id)
    expect(repository.list(scopeA)).toHaveLength(0)
  })

  it('answers 404 when another organisation reads, patches or deletes', async () => {
    const { repository } = projectRepository()
    const created = await repository.create(scopeA, { name: 'p', description: 'd', category: 'c' })

    expect(() => repository.get(scopeB, created.id)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    await expect(repository.patch(scopeB, created.id, { name: 'x' })).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
  })

  it('rejects a project with a blank name', async () => {
    const { repository } = projectRepository()
    await expect(
      repository.create(scopeA, { name: '', description: 'd', category: 'c' }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })
})

describe('PublishRecordRepository CRUD', () => {
  it('lists and reads owned records', async () => {
    const { repository } = publishRepository()
    const created = await repository.create(scopeA, {
      platform: 'xiaohongshu',
      materialId: 'mat_1',
      accountId: 'acct_1',
      projectId: null,
    })
    expect(created.accountId).toBe('acct_1')
    expect(repository.list(scopeA).map(record => record.id)).toEqual([created.id])
    expect(repository.get(scopeA, created.id).id).toBe(created.id)
    expect(repository.list(scopeB)).toHaveLength(0)
  })

  it('re-points the account on patch and keeps an existing publishedAt', async () => {
    const { repository } = publishRepository()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    const published = await repository.patch(scopeA, created.id, { status: 'published' })
    const stamped = published.publishedAt
    expect(stamped).toBeTruthy()

    // Publishing again, or re-pointing the account, must not restamp: the
    // first publication is the fact worth keeping.
    const again = await repository.patch(scopeA, created.id, { status: 'published', accountId: 'acct_2' })
    expect(again.accountId).toBe('acct_2')
    expect(again.publishedAt).toBe(stamped)
  })

  it('keeps the current status when a patch does not name one', async () => {
    const { repository } = publishRepository()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    const patched = await repository.patch(scopeA, created.id, { accountId: 'acct_1' })
    expect(patched.status).toBe('draft')
    expect(patched.publishedAt).toBeUndefined()
  })

  it('deletes an owned record and answers 404 for another organisation', async () => {
    const { repository } = publishRepository()
    const created = await repository.create(scopeA, { platform: 'xiaohongshu', materialId: 'mat_1', projectId: null })

    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    await repository.remove(scopeA, created.id)
    expect(repository.list(scopeA)).toHaveLength(0)
  })

  it('rejects a record with no material to point at', async () => {
    const { repository } = publishRepository()
    await expect(
      repository.create(scopeA, { platform: 'xiaohongshu', materialId: '', projectId: null }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })
})

describe('MaterialRepository optional fields', () => {
  it('stores and updates category, content and url when the caller supplies them', async () => {
    const { repository } = materialRepository()
    const created = await repository.create(scopeA, {
      name: 'a',
      type: 'script',
      category: 'xhs',
      content: 'hello',
      url: 'https://example.com/a',
      projectId: null,
    })
    expect(created).toMatchObject({
      category: 'xhs',
      content: 'hello',
      url: 'https://example.com/a',
    })

    const patched = await repository.patch(scopeA, created.id, { category: 'douyin' })
    expect(patched.category).toBe('douyin')
    expect(patched.content).toBe('hello')
  })
})

describe('AuditLog optional fields', () => {
  it('omits resourceId when the action has no single record to name', async () => {
    const table = auditTable()
    const h = repositoryHarness()
    const log = new AuditLog(table, { newId: h.newId, now: h.now })

    await log.write({ organizationId: ORG_A, actorId: 'actor_a', resource: 'material', action: 'list' })

    const [event] = [...table.entries()].map(([, value]) => value)
    expect(event).not.toHaveProperty('resourceId')
    expect(event).toMatchObject({ action: 'list', resource: 'material' })
  })
})
