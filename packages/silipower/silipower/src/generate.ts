import type { GenerateFunctionType, GenerateRequest, SilipowerErrorCode } from './contracts.ts'
import { generateRequestSchema } from './contracts.ts'
import { failure } from './errors.ts'

/** Model used when the composition does not name one. */
export const DEFAULT_GENERATION_MODEL = 'deepseek-v4-flash'

/** Provider used when the composition does not name one. */
export const DEFAULT_GENERATION_PROVIDER = 'deepseek-official'

/** The skill a function type is routed through. */
export interface GenerationProfile {
  readonly functionType: GenerateFunctionType
  readonly skillName: string
}

/**
 * Deterministic routing from function type to business skill.
 *
 * This table is the whole point of the generation contract: before it, the
 * endpoint forwarded whatever text it was given to one fixed model, so the
 * three registered business skills were never reached and every function type
 * produced the same shape of answer.
 *
 * Three entries name skills that land in iteration 5. They are listed rather
 * than omitted so that routing is total and an unimplemented type fails as
 * `SKILL_UNAVAILABLE` — visibly — instead of silently falling back to a generic
 * prompt that would read like a successful generation.
 */
export const GENERATION_PROFILES: Record<GenerateFunctionType, GenerationProfile> = {
  account_planning: { functionType: 'account_planning', skillName: 'account-startup-sop' },
  copywriting_analysis: { functionType: 'copywriting_analysis', skillName: 'copywriting-templates' },
  copywriting_generate: { functionType: 'copywriting_generate', skillName: 'copywriting-templates' },
  content_check: { functionType: 'content_check', skillName: 'compliance-check' },
  data_diagnosis: { functionType: 'data_diagnosis', skillName: 'analytics-diagnosis' },
  geo_outreach: { functionType: 'geo_outreach', skillName: 'geo-outreach' },
  digital_human_script: { functionType: 'digital_human_script', skillName: 'digital-human-script' },
}

/** One event on the generation stream. */
export type GenerationEvent =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'done'; readonly runId: string; readonly model: string; readonly skillName: string }
  | { readonly type: 'error'; readonly error: GenerationFailure }

/** A failure that happened after the stream had already started. */
export interface GenerationFailure {
  readonly code: SilipowerErrorCode
  readonly message: string
}

/** Project context folded into the prompt. */
export interface ProjectContext {
  readonly organizationId: string
  readonly projectName?: string
}

/** One chat message as the model port expects it. */
export interface LlmMessage {
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
}

/** One chunk from the model stream. */
export interface LlmStreamChunk {
  readonly type: string
  readonly text?: string
}

/** A prepared model call. */
export interface LlmCall {
  stream(input: { readonly messages: readonly LlmMessage[] }): AsyncIterable<LlmStreamChunk>
}

/** The model port; the composition supplies the real DeepSeek implementation. */
export interface LlmPort {
  prepareCall(options: { readonly provider: string; readonly model: string }): Promise<LlmCall>
}

/** The skill port; reads registered business skill content by name. */
export interface SkillPort {
  read(name: string): Promise<string | undefined>
}

/** What {@link GenerationService} needs from its composition. */
export interface GenerationDeps {
  readonly llm: LlmPort
  readonly skills: SkillPort
  readonly newRunId: () => string
  readonly provider: string
  readonly model: string
}

/** A validated generation, ready to stream. */
export interface PreparedGeneration {
  readonly request: GenerateRequest
  readonly profile: GenerationProfile
  readonly runId: string
  readonly prompt: string
}

/**
 * Assemble the one prompt this service ever sends.
 *
 * Built in exactly one place so the five required inputs cannot drift apart per
 * route, and labelled so a reviewer can see each one is present.
 * @param input - Profile, validated request, skill body, and project context.
 * @returns the prompt text.
 */
export function buildPrompt(input: {
  readonly profile: GenerationProfile
  readonly request: GenerateRequest
  readonly skillContent: string
  readonly context: ProjectContext
}): string {
  const requirements =
    input.request.additionalRequirements === undefined || input.request.additionalRequirements === ''
      ? 'No additional requirements were given.'
      : input.request.additionalRequirements
  const project =
    input.context.projectName === undefined
      ? `organization ${input.context.organizationId}`
      : `project ${input.context.projectName} (organization ${input.context.organizationId})`
  // Background is optional and only present when the caller had organisation
  // facts to fold in; an empty section would just invite the model to invent
  // something to put in it.
  const background =
    input.request.context === undefined || input.request.context === ''
      ? []
      : ['', '## Background', input.request.context]

  return [
    `## Skill: ${input.profile.skillName}`,
    input.skillContent,
    '',
    '## Function',
    input.profile.functionType,
    '',
    '## Input',
    input.request.inputContent,
    '',
    '## Additional requirements',
    requirements,
    '',
    '## Project context',
    project,
    ...background,
  ].join('\n')
}

