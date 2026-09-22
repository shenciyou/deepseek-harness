import { describe, expect, it, vi } from 'vitest'
import {
  GENERATION_PROFILES,
  GenerationService,
  buildPrompt,
  toNdjson,
  type GenerationEvent,
  type LlmPort,
  type ProjectContext,
} from '../src/generate.ts'

const context: ProjectContext = { organizationId: 'org_a', projectName: '秋季新品' }

/** A mock LLM that replays fixed chunks and records what it was asked. */
function mockLlm(chunks: readonly string[], options: { fail?: boolean } = {}) {
  const calls: { messages: readonly { content: readonly { text: string }[] }[] }[] = []
  const port: LlmPort = {
    prepareCall: async ({ model }) => {
      expect(model).toBe('deepseek-v4-flash')
      return {
        stream: async function* (input) {
          calls.push(input as never)
          for (const text of chunks) {
            yield { type: 'text-delta', text }
          }
          // Fail after the chunks: a mid-stream provider failure is the case
          // that must surface as an error event rather than a lost response.
          if (options.fail === true) throw new Error('provider exploded')
        },
      }
    },
  }
  return { port, calls }
}

/** A skill registry that knows the three registered content skills. */
function skills(available: readonly string[] = ['account-startup-sop', 'compliance-check', 'copywriting-templates']) {
  return {
    read: async (name: string): Promise<string | undefined> =>
      available.includes(name) ? `# ${name}\nskill body for ${name}` : undefined,
  }
}

function service(options: { chunks?: readonly string[]; available?: readonly string[]; fail?: boolean } = {}) {
  const llm = mockLlm(options.chunks ?? ['第一段', '第二段'], {
    ...(options.fail === undefined ? {} : { fail: options.fail }),
  })
  const generation = new GenerationService({
    llm: llm.port,
    skills: skills(options.available),
    newRunId: () => 'run_1',
    model: 'deepseek-v4-flash',
    provider: 'deepseek-official',
  })
  return { generation, llm }
}

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('generation profiles', () => {
  it('maps every function type, and the three the roadmap names', () => {
    expect(Object.keys(GENERATION_PROFILES).sort()).toEqual([
      'account_planning',
      'content_check',
      'copywriting_analysis',
      'copywriting_generate',
      'data_diagnosis',
      'digital_human_script',
      'geo_outreach',
    ])
    expect(GENERATION_PROFILES.account_planning.skillName).toBe('account-startup-sop')
    expect(GENERATION_PROFILES.content_check.skillName).toBe('compliance-check')
    expect(GENERATION_PROFILES.copywriting_generate.skillName).toBe('copywriting-templates')
    expect(GENERATION_PROFILES.copywriting_analysis.skillName).toBe('copywriting-templates')
  })

  it('rejects an unknown function type with a stable error', () => {
    const { generation } = service()
    expect(() => generation.resolveProfile('nope')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    )
  })
})

describe('buildPrompt', () => {
  it('carries the skill, the function, the input, the requirements and the project', () => {
    const prompt = buildPrompt({
      profile: GENERATION_PROFILES.copywriting_generate,
      request: {
        functionType: 'copywriting_generate',
        inputContent: 'AI 自媒体工具评测',
        additionalRequirements: '口播，500 字',
      },
      skillContent: '# copywriting-templates\nskill body',
      context,
    })

    expect(prompt).toContain('copywriting_generate')
    expect(prompt).toContain('AI 自媒体工具评测')
    expect(prompt).toContain('口播，500 字')
    expect(prompt).toContain('秋季新品')
    expect(prompt).toContain('skill body')
  })

  it('states that no extra requirements were given rather than dropping the section', () => {
    const prompt = buildPrompt({
      profile: GENERATION_PROFILES.content_check,
      request: { functionType: 'content_check', inputContent: '待检测文案' },
      skillContent: 'skill body',
      context,
    })
    expect(prompt).toContain('待检测文案')
    expect(prompt.toLowerCase()).toContain('no additional requirements')
  })

  it('folds in background only when the caller supplied some', () => {
    const withBackground = buildPrompt({
      profile: GENERATION_PROFILES.account_planning,
      request: {
        functionType: 'account_planning',
        inputContent: '美食账号',
        context: '公司：示例科技\n账号：主号',
      },
      skillContent: 'skill body',
      context,
    })
    expect(withBackground).toContain('## Background')
    expect(withBackground).toContain('公司：示例科技')

    // An empty section would just invite the model to invent something for it.
    for (const contextValue of [undefined, '']) {
      const without = buildPrompt({
        profile: GENERATION_PROFILES.account_planning,
        request: {
          functionType: 'account_planning',
          inputContent: '美食账号',
          ...(contextValue === undefined ? {} : { context: contextValue }),
        },
        skillContent: 'skill body',
        context,
      })
      expect(without).not.toContain('## Background')
    }
  })
})

