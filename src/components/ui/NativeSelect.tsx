import { ListBox, ListBoxItem, Select as HeroSelect } from '@heroui/react'
import { Check } from 'lucide-react'
import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Input } from './Input'

type NativeOption = {
  disabled: boolean
  label: ReactNode
  textValue: string
  value: string
}

export type NativeSelectProps = ComponentProps<'select'>

function collectOptions(children: ReactNode): NativeOption[] {
  const options: NativeOption[] = []

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return

    if (child.type === Fragment) {
      options.push(...collectOptions((child.props as { children?: ReactNode }).children))
      return
    }

    if (child.type !== 'option') return
    const option = child as ReactElement<{ children?: ReactNode; disabled?: boolean; value?: string | number }>
    const optionValue = String(option.props.value ?? '')
    options.push({
      disabled: option.props.disabled ?? false,
      label: option.props.children,
      textValue: typeof option.props.children === 'string' ? option.props.children : optionValue,
      value: optionValue,
    })
  })

  return options
}

export function NativeSelect({
  'aria-label': ariaLabel,
  children,
  className,
  defaultValue,
  disabled = false,
  name,
  onChange,
  required,
  value,
}: NativeSelectProps) {
  const options = collectOptions(children)
  const [uncontrolledValue, setUncontrolledValue] = useState(String(defaultValue ?? options[0]?.value ?? ''))
  const selectedValue = String(value ?? uncontrolledValue)
  const selectedOption = options.find((option) => option.value === selectedValue)

  return (
    <>
      {name ? <Input name={name} type="hidden" value={selectedValue} /> : null}
      <HeroSelect
        aria-label={ariaLabel ?? name ?? 'Seleccionar opcion'}
        className={className}
        fullWidth
        isDisabled={disabled}
        isRequired={required}
        onSelectionChange={(key) => {
          if (key === null) return
          const nextValue = String(key)
          if (value === undefined) setUncontrolledValue(nextValue)
          if (onChange) {
            const target = { value: nextValue } as HTMLSelectElement
            onChange({ currentTarget: target, target } as ChangeEvent<HTMLSelectElement>)
          }
        }}
        selectedKey={selectedValue || null}
        variant="secondary"
      >
        <HeroSelect.Trigger>
          <HeroSelect.Value>{selectedOption?.label ?? 'Seleccionar opcion'}</HeroSelect.Value>
          <HeroSelect.Indicator />
        </HeroSelect.Trigger>
        <HeroSelect.Popover>
          <ListBox items={options}>
            {(option) => (
              <ListBoxItem
                className="transition-colors hover:bg-foreground/5 data-[hovered]:bg-foreground/5"
                id={option.value}
                isDisabled={option.disabled}
                textValue={option.textValue}
              >
                {option.label}
                {option.value === selectedValue ? (
                  <ListBoxItem.Indicator>
                    <Check aria-hidden="true" className="size-4" />
                  </ListBoxItem.Indicator>
                ) : null}
              </ListBoxItem>
            )}
          </ListBox>
        </HeroSelect.Popover>
      </HeroSelect>
    </>
  )
}
