import { describe, expect, it } from 'vitest'
import { ACTOR_HEADER, ORGANIZATION_HEADER } from '../src/auth.ts'
import { GenerationService, metaPayload, type GenerationEvent, type PreparedGeneration } from '../src/generate.ts'
import { handleGenerateRequest, type GenerateRequestInput } from '../src/http.ts'
import type { GenerateRequest } from '../src/contracts.ts'

const ORIGIN = 'https://workbench.example'
const DEV_ACTORS = 'actor_a=org_a'

function base(overrides: Partial<GenerateRequestInput> = {}): GenerateRequestInput {
  return {
    method: 'POST',
    headers: { [ACTOR_HEADER]: 'actor_a', [ORGANIZATION_HEADER]: 'org_a', origin: ORIGIN },
    rawBody: JSON.stringify({
      functionType: 'copywriting_generate',
      inputContent: '主题',
      additionalRequirements: '口播',
    }),
    nodeEnv: 'development',
    devActors: DEV_ACTORS,
    allowedOrigins: [ORIGIN],
    requestId: 'req_gen',
    context: scope => ({ organizationId: scope.organizationId, projectName: '秋季新品' }),
    generation: {
      prepare: async (request): Promise<PreparedGeneration> => ({
        request,
        profile: { functionType: 'copywriting_generate', skillName: 'copywriting-templates' },
        runId: 'run_1',
        prompt: 'prompt',
      }),
      stream: async function* (): AsyncIterable<GenerationEvent> {
        yield { type: 'token', text: 'a' }
        yield { type: 'done', runId: 'run_1', model: 'deepseek-v4-flash', skillName: 'copywriting-templates' }
      },
    },
    ...overrides,
  }
}

async function lines(outcome: Awaited<ReturnType<typeof handleGenerateRequest>>): Promise<string[]> {
  if (outcome.kind !== 'stream') throw new Error(`expected a stream, got ${JSON.stringify(outcome)}`)
  const collected: string[] = []
  for await (const line of outcome.lines) collected.push(line)
  return collected
}

describe('handleGenerateRequest request handling', () => {
  it('hands the model service all three contract fields', async () => {
    let seen: GenerateRequest | undefined
    const outcome = await handleGenerateRequest(
      base({
        generation: {
          prepare: async (request): Promise<PreparedGeneration> => {
            seen = request
            return {
              request,
              profile: { functionType: 'copywriting_generate', skillName: 'copywriting-templates' },
              runId: 'run_1',
              prompt: 'prompt',
            }
          },
          stream: async function* (): AsyncIterable<GenerationEvent> {
            yield { type: 'done', runId: 'run_1', model: 'm', skillName: 's' }
          },
        },
      }),
    )
    await lines(outcome)

    // Before iteration 2 the endpoint consumed only `content`, so the function
    // type and the extra requirements were silently dropped.
    expect(seen).toMatchObject({
      functionType: 'copywriting_generate',
      inputContent: '主题',
      additionalRequirements: '口播',
    })
  })

  it('answers the generation as application/x-ndjson', async () => {
    const outcome = await handleGenerateRequest(base())
    expect(outcome.status).toBe(200)
    expect(outcome.headers['Content-Type']).toContain('application/x-ndjson')
    expect(outcome.headers['x-request-id']).toBe('req_gen')

    const body = await lines(outcome)
    expect(body.map(line => JSON.parse(line).type)).toEqual(['token', 'done'])
    expect(body.every(line => line.endsWith('\n'))).toBe(true)
  })

  it('passes the resolved scope into the project context', async () => {
    let seenOrganization: string | undefined
    const outcome = await handleGenerateRequest(
      base({
        context: (scope) => {
          seenOrganization = scope.organizationId
          return { organizationId: scope.organizationId }
        },
      }),
    )
    await lines(outcome)
    expect(seenOrganization).toBe('org_a')
  })
})