/**
 * The public description of what generation supports.
 *
 * Deliberately narrow: the function types and the skills they route through.
 * It must never grow to include the provider, the model credential reference,
 * environment values, or any filesystem path — a meta endpoint is the easiest
 * place for an internal detail to leak.
 * @returns the capability payload.
 */
export function metaPayload(): {
  readonly functionTypes: readonly { readonly functionType: GenerateFunctionType; readonly skillName: string }[]
} {
  return {
    functionTypes: Object.values(GENERATION_PROFILES).map(profile => ({
      functionType: profile.functionType,
      skillName: profile.skillName,
    })),
  }
}

/**
 * Serialise one event as a single NDJSON line.
 * @param event - The event.
 * @returns the line, including its trailing newline.
 */
export function toNdjson(event: GenerationEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Routes a validated generation request through a business skill to a model.
 *
 * `prepare` does everything that can fail — validation, routing, skill lookup,
 * prompt assembly — so those failures are ordinary thrown errors the HTTP layer
 * can answer as JSON. Only a failure after tokens have started reaches the
 * client as an `error` event, because by then the status line is already sent.
 */
export class GenerationService {
  /**
   * @param deps - Model port, skill port, run id source, and provider/model names.
   */
  constructor(private readonly deps: GenerationDeps) {}

  /**
   * Resolve the profile for a function type.
   * @param functionType - The wire function type.
   * @returns the profile.
   * @throws SilipowerFailure `VALIDATION_ERROR` for an unknown type.
   */
  resolveProfile(functionType: string): GenerationProfile {
    const profile = (GENERATION_PROFILES as Record<string, GenerationProfile | undefined>)[functionType]
    if (profile === undefined) throw failure('VALIDATION_ERROR', `unknown function type ${functionType}`)
    return profile
  }

  /**
   * Validate, route, and assemble the prompt.
   * @param request - The request body as received.
   * @param context - The acting project context.
   * @returns everything the stream needs.
   * @throws SilipowerFailure `VALIDATION_ERROR`, or `SKILL_UNAVAILABLE` when the
   * routed skill is not registered.
   */
  async prepare(request: GenerateRequest, context: ProjectContext): Promise<PreparedGeneration> {
    const parsed = generateRequestSchema.safeParse(request)
    if (!parsed.success) {
      throw failure(
        'VALIDATION_ERROR',
        parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      )
    }

    const profile = this.resolveProfile(parsed.data.functionType)
    const skillContent = await this.deps.skills.read(profile.skillName)
    if (skillContent === undefined) {
      throw failure('SKILL_UNAVAILABLE', `skill ${profile.skillName} is not registered`)
    }

    return {
      request: parsed.data,
      profile,
      runId: this.deps.newRunId(),
      prompt: buildPrompt({ profile, request: parsed.data, skillContent, context }),
    }
  }

  /**
   * Stream one prepared generation.
   * @param prepared - The result of {@link prepare}.
   * @returns token events, then exactly one `done`, or one `error` if the model
   * fails after tokens have begun.
   */
  async *stream(prepared: PreparedGeneration): AsyncIterable<GenerationEvent> {
    const call = await this.deps.llm.prepareCall({ provider: this.deps.provider, model: this.deps.model })
    try {
      for await (const chunk of call.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: prepared.prompt }] }],
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          yield { type: 'token', text: chunk.text }
        }
      }
    } catch {
      // The provider's own message can name endpoints or models, so the client
      // gets a fixed one. The composition logs the cause.
      yield { type: 'error', error: { code: 'INTERNAL_ERROR', message: 'generation failed' } }
      return
    }

    yield {
      type: 'done',
      runId: prepared.runId,
      model: this.deps.model,
      skillName: prepared.profile.skillName,
    }
  }

  /**
   * Prepare then stream.
   * @param request - The request body as received.
   * @param context - The acting project context.
   * @returns the generation event stream.
   */
  async *run(request: GenerateRequest, context: ProjectContext): AsyncIterable<GenerationEvent> {
    yield* this.stream(await this.prepare(request, context))
  }
}
