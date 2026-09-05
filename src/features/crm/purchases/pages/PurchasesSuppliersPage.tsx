import { Building2, LoaderCircle, Pencil, Plus, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { AppModal, Button, Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { loadVenueSuppliers, saveVenueSupplier } from '../services/supplierService'
import type { VenueSupplier } from '../types'

type Props = { disabled: boolean; selectedVenueId: string; tenantContext: TenantContext }
type SupplierDraft = { name: string; taxId: string }

const emptyDraft: SupplierDraft = { name: '', taxId: '' }
const sortSuppliers = (suppliers: VenueSupplier[]) => [...suppliers]
  .sort((left, right) => left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }))

export function PurchasesSuppliersCrm({ disabled, selectedVenueId, tenantContext }: Props) {
  const [suppliers, setSuppliers] = useState<VenueSupplier[]>([])
  const [editingSupplier, setEditingSupplier] = useState<VenueSupplier | null>(null)
  const [draft, setDraft] = useState<SupplierDraft>(emptyDraft)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void loadVenueSuppliers(tenantContext, selectedVenueId)
      .then((next) => { if (active) setSuppliers(next) })
      .catch((cause) => { if (active) setError(getReadableError(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selectedVenueId, tenantContext])

  function openCreateForm() {
    setEditingSupplier(null)
    setDraft(emptyDraft)
    setError(null)
    setIsFormOpen(true)
  }

  function openEditForm(supplier: VenueSupplier) {
    setEditingSupplier(supplier)
    setDraft({ name: supplier.name, taxId: supplier.taxId ?? '' })
    setError(null)
    setIsFormOpen(true)
  }

  function closeForm() {
    if (saving) return
    setIsFormOpen(false)
    setEditingSupplier(null)
    setDraft(emptyDraft)
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const name = draft.name.trim()
    if (!name || saving || disabled || !selectedVenueId) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveVenueSupplier(selectedVenueId, {
        id: editingSupplier?.id,
        name,
        taxId: draft.taxId.trim() || null,
      })
      setSuppliers((current) => sortSuppliers(
        editingSupplier
          ? current.map((supplier) => supplier.id === saved.id ? saved : supplier)
          : [...current, saved],
      ))
      setIsFormOpen(false)
      setEditingSupplier(null)
      setDraft(emptyDraft)
    } catch (cause) {
      setError(getReadableError(cause))
    } finally {
      setSaving(false)
    }
  }

  const busy = disabled || loading || saving

  return (
    <section className="grid gap-5">
      <header className="flex flex-col gap-4 rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">Compras</p>
          <h2 className="mt-1 text-2xl font-black">Proveedores</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--crm-text-muted)]">Directorio exclusivo de este local. Se usa para reconocer y asociar correctamente sus facturas y albaranes.</p>
        </div>
        <Button disabled={busy || !selectedVenueId} onClick={openCreateForm} type="button" variant="primary">
          <Plus className="size-4" /> Añadir proveedor
        </Button>
      </header>

      {error && !isFormOpen ? <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}

      <div className="overflow-hidden rounded-3xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead className="bg-[var(--crm-surface-soft)] text-xs font-black uppercase tracking-wider text-[var(--crm-text-muted)]">
              <tr>
                <th className="px-5 py-4" scope="col">Nombre</th>
                <th className="px-5 py-4" scope="col">CIF / NIF</th>
                <th className="px-5 py-4 text-right" scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--crm-border-subtle)]">
              {loading ? (
                <tr><td className="px-5 py-12 text-center text-[var(--crm-text-muted)]" colSpan={3}><LoaderCircle className="mx-auto size-6 animate-spin" /><span className="sr-only">Cargando proveedores</span></td></tr>
              ) : suppliers.length ? suppliers.map((supplier) => (
                <tr className="transition-colors hover:bg-[var(--crm-surface-soft)]" key={supplier.id}>
                  <td className="px-5 py-4"><span className="flex items-center gap-3 font-bold"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]"><Building2 className="size-4" /></span>{supplier.name}</span></td>
                  <td className="px-5 py-4 text-sm font-semibold text-[var(--crm-text-muted)]">{supplier.taxId ?? '—'}</td>
                  <td className="px-5 py-4 text-right"><Button aria-label={`Editar ${supplier.name}`} disabled={disabled || saving} onClick={() => openEditForm(supplier)} type="button" variant="tertiary"><Pencil className="size-4" /> Editar</Button></td>
                </tr>
              )) : (
                <tr><td className="px-5 py-14 text-center text-sm text-[var(--crm-text-muted)]" colSpan={3}>Todavía no hay proveedores registrados en este local.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isFormOpen ? (
        <AppModal dismissDisabled={saving} label={editingSupplier ? 'Editar proveedor' : 'Añadir proveedor'} maxWidth={520} onClose={closeForm}>
          <form onSubmit={submit}>
            <header className="flex items-start justify-between gap-3 border-b border-[var(--separator)] p-5">
              <div>
                <h2 className="text-xl font-black">{editingSupplier ? 'Editar proveedor' : 'Nuevo proveedor'}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">Solo el nombre es obligatorio. El CIF/NIF ayuda al parser a identificarlo con precisión.</p>
              </div>
              <Button aria-label="Cerrar" disabled={saving} onClick={closeForm} size="sm" type="button"><X className="size-4" /></Button>
            </header>
            <div className="grid gap-4 p-5">
              <label>
                <span className="mb-1 block text-sm font-bold">Nombre *</span>
                <Input autoFocus disabled={saving} maxLength={160} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required value={draft.name} />
              </label>
              <label>
                <span className="mb-1 block text-sm font-bold">CIF / NIF <span className="font-medium text-[var(--muted)]">(opcional)</span></span>
                <Input autoCapitalize="characters" disabled={saving} maxLength={40} onChange={(event) => setDraft((current) => ({ ...current, taxId: event.target.value }))} placeholder="Ej. B12345678" value={draft.taxId} />
              </label>
              {error ? <p className="rounded-2xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}
            </div>
            <footer className="flex justify-end gap-2 border-t border-[var(--separator)] p-5">
              <Button disabled={saving} onClick={closeForm} type="button">Cancelar</Button>
              <Button disabled={saving || !draft.name.trim()} type="submit" variant="primary">{saving ? <LoaderCircle className="size-4 animate-spin" /> : null} Guardar</Button>
            </footer>
          </form>
        </AppModal>
      ) : null}
    </section>
  )
}
