import type { CrmVenue, TenantContext } from '../../../types'
import type { BillingDetail } from '../../billing/types'
import { canAccessCrmSection } from '../routing/crmPermissions'
import type { CrmSection } from '../routing/crmNavigation'

export const onboardingThemes = [
  { id: 'business', title: 'Negocio y equipo' },
  { id: 'catalog', title: 'Catálogo y productos' },
  { id: 'options', title: 'Mixers y modificadores' },
  { id: 'inventory', title: 'Inventario y stock' },
  { id: 'restaurant', title: 'Sala y servicio' },
] as const

type OnboardingThemeId = typeof onboardingThemes[number]['id']

export const onboardingTopics = [
  { id: 'settings', theme: 'business', title: 'Datos de tu local', description: 'Revisa los datos del negocio, horario e impuestos.', section: 'settings' },
  { id: 'formats', theme: 'catalog', title: 'Formatos de venta', description: 'Prepara formatos como unidad, copa o ración antes del producto.', section: 'formats' },
  { id: 'categories', theme: 'catalog', title: 'Organizar el TPV', description: 'Crea pestañas y categorías para encontrar tus productos.', section: 'categories' },
  { id: 'products', theme: 'catalog', title: 'Tu primer producto', description: 'Nombre, precio, IVA y dónde aparecerá en el TPV.', section: 'products' },
  { id: 'mixers', theme: 'options', title: 'Crear un grupo de mixers', description: 'Opciones, variantes, suplementos y cantidades.', section: 'selection-groups' },
  { id: 'product-mixers', theme: 'options', title: 'Asignar mixers al producto', description: 'Grupo, selección obligatoria u opcional y variantes.', section: 'products' },
  { id: 'modifiers', theme: 'options', title: 'Preparar modificadores', description: 'Crea opciones como sin hielo, extras o puntos de cocción.', section: 'modifiers' },
  { id: 'inventory-units', theme: 'inventory', title: 'Unidades y equivalencias', description: 'Unidades físicas, decimales y contenido de los envases.', section: 'inventory-units' },
  { id: 'inventory-warehouses', theme: 'inventory', title: 'Tu primer almacén', description: 'Crea las ubicaciones donde guardarás las existencias.', section: 'inventory-warehouses' },
  { id: 'inventory-stock', theme: 'inventory', title: 'Crear un artículo de stock', description: 'Unidad física, almacenes, prioridades y objetivo inicial.', section: 'inventory-stock' },
  { id: 'stock-targets', theme: 'inventory', title: 'Definir el stock objetivo', description: 'Configura cuánto quieres mantener en cada almacén.', section: 'inventory-stock' },
  { id: 'stock-count', theme: 'inventory', title: 'Registrar las existencias iniciales', description: 'Cuenta el stock real y establece el total por almacén.', section: 'inventory-stock' },
  { id: 'stock-replenishment', theme: 'inventory', title: 'Reponer hasta el objetivo', description: 'Registra entradas y comprueba la cantidad resultante.', section: 'inventory-stock' },
  { id: 'product-inventory', theme: 'inventory', title: 'Descontar stock al vender', description: 'Vincula el producto con su artículo y consumo por variante.', section: 'products' },
  { id: 'tables', theme: 'restaurant', title: 'Mesas y zonas', description: 'Prepara tu sala o terraza y distribuye las mesas.', section: 'tables' },
  { id: 'access', theme: 'business', title: 'Equipo y dispositivos', description: 'Prepara los usuarios y terminales de tu negocio.', section: 'access' },
  { id: 'users', theme: 'business', title: 'Crear un usuario del CRM', description: 'Credenciales, rol y locales asignados.', section: 'access' },
] as const satisfies ReadonlyArray<{ id: string; title: string; description: string; section: CrmSection; theme: OnboardingThemeId }>

export type OnboardingTopic = typeof onboardingTopics[number]
export type OnboardingProgress = { offered: boolean; reviewed: string[] }

export function getOnboardingGroups(topics: readonly OnboardingTopic[], reviewed: readonly string[]) {
  const completed = new Set(reviewed)
  return onboardingThemes.map(theme => {
    const guides = topics.filter(topic => topic.theme === theme.id)
    return { ...theme, guides, completed: guides.filter(topic => completed.has(topic.id)).length }
  }).filter(group => group.guides.length > 0)
}

export function getOnboardingTopics(context: TenantContext, venue: CrmVenue) {
  if (context.billingActivationRequired) return []
  return onboardingTopics.filter(topic => canAccessCrmSection(context.role, topic.section, context.features, venue)
    && (topic.id !== 'users' || context.role === 'owner')
    && (topic.id !== 'product-inventory' || canAccessCrmSection(context.role, 'inventory-stock', context.features, venue)))
}

export function onboardingStorageKey(context: Pick<TenantContext, 'tenantId' | 'userId'>, venueId: string) {
  return `crm:onboarding:v1:${context.tenantId}:${context.userId}:${venueId}`
}

export function readOnboardingProgress(key: string, storage?: Pick<Storage, 'getItem'>): OnboardingProgress {
  try {
    const value: unknown = JSON.parse((storage ?? window.localStorage).getItem(key) ?? 'null')
    if (value && typeof value === 'object' && 'offered' in value && 'reviewed' in value && Array.isArray(value.reviewed)) {
      return { offered: value.offered === true, reviewed: value.reviewed.filter((id): id is string => typeof id === 'string' && onboardingTopics.some(topic => topic.id === id)) }
    }
  } catch { /* Storage can be blocked or contain an older/invalid value. */ }
  return { offered: false, reviewed: [] }
}

export function writeOnboardingProgress(key: string, progress: OnboardingProgress, storage?: Pick<Storage, 'setItem'>) {
  try { (storage ?? window.localStorage).setItem(key, JSON.stringify(progress)) } catch { /* The guide remains usable for this session. */ }
}

export function shouldOfferOnboarding(context: TenantContext, detail: BillingDetail, progress: OnboardingProgress) {
  return context.role === 'owner' && !context.billingActivationRequired && !progress.offered
    && detail.account.tenant_id === context.tenantId
    && detail.tenant.id === context.tenantId
    && detail.account.source === 'stripe'
    && detail.tenant.billing_activation_required === false
    && Boolean(detail.account.onboarding_contract)
}
