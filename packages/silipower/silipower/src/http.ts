import { readHeader, resolveScope, type RequestHeaders, type RequestScope } from './auth.ts'
import type { GenerateRequest } from './contracts.ts'
import { failure, isFailure, statusOf, toErrorPayload } from './errors.ts'
import { toNdjson, type GenerationEvent, type PreparedGeneration, type ProjectContext } from './generate.ts'

/** The parts of a request a route handler reads. */
export interface RouteRequest {
  readonly method: string
  readonly headers: RequestHeaders
  readonly body?: unknown
}

/** A response the transport layer can write. */
export interface RouteResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: unknown
}

/** What a route handler is told about the caller. */
export interface RequestContext {
  readonly scope: RequestScope
  readonly requestId: string
}

/** Everything {@link handleRoute} needs to serve one request. */
export interface RouteInput {
  readonly request: RouteRequest
  readonly allowedMethods: readonly string[]
  readonly allowedOrigins: readonly string[]
  readonly requestId: string
  readonly nodeEnv: string | undefined
  readonly devActors: string | undefined
  readonly handler: (context: RequestContext) => Promise<unknown>
}

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** Media type of the generation stream: one JSON event per line. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8'

/** The half of the generation service the route depends on. */
export interface GenerationPort {
  prepare(request: GenerateRequest, context: ProjectContext): Promise<PreparedGeneration>
  stream(prepared: PreparedGeneration): AsyncIterable<GenerationEvent>
}

/** One generate request, already read off the transport. */
export interface GenerateRequestInput {
  readonly method: string
  readonly headers: RequestHeaders
  readonly rawBody: string
  readonly nodeEnv: string | undefined
  readonly devActors: string | undefined
  readonly allowedOrigins: readonly string[]
  readonly requestId: string
  readonly generation: GenerationPort
  readonly context: (scope: RequestScope) => ProjectContext
}

/**
 * Either a stream of NDJSON lines or a buffered JSON envelope.
 *
 * The two are separate shapes rather than one with an optional field: a route
 * that has started streaming cannot change its status any more, so the decision
 * has to be forced before the first byte goes out.
 */
export type GenerateOutcome =
  | {
    readonly kind: 'stream'
    readonly status: 200
    readonly headers: Record<string, string>
    readonly lines: AsyncIterable<string>
  }
  | {
    readonly kind: 'json'
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: unknown
  }

/**
 * Serve `POST /api/silipower/generate`.
 *
 * Everything that can fail — auth, method, JSON, the contract, skill routing —
 * runs before the stream is opened, so a rejected request is an ordinary JSON
 * error rather than a stream that ends early.
 * @param input - The request and its dependencies.
 * @returns the stream to pipe, or a JSON envelope.
 */
export async function handleGenerateRequest(input: GenerateRequestInput): Promise<GenerateOutcome> {
  const cors = corsHeaders(readHeader(input.headers, 'origin'), input.allowedOrigins)
  try {
    if (input.method === 'OPTIONS') {
      return { kind: 'json', status: 204, headers: { 'x-request-id': input.requestId, ...cors }, body: undefined }
    }

    const scope = resolveScope({
      headers: input.headers,
      nodeEnv: input.nodeEnv,
      devActors: input.devActors,
    })

    if (input.method !== 'POST') {
      throw failure('METHOD_NOT_ALLOWED', `${input.method} is not allowed here`)
    }

    const prepared = await input.generation.prepare(
      parseJsonBody(input.rawBody) as GenerateRequest,
      input.context(scope),
    )

    return {
      kind: 'stream',
      status: 200,
      headers: { 'Content-Type': NDJSON_CONTENT_TYPE, 'x-request-id': input.requestId, ...cors },
      lines: serialize(input.generation.stream(prepared)),
    }
  } catch (error) {
    if (!isFailure(error)) console.error('[silipower] unhandled generate error', error)
    const response = errorResponse(error, input.requestId, cors)
    return { kind: 'json', status: response.status, headers: response.headers, body: response.body }
  }
}

async function* serialize(events: AsyncIterable<GenerationEvent>): AsyncIterable<string> {
  for await (const event of events) yield toNdjson(event)
}

/**
 * Parse a raw request body.
 * @param raw - The raw body text.
 * @returns the parsed value, or `undefined` for an empty body.
 * @throws SilipowerFailure `INVALID_JSON` when the text is not JSON.
 */
export function parseJsonBody(raw: string): unknown {
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw failure('INVALID_JSON', 'request body is not valid JSON')
  }
}

/**
 * CORS headers for one request.
 *
 * The allow list is echoed, never wildcarded: a wildcard would let any page on
 * the internet call the API with the browser's own credentials once real
 * sessions exist.
 * @param origin - The request's `Origin`, if any.
 * @param allowedOrigins - The configured allow list.
 * @returns the headers to attach.
 */
export function corsHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-silipower-actor, x-silipower-organization, x-request-id',
    Vary: 'Origin',
  }
  if (origin !== undefined && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

/**
 * Wrap a value in the success envelope.
 * @param value - The payload.
 * @param requestId - Request id carried on the response.
 * @param cors - CORS headers to merge in.
 * @returns the response.
 */
export function okResponse(value: unknown, requestId: string, cors: Record<string, string> = {}): RouteResponse {
  return {
    status: 200,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, 'x-request-id': requestId, ...cors },
    body: { ok: true, value },
  }
}

/**
 * Wrap any thrown value in the failure envelope.
 * @param error - The caught value.
 * @param requestId - Request id carried on both the header and the payload.
 * @param cors - CORS headers to merge in.
 * @returns the response.
 */
export function errorResponse(error: unknown, requestId: string, cors: Record<string, string> = {}): RouteResponse {
  return {
    status: statusOf(error),
    headers: { 'Content-Type': JSON_CONTENT_TYPE, 'x-request-id': requestId, ...cors },
    body: { ok: false, error: toErrorPayload(error, requestId) },
  }
}

/**
 * Serve one request: preflight, then scope, then method, then the handler.
 *
 * Scope is resolved before the method is checked so an unauthenticated caller
 * cannot map which methods a route accepts. Only `SilipowerFailure` reaches the
 * client; anything else is logged and reported as `INTERNAL_ERROR`, because an
 * unexpected message can name internal paths or dependencies.
 * @param input - The request and its route policy.
 * @returns the response to write.
 */
export async function handleRoute(input: RouteInput): Promise<RouteResponse> {
  const cors = corsHeaders(readHeader(input.request.headers, 'origin'), input.allowedOrigins)
  try {
    if (input.request.method === 'OPTIONS') {
      return { status: 204, headers: { 'x-request-id': input.requestId, ...cors }, body: undefined }
    }

    const scope = resolveScope({
      headers: input.request.headers,
      nodeEnv: input.nodeEnv,
      devActors: input.devActors,
    })

    if (!input.allowedMethods.includes(input.request.method)) {
      throw failure('METHOD_NOT_ALLOWED', `${input.request.method} is not allowed here`)
    }

    const value = await input.handler({ scope, requestId: input.requestId })
    return okResponse(value, input.requestId, cors)
  } catch (error) {
    if (!isFailure(error)) console.error('[silipower] unhandled route error', error)
    return errorResponse(error, input.requestId, cors)
  }
}
