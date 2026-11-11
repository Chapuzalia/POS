import { Dropdown, Label } from '@heroui/react'
import { ChevronDown, Download } from 'lucide-react'
import { spreadsheetFormatOptions, type SpreadsheetFormat } from '../../../../lib/spreadsheet'

export function ExportFormatMenu({ disabled, isExporting, label, onExport }: {
  disabled: boolean
  isExporting: boolean
  label: string
  onExport: (format: SpreadsheetFormat) => void
}) {
  return (
    <Dropdown>
      <Dropdown.Trigger className="inline-flex !min-h-10 items-center justify-center gap-2 !rounded-[10px] !bg-[var(--crm-blue)] !px-3 text-[13px] font-semibold !text-white disabled:opacity-50" isDisabled={disabled || isExporting}>
        <Download className="!size-4" />{isExporting ? 'Exportando...' : label}<ChevronDown className="!-mr-1 !size-3.5" />
      </Dropdown.Trigger>
      <Dropdown.Popover className="!w-56" placement="bottom end">
        <Dropdown.Menu aria-label={label} onAction={(key) => onExport(String(key) as SpreadsheetFormat)}>
          {spreadsheetFormatOptions.map(({ format, label: optionLabel }) => (
            <Dropdown.Item id={format} key={format} textValue={optionLabel}><Download className="!size-4" /><Label>{optionLabel}</Label></Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}
