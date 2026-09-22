import { failure } from './errors.ts'

/** Header naming the dev actor. */
export const ACTOR_HEADER = 'x-silipower-actor'

/** Header naming the organization the actor claims to act within. */
export const ORGANIZATION_HEADER = 'x-silipower-organization'

/**
 * Header naming the project the actor is working in.
 *
 * A project is the data boundary for accounts, competitors and plans, so the
 * server has to be told which one a request acts in. It is optional here and
 * required by the routes that are project-scoped: a route that needs it fails
 * closed rather than silently reading every project in the organization.
 */
export const PROJECT_HEADER = 'x-silipower-project'

/** Environment variable holding the dev actor allow list. */
export const DEV_ACTORS_ENV = 'SILIPOWER_DEV_ACTORS'

/** Who is acting, and inside which organization and project. */
export interface RequestScope {
  readonly organizationId: string
  readonly actorId: string
  /** The acting project, or `null` when the request named no project. */
  readonly projectId: string | null
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

  return { organizationId, actorId, projectId: readHeader(input.headers, PROJECT_HEADER) ?? null }
}

/**
 * The project a project-scoped route must act in.
 * @param scope - The resolved scope.
 * @returns the project id.
 * @throws SilipowerFailure `VALIDATION_ERROR` when the request named none, so a
 * caller cannot read or write across every project by omitting the header.
 */
export function requireProjectId(scope: RequestScope): string {
  if (scope.projectId === null) {
    throw failure('VALIDATION_ERROR', `${PROJECT_HEADER} is required`)
  }
  return scope.projectId
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
