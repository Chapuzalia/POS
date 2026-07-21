import { Check, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

export type CrmSelectOption = {
  description?: string
  disabled?: boolean
  label: string
  value: string
}

type MenuPosition = {
  left: number
  maxHeight?: number
  scrollable: boolean
  top: number
  width: number
}

type Props = {
  ariaLabel?: string
  className?: string
  defaultValue?: string
  disabled?: boolean
  leadingIcon?: ReactNode
  menuLabel?: string
  name?: string
  onChange?: (value: string) => void
  options: CrmSelectOption[]
  placeholder?: string
  required?: boolean
  value?: string
}

const MENU_GAP = 6
const MENU_PADDING = 8
const OPTION_HEIGHT = 42
const VIEWPORT_MARGIN = 4

export function CrmSelect({
  ariaLabel,
  className = '',
  defaultValue = '',
  disabled = false,
  leadingIcon,
  menuLabel,
  name,
  onChange,
  options,
  placeholder = 'Selecciona una opción',
  required = false,
  value,
}: Props) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selectedValue = value ?? uncontrolledValue
  const selectedIndex = options.findIndex((option) => option.value === selectedValue)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const enabledOptions = options.filter((option) => !option.disabled)
  const isDisabled = disabled || enabledOptions.length === 0

  function getNextEnabledIndex(start: number, direction: 1 | -1) {
    if (!enabledOptions.length) return -1
    let index = start
    for (let count = 0; count < options.length; count += 1) {
      index = (index + direction + options.length) % options.length
      if (!options[index]?.disabled) return index
    }
    return -1
  }

  function openMenu(preferredIndex = selectedIndex) {
    if (isDisabled) return
    const firstEnabledIndex = getNextEnabledIndex(-1, 1)
    setActiveIndex(preferredIndex >= 0 && !options[preferredIndex]?.disabled ? preferredIndex : firstEnabledIndex)
    setIsOpen(true)
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setIsOpen(false)
    setMenuPosition(null)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function selectOption(option: CrmSelectOption) {
    if (option.disabled) return
    if (value === undefined) setUncontrolledValue(option.value)
    onChange?.(option.value)
    closeMenu({ restoreFocus: true })
  }

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const estimatedHeight = options.length * OPTION_HEIGHT + Math.max(0, options.length - 1) * 2 + MENU_PADDING
    const naturalHeight = menuRef.current?.scrollHeight ?? estimatedHeight
    const roomBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN
    const roomAbove = rect.top - VIEWPORT_MARGIN
    const fitsBelow = naturalHeight + MENU_GAP <= roomBelow
    const fitsAbove = naturalHeight + MENU_GAP <= roomAbove
    const openAbove = fitsBelow ? false : fitsAbove || roomAbove > roomBelow
    const availableHeight = Math.max(96, (openAbove ? roomAbove : roomBelow) - MENU_GAP)
    const scrollable = naturalHeight > availableHeight + 1
    const renderedHeight = scrollable ? availableHeight : naturalHeight
    const width = Math.max(rect.width, 180)
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN))

    setMenuPosition({
      left,
      maxHeight: scrollable ? availableHeight : undefined,
      scrollable,
      top: openAbove ? Math.max(VIEWPORT_MARGIN, rect.top - renderedHeight - MENU_GAP) : rect.bottom + MENU_GAP,
      width,
    })
  }, [options.length])
  useLayoutEffect(() => {
    if (isOpen) updateMenuPosition()
  }, [isOpen, updateMenuPosition])

  useEffect(() => {
    if (!isOpen) return undefined

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu()
    }

    function repositionOrClose(event: Event) {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return
      updateMenuPosition()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('resize', repositionOrClose)
    window.addEventListener('scroll', repositionOrClose, true)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('resize', repositionOrClose)
      window.removeEventListener('scroll', repositionOrClose, true)
    }
  }, [isOpen, updateMenuPosition])

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!isOpen) {
        openMenu(event.key === 'ArrowDown' ? selectedIndex : getNextEnabledIndex(0, -1))
      } else {
        setActiveIndex((current) => getNextEnabledIndex(current, event.key === 'ArrowDown' ? 1 : -1))
      }
    } else if (event.key === 'Home' && isOpen) {
      event.preventDefault()
      setActiveIndex(getNextEnabledIndex(-1, 1))
    } else if (event.key === 'End' && isOpen) {
      event.preventDefault()
      setActiveIndex(getNextEnabledIndex(0, -1))
    } else if ((event.key === 'Enter' || event.key === ' ') && isOpen) {
      event.preventDefault()
      const option = options[activeIndex]
      if (option) selectOption(option)
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    } else if (event.key === 'Tab') {
      closeMenu()
    }
  }

  const menuRoot = document.querySelector<HTMLElement>('.crm-shell') ?? document.body

  return (
    <div className={`crm-select !relative !min-w-0 ${className}`}>
      {name ? <input name={name} type="hidden" value={selectedValue} /> : null}
      <button
        aria-activedescendant={isOpen && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-required={required || undefined}
        className="!inline-flex !h-11 !w-full !min-w-0 !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-left !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 hover:!bg-[var(--crm-surface-hover)] focus-visible:!border-[var(--crm-blue)] focus-visible:!ring-2 focus-visible:!ring-[var(--crm-blue-soft)] disabled:!cursor-not-allowed disabled:!opacity-55"
        disabled={isDisabled}
        onClick={() => isOpen ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        {leadingIcon}
        <span className={`!min-w-0 !flex-1 !truncate ${selectedOption ? '' : '!text-[var(--crm-text-muted)]'}`}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className={`!size-4 !shrink-0 !text-[var(--crm-text-muted)] !transition-transform !duration-150 ${isOpen ? '!rotate-180' : ''}`} />
      </button>

      {isOpen ? createPortal(
        <div
          aria-label={menuLabel ?? ariaLabel ?? placeholder}
          className={'!fixed !z-[120] !grid !gap-0.5 !rounded-[12px] !border !border-[var(--crm-border)] !bg-[var(--crm-surface)] !p-1 !shadow-[var(--crm-shadow-floating)] ' + (menuPosition?.scrollable ? '!overflow-y-auto' : '!overflow-y-visible')}
          id={listboxId}
          ref={menuRef}
          role="listbox"
          style={menuPosition ?? { left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, visibility: 'hidden', width: 180 }}
        >
          {options.map((option, index) => {
            const selected = option.value === selectedValue
            const active = index === activeIndex
            return (
              <button
                aria-disabled={option.disabled || undefined}
                aria-selected={selected}
                className={selected
                  ? '!flex !min-h-10 !w-full !items-center !gap-2 !rounded-[9px] !border-0 !bg-[var(--crm-blue-soft)] !px-3 !text-left !text-[13px] !font-semibold !text-[var(--crm-blue)]'
                  : active
                    ? '!flex !min-h-10 !w-full !items-center !gap-2 !rounded-[9px] !border-0 !bg-[var(--crm-surface-hover)] !px-3 !text-left !text-[13px] !font-medium !text-[var(--crm-text)]'
                    : '!flex !min-h-10 !w-full !items-center !gap-2 !rounded-[9px] !border-0 !bg-transparent !px-3 !text-left !text-[13px] !font-medium !text-[var(--crm-text-secondary)] hover:!bg-[var(--crm-surface-hover)] hover:!text-[var(--crm-text)] disabled:!opacity-45'}
                disabled={option.disabled}
                id={`${listboxId}-option-${index}`}
                key={option.value}
                onClick={() => selectOption(option)}
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span className="!min-w-0 !flex-1">
                  <span className="!block !truncate">{option.label}</span>
                  {option.description ? <small className="!mt-0.5 !block !truncate !text-[11px] !font-medium !text-[var(--crm-text-muted)]">{option.description}</small> : null}
                </span>
                {selected ? <Check className="!size-4 !shrink-0" /> : null}
              </button>
            )
          })}
        </div>,
        menuRoot,
      ) : null}
    </div>
  )
}
