import { Armchair, BarChart3, Boxes, Gauge, LayoutDashboard, LayoutGrid, ListChecks, Puzzle, Ruler, type LucideIcon, ReceiptText, Settings, Tags, Upload, Users } from 'lucide-react'

export type CrmSection = 'dashboard' | 'access' | 'products' | 'formats' | 'categories' | 'selection-groups' | 'modifiers' | 'discounts' | 'tables' | 'reports' | 'x-reports' | 'import' | 'stats' | 'settings' | 'plan'

export type CrmNavItem = { id: CrmSection; label: string; icon: LucideIcon }

export const productNavItems: CrmNavItem[] = [
  { id: 'products', label: 'Productos', icon: Boxes },
  { id: 'formats', label: 'Formatos', icon: Ruler },
  { id: 'categories', label: 'Categorías y pestañas', icon: LayoutGrid },
  { id: 'selection-groups', label: 'Grupos de selección', icon: ListChecks },
  { id: 'modifiers', label: 'Modificadores', icon: Puzzle },
  { id: 'discounts', label: 'Descuentos', icon: Tags },
]

export const reportNavItems: CrmNavItem[] = [
  { id: 'reports', label: 'Tickets', icon: ReceiptText },
  { id: 'x-reports', label: 'Informes Z', icon: BarChart3 },
]

export const navItems: CrmNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'access', label: 'Accesos', icon: Users },
  { id: 'tables', label: 'Mesas y zonas', icon: Armchair },
  { id: 'import', label: 'Importar / exportar', icon: Upload },
  { id: 'stats', label: 'Estadísticas', icon: BarChart3 },
  { id: 'plan', label: 'Mi Plan', icon: Gauge },
  { id: 'settings', label: 'Configuración', icon: Settings },
]

export const allNavItems = [...navItems, ...productNavItems, ...reportNavItems]
export const productSections = new Set<CrmSection>(productNavItems.map((item) => item.id))
export const reportSections = new Set<CrmSection>(reportNavItems.map((item) => item.id))

export function getSectionTitle(section: CrmSection) {
  const titles: Partial<Record<CrmSection, string>> = {
    access: 'Dispositivos y usuarios',
    products: 'Productos del catálogo',
    formats: 'Formatos de venta',
    categories: 'Categorías y pestañas del TPV',
    'selection-groups': 'Grupos de selección reutilizables',
    modifiers: 'Modificadores reutilizables',
    import: 'Importar y exportar catálogo',
    tables: 'Mesas y zonas del local',
    discounts: 'Descuentos del local',
    reports: 'Tickets',
    'x-reports': 'Informes Z',
    stats: 'Analítica comercial',
    settings: 'Configuración de locales',
    plan: 'Mi Plan',
  }
  return titles[section] ?? 'Panel de control'
}
