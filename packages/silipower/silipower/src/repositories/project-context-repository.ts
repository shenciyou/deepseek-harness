import type { RequestScope } from '../auth.ts'
import { companyPatchSchema, founderPatchSchema } from '../contracts.ts'
import { failure } from '../errors.ts'
import type { Company, Founder, Project } from '../spec.ts'
import { ScopedRepository, validationFailure, type KvLike, type OwnedRecord, type WriteObserver } from './base.ts'
import { ProjectRepository, type ProjectRepositoryOptions } from './project-repository.ts'

/**
 * What every organization singleton is missing before its first write.
 *
 * A company profile or founder persona that has never been edited still has to
 * render, so the first write fills the gaps rather than forcing the client to
 * invent placeholder text the server would then own.
 */
const COMPANY_DEFAULTS = {
  name: '未命名企业',
  description: '',
  businessScope: [] as string[],
  advantages: [] as string[],
  slogan: '',
  pricingInfo: '',
}

const FOUNDER_DEFAULTS = {
  name: '未命名创始人',
  resume: '',
  personaTags: [] as string[],
  personalStory: '',
  goldenQuotes: [] as string[],
  speakingStyle: '',
}

/** Name of the project an organization is provisioned with. */
export const DEFAULT_PROJECT_NAME = '默认项目'

/** What an organization-singleton repository needs from its owner. */
export interface SingletonOptions<T extends OwnedRecord> {
  readonly table: KvLike<T>
  readonly now: () => string
  readonly newId: () => string
  readonly onWrite: WriteObserver<T>
}

/**
 * The organization's company profile: exactly one record per organization.
 *
 * `get` answers `undefined` rather than throwing when nothing is stored yet —
 * "not configured" is a normal first-run state, not an error, and the caller
 * decides whether to show an empty form.
 */
export class CompanyRepository {
  private readonly base: ScopedRepository<Company>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: SingletonOptions<Company>) {
    this.base = new ScopedRepository<Company>({ resource: 'company', ...options })
  }

  /**
   * The organization's company profile, if it has one.
   * @param scope - The acting scope.
   * @returns the profile, or `undefined`.
   */
  get(scope: RequestScope): Company | undefined {
    return this.base.list(scope)[0]
  }

  /**
   * Write the profile, creating it on the first edit.
   * @param scope - The acting scope.
   * @param input - The fields to change, unvalidated.
   * @returns the stored profile.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async upsert(scope: RequestScope, input: unknown): Promise<Company> {
    const parsed = companyPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const current = this.get(scope)
    if (current === undefined) {
      return this.base.create(scope, base => Object.assign({}, COMPANY_DEFAULTS, base, parsed.data))
    }
    if (Object.keys(parsed.data).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    return this.base.patch(scope, current.id, cur => Object.assign({}, cur, parsed.data))
  }
}

/** The founder persona, also exactly one record per organization. */
export class FounderRepository {
  private readonly base: ScopedRepository<Founder>

  /**
   * @param options - Table, clock, id source, and the audit hook.
   */
  constructor(options: SingletonOptions<Founder>) {
    this.base = new ScopedRepository<Founder>({ resource: 'founder', ...options })
  }

  /**
   * The organization's founder persona, if it has one.
   * @param scope - The acting scope.
   * @returns the persona, or `undefined`.
   */
  get(scope: RequestScope): Founder | undefined {
    return this.base.list(scope)[0]
  }

  /**
   * Write the persona, creating it on the first edit.
   * @param scope - The acting scope.
   * @param input - The fields to change, unvalidated.
   * @returns the stored persona.
   * @throws SilipowerFailure `VALIDATION_ERROR` for a body the contract rejects.
   */
  async upsert(scope: RequestScope, input: unknown): Promise<Founder> {
    const parsed = founderPatchSchema.safeParse(input)
    if (!parsed.success) throw validationFailure(parsed.error)
    const current = this.get(scope)
    if (current === undefined) {
      return this.base.create(scope, base => Object.assign({}, FOUNDER_DEFAULTS, base, parsed.data))
    }
    if (Object.keys(parsed.data).length === 0) {
      throw failure('VALIDATION_ERROR', 'patch must change at least one field')
    }
    return this.base.patch(scope, current.id, cur => Object.assign({}, cur, parsed.data))
  }
}

/** What {@link ProjectContextRepository} needs from its owner. */
export interface ProjectContextOptions {
  readonly company: SingletonOptions<Company>
  readonly founder: SingletonOptions<Founder>
  readonly projects: ProjectRepositoryOptions
}

/**
 * The organization's project boundary: its profile, its persona, and its
 * projects.
 *
 * Everything the app produces hangs off a project, so an organization without
 * one cannot use the product at all. {@link ensureDefaultProject} is the
 * provisioning step that guarantees the boundary exists; it is idempotent, so
 * calling it on every list is safe.
 */
export class ProjectContextRepository {
  /** The organization's company profile. */
  readonly company: CompanyRepository
  /** The organization's founder persona. */
  readonly founder: FounderRepository
  /** The organization's projects. */
  readonly projects: ProjectRepository

  /**
   * @param options - The three tables and their shared clock, id source and audit hook.
   */
  constructor(options: ProjectContextOptions) {
    this.company = new CompanyRepository(options.company)
    this.founder = new FounderRepository(options.founder)
    this.projects = new ProjectRepository(options.projects)
  }

  /**
   * Every project the caller owns, provisioning a default on first use.
   * @param scope - The acting scope.
   * @returns the projects, newest first, never empty.
   */
  async listProjects(scope: RequestScope): Promise<Project[]> {
    await this.ensureDefaultProject(scope)
    return this.projects.list(scope)
  }

  /**
   * Give the organization a project if it has none.
   * @param scope - The acting scope.
   * @returns the default project when one was created, else `undefined`.
   */
  async ensureDefaultProject(scope: RequestScope): Promise<Project | undefined> {
    if (this.projects.list(scope).length > 0) return undefined
    return this.projects.create(scope, {
      name: DEFAULT_PROJECT_NAME,
      description: '系统创建的默认项目，可重命名',
      category: '通用',
    })
  }
}
