import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createCompiledHookRunner, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/components/ui/HoldButton.tsx', import.meta.url), 'utf8')

function eventTarget() {
  const listeners = new Map()
  return {
    addEventListener(name, callback) { listeners.set(name, callback) },
    removeEventListener(name) { listeners.delete(name) },
    emit(name, event) { listeners.get(name)?.(event) },
    listeners,
  }
}

function harness(onHold) {
  let now = 0, nextFrame = 0, calls = 0
  const frames = new Map(), styles = new Map()
  const window = eventTarget(), document = { ...eventTarget(), hidden: false }
  const element = {
    style: { setProperty: (name, value) => styles.set(name, value) },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 110, bottom: 44 }),
    setPointerCapture() {},
  }
  const props = { children: 'Anular', disabled: false, onHold: () => { calls++; return onHold?.() } }
  const runner = createCompiledHookRunner(source, 'HoldButton', {
    'react/jsx-runtime': jsxRuntime,
    '@heroui/react': { Popover: { Content: 'popover', Arrow: 'arrow', Dialog: 'dialog' } },
    './Button': { Button: 'button' },
  }, {
    window, document, performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id),
  })
  function render() {
    const tree = runner.render(props)
    const button = nodes(tree).find(node => node.type === 'button')
    button.props.ref.current = element
    return button.props
  }
  const hint = () => nodes(runner.render(props)).find(node => node.type === 'popover').props
  const pointer = (extra = {}) => ({ button: 0, isPrimary: true, pointerId: 1, currentTarget: element, ...extra })
  const key = (value, extra = {}) => ({ key: value, repeat: false, preventDefault() {}, ...extra })
  function advance(ms) {
    now += ms
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(now))
  }
  render()
  return { render, hint, props, pointer, key, advance, window, document, frames, styles, runner, calls: () => calls }
}

test('clicks and releases before 1000ms never annul; each hold starts from zero', async () => {
  const h = harness()
  h.render().onClick({ preventDefault() {} })
  h.render().onPointerDown(h.pointer())
  h.advance(999)
  assert.equal(h.calls(), 0)
  assert.ok(Number(h.styles.get('--hold-progress')) > 0.99)
  h.render().onPointerUp(h.pointer())
  h.advance(2000)
  assert.equal(h.calls(), 0)
  assert.equal(h.styles.get('--hold-progress'), '0')
  h.render().onPointerDown(h.pointer())
  h.advance(999)
  assert.equal(h.calls(), 0)
  h.advance(1)
  assert.equal(h.calls(), 1)
  await Promise.resolve()
  h.advance(5000)
  assert.equal(h.calls(), 1)
})

test('a short click shows an anchored note and starting another hold dismisses it', () => {
  const h = harness()
  assert.equal(h.hint().isOpen, false)
  h.render().onPointerDown(h.pointer())
  h.advance(100)
  h.render().onPointerUp(h.pointer())
  h.render().onClick({ preventDefault() {} })
  assert.equal(h.calls(), 0)
  assert.equal(h.hint().isOpen, true)
  assert.equal(h.hint().triggerRef.current, h.render().ref.current)
  assert.match(nodes(h.hint().children).find(node => node.type === 'dialog').props.children, /mantén pulsado durante 1 segundo/)
  h.hint().onOpenChange(false)
  assert.equal(h.hint().isOpen, false)
  h.render().onClick({ preventDefault() {} })
  h.render().onPointerDown(h.pointer())
  assert.equal(h.hint().isOpen, false)
})

test('the click after a completed hold does not show the short-press note', async () => {
  const h = harness()
  h.render().onPointerDown(h.pointer())
  h.advance(1000)
  await new Promise(setImmediate)
  h.render().onPointerUp(h.pointer())
  h.render().onClick({ preventDefault() {} })
  assert.equal(h.calls(), 1)
  assert.equal(h.hint().isOpen, false)
})

for (const key of ['Enter', ' ']) {
  test(`short keyboard ${JSON.stringify(key)} shows the note without annulling`, () => {
    const h = harness()
    h.render().onKeyDown(h.key(key))
    h.advance(100)
    h.render().onKeyUp(h.key(key))
    assert.equal(h.calls(), 0)
    assert.equal(h.hint().isOpen, true)
    h.render().onKeyDown(h.key('Escape'))
    assert.equal(h.hint().isOpen, false)
  })
}

for (const cancel of ['onPointerCancel', 'onLostPointerCapture', 'onPointerLeave', 'onBlur', 'move', 'window blur', 'hidden', 'disabled', 'unmount']) {
  test(`interrupted holds cancel safely: ${cancel}`, () => {
    const h = harness()
    h.render().onPointerDown(h.pointer())
    h.advance(700)
    if (cancel === 'move') h.render().onPointerMove(h.pointer({ clientX: 111, clientY: 20 }))
    else if (cancel === 'window blur') h.window.emit('blur')
    else if (cancel === 'hidden') { h.document.hidden = true; h.document.emit('visibilitychange') }
    else if (cancel === 'disabled') { h.props.disabled = true; h.render() }
    else if (cancel === 'unmount') h.runner.unmount()
    else h.render()[cancel](h.pointer())
    h.advance(2000)
    assert.equal(h.calls(), 0)
    assert.equal(h.frames.size, 0)
    if (cancel === 'unmount') assert.equal(h.window.listeners.size, 0)
  })
}

for (const key of ['Enter', ' ']) {
  test(`keyboard ${JSON.stringify(key)} needs a continuous hold and ignores autorepeat`, () => {
    const h = harness()
    h.render().onKeyDown(h.key(key))
    h.advance(900)
    h.render().onKeyDown(h.key(key, { repeat: true }))
    h.render().onKeyUp(h.key(key === ' ' ? 'Enter' : ' '))
    h.advance(100)
    assert.equal(h.calls(), 1)
    h.render().onKeyDown(h.key(key, { repeat: true }))
    h.advance(1000)
    assert.equal(h.calls(), 1)
  })
}

test('release during an asynchronous action allows a fresh hold after it completes', async () => {
  let release
  const h = harness(() => new Promise(resolve => { release = resolve }))
  h.render().onKeyDown(h.key('Enter'))
  h.advance(1000)
  assert.equal(h.render().disabled, true)
  h.window.emit('keyup', h.key('Enter'))
  h.render().onPointerDown(h.pointer())
  h.advance(2000)
  assert.equal(h.calls(), 1)
  release()
  await new Promise(setImmediate)
  assert.equal(h.render().disabled, false)
  h.render().onPointerDown(h.pointer())
  h.advance(1000)
  assert.equal(h.calls(), 2)
  release()
  await new Promise(setImmediate)
})

test('disabled buttons, secondary pointers and right clicks never begin a hold', () => {
  const h = harness()
  h.render().onPointerDown(h.pointer({ isPrimary: false }))
  h.render().onPointerDown(h.pointer({ button: 2 }))
  h.props.disabled = true
  h.render().onPointerDown(h.pointer())
  h.render().onKeyDown(h.key('Enter'))
  h.render().onClick({ preventDefault() {} })
  h.advance(2000)
  assert.equal(h.calls(), 0)
  assert.equal(h.hint().isOpen, false)
})
