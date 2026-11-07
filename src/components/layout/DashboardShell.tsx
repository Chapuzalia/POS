import { ChevronDown, Menu, PanelLeft, Search, UserRound, X, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { APP_DISPLAY_VERSION } from '../../config/appVersion'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { ease, play, prefersReducedMotion } from '../../lib/motion'
import { AppModal } from '../ui/AppModal'
import { useContentEntrance, useShellIntro } from './useDashboardMotion'

export type DashboardNavItem = { id: string; label: string; icon: LucideIcon; disabled?: boolean }
export type DashboardNavParent = { id: string; label: string; icon: LucideIcon; items: DashboardNavItem[] }
export type DashboardNavEntry = DashboardNavItem | DashboardNavParent
export type DashboardNavGroup = { label: string; items: DashboardNavEntry[] }

type Props = {
  account: { name: string; detail?: string; menu: ReactNode }
  activeId: string
  brand: ReactNode
  children: ReactNode
  eyebrow?: ReactNode
  goKeys?: Record<string, string>
  groups: DashboardNavGroup[]
  notices?: ReactNode
  onNavigate: (id: string) => void
  sideFooter?: ReactNode
  theme?: 'light' | 'dark'
  title: string
  tools?: ReactNode
  workspace?: ReactNode
}

const COLLAPSE_STORAGE_KEY = 'pos:dashboard-sidebar'
const MOBILE_QUERY = '(max-width: 1100px)'
const isParent = (entry: DashboardNavEntry): entry is DashboardNavParent => 'items' in entry
const focusRing = 'touch-manipulation outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--crm-blue)]'

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'collapsed' } catch { return false }
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

const hasOpenModal = () => Boolean(document.querySelector('.modal__dialog, [aria-modal="true"]:not([data-shell="sidebar"])'))

