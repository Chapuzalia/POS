import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AppModal } from '../../../components/ui/AppModal'
import { Button as UiButton } from '../../../components/ui/Button'
import { Input as UiInput } from '../../../components/ui/Input'
import { NativeSelect as UiNativeSelect } from '../../../components/ui/NativeSelect'
import type { DiningArea, RestaurantTableShape } from '../types'

export type VirtualTableFormValue = {
  areaId: string | null
  name: string
  capacity: number
  shape: RestaurantTableShape
}

type Props = {
  areas: DiningArea[]
  defaultAreaId?: string
  defaultName: string
  isBusy: boolean
  isOnline: boolean
  mobileLayout: boolean
  onClose: () => void
  onSubmit: (value: VirtualTableFormValue) => Promise<boolean>
  requirePhysicalArea?: boolean
}

export function VirtualTableModal({
  areas,
  defaultAreaId,
  defaultName,
  isBusy,
  isOnline,
  mobileLayout,
  onClose,
  onSubmit,
  requirePhysicalArea = false,
}: Props) {
  const physicalAreas = useMemo(() => areas.filter((area) => !area.id.startsWith('virtual:')), [areas])
  const [name, setName] = useState(defaultName)
  const [capacity, setCapacity] = useState(2)
  const [shape, setShape] = useState<RestaurantTableShape>('square')
  const [areaId, setAreaId] = useState(() => {
    const validDefault = physicalAreas.some((area) => area.id === defaultAreaId) ? defaultAreaId! : ''
    return validDefault || (requirePhysicalArea ? physicalAreas[0]?.id ?? '' : '')
  })
  const valid = Boolean(name.trim())
    && capacity >= 1
    && capacity <= 99
    && (!requirePhysicalArea || physicalAreas.some((area) => area.id === areaId))

  async function submit() {
    if (!valid) return
    const created = await onSubmit({
      areaId: areaId || null,
      name: name.trim(),
      capacity,
      shape,
    })
    if (created) onClose()
  }

  return <AppModal
    containerClassName={mobileLayout ? '!p-0' : '!p-4'}
    dialogClassName={mobileLayout ? '!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0' : ''}
    dismissDisabled={isBusy}
    label="Crear mesa virtual"
    maxWidth={480}
    onClose={onClose}
    placement={mobileLayout ? 'bottom' : 'center'}
  >
    <form
      className={`grid w-full gap-4 bg-[var(--surface)] text-[var(--foreground)] [&_h1]:m-0 [&_p]:m-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-1.5 ${mobileLayout ? 'rounded-t-[20px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5' : 'rounded-[var(--radius)] p-6'}`}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div>
        <h1 className="text-lg font-bold">Crear mesa virtual</h1>
        <p>Solo estará disponible durante la sesión de caja actual.</p>
      </div>
      <label>
        <h2 className="text-base font-semibold">Nombre</h2>
        <UiInput autoFocus maxLength={80} onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <label>
        <h2 className="text-base font-semibold">Zona</h2>
        <UiNativeSelect aria-label="Zona de la mesa virtual" onChange={(event) => setAreaId(event.target.value)} value={areaId}>
          {!requirePhysicalArea ? <option value="">Virtual</option> : null}
          {physicalAreas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </UiNativeSelect>
        {requirePhysicalArea && physicalAreas.length === 0 ? <small className="text-[var(--danger)]">No hay ninguna sala disponible.</small> : null}
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <h2 className="text-base font-semibold">Capacidad</h2>
          <UiInput min="1" max="99" onChange={(event) => setCapacity(Number(event.target.value))} type="number" value={capacity} />
        </label>
        <label>
          <h2 className="text-base font-semibold">Forma</h2>
          <UiNativeSelect aria-label="Forma de la mesa virtual" onChange={(event) => setShape(event.target.value as RestaurantTableShape)} value={shape}>
            <option value="square">Cuadrada</option>
            <option value="rectangle">Rectangular</option>
            <option value="round">Redonda</option>
          </UiNativeSelect>
        </label>
      </div>
      <div className="mt-1 flex justify-end gap-2.5">
        <UiButton className="border-1" disabled={isBusy} onClick={onClose} type="button">Cancelar</UiButton>
        <UiButton
          className="border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
          disabled={isBusy || !isOnline || !valid}
          type="submit"
        >
          <Plus size={17} /> Crear mesa
        </UiButton>
      </div>
    </form>
  </AppModal>
}
