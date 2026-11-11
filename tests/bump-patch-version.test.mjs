import assert from 'node:assert/strict'
import test from 'node:test'
import { nextPatch, readVersion, setVersion } from '../scripts/bump-patch-version.mjs'

test('auto bump only increments the patch, keeping manual major/minor', () => {
  assert.equal(nextPatch('1.0.3'), '1.0.4')
  assert.equal(nextPatch('1.0.9'), '1.0.10')
  assert.equal(nextPatch('2.1.0'), '2.1.1')
})

test('setVersion rewrites only the version line', () => {
  const source = '{\n  "name": "pos",\n  "version": "1.0.3",\n  "devDependencies": { "x": "1.2.3" }\n}\n'
  const updated = setVersion(source, '1.0.4')
  assert.equal(readVersion(updated), '1.0.4')
  assert.equal(updated, source.replace('"version": "1.0.3"', '"version": "1.0.4"'))
})

test('rejects package.json without a semver version', () => {
  assert.throws(() => readVersion('{ "version": "next" }'))
})
