import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { validateBuildEnvironment } from './build/validateBuildEnvironment.ts'

const appVersion = process.env.APP_VERSION
  ?? process.env.VERCEL_GIT_COMMIT_SHA
  ?? process.env.GITHUB_SHA
  ?? 'development'
const configuredSupportedVersions = process.env.SUPPORTED_APP_VERSIONS
  ?.split(',')
  .map((version) => version.trim())
  .filter(Boolean)
// Git SHAs are intentionally opaque. A centrally configured allowlist is the
// minimum-version equivalent and also permits gradual rollouts when needed.
const supportedAppVersions = [...new Set([
  ...(configuredSupportedVersions?.length ? configuredSupportedVersions : []),
  appVersion,
])]

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss(), {
    name: 'validate-build-environment',
    configResolved(config) {
      if (config.command === 'build') validateBuildEnvironment(config.env)
    },
  }, {
    name: 'offline-app-assets',
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'offline-assets.json',
        source: JSON.stringify(Object.keys(bundle).filter((file) => /\.(js|css|woff2?)$/.test(file)).map((file) => `/${file}`)),
      })
      this.emitFile({
        type: 'asset',
        fileName: 'app-version.json',
        source: JSON.stringify({ supportedVersions: supportedAppVersions }),
      })
    },
  }, sentryVitePlugin({
    org: "alteil-solutions",
    project: "tpv-pos"
  })],

  build: {
    // The shared login UI belongs to the bootstrap; business screens are split below.
    chunkSizeWarningLimit: 1000,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: (moduleId) => {
                const id = moduleId.replaceAll('\\', '/')
                return [
                  '/node_modules/.pnpm/react@',
                  '/node_modules/.pnpm/react-dom@',
                  '/node_modules/.pnpm/scheduler@',
                  '/node_modules/react/',
                  '/node_modules/react-dom/',
                  '/node_modules/scheduler/',
                ].some((path) => id.includes(path))
              },
              priority: 40,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-supabase',
              test: (moduleId) => {
                const id = moduleId.replaceAll('\\', '/')
                return id.includes('/node_modules/.pnpm/@supabase+')
                  || id.includes('/node_modules/@supabase/')
              },
              priority: 30,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-validation',
              test: (moduleId) => {
                const id = moduleId.replaceAll('\\', '/')
                return id.includes('/node_modules/.pnpm/zod@')
                  || id.includes('/node_modules/zod/')
              },
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: 'vendor-sentry',
              test: (moduleId) => {
                const id = moduleId.replaceAll('\\', '/')
                return id.includes('/node_modules/.pnpm/@sentry+')
                  || id.includes('/node_modules/@sentry/')
              },
              priority: 20,
              maxSize: 450 * 1024,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  }
})
