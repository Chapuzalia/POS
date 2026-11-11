import { readFileSync } from 'node:fs'
import { jsx } from 'react/jsx-runtime'
import { describe, expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/components/ui/DataTable.tsx', import.meta.url), 'utf8')
const component = () => null
const heroTable = Object.assign(component, { ScrollContainer: component, Content: component, Header: component, Column: component, SortableColumnHeader: component, Body: component, Row: component, Cell: component })

function renderTable(isPhonePortrait: boolean, props: Record<string, unknown> = {}) {
  const runner = createCompiledHookRunner(source, 'DataTable', {
    'react/jsx-runtime': jsxRuntime,
    '@heroui/react': { Table: heroTable },
    'lucide-react': new Proxy({}, { get: () => component }),
    '../../hooks/useMediaQuery': { useMediaQuery: () => isPhonePortrait },
    './Button': { Button: component },
    './Input': { Input: component },
  })
  const edit = vi.fn()
  const open = vi.fn()
  const children = [
    jsx('thead', { children: jsx('tr', { children: [jsx('th', { children: 'Producto' }), jsx('th', { children: 'Precio' }), jsx('th', { children: 'Acciones' })] }) }, 'head'),
    jsx('tbody', { children: [
      jsx('tr', { children: [jsx('td', { children: 'Gin tonic' }), jsx('td', { children: '9,50 €' }), jsx('td', { children: jsx('button', { onClick: edit, children: 'Editar' }) })] }, 'gin'),
      jsx('tr', { onClick: open, children: [jsx('td', { children: 'Cerveza' }), jsx('td', { children: '3,00 €' }), jsx('td', { children: '' })] }, 'beer'),
    ] }, 'body'),
  ]
  const tree = runner.render({ 'aria-label': 'Productos', children, filterable: false, ...props })
  return { tree, edit, open }
}

const textOf = (node: unknown): string => nodes(node).map((item: { props?: { children?: unknown } }) => typeof item.props?.children === 'string' ? item.props.children : '').join(' ')

describe('DataTable on a phone held upright', () => {
  it('renders each row as a card with labelled fields and its actions', () => {
    const { tree, edit } = renderTable(true)
    const cards = nodes(tree).filter((node: { type?: unknown }) => node.type === 'li')
    expect(cards).toHaveLength(2)
    expect(nodes(tree).some((node: { type?: unknown }) => node.type === 'table' || node.type === heroTable)).toBe(false)
    const labels = nodes(cards[0]).filter((node: { type?: unknown }) => node.type === 'dt').map((node: { props: { children: string } }) => node.props.children)
    expect(labels).toEqual(['Precio'])
    expect(textOf(cards[0])).toContain('Gin tonic')
    expect(textOf(cards[0])).toContain('9,50 €')
    nodes(cards[0]).find((node: { type?: unknown }) => node.type === 'button')?.props.onClick()
    expect(edit).toHaveBeenCalledOnce()
  })

  it('keeps row actions reachable by tapping or keyboard on the card', () => {
    const { tree, open } = renderTable(true)
    const card = nodes(tree).filter((node: { type?: unknown }) => node.type === 'li')[1]
    expect(card.props.role).toBe('button')
    card.props.onClick()
    card.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('shows the empty message and keeps the table layout elsewhere', () => {
    const empty = renderTable(true, { children: [jsx('thead', { children: jsx('tr', { children: jsx('th', { children: 'Producto' }) }) }, 'head'), jsx('tbody', {}, 'body')], emptyContent: 'Sin productos' })
    expect(textOf(empty.tree)).toContain('Sin productos')
    const { tree } = renderTable(false)
    expect(nodes(tree).some((node: { type?: unknown }) => node.type === 'li')).toBe(false)
    expect(nodes(tree).some((node: { type?: unknown }) => node.type === heroTable)).toBe(true)
  })
})
