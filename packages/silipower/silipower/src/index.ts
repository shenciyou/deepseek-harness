import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DEV_ACTORS_ENV, readHeader, type RequestHeaders } from './auth.ts'
import {
  DEFAULT_GENERATION_MODEL,
  DEFAULT_GENERATION_PROVIDER,
  GenerationService,
  metaPayload,
  type LlmPort,
  type ProjectContext,
  type SkillPort,
} from './generate.ts'
import { corsHeaders, handleGenerateRequest, type GenerateOutcome } from './http.ts'
import { silipowerDomainSpec } from './spec.ts'
import type { Material } from './spec.ts'

export const name = '@silipower/dsh-silipower'

declare module '@deepseek-ai/cordis' {
  interface Context {
    silipower: SilipowerService
  }
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (cause) {
        reject(new Error('invalid JSON body', { cause }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Parse the comma-separated CORS allow list.
 *
 * Blank entries are dropped rather than interpreted as "any", so a trailing
 * comma or an empty variable narrows the list instead of opening it.
 * @param raw - The raw `SILIPOWER_ALLOWED_ORIGINS` value.
 * @returns the allowed origins.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin !== '')
}

/**
 * Adapt the DSH LLM service to the generation port.
 *
 * The prepared call pins one adapter generation, and `stream` refuses a request
 * whose config differs from the prepared one, so the resolved config is replayed
 * verbatim. The generation port's small message shape is translated here rather
 * than in `generate.ts`, which must stay independent of the harness.
 * @param ctx - The plugin context.
 * @returns the LLM port.
 */
function llmPort(ctx: Context): LlmPort {
  return {
    prepareCall: async ({ provider, model }) => {
      const call = await ctx.llm.prepareCall({ provider, model })
      return {
        stream: input => call.stream({
          ...call.config,
          messages: input.messages.map(message => createUserMessage({
            content: [...message.content],
            source: { kind: 'user' },
          })),
        }),
      }
    },
  }
}

/**
 * Adapt the DSH skill registry to the generation port.
 * @param skills - The skill registry.
 * @returns the skill port.
 */
function skillPort(skills: SkillRegistryLike): SkillPort {
  return {
    read: async name => (await skills.get(name))?.content,
  }
}

/**
 * Write a generate outcome onto the transport.
 *
 * A rejected request is buffered JSON and can still choose its status. A stream
 * has already sent its status line, so a failure past that point is appended as
 * one `error` event — which the generation service already emits — and never
 * rewrites the status.
 * @param res - The response to write.
 * @param outcome - The handler result.
 */
async function writeOutcome(res: ServerResponse, outcome: GenerateOutcome): Promise<void> {
  res.writeHead(outcome.status, outcome.headers)
  if (outcome.kind === 'json') {
    res.end(outcome.body === undefined ? undefined : JSON.stringify(outcome.body))
    return
  }
  try {
    for await (const line of outcome.lines) res.write(line)
  } catch (error) {
    console.error('[silipower] generation stream failed after headers were sent', error)
  }
  res.end()
}

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface WebRuntimeLike {
  search(request: { query: string; maxResults?: number }): Promise<unknown>
}

/** The part of a registered skill the generation port reads. */
interface SkillDefinitionLike {
  readonly content: string
}

interface SkillRegistryLike {
  list(): Promise<unknown>
  get(name: string): Promise<SkillDefinitionLike | undefined>
}

interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
  readImage(ref: unknown): Promise<{ ref: unknown; data: Uint8Array }>
}

interface SessionQueryLike {
  searchSessions(request: { query: string; limit?: number }): Promise<unknown>
}

/** Silipower business API: durable knowledge plus a thin HTTP bridge for the React app. */
export class SilipowerService extends TypertRemoteService {
  static inject = ['storageDomain', 'webServer', 'llm', 'web', 'skills', 'attachments', 'sessionQuery']

  private materials?: KvTable<string, Material>
  private generation?: GenerationService

