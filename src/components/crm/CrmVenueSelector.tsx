import { Building2, Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

type VenueOption = {
  id: string
  isActive: boolean
  name: string
}

type Props = {
  disabled: boolean
  onChange: (venueId: string) => void
  value: string
  venues: VenueOption[]
}

export function CrmVenueSelector({ disabled, onChange, value, venues }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listboxId = useId()
  const activeVenues = venues.filter((venue) => venue.isActive)
  const selectedVenue = activeVenues.find((venue) => venue.id === value)

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
    if (!activeVenues.length) return
    setIsOpen(true)
    focusOption(direction === 'first' ? 0 : activeVenues.length - 1)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openFromKeyboard('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openFromKeyboard('last')
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption((index + 1) % activeVenues.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption((index - 1 + activeVenues.length) % activeVenues.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(activeVenues.length - 1)
    } else if (event.key === 'Tab') {
      setIsOpen(false)
    }
  }

  function selectVenue(venueId: string) {
    onChange(venueId)
    setIsOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div className="crm-custom-venue-selector !relative !w-full !min-w-0 md:!w-auto md:!min-w-[220px]" ref={containerRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="!inline-flex !min-h-10 !w-full !min-w-0 !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-left !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!min-h-[42px]"
        disabled={disabled || !activeVenues.length}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <Building2 className="!hidden !size-4 !shrink-0 !text-[var(--crm-text-muted)] sm:!block" />
        <span className="!min-w-0 !flex-1 !truncate">{selectedVenue?.name ?? 'Selecciona un local'}</span>
        <ChevronDown className={`!size-4 !shrink-0 !text-[var(--crm-text-muted)] !transition-transform !duration-150 ${isOpen ? '!rotate-180' : ''}`} />
      </button>

      {isOpen ? (
        <div aria-label="Seleccionar local" className="!absolute !top-[calc(100%+8px)] !right-0 !z-50 !grid !w-full !min-w-[220px] !gap-1 !rounded-[12px] !border !border-[var(--crm-border)] !bg-[var(--crm-topbar-bg)] !p-1.5 !shadow-[var(--crm-shadow-floating)]" id={listboxId} role="listbox">
          {activeVenues.map((venue, index) => {
            const selected = venue.id === value
            return (
              <button
                aria-selected={selected}
                className={selected
                  ? '!flex !min-h-10 !w-full !items-center !gap-2 !rounded-[9px] !border-0 !bg-[var(--crm-blue-soft)] !px-3 !text-left !text-[13px] !font-semibold !text-[var(--crm-blue)]'
                  : '!flex !min-h-10 !w-full !items-center !gap-2 !rounded-[9px] !border-0 !bg-transparent !px-3 !text-left !text-[13px] !font-medium !text-[var(--crm-text-secondary)] hover:!bg-[var(--crm-surface-hover)] hover:!text-[var(--crm-text)]'}
                key={venue.id}
                onClick={() => selectVenue(venue.id)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                ref={(element) => { optionRefs.current[index] = element }}
                role="option"
                type="button"
              >
                <span className="!min-w-0 !flex-1 !truncate">{venue.name}</span>
                {selected ? <Check className="!size-4 !shrink-0" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
