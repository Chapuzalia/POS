import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/features/tables/hooks/useOrderLineLongPress.ts', import.meta.url), 'utf8')
afterEach(() => vi.useRealTimers())

function setup(disabled = false) {
  vi.useFakeTimers()
  const onOpen = vi.fn()
  const runner = createCompiledHookRunner(source, 'useOrderLineLongPress', {}, {
    Element: class {},
    window: { setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay), clearTimeout: (timer: number) => clearTimeout(timer) },
  })
  return { onOpen, runner, handlers: runner.render(disabled, onOpen) }
}
const pointer = { button: 0, isPrimary: true, clientX: 125, clientY: 260, target: null }

it('opens at the held point after 600 ms and suppresses the following click', () => {
  const { handlers, onOpen } = setup()
  handlers.onPointerDown(pointer)
  vi.advanceTimersByTime(599)
  expect(onOpen).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(onOpen).toHaveBeenCalledWith({ x: 125, y: 260 })
  expect(handlers.onPointerUp()).toBe(true)
  const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
  handlers.onClickCapture(click)
  expect(click.preventDefault).toHaveBeenCalledOnce()
  handlers.onClickCapture(click)
  expect(click.preventDefault).toHaveBeenCalledOnce()
})

it('keeps scrolling, short taps and disabled lines from opening a menu', () => {
  const { handlers, onOpen } = setup()
  handlers.onPointerDown(pointer)
  handlers.onPointerMove({ ...pointer, clientY: 270 })
  vi.advanceTimersByTime(700)
  handlers.onPointerDown(pointer)
  handlers.onPointerUp()
  vi.advanceTimersByTime(700)
  expect(onOpen).not.toHaveBeenCalled()
  const disabled = setup(true)
  disabled.handlers.onPointerDown(pointer)
  vi.advanceTimersByTime(700)
  expect(disabled.onOpen).not.toHaveBeenCalled()
})

it('supports right click and keyboard context menus at the line', () => {
  const { handlers, onOpen } = setup()
  const event = { ...pointer, preventDefault: vi.fn() }
  handlers.onContextMenu(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(onOpen).toHaveBeenLastCalledWith({ x: 125, y: 260 })
  const target = { getBoundingClientRect: () => ({ left: 50, top: 80, width: 240, height: 90 }) }
  handlers.onKeyDown({ key: 'F10', shiftKey: true, target, currentTarget: target, preventDefault: vi.fn() })
  expect(onOpen).toHaveBeenLastCalledWith({ x: 82, y: 128 })
})
