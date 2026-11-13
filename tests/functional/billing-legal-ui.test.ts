import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { compileComponent, jsxRuntime, nodes } from '../helpers/component-harness.mjs'
import * as legal from '../../supabase/functions/_shared/billing/legal'
import { grossCents } from '../../supabase/functions/_shared/billing/mollie'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptySepaForm } from '../../src/features/billing/sepa'
import * as sepaContract from '../../supabase/functions/_shared/billing/sepa'

it('uses two separate legal checkboxes and includes professional representation in the terms acceptance', () => {
  const { BillingLegalAcceptance } = compileComponent(readFileSync(new URL('../../src/features/billing/BillingLegalAcceptance.tsx', import.meta.url), 'utf8'), {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Checkbox': { Checkbox: 'checkbox' },
    '../../../supabase/functions/_shared/billing/legal': legal,
    '../../../supabase/functions/_shared/billing/mollie': { grossCents },
    './service': { billingMoney: String },
  })
  const onChange = vi.fn()
  const render = (value = legal.emptyLegalAcceptance) => BillingLegalAcceptance({ value, disabled: false, onChange })
  const checkboxes = nodes(render()).filter(node => node.type === 'checkbox')
  expect(checkboxes).toHaveLength(2)
  expect(checkboxes.map(node => node.props.checked)).toEqual([false, false])
  checkboxes[0].props.onChange(true)
  const termsAccepted = onChange.mock.calls.at(-1)[0]
  expect(termsAccepted).toMatchObject({ terms: true, businessRepresentative: true, dpa: false })
  expect(legal.legalAcceptanceReady(termsAccepted)).toBe(false)
  nodes(render(termsAccepted)).filter(node => node.type === 'checkbox')[1].props.onChange(true)
  expect(legal.legalAcceptanceReady(onChange.mock.calls.at(-1)[0])).toBe(true)
  nodes(render(termsAccepted)).filter(node => node.type === 'checkbox')[0].props.onChange(false)
  expect(onChange.mock.calls.at(-1)[0]).toMatchObject({ terms: false, businessRepresentative: false })
  expect(nodes(render()).find(node => node.type === 'details').props.open).toBeUndefined()
})

it('shows privacy information before collecting payer or mandate data without duplicating it or adding consent fields', () => {
  const { BillingPrivacyNotice } = compileComponent(readFileSync(new URL('../../src/features/billing/BillingPrivacyNotice.tsx', import.meta.url), 'utf8'), {
    'react/jsx-runtime': jsxRuntime,
    '../../../supabase/functions/_shared/billing/legal': legal,
  })
  const { BillingProfileFields } = compileComponent(readFileSync(new URL('../../src/features/billing/BillingProfileFields.tsx', import.meta.url), 'utf8'), {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Input': { Input: 'input' },
    './BillingPrivacyNotice': { BillingPrivacyNotice },
  })
  const { SepaMandateFields } = compileComponent(readFileSync(new URL('../../src/features/billing/SepaMandateFields.tsx', import.meta.url), 'utf8'), {
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/Input': { Input: 'input' },
    '../../components/ui/Checkbox': { Checkbox: ({ checked, disabled }: { checked: boolean; disabled: boolean }) => jsxRuntime.jsx('input', { type: 'checkbox', checked, disabled, readOnly: true }) },
    './BillingProfileFields': { BillingProfileFields },
    './BillingPrivacyNotice': { BillingPrivacyNotice },
    '../../../supabase/functions/_shared/billing/sepa': sepaContract,
  })
  for (const withPayer of [true, false]) {
    const html = renderToStaticMarkup(SepaMandateFields({ value: emptySepaForm, disabled: false, onChange: vi.fn(), withPayer }))
    expect(html.split(`href="${legal.billingLegalDocuments.privacy.url}"`)).toHaveLength(2)
    expect(html.indexOf('<aside')).toBeLessThan(html.indexOf('<input'))
    expect(html.match(/type="checkbox"/g)).toHaveLength(1)
    expect(html).toContain('<details')
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[\s=>])/)
  }
  expect(renderToStaticMarkup(BillingPrivacyNotice())).not.toContain('<input')
})
