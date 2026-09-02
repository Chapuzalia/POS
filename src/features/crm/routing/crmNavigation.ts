import { Armchair, BarChart3, Beaker, Boxes, ChefHat, FileText, Gauge, LayoutDashboard, LayoutGrid, ListChecks, Package, PackageOpen, PlugZap, Puzzle, Ruler, type LucideIcon, ReceiptText, Settings, Settings2, Tags, Upload, Users, Warehouse } from 'lucide-react'

export type CrmSection = 'dashboard' | 'access' | 'products' | 'formats' | 'categories' | 'selection-groups' | 'modifiers' | 'discounts' | 'tables' | 'production' | 'reports' | 'x-reports' | 'purchases-summary' | 'purchases-invoices' | 'inventory-stock' | 'inventory-items' | 'inventory-preparations' | 'inventory-warehouses' | 'inventory-units' | 'inventory-settings' | 'import' | 'stats' | 'integrations' | 'settings' | 'plan'

export type CrmNavItem = { id: CrmSection; label: string; icon: LucideIcon }

export const productNavItems: CrmNavItem[] = [
  { id: 'products', label: 'Productos', icon: Boxes },
  { id: 'formats', label: 'Formatos', icon: Ruler },
  { id: 'categories', label: 'Categorías y pestañas', icon: LayoutGrid },
  { id: 'selection-groups', label: 'Mixers', icon: ListChecks },
  { id: 'modifiers', label: 'Modificadores', icon: Puzzle },
  { id: 'discounts', label: 'Descuentos', icon: Tags },
]

export const reportNavItems: CrmNavItem[] = [
  { id: 'reports', label: 'Tickets', icon: ReceiptText },
  { id: 'x-reports', label: 'Informes Z', icon: BarChart3 },
]

export const inventoryNavItems: CrmNavItem[] = [
  { id: 'inventory-stock', label: 'Stock', icon: Package },
  { id: 'inventory-items', label: 'Artículos', icon: PackageOpen },
  { id: 'inventory-preparations', label: 'Elaboraciones', icon: Beaker },
  { id: 'inventory-warehouses', label: 'Almacenes', icon: Warehouse },
  { id: 'inventory-units', label: 'Unidades', icon: Ruler },
  { id: 'inventory-settings', label: 'Configuración', icon: Settings2 },
]

export const purchaseNavItems: CrmNavItem[] = [
  { id: 'purchases-summary', label: 'Resumen', icon: BarChart3 },
  { id: 'purchases-invoices', label: 'Facturas', icon: FileText },
]

export const navItems: CrmNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'access', label: 'Accesos', icon: Users },
  { id: 'tables', label: 'Mesas y zonas', icon: Armchair },
  { id: 'production', label: 'Producción', icon: ChefHat },
  { id: 'import', label: 'Importar / exportar', icon: Upload },
  { id: 'stats', label: 'Estadísticas', icon: BarChart3 },
  { id: 'integrations', label: 'Integraciones', icon: PlugZap },
  { id: 'plan', label: 'Mi Plan', icon: Gauge },
  { id: 'settings', label: 'Configuración', icon: Settings },
]

export const allNavItems = [...navItems, ...productNavItems, ...purchaseNavItems, ...reportNavItems, ...inventoryNavItems]
export const productSections = new Set<CrmSection>(productNavItems.map((item) => item.id))
export const reportSections = new Set<CrmSection>(reportNavItems.map((item) => item.id))
export const inventorySections = new Set<CrmSection>(inventoryNavItems.map((item) => item.id))
export const purchaseSections = new Set<CrmSection>(purchaseNavItems.map((item) => item.id))

export function getSectionTitle(section: CrmSection) {
  const titles: Partial<Record<CrmSection, string>> = {
    access: 'Dispositivos y usuarios',
    products: 'Productos del catálogo',
    formats: 'Formatos de venta',
    categories: 'Categorías y pestañas del TPV',
    'selection-groups': 'Mixers y acompañamientos reutilizables',
    modifiers: 'Modificadores reutilizables',
    import: 'Importar y exportar catálogo',
    tables: 'Mesas y zonas del local',
    production: 'Producción del local',
    discounts: 'Descuentos del local',
    reports: 'Tickets',
    'x-reports': 'Informes Z',
    'inventory-stock': 'Stock del local',
    'purchases-summary': 'Resumen de compras',
    'purchases-invoices': 'Facturas y albaranes',
    'inventory-items': 'Artículos de inventario',
    'inventory-preparations': 'Elaboraciones de inventario',
    'inventory-warehouses': 'Almacenes del local',
    'inventory-units': 'Unidades de inventario',
    'inventory-settings': 'Configuración de inventario',
    stats: 'Analítica comercial',
    integrations: 'Integraciones',
    settings: 'Configuración de locales',
    plan: 'Mi Plan',
  }
  return titles[section] ?? 'Panel de control'
}
