import { createContext, useContext } from 'react'

export const CrmModalBusyContext = createContext<boolean | null>(null)

// Editing can be disabled offline while cancellation must remain available.
// Standalone editors retain their existing disabled contract without a provider.
export function useCrmModalBusy(disabled: boolean) {
  return useContext(CrmModalBusyContext) ?? disabled
}
