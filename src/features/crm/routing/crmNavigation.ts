import { Armchair, BarChart3, Boxes, Gauge, LayoutDashboard, type LucideIcon, ReceiptText, Settings, SlidersHorizontal, Tags, Upload, Users } from 'lucide-react'

export type CrmSection = 'dashboard' | 'access' | 'products' | 'categories' | 'sale-formats' | 'discounts' | 'tables' | 'reports' | 'import' | 'stats' | 'settings' | 'plan'

export type CrmNavItem = { id: CrmSection; label: string; icon: LucideIcon }

export const productNavItems: CrmNavItem[] = [
  { id: 'products', label: 'Productos', icon: Boxes },
  { id: 'categories', label: 'Categorias', icon: Tags },
  { id: 'discounts', label: 'Descuentos', icon: Tags },
  { id: 'sale-formats', label: 'Formatos', icon: SlidersHorizontal },
]

export const navItems: CrmNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'access', label: 'Accesos', icon: Users },
  { id: 'tables', label: 'Mesas y zonas', icon: Armchair },
  { id: 'reports', label: 'Informes de ventas', icon: ReceiptText },
  { id: 'import', label: 'Importar / exportar', icon: Upload },
  { id: 'stats', label: 'Estadisticas', icon: BarChart3 },
  { id: 'plan', label: 'Mi Plan', icon: Gauge },
  { id: 'settings', label: 'Configuración', icon: Settings },
]

export const allNavItems = [...navItems, ...productNavItems]

export const productSections = new Set<CrmSection>(productNavItems.map((item) => item.id))

export function getSectionTitle(section: CrmSection) {
  if (section === 'access') {
    return 'Locales, dispositivos y usuarios'
  }
  if (section === 'products') {
    return 'Gestion de productos y precios'
  }
  if (section === 'categories') {
    return 'Categorias del catalogo'
  }
  if (section === 'sale-formats') {
    return 'Formatos de venta'
  }
  if (section === 'import') {
    return 'Importar y exportar catalogo'
  }
  if (section === 'tables') {
    return 'Mesas y zonas del local'
  }
  if (section === 'discounts') {
    return 'Descuentos del local'
  }
  if (section === 'reports') {
    return 'Informes de ventas'
  }
  if (section === 'stats') {
    return 'Analitica comercial'
  }
  if (section === 'settings') {
    return 'Configuración de locales'
  }
  if (section === 'plan') {
    return 'Mi Plan'
  }

  return 'Panel de control'
}
