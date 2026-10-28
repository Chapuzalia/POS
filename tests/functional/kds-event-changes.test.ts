import { expect, it } from 'vitest'
import { getKdsEventChanges } from '../../src/features/production/kds-event-changes'
import type { KdsEvent } from '../../src/features/production/types'

const event = (payload: KdsEvent['payload']): KdsEvent => ({ id: 'event', event_type: 'modified', quantity: 1, payload, created_at: '' })
const cheese = { id: 'cheese', name: 'Queso' }
const bacon = { id: 'bacon', name: 'Bacon' }

it('shows only modifier additions/removals and suppresses an unchanged empty comment', () => {
  expect(getKdsEventChanges(event({ previousState: { lineModifiers: [cheese], note: null }, lineModifiers: [cheese, bacon], note: null }))).toEqual(['Añadido: Bacon'])
  expect(getKdsEventChanges(event({ previousState: { lineModifiers: [cheese, bacon], note: 'Sin sal' }, lineModifiers: [bacon], note: 'Sin sal' }))).toEqual(['Quitado: Queso'])
})

it('compares against the immediately preceding state instead of the original sending snapshot', () => {
  expect(getKdsEventChanges(event({ previousSnapshot: { lineModifiers: [] }, previousState: { lineModifiers: [cheese] }, lineModifiers: [] }))).toEqual(['Quitado: Queso'])
})

it('handles component modifiers and variants without repeating unchanged selections', () => {
  expect(getKdsEventChanges(event({ previousState: { lineModifiers: [bacon], componentModifiers: [], variantName: 'Normal' }, lineModifiers: [bacon], componentModifiers: [cheese], variantName: 'Doble' })))
    .toEqual(['Añadido: Queso', 'Variante: Normal → Doble'])
})

it('shows note changes only when the note changes, including deletion', () => {
  expect(getKdsEventChanges(event({ previousState: { note: 'Sin sal' }, note: null }))).toEqual(['Comentario eliminado'])
  expect(getKdsEventChanges(event({ previousState: { note: null }, note: 'Salsa aparte' }))).toEqual(['Comentario: Salsa aparte'])
  expect(getKdsEventChanges(event({ previousState: { note: null }, note: '' }))).toEqual(['Pedido modificado'])
})

it('supports legacy event snapshots, partial payloads and reordered modifier arrays', () => {
  expect(getKdsEventChanges(event({ previousSnapshot: { lineModifiers: [] }, lineModifiers: [cheese], note: null }))).toEqual(['Añadido: Queso'])
  expect(getKdsEventChanges(event({ previousState: { lineModifiers: [cheese, bacon], componentModifiers: [cheese] }, lineModifiers: [bacon, cheese] }))).toEqual(['Pedido modificado'])
  expect(getKdsEventChanges(event({ previousState: 'bad', lineModifiers: [null, 4, {}], note: null }))).toEqual(['Pedido modificado'])
  expect(getKdsEventChanges(event({ previousSnapshot: { lineModifiers: [] }, lineModifiers: [cheese], components: [{ id: 'cola', productName: 'Cola' }] }))).toEqual(['Añadido: Queso'])
})
