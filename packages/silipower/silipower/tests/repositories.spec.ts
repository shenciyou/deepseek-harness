import { describe, expect, it } from 'vitest'
import { MaterialRepository } from '../src/repositories/material-repository.ts'
import { ProjectRepository } from '../src/repositories/project-repository.ts'
import { PublishRecordRepository } from '../src/repositories/publish-record-repository.ts'
import { AuditLog } from '../src/audit.ts'
import { materialSchema } from '../src/spec.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { auditTable, materialLookup, materialSummary, repositoryHarness } from './helpers/repository-harness.ts'

const ORG_A = 'org_a'
const ORG_B = 'org_b'

const scopeA = { organizationId: ORG_A, actorId: 'actor_a' }
const scopeB = { organizationId: ORG_B, actorId: 'actor_b' }

function materials() {
  const h = repositoryHarness()
  return {
    h,
    repository: new MaterialRepository({
      table: memoryTable(),
      now: h.now,
      newId: h.newId,
      onWrite: h.onWrite,
    }),
  }
}

describe('ScopedRepository organisation boundary', () => {
  it('keeps org-a material out of org-b listings', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })

    expect(repository.list(scopeA)).toHaveLength(1)
    expect(repository.list(scopeB)).toHaveLength(0)
  })

  it('answers 404 for a cross-organisation get', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })

    expect(() => repository.get(scopeB, created.id)).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    expect(repository.get(scopeA, created.id).id).toBe(created.id)
  })

  it('answers 404 for a cross-organisation patch and leaves the record untouched', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })

    await expect(repository.patch(scopeB, created.id, { name: 'hijacked' })).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    expect(repository.get(scopeA, created.id).name).toBe('a')
  })

  it('answers 404 for a cross-organisation remove and leaves the record present', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })

    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    expect(repository.list(scopeA)).toHaveLength(1)
  })

  it('answers 404 for an unknown id', () => {
    const { repository } = materials()
    expect(() => repository.get(scopeA, 'nope')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
  })
})

describe('ScopedRepository ordering', () => {
  it('lists newest first, breaking ties by descending id', async () => {
    const { repository } = materials()
    const first = await repository.create(scopeA, { name: 'first', type: 'script', projectId: null })
    const second = await repository.create(scopeA, { name: 'second', type: 'script', projectId: null })
    // The harness clock holds still, so both share updatedAt and the id
    // tiebreak alone decides: id_2 before id_1.
    expect(repository.list(scopeA).map(material => material.id)).toEqual([second.id, first.id])
  })

  it('orders by updatedAt ahead of the id tiebreak', async () => {
    const { repository, h } = materials()
    const older = await repository.create(scopeA, { name: 'older', type: 'script', projectId: null })
    h.tick()
    const newer = await repository.create(scopeA, { name: 'newer', type: 'script', projectId: null })
    h.tick()
    await repository.patch(scopeA, older.id, { name: 'touched' })

    // `older` now carries the newest updatedAt although its id sorts last, so
    // updatedAt has to win — an implementation that sorted by id would answer
    // the reverse order and still pass the tie test above.
    expect(repository.list(scopeA).map(material => material.id)).toEqual([older.id, newer.id])
  })
})

describe('ScopedRepository validation and ownership fields', () => {
  it('rejects a write whose scope has no organisation', async () => {
    const { repository } = materials()
    await expect(
      repository.create({ organizationId: '', actorId: 'actor_a' }, { name: 'a', type: 'script', projectId: null }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })

  it('refuses to let a patch move a record between organisations', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })
    await expect(
      repository.patch(scopeA, created.id, { organizationId: ORG_B } as never),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })

  it('stamps ownership and timestamps the caller may not supply', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })
    expect(created.organizationId).toBe(ORG_A)
    expect(created.id).toBeTruthy()
    expect(materialSchema.safeParse(created).success).toBe(true)
  })

  it('refuses a material whose type is not a known material type', async () => {
    const { repository } = materials()
    await expect(
      repository.create(scopeA, { name: 'a', type: 'nope' as never, projectId: null }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })
})

