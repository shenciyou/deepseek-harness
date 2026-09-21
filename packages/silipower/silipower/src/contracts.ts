import { z } from 'zod'

/**
 * The Silipower business function types, as they appear on the wire.
 *
 * These are enum keys rather than the Chinese labels the prototype pages used,
 * because the label is presentation and the type is contract. `apps/src/lib/ai-runtime.ts`
 * owns the single label-to-key mapping.
 */
export const generateFunctionTypeSchema = z.enum([
  'account_planning',
  'copywriting_analysis',
  'copywriting_generate',
  'content_check',
  'data_diagnosis',
  'geo_outreach',
  'digital_human_script',
])

/** Request body of `POST /api/silipower/generate`. */
export const generateRequestSchema = z.object({
  functionType: generateFunctionTypeSchema,
  inputContent: z.string().trim().min(1).max(20_000),
  additionalRequirements: z.string().trim().max(4_000).optional(),
  projectId: z.string().min(1).optional(),
  materialIds: z.array(z.string().min(1)).max(20).optional(),
})

/** The kinds of reusable asset a material can be, as they appear on the wire. */
export const materialTypeSchema = z.enum(['video', 'image', 'script', 'cover', 'tag'])

/**
 * Body of `POST /api/silipower/materials`.
 *
 * Strict on purpose. `id`, `organizationId`, the actor, and both timestamps are
 * the server's to assign; a client that sends them is rejected rather than
 * quietly ignored, so a client cannot believe it chose an owner.
 */
export const materialCreateSchema = z.object({
  name: z.string().min(1),
  type: materialTypeSchema,
  category: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  projectId: z.string().min(1).nullable().optional(),
}).strict()

/** Body of `PATCH /api/silipower/materials/:id`: the create fields, all optional. */
export const materialPatchSchema = z.object({
  name: z.string().min(1).optional(),
  type: materialTypeSchema.optional(),
  category: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  projectId: z.string().min(1).nullable().optional(),
}).strict()

/** Query string of `GET /api/silipower/materials`. */
export const materialListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  type: materialTypeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * Error codes every Silipower endpoint may return.
 *
 * The set is closed on purpose: a client can branch on `code` without parsing
 * `message`, and a new failure mode must be named here before it can reach the
 * wire.
 */
export const silipowerErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'INVALID_JSON',
  'METHOD_NOT_ALLOWED',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SKILL_UNAVAILABLE',
  'INTERNAL_ERROR',
])

/** Failure payload carried by `{ ok: false }` responses. */
export const silipowerErrorSchema = z.object({
  code: silipowerErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
})

/** A Silipower business function type. */
export type GenerateFunctionType = z.infer<typeof generateFunctionTypeSchema>

/** Body of `POST /api/silipower/generate`. */
export type GenerateRequest = z.infer<typeof generateRequestSchema>

/** A kind of reusable asset. */
export type MaterialType = z.infer<typeof materialTypeSchema>

/** Body of `POST /api/silipower/materials`. */
export type MaterialCreateInput = z.infer<typeof materialCreateSchema>

/** Body of `PATCH /api/silipower/materials/:id`. */
export type MaterialPatchInput = z.infer<typeof materialPatchSchema>

/** Query string of `GET /api/silipower/materials`. */
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>

/** A Silipower error code. */
export type SilipowerErrorCode = z.infer<typeof silipowerErrorCodeSchema>

/** Failure payload carried by `{ ok: false }` responses. */
export type SilipowerError = z.infer<typeof silipowerErrorSchema>

/** Successful single-value response envelope. */
export type SilipowerOk<T> = { ok: true; value: T }

/** Failed response envelope. */
export type SilipowerFail = { ok: false; error: SilipowerError }

/** Successful list response envelope. */
export type SilipowerList<T> = { items: T[]; nextCursor?: string }

/** Every response envelope a Silipower endpoint may produce. */
export type SilipowerResponse<T> = SilipowerOk<T> | SilipowerFail
