import * as Sentry from '@sentry/react'
import type { ErrorInfo } from 'react'

const sentryEnabled =
  import.meta.env.VITE_SENTRY_ENABLED === 'true'
  && Boolean(import.meta.env.VITE_SENTRY_DSN)

function removeSensitiveHeaders(headers: Record<string, string>) {
  const sanitizedHeaders = { ...headers }
  const sensitiveHeaderNames = [
    'authorization',
    'cookie',
    'set-cookie',
    'apikey',
    'x-api-key',
  ]

  for (const headerName of Object.keys(sanitizedHeaders)) {
    if (sensitiveHeaderNames.includes(headerName.toLowerCase())) {
      delete sanitizedHeaders[headerName]
    }
  }

  return sanitizedHeaders
}

function removeQueryString(rawUrl?: string) {
  if (!rawUrl) return rawUrl

  try {
    const url = new URL(rawUrl, window.location.origin)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return rawUrl
  }
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: sentryEnabled,
  environment:
    import.meta.env.VITE_APP_ENV
    || import.meta.env.MODE
    || 'unknown',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
  ],
  tracesSampleRate: 0.05,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  beforeBreadcrumb(breadcrumb) {
    if (
      breadcrumb.category === 'fetch'
      || breadcrumb.category === 'xhr'
    ) {
      if (breadcrumb.data?.url) {
        breadcrumb.data.url = removeQueryString(breadcrumb.data.url)
      }
    }

    return breadcrumb
  },
  beforeSend(event) {
    if (event.request) {
      delete event.request.cookies
      delete event.request.data

      if (event.request.url) {
        event.request.url = removeQueryString(event.request.url)
      }

      if (event.request.headers) {
        event.request.headers = removeSensitiveHeaders(event.request.headers)
      }
    }

    return event
  },
})

export function captureException(error: Error, errorInfo: ErrorInfo) {
  Sentry.captureException(error, {
    contexts: {
      react: {
        componentStack: errorInfo.componentStack,
      },
    },
  })
}
