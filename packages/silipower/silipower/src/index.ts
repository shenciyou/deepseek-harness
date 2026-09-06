import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { silipowerDomainSpec } from './spec.ts'
import type { Material, PublishRecord } from './spec.ts'

export const name = '@silipower/dsh-silipower'

const DEFAULT_PROVIDER = 'deepseek-official'
const DEFAULT_MODEL = 'deepseek-v4-flash'

declare module '@deepseek-ai/cordis' {
  interface Context {
    silipower: SilipowerService
  }
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

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() })
  res.end(JSON.stringify(value))
}

function sendPreflight(res: ServerResponse): void {
  res.writeHead(204, corsHeaders())
  res.end()
}

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface WebRuntimeLike {
  search(request: { query: string; maxResults?: number }): Promise<unknown>
}

interface SkillRegistryLike {
  list(): Promise<unknown>
  get(name: string): Promise<unknown>
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
  private publishRecords?: KvTable<string, PublishRecord>

  constructor(ctx: Context) {
    super(ctx, 'silipower')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(silipowerDomainSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'silipower.domainClose')
    this.materials = domain.table('materials')
    this.publishRecords = domain.table('publish_records')

    const disposeHealth = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/health',
      handler: (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        sendJson(res, 200, { ok: true, service: 'silipower-dsh-api' })
      },
    })

    const disposeGenerate = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/generate',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          const body = (await readJson(req) ?? {}) as { content?: string }
          const content = await this.generateText(body.content ?? '')
          sendJson(res, 200, { ok: true, content })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeMaterials = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/materials',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, value: await this.listMaterials() })
          }
          if (req.method === 'POST') {
            const body = (await readJson(req)) as Material | undefined
            if (body === undefined) return sendJson(res, 400, { ok: false, error: 'missing material body' })
            return sendJson(res, 200, { ok: true, value: await this.saveMaterial(body) })
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeStats = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/stats',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          sendJson(res, 200, { ok: true, value: await this.stats() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSearch = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/search',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          const body = (await readJson(req) ?? {}) as { query?: string; maxResults?: number }
          sendJson(res, 200, { ok: true, value: await this.searchWeb(body.query ?? '', body.maxResults) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSkills = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/skills',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          if (pathname === '/api/silipower/skills') {
            return sendJson(res, 200, { ok: true, value: await this.listSkills() })
          }
          const name = decodeURIComponent(pathname.slice('/api/silipower/skills/'.length))
          if (name === '') return sendJson(res, 400, { ok: false, error: 'missing skill name' })
          sendJson(res, 200, { ok: true, value: (await this.getSkill(name)) ?? null })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeAttachments = this.ctx.webServer.register({
      kind: 'prefix',
      path: '/api/silipower/attachments',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          if (req.method === 'POST' && pathname === '/api/silipower/attachments') {
            const body = (await readJson(req)) as { mediaType?: string; dataBase64?: string; name?: string } | undefined
            if (body === undefined || typeof body.mediaType !== 'string' || typeof body.dataBase64 !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'mediaType and dataBase64 are required' })
            }
            const value = await this.saveAttachment({
              data: new Uint8Array(Buffer.from(body.dataBase64, 'base64')),
              mediaType: body.mediaType,
              name: body.name,
            })
            return sendJson(res, 200, { ok: true, value })
          }
          if (req.method === 'POST' && pathname === '/api/silipower/attachments/read') {
            const body = (await readJson(req)) as Record<string, unknown> | undefined
            if (body === undefined || typeof body.attachmentId !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'attachment ref is required' })
            }
            return sendJson(res, 200, { ok: true, value: await this.readAttachment(body) })
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    const disposeSessionSearch = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/session-search',
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') return sendPreflight(res)
        try {
          const body = (await readJson(req) ?? {}) as { query?: string; limit?: number }
          sendJson(res, 200, { ok: true, value: await this.searchSessions(body.query ?? '', body.limit) })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorOf(error) })
        }
      },
    })

    this.ctx.effect(() => () => {
      disposeHealth()
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
    return [...(this.requireMaterials().entries())].map(([, material]) => material)
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

  private async generateText(input: string): Promise<string> {
    const call = await this.ctx.llm.prepareCall({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL })
    let output = ''
    for await (const chunk of call.stream({
      ...call.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
    }
    return output
  }
}

export default SilipowerService
