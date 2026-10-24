import { Button } from '../ui/Button'

export function MenuEntryMode({ mode, disabled, onChange }: { mode: 'individual' | 'courses'; disabled: boolean; onChange: (mode: 'individual' | 'courses') => void }) {
  return <div aria-label="Forma de pedir los menús" className="grid grid-cols-2 gap-1 rounded-[12px] border border-[var(--separator)] bg-[var(--background)] p-1" role="group">
    {(['individual', 'courses'] as const).map((value) => <Button aria-pressed={mode === value} className={`!min-h-11 !rounded-[8px] !px-4 !font-semibold ${mode === value ? '!bg-[var(--surface)] !text-[var(--foreground)] shadow-sm' : '!bg-transparent !text-[var(--muted)]'}`}
      disabled={disabled} key={value} onClick={() => onChange(value)} type="button" variant="tertiary">{value === 'individual' ? 'Individual' : 'Por pases'}</Button>)}
  </div>
}
