import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Checkbox } from '../../src/components/ui/Checkbox'

it('labels the native checkbox without nested labels that suppress pointer activation', () => {
  const html = renderToStaticMarkup(createElement(Checkbox, { checked: false, onChange: vi.fn() }, 'Complemento'))
  expect(html.match(/<label\b/g)).toHaveLength(1)
  expect(html).toMatch(/<input[^>]*type="checkbox"/)
  expect(html).toContain('Complemento')
})

it('preserves checked and disabled semantics', () => {
  const html = renderToStaticMarkup(createElement(Checkbox, { checked: true, disabled: true, onChange: vi.fn() }, 'Complemento'))
  expect(html).toMatch(/<input[^>]*disabled=""/)
  expect(html).toMatch(/<input[^>]*checked=""/)
})
