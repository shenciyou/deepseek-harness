import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const nonNegativeInt = z.number().int().nonnegative()

export const materialTypeSchema = z.enum(['video', 'image', 'script', 'cover', 'tag'])

export const materialSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: materialTypeSchema,
  category: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  createdAt: nonNegativeInt,
})

export type Material = z.infer<typeof materialSchema>

export const publishRecordSchema = z.object({
  id: z.string().min(1),
  platform: z.string(),
  title: z.string(),
  status: z.string(),
  url: z.string().optional(),
  createdAt: nonNegativeInt,
})

export type PublishRecord = z.infer<typeof publishRecordSchema>

/** Silipower durable domain: knowledge materials and publish records. */
export const silipowerDomainSpec = defineDomain({
  name: 'silipower',
  version: 0,
  tables: {
    materials: domainTable<string, Material>(materialSchema),
    publishRecords: domainTable<string, PublishRecord>(publishRecordSchema),
  },
})