describe('handleGenerateRequest controlled failures', () => {
  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    const outcome = await handleGenerateRequest(base({ rawBody: '{"a":' }))
    expect(outcome.status).toBe(400)
    expect(outcome).toMatchObject({ body: { ok: false, error: { code: 'INVALID_JSON' } } })
  })

  it('requires authentication', async () => {
    const outcome = await handleGenerateRequest(base({ devActors: undefined }))
    expect(outcome.status).toBe(401)
  })

  it('refuses the dev actor channel in production', async () => {
    const outcome = await handleGenerateRequest(base({ nodeEnv: 'production' }))
    expect(outcome.status).toBe(401)
  })

  it('rejects an unsupported method', async () => {
    const outcome = await handleGenerateRequest(base({ method: 'GET' }))
    expect(outcome.status).toBe(405)
  })

  it('echoes only an allow-listed origin', async () => {
    const allowed = await handleGenerateRequest(base())
    expect(allowed.headers['Access-Control-Allow-Origin']).toBe(ORIGIN)

    const denied = await handleGenerateRequest(
      base({ headers: { [ACTOR_HEADER]: 'actor_a', [ORGANIZATION_HEADER]: 'org_a', origin: 'https://evil.example' } }),
    )
    expect(denied.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

describe('handleGenerateRequest against the real service', () => {
  /**
   * The real GenerationService with a stub model, so validation, routing and
   * skill lookup actually run. Injecting a hand-made port here would stub out
   * the very behaviour these cases exist to check.
   */
  function realGeneration(available: readonly string[] = ['copywriting-templates', 'compliance-check']) {
    const modelCalls: unknown[] = []
    const service = new GenerationService({
      llm: {
        prepareCall: async () => ({
          stream: async function* () {
            modelCalls.push('called')
            yield { type: 'text-delta', text: '生成结果' }
          },
        }),
      },
      skills: { read: async name => (available.includes(name) ? `# ${name}` : undefined) },
      newRunId: () => 'run_1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    return { service, modelCalls }
  }

  it('answers an unknown function type with 400 and never reaches the model', async () => {
    const { service, modelCalls } = realGeneration()
    const outcome = await handleGenerateRequest(
      base({ rawBody: JSON.stringify({ functionType: 'nope', inputContent: 'x' }), generation: service }),
    )
    expect(outcome.kind).toBe('json')
    expect(outcome.status).toBe(400)
    expect(modelCalls).toHaveLength(0)
  })

  it('answers an unregistered skill with 503 SKILL_UNAVAILABLE and never reaches the model', async () => {
    // analytics-diagnosis lands in iteration 5; until then the honest answer is
    // a visible 503, not a generic prompt that reads like a success.
    const { service, modelCalls } = realGeneration()
    const outcome = await handleGenerateRequest(
      base({ rawBody: JSON.stringify({ functionType: 'data_diagnosis', inputContent: 'x' }), generation: service }),
    )
    expect(outcome.status).toBe(503)
    expect(outcome).toMatchObject({ body: { ok: false, error: { code: 'SKILL_UNAVAILABLE' } } })
    expect(modelCalls).toHaveLength(0)
  })

  it('streams a routed generation end to end as NDJSON', async () => {
    const { service, modelCalls } = realGeneration()
    const outcome = await handleGenerateRequest(
      base({
        rawBody: JSON.stringify({
          functionType: 'content_check',
          inputContent: '待检测文案',
          additionalRequirements: '严格一些',
        }),
        generation: service,
      }),
    )
    expect(outcome.status).toBe(200)

    const body = await lines(outcome)
    expect(body.map(line => JSON.parse(line))).toEqual([
      { type: 'token', text: '生成结果' },
      { type: 'done', runId: 'run_1', model: 'deepseek-v4-flash', skillName: 'compliance-check' },
    ])
    // The model is only touched once the stream is consumed, which is what
    // keeps a rejected request from costing a provider call.
    expect(modelCalls).toHaveLength(1)
  })
})

describe('metaPayload', () => {
  it('lists every supported function type with its skill', () => {
    expect(metaPayload().functionTypes).toHaveLength(7)
    expect(metaPayload().functionTypes).toContainEqual({
      functionType: 'content_check',
      skillName: 'compliance-check',
    })
  })

  it('exposes no credentials, environment or paths', () => {
    const serialised = JSON.stringify(metaPayload())
    for (const leak of ['key', 'Key', 'env', 'ENV', 'token', 'DEEPSEEK', '\\\\', '/packages']) {
      expect(serialised).not.toContain(leak)
    }
  })
})
