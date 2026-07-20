import { useCallback, useEffect, useRef, useState } from 'react'
import { isAdministrativeUser } from '../../../app/app-permissions'
import type { CashRegister, CashSession, TenantContext } from '../../../types'
import { loadCashRegisterOptions, subscribeToVenueCashSessions } from '../service'

type Options = {
  context: TenantContext | null
  currentSession: CashSession | null
  isOnline: boolean
  onClosedRemotely: () => void
  onSessionSelected: (session: CashSession) => void
}

export function useCashRegisterOptions(options: Options) {
  const [registers, setRegisters] = useState<CashRegister[]>([])
  const [sessions, setSessions] = useState<CashSession[]>([])
  const latestRef = useRef(options)
  latestRef.current = options
  const { context, isOnline } = options

  const refresh = useCallback(async (activeContext = context) => {
    if (!activeContext || !isOnline || isAdministrativeUser(activeContext)) return
    const state = await loadCashRegisterOptions(activeContext)
    setRegisters(state.registers)
    setSessions(state.sessions)
    const currentSession = latestRef.current.currentSession
    const current = currentSession
      ? state.sessions.find((session) => session.id === currentSession.id)
      : null
    if (currentSession && !current) {
      latestRef.current.onClosedRemotely()
      return
    }
    if (!currentSession && state.sessions.length === 1) {
      latestRef.current.onSessionSelected(state.sessions[0])
    }
  }, [context, isOnline])

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) {
      setRegisters([])
      setSessions([])
      return undefined
    }
    void refresh(context)
    return subscribeToVenueCashSessions(context, () => void refresh(context))
  }, [context, isOnline, refresh])

  return { registers, sessions, refresh }
}
