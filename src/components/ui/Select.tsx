import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cx } from '../../utils/cx'

export type SelectOption = {
  label: string
  value: string
}

type SelectProps = {
  ariaLabel: string
  disabled?: boolean
  onChange: (value: string) => void
  options: SelectOption[]
  value: string
}

export function Select({ ariaLabel, disabled = false, onChange, options, value }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const selectedOption = options.find((option) => option.value === value)

  useEffect(() => {
    if (!isOpen) return

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      setIsOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  function focusOption(index: number) {
    window.requestAnimationFrame(() => optionRefs.current[index]?.focus())
  }

  function openFromKeyboard(direction: 'first' | 'last') {
    if (!options.length) return
    setIsOpen(true)
    focusOption(direction === 'first' ? 0 : options.length - 1)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Home') {
      event.preventDefault()
      openFromKeyboard('first')
    } else if (event.key === 'ArrowUp' || event.key === 'End') {
      event.preventDefault()
      openFromKeyboard('last')
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption((index + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption((index - 1 + options.length) % options.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    } else if (event.key === 'Tab') {
      setIsOpen(false)
    }
  }

  function selectOption(nextValue: string) {
    onChange(nextValue)
    setIsOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="relative w-full" ref={containerRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-left font-semibold text-[var(--field-foreground)] outline-none transition hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={disabled || !options.length}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate">{selectedOption?.label ?? 'Selecciona una opcion'}</span>
        <ChevronDown aria-hidden="true" className={cx('h-4 w-4 shrink-0 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen ? (
        <div aria-label={ariaLabel} className="absolute top-[calc(100%+6px)] z-50 grid w-full gap-1 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--surface)] p-1 shadow-[var(--shadow)]" id={listboxId} role="listbox">
          {options.map((option, index) => {
            const selected = option.value === value
            return (
              <button
                aria-selected={selected}
                className={cx(
                  'flex min-h-10 w-full items-center gap-3 rounded-[calc(var(--radius)-2px)] px-3 text-left text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
                  selected ? 'bg-[var(--accent-soft)] font-semibold text-[var(--accent)]' : 'font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]',
                )}
                key={option.value}
                onClick={() => selectOption(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                ref={(element) => { optionRefs.current[index] = element }}
                role="option"
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? <Check aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
