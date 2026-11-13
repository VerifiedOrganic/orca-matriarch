#!/usr/bin/env node
// Writes Orca's plugin typings into .orca/types for `tsc`. With Orca installed this is
// `orca plugin types .`. Without it (CI), it downloads the same files from the Orca repository at
// the version in package.json's `config.orcaVersion` (or ORCA_VERSION) and writes the same layout.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const BASE = 'https://raw.githubusercontent.com/stablyai/orca'
// What `orca plugin types` writes, and where each comes from in the Orca repository.
const ORCA_MODULE = ['orca.d.ts', 'orca-components.d.ts', 'orca-components-layout.d.ts', 'orca-components-data.d.ts'].map((f) => `resources/plugins/declarative/${f}`)
const SURFACES = ['orca-host', 'orca-frame', 'orca-worker', 'orca-services', 'orca-testing']
const TSCONFIG = {
  compilerOptions: {
    strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    allowImportingTsExtensions: true, isolatedModules: true, jsx: 'react-jsx', jsxImportSource: 'orca',
    lib: ['ES2022', 'DOM'], preserveSymlinks: true, typeRoots: ['.'], types: ['orca', ...SURFACES]
  }
}

function fromCli() {
  try {
    execFileSync('orca', ['plugin', 'types', '.', '--json'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function get(tag, path) {
  const res = await fetch(`${BASE}/${tag}/${path}`)
  if (!res.ok) throw new Error(`${path} at ${tag}: HTTP ${res.status}`)
  return res.text()
}

if (fromCli()) {
  console.log('typings written by orca plugin types')
} else {
  const version = process.env.ORCA_VERSION ?? pkg.config?.orcaVersion
  if (!version) throw new Error('no orca CLI: set ORCA_VERSION or config.orcaVersion in package.json')
  const tag = `v${version}`
  const header = `// Downloaded by scripts/orca-types.mjs from stablyai/orca ${tag}. Do not edit.\n`
  const files = { orca: (await Promise.all(ORCA_MODULE.map((p) => get(tag, p)))).join('\n') }
  for (const name of SURFACES) files[name] = await get(tag, `resources/plugins/types/${name}.d.ts`)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join('.orca', 'types', name), { recursive: true })
    await writeFile(join('.orca', 'types', name, 'index.d.ts'), header + text)
  }
  await writeFile(join('.orca', 'types', 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`)
  console.log(`typings for Orca ${tag} written to .orca/types`)
}
