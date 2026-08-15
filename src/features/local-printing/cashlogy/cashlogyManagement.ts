import type { CashlogyBackofficePreset } from '../types'

export type CashlogyManagementAction = 'refill' | 'give_change' | 'withdraw'

const basePreset: CashlogyBackofficePreset = {
  status: false,
  addChange: false,
  manualOneCent: false,
  withdrawCash: false,
  removeStacker: false,
  completeEmptying: false,
  giveChange: false,
  cashClosing: false,
  viewLogs: false,
  resetCoins: false,
  statistics: false,
  showOnTop: true,
  maintenance: false,
}

export const cashlogyManagementPresets: Record<CashlogyManagementAction, CashlogyBackofficePreset> = {
  refill: { ...basePreset, addChange: true },
  give_change: { ...basePreset, giveChange: true },
  withdraw: { ...basePreset, withdrawCash: true },
}

export const cashlogyDangerousManagementActions = new Set<CashlogyManagementAction>(['withdraw'])
