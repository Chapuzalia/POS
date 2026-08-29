import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AppModal } from '../../../components/ui/AppModal'
import { Button as UiButton } from '../../../components/ui/Button'
import { Input as UiInput } from '../../../components/ui/Input'

type Props = {
  canSave: boolean
  defaultName: string
  isBusy: boolean
  isOnline: boolean
  mobileLayout: boolean
  onDiscard: () => void
  onSave: (name: string) => Promise<boolean>
}

export function QuickSaleExitModal({ canSave, defaultName, isBusy, isOnline, mobileLayout, onDiscard, onSave }: Props) {
  const [name, setName] = useState(defaultName)
  const [submitting, setSubmitting] = useState(false)
  const validName = Boolean(name.trim())
  const canSubmit = canSave && isOnline && !isBusy && !submitting && validName

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSave(name.trim())
    } finally {
      setSubmitting(false)
    }
  }

  return <AppModal
    containerClassName={mobileLayout ? '!p-0' : '!p-4'}
    dialogClassName={mobileLayout ? '!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0' : ''}
    dismissDisabled
    label="Salir de Venta rápida"
    maxWidth={480}
    onClose={() => undefined}
    placement={mobileLayout ? 'bottom' : 'center'}
  >
    <form
      className={`grid w-full gap-4 bg-[var(--surface)] text-[var(--foreground)] ${mobileLayout ? 'rounded-t-[20px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5' : 'rounded-[var(--radius)] p-6'}`}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div>
        <h1 className="m-0 text-lg font-bold">Guardar Venta rápida</h1>
        <p className="mb-0 mt-1 leading-6 text-[var(--muted)]">Puedes guardarla como mesa virtual o descartarla definitivamente.</p>
      </div>
      <label className="grid gap-1.5">
        <span className="text-base font-semibold">Nombre de la mesa virtual</span>
        <UiInput autoFocus maxLength={80} onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <div className="mt-1 grid grid-cols-2 gap-2.5">
        <UiButton disabled={isBusy || submitting} onClick={onDiscard} type="button" variant="dangerSoft">
          <Trash2 size={17} /> No guardar
        </UiButton>
        <UiButton
          className="border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
          disabled={!canSubmit}
          type="submit"
        >
          <Save size={17} /> Guardar
        </UiButton>
      </div>
    </form>
  </AppModal>
}
