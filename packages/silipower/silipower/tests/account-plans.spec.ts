import { describe, expect, it } from 'vitest'
import { AccountRepository } from '../src/repositories/account-repository.ts'
import { AccountPlanRepository } from '../src/repositories/account-plan-repository.ts'
import { CompetitorRepository } from '../src/repositories/competitor-repository.ts'
import { memoryTable } from './helpers/memory-table.ts'
import { repositoryHarness } from './helpers/repository-harness.ts'

const scopeA = { organizationId: 'org_a', actorId: 'actor_a', projectId: 'prj_1' }
const otherProject = { ...scopeA, projectId: 'prj_2' }
/** Same project id, different organization: the organization boundary must still win. */
const scopeB = { organizationId: 'org_b', actorId: 'actor_b', projectId: 'prj_1' }
const noProject = { organizationId: 'org_a', actorId: 'actor_a', projectId: null }

const validationError = expect.objectContaining({ code: 'VALIDATION_ERROR' })
const notFound = expect.objectContaining({ code: 'NOT_FOUND' })

function harness() {
  const h = repositoryHarness()
  const shared = { now: h.now, newId: h.newId, onWrite: h.onWrite }
  return {
    h,
    accounts: new AccountRepository({ table: memoryTable(), ...shared }),
    competitors: new CompetitorRepository({ table: memoryTable(), ...shared }),
    plans: new AccountPlanRepository({ table: memoryTable(), ...shared }),
  }
}

describe('project scope is required', () => {
  it('refuses a read or write that named no project', async () => {
    const { accounts, competitors, plans } = harness()

    expect(() => accounts.list(noProject)).toThrowError(validationError)
    expect(() => competitors.list(noProject)).toThrowError(validationError)
    expect(() => plans.list(noProject)).toThrowError(validationError)
    await expect(accounts.create(noProject, { accountName: 'a', platform: 'douyin' })).rejects.toThrowError(
      validationError,
    )
  })
})

