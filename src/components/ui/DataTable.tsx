import { Table as HeroTable } from '@heroui/react'
import { Search, X } from 'lucide-react'
import {
  Children,
  Fragment,
  isValidElement,
  useDeferredValue,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Button } from './Button'
import { Input } from './Input'

export type DataTableSortDescriptor = {
  column: string
  direction: 'ascending' | 'descending'
}

export type DataTableProps = Omit<ComponentProps<'table'>, 'children'> & {
  children: ReactNode
  emptyContent?: ReactNode
  filterable?: boolean
  filterPlaceholder?: string
  filterValue?: string
  onFilterChange?: (value: string) => void
  onSortChange?: (descriptor: DataTableSortDescriptor) => void
  sortable?: boolean
  sortDescriptor?: DataTableSortDescriptor
  toolbarClassName?: string
}

type HeaderCellProps = ComponentProps<'th'> & {
  'data-column-key'?: string
  'data-sortable'?: boolean | 'true' | 'false'
}

type BodyCellProps = ComponentProps<'td'> & {
  'data-filter-value'?: string | number
  'data-sort-value'?: string | number
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' })
const actionColumnPattern = /^(acciones?|abrir\b|opciones?)/i
const interactiveElements = new Set(['a', 'button', 'input', 'select', 'textarea'])

function elementsOfType(children: ReactNode, type: string): ReactElement[] {
  const elements: ReactElement[] = []

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) {
      elements.push(...elementsOfType((child.props as { children?: ReactNode }).children, type))
    } else if (child.type === type) {
      elements.push(child)
    }
  })

  return elements
}

function textValue(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return ''
  return Children.toArray((node.props as { children?: ReactNode }).children).map(textValue).join(' ')
}

function isFalse(value: HeaderCellProps['data-sortable']) {
  return value === false || value === 'false'
}

function containsInteractiveControl(node: ReactNode): boolean {
  if (!isValidElement(node)) return false
  const props = node.props as { children?: ReactNode; onClick?: unknown; onPress?: unknown }
  if (typeof node.type === 'string' && interactiveElements.has(node.type)) return true
  if (props.onClick || props.onPress) return true
  return Children.toArray(props.children).some(containsInteractiveControl)
}

function compareValues(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return collator.compare(String(left), String(right))
}

