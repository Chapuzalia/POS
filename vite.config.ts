import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), sentryVitePlugin({
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
