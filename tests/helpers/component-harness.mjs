import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as React from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import ts from 'typescript'

export const jsxRuntime = { Fragment, jsx, jsxs }

export function compileComponent(source, modules, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText

  vm.runInNewContext(code, {
    exports,
    require(name) {
      assert.ok(name in modules, `Missing dependency: ${name}`)
      return modules[name]
    },
    ...globals,
  })

  return exports
}

export function createHookHarness() {
  const states = []
  const refs = []
  let stateCursor = 0
  let refCursor = 0

  const react = {
    ...React,
    useCallback: (callback) => callback,
    useDeferredValue: (value) => value,
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: (factory) => factory(),
    useRef(initialValue) {
      const index = refCursor++
      if (!(index in refs)) refs[index] = { current: initialValue }
      return refs[index]
    },
    useState(initialValue) {
      const index = stateCursor++
      if (!(index in states)) {
        states[index] = typeof initialValue === 'function' ? initialValue() : initialValue
      }
      return [states[index], (nextValue) => {
        states[index] = typeof nextValue === 'function' ? nextValue(states[index]) : nextValue
      }]
    },
  }

  return {
    react,
    render(component, props) {
      stateCursor = 0
      refCursor = 0
      return component(props)
    },
  }
}

export function createCompiledHookRunner(source, exportName, modules = {}, globals = {}) {
  const slots = []
  let cursor = 0
  let effects = []
  const dependenciesChanged = (slot, dependencies) => (
    !slot
    || !dependencies
    || !slot.dependencies
    || dependencies.length !== slot.dependencies.length
    || dependencies.some((dependency, index) => !Object.is(dependency, slot.dependencies[index]))
  )
  const react = {
    ...React,
    useCallback(callback, dependencies) {
      const index = cursor++
      if (dependenciesChanged(slots[index], dependencies)) slots[index] = { callback, dependencies }
      return slots[index].callback
    },
    useDeferredValue: (value) => value,
    useEffect(callback, dependencies) {
      const index = cursor++
      if (dependenciesChanged(slots[index], dependencies)) {
        effects.push(() => {
          slots[index]?.cleanup?.()
          slots[index] = { dependencies, cleanup: callback() }
        })
      }
    },
    useLayoutEffect(callback, dependencies) {
      return react.useEffect(callback, dependencies)
    },
    useMemo(factory, dependencies) {
      const index = cursor++
      if (dependenciesChanged(slots[index], dependencies)) slots[index] = { dependencies, value: factory() }
      return slots[index].value
    },
    useRef(initialValue) {
      const index = cursor++
      return slots[index] ??= { current: initialValue }
    },
    useState(initialValue) {
      const index = cursor++
      slots[index] ??= { value: typeof initialValue === 'function' ? initialValue() : initialValue }
      return [slots[index].value, (nextValue) => {
        slots[index].value = typeof nextValue === 'function' ? nextValue(slots[index].value) : nextValue
      }]
    },
  }
  const exports = compileComponent(source, { ...modules, react }, globals)

  return {
    exports,
    render(...args) {
      cursor = 0
      effects = []
      const result = exports[exportName](...args)
      effects.forEach((effect) => effect())
      return result
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.())
    },
  }
}

export function nodes(tree) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}

export function expandedNodes(tree) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(expandedNodes)
  if (typeof tree.type === 'function') return [tree, ...expandedNodes(tree.type(tree.props))]
  return [tree, ...expandedNodes(tree.props?.children)]
}
