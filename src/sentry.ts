import { sanitizeDiagnosticData } from './lib/observabilityPrivacy.ts'
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
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[invalid-url]'
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
  beforeSendTransaction(event) {
    delete event.user
    delete event.extra
    if (event.request) {
      delete event.request.data
      delete event.request.cookies
    }
    return sanitizeDiagnosticData(event) as typeof event
  },
  sendDefaultPii: false,
  beforeBreadcrumb(breadcrumb) {
    if (breadcrumb.category === 'console' || breadcrumb.category?.startsWith('ui.')) return null
    if (
      breadcrumb.category === 'fetch'
      || breadcrumb.category === 'xhr'
    ) {
      if (breadcrumb.data?.url) {
        breadcrumb.data.url = removeQueryString(breadcrumb.data.url)
      }
    }

    return sanitizeDiagnosticData(breadcrumb) as typeof breadcrumb
  },
  beforeSend(event, hint) {
    // Supabase returns plain objects. Preserve their diagnostic message before
    // removing Sentry's serialized extras, which can contain response payloads.
    const original = hint.originalException
    if (original && typeof original === 'object' && !(original instanceof Error) && 'message' in original && typeof original.message === 'string') {
      const exception = event.exception?.values?.at(-1)
      if (exception) exception.value = original.message
    }
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

    delete event.user
    delete event.extra
    return sanitizeDiagnosticData(event) as typeof event
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
