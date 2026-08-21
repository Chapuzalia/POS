import { ArrowLeft, Building2, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AppModal, Button, Input } from '../../components/ui'
import type { Customer, CustomerCreateInput } from '../../types'
import { getReadableError } from '../../utils/errors'
import { createCustomer, searchCustomers } from './service'

type Props = {
  isBusy: boolean
  onClose: () => void
  onSelect: (customer: Customer) => void
  tenantId: string
}

const emptyCustomer: CustomerCreateInput = {
  legalName: '', taxId: '', address: '', postalCode: '', city: '', province: '', country: 'España', email: null, phone: null,
}

const fields: Array<{ key: keyof CustomerCreateInput; label: string; required?: boolean; autoComplete?: string; type?: string }> = [
  { key: 'legalName', label: 'Nombre / Razón social', required: true, autoComplete: 'organization' },
  { key: 'taxId', label: 'NIF/CIF', required: true },
  { key: 'address', label: 'Dirección fiscal', required: true, autoComplete: 'street-address' },
  { key: 'postalCode', label: 'Código postal', required: true, autoComplete: 'postal-code' },
  { key: 'city', label: 'Ciudad', required: true, autoComplete: 'address-level2' },
  { key: 'province', label: 'Provincia', required: true, autoComplete: 'address-level1' },
  { key: 'country', label: 'País', autoComplete: 'country-name' },
  { key: 'email', label: 'Email', autoComplete: 'email', type: 'email' },
  { key: 'phone', label: 'Teléfono', autoComplete: 'tel', type: 'tel' },
]

export function CustomerInvoiceModal({ isBusy, onClose, onSelect, tenantId }: Props) {
  const [mode, setMode] = useState<'search' | 'create'>('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<CustomerCreateInput>(emptyCustomer)
  const requestRef = useRef(0)

  useEffect(() => {
    if (mode !== 'search') return undefined
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    const timeout = window.setTimeout(() => {
      void searchCustomers(tenantId, query).then((customers) => {
        if (request === requestRef.current) setResults(customers)
      }).catch((searchError) => {
        if (request === requestRef.current) setError(getReadableError(searchError))
      }).finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
    }, query ? 180 : 0)
    return () => window.clearTimeout(timeout)
  }, [mode, query, tenantId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || isBusy) return
    setSaving(true)
    setError(null)
    try {
      const customer = await createCustomer(tenantId, form)
      onSelect(customer)
    } catch (saveError) {
      setError(getReadableError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const busy = isBusy || saving
  return (
    <AppModal dismissDisabled={busy} label="Seleccionar cliente para factura" maxWidth={680} onClose={onClose}>
      <section className="flex max-h-[min(86svh,760px)] min-h-[440px] w-full flex-col bg-[var(--surface)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--separator)] p-5">
          <div className="min-w-0">
            <h2 className="text-xl font-black">{mode === 'search' ? 'Generar factura' : 'Nuevo cliente'}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{mode === 'search' ? 'Busca por nombre, razón social o NIF/CIF.' : 'Datos fiscales que quedarán asociados a la factura.'}</p>
          </div>
          <Button aria-label="Cerrar" disabled={busy} onClick={onClose} size="sm" type="button"><X className="h-4 w-4" /></Button>
        </header>

        {mode === 'search' ? (
          <div className="flex min-h-0 flex-1 flex-col p-5">
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-[var(--muted)]" />
              <Input autoFocus className="!min-h-12 !pl-10" onChange={(event) => setQuery(event.target.value)} placeholder="Nombre o NIF/CIF" value={query} />
            </div>
            <Button className="mt-3 !justify-center" disabled={busy} onClick={() => { setMode('create'); setError(null) }} type="button" variant="secondary"><Plus className="h-4 w-4" /> Nuevo cliente</Button>
            {error ? <p className="mt-3 rounded-[var(--radius)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">{error}</p> : null}
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
              {loading ? <div className="grid min-h-36 place-items-center text-[var(--muted)]"><LoaderCircle className="h-6 w-6 animate-spin" /></div> : null}
              {!loading && !results.length ? <p className="grid min-h-36 place-items-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-5 text-center text-sm font-semibold text-[var(--muted)]">No se han encontrado clientes.</p> : null}
              {!loading ? <div className="space-y-2">{results.map((customer) => (
                <button className="flex min-h-20 w-full items-start gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-muted)]" key={customer.id} onClick={() => onSelect(customer)} type="button">
                  <Building2 className="mt-1 h-5 w-5 shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0">
                    <strong className="block truncate">{customer.legalName}</strong>
                    <span className="block text-sm font-semibold text-[var(--foreground)]">{customer.taxId}</span>
                    <span className="block truncate text-xs text-[var(--muted)]">{customer.address} · {customer.postalCode} {customer.city}</span>
                  </span>
                </button>
              ))}</div> : null}
            </div>
          </div>
        ) : (
          <form className="min-h-0 flex-1 overflow-y-auto p-5" onSubmit={submit}>
            <button className="mb-4 inline-flex min-h-10 items-center gap-2 text-sm font-bold text-[var(--muted)]" disabled={busy} onClick={() => { setMode('search'); setError(null) }} type="button"><ArrowLeft className="h-4 w-4" /> Volver a buscar</button>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((field) => (
                <label className={field.key === 'legalName' || field.key === 'address' ? 'sm:col-span-2' : ''} key={field.key}>
                  <span className="mb-1 block text-sm font-bold">{field.label}{field.required ? ' *' : ''}</span>
                  <Input autoComplete={field.autoComplete} disabled={busy} required={field.required} type={field.type} value={form[field.key] ?? ''} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value || (field.key === 'email' || field.key === 'phone' ? null : '') }))} />
                </label>
              ))}
            </div>
            {error ? <p className="mt-4 rounded-[var(--radius)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">{error}</p> : null}
            <div className="sticky bottom-0 mt-5 flex justify-end gap-2 border-t border-[var(--separator)] bg-[var(--surface)] py-4">
              <Button disabled={busy} onClick={onClose} type="button">Cancelar</Button>
              <Button disabled={busy} type="submit" variant="primary">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} Guardar y seleccionar</Button>
            </div>
          </form>
        )}
      </section>
    </AppModal>
  )
}