describe('AccountRepository', () => {
  it('keeps accounts inside their project', async () => {
    const { accounts } = harness()
    const created = await accounts.create(scopeA, {
      accountName: '主账号',
      platform: 'douyin',
      accountUrl: 'https://example.com/a',
    })
    expect(created).toMatchObject({ projectId: 'prj_1', accountUrl: 'https://example.com/a' })

    expect(accounts.list(scopeA).map(account => account.id)).toEqual([created.id])
    expect(accounts.list(otherProject)).toHaveLength(0)
    expect(() => accounts.get(otherProject, created.id)).toThrowError(notFound)
    await expect(accounts.patch(otherProject, created.id, { accountName: 'x' })).rejects.toThrowError(notFound)
    await expect(accounts.remove(otherProject, created.id)).rejects.toThrowError(notFound)
    expect(accounts.list(scopeA)).toHaveLength(1)
  })

  it('keeps organizations apart even in the same project id', async () => {
    const { accounts } = harness()
    const created = await accounts.create(scopeA, { accountName: 'org-a 账号', platform: 'douyin' })
    expect(accounts.list(scopeB)).toHaveLength(0)
    expect(() => accounts.get(scopeB, created.id)).toThrowError(notFound)
  })

  it('rejects bodies carrying server-owned fields and empty patches', async () => {
    const { accounts } = harness()
    await expect(
      accounts.create(scopeA, { id: 'acct_1', accountName: 'a', platform: 'douyin' }),
    ).rejects.toThrowError(validationError)
    await expect(accounts.create(scopeA, { accountName: '', platform: 'douyin' })).rejects.toThrowError(
      validationError,
    )

    const created = await accounts.create(scopeA, { accountName: 'a', platform: 'douyin' })
    await expect(accounts.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(accounts.patch(scopeA, created.id, { id: 'other' })).rejects.toThrowError(validationError)

    const patched = await accounts.patch(scopeA, created.id, { platform: 'xiaohongshu' })
    expect(patched).toMatchObject({ accountName: 'a', platform: 'xiaohongshu' })
  })
})

describe('CompetitorRepository', () => {
  it('fills the defaults and marks the source as user-entered', async () => {
    const { competitors } = harness()
    const created = await competitors.create(scopeA, { accountName: '竞品一号' })
    expect(created).toMatchObject({
      accountName: '竞品一号',
      latestWork: '',
      dataTrend: 'flat',
      followers: 0,
      source: 'user',
      projectId: 'prj_1',
    })
  })

  it('keeps competitors inside their project and rejects bad numbers', async () => {
    const { competitors } = harness()
    const created = await competitors.create(scopeA, {
      accountName: '竞品二号',
      latestWork: '最新一期',
      dataTrend: 'up',
      followers: 1200,
    })
    expect(created).toMatchObject({ dataTrend: 'up', followers: 1200 })

    expect(competitors.list(otherProject)).toHaveLength(0)
    expect(() => competitors.get(otherProject, created.id)).toThrowError(notFound)
    await expect(competitors.patch(otherProject, created.id, { followers: 1 })).rejects.toThrowError(notFound)

    await expect(competitors.create(scopeA, { accountName: 'x', followers: -1 })).rejects.toThrowError(
      validationError,
    )
    await expect(competitors.create(scopeA, { accountName: 'x', dataTrend: 'sideways' })).rejects.toThrowError(
      validationError,
    )

    const patched = await competitors.patch(scopeA, created.id, { followers: 1300 })
    expect(patched.followers).toBe(1300)
    await expect(competitors.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
    await expect(competitors.patch(scopeA, created.id, { id: 'other' })).rejects.toThrowError(validationError)
    await competitors.remove(scopeA, created.id)
    expect(competitors.list(scopeA)).toHaveLength(0)
  })
})

describe('AccountPlanRepository', () => {
  const planInput = {
    name: '美食账号起号方案',
    track: 'food',
    platforms: ['douyin', 'xiaohongshu'],
    audience: '25-35 岁都市女性',
    accountType: 'personal',
    content: '## 定位\n干货型美食账号',
  }

  it('saves an extra tracking field, plan id and generation run', async () => {
    const { plans } = harness()
    const created = await plans.create(scopeA, { ...planInput, generationRunId: 'run_1' })
    expect(created).toMatchObject({ ...planInput, generationRunId: 'run_1', projectId: 'prj_1' })
    expect(plans.list(scopeA).map(plan => plan.id)).toEqual([created.id])
  })

  it('leaves the run id off when the caller has none, and never patches it', async () => {
    const { plans } = harness()
    const created = await plans.create(scopeA, planInput)
    expect(created).not.toHaveProperty('generationRunId')

    // Audience is optional too; it defaults to an empty string.
    const withoutAudience = await plans.create(scopeA, {
      name: '无人群方案',
      track: 'food',
      platforms: ['douyin'],
      accountType: 'personal',
      content: '内容',
    })
    expect(withoutAudience.audience).toBe('')

    await expect(plans.patch(scopeA, created.id, { generationRunId: 'run_9' })).rejects.toThrowError(
      validationError,
    )
    const patched = await plans.patch(scopeA, created.id, { name: '改名后的方案', audience: '新人群' })
    expect(patched).toMatchObject({ name: '改名后的方案', audience: '新人群', track: 'food' })
  })

  it('keeps plans inside their project', async () => {
    const { plans } = harness()
    const created = await plans.create(scopeA, planInput)

    expect(plans.list(otherProject)).toHaveLength(0)
    expect(plans.list(scopeB)).toHaveLength(0)
    expect(() => plans.get(otherProject, created.id)).toThrowError(notFound)
    await expect(plans.patch(otherProject, created.id, { name: 'x' })).rejects.toThrowError(notFound)
    await expect(plans.remove(otherProject, created.id)).rejects.toThrowError(notFound)

    await plans.remove(scopeA, created.id)
    expect(plans.list(scopeA)).toHaveLength(0)
  })

  it('rejects an empty platform list and an empty patch', async () => {
    const { plans } = harness()
    await expect(plans.create(scopeA, { ...planInput, platforms: [] })).rejects.toThrowError(validationError)
    await expect(plans.create(scopeA, { ...planInput, id: 'plan_1' })).rejects.toThrowError(validationError)

    const created = await plans.create(scopeA, planInput)
    await expect(plans.patch(scopeA, created.id, {})).rejects.toThrowError(validationError)
  })
})
