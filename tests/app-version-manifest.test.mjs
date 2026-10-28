import assert from 'node:assert/strict'
import test from 'node:test'

test('the build emits the current SHA and preserves the explicitly compatible PWA versions', async () => {
  const previous = { APP_VERSION: process.env.APP_VERSION, SUPPORTED_APP_VERSIONS: process.env.SUPPORTED_APP_VERSIONS }
  const current = 'a'.repeat(40), compatible = 'b'.repeat(40)
  try {
    process.env.APP_VERSION = current
    process.env.SUPPORTED_APP_VERSIONS = `${compatible},${compatible}`
    const { default: configuration } = await import('../vite.config.ts?manifest-test')
    const assets = []
    const plugin = configuration.plugins.find(item => item?.name === 'offline-app-assets')
    plugin.generateBundle.call({ emitFile: asset => assets.push(asset) }, {}, {})
    const manifest = JSON.parse(assets.find(asset => asset.fileName === 'app-version.json').source)
    assert.deepEqual(manifest, { currentVersion: current, supportedVersions: [compatible, current] })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
