import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_NAME,
  ProjectContextRepository,
} from '../src/repositories/project-context-repository.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { repositoryHarness } from './helpers/repository-harness.ts'

const scopeA = { organizationId: 'org_a', actorId: 'actor_a', projectId: null }
const scopeB = { organizationId: 'org_b', actorId: 'actor_b', projectId: null }

const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR' })
const notFound = expect.objectContaining({ code: 'NOT_FOUND' })

function context() {
  const h = repositoryHarness()
  const shared = { now: h.now, newId: h.newId, onWrite: h.onWrite }
  return {
    h,
    repository: new ProjectContextRepository({
      company: { table: memoryTable(), ...shared },
      founder: { table: memoryTable(), ...shared },
      projects: { table: memoryTable(), ...shared },
    }),
  }
}

describe('project boundary', () => {
  it('keeps org-a projects out of org-b reads', async () => {
    const { repository } = context()
    const created = await repository.projects.create(scopeA, { name: 'org-a 项目' })

    expect(() => repository.projects.get(scopeB, created.id)).toThrowError(notFound)
    await expect(repository.projects.patch(scopeB, created.id, { name: 'hijacked' })).rejects.toThrowError(notFound)

    // org-b gets its own default project, never org-a's.
    const forB = await repository.listProjects(scopeB)
    expect(forB).toHaveLength(1)
    expect(forB[0]?.id).not.toBe(created.id)
    expect(repository.projects.get(scopeA, created.id).name).toBe('org-a 项目')
  })

  it('provisions exactly one default project per organization', async () => {
    const { repository } = context()

    const provisioned = await repository.ensureDefaultProject(scopeA)
    expect(provisioned).toMatchObject({ name: DEFAULT_PROJECT_NAME, status: 'active' })
    // Idempotent: the second call finds one and does nothing.
    expect(await repository.ensureDefaultProject(scopeA)).toBeUndefined()
    expect(repository.projects.list(scopeA)).toHaveLength(1)

    // A different organization is provisioned separately.
    expect(await repository.ensureDefaultProject(scopeB)).toMatchObject({ name: DEFAULT_PROJECT_NAME })
    expect(repository.projects.list(scopeB)).toHaveLength(1)
  })

  it('lists through the provisioning path', async () => {
    const { repository } = context()
    const created = await repository.projects.create(scopeA, { name: '项目一', description: 'd', category: 'c' })

    const projects = await repository.listProjects(scopeA)
    expect(projects.map(project => project.id)).toContain(created.id)
    expect(projects).toHaveLength(1)
  })

  it('fills description and category when the caller omits them', async () => {
    const { repository } = context()
    const created = await repository.projects.create(scopeA, { name: '只有名字' })
    expect(created).toMatchObject({ description: '', category: '', status: 'active' })
  })

  it('rejects a project body that carries server-owned or unknown fields', async () => {
    const { repository } = context()
    await expect(repository.projects.create(scopeA, { id: 'prj_chosen', name: 'p' })).rejects.toThrowError(
      validationError,
    )
    await expect(repository.projects.create(scopeA, { organizationId: 'org_z', name: 'p' })).rejects.toThrowError(
      validationError,
    )
    await expect(repository.projects.create(scopeA, { name: '' })).rejects.toThrowError(validationError)

    const created = await repository.projects.create(scopeA, { name: 'p' })
    await expect(repository.projects.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(repository.projects.patch(scopeA, created.id, { id: 'other' })).rejects.toThrowError(validationError)
  })

  it('updates a project name and status', async () => {
    const { repository } = context()
    const created = await repository.projects.create(scopeA, { name: 'p', description: 'd', category: 'c' })

    const patched = await repository.projects.patch(scopeA, created.id, { name: 'renamed', status: 'archived' })
    expect(patched).toMatchObject({ name: 'renamed', status: 'archived', description: 'd' })
  })
})

describe('company singleton', () => {
  it('answers undefined until the first edit, then upserts', async () => {
    const { repository } = context()
    expect(repository.company.get(scopeA)).toBeUndefined()

    const created = await repository.company.upsert(scopeA, { name: '示例科技', slogan: '口号' })
    expect(created).toMatchObject({
      name: '示例科技',
      slogan: '口号',
      description: '',
      businessScope: [],
      advantages: [],
      pricingInfo: '',
    })
    expect(repository.company.get(scopeA)?.id).toBe(created.id)

    const patched = await repository.company.upsert(scopeA, { description: '新简介' })
    expect(patched).toMatchObject({ id: created.id, name: '示例科技', description: '新简介' })
  })

  it('keeps each organization on its own profile', async () => {
    const { repository } = context()
    await repository.company.upsert(scopeA, { name: 'org-a 公司' })

    expect(repository.company.get(scopeB)).toBeUndefined()
    const forB = await repository.company.upsert(scopeB, { name: 'org-b 公司' })
    expect(forB.name).toBe('org-b 公司')
    expect(repository.company.get(scopeA)?.name).toBe('org-a 公司')
  })

  it('rejects an unknown field and an empty patch', async () => {
    const { repository } = context()
    await expect(repository.company.upsert(scopeA, { id: 'c_1' })).rejects.toThrowError(validationError)

    await repository.company.upsert(scopeA, { name: 'ok' })
    await expect(repository.company.upsert(scopeA, {})).rejects.toThrowError(validationError)
  })
})

describe('founder singleton', () => {
  it('answers undefined until the first edit, then upserts', async () => {
    const { repository } = context()
    expect(repository.founder.get(scopeA)).toBeUndefined()

    const created = await repository.founder.upsert(scopeA, { name: '张三', personaTags: ['实战派'] })
    expect(created).toMatchObject({
      name: '张三',
      personaTags: ['实战派'],
      resume: '',
      personalStory: '',
      goldenQuotes: [],
      speakingStyle: '',
    })

    const patched = await repository.founder.upsert(scopeA, { speakingStyle: '口语化' })
    expect(patched).toMatchObject({ id: created.id, name: '张三', speakingStyle: '口语化' })
  })

  it('rejects an unknown field and an empty patch', async () => {
    const { repository } = context()
    await expect(repository.founder.upsert(scopeA, { role: 'owner' })).rejects.toThrowError(validationError)

    await repository.founder.upsert(scopeA, { name: 'ok' })
    await expect(repository.founder.upsert(scopeA, {})).rejects.toThrowError(validationError)
  })
})
