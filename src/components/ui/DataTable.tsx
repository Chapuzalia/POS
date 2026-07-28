import { Table as HeroTable } from '@heroui/react'
import {
  Children,
  Fragment,
  isValidElement,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'

export type DataTableProps = ComponentProps<'table'>

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

export function DataTable({ 'aria-label': ariaLabel, children, className }: DataTableProps) {
  const sections = Children.toArray(children).filter(isValidElement)
  const head = sections.find((section) => section.type === 'thead')
  const body = sections.find((section) => section.type === 'tbody')
  const headerRow = head ? elementsOfType((head.props as { children?: ReactNode }).children, 'tr')[0] : undefined
  const columns = headerRow ? elementsOfType((headerRow.props as { children?: ReactNode }).children, 'th') : []
  const rows = body ? elementsOfType((body.props as { children?: ReactNode }).children, 'tr') : []

  return (
    <HeroTable variant="secondary">
      <HeroTable.ScrollContainer>
        <HeroTable.Content aria-label={ariaLabel ?? 'Tabla de datos'} className={className}>
          <HeroTable.Header>
            {columns.map((column, columnIndex) => {
              const props = column.props as ComponentProps<'th'>
              return (
                <HeroTable.Column className={props.className} id={`column-${columnIndex}`} key={`column-${columnIndex}`}>
                  {props.children}
                </HeroTable.Column>
              )
            })}
          </HeroTable.Header>
          <HeroTable.Body>
            {rows.map((row, rowIndex) => {
              const rowProps = row.props as ComponentProps<'tr'>
              const cells = elementsOfType(rowProps.children, 'td')
              const rowId = String(row.key ?? `row-${rowIndex}`)

              return (
                <HeroTable.Row
                  aria-label={rowProps['aria-label']}
                  className={rowProps.className}
                  id={rowId}
                  key={rowId}
                  onAction={rowProps.onClick || rowProps.onKeyDown
                    ? () => rowProps.onClick?.({} as MouseEvent<HTMLTableRowElement>)
                    : undefined}
                >
                  {cells.map((cell, cellIndex) => {
                    const cellProps = cell.props as ComponentProps<'td'>
                    return (
                      <HeroTable.Cell className={cellProps.className} key={`${rowId}-cell-${cellIndex}`}>
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
  )
}
