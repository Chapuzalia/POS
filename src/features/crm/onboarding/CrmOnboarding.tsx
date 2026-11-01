import { useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { driver, type Driver } from 'driver.js'
import { checklist, type Checklist } from 'driver.js/checklist'
import 'driver.js/dist/driver.css'
import 'driver.js/dist/checklist.css'
import './onboarding.css'
import { Button } from '../../../components/ui/Button'
import { CrmModal } from '../shared/components/CrmModal'
import { billingRequest } from '../../billing/service'
import type { BillingDetail } from '../../billing/types'
import type { CrmVenue, TenantContext } from '../../../types'
import type { CrmSection } from '../routing/crmNavigation'
import { getOnboardingTopics, onboardingStorageKey, readOnboardingProgress, shouldOfferOnboarding, writeOnboardingProgress } from './onboardingModel'
import { getOnboardingSteps } from './onboardingTours'
import { notifyOperationalError } from '../../../utils/notifications'

type Props = {
  context: TenantContext
  venue: CrmVenue
  activeSection: CrmSection
  disabled: boolean
  isOnline: boolean
  onSectionChange: (section: CrmSection) => void
}

export default function CrmOnboarding({ context, venue, activeSection, disabled, isOnline, onSectionChange }: Props) {
  const key = onboardingStorageKey(context, venue.id)
  const [initialProgress] = useState(() => readOnboardingProgress(key))
  const progress = useRef(initialProgress)
  const [welcome, setWelcome] = useState(false)
  const [indexVisible, setIndexVisible] = useState(false)
  const index = useRef<Checklist | null>(null)
  const tour = useRef<Driver | null>(null)
  const tourSection = useRef<CrmSection | null>(null)
  const navigate = useRef(onSectionChange)
  navigate.current = onSectionChange
  const canStart = useRef(false)
  canStart.current = !disabled && isOnline
  const topics = getOnboardingTopics(context, venue)
  const availableTopics = useRef(topics)
  availableTopics.current = topics
  const topicIds = topics.map(topic => topic.id).join(',')

  useEffect(() => {
    if (!isOnline || context.role !== 'owner' || progress.current.offered) return
    let active = true
    void billingRequest<BillingDetail>({ action: 'get', tenantId: context.tenantId }).then(detail => {
      if (active && shouldOfferOnboarding(context, detail, progress.current)) setWelcome(true)
    }).catch(() => { /* Billing failure must not interrupt the operational CRM; manual help remains available. */ })
    return () => { active = false }
  }, [context, isOnline])

  useEffect(() => {
    if (tourSection.current && (tourSection.current !== activeSection || !isOnline)) {
      tour.current?.destroy()
    }
  }, [activeSection, isOnline])

  useEffect(() => {
    if (!indexVisible || !topicIds) return
    let disposed = false
    let returnToIndex = false
    let activeDialog: Element | null = null
    const available = availableTopics.current
    const shell = document.querySelector<HTMLElement>('.crm-shell')
    const applyTheme = (element: HTMLElement) => {
      element.classList.add('crm-shell')
      element.dataset.crmTheme = shell?.dataset.crmTheme ?? 'light'
    }
    const findDialog = () => document.querySelector('[data-onboarding-dialog]')?.closest('[role="dialog"]') ?? null
    const attachToDialog = (popover: HTMLElement, dialog: Element) => {
      const overlay = document.querySelector('.driver-overlay')
      if (overlay && overlay.parentElement !== dialog) dialog.appendChild(overlay)
      if (popover.parentElement !== dialog) dialog.appendChild(popover)
      popover.dataset.reactAriaTopLayer = 'true'
      popover.inert = false
      popover.removeAttribute('aria-hidden')
      const back = popover.querySelector('.crm-onboarding-back')
      if (back) back.textContent = 'Pausar guía'
    }
    const showIndex = () => {
      if (disposed) return
      index.current?.show()
      const widget = document.querySelector<HTMLElement>('.crm-onboarding-index')
      if (widget) applyTheme(widget)
    }
    const widget = checklist({
      id: key,
      title: 'Tu inicio guiado',
      description: 'Elige un tema y sigue los pasos. Puedes saltar de uno a otro. Las marcas indican guías vistas, no datos guardados.',
      launcher: false,
      progressText: '{{done}} de {{total}} guías vistas',
      completeTitle: 'Ya has visto todas las guías',
      completeDescription: 'Puedes volver a cualquiera de ellas cuando lo necesites.',
      className: 'crm-onboarding-index',
      completed: progress.current.reviewed,
      items: available.map(topic => ({
        id: topic.id, title: topic.title, description: `${topic.description} · ${getOnboardingSteps(topic).length} pasos`,
        completeWhen: () => progress.current.reviewed.includes(topic.id),
        action: () => {
          if (!canStart.current) return
          tour.current?.destroy()
          widget.hide()
          tourSection.current = topic.section
          navigate.current(topic.section)
          const guide = driver({
            animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            showProgress: true, progressText: '{{current}} de {{total}}',
            nextBtnText: 'Siguiente', prevBtnText: 'Anterior', doneBtnText: 'Terminar guía', closeBtnLabel: 'Cerrar guía',
            overlayClickBehavior: 'none', popoverClass: 'crm-onboarding-popover',
            steps: getOnboardingSteps(topic),
            onPopoverRender: popover => {
              applyTheme(popover.wrapper)
              popover.wrapper.dataset.reactAriaTopLayer = 'true'
              // Keep the help inside the form's focus scope while a modal is open.
              const dialog = findDialog()
              if (dialog) attachToDialog(popover.wrapper, dialog)
              const back = document.createElement('button')
              back.type = 'button'
              back.className = 'crm-onboarding-back'
              back.textContent = dialog ? 'Pausar guía' : 'Volver al índice'
              back.onclick = () => guide.destroy()
              popover.footer.appendChild(back)
            },
            onHighlighted: (element, step) => {
              if (step.element && (!element || element.id === 'driver-dummy-element')) {
                notifyOperationalError('No se pudo encontrar este paso. Espera a que termine de cargar la sección y vuelve a abrir el índice.')
                guide.destroy()
              }
            },
            onDoneClick: () => {
              progress.current = { ...progress.current, reviewed: [...new Set([...progress.current.reviewed, topic.id])] }
              writeOnboardingProgress(key, progress.current)
              widget.complete(topic.id)
              guide.destroy()
            },
            onDestroyed: () => {
              tour.current = null
              tourSection.current = null
              // A modal still owns focus: the index can be reopened from the header after closing it.
              returnToIndex = true
              if (!findDialog()) {
                showIndex()
                if (!disposed) widget.open()
              }
            },
          })
          tour.current = guide
          guide.drive()
        },
      })),
    })
    index.current = widget
    showIndex()
    widget.open()
    const themeObserver = new MutationObserver(() => {
      const element = document.querySelector<HTMLElement>('.crm-onboarding-index')
      if (element) applyTheme(element)
    })
    if (shell) themeObserver.observe(shell, { attributes: true, attributeFilter: ['data-crm-theme'] })
    const formObserver = new MutationObserver(() => {
      const dialog = findDialog()
      if (dialog === activeDialog) return
      activeDialog = dialog
      if (dialog) {
        widget.hide()
        const popover = document.querySelector<HTMLElement>('.crm-onboarding-popover')
        if (popover) attachToDialog(popover, dialog)
      }
      else if (tour.current) tour.current.destroy()
      else if (returnToIndex && !disposed) { showIndex(); widget.open() }
    })
    formObserver.observe(document.body, { childList: true, subtree: true })
    return () => {
      disposed = true
      themeObserver.disconnect()
      formObserver.disconnect()
      tour.current?.destroy()
      tour.current = null
      widget.hide()
      index.current = null
    }
  }, [indexVisible, key, topicIds])

  function dismissWelcome(start: boolean) {
    progress.current = { ...progress.current, offered: true }
    writeOnboardingProgress(key, progress.current)
    setWelcome(false)
    if (start) setIndexVisible(true)
  }

  return <>
    <Button aria-label="Inicio guiado" className="!min-h-11 !shrink-0 !gap-2 !bg-[var(--crm-blue-soft)] !px-3 !text-[var(--crm-blue)]" disabled={disabled || !topics.length} onClick={() => {
      if (!indexVisible) setIndexVisible(true)
      else { index.current?.show(); index.current?.open() }
    }} type="button"><BookOpen className="size-4" /><span className="hidden sm:inline">Inicio guiado</span></Button>
    {welcome && !disabled ? <CrmModal label="Bienvenido a Tickit" onClose={() => dismissWelcome(false)}>
      <div className="!grid !gap-5 !p-6">
        <div className="!grid !size-12 !place-items-center !rounded-2xl !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><BookOpen className="size-6" /></div>
        <div><h2 className="!m-0 !text-2xl !font-bold">¡Tu negocio ya está activo!</h2><p className="!mb-0 !mt-3 !text-sm !text-[var(--crm-text-muted)]">Te acompañamos a preparar tu primer producto, el stock y las mesas de tu local. Elige por dónde empezar desde el índice y avanza a tu ritmo.</p></div>
        <p className="!m-0 !text-sm !text-[var(--crm-text-muted)]">Puedes posponerlo y volver desde «Inicio guiado». Tú decides qué crear y guardar.</p>
        <div className="!flex !flex-wrap !justify-end !gap-3"><Button onClick={() => dismissWelcome(false)} type="button" variant="secondary">Más tarde</Button><Button onClick={() => dismissWelcome(true)} type="button" variant="primary">Empezar inicio guiado</Button></div>
      </div>
    </CrmModal> : null}
  </>
}