export function DashboardShell({ account, activeId, brand, children, eyebrow, goKeys = {}, groups, notices, onNavigate, sideFooter, theme, title, tools, workspace }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const sidebarId = useId()
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const [isOpen, setIsOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const rail = collapsed && !isMobile
  const parents = useMemo(() => groups.flatMap((group) => group.items.filter(isParent)), [groups])
  const [openParents, setOpenParents] = useState<ReadonlySet<string>>(() => new Set(parents.filter((parent) => parent.items.some((item) => item.id === activeId)).map((parent) => parent.id)))

  // Page transition: keep rendering the previous page while it fades up, then swap.
  const [shownId, setShownId] = useState(activeId)
  const shown = useRef({ children, title, eyebrow })
  if (shownId === activeId) shown.current = { children, title, eyebrow }

  useShellIntro(rootRef)

  // iOS tints the status bar from the page background (and theme-color on older versions): match the top bar.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const color = getComputedStyle(root).getPropertyValue('--crm-topbar-bg').trim()
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const previousMeta = meta?.content
    const targets = [document.documentElement, document.body]
    const previous = targets.map((element) => element.style.backgroundColor)
    targets.forEach((element) => { element.style.backgroundColor = color })
    if (meta) meta.content = color
    return () => {
      targets.forEach((element, index) => { element.style.backgroundColor = previous[index] })
      if (meta && previousMeta) meta.content = previousMeta
    }
  }, [theme])
  useContentEntrance(mainRef)

  useEffect(() => {
    const main = mainRef.current
    if (activeId === shownId) {
      // Navigated back to the shown page mid-exit: undo the fade.
      for (const animation of main?.getAnimations() ?? []) animation.cancel()
      return undefined
    }
    if (!main || prefersReducedMotion()) {
      setShownId(activeId)
      return undefined
    }
    const exit = main.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 180, easing: ease.power2In, fill: 'forwards' })
    exit.onfinish = () => setShownId(activeId)
    return () => { exit.onfinish = null }
  }, [activeId, shownId])

  useLayoutEffect(() => {
    for (const animation of mainRef.current?.getAnimations() ?? []) animation.cancel()
    scrollerRef.current?.scrollTo(0, 0)
  }, [shownId])

  // Reopen the accordion that owns the active section as soon as navigation starts.
  useEffect(() => {
    const parent = parents.find((entry) => entry.items.some((item) => item.id === activeId))
    if (parent) setOpenParents((current) => current.has(parent.id) ? current : new Set([...current, parent.id]))
  }, [activeId, parents])

  // Sliding active pill.
  const pillPlaced = useRef(false)
  useLayoutEffect(() => {
    const nav = navRef.current
    const pill = pillRef.current
    if (!nav || !pill) return undefined
    const place = () => {
      const target = nav.querySelector<HTMLElement>('[data-pill-target]')
      if (!target) {
        pill.style.opacity = '0'
        return
      }
      const top = target.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop
      if (!pillPlaced.current) {
        pill.style.transition = 'none'
        void pill.offsetHeight
      }
      pill.style.transform = `translateY(${top}px)`
      pill.style.height = `${target.offsetHeight}px`
      pill.style.opacity = '1'
      if (!pillPlaced.current) {
        void pill.offsetHeight
        pill.style.transition = ''
        pillPlaced.current = true
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(nav)
    // Accordions move items while their rows animate; re-place once they settle.
    nav.addEventListener('transitionend', place)
    return () => {
      observer.disconnect()
      nav.removeEventListener('transitionend', place)
    }
  }, [activeId, openParents, rail, groups])

  useEffect(() => {
    try { window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded') } catch { /* Preference only. */ }
  }, [collapsed])

  // Mobile sidebar: focus the first item, animate items, Escape closes and returns focus.
  useEffect(() => {
    if (!isOpen || !isMobile) return undefined
    const nav = navRef.current
    nav?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    if (nav) play(nav.querySelectorAll('[data-shell-intro]'), [{ transform: 'translateX(-8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 450, delay: 100, stagger: 15, max: 30 })
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsOpen(false)
      menuButtonRef.current?.focus()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isMobile, isOpen])

  // Keyboard shortcuts.
  const latest = useRef({ goKeys, onNavigate, isMobile })
  latest.current = { goKeys, onNavigate, isMobile }
  useEffect(() => {
    let goPending = 0
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIsPaletteOpen((open) => open || !hasOpenModal() ? !open : open)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || hasOpenModal()) return
      if (goPending && performance.now() - goPending < 900) {
        goPending = 0
        const id = latest.current.goKeys[event.key.toLowerCase()]
        if (id) {
          event.preventDefault()
          latest.current.onNavigate(id)
        }
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        setIsPaletteOpen(true)
      } else if (event.key === '[' && !latest.current.isMobile) {
        setCollapsed((value) => !value)
      } else if (event.key === 'g') {
        goPending = performance.now()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function navigate(id: string) {
    onNavigate(id)
    setIsOpen(false)
  }

  function toggleParent(parent: DashboardNavParent) {
    const isInside = parent.items.some((item) => item.id === activeId)
    const willOpen = !openParents.has(parent.id) || !isInside
    setOpenParents((current) => {
      const next = new Set(current)
      if (willOpen) next.add(parent.id)
      else next.delete(parent.id)
      return next
    })
    if (willOpen && !openParents.has(parent.id)) {
      requestAnimationFrame(() => play(document.querySelectorAll(`[data-sub="${CSS.escape(parent.id)}"] button`), [{ transform: 'translateX(-8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 400, delay: 60, stagger: 30 }))
    }
    if (!isInside) {
      const first = parent.items.find((item) => !item.disabled)
      if (first) navigate(first.id)
    }
  }

  const itemClass = (active: boolean) => `relative flex min-h-10 w-full min-w-0 items-center gap-3 rounded-xl border-0 bg-transparent text-left text-sm transition-[color,padding] duration-[180ms] disabled:cursor-not-allowed disabled:opacity-50 ${rail ? 'px-[17px]' : 'px-[14px]'} ${active ? 'font-semibold text-[var(--crm-sidebar-text)]' : 'font-medium text-[var(--crm-sidebar-muted)] hover:text-[var(--crm-sidebar-text)]'} ${focusRing} ${rail ? 'after:pointer-events-none after:absolute after:top-1/2 after:left-[calc(100%+14px)] after:z-50 after:-translate-x-1 after:-translate-y-1/2 after:rounded-lg after:bg-[var(--crm-surface)] after:px-2.5 after:py-1.5 after:text-xs after:font-semibold after:whitespace-nowrap after:text-[var(--crm-text)] after:opacity-0 after:shadow-[var(--crm-shadow-floating)] after:transition-[opacity,translate] after:duration-150 after:content-[attr(data-tip)] hover:after:translate-x-0 hover:after:opacity-100 focus-visible:after:translate-x-0 focus-visible:after:opacity-100' : ''}`
  const iconClass = (active: boolean) => `size-[18px] shrink-0 transition-colors duration-[180ms] ${active ? 'text-[#79b7ff]' : ''}`
  const labelClass = `min-w-0 flex-1 truncate transition-opacity duration-300 ${rail ? 'opacity-0' : ''}`
  const shellStyle = { '--side-w': rail ? 'var(--crm-sidebar-collapsed-width)' : 'var(--crm-sidebar-width)' } as CSSProperties

  return (
    <div ref={rootRef} className="crm-shell !flex !h-full !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased" data-crm-theme={theme} data-theme={theme} style={shellStyle}>
      <aside
        aria-label="Tu workspace"
        aria-modal={isMobile && isOpen ? true : undefined}
        className={`fixed inset-y-0 left-0 z-40 flex h-full w-[min(300px,86vw)] flex-col border-r border-[var(--crm-sidebar-border)] bg-[var(--crm-sidebar-bg)] text-[var(--crm-sidebar-text)] shadow-[var(--crm-shadow-floating)] [.pwa-standalone_&]:pt-[env(safe-area-inset-top,0px)] [transition:transform_350ms_var(--ease-power3),display_350ms_allow-discrete] desk:relative desk:w-[var(--side-w)] desk:min-w-[var(--side-w)] desk:translate-x-0 desk:shadow-none desk:[transition:width_450ms_var(--ease-power3),min-width_450ms_var(--ease-power3)] ${isOpen ? 'translate-x-0 max-desk:starting:-translate-x-[104%]' : 'max-desk:hidden -translate-x-[104%]'}`}
        data-motion-transition=""
        data-shell="sidebar"
        id={sidebarId}
        role={isMobile && isOpen ? 'dialog' : undefined}
      >
        <div className="flex min-h-[72px] shrink-0 items-center gap-2 border-b border-[var(--crm-sidebar-border)] px-4" data-shell-intro="">
          <div className={`min-w-0 flex-1 transition-opacity duration-300 ${rail ? 'pointer-events-none opacity-0' : ''}`}>{brand}</div>
          <button
            aria-label={collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
            className={`hidden size-11 shrink-0 place-items-center rounded-xl text-[var(--crm-sidebar-muted)] transition-colors duration-[180ms] hover:bg-[var(--crm-sidebar-hover)] hover:text-[var(--crm-sidebar-text)] desk:grid ${rail ? 'absolute left-4' : ''} ${focusRing}`}
            onClick={() => setCollapsed((value) => !value)}
            type="button"
          >
            <PanelLeft className={`size-[18px] transition-transform duration-[450ms] ease-[var(--ease-power3)] ${collapsed ? 'rotate-180' : ''}`} />
          </button>
          <button aria-label="Cerrar menú" className={`grid size-11 shrink-0 place-items-center rounded-xl bg-[var(--crm-sidebar-hover)] text-[var(--crm-sidebar-text)] desk:hidden ${focusRing}`} onClick={() => { setIsOpen(false); menuButtonRef.current?.focus() }} type="button">
            <X className="size-5" />
          </button>
        </div>

        {workspace ? <div className={`shrink-0 px-4 pt-4 transition-opacity duration-300 ${rail ? 'pointer-events-none opacity-0' : ''}`} data-shell-intro="">{workspace}</div> : null}

        <nav ref={navRef} aria-label="Navegación principal" className={`relative min-h-0 flex-1 px-3 pt-1 pb-4 [scrollbar-color:rgba(255,255,255,0.14)_transparent] [scrollbar-width:thin] ${rail ? 'overflow-visible' : 'overflow-x-hidden overflow-y-auto'}`}>
          <span ref={pillRef} aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-0 rounded-xl bg-[color-mix(in_srgb,var(--crm-sidebar-accent)_20%,transparent)] opacity-0 shadow-[inset_3px_0_0_var(--crm-sidebar-accent)] [transition:transform_500ms_var(--ease-back),height_300ms_var(--ease-power3),opacity_200ms]" data-motion-transition="" />
          {groups.map((group) => group.items.length ? (
            <div aria-label={group.label} className="grid gap-0.5" key={group.label} role="group">
              <p aria-hidden="true" className={`m-0 px-3 pt-3.5 pb-1.5 text-[11px] font-bold tracking-[0.08em] whitespace-nowrap text-[var(--crm-sidebar-muted)] uppercase transition-opacity duration-300 ${rail ? 'opacity-0' : ''}`} data-shell-intro="">{group.label}</p>
              {group.items.map((entry) => {
                const Icon = entry.icon
                if (!isParent(entry)) {
                  const active = entry.id === activeId
                  return (
                    <button aria-current={active ? 'page' : undefined} className={itemClass(active)} data-pill-target={active ? '' : undefined} data-shell-intro="" data-tip={entry.label} disabled={entry.disabled} key={entry.id} onClick={() => navigate(entry.id)} type="button">
                      <Icon aria-hidden="true" className={iconClass(active)} />
                      <span className={labelClass}>{entry.label}</span>
                    </button>
                  )
                }
                const inside = entry.items.some((item) => item.id === activeId)
                const open = openParents.has(entry.id) && !rail
                const subId = `${sidebarId}-${entry.id}`
                return (
                  <div className="grid" key={entry.id}>
                    <button aria-controls={subId} aria-expanded={open} className={itemClass(inside)} data-active={inside || undefined} data-pill-target={inside ? '' : undefined} data-shell-intro="" data-tip={entry.label} onClick={() => toggleParent(entry)} type="button">
                      <Icon aria-hidden="true" className={iconClass(inside)} />
                      <span className={labelClass}>{entry.label}</span>
                      <ChevronDown aria-hidden="true" className={`size-4 shrink-0 transition-transform duration-[350ms] ease-[var(--ease-power3)] ${open ? 'rotate-180' : ''} ${rail ? 'hidden' : ''}`} />
                    </button>
                    <div className={`grid transition-[grid-template-rows] duration-[380ms] ease-[var(--ease-power3)] ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'} ${rail ? 'hidden' : ''}`} data-motion-transition="" data-sub={entry.id} id={subId} inert={!open}>
                      <div className="min-h-0 overflow-hidden">
                        <div className="my-1 ml-[23px] grid gap-0.5 border-l border-[var(--crm-sidebar-border)] pl-3">
                          {entry.items.map((item) => {
                            const active = item.id === activeId
                            return (
                              <button aria-current={active ? 'page' : undefined} className={`relative flex min-h-9 w-full min-w-0 items-center rounded-lg px-2.5 text-left text-[13px] transition-colors duration-[180ms] disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:top-1/2 before:left-[-15.5px] before:size-1.5 before:-translate-y-1/2 before:rounded-full before:bg-[#79b7ff] before:transition-transform before:duration-[350ms] before:ease-[var(--ease-back)] ${active ? 'font-semibold text-[#79b7ff] before:scale-100' : 'font-medium text-[var(--crm-sidebar-muted)] before:scale-0 hover:text-[var(--crm-sidebar-text)]'} ${focusRing}`} disabled={item.disabled} key={item.id} onClick={() => navigate(item.id)} type="button">
                                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null)}
        </nav>

        {sideFooter ? <div className={`shrink-0 border-t border-[var(--crm-sidebar-border)] px-3 py-3 [&_[data-label]]:transition-opacity [&_[data-label]]:duration-300 ${rail ? '[&_[data-label]]:opacity-0' : ''}`} data-shell-intro="">{sideFooter}</div> : null}
        <p className="m-0 shrink-0 px-4 pt-1 pb-[max(.5rem,env(safe-area-inset-bottom))] text-center text-[11px] font-medium text-[var(--crm-sidebar-muted)] tabular-nums" data-shell-intro="">{APP_DISPLAY_VERSION}</p>
      </aside>

      <div aria-hidden="true" className={`fixed inset-0 z-[39] bg-black/60 [transition:opacity_300ms,display_300ms_allow-discrete] desk:hidden ${isOpen ? 'opacity-100 starting:opacity-0' : 'hidden opacity-0'}`} data-motion-transition="" onClick={() => setIsOpen(false)} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative z-30 flex min-h-[72px] shrink-0 items-center gap-2.5 border-b border-[var(--crm-border-subtle)] bg-[color-mix(in_srgb,var(--crm-topbar-bg)_84%,transparent)] px-6 py-3.5 [-webkit-backdrop-filter:blur(14px)] [backdrop-filter:blur(14px)] max-[700px]:min-h-16 max-[700px]:px-4 max-[700px]:py-3 [.pwa-standalone_&]:pt-[calc(0.875rem+env(safe-area-inset-top,0px))]" data-shell="topbar">
          <button ref={menuButtonRef} aria-controls={sidebarId} aria-expanded={isOpen} aria-label="Abrir menú" className={`grid size-11 shrink-0 place-items-center rounded-full bg-[var(--crm-input-bg)] text-[var(--crm-text-secondary)] desk:hidden ${focusRing}`} onClick={() => setIsOpen(true)} type="button">
            <Menu className="size-5" />
          </button>
          <button aria-label="Buscar en el workspace" className={`flex min-h-11 min-w-11 items-center gap-2.5 rounded-full bg-[var(--crm-input-bg)] px-4 text-sm text-[var(--crm-text-muted)] transition-shadow duration-[180ms] hover:shadow-[inset_0_0_0_1px_var(--crm-input-border)] max-[700px]:size-11 max-[700px]:justify-center max-[700px]:px-0 sm:min-w-[240px] ${focusRing}`} onClick={() => setIsPaletteOpen(true)} type="button">
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <span className="flex-1 text-left max-[700px]:hidden">Buscar…</span>
            <kbd className="rounded-md border border-[var(--crm-border)] px-1.5 py-0.5 font-sans text-[11px] font-semibold max-[700px]:hidden">⌘K</kbd>
          </button>
          <span className="flex-1" />
          <DashboardClock />
          {tools}
          <AccountMenu account={account} />
        </header>

        {notices}

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          <main ref={mainRef} className="mx-auto w-full max-w-[1488px] px-6 pt-7 pb-8 max-[700px]:px-4 max-[700px]:pt-5 max-[700px]:pb-5">
            <div className="mb-6 min-w-0">
              {shown.current.eyebrow ? <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--crm-text-muted)]">{shown.current.eyebrow}</div> : null}
              <PageTitle key={shownId} title={shown.current.title} />
            </div>
            {shown.current.children}
          </main>
        </div>
      </div>

      {isPaletteOpen ? <CommandPalette groups={groups} onClose={() => setIsPaletteOpen(false)} onSelect={(id) => { setIsPaletteOpen(false); navigate(id) }} /> : null}
    </div>
  )
}

function PageTitle({ title }: { title: string }) {
  let charIndex = 0
  return (
    <h1 aria-label={title} className="m-0 text-[28px] leading-[1.15] font-bold tracking-[-0.025em] text-[var(--crm-text)] max-[700px]:text-2xl">
      {title.split(' ').map((word, wordIndex) => (
        <span aria-hidden="true" className="inline-block overflow-clip pb-[0.08em] align-bottom" key={`${word}-${wordIndex}`}>
          {[...word].map((letter, letterIndex) => (
            <span className="inline-block animate-[dashboard-letter_800ms_var(--ease-power4)_backwards]" data-motion-anim="" key={letterIndex} style={{ animationDelay: `${charIndex++ * 22}ms` }}>{letter}</span>
          ))}
          {wordIndex < title.split(' ').length - 1 ? ' ' : null}
        </span>
      ))}
    </h1>
  )
}

const weekdayFormatter = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
const timeFormatter = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' })

function DashboardClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  const time = timeFormatter.format(now)
  return (
    <span className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-[var(--crm-input-bg)] px-4 text-xs font-medium whitespace-nowrap text-[var(--crm-text-secondary)] capitalize max-[700px]:hidden">
      <span className="max-[900px]:hidden">{weekdayFormatter.format(now)}</span>
      <b className="font-semibold text-[var(--crm-text)] tabular-nums animate-[dashboard-flash_1.2s_var(--ease-power3)]" data-motion-anim="" key={time}>{time}</b>
    </span>
  )
}

function AccountMenu({ account }: { account: Props['account'] }) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const details = detailsRef.current
    if (!details) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return
      details.open = false
      details.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    details.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      details.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  return (
    <details ref={detailsRef} className="relative shrink-0">
      <summary aria-label="Menú de cuenta" className={`flex min-h-11 min-w-11 cursor-pointer list-none items-center gap-2 rounded-full bg-[var(--crm-input-bg)] px-3 text-xs font-semibold text-[var(--crm-text-secondary)] max-[700px]:size-11 max-[700px]:justify-center max-[700px]:px-0 [&::-webkit-details-marker]:hidden ${focusRing}`}>
        <UserRound aria-hidden="true" className="size-4 shrink-0" />
        <span className="max-w-[140px] truncate max-[900px]:hidden">{account.name}</span>
      </summary>
      <div className="absolute top-[calc(100%+8px)] right-0 z-50 grid w-[240px] gap-1 rounded-2xl border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-2 text-[var(--crm-text)] shadow-[var(--crm-shadow-floating)] animate-[dashboard-pop_220ms_var(--ease-back)]" data-motion-anim="">
        <div className="px-2.5 pt-1.5 pb-2">
          <p className="m-0 truncate text-sm font-semibold">{account.name}</p>
          {account.detail ? <p className="m-0 mt-0.5 truncate text-xs text-[var(--crm-text-muted)]">{account.detail}</p> : null}
        </div>
        {account.menu}
      </div>
    </details>
  )
}

export const dashboardMenuItemClass = `flex min-h-11 w-full items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 text-left text-sm font-medium text-[var(--crm-text-secondary)] transition-colors duration-[180ms] hover:bg-[var(--crm-surface-soft)] hover:text-[var(--crm-text)] disabled:opacity-50 ${focusRing}`

function CommandPalette({ groups, onClose, onSelect }: { groups: DashboardNavGroup[]; onClose: () => void; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const entries = groups.flatMap((group) => group.items.flatMap((entry) => isParent(entry)
    ? entry.items.map((item) => ({ ...item, context: `${group.label} · ${entry.label}` }))
    : [{ ...entry, context: group.label }]))
  const needle = query.trim().toLocaleLowerCase('es')
  const results = entries.filter((entry) => !entry.disabled && `${entry.label} ${entry.context}`.toLocaleLowerCase('es').includes(needle))
  return (
    <AppModal label="Buscar en el workspace" maxWidth={560} onClose={onClose} theme="crm">
      <form className="grid gap-2 p-3" onSubmit={(event) => { event.preventDefault(); if (results[0]) onSelect(results[0].id) }}>
        <label className="flex min-h-12 items-center gap-2.5 rounded-xl bg-[var(--crm-input-bg)] px-3.5">
          <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--crm-text-muted)]" />
          <input aria-label="Buscar sección" autoFocus className="min-w-0 flex-1 border-0 bg-transparent text-sm text-[var(--crm-text)] outline-none placeholder:text-[var(--crm-text-muted)]" onChange={(event) => setQuery(event.target.value)} placeholder="Ir a una sección…" value={query} />
        </label>
        <ul className="m-0 grid max-h-[min(420px,60dvh)] list-none gap-0.5 overflow-y-auto p-0">
          {results.map((entry, index) => {
            const Icon = entry.icon
            return (
              <li className="animate-[dashboard-row_500ms_var(--ease-power3)_backwards]" data-motion-anim="" key={entry.id} style={{ animationDelay: `${Math.min(index, 4) * 35}ms` }}>
                <button className={dashboardMenuItemClass} onClick={() => onSelect(entry.id)} type="button">
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <span className="truncate text-xs text-[var(--crm-text-muted)]">{entry.context}</span>
                </button>
              </li>
            )
          })}
          {results.length ? null : <li className="px-3 py-6 text-center text-sm text-[var(--crm-text-muted)]">Sin resultados.</li>}
        </ul>
      </form>
    </AppModal>
  )
}

export function LiveStatus({ isOnline }: { isOnline: boolean }) {
  return (
    <div className="flex min-h-10 items-center gap-3 px-[17px] text-xs font-semibold text-[var(--crm-sidebar-muted)]" role="status">
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${isOnline ? 'bg-[var(--crm-green)] animate-[dashboard-breathe_2.4s_infinite]' : 'bg-[var(--crm-red)]'}`} data-motion-anim="" />
      <span data-label="">{isOnline ? 'Online' : 'Offline'}</span>
    </div>
  )
}
