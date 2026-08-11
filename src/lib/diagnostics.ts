import * as Sentry from '@sentry/react'

type DiagnosticData = Record<string, boolean | number | string | null | undefined>

export function addDiagnosticBreadcrumb(message: string, data?: DiagnosticData) {
  Sentry.addBreadcrumb({
    category: 'pos.diagnostics',
    level: 'info',
    message,
    data,
  })
}
