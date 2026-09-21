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