  constructor(ctx: Context) {
    super(ctx, 'silipower')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(silipowerDomainSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'silipower.domainClose')
    this.materials = domain.table('materials')

    this.generation = new GenerationService({
      llm: llmPort(this.ctx),
      skills: skillPort(this.requireSkills()),
      newRunId: () => `run_${randomUUID()}`,
      provider: DEFAULT_GENERATION_PROVIDER,
      model: DEFAULT_GENERATION_MODEL,
    })

    const origins = parseAllowedOrigins(process.env.SILIPOWER_ALLOWED_ORIGINS)
    const cors = (req: IncomingMessage): Record<string, string> =>
      corsHeaders(readHeader(req.headers as RequestHeaders, 'origin'), origins)
    const reply = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) })
      res.end(JSON.stringify(value))
    }
    const preflight = (req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(204, cors(req))
      res.end()
    }

    const disposeHealth = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/health',
      handler: (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        reply(req, res, 200, { ok: true, service: 'silipower-dsh-api' })
      },
    })

    const disposeMeta = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/meta',
      handler: (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        if (req.method !== 'GET') return reply(req, res, 405, { ok: false, error: 'method not allowed' })
        reply(req, res, 200, { ok: true, value: metaPayload() })
      },
    })

    const disposeGenerate = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/generate',
      handler: async (req, res) => {
        const outcome = await handleGenerateRequest({
          method: req.method ?? 'GET',
          headers: req.headers as RequestHeaders,
          rawBody: await readRawBody(req),
          nodeEnv: process.env.NODE_ENV,
          devActors: process.env[DEV_ACTORS_ENV],
          allowedOrigins: origins,
          requestId: `req_${randomUUID()}`,
          generation: this.requireGeneration(),
          context: (scope): ProjectContext => ({ organizationId: scope.organizationId }),
        })
        await writeOutcome(res, outcome)
      },
    })

    const disposeMaterials = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/materials',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          if (req.method === 'GET') {
            return reply(req, res, 200, { ok: true, value: await this.listMaterials() })
          }
          if (req.method === 'POST') {
            const body = (await readJson(req)) as Material | undefined
            if (body === undefined) return reply(req, res, 400, { ok: false, error: 'missing material body' })
            return reply(req, res, 200, { ok: true, value: await this.saveMaterial(body) })
          }
          reply(req, res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeStats = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/stats',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          reply(req, res, 200, { ok: true, value: await this.stats() })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSearch = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/search',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          const body = (await readJson(req) ?? {}) as { query?: string; maxResults?: number }
          reply(req, res, 200, { ok: true, value: await this.searchWeb(body.query ?? '', body.maxResults) })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSkills = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/skills',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          if (req.method !== 'GET') return reply(req, res, 405, { ok: false, error: 'method not allowed' })
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          if (pathname === '/api/silipower/skills') {
            return reply(req, res, 200, { ok: true, value: await this.listSkills() })
          }
          const skillName = decodeURIComponent(pathname.slice('/api/silipower/skills/'.length))
          if (skillName === '') return reply(req, res, 400, { ok: false, error: 'missing skill name' })
          reply(req, res, 200, { ok: true, value: (await this.getSkill(skillName)) ?? null })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeAttachments = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/attachments',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          if (req.method === 'POST' && pathname === '/api/silipower/attachments') {
            const body = (await readJson(req)) as { mediaType?: string; dataBase64?: string; name?: string } | undefined
            if (body === undefined || typeof body.mediaType !== 'string' || typeof body.dataBase64 !== 'string') {
              return reply(req, res, 400, { ok: false, error: 'mediaType and dataBase64 are required' })
            }
            const value = await this.saveAttachment({
              data: new Uint8Array(Buffer.from(body.dataBase64, 'base64')),
              mediaType: body.mediaType,
              ...(body.name === undefined ? {} : { name: body.name }),
            })
            return reply(req, res, 200, { ok: true, value })
          }
          if (req.method === 'POST' && pathname === '/api/silipower/attachments/read') {
            const body = (await readJson(req)) as Record<string, unknown> | undefined
            if (body === undefined || typeof body.attachmentId !== 'string') {
              return reply(req, res, 400, { ok: false, error: 'attachment ref is required' })
            }
            return reply(req, res, 200, { ok: true, value: await this.readAttachment(body) })
          }
          reply(req, res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSessionSearch = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/session-search',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return preflight(req, res)
        try {
          const body = (await readJson(req) ?? {}) as { query?: string; limit?: number }
          reply(req, res, 200, { ok: true, value: await this.searchSessions(body.query ?? '', body.limit) })
        } catch (error) {
          reply(req, res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    this.ctx.effect(() => () => {
      disposeHealth()
      disposeMeta()
      disposeGenerate()
      disposeMaterials()
      disposeStats()
      disposeSearch()
      disposeSkills()
      disposeAttachments()
      disposeSessionSearch()
    })
  }

  @Remote('health')
  async health(): Promise<{ ok: boolean; service: string }> {
    return { ok: true, service: 'silipower-dsh-api' }
  }

  @Remote('listMaterials')
  async listMaterials(): Promise<Material[]> {
    return [...this.requireMaterials().entries()].map(([, material]) => material)
  }

  @Remote('saveMaterial')
  async saveMaterial(material: Material): Promise<Material> {
    await this.requireMaterials().put(material.id, material)
    return material
  }

  @Remote('stats')
  async stats(): Promise<{ materialCount: number; generatedToday: number }> {
    const materials = await this.listMaterials()
    const today = new Date().toISOString().slice(0, 10)
    return {
      materialCount: materials.length,
      generatedToday: materials.filter(material => new Date(material.createdAt).toISOString().slice(0, 10) === today).length,
    }
  }

  @Remote('searchWeb')
  async searchWeb(query: string, maxResults?: number): Promise<unknown> {
    return this.requireWeb().search({ query, ...(maxResults !== undefined ? { maxResults } : {}) })
  }

  @Remote('listSkills')
  async listSkills(): Promise<unknown> {
    return this.requireSkills().list()
  }

  @Remote('getSkill')
  async getSkill(name: string): Promise<unknown> {
    return this.requireSkills().get(name)
  }

  @Remote('saveAttachment')
  async saveAttachment(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown> {
    return this.requireAttachments().saveImage(input)
  }

  @Remote('readAttachment')
  async readAttachment(ref: unknown): Promise<{ ref: unknown; dataBase64: string }> {
    const stored = await this.requireAttachments().readImage(ref)
    return { ref: stored.ref, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  @Remote('searchSessions')
  async searchSessions(query: string, limit?: number): Promise<unknown> {
    return this.requireSessionQuery().searchSessions({ query, ...(limit !== undefined ? { limit } : {}) })
  }

  private requireGeneration(): GenerationService {
    if (this.generation === undefined) throw new Error('silipower generation service is not initialized')
    return this.generation
  }

  private requireMaterials(): KvTable<string, Material> {
    if (this.materials === undefined) throw new Error('silipower domain is not initialized')
    return this.materials
  }

  private requireWeb(): WebRuntimeLike {
    const service = this.ctx.get('web')
    if (service === undefined) throw new Error('web service is unavailable in this profile')
    return service as WebRuntimeLike
  }

  private requireSkills(): SkillRegistryLike {
    const service = this.ctx.get('skills')
    if (service === undefined) throw new Error('skills service is unavailable in this profile')
    return service as SkillRegistryLike
  }

  private requireAttachments(): AttachmentStoreLike {
    const service = this.ctx.get('attachments')
    if (service === undefined) throw new Error('attachments service is unavailable in this profile')
    return service as AttachmentStoreLike
  }

  private requireSessionQuery(): SessionQueryLike {
    const service = this.ctx.get('sessionQuery')
    if (service === undefined) throw new Error('sessionQuery service is unavailable in this profile')
    return service as SessionQueryLike
  }
}

export default SilipowerService
