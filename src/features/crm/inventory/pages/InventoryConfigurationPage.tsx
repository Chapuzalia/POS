import { CircleCheck, Route, ShieldCheck } from 'lucide-react'

export function InventoryConfigurationCrm() {
  return <section className="grid gap-4 rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
    <header><h2 className="text-lg font-bold">Configuración de inventario</h2><p className="text-sm text-[var(--crm-text-muted)]">Reglas operativas aplicadas por el motor único de consumo.</p></header>
    <div className="grid gap-3 md:grid-cols-3">
      <article className="rounded-xl bg-[var(--crm-surface-soft)] p-4"><ShieldCheck className="mb-3 size-5 text-[var(--crm-green)]" /><h3 className="font-bold">Venta no bloqueante</h3><p className="mt-1 text-sm text-[var(--crm-text-muted)]">Los fallos se aíslan y registran sin revertir el cobro.</p></article>
      <article className="rounded-xl bg-[var(--crm-surface-soft)] p-4"><Route className="mb-3 size-5 text-[var(--crm-blue)]" /><h3 className="font-bold">Rutas por artículo</h3><p className="mt-1 text-sm text-[var(--crm-text-muted)]">La prioridad física no depende del TPV que registra la venta.</p></article>
      <article className="rounded-xl bg-[var(--crm-surface-soft)] p-4"><CircleCheck className="mb-3 size-5 text-[var(--crm-yellow)]" /><h3 className="font-bold">Stock negativo</h3><p className="mt-1 text-sm text-[var(--crm-text-muted)]">Se permite para reflejar faltantes reales; nunca fabrica elaboraciones automáticamente.</p></article>
    </div>
  </section>
}
