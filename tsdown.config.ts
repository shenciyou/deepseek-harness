import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * Silipower content/runtime directories under `packages/silipower` that are not
 * build packages: they ship skill markdown and future business modules, and the
 * workspace glob must skip them until each one owns a package.json and tsconfig.
 */
const NON_BUILD_WORKSPACE_DIRS = [
  '!packages/silipower/api',
  '!packages/silipower/knowledge',
  '!packages/silipower/skill-content',
  '!packages/silipower/stats',
]

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', 'apps/cli', ...NON_BUILD_WORKSPACE_DIRS]
      : ['vendor/*', 'packages/*/*', 'apps/cli', 'apps/desktop', 'apps/desktop-host', ...NON_BUILD_WORKSPACE_DIRS],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
