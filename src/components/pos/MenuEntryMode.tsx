import { Button } from '../ui/Button'

type Mode = 'individual' | 'courses'

export function MenuEntryMode({ mode, animateFrom, disabled, onChange }: { mode: Mode; animateFrom?: Mode; disabled: boolean; onChange: (mode: Mode) => void }) {
  // Changing modes mounts a different dialog, so animate from the previous side on entry too.
  const animation = animateFrom && animateFrom !== mode
    ? mode === 'courses' ? 'animate-[menu-mode-to-courses_220ms_ease-out]' : 'animate-[menu-mode-to-individual_220ms_ease-out]'
    : ''

  return <div aria-label="Forma de pedir los menús" className="relative isolate grid grid-cols-2 gap-1 rounded-[12px] border border-[var(--separator)] bg-[var(--background)] p-1" role="group">
    <span aria-hidden="true" className={`pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-12px)/2)] rounded-[8px] bg-[var(--surface)] shadow-sm transition-transform duration-[220ms] ease-out motion-reduce:animate-none motion-reduce:transition-none ${mode === 'courses' ? 'translate-x-[calc(100%+4px)]' : 'translate-x-0'} ${animation}`} />
    {(['individual', 'courses'] as const).map((value) => <Button aria-pressed={mode === value} className={`relative !min-h-11 !rounded-[8px] !bg-transparent !px-4 !font-semibold transition-colors duration-[220ms] motion-reduce:transition-none ${mode === value ? '!text-[var(--foreground)]' : '!text-[var(--muted)]'}`}
      disabled={disabled} key={value} onClick={() => onChange(value)} type="button" variant="tertiary">{value === 'individual' ? 'Individual' : 'Por pases'}</Button>)}
  </div>
}
