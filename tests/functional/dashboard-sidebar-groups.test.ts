import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/components/layout/DashboardShell.tsx', import.meta.url), 'utf8')
const component = () => null
// Any browser API the shell's effects touch becomes a harmless no-op.
const stub: object = new Proxy(function noop() {}, { get: (_target, key) => key === Symbol.toPrimitive ? () => '' : stub, apply: () => stub, construct: () => stub })

function harness({ collapsed = false, mobile = false } = {}) {
  const onNavigate = vi.fn()
  const runner = createCompiledHookRunner(source, 'DashboardShell', {
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': new Proxy({}, { get: () => component }),
    '../../config/appVersion': { APP_DISPLAY_VERSION: 'test' },
    '../../hooks/useMediaQuery': { useMediaQuery: () => mobile },
    '../../lib/motion': { ease: {}, play: vi.fn(), prefersReducedMotion: () => true },
    '../ui/AppModal': { AppModal: component },
    './useDashboardMotion': { useContentEntrance: vi.fn(), useShellIntro: vi.fn() },
  }, {
    window: new Proxy({ localStorage: { getItem: () => (collapsed ? 'collapsed' : null), setItem() {} } }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : stub) }),
    document: stub, requestAnimationFrame: (callback: () => void) => callback(), CSS: { escape: String }, performance: { now: () => 0 },
  })
  const groups = [{ label: 'Ventas', items: [
    { id: 'dashboard', label: 'Inicio', icon: component },
    { id: 'sales', label: 'Ventas', icon: component, items: [{ id: 'reports', label: 'Tickets', icon: component }, { id: 'x-reports', label: 'Informes Z', icon: component }] },
  ] }]
  const props = { account: { name: 'Ana', menu: null }, activeId: 'dashboard', brand: null, children: null, groups, onNavigate, title: 'Inicio' }
  const toggle = () => nodes(runner.render(props)).find(node => node.props?.['aria-controls'] && node.props?.['aria-expanded'] !== undefined && node.props?.['data-tip'] === 'Ventas')
  return { onNavigate, toggle }
}

it.each([{ mobile: true }, { mobile: false }])('only expands and collapses a sidebar group without opening its first page: %o', ({ mobile }) => {
  const h = harness({ mobile })
  expect(h.toggle().props['aria-expanded']).toBe(false)
  h.toggle().props.onClick()
  expect(h.toggle().props['aria-expanded']).toBe(true)
  h.toggle().props.onClick()
  expect(h.toggle().props['aria-expanded']).toBe(false)
  expect(h.onNavigate).not.toHaveBeenCalled()
})

it('still enters the group from the collapsed desktop rail, where its pages are hidden', () => {
  const h = harness({ collapsed: true })
  h.toggle().props.onClick()
  expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith('reports')
})
