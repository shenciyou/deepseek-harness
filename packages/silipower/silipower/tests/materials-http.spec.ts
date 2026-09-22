import { describe, expect, it } from 'vitest'
import { MaterialRepository } from '../src/repositories/material-repository.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { repositoryHarness } from './helpers/repository-harness.ts'

const scopeA = { organizationId: 'org_a', actorId: 'actor_a', projectId: 'prj_1' }
const scopeB = { organizationId: 'org_b', actorId: 'actor_b', projectId: 'prj_1' }

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

const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR' })

describe('material writes reject server-owned fields', () => {
  it('refuses a create body that carries an id', async () => {
    const { repository } = materials()
    await expect(
      repository.create(scopeA, { id: 'mat_chosen', name: 'a', type: 'script' }),
    ).rejects.toThrowError(validationError)
    // A rejected body must not reach the table.
    expect(repository.list(scopeA)).toHaveLength(0)
  })

  it('refuses a create body that claims another organization', async () => {
    const { repository } = materials()
    await expect(
      repository.create(scopeA, { organizationId: 'org_z', name: 'a', type: 'script' }),
    ).rejects.toThrowError(validationError)
  })

  it('refuses a create body that sets a timestamp', async () => {
    const { repository } = materials()
    await expect(
      repository.create(scopeA, { createdAt: '2020-01-01T00:00:00.000Z', name: 'a', type: 'script' }),
    ).rejects.toThrowError(validationError)
  })

  it('refuses a patch body that carries an id and leaves the record untouched', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script' })

    await expect(repository.patch(scopeA, created.id, { id: 'mat_other' })).rejects.toThrowError(validationError)
    await expect(repository.patch(scopeA, created.id, { organizationId: 'org_z' })).rejects.toThrowError(validationError)
    expect(repository.get(scopeA, created.id)).toMatchObject({ id: created.id, name: 'a', organizationId: 'org_a' })
  })

  it('refuses a patch that changes nothing', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script' })
    await expect(repository.patch(scopeA, created.id, {})).rejects.toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR', message: 'patch must change at least one field' }),
    )
  })

  it('keeps every field the caller is allowed to change', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, {
      name: 'a',
      type: 'script',
      category: 'xhs',
      content: 'hello',
      url: 'https://example.com/a',
      projectId: null,
    })
    expect(created).toMatchObject({ category: 'xhs', content: 'hello', url: 'https://example.com/a' })

    const patched = await repository.patch(scopeA, created.id, {
      name: 'renamed',
      type: 'cover',
      category: 'douyin',
      content: 'world',
      url: 'https://example.com/b',
      projectId: 'prj_1',
    })
    expect(patched).toMatchObject({
      name: 'renamed',
      type: 'cover',
      category: 'douyin',
      content: 'world',
      url: 'https://example.com/b',
      projectId: 'prj_1',
    })
  })
})

describe('material scoping', () => {
  it('answers 404 when another organization deletes a material, and keeps it', async () => {
    const { repository } = materials()
    const created = await repository.create(scopeA, { name: 'a', type: 'script' })

    await expect(repository.remove(scopeB, created.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    expect(repository.get(scopeA, created.id).id).toBe(created.id)

    await repository.remove(scopeA, created.id)
    expect(repository.list(scopeA)).toHaveLength(0)
  })

  it('never lists another organization’s materials', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script' })

    expect(repository.query(scopeB).items).toHaveLength(0)
    expect(repository.query(scopeA).items).toHaveLength(1)
  })
})

describe('material list query', () => {
  it('returns every owned material when no limit is asked for', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script' })

    const page = repository.query(scopeA)
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeUndefined()
  })

  it('filters by projectId', async () => {
    const { repository } = materials()
    const inProject = await repository.create(scopeA, { name: 'a', type: 'script', projectId: 'prj_a' })
    await repository.create(scopeA, { name: 'b', type: 'script', projectId: 'prj_b' })
    // No projectId means organization-wide, which `prj_a` must not match.
    await repository.create(scopeA, { name: 'c', type: 'script', projectId: null })

    expect(repository.query(scopeA, { projectId: 'prj_a' }).items.map(material => material.id)).toEqual([inProject.id])
  })

  it('filters by type', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script' })
    const cover = await repository.create(scopeA, { name: 'b', type: 'cover' })

    expect(repository.query(scopeA, { type: 'cover' }).items.map(material => material.id)).toEqual([cover.id])
  })

  it('refuses an unknown type instead of returning everything', async () => {
    const { repository } = materials()
    expect(() => repository.query(scopeA, { type: 'podcast' })).toThrowError(validationError)
  })

  it('paginates newest first, and the last page has no cursor', async () => {
    const { repository } = materials()
    const first = await repository.create(scopeA, { name: 'a', type: 'script' })
    const second = await repository.create(scopeA, { name: 'b', type: 'script' })
    const third = await repository.create(scopeA, { name: 'c', type: 'script' })

    const pageOne = repository.query(scopeA, { limit: '2' })
    // Same timestamp, so the id tiebreak decides: descending id, newest first.
    expect(pageOne.items.map(material => material.id)).toEqual([third.id, second.id])
    expect(pageOne.nextCursor).toBeDefined()

    const pageTwo = repository.query(scopeA, { limit: '2', cursor: pageOne.nextCursor! })
    expect(pageTwo.items.map(material => material.id)).toEqual([first.id])
    expect(pageTwo.nextCursor).toBeUndefined()
  })

  it('refuses a cursor that does not point into this list', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script' })

    expect(() => repository.query(scopeA, { cursor: 'not-a-real-cursor' })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR', message: 'cursor does not point into this list' }),
    )
  })

  it('refuses a cursor from another organization’s page', async () => {
    const { repository } = materials()
    await repository.create(scopeA, { name: 'a', type: 'script' })
    // An {@link scopeB} actor cannot see org-a's material, so its id is simply absent.
    const foreign = Buffer.from('id_1', 'utf8').toString('base64url')

    expect(() => repository.query(scopeB, { cursor: foreign })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })

  it('refuses a page size outside the contract', async () => {
    const { repository } = materials()
    expect(() => repository.query(scopeA, { limit: '0' })).toThrowError(validationError)
    expect(() => repository.query(scopeA, { limit: '1000' })).toThrowError(validationError)
  })
})
