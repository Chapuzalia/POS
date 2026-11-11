import { Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { MAX_MENU_BATCH_SIZE } from '../../features/restaurant/services/menuBatch'
import { Button, Input } from '../ui'

export function MenuCountControl({ count, disabled, onChange }: { count: number; disabled: boolean; onChange: (count: number) => void }) {
  const [input, setInput] = useState<string | null>(null)

  function commit(value: string) {
    setInput(null)
    const next = Number(value)
    if (!disabled && Number.isSafeInteger(next) && next >= 1 && next <= MAX_MENU_BATCH_SIZE && next !== count) onChange(next)
  }

  return <div className="flex items-center justify-between gap-3">
    <span className="text-sm font-semibold">Menús</span>
    <div className="flex items-center rounded-[12px] border border-[var(--separator)] bg-[var(--background)] p-1">
      <Button aria-label="Un menú menos" className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={disabled || count <= 1} onClick={() => commit(String(count - 1))} type="button" variant="tertiary"><Minus aria-hidden="true" className="h-4 w-4" /></Button>
      <Input aria-label="Número de menús" className="!w-14 !px-1 text-center text-lg font-bold tabular-nums" disabled={disabled} inputMode="numeric" max={MAX_MENU_BATCH_SIZE} min={1}
        onBlur={(event) => commit(event.currentTarget.value)} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} type="number" value={input ?? String(count)} />
      <Button aria-label="Un menú más" className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={disabled || count >= MAX_MENU_BATCH_SIZE} onClick={() => commit(String(count + 1))} type="button" variant="tertiary"><Plus aria-hidden="true" className="h-4 w-4" /></Button>
    </div>
  </div>
}
