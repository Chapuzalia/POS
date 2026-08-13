import { Input as UiInput } from '../../../../components/ui/Input'
import { ListBox, ListBoxItem, Select } from '@heroui/react'
import { Check, ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export type CrmSelectOption = {
  description?: string
  disabled?: boolean
  label: string
  value: string
}

type Props = {
  ariaLabel?: string
  className?: string
  compact?: boolean
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

export function CrmSelect({
  ariaLabel,
  className = '',
  compact = false,
  defaultValue = '',
  disabled = false,
  leadingIcon,
  menuLabel,
  name,
  onChange,
  options,
  placeholder = 'Selecciona una opci\u00f3n',
  required = false,
  value,
}: Props) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const selectedValue = value ?? uncontrolledValue
  const selectedOption = options.find((option) => option.value === selectedValue)
  const isDisabled = disabled || options.every((option) => option.disabled)

  return (
    <div className={`relative min-w-0 w-full ${className}`}>
      {name ? <UiInput name={name} type="hidden" value={selectedValue} /> : null}
      <Select
        aria-label={ariaLabel ?? menuLabel ?? placeholder}
        fullWidth
        isDisabled={isDisabled}
        isRequired={required}
        onSelectionChange={(key) => {
          if (key === null) return
          const nextValue = String(key)
          if (value === undefined) setUncontrolledValue(nextValue)
          onChange?.(nextValue)
        }}
        selectedKey={selectedValue || null}
        variant="secondary"
      >
        <Select.Trigger
          aria-haspopup="listbox"
          className={`!flex !min-w-0 !items-center !gap-2.5 !border !border-[var(--crm-input-border)] !bg-[var(--crm-input-bg)] !leading-none !font-medium !text-[var(--crm-text)] focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)] ${compact ? '!h-9 !rounded-[9px] !px-2.5 !text-[12px]' : '!h-11 !rounded-[10px] !px-3 !text-[13px]'}`}
        >
          {leadingIcon ? <span className="!flex !size-[18px] !shrink-0 !items-center [&_svg]:!size-[18px]">{leadingIcon}</span> : null}
          <span className="!flex !w-0 !min-w-0 !flex-1 !items-center !gap-3">
            <Select.Value className={`!flex !min-w-0 !flex-1 !items-center !truncate !leading-none ${selectedOption ? '' : '!text-[var(--crm-text-muted)]'}`}>
              {selectedOption?.label ?? placeholder}
            </Select.Value>
            <span aria-hidden="true" className="!flex !size-5 !shrink-0 !items-center !justify-center !text-[var(--crm-text-muted)]">
              <ChevronDown className="!size-4" />
            </span>
          </span>
        </Select.Trigger>
        <Select.Popover
          className="!z-[120] !max-h-72 !min-w-[var(--trigger-width)] !rounded-[12px] !border !border-[var(--crm-popover-border)] !bg-[var(--crm-popover-bg)] !p-1 !text-[var(--crm-popover-text)] !opacity-100 !shadow-[var(--crm-shadow-floating)] !backdrop-blur-none [&_[role=listbox]]:!bg-[var(--crm-popover-bg)] [&_[role=listbox]]:!text-[var(--crm-popover-text)]"
          placement="bottom"
        >
          <ListBox aria-label={menuLabel ?? ariaLabel ?? placeholder} className="!bg-[var(--crm-popover-bg)]" items={options}>
            {(option) => (
              <ListBoxItem
                className="!flex !min-h-10 !items-center !gap-3 !rounded-lg !bg-transparent !px-3 !py-2 !text-[13px] !leading-tight !text-[var(--crm-popover-text)] hover:!bg-[var(--crm-popover-hover)] data-[focused]:!bg-[var(--crm-popover-hover)] data-[hovered]:!bg-[var(--crm-popover-hover)] data-[selected]:!bg-[var(--crm-popover-selected)]"
                id={option.value}
                isDisabled={option.disabled}
                textValue={option.label}
              >
                <span className="!min-w-0 !flex-1 !pr-2.5">
                  <span className="!block !truncate">{option.label}</span>
                  {option.description ? (
                    <small className="!mt-0.5 !block !truncate !text-[11px] !font-medium !text-[var(--crm-popover-muted)]">
                      {option.description}
                    </small>
                  ) : null}
                </span>
                <span aria-hidden="true" className="!ml-auto !flex !size-5 !shrink-0 !items-center !justify-center">
                  {option.value === selectedValue ? <Check className="!size-4 !shrink-0 !stroke-[2.5] !text-[var(--crm-popover-accent)]" /> : null}
                </span>
              </ListBoxItem>
            )}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}
