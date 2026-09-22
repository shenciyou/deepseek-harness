import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  dataTrendSchema,
  generateFunctionTypeSchema,
  materialTypeSchema,
  projectStatusSchema,
  publishStatusSchema,
  taskStatusSchema,
} from './contracts.ts'

/**
 * Silipower durable domain, version 1.
 *
 * Version 1 introduces ownership: every business record carries an
 * `organizationId`, a nullable `projectId`, and ISO `createdAt`/`updatedAt`
 * stamps. Version 0 stored bare records with numeric epoch timestamps and no
 * owner, which is why the domain declares no `compatibleVersions` — the current
 * schemas cannot accept a version 0 record, so promising that read would only
 * turn a `version-mismatch` into an `invalid-record`. A stale unit is meant to
 * be migrated out of band by `migrateV0Material` before the host opens it.
 */
export const CURRENT_DOMAIN_VERSION = 1

/** Organization the development-only migration files unowned records under. */
export const DEMO_ORGANIZATION_ID = 'demo-org'

/** Project the development-only migration files unowned records under. */
export const DEMO_PROJECT_ID = 'demo-project'

const nonEmptyId = z.string().min(1)
const isoTimestamp = z.string().datetime()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Ownership fields every tenant-scoped record carries. Spread into each
 * `z.object` below; `projectId` is null for organization-wide records.
 */
const ownershipFields = {
  organizationId: nonEmptyId,
  projectId: nonEmptyId.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}

/** Who a member is and what they may do. */
export const memberRoleSchema = z.enum(['owner', 'operator', 'viewer', 'platform_admin'])

/** How a record came to exist, which decides whether a user may edit it. */
export const dataSourceSchema = z.enum(['mock', 'user', 'openapi'])

/** The tenant root. Carries no `organizationId` because it is the organization. */
export const organizationSchema = z.object({
  id: nonEmptyId,
  name: z.string().min(1),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})

/** A person allowed into one organization, with exactly one role. */
export const memberSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  userId: nonEmptyId,
  displayName: z.string(),
  role: memberRoleSchema,
})

/** The organization's company profile; one record per organization. */
export const companySchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  description: z.string(),
  businessScope: z.array(z.string()),
  advantages: z.array(z.string()),
  slogan: z.string(),
  pricingInfo: z.string(),
})

/** The founder persona the account plans are written against. */
export const founderSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  resume: z.string(),
  personaTags: z.array(z.string()),
  personalStory: z.string(),
  goldenQuotes: z.array(z.string()),
  speakingStyle: z.string(),
})

/** A project is the data boundary content is produced inside. */
export const projectSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  description: z.string(),
  category: z.string(),
  status: projectStatusSchema,
})

/** A reusable asset: a script, a cover, a tag set, or media. */
export const materialSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string(),
  type: materialTypeSchema,
  category: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
})

/**
 * A publish record.
 *
 * Version 1 refers to the published material by `materialId` instead of the
 * version 0 `materialName` string, so renaming a material cannot orphan the
 * record. `publishedAt` is written only once the status reaches `published`;
 * the transition rules live in the publish repository.
 */
export const publishRecordSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  platform: z.string().min(1),
  materialId: nonEmptyId,
  accountId: nonEmptyId.optional(),
  status: publishStatusSchema,
  publishedAt: isoTimestamp.optional(),
})

/** A publish record. */
export type PublishRecord = z.infer<typeof publishRecordSchema>

/** A unit of content work that may produce a material and a publish record. */
export const contentTaskSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  status: taskStatusSchema,
  description: z.string().optional(),
  relatedTopic: z.string().optional(),
  materialId: nonEmptyId.optional(),
})

/** An account the organization operates. */
export const operationAccountSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  accountName: z.string().min(1),
  platform: z.string().min(1),
  accountUrl: z.string().optional(),
})

/** An account the organization watches. */
export const competitorSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  accountName: z.string().min(1),
  latestWork: z.string(),
  dataTrend: dataTrendSchema,
  followers: z.number().int().nonnegative(),
  source: dataSourceSchema,
})

/** A saved account-startup plan, optionally traceable to the run that wrote it. */
export const accountPlanSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  track: z.string(),
  platforms: z.array(z.string()),
  audience: z.string(),
  accountType: z.string(),
  content: z.string(),
  generationRunId: nonEmptyId.optional(),
})

/**
 * One planned task on one calendar day. `date` is a local calendar date and
 * `weekday` is ISO (1 = Monday, 7 = Sunday) so a week can be queried without
 * parsing the date.
 */
export const workPlanTaskSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  name: z.string().min(1),
  date: isoDate,
  weekday: z.number().int().min(1).max(7),
  status: taskStatusSchema,
  description: z.string().optional(),
  relatedTopic: z.string().optional(),
  platform: z.string().optional(),
})

/**
 * One platform's numbers for one published work on one day. Entered by hand
 * until a platform API exists; `completedViews` is the completion-rate
 * numerator, and a record with zero plays is excluded from that rate.
 */
export const contentMetricSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  publishRecordId: nonEmptyId,
  title: z.string().min(1),
  platform: z.string().min(1),
  statDate: isoDate,
  plays: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  completedViews: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative(),
  source: dataSourceSchema,
})

