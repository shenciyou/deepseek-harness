import { describe, expect, it } from 'vitest'
import {
  CURRENT_DOMAIN_VERSION,
  DEMO_ORGANIZATION_ID,
  DEMO_PROJECT_ID,
  materialSchema,
  migrateV0Material,
  publishRecordSchema,
  silipowerDomainSpec,
  workPlanTaskSchema,
} from '../src/spec.ts'

/**
 * The stored version-0 material, copied verbatim from the development database
 * (`u_silipower_materials` in server/.dsh/silipower.sqlite) before the domain
 * moved to version 1. Using the real record keeps the migration honest: it has
 * a numeric `createdAt` and none of the ownership fields.
 */
const STORED_V0_MATERIAL = {
  id: 'm1',
  name: '测试素材',
  type: 'script',
  category: 'xhs',
  content: 'hello',
  createdAt: 1700000000000,
} as const

describe('domain version', () => {
  it('declares version 1', () => {
    expect(CURRENT_DOMAIN_VERSION).toBe(1)
    expect(silipowerDomainSpec.version).toBe(1)
  })

  it('does not claim compatibility with version 0', () => {
    // The ownership fields are mandatory, so version-0 records cannot satisfy
    // the version-1 schemas. Listing 0 in compatibleVersions would promise a
    // read that then fails as `invalid-record`, so the domain instead lets the
    // backend reject the stale unit with `version-mismatch`.
    //
    // Asserted with `in` rather than property access: the spec's literal type
    // does not declare the field, so reading it would itself be a type error.
    expect('compatibleVersions' in silipowerDomainSpec).toBe(false)
  })

  it('declares every table the roadmap needs', () => {
    expect(Object.keys(silipowerDomainSpec.tables).sort()).toEqual([
      'account_plans',
      'audit_events',
      'companies',
      'competitors',
      'content_metrics',
      'content_tasks',
      'founders',
      'generation_runs',
      'geo_leads',
      'materials',
      'members',
      'operation_accounts',
      'organizations',
      'projects',
      'publish_records',
      'workplan_tasks',
    ])
  })
})

describe('materialSchema', () => {
  it('requires organizationId for a material', () => {
    expect(
      materialSchema.safeParse({ id: 'm1', name: 'x', type: 'script', createdAt: Date.now() }).success,
    ).toBe(false)
  })

  it('accepts a fully owned material with ISO timestamps', () => {
    expect(
      materialSchema.safeParse({
        id: 'm1',
        name: 'x',
        type: 'script',
        organizationId: 'org_1',
        projectId: 'prj_1',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('allows an organization-wide material without a project', () => {
    expect(
      materialSchema.safeParse({
        id: 'm1',
        name: 'x',
        type: 'script',
        organizationId: 'org_1',
        projectId: null,
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })
})

describe('workPlanTaskSchema', () => {
  it('rejects invalid ISO weekday', () => {
    expect(
      workPlanTaskSchema.safeParse({
        id: 'w1',
        organizationId: 'o1',
        projectId: 'p1',
        name: 'x',
        date: '2026-09-21',
        weekday: 8,
        status: 'pending',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('accepts a weekday between 1 and 7', () => {
    expect(
      workPlanTaskSchema.safeParse({
        id: 'w1',
        organizationId: 'o1',
        projectId: 'p1',
        name: 'x',
        date: '2026-09-21',
        weekday: 1,
        status: 'pending',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-21T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })
})

describe('publishRecordSchema', () => {
  it('refers to a material instead of a stranded name', () => {
    const base = {
      id: 'p1',
      organizationId: 'o1',
      projectId: 'p1',
      platform: 'xiaohongshu',
      materialId: 'm1',
      status: 'draft',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    }
    expect(publishRecordSchema.safeParse(base).success).toBe(true)
    expect(publishRecordSchema.safeParse({ ...base, materialId: undefined }).success).toBe(false)
  })

  it('accepts a published record with publishedAt and a draft without it', () => {
    const record = {
      id: 'p1',
      organizationId: 'o1',
      projectId: 'p1',
      platform: 'xiaohongshu',
      materialId: 'm1',
      status: 'published',
      publishedAt: '2026-09-22T00:00:00.000Z',
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    }
    expect(publishRecordSchema.safeParse(record).success).toBe(true)
    expect(publishRecordSchema.safeParse({ ...record, status: 'draft', publishedAt: undefined }).success).toBe(true)
  })
})

describe('migrateV0Material', () => {
  it('maps the stored version-0 material onto the demo organization and project', () => {
    const migrated = migrateV0Material(STORED_V0_MATERIAL)
    expect(migrated).toEqual({
      id: 'm1',
      name: '测试素材',
      type: 'script',
      category: 'xhs',
      content: 'hello',
      organizationId: DEMO_ORGANIZATION_ID,
      projectId: DEMO_PROJECT_ID,
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:13:20.000Z',
    })
    expect(materialSchema.safeParse(migrated).success).toBe(true)
  })

  it('omits optional fields the version-0 record never had', () => {
    const migrated = migrateV0Material({ id: 'm2', name: 'n', type: 'cover', createdAt: 0 })
    expect(migrated.category).toBeUndefined()
    expect(migrated.content).toBeUndefined()
    expect(migrated.url).toBeUndefined()
    expect(materialSchema.safeParse(migrated).success).toBe(true)
  })

  it('carries a stored url through the migration', () => {
    const migrated = migrateV0Material({
      id: 'm3',
      name: 'n',
      type: 'video',
      url: 'https://example.com/v.mp4',
      createdAt: 1700000000000,
    })
    expect(migrated.url).toBe('https://example.com/v.mp4')
    expect(materialSchema.safeParse(migrated).success).toBe(true)
  })

  it('refuses a record that is not a version-0 material', () => {
    // The migration invents an owner, so it must not invent one for a record
    // it cannot even recognise: a malformed input fails loudly here instead of
    // being written back as a plausible-looking version 1 row.
    expect(() =>
      migrateV0Material({ id: '', name: 'n', type: 'script', createdAt: 0 }),
    ).toThrow()
    expect(() =>
      migrateV0Material({ id: 'm4', name: 'n', type: 'nope', createdAt: 0 } as never),
    ).toThrow()
  })
})
