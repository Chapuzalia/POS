import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
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
  CRM_USER_PASSWORD_MIN_LENGTH,
  createCrmDevice,
  createCrmUser,
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
  manager: 'Manager',
  owner: 'Owner',
}

const roleOptions = [
  { label: 'Manager', value: 'manager' },
  { label: 'Owner', value: 'owner' },
]

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
  const [isUserModalOpen, setIsUserModalOpen] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState<'owner' | 'manager'>('manager')

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

  function openUserModal() {
    setUserEmail('')
    setUserPassword('')
    setUserRole('manager')
    setIsUserModalOpen(true)
  }

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      const user = await createCrmUser(tenantContext, {
        email: userEmail,
        password: userPassword,
        role: userRole,
      })
      setData((current) => ({
        ...current,
        users: [...current.users, user].sort((first, second) => first.email.localeCompare(second.email)),
      }))
      setIsUserModalOpen(false)
      sileo.success({ title: 'Usuario CRM creado' })
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
      <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[340px_minmax(0,1fr)] xl:!gap-6">
        <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Nuevo dispositivo</span>
            <MonitorSmartphone className="h-4 w-4" />
          </div>
          <form className="grid gap-3 p-3.5 !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitDevice(event)}>
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
              <UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none" disabled={disabled} maxLength={80} onChange={(event) => setDeviceName(event.target.value)} required value={deviceName} />
            </Field>
            <Field label="Modo">
              <CrmSelect onChange={(value) => setDeviceMode(value as DeviceMode)} options={modeOptions} value={deviceMode} />
            </Field>
            <p className="!m-0 !text-xs !leading-relaxed !text-[var(--crm-text-muted)]">Se crearán automáticamente un email de acceso sin identificadores y una contraseña de 6 caracteres.</p>
            <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !deviceVenueId || !deviceName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear dispositivo
            </UiButton>
          </form>
        </section>

        <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]"><h2>Dispositivos</h2><p>{data.devices.length} dispositivos registrados</p></div>
            <UiButton aria-label="Actualizar dispositivos" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !text-[var(--crm-text-muted)]" disabled={disabled} onClick={() => void runAction(refresh)} type="button"><RefreshCw className="!size-4" /></UiButton>
          </div>
          <div className="!divide-y !divide-[var(--crm-border-subtle)]">
            {data.devices.map((device) => {
              const venue = venueById.get(device.venueId)
              const mode = modeOptions.find((option) => option.value === device.deviceMode)?.label ?? 'Caja'
              const isEditing = editingDeviceId === device.id
              return (
                <div className="!px-[18px] !py-3 md:!px-[22px]" key={device.id}>
                  <div className="!grid !min-h-[68px] !items-center !gap-3 md:!grid-cols-[minmax(150px,0.8fr)_minmax(220px,1.2fr)_100px_auto]">
                    <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]"><strong>{device.name}</strong><span>{venue?.name ?? 'Local no disponible'} · {mode}</span></div>
                    <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]">
                      <strong>{device.account?.email || 'Sin credenciales asociadas'}</strong>
                      <span>{device.account ? 'Credencial de acceso del dispositivo' : 'Requiere revisión'}</span>
                    </div>
                    <div className="!grid !justify-items-start !gap-1">
                      <span className={device.account?.isActive ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold !inline-flex !min-h-6 !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]' : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold !inline-flex !min-h-6 !rounded-full !bg-[var(--crm-surface-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-text-secondary)]'}>
                        {device.account?.hasActiveLogin ? 'En sesión' : device.account?.isActive ? 'Activo' : 'Inactivo'}
                      </span>
                    </div>
                    <div className="!flex !flex-wrap !items-center !justify-start !gap-2 md:!justify-end">
                      <UiButton aria-label={`Editar dispositivo ${device.name}`} className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !bg-[var(--crm-blue)] !text-white" disabled={disabled || !device.account} onClick={() => startEditingDevice(device)} title="Editar nombre, modo o contraseña" type="button"><Pencil className="!size-4" /></UiButton>
                      {tenantContext.role === 'owner' ? (
                        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-surface-soft)] !px-3 !text-[13px] !font-semibold" disabled={disabled || !device.account?.hasActiveLogin} onClick={() => void releaseDeviceLogin(device)} title={device.account?.loginHeartbeatAt ? `Última actividad: ${formatCrmDateTime(device.account.loginHeartbeatAt)}` : 'Cerrar la sesión de este dispositivo'} type="button"><LogOut className="!size-4" /> Liberar</UiButton>
                      ) : null}
                      <UiButton aria-label={`Eliminar dispositivo ${device.name}`} className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95 !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-red-soft)] !px-3 !text-[13px] !font-semibold !text-[var(--crm-red)]" disabled={disabled} onClick={() => void removeDevice(device)} title="Eliminar definitivamente" type="button"><Trash2 className="!size-4" /> Eliminar</UiButton>
                    </div>
                  </div>
                  {isEditing ? (
                    <form className="!mt-3 !grid !grid-cols-1 !gap-3 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-surface-soft)] !p-4 md:!grid-cols-3" onSubmit={(event) => void submitDeviceEdit(event)}>
                      <Field label="Nombre">
                        <UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium" disabled={disabled} maxLength={80} onChange={(event) => setEditingDeviceName(event.target.value)} required value={editingDeviceName} />
                      </Field>
                      <Field label="Nueva contraseña (opcional)">
                        <UiInput autoComplete="new-password" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium" disabled={disabled} maxLength={6} minLength={6} onChange={(event) => setEditingDevicePassword(event.target.value)} placeholder="6 caracteres" type="text" value={editingDevicePassword} />
                      </Field>
                      <Field label="Modo">
                        <CrmSelect disabled={disabled} onChange={(value) => setEditingDeviceMode(value as DeviceMode)} options={modeOptions} value={editingDeviceMode} />
                      </Field>
                      <p className="!m-0 !text-xs !text-[var(--crm-text-muted)] md:!col-span-3">Al cambiar el nombre también se actualizará automáticamente el email de acceso.</p>
                      <div className="!flex !gap-2 md:!col-span-3 md:!justify-end">
                        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !px-3 !text-[13px] !font-semibold" disabled={disabled} onClick={cancelEditingDevice} type="button"><X className="!size-4" /> Cancelar</UiButton>
                        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !editingDeviceName.trim() || (editingDevicePassword.length > 0 && editingDevicePassword.length !== 6)} type="submit"><Save className="!size-4" /> Guardar cambios</UiButton>
                      </div>
                    </form>
                  ) : null}
                </div>
              )
            })}
            {!data.devices.length ? <EmptyList message="No hay dispositivos registrados." /> : null}
          </div>
        </section>

        <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] xl:!col-span-2">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]"><h2>Usuarios con acceso al CRM</h2><p>{data.users.length} usuarios gestores · las cuentas técnicas de dispositivos no aparecen aquí</p></div>
            <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !shrink-0 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || tenantContext.role !== 'owner'} onClick={openUserModal} type="button">
              <Plus className="!size-4" /> <span className="!hidden sm:!inline">Añadir usuario</span><span className="sm:!hidden">Añadir</span>
            </UiButton>
          </div>
          <div className="!divide-y !divide-[var(--crm-border-subtle)]">
            {data.users.map((user) => (
              <div className="!grid !min-h-[68px] !items-center !gap-3 !px-[18px] !py-3 sm:!grid-cols-[minmax(0,1fr)_140px_100px] md:!px-[22px]" key={user.id}>
                <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]"><strong>{user.fullName || user.email}</strong><span>{user.email}</span></div>
                <span className="!text-sm !font-semibold !text-[var(--crm-text-secondary)]">{roleLabels[user.role]}</span>
                <span className={user.isActive ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold !inline-flex !min-h-6 !w-fit !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]' : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold !inline-flex !min-h-6 !w-fit !rounded-full !bg-[var(--crm-surface-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-text-secondary)]'}>{user.isActive ? 'Activo' : 'Inactivo'}</span>
              </div>
            ))}
            {!data.users.length ? <EmptyList message="No hay usuarios gestores configurados." /> : null}
          </div>
        </section>
      </div>

      {isUserModalOpen ? (
        <CrmModal label="Añadir usuario CRM" onClose={() => setIsUserModalOpen(false)}>
          <form onSubmit={(event) => void submitUser(event)}>
            <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
              <div>
                <h2 className="!m-0 !text-lg !font-bold">Nuevo usuario CRM</h2>
                <p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Crea sus credenciales y asigna el nivel de acceso al negocio.</p>
              </div>
              <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !shrink-0 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" disabled={disabled} onClick={() => setIsUserModalOpen(false)} type="button"><X className="!size-4" /></UiButton>
            </div>
            <div className="!grid !gap-4 !px-5 !py-5">
              <Field label="Email">
                <UiInput
                  autoComplete="email"
                  autoFocus
                  className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none"
                  disabled={disabled}
                  maxLength={254}
                  onChange={(event) => setUserEmail(event.target.value)}
                  placeholder="usuario@empresa.com"
                  required
                  type="email"
                  value={userEmail}
                />
              </Field>
              <Field label="Contraseña">
                <UiInput
                  autoComplete="new-password"
                  className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none"
                  disabled={disabled}
                  maxLength={72}
                  minLength={CRM_USER_PASSWORD_MIN_LENGTH}
                  onChange={(event) => setUserPassword(event.target.value)}
                  required
                  type="password"
                  value={userPassword}
                />
              </Field>
              <Field label="Rol">
                <CrmSelect
                  disabled={disabled}
                  onChange={(value) => setUserRole(value as 'owner' | 'manager')}
                  options={roleOptions}
                  required
                  value={userRole}
                />
              </Field>
              <p className="m-0 text-xs leading-6 text-[var(--crm-text-muted)]">La contraseña debe tener al menos {CRM_USER_PASSWORD_MIN_LENGTH} caracteres.</p>
              <div className="!flex !flex-col-reverse !gap-2 sm:!flex-row sm:!justify-end">
                <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !px-4 !text-[13px] !font-semibold" disabled={disabled} onClick={() => setIsUserModalOpen(false)} type="button">Cancelar</UiButton>
                <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !userEmail.trim() || userPassword.length < CRM_USER_PASSWORD_MIN_LENGTH} type="submit">
                  <ShieldCheck className="!size-4" /> Crear usuario
                </UiButton>
              </div>
            </div>
          </form>
        </CrmModal>
      ) : null}

      {generatedCredentials ? (
        <CrmModal label="Credenciales del nuevo dispositivo" onClose={() => setGeneratedCredentials(null)}>
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
            <div><h2 className="!m-0 !text-lg !font-bold">Dispositivo creado</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Guarda estas credenciales: la contraseña solo se muestra ahora.</p></div>
            <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]" onClick={() => setGeneratedCredentials(null)} type="button"><X className="!size-4" /></UiButton>
          </div>
          <div className="!grid !gap-4 !px-5 !py-5">
            <CredentialRow label="Email de acceso" onCopy={() => void copyCredential(generatedCredentials.email, 'Email')} value={generatedCredentials.email} />
            <CredentialRow label="Contraseña" large onCopy={() => void copyCredential(generatedCredentials.password, 'Contraseña')} value={generatedCredentials.password} />
            <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !mt-1 !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" onClick={() => setGeneratedCredentials(null)} type="button">He guardado las credenciales</UiButton>
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
        <UiButton aria-label={`Copiar ${label.toLowerCase()}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !shrink-0 !items-center !justify-center !rounded-[9px] !bg-[var(--crm-input-bg)] !text-[var(--crm-text-secondary)]" onClick={onCopy} type="button"><Copy className="!size-4" /></UiButton>
      </div>
    </div>
  )
}