export function DataTable({
  'aria-label': ariaLabel,
  children,
  className,
  emptyContent = 'No hay resultados para este filtro.',
  filterable = true,
  filterPlaceholder = 'Filtrar resultados…',
  filterValue,
  onFilterChange,
  onSortChange,
  sortable = true,
  sortDescriptor,
  toolbarClassName,
}: DataTableProps) {
  const [localFilter, setLocalFilter] = useState('')
  const [localSort, setLocalSort] = useState<DataTableSortDescriptor | undefined>()
  const currentFilter = filterValue ?? localFilter
  const deferredFilter = useDeferredValue(currentFilter.trim().toLocaleLowerCase('es'))
  const activeSort = sortDescriptor ?? localSort
  const sections = Children.toArray(children).filter(isValidElement)
  const head = sections.find((section) => section.type === 'thead')
  const body = sections.find((section) => section.type === 'tbody')
  const headProps = head?.props as ComponentProps<'thead'> | undefined
  const bodyProps = body?.props as ComponentProps<'tbody'> | undefined
  const headerRow = head ? elementsOfType(headProps?.children, 'tr')[0] : undefined
  const columns = headerRow ? elementsOfType((headerRow.props as { children?: ReactNode }).children, 'th') : []
  const rows = body ? elementsOfType(bodyProps?.children, 'tr') : []
  const columnKeys = columns.map((column, index) => {
    const props = column.props as HeaderCellProps
    return props['data-column-key'] ?? `column-${index}`
  })
  const actionColumnIndexes = columns.flatMap((column, index) => {
    const props = column.props as HeaderCellProps
    const label = textValue(props.children).trim() || props['aria-label'] || ''
    return actionColumnPattern.test(label) ? [index] : []
  })

  const filteredRows = deferredFilter
    ? rows.filter((row) => {
        const cells = elementsOfType((row.props as ComponentProps<'tr'>).children, 'td')
        return cells.some((cell, index) => {
          if (actionColumnIndexes.includes(index)) return false
          const props = cell.props as BodyCellProps
          const value = props['data-filter-value'] ?? textValue(props.children)
          return String(value).toLocaleLowerCase('es').includes(deferredFilter)
        })
      })
    : rows

  const visibleRows = activeSort && !onSortChange
    ? filteredRows.map((row, index) => ({ row, index })).sort((left, right) => {
        const columnIndex = columnKeys.indexOf(activeSort.column)
        if (columnIndex < 0) return left.index - right.index
        const leftCell = elementsOfType((left.row.props as ComponentProps<'tr'>).children, 'td')[columnIndex]
        const rightCell = elementsOfType((right.row.props as ComponentProps<'tr'>).children, 'td')[columnIndex]
        const leftProps = leftCell?.props as BodyCellProps | undefined
        const rightProps = rightCell?.props as BodyCellProps | undefined
        const leftValue = leftProps?.['data-sort-value'] ?? textValue(leftProps?.children)
        const rightValue = rightProps?.['data-sort-value'] ?? textValue(rightProps?.children)
        const comparison = compareValues(leftValue, rightValue)
        return (activeSort.direction === 'ascending' ? comparison : -comparison) || left.index - right.index
      }).map(({ row }) => row)
    : filteredRows

  function updateFilter(value: string) {
    if (filterValue === undefined) setLocalFilter(value)
    onFilterChange?.(value)
  }

  function updateSort(next: { column: React.Key; direction: 'ascending' | 'descending' }) {
    const descriptor: DataTableSortDescriptor = { column: String(next.column), direction: next.direction }
    if (sortDescriptor === undefined) setLocalSort(descriptor)
    onSortChange?.(descriptor)
  }

  return (
    <div className="min-w-0">
      {filterable ? (
        <div className={`flex items-center gap-2 border-b border-[var(--separator)] bg-[var(--surface)] p-3 ${toolbarClassName ?? ''}`}>
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{filterPlaceholder}</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-[var(--muted)]" />
            <Input
              aria-label={filterPlaceholder}
              className="!min-h-10 !rounded-xl !border-0 !bg-[var(--field)] !pl-9 !pr-10"
              onChange={(event) => updateFilter(event.target.value)}
              placeholder={filterPlaceholder}
              type="search"
              value={currentFilter}
            />
          </label>
          {currentFilter ? (
            <Button aria-label="Limpiar filtro" onClick={() => updateFilter('')} size="sm" type="button" variant="tertiary">
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}
      <HeroTable variant="secondary">
        <HeroTable.ScrollContainer>
          <HeroTable.Content
            aria-label={ariaLabel ?? 'Tabla de datos'}
            className={className}
            onSortChange={updateSort}
            sortDescriptor={activeSort}
          >
            <HeroTable.Header className={headProps?.className}>
              {columns.map((column, columnIndex) => {
                const props = column.props as HeaderCellProps
                const label = textValue(props.children).trim() || props['aria-label'] || `Columna ${columnIndex + 1}`
                const isActionColumn = actionColumnIndexes.includes(columnIndex)
                const allowsSorting = sortable && !isActionColumn && !isFalse(props['data-sortable'])
                return (
                  <HeroTable.Column
                    aria-label={props['aria-label']}
                    allowsSorting={allowsSorting}
                    className={props.className}
                    id={columnKeys[columnIndex]}
                    isRowHeader={columnIndex === 0}
                    key={columnKeys[columnIndex]}
                    textValue={label}
                  >
                    {({ sortDirection: direction }) => allowsSorting ? (
                      <HeroTable.SortableColumnHeader sortDirection={direction}>
                        {props.children || props['aria-label']}
                      </HeroTable.SortableColumnHeader>
                    ) : props.children}
                  </HeroTable.Column>
                )
              })}
            </HeroTable.Header>
            <HeroTable.Body
              className={bodyProps?.className}
              renderEmptyState={() => <div className="p-6 text-center text-sm font-semibold text-[var(--muted)]">{emptyContent}</div>}
            >
              {visibleRows.map((row, rowIndex) => {
                const rowProps = row.props as ComponentProps<'tr'>
                const cells = elementsOfType(rowProps.children, 'td')
                const rowId = String(row.key ?? `row-${rowIndex}`)
                const hasActionControls = actionColumnIndexes.some((index) => containsInteractiveControl(cells[index]))

                return (
                  <HeroTable.Row
                    aria-current={rowProps['aria-current']}
                    aria-label={rowProps['aria-label']}
                    className={rowProps.className}
                    id={rowId}
                    key={rowId}
                    onAction={rowProps.onClick && !hasActionControls
                      ? () => rowProps.onClick?.({} as MouseEvent<HTMLTableRowElement>)
                      : undefined}
                    textValue={cells.map((cell) => textValue((cell.props as BodyCellProps).children)).join(' ')}
                  >
                    {cells.map((cell, cellIndex) => {
                      const cellProps = cell.props as BodyCellProps
                      const value = textValue(cellProps.children)
                      return (
                        <HeroTable.Cell
                          aria-label={cellProps['aria-label']}
                          className={cellProps.className}
                          colSpan={cellProps.colSpan}
                          key={`${rowId}-cell-${cellIndex}`}
                          textValue={value || cellProps['aria-label']}
                        >
                          {cellProps.children}
                        </HeroTable.Cell>
                      )
                    })}
                  </HeroTable.Row>
                )
              })}
            </HeroTable.Body>
          </HeroTable.Content>
        </HeroTable.ScrollContainer>
      </HeroTable>
    </div>
  )
}
