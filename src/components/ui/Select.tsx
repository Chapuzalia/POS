import { ListBox, ListBoxItem, Select as HeroSelect } from '@heroui/react'
import { Check } from 'lucide-react'

export type SelectOption = {
  disabled?: boolean
  label: string
  value: string
}

type SelectProps = {
  ariaLabel: string
  className?: string
  disabled?: boolean
  onChange: (value: string) => void
  options: SelectOption[]
  value: string
}

export function Select({ ariaLabel, className, disabled = false, onChange, options, value }: SelectProps) {
  const selectedOption = options.find((option) => option.value === value)

  return (
    <HeroSelect
      aria-label={ariaLabel}
      className={className}
      fullWidth
      isDisabled={disabled}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key))
      }}
      selectedKey={value || null}
      variant="secondary"
    >
      <HeroSelect.Trigger>
        <HeroSelect.Value>{selectedOption?.label ?? ariaLabel}</HeroSelect.Value>
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <HeroSelect.Popover>
        <ListBox items={options}>
          {(option) => (
            <ListBoxItem id={option.value} isDisabled={option.disabled} textValue={option.label}>
              {option.label}
              <ListBoxItem.Indicator>
                <Check aria-hidden="true" className="size-4" />
              </ListBoxItem.Indicator>
            </ListBoxItem>
          )}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  )
}
