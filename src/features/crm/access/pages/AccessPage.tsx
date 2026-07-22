import { ArchiveX, Building2, Copy, LogOut, MonitorSmartphone, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { CrmModal } from '../../shared/components/CrmModal'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { formatCrmDateTime } from '../../shared/formatCrmDateTime'
import { sileo } from 'sileo'
import { type CrmAccessData, createCrmDevice, createCrmVenue, deleteCrmPosUser, loadCrmAccessData, releaseCrmPosUserLogin, retireCrmDevice, setCrmPosUserActive, updateCrmPosUser } from '../services/accessService'
import { type CrmPosUser, type DeviceMode, type TenantContext } from '../../../../types'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { type RunAction } from '../../shared/types'

export type AccessManagementCrmProps = {
  disabled: boolean
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
}

export function AccessManagementCrm({
  disabled,
  onVenuesChanged,
  runAction,
  tenantContext,
}: AccessManagementCrmProps) {
  const [data, setData] = useState<CrmAccessData>({ devices: [], users: [], venues: [] })
  const [venueName, setVenueName] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [deviceVenueId, setDeviceVenueId] = useState('')
  const [deviceMode, setDeviceMode] = useState<'satellite' | 'checkout' | 'hybrid'>('checkout')
  const [generatedCredentials, setGeneratedCredentials] = useState<{ email: string; password: string } | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingUserName, setEditingUserName] = useState('')
  const [editingUserEmail, setEditingUserEmail] = useState('')
  const [editingUserPassword, setEditingUserPassword] = useState('')
  const [editingUserDeviceId, setEditingUserDeviceId] = useState('')
  const [editingUserDeviceMode, setEditingUserDeviceMode] = useState<DeviceMode>('checkout')

  const refresh = useCallback(async () => {
    setData(await loadCrmAccessData(tenantContext))
  }, [tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  useEffect(() => {
    if (!deviceVenueId && data.venues.length) {
      setDeviceVenueId(data.venues[0].id)
    }
  }, [data.venues, deviceVenueId])

  async function submitVenue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      await createCrmVenue(tenantContext, venueName)
      setVenueName('')
      await Promise.all([refresh(), onVenuesChanged()])
    })
  }

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

  async function toggleUser(userId: string, isActive: boolean) {
    await runAction(async () => {
      await setCrmPosUserActive(tenantContext, userId, isActive)
      await refresh()
    })
  }

  function startEditingUser(user: CrmPosUser) {
    const assignedDevice = data.devices.find((device) => device.id === user.deviceId)
    setEditingUserId(user.id)
    setEditingUserName(user.fullName)
    setEditingUserEmail(user.email)
    setEditingUserPassword('')
    setEditingUserDeviceId(user.deviceId)
    setEditingUserDeviceMode(assignedDevice?.deviceMode ?? 'checkout')
  }

  async function releaseUserLogin(user: CrmPosUser) {
    if (!window.confirm(`Liberar la sesion de "${user.fullName || user.email}"? El dispositivo se desconectara en menos de 30 segundos.`)) return

    await runAction(async () => {
      await releaseCrmPosUserLogin(tenantContext, user.id)
      await refresh()
    })
  }

  function cancelEditingUser() {
    setEditingUserId(null)
    setEditingUserName('')
    setEditingUserEmail('')
    setEditingUserPassword('')
    setEditingUserDeviceId('')
    setEditingUserDeviceMode('checkout')
  }

  function changeEditingUserDevice(deviceId: string) {
    setEditingUserDeviceId(deviceId)
    const selectedDevice = data.devices.find((device) => device.id === deviceId)
    if (selectedDevice) setEditingUserDeviceMode(selectedDevice.deviceMode)
  }

  async function submitUserEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingUserId) return

    await runAction(async () => {
      await updateCrmPosUser(tenantContext, editingUserId, {
        deviceId: editingUserDeviceId,
        deviceMode: editingUserDeviceMode,
        email: editingUserEmail.trim(),
        fullName: editingUserName.trim(),
        password: editingUserPassword || undefined,
      })
      cancelEditingUser()
      await refresh()
    })
  }

  async function removeUser(user: CrmPosUser) {
    if (!window.confirm(`Eliminar la cuenta TPV de "${user.fullName || user.email}"? Esta accion no se puede deshacer.`)) return

    await runAction(async () => {
      await deleteCrmPosUser(tenantContext, user.id)
      if (editingUserId === user.id) cancelEditingUser()
      await refresh()
    })
  }

  async function retireDevice(deviceId: string, deviceName: string) {
    if (!window.confirm(`Retirar el dispositivo "${deviceName}"? Dejará de consumir una plaza del plan y se conservará su histórico.`)) return

    await runAction(async () => {
      await retireCrmDevice(tenantContext, deviceId)
      await refresh()
    })
  }

  const venueById = new Map(data.venues.map((venue) => [venue.id, venue]))
  const deviceById = new Map(data.devices.map((device) => [device.id, device]))
  const userByDeviceId = new Map(data.users.filter((user) => user.hasDeviceAssignment).map((user) => [user.deviceId, user]))
  const assignedDeviceIds = new Set(data.users.filter((user) => user.isActive).map((user) => user.deviceId))
  const activeDeviceCount = data.devices.filter((device) => device.isActive).length

  return (
    <>
      <div className="crm-access-layout !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[340px_minmax(0,1fr)] xl:!gap-6">
      <div className="crm-access-forms">
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Nuevo local</span><Building2 className="h-4 w-4" /></div>
          <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitVenue(event)}>
            <Field label="Nombre del local">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setVenueName(event.target.value)} required value={venueName} />
            </Field>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !venueName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear local
            </button>
          </form>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Nuevo dispositivo</span><MonitorSmartphone className="h-4 w-4" /></div>
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
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setDeviceName(event.target.value)} required value={deviceName} />
            </Field>
            <Field label="Modo">
              <CrmSelect
                onChange={(nextMode) => setDeviceMode(nextMode as typeof deviceMode)}
                options={[
                  { label: 'Satelite', value: 'satellite' },
                  { label: 'Caja', value: 'checkout' },
                  { label: 'Hibrido', value: 'hybrid' },
                ]}
                value={deviceMode}
              />
            </Field>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !deviceVenueId || !deviceName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear dispositivo
            </button>
          </form>
        </section>

      </div>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-access-users">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title"><h2>Usuarios de caja</h2><p>{data.users.length} cuentas configuradas · cierre tras 30 min sin actividad</p></div>
          <button aria-label="Actualizar usuarios" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void runAction(refresh)} type="button"><RefreshCw className="h-4 w-4" /></button>
        </div>
        <div className="crm-access-user-list">
          {data.users.map((user) => {
            const device = deviceById.get(user.deviceId)
            const venue = venueById.get(user.venueId)
            const deviceModeLabel = device?.deviceMode === 'satellite' ? 'Satelite' : device?.deviceMode === 'hybrid' ? 'Hibrido' : 'Caja'
            const editDevices = data.devices.filter((candidate) => (
              candidate.isActive
              && (!assignedDeviceIds.has(candidate.id) || (user.isActive && candidate.id === user.deviceId))
            ))
            const isEditing = editingUserId === user.id
            return (
              <div className="crm-access-user-entry" key={user.id}>
                <div className="crm-access-user-row !grid !min-h-[72px] !grid-cols-1 !items-center !gap-3.5 !py-2.5 sm:!grid-cols-[minmax(0,1fr)_auto] lg:!grid-cols-[minmax(180px,1fr)_minmax(170px,0.8fr)_100px_minmax(300px,auto)]">
                  <div className="crm-cell-main"><strong>{user.fullName || user.email}</strong><span>{user.email}</span></div>
                  <div className="crm-cell-main !col-span-1 sm:!col-span-full lg:!col-span-1">
                    <strong>{venue?.name ?? (user.hasDeviceAssignment ? 'Local no disponible' : 'Pendiente de asignar')}</strong>
                    <span>{device ? `${device.name} · ${deviceModeLabel}` : user.hasDeviceAssignment ? 'Dispositivo no disponible' : 'Edita el usuario para asignarle un dispositivo'}</span>
                  </div>
                  <div className="crm-user-statuses !col-start-1 !grid !justify-items-start !gap-[5px] sm:!col-auto">
                    <span className={user.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
                      {user.isActive ? 'Activo' : user.hasDeviceAssignment ? 'Inactivo' : 'Sin asignar'}
                    </span>
                    <span
                      className={user.hasActiveLogin ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}
                      title={user.loginHeartbeatAt ? `Ultima actividad: ${formatCrmDateTime(user.loginHeartbeatAt)}` : undefined}
                    >
                      {user.hasActiveLogin ? 'En sesion' : 'Libre'}
                    </span>
                  </div>
                  <div className="crm-access-user-actions !col-start-1 !flex !items-center !justify-start !gap-2 sm:!col-span-full lg:!col-auto lg:!justify-end">
                    <button aria-label="Editar usuario" className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => startEditingUser(user)} title="Editar y reasignar" type="button"><Pencil className="h-4 w-4" /></button>
                    {tenantContext.role === 'owner' ? (
                      <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !user.hasActiveLogin} onClick={() => void releaseUserLogin(user)} title="Cerrar la sesion abierta de este usuario" type="button">
                        <LogOut className="h-4 w-4" /> Liberar
                      </button>
                    ) : null}
                    <button className={user.isActive ? 'crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150'} disabled={disabled || !user.hasDeviceAssignment} onClick={() => void toggleUser(user.id, !user.isActive)} type="button">
                      {user.isActive ? 'Desactivar' : 'Activar'}
                    </button>
                    <button aria-label="Eliminar usuario" className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void removeUser(user)} title="Eliminar usuario" type="button"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                {isEditing ? (
                  <form className="crm-access-user-editor !grid !grid-cols-1 !gap-3 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-surface-soft)] !p-4 !mb-3.5 md:!grid-cols-2" onSubmit={(event) => void submitUserEdit(event)}>
                    <Field label="Nombre">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setEditingUserName(event.target.value)} required value={editingUserName} />
                    </Field>
                    <Field label="Email">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setEditingUserEmail(event.target.value)} required type="email" value={editingUserEmail} />
                    </Field>
                    <Field label="Nueva contrasena (opcional)">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} minLength={8} onChange={(event) => setEditingUserPassword(event.target.value)} placeholder="Dejar vacio para conservarla" type="password" value={editingUserPassword} />
                    </Field>
                    <Field label="Dispositivo">
                      <CrmSelect
                        disabled={disabled}
                        onChange={changeEditingUserDevice}
                        options={[
                          { disabled: true, label: 'Selecciona un dispositivo libre', value: '' },
                          ...editDevices.map((candidate) => ({
                            label: (venueById.get(candidate.venueId)?.name ?? '') + ' / ' + candidate.name,
                            value: candidate.id,
                          })),
                        ]}
                        required
                        value={editingUserDeviceId}
                      />
                    </Field>
                    <Field label="Modo de trabajo">
                      <CrmSelect
                        disabled={disabled}
                        onChange={(nextMode) => setEditingUserDeviceMode(nextMode as DeviceMode)}
                        options={[
                          { label: 'Caja', value: 'checkout' },
                          { label: 'Satelite', value: 'satellite' },
                          { label: 'Hibrido', value: 'hybrid' },
                        ]}
                        value={editingUserDeviceMode}
                      />
                    </Field>
                    <div className="crm-access-user-editor-actions !col-auto !flex !items-center !justify-stretch !gap-2 [&>button]:!flex-1 md:!col-span-full md:!justify-end md:[&>button]:!flex-none">
                      <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={cancelEditingUser} type="button"><X className="h-4 w-4" /> Cancelar</button>
                      <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !editingUserName.trim() || !editingUserEmail.trim() || !editingUserDeviceId || (editingUserPassword.length > 0 && editingUserPassword.length < 8)} type="submit"><Save className="h-4 w-4" /> Guardar cambios</button>
                    </div>
                  </form>
                ) : null}
              </div>
            )
          })}
          {!data.users.length ? <EmptyList message="No hay usuarios TPV creados." /> : null}
        </div>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] xl:!col-span-2">
          <div className="crm-list-toolbar !flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
            <div className="crm-list-title"><h2>Dispositivos</h2><p>{activeDeviceCount} activos · {data.devices.length} registrados · límite calculado sobre los activos</p></div>
            <MonitorSmartphone className="!size-5 !text-[var(--crm-text-muted)]" />
          </div>
          <div className="!divide-y !divide-[var(--crm-border-subtle)]">
            {data.devices.map((device) => {
              const assignedUser = userByDeviceId.get(device.id)
              const venue = venueById.get(device.venueId)
              const mode = device.deviceMode === 'satellite' ? 'Satélite' : device.deviceMode === 'hybrid' ? 'Híbrido' : 'Caja'
              return <div className="!grid !min-h-[68px] !items-center !gap-3 !px-[18px] !py-3 md:!grid-cols-[minmax(160px,1fr)_minmax(150px,0.8fr)_110px_auto] md:!px-[22px]" key={device.id}>
                <div className="crm-cell-main"><strong>{device.name}</strong><span>{venue?.name ?? 'Local no disponible'} · {mode}</span></div>
                <div className="crm-cell-main"><strong>{assignedUser?.fullName || assignedUser?.email || 'Sin usuario asignado'}</strong><span>{assignedUser ? assignedUser.email : 'Disponible para retirar'}</span></div>
                <span className={device.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>{device.isActive ? 'Activo' : 'Retirado'}</span>
                <button aria-label={`Retirar dispositivo ${device.name}`} className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-3 !text-[13px] !font-semibold !text-[var(--crm-red)]" disabled={disabled || !device.isActive || Boolean(assignedUser)} onClick={() => void retireDevice(device.id, device.name)} title={assignedUser ? 'Elimina o reasigna primero el usuario asociado' : device.isActive ? 'Retirar y liberar una plaza del plan' : 'Dispositivo retirado'} type="button"><ArchiveX className="!size-4" /> Retirar</button>
              </div>
            })}
            {!data.devices.length ? <EmptyList message="No hay dispositivos registrados." /> : null}
          </div>
        </section>
      </div>

      {generatedCredentials ? (
        <CrmModal label="Credenciales del nuevo dispositivo" onClose={() => setGeneratedCredentials(null)}>
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
            <div><h2 className="!m-0 !text-lg !font-bold">Dispositivo y usuario creados</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Guarda estas credenciales: la contraseña solo se muestra ahora.</p></div>
            <button aria-label="Cerrar" className="crm-icon-button !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={() => setGeneratedCredentials(null)} type="button"><X className="!size-4" /></button>
          </div>
          <div className="!grid !gap-4 !px-5 !py-5">
            <div className="!grid !gap-2"><span className="!text-[11px] !font-semibold !text-[var(--crm-text-muted)]">Email de acceso</span><div className="!flex !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3"><code className="!min-w-0 !flex-1 !overflow-hidden !text-ellipsis !text-sm !font-semibold">{generatedCredentials.email}</code><button aria-label="Copiar email" className="crm-icon-button !inline-flex !size-9 !shrink-0 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-input-bg)] !p-0 !text-[var(--crm-text-secondary)]" onClick={() => void copyCredential(generatedCredentials.email, 'Email')} type="button"><Copy className="!size-4" /></button></div></div>
            <div className="!grid !gap-2"><span className="!text-[11px] !font-semibold !text-[var(--crm-text-muted)]">Contraseña temporal</span><div className="!flex !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3"><code className="!min-w-0 !flex-1 !text-lg !font-bold !tracking-[0.08em]">{generatedCredentials.password}</code><button aria-label="Copiar contraseña" className="crm-icon-button !inline-flex !size-9 !shrink-0 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-input-bg)] !p-0 !text-[var(--crm-text-secondary)]" onClick={() => void copyCredential(generatedCredentials.password, 'Contraseña')} type="button"><Copy className="!size-4" /></button></div></div>
            <button className="crm-primary-button !mt-1 !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" onClick={() => setGeneratedCredentials(null)} type="button">He guardado las credenciales</button>
          </div>
        </CrmModal>
      ) : null}
    </>
  )
}
