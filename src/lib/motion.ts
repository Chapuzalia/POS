// Motion tokens and helpers for the dashboard shell. Web Animations API only: no animation library.
export const ease = {
  power3: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  power4: 'cubic-bezier(0.165, 0.84, 0.44, 1)',
  power2In: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  back14: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  back24: 'cubic-bezier(0.3, 1.9, 0.5, 1)',
} as const

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type PlayOptions = { duration: number; delay?: number; stagger?: number; max?: number; easing?: string }
type Frames = Keyframe[] | ((index: number) => Keyframe[])

export function play(targets: Element | Iterable<Element>, frames: Frames, { duration, delay = 0, stagger = 0, max = 12, easing = ease.power3 }: PlayOptions) {
  if (prefersReducedMotion()) return []
  const list = targets instanceof Element ? [targets] : [...targets]
  return list.map((element, index) => {
    const animation = element.animate(typeof frames === 'function' ? frames(index) : frames, {
      duration,
      delay: delay + Math.min(index, max) * stagger,
      easing,
      fill: 'backwards',
    })
    animation.id = 'dashboard-enter'
    return animation
  })
}

export type CountFormat = { prefix: string; suffix: string; decimals: number; decimalMark: ',' | '.'; grouped: boolean; value: number }

// Spanish display numbers: "," is the decimal mark and "." groups thousands, unless a "." is not followed by exactly 3 digits.
export function parseCount(text: string): CountFormat | null {
  const match = /^(\D*?)(-?\d[\d.,]*?)(\D*)$/.exec(text)
  if (!match) return null
  const [, prefix, number, suffix] = match
  let integer = number
  let fraction = ''
  let grouped = false
  let decimalMark: ',' | '.' = ','
  if (number.includes(',')) {
    const comma = number.lastIndexOf(',')
    integer = number.slice(0, comma)
    fraction = number.slice(comma + 1)
    grouped = integer.includes('.')
    if (grouped && !/^-?\d{1,3}(\.\d{3})+$/.test(integer)) return null
    integer = integer.replaceAll('.', '')
  } else if (number.includes('.')) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(number)) {
      grouped = true
      integer = number.replaceAll('.', '')
    } else {
      const parts = number.split('.')
      if (parts.length !== 2) return null
      ;[integer, fraction] = parts
      decimalMark = '.'
    }
  }
  if (!/^-?\d+$/.test(integer) || !/^\d*$/.test(fraction)) return null
  const value = Number(fraction ? `${integer}.${fraction}` : integer)
  return Number.isFinite(value) ? { prefix, suffix, decimals: fraction.length, decimalMark, grouped, value } : null
}

export function formatCount(value: number, format: CountFormat) {
  const [integer, fraction] = Math.abs(value).toFixed(format.decimals).split('.')
  const digits = format.grouped ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : integer
  const sign = value < 0 && Number(Math.abs(value).toFixed(format.decimals)) !== 0 ? '-' : ''
  return `${format.prefix}${sign}${digits}${fraction ? `${format.decimalMark}${fraction}` : ''}${format.suffix}`
}
