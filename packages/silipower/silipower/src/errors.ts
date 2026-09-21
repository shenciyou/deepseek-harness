import type { SilipowerError, SilipowerErrorCode } from './contracts.ts'

/**
 * HTTP status for each failure code.
 *
 * The mapping lives here rather than at each route so a code cannot mean one
 * status in one handler and another elsewhere — the client branches on `code`
 * and would otherwise have to re-derive the meaning from the status.
 */
export const HTTP_STATUS: Record<SilipowerErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  METHOD_NOT_ALLOWED: 405,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SKILL_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

/** A failure that already knows its wire code and status. */
export class SilipowerFailure extends Error {
  /** The wire code. */
  readonly code: SilipowerErrorCode
  /** The HTTP status this code maps to. */
  readonly status: number

  /**
   * @param code - The wire code.
   * @param message - Operator-facing detail; never contains record bodies.
   */
  constructor(code: SilipowerErrorCode, message: string) {
    super(message)
    this.name = 'SilipowerFailure'
    this.code = code
    this.status = HTTP_STATUS[code]
  }
}

/**
 * Build a failure that carries its own wire code.
 * @param code - The wire code.
 * @param message - Operator-facing detail.
 * @returns the failure, ready to throw.
 */
export function failure(code: SilipowerErrorCode, message: string): SilipowerFailure {
  return new SilipowerFailure(code, message)
}

/**
 * Narrow an unknown thrown value to a failure we produced.
 * @param value - The caught value.
 * @returns whether it is a {@link SilipowerFailure}.
 */
export function isFailure(value: unknown): value is SilipowerFailure {
  return value instanceof SilipowerFailure
}

/**
 * Map any thrown value onto the wire error payload.
 *
 * An unrecognised error is reported as `INTERNAL_ERROR` with a fixed message:
 * the real text can name internal paths or dependencies, so it is logged rather
 * than returned.
 * @param error - The caught value.
 * @param requestId - Request id carried on the response.
 * @returns the payload for an `ok: false` envelope.
 */
export function toErrorPayload(error: unknown, requestId: string): SilipowerError {
  if (isFailure(error)) return { code: error.code, message: error.message, requestId }
  return { code: 'INTERNAL_ERROR', message: 'internal error', requestId }
}

/**
 * HTTP status for any thrown value.
 * @param error - The caught value.
 * @returns the status to answer with.
 */
export function statusOf(error: unknown): number {
  return isFailure(error) ? error.status : HTTP_STATUS.INTERNAL_ERROR
}
