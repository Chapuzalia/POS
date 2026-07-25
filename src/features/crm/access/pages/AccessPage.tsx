import { Copy, LogOut, MonitorSmartphone, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { sileo } from 'sileo'
import { type CrmDevice, type DeviceMode, type TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { formatCrmDateTime } from '../../shared/formatCrmDateTime'
import { type RunAction } from '../../shared/types'
import {
  type CrmAccessData,
  createCrmDevice,
  deleteCrmDevice,
  loadCrmAccessData,
  releaseCrmDeviceLogin,
  updateCrmDevice,
} from '../services/accessService'

export type AccessManagementCrmProps = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

const modeOptions = [
  { label: 'Caja', value: 'checkout' },
  { label: 'Satélite', value: 'satellite' },
  { label: 'Híbrido', value: 'hybrid' },
]

const roleLabels = {

  manager: 'Gestor',
  owner: 'Owner',
}

export function AccessManagementCrm({ disabled, runAction, tenantContext }: AccessManagementCrmProps) {
  const [data, setData] = useState<CrmAccessData>({ devices: [], users: [], venues: [] })
  const [deviceName, setDeviceName] = useState('')
  const [deviceVenueId, setDeviceVenueId] = useState('')
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('checkout')
  const [generatedCredentials, setGeneratedCredentials] = useState<{ email: string; password: string } | null>(null)
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [editingDeviceName, setEditingDeviceName] = useState('')
  const [editingDeviceMode, setEditingDeviceMode] = useState<DeviceMode>('checkout')
  const [editingDevicePassword, setEditingDevicePassword] = useState('')

  const refresh = useCallback(async () => {
    setData(await loadCrmAccessData(tenantContext))
  }, [tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  useEffect(() => {
    if (!deviceVenueId && data.venues.length) setDeviceVenueId(data.venues[0].id)
  }, [data.venues, deviceVenueId])

  async function submitDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      const credentials = await createCrmDevice(tenantContext, deviceVenueId, deviceName, deviceMode)
      setDeviceName('')
      await refresh()
      setGeneratedCredentials(credentials)
    })
  }

  async function copyCredential(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      sileo.success({ title: `${label} copiado` })
    } catch {
      sileo.error({ title: `No se pudo copiar ${label.toLowerCase()}` })
    }
  }

  function startEditingDevice(device: CrmDevice) {
    setEditingDeviceId(device.id)
    setEditingDeviceName(device.name)
    setEditingDeviceMode(device.deviceMode)
    setEditingDevicePassword('')
  }

  function cancelEditingDevice() {
    setEditingDeviceId(null)
    setEditingDeviceName('')
    setEditingDeviceMode('checkout')
    setEditingDevicePassword('')
  }

  async function submitDeviceEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingDeviceId) return

    await runAction(async () => {
      await updateCrmDevice(tenantContext, editingDeviceId, {
        deviceMode: editingDeviceMode,
        name: editingDeviceName,
        password: editingDevicePassword || undefined,
      })
      cancelEditingDevice()
      await refresh()
    })
  }

  async function releaseDeviceLogin(device: CrmDevice) {
    if (!device.account) return
    if (!window.confirm(`Liberar la sesión de "${device.name}"? El dispositivo se desconectará en menos de 30 segundos.`)) return

    await runAction(async () => {
      await releaseCrmDeviceLogin(tenantContext, device.account!.userId)
      await refresh()
    })
  }

  async function removeDevice(device: CrmDevice) {
    if (!window.confirm(`Eliminar definitivamente el dispositivo "${device.name}" y sus credenciales? Su histórico se conservará sin vincularlo al dispositivo.`)) return

    await runAction(async () => {
      await deleteCrmDevice(tenantContext, device.id)
      if (editingDeviceId === device.id) cancelEditingDevice()
      await refresh()
    })
  }

  const venueById = new Map(data.venues.map((venue) => [venue.id, venue]))

  return (
    <>
      <div className="crm-access-layout !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[340px_minmax(0,1fr)] xl:!gap-6">
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Nuevo dispositivo</span>
            <MonitorSmartphone className="h-4 w-4" />
          </div>
          <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitDevice(event)}>
            <Field label="Local">
              <CrmSelect
                disabled={disabled}
                onChange={setDeviceVenueId}
                options={data.venues.filter((venue) => venue.isActive).map((venue) => ({ label: venue.name, value: venue.id }))}
                required
                value={deviceVenueId}
              />
            </Field>
            <Field label="Nombre del dispositivo">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none" disabled={disabled} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} required value={deviceName} />
            </Field>
            <Field label="Modo">
              <CrmSelect onChange={(value) => setDeviceMode(value as DeviceMode)} options={modeOptions} value={deviceMode} />
            </Field>
            <p className="!m-0 !text-xs !leading-relaxed !text-[var(--crm-text-muted)]">Se crearán automáticamente un email de acceso sin identificadores y una contraseña de 6 caracteres.</p>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !deviceVenueId || !deviceName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear dispositivo
            </button>
          </form>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-list-toolbar !flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div className="crm-list-title"><h2>Dispositivos</h2><p>{data.devices.length} dispositivos registrados</p></div>
            <button aria-label="Actualizar dispositivos" className="crm-icon-button !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !text-[var(--crm-text-muted)]" disabled={disabled} onClick={() => void runAction(refresh)} type="button"><RefreshCw className="!size-4" /></button>
          </div>
          <div className="!divide-y !divide-[var(--crm-border-subtle)]">
            {data.devices.map((device) => {
              const venue = venueById.get(device.venueId)
              const mode = modeOptions.find((option) => option.value === device.deviceMode)?.label ?? 'Caja'
              const isEditing = editingDeviceId === device.id
              return (
                <div className="!px-[18px] !py-3 md:!px-[22px]" key={device.id}>
                  <div className="!grid !min-h-[68px] !items-center !gap-3 md:!grid-cols-[minmax(150px,0.8fr)_minmax(220px,1.2fr)_100px_auto]">
                    <div className="crm-cell-main"><strong>{device.name}</strong><span>{venue?.name ?? 'Local no disponible'} · {mode}</span></div>
                    <div className="crm-cell-main">
                      <strong>{device.account?.email || 'Sin credenciales asociadas'}</strong>
                      <span>{device.account ? 'Credencial de acceso del dispositivo' : 'Requiere revisión'}</span>
                    </div>
                    <div className="!grid !justify-items-start !gap-1">
                      <span className={device.account?.isActive ? 'crm-status-pill !inline-flex !min-h-6 !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !rounded-full !bg-[var(--crm-surface-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-text-secondary)]'}>
                        {device.account?.hasActiveLogin ? 'En sesión' : device.account?.isActive ? 'Activo' : 'Inactivo'}
                      </span>
                    </div>
                    <div className="!flex !flex-wrap !items-center !justify-start !gap-2 md:!justify-end">
                      <button aria-label={`Editar dispositivo ${device.name}`} className="crm-primary-button !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !bg-[var(--crm-blue)] !text-white" disabled={disabled || !device.account} onClick={() => startEditingDevice(device)} title="Editar nombre, modo o contraseña" type="button"><Pencil className="!size-4" /></button>
                      {tenantContext.role === 'owner' ? (
                        <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-surface-soft)] !px-3 !text-[13px] !font-semibold" disabled={disabled || !device.account?.hasActiveLogin} onClick={() => void releaseDeviceLogin(device)} title={device.account?.loginHeartbeatAt ? `Última actividad: ${formatCrmDateTime(device.account.loginHeartbeatAt)}` : 'Cerrar la sesión de este dispositivo'} type="button"><LogOut className="!size-4" /> Liberar</button>
                      ) : null}
                      <button aria-label={`Eliminar dispositivo ${device.name}`} className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-red-soft)] !px-3 !text-[13px] !font-semibold !text-[var(--crm-red)]" disabled={disabled} onClick={() => void removeDevice(device)} title="Eliminar definitivamente" type="button"><Trash2 className="!size-4" /> Eliminar</button>
                    </div>
                  </div>
                  {isEditing ? (
                    <form className="!mt-3 !grid !grid-cols-1 !gap-3 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-surface-soft)] !p-4 md:!grid-cols-3" onSubmit={(event) => void submitDeviceEdit(event)}>
                      <Field label="Nombre">
                        <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium" disabled={disabled} maxLength={80} onChange={(event) => setEditingDeviceName(event.target.value)} required value={editingDeviceName} />
                      </Field>
                      <Field label="Nueva contraseña (opcional)">
                        <input autoComplete="new-password" className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium" disabled={disabled} maxLength={6} minLength={6} onChange={(event) => setEditingDevicePassword(event.target.value)} placeholder="6 caracteres" type="text" value={editingDevicePassword} />
                      </Field>
                      <Field label="Modo">
                        <CrmSelect disabled={disabled} onChange={(value) => setEditingDeviceMode(value as DeviceMode)} options={modeOptions} value={editingDeviceMode} />
                      </Field>
                      <p className="!m-0 !text-xs !text-[var(--crm-text-muted)] md:!col-span-3">Al cambiar el nombre también se actualizará automáticamente el email de acceso.</p>
                      <div className="!flex !gap-2 md:!col-span-3 md:!justify-end">
                        <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !px-3 !text-[13px] !font-semibold" disabled={disabled} onClick={cancelEditingDevice} type="button"><X className="!size-4" /> Cancelar</button>
                        <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !editingDeviceName.trim() || (editingDevicePassword.length > 0 && editingDevicePassword.length !== 6)} type="submit"><Save className="!size-4" /> Guardar cambios</button>
                      </div>
                    </form>
                  ) : null}
                </div>
              )
            })}
            {!data.devices.length ? <EmptyList message="No hay dispositivos registrados." /> : null}
          </div>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] xl:!col-span-2">
          <div className="crm-list-toolbar !flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div className="crm-list-title"><h2>Usuarios con acceso al CRM</h2><p>{data.users.length} usuarios gestores · las cuentas técnicas de dispositivos no aparecen aquí</p></div>
            <ShieldCheck className="!size-5 !text-[var(--crm-text-muted)]" />
          </div>
          <div className="!divide-y !divide-[var(--crm-border-subtle)]">
            {data.users.map((user) => (
              <div className="!grid !min-h-[68px] !items-center !gap-3 !px-[18px] !py-3 sm:!grid-cols-[minmax(0,1fr)_140px_100px] md:!px-[22px]" key={user.id}>
                <div className="crm-cell-main"><strong>{user.fullName || user.email}</strong><span>{user.email}</span></div>
                <span className="!text-sm !font-semibold !text-[var(--crm-text-secondary)]">{roleLabels[user.role]}</span>
                <span className={user.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !rounded-full !bg-[var(--crm-surface-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-text-secondary)]'}>{user.isActive ? 'Activo' : 'Inactivo'}</span>
              </div>
            ))}
            {!data.users.length ? <EmptyList message="No hay usuarios gestores configurados." /> : null}
          </div>
        </section>
      </div>

      {generatedCredentials ? (
        <CrmModal label="Credenciales del nuevo dispositivo" onClose={() => setGeneratedCredentials(null)}>
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
            <div><h2 className="!m-0 !text-lg !font-bold">Dispositivo creado</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Guarda estas credenciales: la contraseña solo se muestra ahora.</p></div>
            <button aria-label="Cerrar" className="crm-icon-button !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]" onClick={() => setGeneratedCredentials(null)} type="button"><X className="!size-4" /></button>
          </div>
          <div className="!grid !gap-4 !px-5 !py-5">
            <CredentialRow label="Email de acceso" onCopy={() => void copyCredential(generatedCredentials.email, 'Email')} value={generatedCredentials.email} />
            <CredentialRow label="Contraseña" large onCopy={() => void copyCredential(generatedCredentials.password, 'Contraseña')} value={generatedCredentials.password} />
            <button className="crm-primary-button !mt-1 !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" onClick={() => setGeneratedCredentials(null)} type="button">He guardado las credenciales</button>
          </div>
        </CrmModal>
      ) : null}
    </>
  )
}

function CredentialRow({ label, large = false, onCopy, value }: { label: string; large?: boolean; onCopy: () => void; value: string }) {
  return (
    <div className="!grid !gap-2">
      <span className="!text-[11px] !font-semibold !text-[var(--crm-text-muted)]">{label}</span>
      <div className="!flex !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3">
        <code className={large ? '!min-w-0 !flex-1 !text-lg !font-bold !tracking-[0.08em]' : '!min-w-0 !flex-1 !overflow-hidden !text-ellipsis !text-sm !font-semibold'}>{value}</code>
        <button aria-label={`Copiar ${label.toLowerCase()}`} className="crm-icon-button !inline-flex !size-9 !shrink-0 !items-center !justify-center !rounded-[9px] !bg-[var(--crm-input-bg)] !text-[var(--crm-text-secondary)]" onClick={onCopy} type="button"><Copy className="!size-4" /></button>
      </div>
    </div>
  )
}
