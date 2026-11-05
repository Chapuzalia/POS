import { useLayoutEffect, type RefObject } from 'react'
import { ease, formatCount, parseCount, play, prefersReducedMotion } from '../../lib/motion'

let introPlayed = false

// Shell intro: runs once per page load, not on every shell mount.
export function useShellIntro(rootRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || introPlayed) return
    introPlayed = true
    const sidebar = root.querySelector('[data-shell="sidebar"]')
    if (sidebar && window.matchMedia('(min-width: 1101px)').matches) {
      play(sidebar, [{ transform: 'translateX(-40px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600 })
    }
    play(root.querySelectorAll('[data-shell="sidebar"] [data-shell-intro]'), [{ transform: 'translateX(-14px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 450, delay: 150, stagger: 25, max: 30 })
    play(root.querySelectorAll('[data-shell="topbar"] > *'), [{ transform: 'translateY(-16px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 500, delay: 200, stagger: 40 })
  }, [rootRef])
}

const cardSelector = 'section, article, [data-motion="card"]'
const kinds = [
  { selector: '[data-motion="stat"]', frames: (index: number) => [{ transform: `translateY(36px) rotate(${index % 2 ? -2.5 : 2.5}deg) scale(.95)`, opacity: 0 }, { transform: 'none', opacity: 1 }], options: { duration: 800, stagger: 60, easing: ease.back14 } },
  { selector: 'tbody > tr, [data-motion="row"]', frames: () => [{ transform: 'translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], options: { duration: 500, stagger: 35, max: 14 } },
  { selector: '[data-motion="badge"]', frames: () => [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], options: { duration: 600, delay: 300, stagger: 40, easing: ease.back24 } },
]

type CountState = { node: Text; written: string; target: string; frame: number }

/**
 * Content entrance and count-up for everything rendered inside `main`.
 * A MutationObserver runs in the microtask before paint, so content that arrives after loading also animates without flashing.
 */
export function useContentEntrance(mainRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const main = mainRef.current
    if (!main || prefersReducedMotion()) return undefined
    const seen = new WeakSet<Element>()
    const counters = new Map<Element, CountState>()
    const isNew = (element: Element) => !seen.has(element) && !element.closest('[role="dialog"], .modal') && seen.add(element)

    const cards = () => [...main.querySelectorAll(cardSelector)].filter((element) => {
      const parentCard = element.parentElement?.closest(cardSelector)
      // A transformed card would re-anchor fixed action bars inside it while it animates.
      return !(parentCard && main.contains(parentCard)) && !element.querySelector('.fixed')
    })

    const count = (state: CountState, from: number, duration: number, delay: number) => {
      const format = parseCount(state.target)
      if (!format) return
      cancelAnimationFrame(state.frame)
      const start = performance.now() + delay
      const tick = (now: number) => {
        if (!state.node.isConnected) return
        if (state.node.data !== state.written) {
          // React wrote a new value mid-count: restart from what was on screen.
          const onScreen = parseCount(state.written)?.value ?? 0
          state.target = state.node.data
          state.written = state.node.data
          count(state, onScreen, 800, 0)
          return
        }
        const progress = Math.min(1, Math.max(0, (now - start) / duration))
        const text = progress >= 1 ? state.target : formatCount(from + (format.value - from) * (1 - (1 - progress) ** 3), format)
        state.node.data = text
        state.written = text
        if (progress < 1) state.frame = requestAnimationFrame(tick)
        else state.frame = 0
      }
      state.frame = requestAnimationFrame(tick)
    }

    const scanCounters = () => {
      for (const element of main.querySelectorAll('[data-count]')) {
        const node = element.childNodes.length === 1 && element.firstChild instanceof Text ? element.firstChild : null
        if (!node) continue
        const state = counters.get(element)
        if (!state) {
          const nextState = { node, written: node.data, target: node.data, frame: 0 }
          counters.set(element, nextState)
          count(nextState, 0, 1300, 150)
        } else if (state.frame === 0 && (node !== state.node || node.data !== state.target)) {
          const from = parseCount(state.target)?.value ?? 0
          state.node = node
          state.target = node.data
          state.written = node.data
          count(state, from, 800, 0)
          element.classList.remove('is-flash')
          void (element as HTMLElement).offsetWidth
          element.classList.add('is-flash')
          play(element, [{ transform: 'translateY(-4px) scale(1.06)' }, { transform: 'none' }], { duration: 550, easing: ease.back24 })
        }
      }
    }

    const enter = () => {
      play(cards().filter(isNew), [{ transform: 'translateY(30px) scale(.985)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 850, stagger: 60, max: 8 })
      for (const kind of kinds) play([...main.querySelectorAll(kind.selector)].filter(isNew), kind.frames, kind.options)
      scanCounters()
    }

    enter()
    const observer = new MutationObserver((records) => {
      const ownWrites = records.every((record) => record.type === 'characterData' && [...counters.values()].some((state) => state.node === record.target && state.node.data === state.written))
      if (!ownWrites) enter()
    })
    observer.observe(main, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      for (const state of counters.values()) {
        cancelAnimationFrame(state.frame)
        if (state.node.isConnected) state.node.data = state.target
      }
    }
  }, [mainRef])
}
