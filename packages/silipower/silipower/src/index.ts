import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DEV_ACTORS_ENV, readHeader, type RequestHeaders, type RequestScope } from './auth.ts'
import { AuditLog } from './audit.ts'
import {
  DEFAULT_GENERATION_MODEL,
  DEFAULT_GENERATION_PROVIDER,
  GenerationService,
  metaPayload,
  type LlmPort,
  type ProjectContext,
  type SkillPort,
} from './generate.ts'
import { corsHeaders, handleGenerateRequest, handleRoute, parseJsonBody, type GenerateOutcome, type RouteResponse } from './http.ts'
import { MaterialRepository } from './repositories/material-repository.ts'
import { ProjectContextRepository } from './repositories/project-context-repository.ts'
import { PublishRecordRepository } from './repositories/publish-record-repository.ts'
import { TaskRepository } from './repositories/task-repository.ts'
import type { AuditAction } from './repositories/base.ts'
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

const MATERIALS_PATH = '/api/silipower/materials'
const CONTENT_TASKS_PATH = '/api/silipower/content-tasks'
const PUBLISH_RECORDS_PATH = '/api/silipower/publish-records'
const PROJECTS_PATH = '/api/silipower/projects'
const COMPANY_PATH = '/api/silipower/company'
const FOUNDER_PATH = '/api/silipower/founder'

/** A handler may answer synchronously or after a read. */
type MaybePromise<T> = T | Promise<T>

/**
 * The CRUD surface every scoped resource repository exposes to the router.
 *
 * Structural rather than an interface each repository implements, so a
 * repository keeps its own narrower return types and still registers here.
 */
interface ResourceRepository {
  query(
    scope: RequestScope,
    rawQuery: unknown,
  ): MaybePromise<{ readonly items: readonly unknown[]; readonly nextCursor?: string }>
  get(scope: RequestScope, id: string): unknown
  create(scope: RequestScope, input: unknown): Promise<unknown>
  patch(scope: RequestScope, id: string, input: unknown): Promise<unknown>
  remove(scope: RequestScope, id: string): Promise<void>
}

/** The read/write surface of an organization singleton (company, founder). */
interface SingletonResource {
  get(scope: RequestScope): unknown
  upsert(scope: RequestScope, input: unknown): Promise<unknown>
}

/**
 * Read the record id off a request path.
 * @param basePath - The collection path, without a trailing slash.
 * @param url - The raw request URL.
 * @returns the id, or `undefined` when the path names the collection itself.
 */
function resourceIdFromUrl(basePath: string, url: string | undefined): string | undefined {
  const pathname = new URL(url ?? '/', 'http://x').pathname
  if (!pathname.startsWith(`${basePath}/`)) return undefined
  const id = decodeURIComponent(pathname.slice(basePath.length + 1))
  return id === '' ? undefined : id
}

/**
 * Read the list filters off the query string.
 *
 * The values stay strings here; each repository's schema is the one place that
 * coerces and range-checks them, so an invalid filter is a `VALIDATION_ERROR`
 * with the same shape as any other bad input. Keys a schema does not name are
 * dropped by that schema.
 * @param url - The raw request URL.
 * @returns the raw filter values that were present.
 */
function queryFromUrl(url: string | undefined): Record<string, string> {
  const params = new URL(url ?? '/', 'http://x').searchParams
  const query: Record<string, string> = {}
  for (const [key, value] of params) query[key] = value
  return query
}

/**
 * Write a route response produced by {@link handleRoute}.
 * @param res - The response to write.
 * @param response - The handler result.
 */