describe('audit trail', () => {
  it('records one event per write with the acting organisation and actor', async () => {
    const { repository, h } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script', projectId: null })
    await repository.patch(scopeA, created.id, { name: 'b' })
    await repository.remove(scopeA, created.id)

    expect(h.writes).toEqual([
      { action: 'create', resource: 'material', id: created.id, organizationId: ORG_A, actorId: 'actor_a' },
      { action: 'patch', resource: 'material', id: created.id, organizationId: ORG_A, actorId: 'actor_a' },
      { action: 'remove', resource: 'material', id: created.id, organizationId: ORG_A, actorId: 'actor_a' },
    ])
  })

  it('records nothing for a rejected write', async () => {
    const { repository, h } = materials()
    await expect(
      repository.create(scopeA, { name: 'a', type: 'nope' as never, projectId: null }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
    expect(h.writes).toEqual([])
  })

  it('writes an audit event that names the resource without the record body', async () => {
    const table = auditTable()
    const h = repositoryHarness()
    const log = new AuditLog(table, { newId: h.newId, now: h.now })

    await log.write({
      organizationId: ORG_A,
      actorId: 'actor_a',
      resource: 'material',
      resourceId: 'mat_1',
      action: 'create',
    })

    const [event] = [...table.entries()].map(([, value]) => value)
    expect(event).toMatchObject({
      organizationId: ORG_A,
      actorId: 'actor_a',
      resource: 'material',
      resourceId: 'mat_1',
      action: 'create',
      createdAt: '2026-09-21T00:00:00.000Z',
    })
    // The event names the record; it must not carry its content.
    expect(JSON.stringify(event)).not.toContain('content')
  })
})

describe('PublishRecordRepository', () => {
  function records() {
    const h = repositoryHarness()
    return {
      h,
      repository: new PublishRecordRepository({
        table: memoryTable(),
        now: h.now,
        newId: h.newId,
        onWrite: h.onWrite,
        materials: materialLookup([materialSummary('mat_1')]),
      }),
    }
  }

  it('refers to a material and starts as a draft without publishedAt', async () => {
    const { repository } = records()
    const created = await repository.create(scopeA, {
      platform: 'xiaohongshu',
      materialId: 'mat_1',
      projectId: null,
    })
    expect(created.status).toBe('draft')
    expect(created.publishedAt).toBeUndefined()
    expect(created.materialId).toBe('mat_1')
  })

  it('stamps publishedAt only while the status is published', async () => {
    const { repository } = records()
    const created = await repository.create(scopeA, {
      platform: 'xiaohongshu',
      materialId: 'mat_1',
      projectId: null,
    })

    const scheduled = await repository.patch(scopeA, created.id, { status: 'scheduled' })
    expect(scheduled.publishedAt).toBeUndefined()

    const published = await repository.patch(scopeA, created.id, { status: 'published' })
    expect(published.publishedAt).toBeTruthy()

    // Leaving `published` clears the stamp rather than leaving a timestamp
    // that contradicts the status.
    const failed = await repository.patch(scopeA, created.id, { status: 'failed' })
    expect(failed.publishedAt).toBeUndefined()
  })
})

describe('ProjectRepository', () => {
  it('scopes projects to the owning organisation', async () => {
    const h = repositoryHarness()
    const repository = new ProjectRepository({
      table: memoryTable(),
      now: h.now,
      newId: h.newId,
      onWrite: h.onWrite,
    })
    const created = await repository.create(scopeA, { name: 'p', description: 'd', category: 'c' })
    expect(created.status).toBe('active')
    expect(repository.list(scopeB)).toHaveLength(0)
    expect(repository.list(scopeA).map(project => project.id)).toEqual([created.id])
  })
})