/** A local business lead for GEO outreach. */
export const geoLeadSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  companyName: z.string().min(1),
  city: z.string().min(1),
  industry: z.string().min(1),
  contactName: z.string().optional(),
  intentLevel: z.enum(['high', 'medium', 'low']),
  distanceKm: z.number().nonnegative(),
  status: z.enum(['new', 'contacted', 'qualified', 'closed']),
  lastFollowedAt: isoTimestamp.optional(),
  notes: z.string().optional(),
})

/**
 * The audit record of one model call. Deliberately carries no prompt or
 * completion text: the run is traceable by `functionType`, `model`, skill and
 * session without duplicating user content into a second store.
 */
export const generationRunSchema = z.object({
  id: nonEmptyId,
  ...ownershipFields,
  functionType: generateFunctionTypeSchema,
  inputContent: z.string(),
  additionalRequirements: z.string().optional(),
  model: z.string().min(1),
  skillName: z.string().min(1),
  sessionId: z.string().optional(),
})

/**
 * One audited write. Append-only, so it carries no `updatedAt` and no
 * `projectId`; `resource`/`resourceId` name what changed and `actorId` who did
 * it. Never stores record bodies, cookies, or tokens.
 */
export const auditEventSchema = z.object({
  id: nonEmptyId,
  organizationId: nonEmptyId,
  actorId: nonEmptyId,
  resource: z.string().min(1),
  resourceId: z.string().optional(),
  action: z.string().min(1),
  createdAt: isoTimestamp,
})

/** The material shape domain version 0 stored. */
export const v0MaterialSchema = z.object({
  id: nonEmptyId,
  name: z.string(),
  type: materialTypeSchema,
  category: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
})

/** The organization root. */
export type Organization = z.infer<typeof organizationSchema>
/** A member of an organization. */
export type Member = z.infer<typeof memberSchema>
/** The organization's company profile. */
export type Company = z.infer<typeof companySchema>
/** The founder persona. */
export type Founder = z.infer<typeof founderSchema>
/** A project. */
export type Project = z.infer<typeof projectSchema>
/** A reusable asset. */
export type Material = z.infer<typeof materialSchema>
/** A unit of content work. */
export type ContentTask = z.infer<typeof contentTaskSchema>
/** An operated account. */
export type OperationAccount = z.infer<typeof operationAccountSchema>
/** A watched competitor. */
export type Competitor = z.infer<typeof competitorSchema>
/** A saved account-startup plan. */
export type AccountPlan = z.infer<typeof accountPlanSchema>
/** One planned task on one day. */
export type WorkPlanTask = z.infer<typeof workPlanTaskSchema>
/** One platform's numbers for one work on one day. */
export type ContentMetric = z.infer<typeof contentMetricSchema>
/** A GEO outreach lead. */
export type GeoLead = z.infer<typeof geoLeadSchema>
/** The audit record of one model call. */
export type GenerationRun = z.infer<typeof generationRunSchema>
/** One audited write. */
export type AuditEvent = z.infer<typeof auditEventSchema>
/** The material shape domain version 0 stored. */
export type V0Material = z.infer<typeof v0MaterialSchema>

/**
 * Rebuild a version 1 material from a version 0 record.
 *
 * Development-only: version 0 had no concept of an owner, so the migration has
 * to invent one, and it invents the demo organization and project rather than
 * guessing a real tenant. Both stamps come from the stored epoch milliseconds.
 * @param record - A version 0 material, validated before use.
 * @returns the same material as a version 1 record.
 */
export function migrateV0Material(record: V0Material): Material {
  const parsed = v0MaterialSchema.parse(record)
  const createdAt = new Date(parsed.createdAt).toISOString()
  const material: Material = {
    id: parsed.id,
    name: parsed.name,
    type: parsed.type,
    organizationId: DEMO_ORGANIZATION_ID,
    projectId: DEMO_PROJECT_ID,
    createdAt,
    updatedAt: createdAt,
  }
  if (parsed.category !== undefined) material.category = parsed.category
  if (parsed.content !== undefined) material.content = parsed.content
  if (parsed.url !== undefined) material.url = parsed.url
  return material
}

/** Silipower durable domain: 16 tables covering ownership through audit. */
export const silipowerDomainSpec = defineDomain({
  name: 'silipower',
  version: CURRENT_DOMAIN_VERSION,
  tables: {
    organizations: domainTable<string, Organization>(organizationSchema),
    members: domainTable<string, Member>(memberSchema),
    companies: domainTable<string, Company>(companySchema),
    founders: domainTable<string, Founder>(founderSchema),
    projects: domainTable<string, Project>(projectSchema),
    materials: domainTable<string, Material>(materialSchema),
    content_tasks: domainTable<string, ContentTask>(contentTaskSchema),
    operation_accounts: domainTable<string, OperationAccount>(operationAccountSchema),
    competitors: domainTable<string, Competitor>(competitorSchema),
    account_plans: domainTable<string, AccountPlan>(accountPlanSchema),
    workplan_tasks: domainTable<string, WorkPlanTask>(workPlanTaskSchema),
    content_metrics: domainTable<string, ContentMetric>(contentMetricSchema),
    geo_leads: domainTable<string, GeoLead>(geoLeadSchema),
    generation_runs: domainTable<string, GenerationRun>(generationRunSchema),
    publish_records: domainTable<string, PublishRecord>(publishRecordSchema),
    audit_events: domainTable<string, AuditEvent>(auditEventSchema),
  },
})