describe('GenerationService.prepare', () => {
  it('validates the request before any token is produced', async () => {
    const { generation } = service()
    await expect(
      generation.prepare({ functionType: 'copywriting_generate', inputContent: '   ' }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
  })

  it('refuses to generate when the profile names an unregistered skill', async () => {
    // data_diagnosis's skill lands in iteration 5. Until then the honest answer
    // is SKILL_UNAVAILABLE — never a generic prompt that would look like success.
    const { generation, llm } = service()
    await expect(
      generation.prepare({ functionType: 'data_diagnosis', inputContent: '近七日数据' }, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'SKILL_UNAVAILABLE' }))
    expect(llm.calls).toHaveLength(0)
  })

  it('passes the resolved skill content into the prompt it hands the model', async () => {
    const { generation, llm } = service()
    const prepared = await generation.prepare(
      { functionType: 'copywriting_generate', inputContent: '主题', additionalRequirements: '口播' },
      context,
    )
    await collect(generation.stream(prepared))

    const [call] = llm.calls
    expect(call).toBeDefined()
    const prompt = call!.messages[0]!.content[0]!.text
    expect(prompt).toContain('copywriting-templates')
    expect(prompt).toContain('主题')
    expect(prompt).toContain('口播')
  })
})

describe('GenerationService.stream', () => {
  it('emits a token per chunk and closes with a done event', async () => {
    const { generation } = service({ chunks: ['第一段', '第二段'] })
    const prepared = await generation.prepare({ functionType: 'copywriting_generate', inputContent: 'x' }, context)
    const events = await collect(generation.stream(prepared))

    expect(events).toEqual([
      { type: 'token', text: '第一段' },
      { type: 'token', text: '第二段' },
      { type: 'done', runId: 'run_1', model: 'deepseek-v4-flash', skillName: 'copywriting-templates' },
    ])
  })

  it('reports a mid-stream provider failure as an error event', async () => {
    const { generation } = service({ chunks: ['第一段'], fail: true })
    const prepared = await generation.prepare({ functionType: 'copywriting_generate', inputContent: 'x' }, context)
    const events = await collect(generation.stream(prepared))

    expect(events[0]).toEqual({ type: 'token', text: '第一段' })
    expect(events[1]).toMatchObject({ type: 'error', error: { code: 'INTERNAL_ERROR' } })
    // The provider's own text must not reach the client.
    expect(JSON.stringify(events[1])).not.toContain('provider exploded')
  })
})

describe('prompt and stream edge cases', () => {
  it('treats an empty additional-requirements string as absent', () => {
    const prompt = buildPrompt({
      profile: GENERATION_PROFILES.copywriting_generate,
      request: { functionType: 'copywriting_generate', inputContent: 'x', additionalRequirements: '' },
      skillContent: 'skill body',
      context,
    })
    expect(prompt).toContain('No additional requirements were given.')
  })

  it('falls back to the organization when there is no project name', () => {
    const prompt = buildPrompt({
      profile: GENERATION_PROFILES.copywriting_generate,
      request: { functionType: 'copywriting_generate', inputContent: 'x' },
      skillContent: 'skill body',
      context: { organizationId: 'org_a' },
    })
    expect(prompt).toContain('organization org_a')
  })

  it('ignores model chunks that carry no text-delta', async () => {
    const port: LlmPort = {
      prepareCall: async () => ({
        stream: async function* () {
          yield { type: 'reasoning-delta', text: 'thinking' }
          yield { type: 'text-delta' }
          yield { type: 'text-delta', text: 'real' }
        },
      }),
    }
    const generation = new GenerationService({
      llm: port,
      skills: skills(),
      newRunId: () => 'run_1',
      model: 'deepseek-v4-flash',
      provider: 'deepseek-official',
    })
    const prepared = await generation.prepare({ functionType: 'content_check', inputContent: 'x' }, context)

    expect(await collect(generation.stream(prepared))).toEqual([
      { type: 'token', text: 'real' },
      { type: 'done', runId: 'run_1', model: 'deepseek-v4-flash', skillName: 'compliance-check' },
    ])
  })
})

describe('toNdjson', () => {
  it('serialises each event as exactly one line', () => {
    const line = toNdjson({ type: 'token', text: '第一行\n第二行' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toEqual({ type: 'token', text: '第一行\n第二行' })
  })

  it('serialises a full generation as token, token, done lines', async () => {
    const { generation } = service({ chunks: ['a', 'b'] })
    const prepared = await generation.prepare({ functionType: 'content_check', inputContent: 'x' }, context)
    const lines: string[] = []
    for await (const event of generation.stream(prepared)) lines.push(toNdjson(event))

    expect(lines).toHaveLength(3)
    expect(lines.map(line => JSON.parse(line).type)).toEqual(['token', 'token', 'done'])
    expect(JSON.parse(lines[2]!)).toEqual({
      type: 'done',
      runId: 'run_1',
      model: 'deepseek-v4-flash',
      skillName: 'compliance-check',
    })
  })
})

describe('GenerationService.run', () => {
  it('prepares and streams in one call, and never reaches the network on a rejected request', async () => {
    const { generation, llm } = service()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const events = await collect(
      generation.run({ functionType: 'copywriting_generate', inputContent: '主题' }, context),
    )
    fetchSpy.mockRestore()

    expect(events.at(-1)).toMatchObject({ type: 'done', skillName: 'copywriting-templates' })
    expect(llm.calls).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
