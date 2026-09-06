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

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Silipower business API: durable knowledge plus a thin HTTP bridge for the React app. */
export class SilipowerService extends TypertRemoteService {
  static inject = ['storageDomain', 'webServer', 'llm']

  private materials?: KvTable<string, Material>
  private publishRecords?: KvTable<string, PublishRecord>

  constructor(ctx: Context) {
    super(ctx, 'silipower')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(silipowerDomainSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'silipower.domainClose')
    this.materials = domain.table('materials')
    this.publishRecords = domain.table('publishRecords')

    const disposeHealth = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/health',
      handler: (_req, res) => { sendJson(res, 200, { ok: true, service: 'silipower-dsh-api' }) },
    })

    const disposeGenerate = this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/silipower/generate',
      handler: async (req, res) => {
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
      handler: async (_req, res) => {
        try {
          sendJson(res, 200, { ok: true, value: await this.stats() })
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

  private requireMaterials(): KvTable<string, Material> {
    if (this.materials === undefined) throw new Error('silipower domain is not initialized')
    return this.materials
  }

  private async generateText(input: string): Promise<string> {
    const call = await this.ctx.llm.prepareCall({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL })
    let output = ''
    for await (const chunk of call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
    }
    return output
  }
}

export default SilipowerService