function writeRouteResponse(res: ServerResponse, response: RouteResponse): void {
  res.writeHead(response.status, response.headers)
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body))
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
  private materialRepository?: MaterialRepository
  private publishRecordRepository?: PublishRecordRepository
  private taskRepository?: TaskRepository
  private projectContext?: ProjectContextRepository
  private generation?: GenerationService

  constructor(ctx: Context) {
    super(ctx, 'silipower')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(silipowerDomainSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'silipower.domainClose')
    this.materials = domain.table('materials')

    const audit = new AuditLog(domain.table('audit_events'), {
      newId: () => randomUUID(),
      now: () => new Date().toISOString(),
    })
    const onWrite = async (
      action: AuditAction,
      resource: string,
      record: { readonly id: string },
      scope: RequestScope,
    ): Promise<void> => {
      await audit.write({
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        resource,
        resourceId: record.id,
        action,
      })
    }
    this.materialRepository = new MaterialRepository({
      table: this.requireMaterials(),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      onWrite,
    })
    this.publishRecordRepository = new PublishRecordRepository({
      table: domain.table('publish_records'),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      onWrite,
      materials: this.requireMaterialRepository(),
    })
    this.taskRepository = new TaskRepository({
      table: domain.table('content_tasks'),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      onWrite,
    })
    this.projectContext = new ProjectContextRepository({
      company: { table: domain.table('companies'), now: () => new Date().toISOString(), newId: () => randomUUID(), onWrite },
      founder: { table: domain.table('founders'), now: () => new Date().toISOString(), newId: () => randomUUID(), onWrite },
      projects: { table: domain.table('projects'), now: () => new Date().toISOString(), newId: () => randomUUID(), onWrite },
    })

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

    const registerResource = (
      basePath: string,
      repository: () => ResourceRepository,
      options: { readonly allowDelete?: boolean } = {},
    ): (() => void) =>
      this.ctx.webServer.register({
        kind: 'prefix',
        path: basePath,
        handler: async (req, res) => {
          const rawBody = await readRawBody(req)
          const id = resourceIdFromUrl(basePath, req.url)
          // The method set depends on whether the path names one record, so the
          // generic boundary still rejects a method the path does not accept.
          const itemMethods =
            options.allowDelete === false ? ['GET', 'PATCH'] : ['GET', 'PATCH', 'DELETE']
          const response = await handleRoute({
            request: { method: req.method ?? 'GET', headers: req.headers as RequestHeaders },
            allowedMethods: id === undefined ? ['GET', 'POST'] : itemMethods,
            allowedOrigins: origins,
            requestId: `req_${randomUUID()}`,
            nodeEnv: process.env.NODE_ENV,
            devActors: process.env[DEV_ACTORS_ENV],
            handler: async ({ scope }) => {
              const resource = repository()
              if (id === undefined) {
                if (req.method === 'GET') return resource.query(scope, queryFromUrl(req.url))
                return resource.create(scope, parseJsonBody(rawBody))
              }
              if (req.method === 'GET') return resource.get(scope, id)
              if (req.method === 'PATCH') return resource.patch(scope, id, parseJsonBody(rawBody))
              await resource.remove(scope, id)
              return { id }
            },
          })
          writeRouteResponse(res, response)
        },
      })

    /** A route for a value that exists once per organization. */
    const registerSingleton = (basePath: string, resource: () => SingletonResource): (() => void) =>
      this.ctx.webServer.register({
        kind: 'exact',
        path: basePath,
        handler: async (req, res) => {
          const rawBody = await readRawBody(req)
          const response = await handleRoute({
            request: { method: req.method ?? 'GET', headers: req.headers as RequestHeaders },
            allowedMethods: ['GET', 'PATCH'],
            allowedOrigins: origins,
            requestId: `req_${randomUUID()}`,
            nodeEnv: process.env.NODE_ENV,
            devActors: process.env[DEV_ACTORS_ENV],
            handler: async ({ scope }) => {
              const singleton = resource()
              // `null` rather than an error: the caller renders an empty form.
              if (req.method === 'GET') return singleton.get(scope) ?? null
              return singleton.upsert(scope, parseJsonBody(rawBody))
            },
          })
          writeRouteResponse(res, response)
        },
      })

    const disposeMaterials = registerResource(MATERIALS_PATH, () => this.requireMaterialRepository())
    const disposeTasks = registerResource(CONTENT_TASKS_PATH, () => this.requireTaskRepository())
    const disposePublishRecords = registerResource(
      PUBLISH_RECORDS_PATH,
      () => this.requirePublishRecordRepository(),
    )
    const disposeProjects = registerResource(
      PROJECTS_PATH,
      () => {
        const context = this.requireProjectContext()
        return {
          // Listing provisions the organization's default project, so the app
          // always has a boundary to hang content off.
          query: async (scope: RequestScope) => ({ items: await context.listProjects(scope) }),
          get: (scope, id) => context.projects.get(scope, id),
          create: (scope, input) => context.projects.create(scope, input),
          patch: (scope, id, input) => context.projects.patch(scope, id, input),
          remove: (scope, id) => context.projects.remove(scope, id),
        }
      },
      { allowDelete: false },
    )
    const disposeCompany = registerSingleton(COMPANY_PATH, () => this.requireProjectContext().company)
    const disposeFounder = registerSingleton(FOUNDER_PATH, () => this.requireProjectContext().founder)

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
      disposeTasks()
      disposePublishRecords()
      disposeProjects()
      disposeCompany()
      disposeFounder()
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

  private requireMaterialRepository(): MaterialRepository {
    if (this.materialRepository === undefined) throw new Error('silipower material repository is not initialized')
    return this.materialRepository
  }

  private requirePublishRecordRepository(): PublishRecordRepository {
    if (this.publishRecordRepository === undefined) {
      throw new Error('silipower publish record repository is not initialized')
    }
    return this.publishRecordRepository
  }

  private requireTaskRepository(): TaskRepository {
    if (this.taskRepository === undefined) throw new Error('silipower task repository is not initialized')
    return this.taskRepository
  }

  private requireProjectContext(): ProjectContextRepository {
    if (this.projectContext === undefined) throw new Error('silipower project context is not initialized')
    return this.projectContext
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
