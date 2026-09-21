import { failure } from './errors.ts'

/** Header naming the dev actor. */
export const ACTOR_HEADER = 'x-silipower-actor'

/** Header naming the organization the actor claims to act within. */
export const ORGANIZATION_HEADER = 'x-silipower-organization'

/** Environment variable holding the dev actor allow list. */
export const DEV_ACTORS_ENV = 'SILIPOWER_DEV_ACTORS'

/** Who is acting, and inside which organization. */
export interface RequestScope {
  readonly organizationId: string
  readonly actorId: string
}

/** The headers a request may carry. */
export type RequestHeaders = Record<string, string | string[] | undefined>

/**
 * Parse the dev actor allow list.
 *
 * Format: `actorId=organizationId`, comma separated. An entry that is not of
 * that shape is skipped rather than interpreted, so a typo narrows the list
 * instead of widening it.
 * @param raw - The raw environment value, or `undefined`.
 * @returns the actor-to-organization map.
 */
export function parseDevActors(raw: string | undefined): Map<string, string> {
  const actors = new Map<string, string>()
  if (raw === undefined) return actors
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const actorId = trimmed.slice(0, separator).trim()
    const organizationId = trimmed.slice(separator + 1).trim()
    if (actorId === '' || organizationId === '') continue
    actors.set(actorId, organizationId)
  }
  return actors
}

/**
 * Resolve the acting scope for a request.
 *
 * **This channel is temporary and fails closed.** Real sessions arrive in
 * iteration 6; until then the only way to authenticate is an explicitly
 * configured allow list, and `NODE_ENV=production` refuses the channel outright
 * rather than depending on the variable being absent. A production build must
 * fail here, not silently accept a header.
 * @param input - Headers, `NODE_ENV`, and the raw allow list.
 * @returns the scope the request may act within.
 * @throws SilipowerFailure with `AUTH_REQUIRED`, `VALIDATION_ERROR`, or `FORBIDDEN`.
 */
export function resolveScope(input: {
  headers: RequestHeaders
  nodeEnv: string | undefined
  devActors: string | undefined
}): RequestScope {
  if (input.nodeEnv === 'production') {
    throw failure('AUTH_REQUIRED', 'authentication is not available yet')
  }

  const actors = parseDevActors(input.devActors)
  if (actors.size === 0) {
    throw failure('AUTH_REQUIRED', 'authentication is not configured')
  }

  const actorId = readHeader(input.headers, ACTOR_HEADER)
  if (actorId === undefined) {
    throw failure('AUTH_REQUIRED', `${ACTOR_HEADER} is required`)
  }

  const organizationId = actors.get(actorId)
  if (organizationId === undefined) {
    throw failure('AUTH_REQUIRED', 'unknown actor')
  }

  const claimed = readHeader(input.headers, ORGANIZATION_HEADER)
  if (claimed === undefined) {
    throw failure('VALIDATION_ERROR', `${ORGANIZATION_HEADER} is required`)
  }
  if (claimed !== organizationId) {
    throw failure('FORBIDDEN', `actor ${actorId} does not belong to organization ${claimed}`)
  }

  return { organizationId, actorId }
}

/**
 * Read one header, taking the first value when the transport repeats it.
 * @param headers - The request headers.
 * @param name - Lower-case header name.
 * @returns the value, or `undefined` when absent or empty.
 */
export function readHeader(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first === '' ? undefined : first
}
