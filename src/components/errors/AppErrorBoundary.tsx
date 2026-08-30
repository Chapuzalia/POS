import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  fallback: ReactNode
}

type State = {
  failed: boolean
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (
      import.meta.env.VITE_SENTRY_ENABLED === 'true'
      && Boolean(import.meta.env.VITE_SENTRY_DSN)
    ) {
      void import('../../sentry.ts').then((module) => {
        module.captureException(error, errorInfo)
      })
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
