import type { TenantContext } from '../../types'

export function shouldResetTenantState(previous: TenantContext | null, next: TenantContext) {
  return previous?.tenantId !== next.tenantId || previous.userId !== next.userId
}
