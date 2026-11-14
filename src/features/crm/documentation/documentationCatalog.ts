import { billingLegalDocuments } from '../../../../supabase/functions/_shared/billing/legal'

export type DocumentationEntry = {
  id: string
  title: string
  description: string
  /** Public, downloadable document URL. Missing = not published yet. */
  href?: string
}

// Add `href` once each document is published; the page enables its download automatically.
export const legalDocuments: DocumentationEntry[] = [
  { id: 'service-contract', title: 'Contrato de prestación de servicios', description: 'Acuerdo entre tu empresa y Alteil Solutions SL para el uso de Tickit.' },
  { id: 'terms', title: 'Términos y condiciones', description: 'Condiciones generales vigentes, incluido el cambio de proveedor.', href: billingLegalDocuments.terms.url },
  { id: 'privacy', title: 'Política de privacidad', description: 'Cómo Alteil Solutions SL trata los datos personales.', href: billingLegalDocuments.privacy.url },
  { id: 'dpa', title: 'Contrato de encargado del tratamiento', description: 'Tratamiento de los datos de tus clientes y empleados (art. 28 RGPD).', href: billingLegalDocuments.dpa.url },
  { id: 'portability', title: 'Portabilidad y cambio de proveedor', description: 'Registro de exportaciones, formatos, limitaciones y asistencia al cambio.', href: '/legal/portabilidad.html' },
]

export const userManuals: DocumentationEntry[] = [
  { id: 'crm-manual', title: 'Manual del Back Office', description: 'Catálogo, inventario, informes y configuración del local.' },
  { id: 'pos-manual', title: 'Manual del TPV', description: 'Ventas, cobros, aperturas y cierres de caja.' },
  { id: 'kds-manual', title: 'Manual de cocina (KDS)', description: 'Pantalla de producción y gestión de comandas.' },
]
