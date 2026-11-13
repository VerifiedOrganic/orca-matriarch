#!/usr/bin/env node
// Orca installs every tracked file of this repository (its root is the plugin), and Orca's plugin
// directory refuses a release that carries binaries other than PNG, JPEG, WEBP or GIF images, or
// symlinks. `orca plugin validate` does not check this; this does.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
const bad = []
let count = 0
for (const line of execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
  const [meta, path] = line.split('\t')
  count++
  if (meta.startsWith('120000')) bad.push(`${path} (symlink)`)
  else if (!IMAGE.test(path) && readFileSync(path).includes(0)) bad.push(`${path} (binary)`)
}
if (bad.length > 0) {
  console.error(`Orca's plugin directory refuses these files:\n  ${bad.join('\n  ')}`)
  process.exit(1)
}
console.log(`no binaries among ${count} tracked files`)
