// Pre-commit: bumps the patch of package.json "version" unless this commit already changes it by hand
// (a manual 1.1.0 or 2.0.0 is kept as-is). Only the staged blob and the version line are touched.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const VERSION_LINE = /^(\s*"version":\s*")(\d+\.\d+\.\d+)(")/m

export function readVersion(source) {
  const match = source.match(VERSION_LINE)
  if (!match) throw new Error('package.json no tiene una "version" semver x.y.z')
  return match[2]
}

export function setVersion(source, version) {
  readVersion(source)
  return source.replace(VERSION_LINE, (_, start, _old, end) => `${start}${version}${end}`)
}

export function nextPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', input })
}

function apply() {
  const stagedDiff = git(['diff', '--cached', '-U0', '--', 'package.json'])
  if (/^\+\s*"version":/m.test(stagedDiff)) return

  const staged = git(['show', ':package.json'])
  const version = nextPatch(readVersion(staged))
  const blob = git(['hash-object', '-w', '--stdin'], setVersion(staged, version)).trim()
  git(['update-index', '--cacheinfo', `100644,${blob},package.json`])
  // Mirror only the version line in the working tree so unstaged edits stay unstaged.
  writeFileSync('package.json', setVersion(readFileSync('package.json', 'utf8'), version))
}

if (process.argv.includes('--apply')) apply()
