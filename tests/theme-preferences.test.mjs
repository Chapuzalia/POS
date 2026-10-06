import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createCompiledHookRunner } from './helpers/component-harness.mjs'

const themes = JSON.parse(readFileSync(new URL('../src/config/themes.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../src/hooks/useThemeTokens.ts', import.meta.url), 'utf8')

function preferences(storedThemeId) {
  const saved = []
  const root = { dataset: {}, style: { setProperty() {} } }
  const runner = createCompiledHookRunner(source, 'useThemeTokens', {
    '../lib/offlineStore': {
      getStoredTheme: () => storedThemeId,
      saveStoredTheme: id => saved.push(id),
    },
  }, { document: { documentElement: root } })
  return { runner, saved, root }
}

test('existing light and dark preferences retain their IDs and appearance', () => {
  for (const [id, mode, name] of [['hero-minimal', 'light', 'Claro'], ['club-night', 'dark', 'Oscuro']]) {
    const { runner, saved, root } = preferences(id)
    const value = runner.render(themes, 'hero-minimal')
    assert.equal(value.themeId, id)
    assert.equal(value.selectedTheme.name, name)
    assert.equal(root.dataset.theme, mode)
    assert.deepEqual(saved, [id])
  }
})

test('retired or unknown saved themes migrate to the light preference', () => {
  for (const id of ['shadcn-neutral', 'retro-brutal', 'unknown']) {
    const { runner, saved, root } = preferences(id)
    const value = runner.render(themes, 'hero-minimal')
    assert.equal(value.themeId, 'hero-minimal')
    assert.equal(value.selectedTheme.mode, 'light')
    assert.equal(root.dataset.theme, 'light')
    assert.deepEqual(saved, ['hero-minimal'])
  }
})

test('switching mode persists the dark selection and applies its tokens', () => {
  const { runner, saved, root } = preferences('hero-minimal')
  runner.render(themes, 'hero-minimal').setThemeId('club-night')
  const value = runner.render(themes, 'hero-minimal')
  assert.equal(value.selectedTheme.mode, 'dark')
  assert.equal(root.dataset.posTheme, 'club-night')
  assert.deepEqual(saved, ['hero-minimal', 'club-night'])
})
