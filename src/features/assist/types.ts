export type AssistSensitivity = 'low' | 'normal' | 'high'
export type AssistConfiguration = { tenantEnabled: boolean; venueEnabled: boolean; sensitivity: AssistSensitivity }
export type AssistOrder = {
  id: string; groupId: string; tableName: string; zoneId: string | null
  zoneName?: string
  openedAt: string; updatedAt: string; guests: number; lineCount: number
  pendingUnits: number; readyUnits: number; oldestPendingAt: string | null; readyAt: string | null
  averagePendingAt?: string | null; timedPendingUnits?: number
}
export type AssistSnapshot = { configuration: AssistConfiguration; orders: AssistOrder[]; observedAt: string; contextKey: string }
export type AssistKind = 'unattended_table' | 'kitchen_delay' | 'kitchen_overload' | 'floor_imbalance'
export type AssistSeverity = 'INFO' | 'ATTENTION' | 'ACTION'
export type AssistSituation = {
  key: string; episodeId: string; kind: AssistKind; severity: AssistSeverity
  entityId: string; description: string; metrics: Record<string, number>
  startedAt: string; endedAt: string | null; state: 'active' | 'resolved'
  feedback?: 'understood' | 'not_a_problem'; expiresAt: string
}
