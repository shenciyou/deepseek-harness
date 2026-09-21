import { describe, expect, it, vi } from 'vitest'
import { ACTOR_HEADER, ORGANIZATION_HEADER, parseDevActors } from '../src/auth.ts'
import { failure } from '../src/errors.ts'
import { corsHeaders, errorResponse, handleRoute, parseJsonBody, type RouteInput, type RouteRequest } from '../src/http.ts'

const ORIGIN = 'https://workbench.example'
const ALLOWED = [ORIGIN]
const DEV_ACTORS = 'actor_a=org_a,actor_b=org_b'

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'POST',
    headers: { [ACTOR_HEADER]: 'actor_a', [ORGANIZATION_HEADER]: 'org_a' },
    ...overrides,
  }
}

function route(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    request: request(),
    allowedMethods: ['POST'],
    allowedOrigins: ALLOWED,
    requestId: 'req_test',
    nodeEnv: 'development',
    devActors: DEV_ACTORS,
    handler: async () => ({ hello: 'world' }),
    ...overrides,
  }
}

describe('parseJsonBody', () => {
  it('rejects malformed JSON as INVALID_JSON at 400', () => {
    expect(() => parseJsonBody('{"a":')).toThrowError(
      expect.objectContaining({ code: 'INVALID_JSON', status: 400 }),
    )
  })

  it('accepts a well-formed body and treats empty input as absent', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonBody('')).toBeUndefined()
  })
})

describe('parseDevActors', () => {
  it('reads actor=organization pairs and ignores malformed entries', () => {
    expect([...parseDevActors(DEV_ACTORS)]).toEqual([
      ['actor_a', 'org_a'],
      ['actor_b', 'org_b'],
    ])
    // A typo narrows the allow list rather than widening it.
    expect([...parseDevActors('nonsense,=,x=,=y')]).toEqual([])
    expect([...parseDevActors(undefined)]).toEqual([])
  })
})

describe('handleRoute authentication', () => {
  it('answers AUTH_REQUIRED when the dev actor channel is not configured', async () => {
    const response = await handleRoute(route({ devActors: undefined }))
    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } })
  })

  it('refuses the dev actor channel in production even when it is configured', async () => {
    // Fail-closed: the channel exists only because iteration 6 has not landed
    // real sessions yet. In production it must not be reachable at all, not
    // merely disabled by an absent variable.
    const response = await handleRoute(route({ nodeEnv: 'production' }))
    expect(response.status).toBe(401)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } })
  })

  it('answers AUTH_REQUIRED when the actor header is missing', async () => {
    const response = await handleRoute(route({ request: request({ headers: {} }) }))
    expect(response.status).toBe(401)
  })

  it('answers AUTH_REQUIRED for an actor outside the allow list', async () => {
    const response = await handleRoute(
      route({ request: request({ headers: { [ACTOR_HEADER]: 'actor_z', [ORGANIZATION_HEADER]: 'org_a' } }) }),
    )
    expect(response.status).toBe(401)
  })

  it('lets a whitelisted actor act inside its own organisation', async () => {
    const response = await handleRoute(route())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, value: { hello: 'world' } })
  })

  it('answers FORBIDDEN when the actor claims another organisation', async () => {
    const response = await handleRoute(
      route({ request: request({ headers: { [ACTOR_HEADER]: 'actor_a', [ORGANIZATION_HEADER]: 'org_b' } }) }),
    )
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('tells the handler which organisation and actor it acts for', async () => {
    const handler = vi.fn(async () => null)
    await handleRoute(route({ handler }))
    expect(handler).toHaveBeenCalledWith({ scope: { organizationId: 'org_a', actorId: 'actor_a' }, requestId: 'req_test' })
  })
})

describe('header edge cases', () => {
  it('requires the organization header once the actor is known', async () => {
    const response = await handleRoute(route({ request: request({ headers: { [ACTOR_HEADER]: 'actor_a' } }) }))
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  it('takes the first value when the transport repeats a header', async () => {
    const response = await handleRoute(
      route({
        request: request({
          headers: { [ACTOR_HEADER]: ['actor_a', 'actor_z'], [ORGANIZATION_HEADER]: 'org_a' },
        }),
      }),
    )
    expect(response.status).toBe(200)
  })

  it('treats an empty or unset header value as absent', async () => {
    const empty = await handleRoute(
      route({ request: request({ headers: { [ACTOR_HEADER]: '', [ORGANIZATION_HEADER]: 'org_a' } }) }),
    )
    expect(empty.status).toBe(401)

    const unset = await handleRoute(
      route({ request: request({ headers: { [ACTOR_HEADER]: [], [ORGANIZATION_HEADER]: 'org_a' } }) }),
    )
    expect(unset.status).toBe(401)
  })
})

describe('handleRoute method and error mapping', () => {
  it('answers METHOD_NOT_ALLOWED for an unsupported method', async () => {
    const response = await handleRoute(route({ request: request({ method: 'DELETE' }), allowedMethods: ['POST'] }))
    expect(response.status).toBe(405)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
  })

  it('maps a NOT_FOUND failure to 404', async () => {
    const response = await handleRoute(
      route({
        handler: async () => {
          throw failure('NOT_FOUND', 'no such material')
        },
      }),
    )
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: 'no such material' } })
  })

  it('maps a VALIDATION_ERROR failure to 400', async () => {
    const response = await handleRoute(
      route({
        handler: async () => {
          throw failure('VALIDATION_ERROR', 'name too short')
        },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('hides an unexpected error behind INTERNAL_ERROR and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await handleRoute(
      route({
        handler: async () => {
          throw new Error('boom: secret detail')
        },
      }),
    )
    const logCalls = logged.mock.calls.length
    logged.mockRestore()

    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(JSON.stringify(response.body)).not.toContain('secret detail')
    // The real message has to survive somewhere, or a 500 is undiagnosable.
    expect(logCalls).toBe(1)
  })

  it('carries the requestId on both the header and the error payload', async () => {
    const response = await handleRoute(
      route({
        handler: async () => {
          throw failure('NOT_FOUND', 'gone')
        },
      }),
    )
    expect(response.headers['x-request-id']).toBe('req_test')
    expect(response.body).toMatchObject({ error: { requestId: 'req_test' } })
  })
})

describe('CORS', () => {
  it('echoes an allow-listed origin', () => {
    expect(corsHeaders(ORIGIN, ALLOWED)['Access-Control-Allow-Origin']).toBe(ORIGIN)
  })

  it('echoes nothing for an origin outside the allow list', () => {
    expect(corsHeaders('https://evil.example', ALLOWED)['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('never answers with a wildcard', () => {
    expect(JSON.stringify(corsHeaders(ORIGIN, ALLOWED))).not.toContain('*')
  })

  it('answers a preflight without reaching the handler', async () => {
    const handler = vi.fn(async () => ({ unreachable: true }))
    const response = await handleRoute(
      route({ request: { method: 'OPTIONS', headers: { origin: ORIGIN } }, handler }),
    )
    expect(response.status).toBe(204)
    expect(response.headers['Access-Control-Allow-Origin']).toBe(ORIGIN)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('errorResponse', () => {
  it('always produces the ok:false envelope', () => {
    expect(errorResponse(failure('INTERNAL_ERROR', 'x'), 'req_1')).toMatchObject({
      body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'x', requestId: 'req_1' } },
    })
  })
})
